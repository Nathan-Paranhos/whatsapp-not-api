const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AppDatabase } = require('../src/database');
const { CampaignRunner } = require('../src/campaign-runner');

function setup(t, sendText) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-runner-'));
  const database = new AppDatabase({
    databasePath: path.join(tempDir, 'test.db'),
    seedPath: path.resolve(__dirname, 'fixtures/contacts.json'),
  });
  class MockWhatsApp extends EventEmitter {
    getStatus() { return { status: 'ready' }; }
  }
  const whatsapp = new MockWhatsApp();
  whatsapp.sendText = sendText;
  const runner = new CampaignRunner({
    database,
    whatsapp,
    config: {
      minIntervalSeconds: 0,
      defaultIntervalSeconds: 1,
      maxBatchSize: 20,
      hourlyLimit: 20,
      dailyLimit: 50,
      businessHourStart: 0,
      businessHourEnd: 24,
    },
  });

  t.after(() => {
    runner.stop();
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { database, runner };
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Tempo esgotado aguardando a fila.');
}

test('fila envia somente contato autorizado e personaliza {empresa}', async (t) => {
  const calls = [];
  const { database, runner } = setup(t, async (phone, message) => {
    calls.push({ phone, message });
    return { registered: true, messageId: 'message-1' };
  });
  database.confirmConsent(2, 'Autorizado no teste');
  runner.start({ limit: 1, intervalSeconds: 1, authorizationAcknowledged: true });
  await waitFor(() => database.getQueueView().status === 'completed');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone, '5571992222222');
  assert.match(calls[0].message, /Café Bom Dia/);
  assert.doesNotMatch(calls[0].message, /\{empresa\}/);
  assert.equal(database.getContact(2).status, 'sent');
  assert.equal(database.getQueueView().sent, 1);
});

test('número sem WhatsApp vira inválido sem nova tentativa', async (t) => {
  let calls = 0;
  const { database, runner } = setup(t, async () => {
    calls += 1;
    return { registered: false, messageId: null };
  });
  database.confirmConsent(2);
  runner.start({ limit: 1, intervalSeconds: 1, authorizationAcknowledged: true });
  await waitFor(() => database.getQueueView().status === 'completed');

  assert.equal(calls, 1);
  assert.equal(database.getContact(2).status, 'invalid');
  assert.equal(database.getQueueView().invalid, 1);
});

test('erro durante chamada de envio vira resultado incerto e bloqueia reenvio', async (t) => {
  const { database, runner } = setup(t, async () => {
    throw new Error('conexão caiu');
  });
  database.confirmConsent(2);
  runner.start({ limit: 1, intervalSeconds: 1, authorizationAcknowledged: true });
  await waitFor(() => database.getQueueView().status === 'completed');

  assert.equal(database.getContact(2).status, 'uncertain');
  assert.equal(database.getQueueView().uncertain, 1);
  assert.equal(database.getSummary().eligible, 0);
});
