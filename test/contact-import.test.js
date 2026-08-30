const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AppDatabase } = require('../src/database');
const { parseContactList, detectFormat } = require('../src/import/parse-contacts');

function createDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-import-'));
  const database = new AppDatabase({
    databasePath: path.join(tempDir, 'test.db'),
    seedPath: null,
  });
  t.after(() => {
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });
  return database;
}

test('reconhece sozinho JSON, CSV e texto livre', () => {
  assert.equal(detectFormat('[{"telefone":"71991111111"}]'), 'json');
  assert.equal(detectFormat('{"contacts":[]}'), 'json');
  assert.equal(detectFormat('empresa;telefone\nLoja;71991111111'), 'csv');
  assert.equal(detectFormat('Loja — 71991111111'), 'text');
  assert.equal(detectFormat('   '), 'empty');
  // Vírgula sem cabeçalho de telefone é texto, não CSV.
  assert.equal(detectFormat('Loja A, 71991111111'), 'text');
});

test('texto livre separa nome e telefone em vários formatos de linha', () => {
  const { contacts, summary } = parseContactList([
    'Padaria Aurora — (71) 99111-1111',
    '2. Café Bom Dia - 71 99222-2222',
    'Mercado Central, 71993333333',
    'Loja 2 | 71994444444',
    'Doceria Lua: +55 71 99555-5555',
  ].join('\n'));

  assert.deepEqual(contacts.map((contact) => contact.companyDisplay), [
    'Padaria Aurora', 'Café Bom Dia', 'Mercado Central', 'Loja 2', 'Doceria Lua',
  ]);
  assert.equal(contacts[0].phoneE164, '+5571991111111');
  assert.equal(contacts[4].phoneE164, '+5571995555555');
  assert.equal(summary.unnamed, 0);
});

test('lista só de números importa sem nome e o resumo avisa quantos ficaram assim', () => {
  const { contacts, summary } = parseContactList('71991111111\n+5571992222222\n(71) 99333-3333');
  assert.equal(contacts.length, 3);
  assert.deepEqual(contacts.map((contact) => contact.companyDisplay), ['', '', '']);
  assert.equal(summary.unnamed, 3);
  assert.equal(summary.named, 0);
  assert.equal(summary.valid, 3);
});

test('CSV aceita separador, acento e ordem de coluna variados', () => {
  const semicolon = parseContactList('Telefone;Empresa;Cidade\n71991111111;Padaria Ação;Salvador');
  assert.equal(semicolon.format, 'csv');
  assert.equal(semicolon.contacts[0].companyDisplay, 'Padaria Ação');
  assert.equal(semicolon.contacts[0].city, 'Salvador');

  const comma = parseContactList('nome,celular\n"Bar, do Zé",71992222222');
  assert.equal(comma.contacts[0].companyDisplay, 'Bar, do Zé');
  assert.equal(comma.contacts[0].phoneE164, '+5571992222222');
});

test('JSON aceita objetos com chaves variadas e também lista de números', () => {
  const objetos = parseContactList(JSON.stringify([
    { empresa: 'Loja A', telefone: '71991111111' },
    { nome: 'Loja B', numero: '71992222222' },
    { company: 'Loja C', phone: '71993333333', city: 'Salvador' },
    { phone: '71994444444' },
  ]));
  assert.deepEqual(objetos.contacts.map((c) => c.companyDisplay), ['Loja A', 'Loja B', 'Loja C', '']);
  assert.equal(objetos.contacts[2].city, 'Salvador');

  const numeros = parseContactList(JSON.stringify(['71995555555', 5571996666666]));
  assert.equal(numeros.contacts.length, 2);
  assert.equal(numeros.contacts[1].phoneE164, '+5571996666666');

  const embrulhado = parseContactList(JSON.stringify({ contacts: [{ telefone: '71997777777' }] }));
  assert.equal(embrulhado.contacts.length, 1);
});

test('telefone repetido é descartado e telefone inválido entra marcado', () => {
  const { contacts, warnings, summary } = parseContactList([
    'Loja A — 71991111111',
    'Loja A de novo — 71991111111',
    'Loja B — 123',
  ].join('\n'));

  assert.equal(contacts.length, 1, 'a repetição não vira um segundo contato');
  assert.equal(summary.invalid, 0);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join(' '), /repetido/);
});

