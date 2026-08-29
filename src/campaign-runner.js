const EventEmitter = require('node:events');
const { renderTemplate, validateTemplate, hashMessage, usesCompanyToken } = require('./lib/template');
const { isEligibleContact } = require('./database');

const MAX_CONSECUTIVE_PROBLEMS = 3;
const MAX_INTERVAL_SECONDS = 600;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Conduz um lote: escolhe destinatários, envia uma mensagem por vez e para
 * sozinho diante de qualquer sinal ruim. Cada etapa vive na sua própria função
 * para que o caminho do envio possa ser lido de cima para baixo.
 */
class CampaignRunner extends EventEmitter {
  constructor({ database, whatsapp, config }) {
    super();
    this.database = database;
    this.whatsapp = whatsapp;
    this.config = config;
    this.timer = null;
    this.processing = false;
    this.consecutiveProblems = 0;

    this.whatsapp.on('state-change', (state) => {
      if (state.status && state.status !== 'ready') {
        const run = this.database.getActiveRun();
        if (run?.status === 'running') this.pause('WhatsApp desconectado. A fila foi pausada automaticamente.');
      }
      this.emitChange();
    });
  }

  // ---------------------------------------------------------------- consultas

  // Lista, sem alterar nada, exatamente quem entraria no próximo lote.
  preview({ limit }) {
    return this.database.selectEligibleContacts(clampBatchSize(this.config, limit, this.config.maxBatchSize));
  }

  // ----------------------------------------------------------------- comandos

  start({ limit, intervalSeconds, authorizationAcknowledged, contactIds = null }) {
    this.assertCanQueue(authorizationAcknowledged, {
      confirmation: 'Confirme que os contatos selecionados deram permissão para receber a mensagem.',
      notReady: 'Leia o QR Code e aguarde o WhatsApp ficar pronto antes de iniciar.',
      busy: 'Já existe um lote ativo ou pausado. Retome ou cancele esse lote primeiro.',
      outsideHours: `Os envios ficam disponíveis entre ${formatHour(this.config.businessHourStart)} e ${formatHour(this.config.businessHourEnd)}.`,
    });

    return this.openCampaign({
      contacts: this.resolveRecipients({ contactIds, limit }),
      template: this.requireValidTemplate(),
      intervalSeconds: clampInterval(this.config, intervalSeconds),
    });
  }

  startSingle({ contactId, authorizationAcknowledged }) {
    this.assertCanQueue(authorizationAcknowledged, {
      confirmation: 'Confirme o opt-in deste contato antes de enviar.',
      notReady: 'O WhatsApp ainda não está pronto.',
      busy: 'Pause, conclua ou cancele o lote atual antes do envio individual.',
      outsideHours: 'O envio individual também respeita o horário comercial configurado.',
    });

    return this.openCampaign({
      contacts: [this.requireEligibleContact(contactId)],
      template: this.requireValidTemplate(),
      intervalSeconds: this.config.defaultIntervalSeconds,
    });
  }

  pause(reason = 'Pausado manualmente.') {
    const run = this.database.getActiveRun();
    if (!run || run.status !== 'running') return false;
    this.clearTimer();
    this.database.pauseCampaign(run.id, reason);
    this.emitChange();
    return true;
  }

  resume() {
    const run = this.database.getActiveRun();
    if (!run || run.status !== 'paused') {
      throw appError('NO_PAUSED_CAMPAIGN', 'Não há lote pausado para retomar.');
    }
    if (!this.isWhatsAppReady()) {
      throw appError('WHATSAPP_NOT_READY', 'Reconecte o WhatsApp antes de retomar.');
    }
    if (!isWithinBusinessHours(this.config)) {
      throw appError('OUTSIDE_BUSINESS_HOURS', 'Aguarde o horário comercial para retomar.');
    }
    this.database.resumeCampaign(run.id);
    this.schedule(run.id, 0);
    this.emitChange();
    return this.database.getQueueView();
  }

  cancel() {
    const run = this.database.getActiveRun();
    if (!run) return false;
    this.clearTimer();
    this.database.cancelCampaign(run.id);
    this.emitChange();
    return true;
  }

  stop() {
    this.clearTimer();
  }

  // ------------------------------------------------------ guardas de abertura

  assertCanQueue(authorizationAcknowledged, messages) {
    if (!authorizationAcknowledged) throw appError('CONFIRMATION_REQUIRED', messages.confirmation);
    if (!this.isWhatsAppReady()) throw appError('WHATSAPP_NOT_READY', messages.notReady);
    if (this.database.getActiveRun()) throw appError('CAMPAIGN_ACTIVE', messages.busy);
    if (!isWithinBusinessHours(this.config)) throw appError('OUTSIDE_BUSINESS_HOURS', messages.outsideHours);
  }

