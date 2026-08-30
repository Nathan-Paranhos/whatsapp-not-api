const path = require('node:path');
const http = require('node:http');
const express = require('express');
const config = require('./config');
const { AppDatabase } = require('./database');
const { WhatsAppService } = require('./whatsapp-service');
const { CampaignRunner } = require('./campaign-runner');
const { RealtimeHub } = require('./realtime-hub');
const { normalizeCompanyName, validateTemplate, renderTemplate, usesCompanyToken } = require('./lib/template');
const { parseContactList } = require('./import/parse-contacts');

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
  registerImportRoutes(context);
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
  app.use(blockForeignHosts());
  app.use(blockForeignOrigins());
  // Uma lista de milhares de contatos passa fácil de 96kb. O limite maior vale
  // só para a rota de importação; o resto do painel continua apertado.
  app.use('/api/imports/upload', express.json({ limit: '12mb' }));
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
      tags: database.listTags(),
      imports: database.listImportBatches(10),
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
      tag: String(req.query.tag || ''),
      page: req.query.page,
      pageSize: req.query.pageSize,
    }));
  });

  app.get('/api/contacts/:id', (req, res) => {
    const contact = database.getContact(req.params.id);
    if (!contact) throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    res.json({
      ok: true,
      contact,
      stats: database.getContactStats(req.params.id),
      deliveries: database.listDeliveries(req.params.id),
    });
  });

  // 3. etiquetas: substitui o conjunto inteiro do contato
  app.put('/api/contacts/:id/tags', (req, res) => {
    if (!Array.isArray(req.body?.tags)) {
      throw apiError(400, 'INVALID_TAGS', 'Envie uma lista de etiquetas.');
    }
    if (!database.setContactTags(req.params.id, req.body.tags)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    respondWithContact(res, req.params.id);
  });

  // 5. desfecho manual de um envio incerto
  app.post('/api/contacts/:id/resolve', (req, res) => {
    if (!database.resolveUncertain(req.params.id, String(req.body?.outcome || ''))) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    respondWithContact(res, req.params.id);
  });

  app.patch('/api/contacts/:id', (req, res) => {
    const patch = {};
    if (req.body?.company !== undefined) {
      const company = normalizeCompanyName(req.body.company);
      // Nome é opcional no produto (lista só com números), mas se veio no
      // corpo em branco é engano, não intenção de limpar.
      if (!company) throw apiError(400, 'INVALID_COMPANY', 'Informe um nome de empresa válido.');
      patch.company = company;
    }
    if (req.body?.phone !== undefined) patch.phone = String(req.body.phone);
    if (req.body?.city !== undefined) patch.city = String(req.body.city);
    if (!Object.keys(patch).length) {
      throw apiError(400, 'NOTHING_TO_UPDATE', 'Informe ao menos um campo para alterar.');
    }

    if (!database.updateContact(req.params.id, patch)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    if (patch.company) {
      database.recordEvent({
        type: 'contact.updated',
        contactId: Number(req.params.id),
        title: `Nome atualizado para ${patch.company}`,
      });
    }
    respondWithContact(res, req.params.id);
  });

  app.delete('/api/contacts/:id', (req, res) => {
    if (!database.deleteContact(req.params.id)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    notify('contacts');
    res.json({ ok: true, deleted: 1, summary: database.getSummary() });
  });

  // Apaga exatamente o conjunto que a tela está mostrando. O painel manda de
  // volta a contagem que exibiu; se ela não bater com a do banco, a lista mudou
  // desde então e a exclusão é recusada em vez de apagar demais.
  app.post('/api/contacts/delete-many', (req, res) => {
    if (req.body?.confirmed !== true) {
      throw apiError(400, 'CONFIRMATION_REQUIRED', 'Confirme explicitamente a exclusão em massa.');
    }
    const criteria = {
      search: String(req.body?.search || ''),
      filter: String(req.body?.filter || 'all'),
      city: String(req.body?.city || ''),
      tag: String(req.body?.tag || ''),
    };

    const actual = database.countContacts(criteria);
    if (!actual) throw apiError(400, 'NOTHING_TO_DELETE', 'Nenhum contato corresponde a estes filtros.');

    const expected = Number(req.body?.expected);
    if (Number.isInteger(expected) && expected !== actual) {
      throw apiError(
        409,
        'COUNT_MISMATCH',
        `A lista mudou: você confirmou ${expected} contato(s), mas agora são ${actual}. Recarregue e confira de novo.`,
      );
    }

    const result = database.deleteContactsByFilter(criteria);
    notify('contacts');
    res.json({ ok: true, ...result, summary: database.getSummary() });
  });

  app.delete('/api/contacts/:id/consent', (req, res) => {
    if (!database.revokeConsent(req.params.id, req.body?.reason)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
    respondWithContact(res, req.params.id);
  });

  app.delete('/api/contacts/:id/review', (req, res) => {
    if (!database.revokeReview(req.params.id)) {
      throw apiError(404, 'NOT_FOUND', 'Contato não encontrado.');
    }
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

function registerImportRoutes({ app, database, notify }) {
  /**
   * Importa uma lista colada ou enviada pelo painel, sem terminal. Sem
   * `confirmed`, só analisa e devolve o que faria — é a prévia que a tela mostra
   * antes de gravar qualquer coisa.
   */
  app.post('/api/imports/upload', (req, res) => {
    const content = String(req.body?.content ?? '');
    if (!content.trim()) throw apiError(400, 'EMPTY_CONTENT', 'Cole o conteúdo ou escolha um arquivo.');

    const parsed = parseContactList(content, { defaultCity: String(req.body?.defaultCity || '') });
    const resumo = {
      ok: true,
      format: parsed.format,
      summary: parsed.summary,
      warnings: parsed.warnings.slice(0, 50),
      warningsTotal: parsed.warnings.length,
      sample: parsed.contacts.slice(0, 5).map((contact) => ({
        company: contact.companyDisplay,
        phoneRaw: contact.phoneRaw,
        city: contact.city,
        phoneKind: contact.phoneKind,
      })),
    };

    if (!parsed.summary.valid) {
      throw apiError(400, 'NOTHING_TO_IMPORT', 'Nenhum contato utilizável foi encontrado no conteúdo enviado.');
    }
    // Nome por contato é o que permite usar {empresa}. Quem não tem precisa
    // dizer de propósito que aceita seguir só com os números.
    if (parsed.summary.unnamed && req.body?.allowUnnamed !== true) {
      return res.status(200).json({ ...resumo, needsUnnamedConfirmation: true, imported: false });
    }
    if (req.body?.confirmed !== true) {
      return res.status(200).json({ ...resumo, imported: false });
    }

    const result = database.importContacts(parsed.contacts, {
      source: String(req.body?.filename || 'colado no painel').slice(0, 120),
      format: parsed.format,
    });
    notify('contacts');
    return res.json({ ...resumo, imported: true, result, summaryTotals: database.getSummary() });
  });

  app.get('/api/imports', (req, res) => {
    res.json({ ok: true, batches: database.listImportBatches() });
  });

  // Desfaz uma importação inteira. Só apaga o que ainda pertence àquele lote:
  // contatos já removidos ou de outras importações não são tocados.
  app.delete('/api/imports/:id', (req, res) => {
    if (req.body?.confirmed !== true) {
      throw apiError(400, 'CONFIRMATION_REQUIRED', 'Confirme explicitamente que quer desfazer esta importação.');
    }
    const result = database.deleteImportBatch(req.params.id);
    if (!result) throw apiError(404, 'NOT_FOUND', 'Importação não encontrada.');
    notify('contacts');
    res.json({ ok: true, ...result, summary: database.getSummary() });
  });
}

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

  // Remove um lote encerrado do painel, devolvendo a fila ao estado inicial.
  app.delete('/api/queue/:runId', (req, res) => {
    const result = database.discardRun(req.params.runId);
    if (!result) throw apiError(404, 'NOT_FOUND', 'Lote não encontrado.');
    notify('queue');
    res.json({ ok: true, ...result, queue: database.getQueueView() });
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
    const rows = database.exportRows({
      search: String(req.query.search || ''),
      filter: String(req.query.filter || 'all'),
      city: String(req.query.city || ''),
      tag: String(req.query.tag || ''),
    });
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
    res.status(404).json({
      ok: false,
      code: 'NOT_FOUND',
      error: 'Endpoint não encontrado. Se o painel foi atualizado, feche e rode npm start de novo.',
    });
  });

  // Sem cache de tempo: em localhost não há ganho, e um app.js velho servido
  // contra um servidor novo produz erros de endpoint difíceis de diagnosticar.
  app.use(express.static(path.join(appConfig.rootDir, 'public'), {
    extensions: ['html'],
    etag: true,
    maxAge: 0,
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

/**
 * Barra DNS rebinding. O bind em 127.0.0.1 impede que a porta seja alcançada de
 * outra máquina, mas não impede que um domínio do atacante resolva para
 * 127.0.0.1 e o navegador da vítima trate a página dele como mesma origem do
 * painel. Sem esta checagem, um GET de fora lia a lista inteira.
 *
 * Vale para TODOS os métodos, inclusive GET — era justamente a isenção do GET
 * que abria o vazamento.
 */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Extrai só o nome do host, descartando a porta. O rebinding se dá pelo nome —
// a porta é a que o servidor estiver escutando, e ela varia (config, porta 0
// nos testes), então prendê-la aqui só produziria falso positivo.
function hostnameOf(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1) || host;
  const corte = host.lastIndexOf(':');
  return corte === -1 ? host : host.slice(0, corte);
}

function blockForeignHosts() {
  return (req, res, next) => {
    if (LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host))) return next();
    return res.status(403).json({
      ok: false,
      code: 'FOREIGN_HOST',
      error: 'Host não autorizado. O painel responde apenas em 127.0.0.1 ou localhost.',
    });
  };
}

/**
 * Impede que outra origem provoque escrita. Falha FECHADA: sem prova de mesma
 * origem a requisição é negada, em vez de liberada. Clientes fora do navegador
 * (scripts, testes) se identificam com o cabeçalho X-Local-Client.
 */
function blockForeignOrigins() {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    const origemLocal = Boolean(origin) && (() => {
      try {
        return LOCAL_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
      } catch {
        return false;
      }
    })();
    const mesmaOrigem = origemLocal
      || fetchSite === 'same-origin'
      || Boolean(req.get('x-local-client'));

    if (!mesmaOrigem) {
      return res.status(403).json({
        ok: false,
        code: 'FOREIGN_ORIGIN',
        error: 'Origem não autorizada.',
      });
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
  if (['CONTACT_IN_ACTIVE_RUN', 'DUPLICATE_PHONE', 'COUNT_MISMATCH', 'CONTACT_NOT_UNCERTAIN'].includes(code)) return 409;
  if (['WHATSAPP_NOT_READY', 'OUTSIDE_BUSINESS_HOURS'].includes(code)) return 409;
  if (code) return 400;
  return 500;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  // TAB e CR são descartados pela planilha antes de avaliar, então também precisam do apóstrofo.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createSystem, startServer };