test('fixo e DDD fora da cidade entram pedindo revisão manual', () => {
  const csv = parseContactList('empresa;telefone;cidade\nMercado Central;(71) 3333-4444;Salvador\nDoceria Lua;71995555555;Feira de Santana');

  assert.equal(csv.contacts[0].phoneKind, 'landline');
  assert.equal(csv.contacts[0].needsReview, true);
  assert.equal(csv.contacts[0].reviewApproved, false);
  assert.equal(csv.contacts[1].dddMismatch, true);
  assert.equal(csv.contacts[1].needsReview, true);
  assert.equal(csv.contacts[1].reviewApproved, false);

  // Sem cidade informada não há como avaliar DDD; o celular passa direto.
  const semCidade = parseContactList('Doceria Lua — 71995555555');
  assert.equal(semCidade.contacts[0].dddMismatch, false);
  assert.equal(semCidade.contacts[0].reviewApproved, true);
});

test('importar grava no banco e reimportar o mesmo arquivo não duplica', (t) => {
  const database = createDatabase(t);
  const { contacts } = parseContactList('Padaria Aurora — 71991111111\n71992222222');

  const first = database.importContacts(contacts);
  assert.equal(first.inserted, 2);
  assert.equal(first.duplicated, 0);

  const second = database.importContacts(contacts);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicated, 2);
  assert.equal(database.getSummary().total, 2);
});

test('contato importado começa sem opt-in e fora da fila', (t) => {
  const database = createDatabase(t);
  database.importContacts(parseContactList('Padaria Aurora — 71991111111').contacts);

  const summary = database.getSummary();
  assert.equal(summary.total, 1);
  assert.equal(summary.eligible, 0, 'importar nunca autoriza ninguém');
  assert.equal(summary.awaiting_consent, 1);
});

test('reimportar preserva o opt-in já registrado', (t) => {
  const database = createDatabase(t);
  const { contacts } = parseContactList('Padaria Aurora — 71991111111');
  database.importContacts(contacts);

  const contact = database.listContacts({ pageSize: 10 }).items[0];
  database.confirmConsent(contact.id, 'formulário do site · 01/08/2026');

  database.importContacts(contacts);
  const after = database.getContact(contact.id);
  assert.equal(after.consentStatus, 'confirmed');
  assert.equal(after.consentNote, 'formulário do site · 01/08/2026');
  assert.equal(database.getSummary().total, 1);
});

test('banco novo sem lista inicial abre vazio em vez de falhar', (t) => {
  const database = createDatabase(t);
  assert.equal(database.getSummary().total, 0);
  assert.deepEqual(database.getCities(), []);
});

test('apagar todos os contatos não derruba o próximo start nem ressuscita a lista', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-seed-'));
  const args = {
    databasePath: path.join(tempDir, 'test.db'),
    seedPath: path.resolve(__dirname, 'fixtures/contacts.json'),
  };
  t.after(() => {
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });

  const primeira = new AppDatabase(args);
  assert.ok(primeira.getSummary().total > 0, 'a primeira abertura semeia a lista');
  primeira.deleteContactsByFilter({});
  assert.equal(primeira.getSummary().total, 0);
  primeira.close();

  // Antes da correção isto batia na restrição UNIQUE de imports.source_hash.
  const segunda = new AppDatabase(args);
  assert.equal(segunda.getSummary().total, 0, 'a lista apagada de propósito não volta sozinha');
  segunda.close();

  const terceira = new AppDatabase(args);
  assert.equal(terceira.getSummary().total, 0);
  terceira.close();
});

test('banco existente com contatos não é semeado de novo', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-seed2-'));
  const args = {
    databasePath: path.join(tempDir, 'test.db'),
    seedPath: path.resolve(__dirname, 'fixtures/contacts.json'),
  };
  t.after(() => {
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });

  const primeira = new AppDatabase(args);
  const total = primeira.getSummary().total;
  primeira.close();

  const segunda = new AppDatabase(args);
  assert.equal(segunda.getSummary().total, total, 'reabrir não duplica a lista');
  segunda.close();
});