  resolveRecipients({ contactIds, limit }) {
    const hasSelection = Array.isArray(contactIds) && contactIds.length > 0;
    const contacts = hasSelection
      ? this.requireReviewedSelection(contactIds)
      : this.database.selectEligibleContacts(clampBatchSize(this.config, limit, 1));

    if (!contacts.length) {
      throw appError('NO_ELIGIBLE_CONTACTS', 'Nenhum contato está elegível. Registre o opt-in e aprove os dados antes de enviar.');
    }
    return contacts;
  }

  // A lista foi conferida na tela: ou o lote sai exatamente com ela, ou não sai.
  requireReviewedSelection(contactIds) {
    const requested = [...new Set(contactIds.map(Number).filter(Number.isInteger))];
    if (requested.length > this.config.maxBatchSize) {
      throw appError('INVALID_BATCH_SIZE', `Selecione no máximo ${this.config.maxBatchSize} contatos por lote.`);
    }

    const contacts = this.database.selectEligibleContactsByIds(requested);
    const dropped = requested.length - contacts.length;
    if (dropped > 0) {
      throw appError(
        'SELECTION_STALE',
        `${dropped} contato(s) da lista deixaram de estar elegíveis. Revise os destinatários e confirme de novo.`,
      );
    }
    return contacts;
  }

  requireEligibleContact(contactId) {
    const contact = this.database.getContactInternal(contactId);
    if (!contact) throw appError('NOT_FOUND', 'Contato não encontrado.');
    if (!isEligibleContact(contact)) {
      throw appError('CONTACT_NOT_ELIGIBLE', 'Este contato ainda não está elegível para envio.');
    }
    return contact;
  }

  requireValidTemplate() {
    const validation = validateTemplate(this.database.getSetting('message_template'));
    if (!validation.valid) throw appError('INVALID_TEMPLATE', validation.errors.join(' '));
    return validation.value;
  }

  openCampaign({ contacts, template, intervalSeconds }) {
    this.assertNamesCoverTemplate(contacts, template);
    const run = this.database.createCampaign({
      contactIds: contacts.map((contact) => contact.id),
      templateHash: hashMessage(template),
      intervalSeconds,
    });
    this.consecutiveProblems = 0;
    this.schedule(run.id, 0);
    this.emitChange();
    return this.database.getQueueView();
  }

  /**
   * {empresa} só entra na fila se todo destinatário tiver nome. Sem isso a
   * mensagem sairia com um buraco no lugar do nome, e quem importou uma lista
   * só de números precisa saber disso antes de disparar, não depois.
   */
  assertNamesCoverTemplate(contacts, template) {
    if (!usesCompanyToken(template)) return;
    const unnamed = contacts.filter((contact) => !contact.company_display).length;
    if (unnamed > 0) {
      throw appError(
        'MISSING_COMPANY_NAMES',
        `${unnamed} contato(s) desta seleção estão sem nome de empresa. Preencha o nome deles ou tire a variável {empresa} da mensagem.`,
      );
    }
  }

  // -------------------------------------------------------- ciclo de trabalho

