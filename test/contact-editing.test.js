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

function createDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-edit-'));
  const database = new AppDatabase({ databasePath: path.join(tempDir, 'test.db'), seedPath: FIXTURE });
  t.after(() => {
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });
  return database;
}

async function createServer(t) {
  const database = createDatabase(t);
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

// ------------------------------------------------------------------ exclusão

test('apagar um contato o remove da lista e do resumo', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const antes = database.getSummary().total;

  const response = await send(baseUrl, 'DELETE', '/api/contacts/1');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, 1);

  assert.equal(database.getSummary().total, antes - 1);
  assert.equal(database.getContact(1), null);
});

test('apagar um contato suprimido NÃO libera o número de volta', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const alvo = database.getContact(2);
  const telefone = alvo.phoneRaw;

  database.suppressContact(2, 'Respondeu SAIR');
  assert.equal(database.getContact(2).status, 'suppressed');

  assert.equal((await send(baseUrl, 'DELETE', '/api/contacts/2')).status, 200);
  assert.equal(database.getContact(2), null);

  // A supressão continua de pé, agora sem dono, presa ao telefone. Reimportar
  // o mesmo número não pode devolvê-lo à fila.
  const { contacts } = parseContactList(`Empresa Reimportada — ${telefone}`);
  assert.equal(database.importContacts(contacts).inserted, 1);
  const reimportado = database.listContacts({ search: 'Empresa Reimportada', pageSize: 10 }).items[0];
  assert.ok(reimportado, 'o contato foi reimportado');
  assert.equal(reimportado.phoneRaw, telefone, 'o telefone é regravado igualzinho');

  database.confirmConsent(reimportado.id, 'teste');
  assert.equal(
    database.getContact(reimportado.id).eligible,
    false,
    'quem pediu SAIR continua bloqueado mesmo depois de apagado e reimportado',
  );
});

test('não dá para apagar contato preso a um lote ativo', async (t) => {
  const { baseUrl, database, system } = await createServer(t);
  database.confirmConsent(1, 'teste');
  system.runner.start({ limit: 1, intervalSeconds: 180, authorizationAcknowledged: true });
  // Congela o worker: o lote fica registrado como ativo sem processar o job,
  // que é exatamente a situação que a trava precisa cobrir.
  system.runner.stop();

  const response = await send(baseUrl, 'DELETE', '/api/contacts/1');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'CONTACT_IN_ACTIVE_RUN');
  assert.ok(database.getContact(1), 'o contato continua lá');
});

test('o histórico do painel sobrevive à exclusão do contato', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.confirmConsent(1, 'formulário do site');
  const antes = database.listEvents(50).length;

  assert.equal((await send(baseUrl, 'DELETE', '/api/contacts/1')).status, 200);
  const eventos = database.listEvents(50);
  assert.ok(eventos.length > antes, 'a exclusão entra no histórico');
  assert.ok(eventos.some((evento) => evento.type === 'contact.deleted'));
});

// ----------------------------------------------------------- exclusão em massa

test('exclusão em massa apaga exatamente o conjunto filtrado', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const total = database.getSummary().total;
  const alvo = database.countContacts({ filter: 'review' });
  assert.ok(alvo > 0 && alvo < total, 'o filtro precisa pegar parte da lista');

  const response = await send(baseUrl, 'POST', '/api/contacts/delete-many', { filter: 'review', confirmed: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, alvo);

  assert.equal(database.getSummary().total, total - alvo);
  assert.equal(database.countContacts({ filter: 'review' }), 0);
});

test('exclusão em massa respeita a busca por texto', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const total = database.getSummary().total;

  const response = await send(baseUrl, 'POST', '/api/contacts/delete-many', { search: 'Aurora', confirmed: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, 1);
  assert.equal(database.getSummary().total, total - 1);
});

test('exclusão em massa exige confirmação explícita', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const total = database.getSummary().total;

  const response = await send(baseUrl, 'POST', '/api/contacts/delete-many', { filter: 'all' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'CONFIRMATION_REQUIRED');
  assert.equal(database.getSummary().total, total, 'nada foi apagado');
});

test('exclusão em massa é recusada se a contagem mudou desde a tela', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const atual = database.countContacts({ filter: 'all' });

  const response = await send(baseUrl, 'POST', '/api/contacts/delete-many', {
    filter: 'all',
    confirmed: true,
    expected: atual + 5,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'COUNT_MISMATCH');
  assert.equal(database.getSummary().total, atual, 'nada foi apagado');
});

