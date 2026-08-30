const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TEMPLATE,
  normalizeCompanyName,
  renderTemplate,
  validateTemplate,
  usesCompanyToken,
  hashMessage,
  variablesForContact,
  missingVariablesFor,
  validateCustomVariables,
  normalizeVariableName,
  MAX_VARIABLE_VALUE,
} = require('../src/lib/template');

test('personaliza todas as ocorrências de {empresa}', () => {
  assert.equal(
    renderTemplate('Oi, {empresa}. Empresa: {empresa}.', { empresa: '  Doce\nLar  ' }),
    'Oi, Doce Lar. Empresa: Doce Lar.',
  );
});

test('{empresa} é opcional, mas variável desconhecida continua bloqueada', () => {
  assert.equal(validateTemplate('Oi, tudo bem?').valid, true);
  assert.equal(validateTemplate('').valid, false);

  const invalid = validateTemplate('Oi, {nome} da {empresa}');
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' '), /desconhecida/i);
});

test('mensagem sem {empresa} é renderizada mesmo sem nome de contato', () => {
  assert.equal(usesCompanyToken('Oi, tudo bem?'), false);
  assert.equal(renderTemplate('Oi, tudo bem?', {}), 'Oi, tudo bem?');

  assert.equal(usesCompanyToken('Oi, {empresa}'), true);
  assert.throws(() => renderTemplate('Oi, {empresa}', {}), (error) => error.code === 'INVALID_COMPANY');
});

test('modelo inicial é válido, nome é normalizado e hash é estável', () => {
  assert.equal(validateTemplate(DEFAULT_TEMPLATE).valid, true);
  assert.equal(normalizeCompanyName('A\tB\nC'), 'A B C');
  assert.equal(hashMessage('abc'), hashMessage('abc'));
  assert.notEqual(hashMessage('abc'), hashMessage('abd'));
});


// ------------------------------------------------------- variáveis do painel

test('variáveis do contato saem da linha importada', () => {
  const contato = { company_display: 'Padaria Aurora', city: 'Salvador', phone_raw: '(71) 99111-1111' };
  const valores = variablesForContact(contato);

  assert.equal(valores.empresa, 'Padaria Aurora');
  assert.equal(valores.cidade, 'Salvador');
  assert.equal(valores.telefone, '(71) 99111-1111');
  assert.equal(renderTemplate('Oi {empresa}, de {cidade}!', valores), 'Oi Padaria Aurora, de Salvador!');
});

test('variável personalizada tem valor fixo para todo mundo', () => {
  const custom = [{ name: 'meunome', value: 'Nathan' }, { name: 'link', value: 'exemplo.com' }];
  const contato = { company_display: 'Loja A', city: 'Salvador', phone_raw: '71999999999' };
  const modelo = 'Oi {empresa}, aqui é {meunome}. {link}';

  assert.equal(validateTemplate(modelo, custom).valid, true);
  assert.equal(
    renderTemplate(modelo, variablesForContact(contato, custom), custom),
    'Oi Loja A, aqui é Nathan. exemplo.com',
  );
});

test('variável fora da lista conhecida continua sendo recusada', () => {
  const custom = [{ name: 'meunome', value: 'Nathan' }];

  const semDefinir = validateTemplate('Oi {meunome}');
  assert.equal(semDefinir.valid, false, 'sem a variável definida, a mensagem não vale');
  assert.match(semDefinir.errors.join(' '), /meunome/);

  assert.equal(validateTemplate('Oi {meunome}', custom).valid, true);
  assert.equal(validateTemplate('Oi {naoexiste}', custom).valid, false);
});

test('nome de variável é normalizado e não pode colidir com as do contato', () => {
  assert.equal(normalizeVariableName(' Meu Nome! '), 'meunome');
  assert.equal(normalizeVariableName('Endereço'), 'endereco');

  const colide = validateCustomVariables([{ name: 'empresa', value: 'x' }]);
  assert.equal(colide.valid, false);
  assert.match(colide.errors.join(' '), /já é uma variável do contato/);

  assert.equal(validateCustomVariables([{ name: 'ok', value: '1' }, { name: 'ok', value: '2' }]).valid, false);
  assert.equal(validateCustomVariables([{ name: 'a', value: 'x' }]).valid, false, 'nome de uma letra é recusado');
});

test('valor de variável não pode conter chaves nem passar do limite', () => {
  const comChave = validateCustomVariables([{ name: 'ok', value: 'texto com {chave}' }]);
  assert.equal(comChave.valid, false);
  assert.match(comChave.errors.join(' '), /não pode conter/);

  assert.equal(validateCustomVariables([{ name: 'ok', value: 'x'.repeat(MAX_VARIABLE_VALUE + 1) }]).valid, false);
  assert.equal(validateCustomVariables([{ name: 'ok', value: 'x'.repeat(MAX_VARIABLE_VALUE) }]).valid, true);
});

test('aponta quais variáveis o contato não consegue preencher', () => {
  const custom = [{ name: 'meunome', value: 'Nathan' }];
  const modelo = 'Oi {empresa} de {cidade}, aqui é {meunome}';

  assert.deepEqual(missingVariablesFor(modelo, { company_display: 'Loja', city: 'Salvador', phone_raw: '1' }, custom), []);
  assert.deepEqual(missingVariablesFor(modelo, { company_display: 'Loja', city: '', phone_raw: '1' }, custom), ['cidade']);
  assert.deepEqual(missingVariablesFor(modelo, { company_display: '', city: '', phone_raw: '' }, custom), ['empresa', 'cidade']);
});
