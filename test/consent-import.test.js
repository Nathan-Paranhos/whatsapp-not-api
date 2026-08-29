const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConsentCsv } = require('../src/import/parse-consents');

test('aceita vírgula, ponto e vírgula, aspas e acentos no cabeçalho', () => {
  const comma = parseConsentCsv('telefone,data,origem\n(71) 99111-1111,28/08/2026,"formulário, site"');
  assert.equal(comma.rows.length, 1);
  assert.equal(comma.rows[0].e164, '+5571991111111');
  assert.equal(comma.rows[0].note, 'formulário, site · 28/08/2026');

  const semicolon = parseConsentCsv('Telefone;Data;Origem;Observação\n71991111111;28/08/2026;WhatsApp;pediu retorno');
  assert.equal(semicolon.rows.length, 1);
  assert.equal(semicolon.rows[0].note, 'WhatsApp · 28/08/2026 · pediu retorno');
});

test('cada linha precisa dizer quando e por onde o contato autorizou', () => {
  const parsed = parseConsentCsv([
    'telefone,data,origem',
    '71991111111,,site',
    '71993815124,28/08/2026,',
    '71993815125,28/08/2026,indicação',
  ].join('\n'));

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].source, 'indicação');
  assert.deepEqual(parsed.errors.map((error) => error.line), [2, 3]);
});

test('telefone fora do padrão brasileiro vira erro, não registro em branco', () => {
  const parsed = parseConsentCsv('telefone,data,origem\n123,28/08/2026,site\n,28/08/2026,site');
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors[0].reason, /Telefone inválido/);
});

test('cabeçalho incompleto interrompe a importação', () => {
  const parsed = parseConsentCsv('telefone,data\n71991111111,28/08/2026');
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.errors[0].reason, /origem/);
});

test('arquivo vazio não gera linhas', () => {
  const parsed = parseConsentCsv('   \n\n');
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.errors.length, 1);
});
