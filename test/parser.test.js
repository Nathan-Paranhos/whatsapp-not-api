const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLeadList } = require('../src/import/parse-leads');

test('interpreta cabeçalho, cidades, tags e linhas sem telefone', () => {
  const source = `Leads de teste
Ja enviado: 1. Padaria Aurora - Salvador - (71) 99222-2222
--- Salvador ---
2. Café Bom Dia — (71) 99111-1111
3. Telefone Fixo — (71) 3333-4444  [fixo]
4. Sem Número —`;
  const result = parseLeadList(source);
  assert.equal(result.contacts.length, 4);
  assert.equal(result.contacts[0].status, 'sent');
  assert.equal(result.contacts[1].city, 'Salvador');
  assert.equal(result.contacts[1].reviewApproved, true);
  assert.equal(result.contacts[2].phoneKind, 'landline');
  assert.equal(result.contacts[2].needsReview, true);
  assert.equal(result.contacts[3].status, 'invalid');
  assert.equal(result.warnings.length, 0);
});

const realSeedPath = path.resolve(__dirname, '../data/seed-contacts.json');

// A lista real de quem usa não vai para o repositório (veja .gitignore), então
// esta verificação só roda na máquina onde o arquivo existe.
test('seed gerada contém a lista completa e os dois telefones ausentes conhecidos', {
  skip: fs.existsSync(realSeedPath) ? false : 'data/seed-contacts.json não está presente',
}, () => {
  const seedPath = realSeedPath;
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  assert.equal(seed.contacts.length, 832);
  assert.equal(seed.summary.sent, 1);
  assert.equal(seed.summary.pending, 829);
  assert.equal(seed.summary.mobile, 645);
  assert.equal(seed.summary.landline, 185);
  assert.deepEqual(
    seed.contacts.filter((contact) => !contact.phoneE164).map((contact) => contact.sourceIndex),
    [292, 324],
  );
  assert.equal(new Set(seed.contacts.filter((contact) => contact.phoneE164).map((contact) => contact.phoneE164)).size, 830);
});

