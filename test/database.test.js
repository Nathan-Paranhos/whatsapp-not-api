const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AppDatabase } = require('../src/database');

function createDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-database-'));
  const database = new AppDatabase({
    databasePath: path.join(tempDir, 'test.db'),
    seedPath: path.resolve(__dirname, 'fixtures/contacts.json'),
  });
  t.after(() => {
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });
  return database;
}

test('semeia contatos uma única vez com totais consistentes', (t) => {
  const database = createDatabase(t);
  const summary = database.getSummary();
  assert.equal(summary.total, 30);
  assert.equal(summary.sent, 1);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.eligible, 0);
  assert.equal(database.listContacts({ filter: 'review', pageSize: 100 }).pagination.total, 3);
});

test('contato só fica elegível depois do opt-in e da revisão necessária', (t) => {
  const database = createDatabase(t);
  const clean = database.getContactInternal(2);
  database.confirmConsent(clean.id, 'Pedido de demonstração');
  assert.equal(database.getContact(clean.id).eligible, true);

  const landline = database.getContactInternal(3);
  database.confirmConsent(landline.id);
  assert.equal(database.getContact(landline.id).eligible, false);
  database.approveReview(landline.id);
  assert.equal(database.getContact(landline.id).eligible, true);
  assert.equal(database.getSummary().eligible, 2);
});

test('supressão remove o contato da elegibilidade de forma persistente', (t) => {
  const database = createDatabase(t);
  database.confirmConsent(2);
  database.suppressContact(2, 'Solicitou saída');
  const contact = database.getContact(2);
  assert.equal(contact.status, 'suppressed');
  assert.equal(contact.eligible, false);
  assert.equal(database.getSummary().suppressed, 1);
});

test('opt-out recebido durante um envio não é sobrescrito pela conclusão da entrega', (t) => {
  const database = createDatabase(t);
  database.confirmConsent(2);
  const run = database.createCampaign({ contactIds: [2], templateHash: 'hash', intervalSeconds: 180 });
  const job = database.leaseNextJob(run.id, () => 'mensagem', 'hash');
  database.suppressContact(2, 'SAIR recebido durante o envio');
  database.completeJob({
    jobId: job.job_id,
    contactId: job.contact_id,
    deliveryId: job.deliveryId,
    outcome: 'sent',
    messageId: 'message-race',
  });
  assert.equal(database.getContact(2).status, 'suppressed');
  assert.equal(database.getSummary().suppressed, 1);
});

test('supressão de item pendente conclui o lote e tem precedência sobre respostas futuras', (t) => {
  const database = createDatabase(t);
  database.confirmConsent(2);
  const run = database.createCampaign({ contactIds: [2], templateHash: 'hash', intervalSeconds: 180 });
  database.suppressContact(2, 'Bloqueio durante espera');
  assert.equal(database.finishCampaignIfDone(run.id), true);

  const queue = database.getQueueView();
  assert.equal(queue.status, 'completed');
  assert.equal(queue.total, 1);
  assert.equal(queue.processed, 1);
  assert.equal(queue.canceled, 1);

  database.recordInbound({ from: '5571992222222', body: 'Tudo bem?', isOptOut: false });
  assert.equal(database.getContact(2).status, 'suppressed');
  assert.equal(database.getSummary().suppressed, 1);
});
