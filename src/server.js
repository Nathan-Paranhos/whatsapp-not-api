const path = require('node:path');
const http = require('node:http');
const express = require('express');
const config = require('./config');
const { AppDatabase } = require('./database');
const { WhatsAppService } = require('./whatsapp-service');
const { CampaignRunner } = require('./campaign-runner');
const { RealtimeHub } = require('./realtime-hub');
const { normalizeCompanyName, validateTemplate, renderTemplate, usesCompanyToken } = require('./lib/template');

const PREVIEW_COMPANY = 'Empresa Exemplo';
const MAX_INTERVAL_SECONDS = 600;

/**
 * Monta o painel local: banco, WhatsApp, fila e as rotas HTTP. As rotas ficam
 * agrupadas por assunto, e cada grupo recebe o mesmo `context` para evitar
 * repassar meia dúzia de parâmetros soltos.
 */
function createSystem(overrides = {}) {
  const appConfig = { ...config, ...(overrides.config || {}) };
  const database = overrides.database || new AppDatabase({
    databasePath: appConfig.databasePath,
    seedPath: appConfig.seedPath,
  });
  const whatsapp = overrides.whatsapp || new WhatsAppService({
    sessionPath: appConfig.sessionPath,
    database,
  });
  const runner = overrides.runner || new CampaignRunner({ database, whatsapp, config: appConfig });
  const hub = overrides.hub || new RealtimeHub();
  const app = express();

  applyMiddleware(app, appConfig);

  const notify = (reason) => hub.notify(reason);
  const context = { app, appConfig, database, whatsapp, runner, hub, notify };
  wireRealtimeNotifications(context);

  registerBootstrapRoutes(context);
  registerContactRoutes(context);
  registerTemplateRoutes(context);
  registerQueueRoutes(context);
  registerWhatsAppRoutes(context);
  registerExportRoutes(context);
  registerFallbackRoutes(context);

  return { app, appConfig, database, whatsapp, runner, hub };
}

function applyMiddleware(app, appConfig) {
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(blockForeignMutationOrigins(appConfig.port));
  app.use(express.json({ limit: '96kb' }));
}

function wireRealtimeNotifications({ whatsapp, runner, notify }) {
  whatsapp.on('state-change', () => notify('whatsapp'));
  whatsapp.on('data-change', () => notify('messages'));
  runner.on('data-change', () => notify('queue'));
}

// ------------------------------------------------------------------ bootstrap

function registerBootstrapRoutes({ app, appConfig, database, whatsapp, hub }) {
  app.get('/api/bootstrap', (req, res) => {
    const template = database.getSetting('message_template');
    res.json({
      whatsapp: whatsapp.getStatus(),
      summary: database.getSummary(),
      queue: database.getQueueView(),
      template,
      templatePreview: renderTemplate(template, PREVIEW_COMPANY),
      cities: database.getCities(),
      import: database.getImportSummary(),
      events: database.listEvents(24),
      policy: buildPolicy(appConfig),
    });
  });

  app.get('/api/events/stream', (req, res) => hub.connect(req, res));
  app.get('/api/health', (req, res) => res.json({ ok: true, at: new Date().toISOString() }));
}

function buildPolicy(appConfig) {
  return {
    consentRequired: true,
    minIntervalSeconds: appConfig.minIntervalSeconds,
    defaultIntervalSeconds: appConfig.defaultIntervalSeconds,
    intervalJitterRatio: appConfig.intervalJitterRatio,
    maxBatchSize: appConfig.maxBatchSize,
    hourlyLimit: appConfig.hourlyLimit,
    dailyLimit: appConfig.dailyLimit,
    businessHourStart: appConfig.businessHourStart,
    businessHourEnd: appConfig.businessHourEnd,
  };
}

// -------------------------------------------------------------------- contatos

