const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

test('todos os elementos armazenados pelo JavaScript existem no HTML e IDs não se repetem', () => {
  const idBlock = appJs.match(/const ids = \[([\s\S]*?)\];/);
  assert.ok(idBlock, 'lista de IDs não encontrada');
  const referencedIds = [...idBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const htmlIdSet = new Set(htmlIds);
  assert.deepEqual(referencedIds.filter((id) => !htmlIdSet.has(id)), []);
  assert.equal(htmlIds.length, htmlIdSet.size, 'o HTML possui IDs duplicados');
});

test('página respeita a CSP sem scripts ou estilos inline', () => {
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  assert.equal(/\sstyle="/i.test(html), false);
  assert.match(html, /<script src="\/app\.js" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
});
