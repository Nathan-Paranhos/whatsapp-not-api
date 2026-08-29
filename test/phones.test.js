const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBrazilianPhone, hasCityDddMismatch, maskPhone } = require('../src/lib/phones');

test('normaliza celular brasileiro sem inventar o nono dígito', () => {
  assert.deepEqual(normalizeBrazilianPhone('(71) 99111-1111'), {
    valid: true,
    digits: '71991111111',
    e164: '+5571991111111',
    whatsappDigits: '5571991111111',
    kind: 'mobile',
    ddd: '71',
  });
});

test('preserva telefone fixo e o classifica para revisão', () => {
  const result = normalizeBrazilianPhone('(71) 3333-4444');
  assert.equal(result.kind, 'landline');
  assert.equal(result.e164, '+557133334444');
});

test('rejeita telefone ausente e identifica divergência de DDD', () => {
  assert.equal(normalizeBrazilianPhone('').valid, false);
  assert.equal(hasCityDddMismatch('Salvador', '75'), true);
  assert.equal(hasCityDddMismatch('Salvador', '71'), false);
  assert.equal(maskPhone('+5571991111111'), '+5571 •••••-1111');
});