function registerContactRoutes({ app, database, runner, notify }) {
  // Toda mutação de contato responde igual: notifica o painel e devolve a linha
  // já atualizada, para a tela não precisar recarregar a lista inteira.
  const respondWithContact = (res, contactId) => {
    notify('contacts');
    res.json({ ok: true, contact: database.getContact(contactId) });
  };

  app.get('/api/contacts', (req, res) => {
    res.json(database.listContacts({
      search: String(req.query.search || ''),
      filter: String(req.query.filter || 'all'),
      city: String(req.query.city || ''),
      page: req.query.page,
      pageSize: req.query.pageSize,
    }));
  });

  app.patch('/api/contacts/:id', (req, res) => {
    const company = normalizeCompanyName(req.body?.company);
    if (!company) throw apiError(400, 'INVALID_COMPANY', 'Informe um nome de empresa válido.');
    if (!database.updateCompanyName(req.params.id, company)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    database.recordEvent({
      type: 'contact.updated',
      contactId: Number(req.params.id),
      title: `Nome atualizado para ${company}`,
    });
    respondWithContact(res, req.params.id);
  });

  app.post('/api/contacts/:id/consent', (req, res) => {
    if (req.body?.confirmed !== true) {
      throw apiError(400, 'CONFIRMATION_REQUIRED', 'Confirme explicitamente que este contato deu opt-in.');
    }
    if (!database.confirmConsent(req.params.id, req.body?.note)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    respondWithContact(res, req.params.id);
  });

  app.post('/api/contacts/:id/review', (req, res) => {
    if (req.body?.approved !== true) throw apiError(400, 'CONFIRMATION_REQUIRED', 'Confirme a revisão dos dados.');
    if (!database.approveReview(req.params.id)) throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    respondWithContact(res, req.params.id);
  });

  app.post('/api/contacts/:id/suppress', (req, res) => {
    if (!database.suppressContact(req.params.id, req.body?.reason)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    respondWithContact(res, req.params.id);
  });

  app.post('/api/contacts/:id/send', (req, res) => {
    const queue = runner.startSingle({
      contactId: req.params.id,
      authorizationAcknowledged: req.body?.authorizationAcknowledged === true,
    });
    notify('queue');
    res.status(202).json({ ok: true, queue });
  });
}

// -------------------------------------------------------------------- mensagem

function registerTemplateRoutes({ app, database, notify }) {
  app.put('/api/template', (req, res) => {
    if (database.getActiveRun()) {
      throw apiError(409, 'CAMPAIGN_ACTIVE', 'Conclua ou cancele o lote atual antes de alterar a mensagem.');
    }
    const validation = validateTemplate(req.body?.template);
    if (!validation.valid) throw apiError(400, 'INVALID_TEMPLATE', validation.errors.join(' '));

    database.setSetting('message_template', validation.value);
    database.recordEvent({ type: 'template.updated', title: 'Mensagem da campanha atualizada' });
    notify('template');
    res.json({
      ok: true,
      template: validation.value,
      preview: renderTemplate(validation.value, PREVIEW_COMPANY),
    });
  });
}

// ------------------------------------------------------------------------ fila

function registerQueueRoutes({ app, appConfig, database, runner, notify }) {
  // Quem entraria no próximo lote, com a mensagem já montada. Só leitura: serve
  // para conferir e remover destinatários antes de qualquer envio.
  app.get('/api/queue/preview', (req, res) => {
    const limit = clampPreviewLimit(appConfig, req.query.limit);
    const template = database.getSetting('message_template');
    res.json({
      ok: true,
      limit,
      eligibleTotal: database.getSummary().eligible,
      contacts: runner.preview({ limit }).map((contact) => toPreviewContact(contact, template)),
    });
  });

  app.post('/api/queue/start', (req, res) => {
    const { contactIds, limit, intervalSeconds } = parseBatchRequest(req.body, appConfig);
    const queue = runner.start({
      limit,
      intervalSeconds,
      contactIds,
      authorizationAcknowledged: req.body?.authorizationAcknowledged === true,
    });
    notify('queue');
    res.status(202).json({ ok: true, queue });
  });

  app.post('/api/queue/pause', (req, res) => {
    const changed = runner.pause('Pausado manualmente.');
    notify('queue');
    res.json({ ok: true, changed, queue: database.getQueueView() });
  });

  app.post('/api/queue/resume', (req, res) => {
    const queue = runner.resume();
    notify('queue');
    res.json({ ok: true, queue });
  });

  app.post('/api/queue/cancel', (req, res) => {
    const changed = runner.cancel();
    notify('queue');
    res.json({ ok: true, changed, queue: database.getQueueView() });
  });
}

function clampPreviewLimit(appConfig, rawLimit) {
  const requested = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(requested)) return appConfig.maxBatchSize;
  return Math.min(appConfig.maxBatchSize, Math.max(1, requested));
}

/**
 * Um contato importado só com o número não tem nome para colocar em {empresa}.
 * A prévia mostra a linha assim mesmo, marcada, para a pessoa nomear ou remover
 * antes de iniciar — em vez de o painel quebrar na hora de montar a mensagem.
 */
function toPreviewContact(contact, template) {
  const hasCompanyName = Boolean(contact.company_display);
  const needsCompanyName = !hasCompanyName && usesCompanyToken(template);
  return {
    id: Number(contact.id),
    sourceIndex: Number(contact.source_index),
    company: contact.company_display || contact.phone_raw || `#${contact.source_index}`,
    hasCompanyName,
    needsCompanyName,
    city: contact.city,
    phoneRaw: contact.phone_raw,
    phoneKind: contact.phone_kind,
    consentNote: contact.consent_note,
    message: needsCompanyName ? null : renderTemplate(template, contact.company_display),
  };
}

/**
 * Valida o pedido de lote. Quando o painel manda uma lista conferida, é ela que
 * define o tamanho — `limit` só vale para o caminho sem seleção.
 */
function parseBatchRequest(body, appConfig) {
  const rawIds = body?.contactIds;
  const hasSelection = Array.isArray(rawIds);
  if (hasSelection && !rawIds.every((id) => Number.isInteger(Number(id)))) {
    throw apiError(400, 'INVALID_SELECTION', 'A lista de destinatários contém um identificador inválido.');
  }

  const contactIds = hasSelection ? rawIds.map(Number) : null;
  const limit = hasSelection ? new Set(contactIds).size : Number(body?.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > appConfig.maxBatchSize) {
    throw apiError(400, 'INVALID_BATCH_SIZE', `O lote deve ter entre 1 e ${appConfig.maxBatchSize} contatos.`);
  }

  const intervalSeconds = Number(body?.intervalSeconds);
  if (!Number.isInteger(intervalSeconds)
    || intervalSeconds < appConfig.minIntervalSeconds
    || intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw apiError(400, 'INVALID_INTERVAL', `O intervalo deve ficar entre ${appConfig.minIntervalSeconds} e ${MAX_INTERVAL_SECONDS} segundos.`);
  }

  return { contactIds, limit, intervalSeconds };
}

// -------------------------------------------------------------------- whatsapp

function registerWhatsAppRoutes({ app, whatsapp, runner, notify }) {
  app.post('/api/whatsapp/connect', async (req, res) => {
    const status = await whatsapp.start();
    notify('whatsapp');
    res.status(202).json({ ok: true, whatsapp: status });
  });

  app.post('/api/whatsapp/reconnect', async (req, res) => {
    runner.pause('Reconexão do WhatsApp solicitada.');
    const status = await whatsapp.reconnect();
    notify('whatsapp');
    res.status(202).json({ ok: true, whatsapp: status });
  });

  app.post('/api/whatsapp/disconnect', async (req, res) => {
    runner.pause('WhatsApp desconectado manualmente.');
    await whatsapp.destroy();
    notify('whatsapp');
    res.json({ ok: true, whatsapp: whatsapp.getStatus() });
  });
}

// ----------------------------------------------------------------- exportação

function registerExportRoutes({ app, database }) {
  app.get('/api/export.csv', (req, res) => {
    const rows = database.exportRows();
    const headers = Object.keys(rows[0] || {});
    const csv = [headers, ...rows.map((row) => headers.map((key) => row[key]))]
      .map((line) => line.map(csvCell).join(','))
      .join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-not-api-contatos.csv"');
    res.send(`﻿${csv}`);
  });
}

// ------------------------------------------ estáticos, 404 e tratamento de erro

function registerFallbackRoutes({ app, appConfig, database }) {
  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Endpoint não encontrado.' });
  });

  app.use(express.static(path.join(appConfig.rootDir, 'public'), {
    extensions: ['html'],
    etag: true,
    maxAge: '5m',
  }));
  app.get('*splat', (req, res) => res.sendFile(path.join(appConfig.rootDir, 'public/index.html')));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || statusForCode(error.code);
    if (status >= 500) {
      database.recordEvent({
        level: 'error',
        type: 'api.error',
        title: 'Erro interno no painel',
        detail: { error: String(error.message || error).slice(0, 300) },
      });
    }
    return res.status(status).json({
      ok: false,
      code: error.code || 'INTERNAL_ERROR',
      error: status >= 500 ? 'Ocorreu um erro interno. Consulte o histórico do painel.' : error.message,
    });
  });
}

