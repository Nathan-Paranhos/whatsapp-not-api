const test = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const { nextDelayMs } = require('../src/campaign-runner');

test('a espera varia em torno do intervalo escolhido', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(nextDelayMs(baseConfig, 180));
  assert.ok(seen.size > 50, 'as esperas não podem sair sempre iguais');

  const values = [...seen];
  assert.ok(Math.min(...values) < 180_000, 'alguma espera fica abaixo do intervalo base');
  assert.ok(Math.max(...values) > 180_000, 'alguma espera fica acima do intervalo base');
});

test('o sorteio nunca desce abaixo do intervalo mínimo nem passa do teto', () => {
  const floor = baseConfig.minIntervalSeconds * 1000;
  for (const interval of [90, 120, 180, 300, 600]) {
    for (const draw of [0, 0.5, 0.999999]) {
      const delay = nextDelayMs(baseConfig, interval, () => draw);
      assert.ok(delay >= floor, `${interval}s com sorteio ${draw} caiu para ${delay}ms`);
      assert.ok(delay <= 600_000, `${interval}s com sorteio ${draw} passou do teto`);
    }
  }
});

test('intervalo ausente cai no padrão configurado', () => {
  const delay = nextDelayMs(baseConfig, null, () => 0.5);
  assert.equal(delay, baseConfig.defaultIntervalSeconds * 1000);
});
