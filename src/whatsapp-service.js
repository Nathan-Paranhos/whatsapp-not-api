const EventEmitter = require('node:events');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { digitsOnly } = require('./lib/phones');

class WhatsAppService extends EventEmitter {
  constructor({ sessionPath, database }) {
    super();
    this.sessionPath = sessionPath;
    this.database = database;
    this.client = null;
    this.initializePromise = null;
    this.state = {
      status: 'disconnected',
      qrDataUrl: null,
      qrUpdatedAt: null,
      account: null,
      message: 'Aguardando conexão.',
      updatedAt: new Date().toISOString(),
    };
  }

  getStatus() {
    return { ...this.state };
  }

  async start() {
    if (this.initializePromise || ['starting', 'qr_pending', 'authenticated', 'ready'].includes(this.state.status)) {
      return this.getStatus();
    }

    if (this.client) await this.destroy();

    this.setState({ status: 'starting', message: 'Abrindo o WhatsApp Web…', qrDataUrl: null });
    this.client = this.buildClient();
    this.bindEvents(this.client);

    this.initializePromise = this.client.initialize()
      .catch((error) => {
        this.setState({
          status: 'error',
          message: humanizeWhatsAppError(error),
          qrDataUrl: null,
        });
        this.database.recordEvent({
          level: 'error',
          type: 'whatsapp.error',
          title: 'Não foi possível iniciar o WhatsApp',
          detail: { error: String(error.message || error).slice(0, 300) },
        });
      })
      .finally(() => {
        this.initializePromise = null;
      });

    return this.getStatus();
  }

  buildClient() {
    return new Client({
      authStrategy: new LocalAuth({
        clientId: 'whatsapp-not-api',
        dataPath: this.sessionPath,
      }),
      puppeteer: {
        headless: true,
      },
    });
  }

  bindEvents(client) {
    client.on('qr', async (qr) => {
      if (client !== this.client) return;
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 360,
          color: { dark: '#12251d', light: '#ffffff' },
        });
        if (client !== this.client) return;
        this.setState({
          status: 'qr_pending',
          qrDataUrl,
          qrUpdatedAt: new Date().toISOString(),
          message: 'Leia o QR Code com o WhatsApp do celular.',
        });
      } catch (error) {
        this.setState({ status: 'error', message: 'Falha ao gerar a imagem do QR Code.' });
      }
    });

    client.on('authenticated', () => {
      if (client !== this.client) return;
      this.setState({
        status: 'authenticated',
        qrDataUrl: null,
        message: 'QR Code confirmado. Sincronizando a conta…',
      });
    });

    client.on('ready', () => {
      if (client !== this.client) return;
      const info = client.info || {};
      const accountDigits = info.wid?.user || null;
      this.setState({
        status: 'ready',
        qrDataUrl: null,
        account: accountDigits
          ? { phoneMasked: maskAccount(accountDigits), name: info.pushname || 'WhatsApp conectado' }
          : { phoneMasked: null, name: info.pushname || 'WhatsApp conectado' },
        message: 'WhatsApp pronto para enviar.',
      });
      this.database.recordEvent({ type: 'whatsapp.ready', title: 'WhatsApp conectado e pronto' });
    });

    client.on('auth_failure', (message) => {
      if (client !== this.client) return;
      this.setState({
        status: 'auth_failed',
        qrDataUrl: null,
        account: null,
        message: `Falha de autenticação: ${String(message || '').slice(0, 180)}`,
      });
      this.database.recordEvent({ level: 'error', type: 'whatsapp.auth_failure', title: 'Falha na autenticação do WhatsApp' });
    });

    client.on('disconnected', (reason) => {
      if (client !== this.client) return;
      this.setState({
        status: 'disconnected',
        qrDataUrl: null,
        account: null,
        message: `WhatsApp desconectado${reason ? `: ${String(reason).slice(0, 120)}` : '.'}`,
      });
      this.database.recordEvent({
        level: 'warning',
        type: 'whatsapp.disconnected',
        title: 'WhatsApp desconectado',
        detail: reason ? { reason: String(reason).slice(0, 180) } : null,
      });
    });

    client.on('change_state', (state) => {
      if (client !== this.client) return;
      this.emit('state-change', { providerState: state });
    });

    client.on('message_ack', (message, ack) => {
      if (client !== this.client) return;
      const messageId = message?.id?._serialized;
      if (messageId) this.database.updateMessageAck(messageId, ack);
      this.emit('data-change');
    });

    client.on('message', (message) => {
      if (client !== this.client) return;
      this.handleInbound(message);
    });
  }

  async handleInbound(message) {
    try {
      if (!message?.from || !message.from.endsWith('@c.us')) return;
      const body = String(message.body || '');
      const sender = message.from.replace(/@c\.us$/, '').split(':')[0];
      const contact = this.database.recordInbound({
        from: sender,
        body,
        isOptOut: containsOptOut(body),
      });
      if (contact) this.emit('data-change');
    } catch (error) {
      this.database.recordEvent({
        level: 'error',
        type: 'message.inbound_error',
        title: 'Falha ao registrar uma resposta recebida',
        detail: { error: String(error.message || error).slice(0, 300) },
      });
    }
  }

  async sendText(whatsappDigits, text) {
    if (this.state.status !== 'ready' || !this.client) {
      const error = new Error('O WhatsApp ainda não está pronto.');
      error.code = 'WHATSAPP_NOT_READY';
      throw error;
    }

    const normalized = digitsOnly(whatsappDigits);
    const numberId = await this.client.getNumberId(normalized);
    if (!numberId) return { registered: false, messageId: null };

    const message = await this.client.sendMessage(numberId._serialized, text, {
      linkPreview: false,
      waitUntilMsgSent: true,
    });

    return {
      registered: true,
      messageId: message?.id?._serialized || null,
    };
  }

  async reconnect() {
    await this.destroy();
    return this.start();
  }

  async destroy() {
    const client = this.client;
    this.client = null;
    this.initializePromise = null;
    if (client) {
      try {
        await client.destroy();
      } catch {
        // O processo ainda pode encerrar com segurança; a sessão local é preservada.
      }
    }
    this.setState({
      status: 'disconnected',
      qrDataUrl: null,
      account: null,
      message: 'WhatsApp desconectado. A sessão foi preservada.',
    });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    this.emit('state-change', this.getStatus());
  }
}

function containsOptOut(body) {
  const normalized = String(body || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  if (!normalized) return false;
  const direct = new Set(['SAIR', 'PARAR', 'REMOVER', 'CANCELAR']);
  if (direct.has(normalized)) return true;
  return /\b(NAO QUERO(?: MAIS)? RECEBER|NAO TENHO INTERESSE|PARE DE ENVIAR|ME REMOVA|TIRE ME DA LISTA)\b/.test(normalized);
}

function maskAccount(value) {
  const digits = digitsOnly(value);
  if (digits.length < 8) return null;
  return `+${digits.slice(0, 2)} (${digits.slice(2, 4)}) •••••-${digits.slice(-4)}`;
}

function humanizeWhatsAppError(error) {
  const message = String(error?.message || error || 'Erro desconhecido');
  if (/browser|chrome|chromium|executable/i.test(message)) {
    return 'Não foi possível abrir o navegador interno. Reinstale as dependências e tente novamente.';
  }
  return `Falha ao iniciar o WhatsApp: ${message.slice(0, 220)}`;
}

module.exports = { WhatsAppService, containsOptOut };
