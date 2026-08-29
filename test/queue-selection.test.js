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

class ReadyWhatsApp extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  getStatus() {
    return { status: 'ready', qrDataUrl: null, account: null, message: 'pronto', updatedAt: new Date().toISOString() };
  }

  async start() { return this.getStatus(); }
  async reconnect() { return this.getStatus(); }
  async destroy() {}
  async sendText(digits, message) {
    this.sent.push({ digits, message });
    return { registered: true, messageId: `mock-${this.sent.length}` };
  }
}

async function createTestServer(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-selection-'));
  const database = new AppDatabase({
    databasePath: path.join(tempDir, 'test.db'),
    seedPath: path.resolve(__dirname, 'fixtures/contacts.json'),
  });
  const whatsapp = new ReadyWhatsApp();
  const system = createSystem({
    database,
    whatsapp,
    config: { ...baseConfig, port: 0, whatsappAutostart: false, businessHourStart: 0, businessHourEnd: 24 },
  });
  const server = http.createServer(system.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    system.runner.stop();
    system.hub.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });

  return { baseUrl, database, system };
}

function post(baseUrl, url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function authorize(database, count) {
  const ids = database.listContacts({ filter: 'consent', pageSize: 100 }).items
    .filter((contact) => contact.reviewApproved && contact.phoneRaw)
    .slice(0, count)
    .map((contact) => contact.id);
  for (const id of ids) database.confirmConsent(id, 'teste');
  return ids;
}

test('a prévia lista exatamente quem entraria no lote, sem enfileirar nada', async (t) => {
  const { baseUrl, database } = await createTestServer(t);
  await authorize(database, 5);

  const response = await fetch(`${baseUrl}/api/queue/preview?limit=3`);
  assert.equal(response.status, 200);
  const preview = await response.json();

  assert.equal(preview.contacts.length, 3);
  assert.equal(preview.eligibleTotal, 5);
  for (const contact of preview.contacts) {
    assert.ok(contact.company, 'toda linha tem um rótulo, nem que seja o telefone');
    if (contact.hasCompanyName) {
      assert.ok(contact.message.includes(contact.company), 'a mensagem já vem montada para o destinatário');
    } else {
      // Sem nome não dá para preencher {empresa}: a linha vem marcada em vez de
      // sair com um buraco no meio da mensagem.
      assert.equal(contact.needsCompanyName, true);
      assert.equal(contact.message, null);
    }
  }
  assert.equal(database.getQueueView().status, 'idle', 'a prévia não cria lote');
});

test('a prévia respeita o teto de lote mesmo se o painel pedir mais', async (t) => {
  const { baseUrl, database } = await createTestServer(t);
  const authorized = await authorize(database, 25);
  const preview = await (await fetch(`${baseUrl}/api/queue/preview?limit=999`)).json();

  // Nunca passa do teto, e nunca inventa contato além dos elegíveis.
  assert.ok(preview.contacts.length <= baseConfig.maxBatchSize);
  assert.equal(preview.contacts.length, Math.min(baseConfig.maxBatchSize, authorized.length));
  assert.equal(preview.limit, Math.min(baseConfig.maxBatchSize, 999));
});

test('o lote enfileira apenas os destinatários que sobraram na lista', async (t) => {
  const { baseUrl, database } = await createTestServer(t);
  const authorized = await authorize(database, 4);
  const kept = authorized.slice(0, 2);

  const response = await post(baseUrl, '/api/queue/start', {
    contactIds: kept,
    intervalSeconds: 180,
    authorizationAcknowledged: true,
  });
  assert.equal(response.status, 202);
  const { queue } = await response.json();
  assert.equal(queue.total, 2, 'os removidos ficaram de fora');

  const queued = database.listContacts({ filter: 'all', pageSize: 100 }).items
    .filter((contact) => authorized.includes(contact.id) && contact.status === 'sending');
  assert.ok(queued.every((contact) => kept.includes(contact.id)));
});

test('remover na tela não burla o opt-in: id sem autorização derruba o lote inteiro', async (t) => {
  const { baseUrl, database } = await createTestServer(t);
  const authorized = await authorize(database, 2);
  const semOptIn = database.listContacts({ filter: 'consent', pageSize: 5 }).items[0];

  const response = await post(baseUrl, '/api/queue/start', {
    contactIds: [...authorized, semOptIn.id],
    intervalSeconds: 180,
    authorizationAcknowledged: true,
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, 'SELECTION_STALE');
  assert.equal(database.getQueueView().status, 'idle');
});

test('a confirmação de autorização continua obrigatória com lista escolhida', async (t) => {
  const { baseUrl, database } = await createTestServer(t);
  const authorized = await authorize(database, 2);
  const response = await post(baseUrl, '/api/queue/start', {
    contactIds: authorized,
    intervalSeconds: 180,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'CONFIRMATION_REQUIRED');
});

test('a seleção não passa do limite de lote', async (t) => {
  const { baseUrl } = await createTestServer(t);
  // O tamanho é validado antes da elegibilidade, então ids sintéticos bastam e
  // o teste não fica preso ao tamanho do fixture.
  const excessivo = Array.from({ length: baseConfig.maxBatchSize + 1 }, (_, index) => index + 1);
  const response = await post(baseUrl, '/api/queue/start', {
    contactIds: excessivo,
    intervalSeconds: 180,
    authorizationAcknowledged: true,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_BATCH_SIZE');
});

test('{empresa} na mensagem barra o lote enquanto houver destinatário sem nome', async (t) => {
  const { baseUrl, database } = await createTestServer(t);
  const semNome = database.listContacts({ filter: 'consent', pageSize: 100 }).items
    .find((contact) => !contact.hasCompanyName);
  assert.ok(semNome, 'o fixture precisa de um contato sem nome');
  database.confirmConsent(semNome.id, 'teste');

  const response = await post(baseUrl, '/api/queue/start', {
    contactIds: [semNome.id],
    intervalSeconds: 180,
    authorizationAcknowledged: true,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'MISSING_COMPANY_NAMES');
  assert.equal(database.getQueueView().status, 'idle');
});

test('sem {empresa} na mensagem, contato só com número é enviado normalmente', async (t) => {
  const { baseUrl, database } = await createTestServer(t);
  const semNome = database.listContacts({ filter: 'consent', pageSize: 100 }).items
    .find((contact) => !contact.hasCompanyName);
  database.confirmConsent(semNome.id, 'teste');
  database.setSetting('message_template', 'Oi! Podemos conversar por aqui?');

  const response = await post(baseUrl, '/api/queue/start', {
    contactIds: [semNome.id],
    intervalSeconds: 180,
    authorizationAcknowledged: true,
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queue.total, 1);
});
