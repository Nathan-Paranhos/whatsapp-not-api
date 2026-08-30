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

// ------------------------------------------- importação pelo painel

test('importa pelo painel: analisa primeiro, grava só depois de confirmar', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const antes = database.getSummary().total;
  const content = 'Padaria Nova — (71) 99770-0001\nCafé Central, 71997700002';

  const previa = await (await send(baseUrl, 'POST', '/api/imports/upload', { content })).json();
  assert.equal(previa.imported, false, 'a análise não grava nada');
  assert.equal(previa.format, 'text');
  assert.equal(previa.summary.valid, 2);
  assert.equal(previa.sample.length, 2);
  assert.equal(database.getSummary().total, antes);

  const gravado = await (await send(baseUrl, 'POST', '/api/imports/upload', {
    content, filename: 'lista.txt', confirmed: true,
  })).json();
  assert.equal(gravado.imported, true);
  assert.equal(gravado.result.inserted, 2);
  assert.equal(database.getSummary().total, antes + 2);
  assert.equal(database.listImportBatches()[0].source, 'lista.txt');
});

test('importação pelo painel para e avisa quando há contato sem nome', async (t) => {
  const { baseUrl, database } = await createServer(t);
  const antes = database.getSummary().total;
  const content = 'Padaria Nova — 71997700001\n71997700002';

  const bloqueado = await (await send(baseUrl, 'POST', '/api/imports/upload', { content, confirmed: true })).json();
  assert.equal(bloqueado.needsUnnamedConfirmation, true);
  assert.equal(bloqueado.imported, false);
  assert.equal(bloqueado.summary.unnamed, 1);
  assert.equal(database.getSummary().total, antes, 'nada foi gravado sem a confirmação');

  const liberado = await (await send(baseUrl, 'POST', '/api/imports/upload', {
    content, confirmed: true, allowUnnamed: true,
  })).json();
  assert.equal(liberado.imported, true);
  assert.equal(database.getSummary().total, antes + 2);
});

test('importação pelo painel recusa conteúdo vazio ou sem contato utilizável', async (t) => {
  const { baseUrl } = await createServer(t);

  const vazio = await send(baseUrl, 'POST', '/api/imports/upload', { content: '   ' });
  assert.equal(vazio.status, 400);
  assert.equal((await vazio.json()).code, 'EMPTY_CONTENT');

  const inutil = await send(baseUrl, 'POST', '/api/imports/upload', { content: 'linha sem telefone nenhum' });
  assert.equal(inutil.status, 400);
  assert.equal((await inutil.json()).code, 'NOTHING_TO_IMPORT');
});

test('importação pelo painel aceita CSV e JSON colados', async (t) => {
  const { baseUrl } = await createServer(t);

  const csv = await (await send(baseUrl, 'POST', '/api/imports/upload', {
    content: 'empresa;telefone\nLoja CSV;71997710001',
  })).json();
  assert.equal(csv.format, 'csv');

  const json = await (await send(baseUrl, 'POST', '/api/imports/upload', {
    content: JSON.stringify([{ empresa: 'Loja JSON', telefone: '71997720001' }]),
  })).json();
  assert.equal(json.format, 'json');
});

// --------------------------------------- limpar o lote do painel