test('exclusão em massa é bloqueada enquanto houver lote ativo', async (t) => {
  const { baseUrl, database, system } = await createServer(t);
  database.confirmConsent(1, 'teste');
  system.runner.start({ limit: 1, intervalSeconds: 180, authorizationAcknowledged: true });
  system.runner.stop();
  const total = database.getSummary().total;

  const response = await send(baseUrl, 'POST', '/api/contacts/delete-many', { filter: 'all', confirmed: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'CAMPAIGN_ACTIVE');
  assert.equal(database.getSummary().total, total);
});

// -------------------------------------------------------------------- edição

test('corrigir o telefone reclassifica o contato e derruba a revisão aprovada', async (t) => {
  const { baseUrl, database } = await createServer(t);
  assert.equal(database.getContact(1).reviewApproved, true);

  const response = await send(baseUrl, 'PATCH', '/api/contacts/1', { phone: '(71) 3333-9090' });
  assert.equal(response.status, 200);

  const contato = database.getContact(1);
  assert.equal(contato.phoneKind, 'landline');
  assert.equal(contato.needsReview, true);
  assert.equal(contato.reviewApproved, false, 'o dado mudou, a conferência anterior não vale mais');
  assert.equal(contato.eligible, false);
});

test('contato sem telefone volta a ser utilizável quando ganha um número', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const semTelefone = database.listContacts({ filter: 'invalid', pageSize: 10 }).items[0];
  assert.equal(semTelefone.status, 'invalid');

  assert.equal((await send(baseUrl, 'PATCH', `/api/contacts/${semTelefone.id}`, { phone: '71997770001' })).status, 200);
  assert.equal(database.getContact(semTelefone.id).status, 'pending');
});

test('telefone inválido ou já usado por outro contato é recusado', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const outro = database.getContact(2).phoneRaw;

  const invalido = await send(baseUrl, 'PATCH', '/api/contacts/1', { phone: '123' });
  assert.equal(invalido.status, 400);
  assert.equal((await invalido.json()).code, 'INVALID_PHONE');

  const duplicado = await send(baseUrl, 'PATCH', '/api/contacts/1', { phone: outro });
  assert.equal(duplicado.status, 409);
  assert.equal((await duplicado.json()).code, 'DUPLICATE_PHONE');
});

test('PATCH sem nenhum campo é recusado em vez de virar no-op silencioso', async (t) => {
  const { baseUrl } = await createServer(t);
  const response = await send(baseUrl, 'PATCH', '/api/contacts/1', {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'NOTHING_TO_UPDATE');
});

// ------------------------------------------------------------------ desfazer

test('revogar o opt-in tira o contato da elegibilidade', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.confirmConsent(1, 'registrado por engano');
  assert.equal(database.getContact(1).eligible, true);

  const response = await send(baseUrl, 'DELETE', '/api/contacts/1/consent', { reason: 'engano' });
  assert.equal(response.status, 200);

  const contato = database.getContact(1);
  assert.equal(contato.consentStatus, 'unknown');
  assert.equal(contato.consentNote, null);
  assert.equal(contato.eligible, false);
});

test('desfazer a revisão devolve o contato para conferência', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.confirmConsent(1, 'teste');
  assert.equal(database.getContact(1).eligible, true);

  assert.equal((await send(baseUrl, 'DELETE', '/api/contacts/1/review')).status, 200);
  const contato = database.getContact(1);
  assert.equal(contato.reviewApproved, false);
  assert.equal(contato.eligible, false);
});

test('a rota de detalhe informa o que se perde ao apagar', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.suppressContact(2, 'SAIR');

  const response = await fetch(`${baseUrl}/api/contacts/2`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.contact.id, 2);
  assert.equal(payload.stats.suppressed, 1);
  assert.equal(payload.stats.deliveries, 0);
});

test('envio individual recusa número suprimido que voltou por reimportação', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const telefone = database.getContact(2).phoneRaw;

  // Alguém pediu SAIR, foi apagado da lista e o número voltou numa reimportação.
  database.suppressContact(2, 'Respondeu SAIR');
  database.deleteContact(2);
  database.importContacts(parseContactList(`Voltou Pela Porta Dos Fundos — ${telefone}`).contacts);

  const voltou = database.listContacts({ search: 'Voltou Pela Porta', pageSize: 10 }).items[0];
  database.confirmConsent(voltou.id, 'teste');

  assert.equal(voltou.suppressed, true, 'a listagem já marca o número bloqueado');
  const atual = database.getContact(voltou.id);
  assert.equal(atual.suppressed, true, 'a tela precisa mostrar que o número está bloqueado');
  assert.equal(atual.eligible, false);

  const response = await send(baseUrl, 'POST', `/api/contacts/${voltou.id}/send`, {
    authorizationAcknowledged: true,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'CONTACT_NOT_ELIGIBLE');

  // E o lote também não pode pegá-lo.
  assert.equal(database.selectEligibleContactsByIds([voltou.id]).length, 0);
});