  schedule(runId, delayMs) {
    this.clearTimer();
    const delay = Math.max(0, delayMs);
    this.database.setNextRunAt(runId, new Date(Date.now() + delay).toISOString());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.processNext(runId).catch((error) => this.pauseOnWorkerError(error));
    }, delay);
  }

  async processNext(runId) {
    if (this.processing) return;
    this.processing = true;
    try {
      const run = this.database.getRun(runId);
      if (!run || run.status !== 'running') return;

      const blocker = this.findBlockerBeforeSending();
      if (blocker) {
        this.pause(blocker);
        return;
      }

      const template = this.database.getSetting('message_template');
      const job = this.leaseJobFor(run, template);
      if (!job) {
        this.database.finishCampaignIfDone(runId);
        this.emitChange();
        return;
      }

      this.emitChange();
      const delivery = await this.sendMessage(job, template);
      this.recordDelivery(job, delivery);
      this.afterDelivery(runId, delivery);
    } finally {
      this.processing = false;
    }
  }

  // Motivo para não enviar agora, ou null quando o caminho está livre. Só lê
  // estado: quem decide pausar é quem chama.
  findBlockerBeforeSending() {
    if (!this.isWhatsAppReady()) {
      return 'WhatsApp desconectado. A fila foi pausada automaticamente.';
    }
    if (!isWithinBusinessHours(this.config)) {
      return 'Fim do horário comercial. Retome no próximo período.';
    }
    if (this.database.countSentToday() >= this.config.dailyLimit) {
      return `Limite diário conservador de ${this.config.dailyLimit} mensagens atingido.`;
    }
    const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS).toISOString();
    if (this.database.countSentSince(oneHourAgo) >= this.config.hourlyLimit) {
      return `Limite conservador de ${this.config.hourlyLimit} mensagens por hora atingido.`;
    }
    return null;
  }

  leaseJobFor(run, template) {
    return this.database.leaseNextJob(
      run.id,
      (contact) => renderTemplate(template, contact.company_display),
      run.template_hash,
    );
  }

  /**
   * Entrega uma mensagem e traduz o resultado em desfecho. Nunca lança: uma
   * falha de rede vira "uncertain", porque não dá para saber se a mensagem
   * chegou, e um desfecho incerto jamais é reenviado sozinho.
   */
  async sendMessage(job, template) {
    try {
      const message = renderTemplate(template, job.company_display);
      const result = await this.whatsapp.sendText(job.whatsapp_digits, message);
      return result.registered
        ? { outcome: 'sent', messageId: result.messageId, error: null }
        : { outcome: 'invalid', messageId: null, error: 'Número não registrado no WhatsApp.' };
    } catch (error) {
      return {
        outcome: 'uncertain',
        messageId: null,
        error: `O resultado do envio não pôde ser confirmado: ${describeError(error, 240)}`,
      };
    }
  }

  recordDelivery(job, { outcome, messageId, error }) {
    this.database.completeJob({
      jobId: job.job_id,
      contactId: job.contact_id,
      deliveryId: job.deliveryId,
      outcome,
      messageId,
      error,
    });
  }

  // Decide o que vem depois de uma entrega: encerrar o lote, parar por
  // problemas seguidos ou agendar a próxima com a espera sorteada.
  afterDelivery(runId, { outcome }) {
    this.consecutiveProblems = outcome === 'sent' ? 0 : this.consecutiveProblems + 1;

    if (this.database.finishCampaignIfDone(runId)) {
      this.emitChange();
      return;
    }
    if (this.consecutiveProblems >= MAX_CONSECUTIVE_PROBLEMS) {
      this.pause(`${MAX_CONSECUTIVE_PROBLEMS} resultados problemáticos consecutivos. Revise a conexão e os contatos.`);
      return;
    }

    const latestRun = this.database.getRun(runId);
    if (latestRun?.status === 'running') {
      this.schedule(runId, nextDelayMs(this.config, latestRun.interval_seconds));
    }
    this.emitChange();
  }

  pauseOnWorkerError(error) {
    this.database.recordEvent({
      level: 'error',
      type: 'campaign.worker_error',
      title: 'A fila foi pausada por um erro interno',
      detail: { error: describeError(error, 300) },
    });
    this.pause('Erro interno no processamento da fila.');
  }

  // ------------------------------------------------------------------ auxílio

  isWhatsAppReady() {
    return this.whatsapp.getStatus().status === 'ready';
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  emitChange() {
    this.emit('data-change', this.database.getQueueView());
  }
}

function isWithinBusinessHours(config, date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= config.businessHourStart && hour < config.businessHourEnd;
}

function clampBatchSize(config, value, fallback) {
  const parsed = Number.parseInt(value, 10) || fallback;
  return Math.min(config.maxBatchSize, Math.max(1, parsed));
}

function clampInterval(config, value) {
  const parsed = Number.parseInt(value, 10) || config.defaultIntervalSeconds;
  return Math.max(config.minIntervalSeconds, Math.min(MAX_INTERVAL_SECONDS, parsed));
}

/**
 * Sorteia a espera até a próxima mensagem dentro de ±jitter do intervalo
 * escolhido. O piso continua sendo minIntervalSeconds: a variação distribui as
 * esperas, não serve para apertar o ritmo.
 */
function nextDelayMs(config, intervalSeconds, random = Math.random) {
  const base = Number(intervalSeconds) || config.defaultIntervalSeconds;
  const spread = base * (config.intervalJitterRatio || 0);
  const drawn = base + (random() * 2 - 1) * spread;
  const seconds = Math.min(MAX_INTERVAL_SECONDS, Math.max(config.minIntervalSeconds, drawn));
  return Math.round(seconds * 1000);
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function describeError(error, maxLength) {
  return String(error?.message || error).slice(0, maxLength);
}

function appError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { CampaignRunner, isWithinBusinessHours, nextDelayMs };
