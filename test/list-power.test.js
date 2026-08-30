const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const { AppDatabase } = require('../src/database');
const { parseContactList } = require('../src/import/parse-contacts');
const { createSystem } = require('../src/server');

const FIXTURE = path.resolve(__dirname, 'fixtures/contacts.json');

class ReadyWhatsApp extends EventEmitter {
  getStatus() {
    return { status: 'ready', qrDataUrl: null, account: null, message: 'pronto', updatedAt: new Date().toISOString() };
  }

  async start() { return this.getStatus(); }
  async reconnect() { return this.getStatus(); }
  async destroy() {}
  async sendText() { return { registered: true, messageId: 'mock' }; }
}

async function createServer(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-power-'));
  const database = new AppDatabase({ databasePath: path.join(tempDir, 'test.db'), seedPath: FIXTURE });
  const system = createSystem({
    database,
    whatsapp: new ReadyWhatsApp(),
    config: { ...baseConfig, port: 0, whatsappAutostart: false, businessHourStart: 0, businessHourEnd: 24 },
  });
  const server = http.createServer(system.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    system.runner.stop();
    system.hub.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });

  return { baseUrl: `http://127.0.0.1:${server.address().port}`, database, system };
}

function send(baseUrl, method, url, body) {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Local-Client': 'test' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --------------------------------------------------- 1. histórico por contato

test('o detalhe do contato traz a mensagem exata que foi enviada', async (t) => {
  const { baseUrl, database, system } = await createServer(t);
  database.confirmConsent(1, 'teste');
  database.setSetting('message_template', 'Olá, {empresa}! Mensagem da versão antiga.');

  const run = database.createCampaign({ contactIds: [1], templateHash: 'hash', intervalSeconds: 180 });
  const job = database.leaseNextJob(run.id, (c) => `Olá, ${c.company_display}! Mensagem da versão antiga.`, 'hash');
  database.completeJob({
    jobId: job.job_id,
    contactId: job.contact_id,
    deliveryId: job.deliveryId,
    outcome: 'sent',
    messageId: 'msg-1',
  });

  // O modelo muda depois; o histórico precisa continuar mostrando o que saiu.
  database.setSetting('message_template', 'Texto completamente diferente agora.');

  const payload = await (await fetch(`${baseUrl}/api/contacts/1`)).json();
  assert.equal(payload.deliveries.length, 1);
  assert.match(payload.deliveries[0].message, /Mensagem da versão antiga/);
  assert.equal(payload.deliveries[0].status, 'sent');
  assert.equal(payload.deliveries[0].messageId, 'msg-1');
  assert.equal(payload.stats.sent, 1);
  system.runner.stop();
});

// ------------------------------------------------- 2. desfazer uma importação

test('cada importação vira um lote que pode ser desfeito inteiro', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const antes = database.getSummary().total;

  const primeiro = database.importContacts(
    parseContactList('Lote Um A — 71987650001\nLote Um B — 71987650002').contacts,
    { source: 'primeiro.txt', format: 'text' },
  );
  const segundo = database.importContacts(
    parseContactList('Lote Dois A — 71987650003').contacts,
    { source: 'segundo.csv', format: 'csv' },
  );
  assert.equal(database.getSummary().total, antes + 3);

  const { batches } = await (await fetch(`${baseUrl}/api/imports`)).json();
  assert.equal(batches.length, 2);
  assert.equal(batches[0].source, 'segundo.csv');
  assert.equal(batches[0].remaining, 1);

  const response = await send(baseUrl, 'DELETE', `/api/imports/${primeiro.batchId}`, { confirmed: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, 2);

  assert.equal(database.getSummary().total, antes + 1, 'só o primeiro lote saiu');
  assert.equal(database.countContacts({ importBatchId: segundo.batchId }), 1);
});

test('desfazer importação não toca na lista inicial nem em outros lotes', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const seed = database.getSummary().total;

  const lote = database.importContacts(
    parseContactList('Importado — 71987650009').contacts,
    { source: 'x.txt', format: 'text' },
  );
  await send(baseUrl, 'DELETE', `/api/imports/${lote.batchId}`, { confirmed: true });

  assert.equal(database.getSummary().total, seed, 'a lista inicial ficou intacta');
  assert.equal((await (await fetch(`${baseUrl}/api/imports`)).json()).batches.length, 0);
});

test('desfazer importação exige confirmação e preserva a supressão', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const lote = database.importContacts(
    parseContactList('Vai Sair — 71987650011').contacts,
    { source: 'y.txt', format: 'text' },
  );
  const importado = database.listContacts({ search: 'Vai Sair', pageSize: 5 }).items[0];
  database.suppressContact(importado.id, 'SAIR');

  const semConfirmar = await send(baseUrl, 'DELETE', `/api/imports/${lote.batchId}`, {});
  assert.equal(semConfirmar.status, 400);
  assert.equal(database.getContact(importado.id).status, 'suppressed');

  assert.equal((await send(baseUrl, 'DELETE', `/api/imports/${lote.batchId}`, { confirmed: true })).status, 200);

  // O número volta bloqueado mesmo depois do lote inteiro sumir.
  database.importContacts(parseContactList('Tentou Voltar — 71987650011').contacts);
  const devolta = database.listContacts({ search: 'Tentou Voltar', pageSize: 5 }).items[0];
  database.confirmConsent(devolta.id, 'teste');
  assert.equal(database.getContact(devolta.id).eligible, false);
});

