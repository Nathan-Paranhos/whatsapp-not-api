const test = require('node:test');
const assert = require('node:assert/strict');
const { containsOptOut } = require('../src/whatsapp-service');

test('reconhece pedidos explícitos de saída', () => {
  for (const phrase of ['SAIR', 'parar', 'Não quero receber', 'não quero mais receber', 'me remova', 'não tenho interesse']) {
    assert.equal(containsOptOut(phrase), true, phrase);
  }
});

test('não confunde resposta comum com opt-out', () => {
  assert.equal(containsOptOut('Sim, quero ver como funciona'), false);
  assert.equal(containsOptOut('Podemos conversar amanhã?'), false);
});
