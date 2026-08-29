const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const { AppDatabase } = require('../src/database');
const { createSystem } = require('../src/server');

class MockWhatsApp extends EventEmitter {
  constructor() {
    super();
    this.state = {
      status: 'disconnected',
      qrDataUrl: null,
      account: null,
      message: 'Desconectado para teste.',
      updatedAt: new Date().toISOString(),
    };
  }

  getStatus() { return { ...this.state }; }
  async start() { return this.getStatus(); }
  async reconnect() { return this.getStatus(); }
  async destroy() {}
  async sendText() { throw new Error('Envio externo não permitido neste teste.'); }
}

async function createTestServer(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-http-'));
  const database = new AppDatabase({
    databasePath: path.join(tempDir, 'test.db'),
    seedPath: path.resolve(__dirname, 'fixtures/contacts.json'),
  });
  const whatsapp = new MockWhatsApp();
  const system = createSystem({
    database,
    whatsapp,
    config: {
      ...baseConfig,
      port: 0,
      whatsappAutostart: false,
      businessHourStart: 0,
      businessHourEnd: 24,
    },
  });
  const server = http.createServer(system.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    system.runner.stop();
    system.hub.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });

  return { baseUrl };
}

test('API entrega o painel, filtra contatos e mantém a fila bloqueada sem WhatsApp', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.summary.total, 30);
  assert.equal(bootstrap.summary.eligible, 0);
  assert.equal(bootstrap.whatsapp.status, 'disconnected');

  const contacts = await (await fetch(`${baseUrl}/api/contacts?search=Aurora&pageSize=10`)).json();
  assert.equal(contacts.pagination.total, 1);
  assert.equal(contacts.items[0].company, 'Padaria Aurora');

  const queueResponse = await fetch(`${baseUrl}/api/queue/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1, intervalSeconds: 180, authorizationAcknowledged: true }),
  });
  assert.equal(queueResponse.status, 409);
  assert.equal((await queueResponse.json()).code, 'WHATSAPP_NOT_READY');
});

test('API exige confirmação de opt-in e bloqueia origem externa', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const missingConfirmation = await fetch(`${baseUrl}/api/contacts/2/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: false }),
  });
  assert.equal(missingConfirmation.status, 400);

  const foreignOrigin = await fetch(`${baseUrl}/api/contacts/2/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://site-malicioso.example' },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(foreignOrigin.status, 403);

  const confirmed = await fetch(`${baseUrl}/api/contacts/2/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true, note: 'Solicitou demonstração' }),
  });
  assert.equal(confirmed.status, 200);
  const updated = await confirmed.json();
  assert.equal(updated.contact.eligible, true);
});

test('API aceita mensagem sem {empresa} e recusa variável desconhecida', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const put = (template) => fetch(`${baseUrl}/api/template`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template }),
  });

  // Listas só com números não têm nome para interpolar; a mensagem sem
  // variável precisa ser aceita.
  const semVariavel = await put('Mensagem sem variável');
  assert.equal(semVariavel.status, 200);
  assert.equal((await semVariavel.json()).template, 'Mensagem sem variável');

  const desconhecida = await put('Oi, {nome}');
  assert.equal(desconhecida.status, 400);
  assert.equal((await desconhecida.json()).code, 'INVALID_TEMPLATE');

  const vazia = await put('   ');
  assert.equal(vazia.status, 400);
});