test('limpar o lote devolve a fila ao estado inicial', async (t) => {
  const { baseUrl, database, system } = await createServer(t);
  database.setSetting('message_template', 'Oi! Podemos conversar por aqui?');
  database.confirmConsent(1, 'teste');

  const { runId } = system.runner.start({ limit: 1, intervalSeconds: 180, authorizationAcknowledged: true });
  system.runner.stop();
  system.runner.cancel();
  assert.equal(database.getQueueView().status, 'canceled', 'o lote cancelado continua à vista');

  const response = await send(baseUrl, 'DELETE', `/api/queue/${runId}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).queue.status, 'idle');
  assert.equal(database.getQueueView().status, 'idle');
  assert.equal(database.getContact(1).status, 'pending', 'o contato volta para a lista');
});

test('não dá para limpar um lote que ainda está rodando', async (t) => {
  const { baseUrl, database, system } = await createServer(t);
  database.setSetting('message_template', 'Oi! Podemos conversar por aqui?');
  database.confirmConsent(1, 'teste');
  const { runId } = system.runner.start({ limit: 1, intervalSeconds: 180, authorizationAcknowledged: true });
  system.runner.stop();

  const response = await send(baseUrl, 'DELETE', `/api/queue/${runId}`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'CAMPAIGN_ACTIVE');
  assert.equal(database.getQueueView().status, 'running');
});

test('limpar o lote não apaga o histórico do que já foi enviado', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.confirmConsent(1, 'teste');
  const run = database.createCampaign({ contactIds: [1], templateHash: 'hash', intervalSeconds: 180 });
  const job = database.leaseNextJob(run.id, () => 'mensagem enviada', 'hash');
  database.completeJob({
    jobId: job.job_id,
    contactId: job.contact_id,
    deliveryId: job.deliveryId,
    outcome: 'sent',
    messageId: 'msg-guardada',
  });
  // O lote precisa estar encerrado para poder ser limpo do painel.
  database.finishCampaignIfDone(run.id);

  assert.equal((await send(baseUrl, 'DELETE', `/api/queue/${run.id}`)).status, 200);

  assert.equal(database.getQueueView().status, 'idle');
  assert.equal(database.getContact(1).status, 'sent', 'quem recebeu continua marcado como enviado');
  const historico = database.listDeliveries(1);
  assert.equal(historico.length, 1, 'a entrega continua registrada');
  assert.equal(historico[0].message, 'mensagem enviada');
});

// ------------------------------------------------ variáveis personalizadas

test('adiciona, usa e remove variável personalizada pela API', async (t) => {
  const { baseUrl, database } = await createServer(t);

  const inicial = await (await fetch(`${baseUrl}/api/variables`)).json();
  assert.deepEqual(inicial.contact.map((item) => item.name), ['empresa', 'cidade', 'telefone']);
  assert.deepEqual(inicial.custom, []);

  const salvou = await send(baseUrl, 'PUT', '/api/variables', {
    variables: [{ name: 'Meu Nome', value: 'Nathan' }, { name: 'link', value: 'exemplo.com' }],
  });
  assert.equal(salvou.status, 200);
  assert.deepEqual((await salvou.json()).custom, [
    { name: 'meunome', value: 'Nathan' },
    { name: 'link', value: 'exemplo.com' },
  ]);

  // agora a mensagem pode citá-las
  const template = 'Oi {empresa} de {cidade}, aqui é {meunome}. {link}';
  assert.equal((await send(baseUrl, 'PUT', '/api/template', { template })).status, 200);

  const removida = await send(baseUrl, 'PUT', '/api/variables', { variables: [{ name: 'link', value: 'exemplo.com' }] });
  assert.equal(removida.status, 409, 'não remove variável que a mensagem usa');
  assert.equal((await removida.json()).code, 'TEMPLATE_USES_VARIABLE');
  assert.equal(database.getCustomVariables().length, 2);

  await send(baseUrl, 'PUT', '/api/template', { template: 'Oi {empresa}!' });
  assert.equal((await send(baseUrl, 'PUT', '/api/variables', { variables: [] })).status, 200);
  assert.deepEqual(database.getCustomVariables(), []);
});

test('variável inválida é recusada com a razão', async (t) => {
  const { baseUrl } = await createServer(t);

  const colide = await send(baseUrl, 'PUT', '/api/variables', { variables: [{ name: 'empresa', value: 'x' }] });
  assert.equal(colide.status, 400);
  assert.match((await colide.json()).error, /já é uma variável do contato/);

  const comChave = await send(baseUrl, 'PUT', '/api/variables', { variables: [{ name: 'ok', value: '{x}' }] });
  assert.equal(comChave.status, 400);

  const formato = await send(baseUrl, 'PUT', '/api/variables', { variables: 'não é lista' });
  assert.equal(formato.status, 400);
  assert.equal((await formato.json()).code, 'INVALID_VARIABLES');
});

test('a mensagem enviada usa as variáveis do contato e as personalizadas', async (t) => {
  const { baseUrl, database } = await createServer(t);
  await send(baseUrl, 'PUT', '/api/variables', { variables: [{ name: 'meunome', value: 'Nathan' }] });
  database.setSetting('message_template', 'Oi {empresa} de {cidade}, aqui é {meunome}.');
  database.confirmConsent(1, 'teste');

  const previa = await (await fetch(`${baseUrl}/api/queue/preview?limit=1`)).json();
  assert.equal(previa.contacts[0].message, 'Oi Padaria Aurora de Salvador, aqui é Nathan.');
});

test('lote é barrado quando a variável do contato falta em alguém', async (t) => {
  const { baseUrl, database } = await createServer(t);
  database.setSetting('message_template', 'Oi {empresa} de {cidade}!');

  // o contato #4 do fixture não tem nome nem cidade
  const semDados = database.listContacts({ filter: 'consent', pageSize: 100 }).items
    .find((contact) => !contact.hasCompanyName);
  database.confirmConsent(semDados.id, 'teste');

  const response = await send(baseUrl, 'POST', '/api/queue/start', {
    contactIds: [semDados.id],
    intervalSeconds: 180,
    authorizationAcknowledged: true,
  });
  assert.equal(response.status, 400);
  const erro = await response.json();
  assert.equal(erro.code, 'MISSING_COMPANY_NAMES');
  assert.match(erro.error, /\{empresa\}/);
  assert.match(erro.error, /\{cidade\}/);
});