// --------------------------------------------------------------- ciclo de vida

async function startServer() {
  const system = createSystem();
  const server = http.createServer(system.app);
  await listen(server, system.appConfig);
  console.log(`whatsapp-not-api: http://${system.appConfig.host}:${system.appConfig.port}`);

  if (system.appConfig.whatsappAutostart) {
    setImmediate(() => system.whatsapp.start());
  }

  const shutdown = createShutdown(system, server);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...system, server, shutdown };
}

function listen(server, appConfig) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(appConfig.port, appConfig.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function createShutdown(system, server) {
  let closing = false;
  return async () => {
    if (closing) return;
    closing = true;
    console.log('\nEncerrando com segurança…');
    system.runner.stop();
    system.hub.close();
    await system.whatsapp.destroy();
    await new Promise((resolve) => server.close(resolve));
    system.database.close();
  };
}

// ------------------------------------------------------------------- segurança

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
}

function blockForeignMutationOrigins(port) {
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    if ((origin && !allowed.has(origin)) || fetchSite === 'cross-site') {
      return res.status(403).json({ ok: false, code: 'FOREIGN_ORIGIN', error: 'Origem não autorizada.' });
    }
    return next();
  };
}

// --------------------------------------------------------------------- auxílio

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function statusForCode(code) {
  if (code === 'NOT_FOUND') return 404;
  if (['CAMPAIGN_ACTIVE', 'CONTACT_BLOCKED', 'NO_PAUSED_CAMPAIGN', 'SELECTION_STALE'].includes(code)) return 409;
  if (['WHATSAPP_NOT_READY', 'OUTSIDE_BUSINESS_HOURS'].includes(code)) return 409;
  if (code) return 400;
  return 500;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createSystem, startServer };
