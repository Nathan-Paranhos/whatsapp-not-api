const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TEMPLATE,
  normalizeCompanyName,
  renderTemplate,
  validateTemplate,
  usesCompanyToken,
  hashMessage,
} = require('../src/lib/template');

test('personaliza todas as ocorrências de {empresa}', () => {
  assert.equal(renderTemplate('Oi, {empresa}. Empresa: {empresa}.', '  Doce\nLar  '), 'Oi, Doce Lar. Empresa: Doce Lar.');
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
  assert.equal(renderTemplate('Oi, tudo bem?', ''), 'Oi, tudo bem?');

  assert.equal(usesCompanyToken('Oi, {empresa}'), true);
  assert.throws(() => renderTemplate('Oi, {empresa}', ''), (error) => error.code === 'INVALID_COMPANY');
});

test('modelo inicial é válido, nome é normalizado e hash é estável', () => {
  assert.equal(validateTemplate(DEFAULT_TEMPLATE).valid, true);
  assert.equal(normalizeCompanyName('A\tB\nC'), 'A B C');
  assert.equal(hashMessage('abc'), hashMessage('abc'));
  assert.notEqual(hashMessage('abc'), hashMessage('abd'));
});