// ------------------------------------------------------------- 3. etiquetas

test('etiquetas são normalizadas, filtram a lista e aparecem no contato', async (t) => {
  const { baseUrl, database } = await createServer(t);

  const response = await send(baseUrl, 'PUT', '/api/contacts/1/tags', { tags: ['Clientes', ' clientes ', 'VIP'] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).contact.tags, ['clientes', 'vip']);

  await send(baseUrl, 'PUT', '/api/contacts/2/tags', { tags: ['clientes'] });

  const porTag = await (await fetch(`${baseUrl}/api/contacts?tag=vip&pageSize=50`)).json();
  assert.equal(porTag.pagination.total, 1);
  assert.equal(porTag.items[0].id, 1);

  const clientes = await (await fetch(`${baseUrl}/api/contacts?tag=clientes&pageSize=50`)).json();
  assert.equal(clientes.pagination.total, 2);

  const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
  assert.deepEqual(bootstrap.tags, [{ tag: 'clientes', total: 2 }, { tag: 'vip', total: 1 }]);
});

test('etiquetas somem junto com o contato apagado', async (t) => {
  const { baseUrl, database } = await createServer(t);
  await send(baseUrl, 'PUT', '/api/contacts/1/tags', { tags: ['sumir'] });
  assert.equal(database.listTags().length, 1);

  await send(baseUrl, 'DELETE', '/api/contacts/1');
  assert.deepEqual(database.listTags(), []);
});

test('lista de etiquetas inválida é recusada', async (t) => {
  const { baseUrl } = await createServer(t);
  const response = await send(baseUrl, 'PUT', '/api/contacts/1/tags', { tags: 'clientes' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_TAGS');
});

// ------------------------------------------------- 4. exportar o filtro atual

test('a exportação segue o filtro pedido em vez de despejar tudo', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const total = database.getSummary().total;

  const tudo = await (await fetch(`${baseUrl}/api/export.csv`)).text();
  assert.equal(tudo.trim().split('\r\n').length - 1, total, 'sem filtro exporta a base inteira');

  const filtrado = await (await fetch(`${baseUrl}/api/export.csv?search=Aurora`)).text();
  const linhas = filtrado.trim().split('\r\n');
  assert.equal(linhas.length - 1, 1);
  assert.match(linhas[1], /Padaria Aurora/);

  const porStatus = await (await fetch(`${baseUrl}/api/export.csv?filter=review`)).text();
  assert.equal(porStatus.trim().split('\r\n').length - 1, database.countContacts({ filter: 'review' }));
});

test('a exportação inclui a origem do opt-in', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.confirmConsent(1, 'formulário do site · 12/08/2026');

  const csv = await (await fetch(`${baseUrl}/api/export.csv?search=Aurora`)).text();
  assert.match(csv, /consent_note/);
  assert.match(csv, /formulário do site · 12\/08\/2026/);
});

// ----------------------------------------------- 5. resolver envio incerto

test('envio incerto pode ser confirmado como entregue', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.db.prepare("UPDATE contacts SET status = 'uncertain' WHERE id = 1").run();

  const response = await send(baseUrl, 'POST', '/api/contacts/1/resolve', { outcome: 'sent' });
  assert.equal(response.status, 200);

  const contato = database.getContact(1);
  assert.equal(contato.status, 'sent');
  assert.ok(contato.sentAt, 'a data de envio é preenchida');
});

test('envio incerto pode voltar para a fila', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.confirmConsent(1, 'teste');
  database.db.prepare("UPDATE contacts SET status = 'uncertain' WHERE id = 1").run();

  assert.equal((await send(baseUrl, 'POST', '/api/contacts/1/resolve', { outcome: 'pending' })).status, 200);
  const contato = database.getContact(1);
  assert.equal(contato.status, 'pending');
  assert.equal(contato.eligible, true, 'volta a ser enviável, já que o opt-in continua valendo');
});

test('só contato incerto aceita desfecho manual, e o desfecho precisa ser válido', async (t) => {
  const { baseUrl, database } = await createServer(t);

  const naoIncerto = await send(baseUrl, 'POST', '/api/contacts/1/resolve', { outcome: 'sent' });
  assert.equal(naoIncerto.status, 409);
  assert.equal((await naoIncerto.json()).code, 'CONTACT_NOT_UNCERTAIN');

  database.db.prepare("UPDATE contacts SET status = 'uncertain' WHERE id = 1").run();
  const desfechoInvalido = await send(baseUrl, 'POST', '/api/contacts/1/resolve', { outcome: 'sumiu' });
  assert.equal(desfechoInvalido.status, 400);
  assert.equal((await desfechoInvalido.json()).code, 'INVALID_OUTCOME');
  assert.equal(database.getContact(1).status, 'uncertain');
});
