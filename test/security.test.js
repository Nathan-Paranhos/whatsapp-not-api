/**
 * Regressões da auditoria de segurança. Cada teste reexecuta o ataque que
 * funcionava antes da correção — se alguém afrouxar a fronteira de rede de
 * novo, estes testes falham.
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../src/config');
const { AppDatabase } = require('../src/database');
const { createSystem } = require('../src/server');

const FIXTURE = path.resolve(__dirname, 'fixtures/contacts.json');

class OfflineWhatsApp extends EventEmitter {
  getStatus() {
    return { status: 'disconnected', qrDataUrl: null, account: null, message: 'x', updatedAt: new Date().toISOString() };
  }

  async start() { return this.getStatus(); }
  async reconnect() { return this.getStatus(); }
  async destroy() {}
  async sendText() { throw new Error('não envia em teste'); }
}

async function createServer(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-sec-'));
  const database = new AppDatabase({ databasePath: path.join(tempDir, 'test.db'), seedPath: FIXTURE });
  const system = createSystem({
    database,
    whatsapp: new OfflineWhatsApp(),
    config: { ...baseConfig, port: 0, whatsappAutostart: false, businessHourStart: 0, businessHourEnd: 24 },
  });
  const server = http.createServer(system.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(async () => {
    system.runner.stop();
    system.hub.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  });

  return { port, database, baseUrl: `http://127.0.0.1:${port}` };
}

// Requisição crua: permite forjar Host, que fetch() não deixa alterar.
function requisicaoCrua({ port, method = 'GET', pathname = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let dados = '';
      res.on('data', (parte) => { dados += parte; });
      res.on('end', () => resolve({ status: res.statusCode, body: dados }));
    });
    req.on('error', (erro) => resolve({ status: 0, body: String(erro.message) }));
    if (body) req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------- A-01

test('A-01: GET com Host forjado não lê a lista de contatos', async (t) => {
  const { port } = await createServer(t);

  const resposta = await requisicaoCrua({
    port,
    pathname: '/api/contacts?pageSize=100',
    headers: { Host: 'evil.example.com', Origin: 'http://evil.example.com', 'Sec-Fetch-Site': 'cross-site' },
  });

  assert.equal(resposta.status, 403);
  assert.equal(JSON.parse(resposta.body).code, 'FOREIGN_HOST');
  assert.doesNotMatch(resposta.body, /phoneRaw|Padaria Aurora/, 'nenhum dado de contato vaza');
});

test('A-01: exportação CSV também recusa Host forjado', async (t) => {
  const { port } = await createServer(t);

  const resposta = await requisicaoCrua({
    port, pathname: '/api/export.csv', headers: { Host: 'evil.example.com' },
  });

  assert.equal(resposta.status, 403);
  assert.doesNotMatch(resposta.body, /phone_raw|Padaria/);
});

test('A-01: o fluxo de tempo real também é protegido', async (t) => {
  const { port } = await createServer(t);
  const resposta = await requisicaoCrua({
    port, pathname: '/api/events/stream', headers: { Host: 'attacker.test' },
  });
  assert.equal(resposta.status, 403);
});

test('A-01: hosts locais legítimos continuam funcionando', async (t) => {
  const { port } = await createServer(t);

  for (const host of ['127.0.0.1', `127.0.0.1:${port}`, `localhost:${port}`, '[::1]']) {
    const resposta = await requisicaoCrua({ port, pathname: '/api/health', headers: { Host: host } });
    assert.equal(resposta.status, 200, `host ${host} deveria passar`);
  }
});

// ------------------------------------------------------------------- A-02

test('A-02: mutação sem cabeçalho de origem é negada (falha fechada)', async (t) => {
  const { port, database } = await createServer(t);
  const antes = database.getSummary().total;

  const escrita = await requisicaoCrua({
    port,
    method: 'POST',
    pathname: '/api/contacts/1/consent',
    headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(escrita.status, 403);
  assert.equal(JSON.parse(escrita.body).code, 'FOREIGN_ORIGIN');
  assert.equal(database.getContact(1).consentStatus, 'unknown');

  const exclusao = await requisicaoCrua({
    port,
    method: 'DELETE',
    pathname: '/api/contacts/8',
    headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' },
  });
  assert.equal(exclusao.status, 403);
  assert.equal(database.getSummary().total, antes, 'nada foi apagado');
});

test('A-02: origem local, same-origin e cliente local declarado passam', async (t) => {
  const { port, baseUrl, database } = await createServer(t);

  const comOrigin = await requisicaoCrua({
    port,
    method: 'POST',
    pathname: '/api/contacts/1/consent',
    headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(comOrigin.status, 200);

  const comFetchSite = await requisicaoCrua({
    port,
    method: 'POST',
    pathname: '/api/contacts/2/consent',
    headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(comFetchSite.status, 200);

  const comClienteLocal = await requisicaoCrua({
    port,
    method: 'POST',
    pathname: '/api/contacts/4/consent',
    headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', 'X-Local-Client': 'cli' },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(comClienteLocal.status, 200);

  assert.equal(database.getSummary().authorized, 3);
});

test('A-02: origem externa continua bloqueada', async (t) => {
  const { port } = await createServer(t);
  const resposta = await requisicaoCrua({
    port,
    method: 'POST',
    pathname: '/api/contacts/1/consent',
    headers: {
      Host: '127.0.0.1',
      'Content-Type': 'application/json',
      Origin: 'https://site-malicioso.example',
    },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(resposta.status, 403);
  assert.equal(JSON.parse(resposta.body).code, 'FOREIGN_ORIGIN');
});

// ------------------------------------------------------------------- A-03

test('A-03: CSV neutraliza fórmula inclusive com TAB ou CR na frente', async (t) => {
  const { baseUrl, database } = await createServer(t);
  // Grava direto no banco: updateContact aplica trim() e removeria o TAB/CR
  // antes de chegar ao CSV. O que se testa aqui é a neutralização na saída.
  const gravar = database.db.prepare('UPDATE contacts SET company_display = ? WHERE id = ?');
  gravar.run('\t=1+1', 1);
  gravar.run('\r=cmd|calc', 2);
  gravar.run('=SOMA(A1)', 3);

  const csv = await (await fetch(`${baseUrl}/api/export.csv`)).text();

  for (const perigoso of ['"\t=', '"\r=', '"=']) {
    assert.ok(!csv.includes(perigoso), `célula começando com ${JSON.stringify(perigoso)} escapou da neutralização`);
  }
  assert.match(csv, /"'\t=1\+1"/);
  assert.match(csv, /"'\r=cmd\|calc"/);
  assert.match(csv, /"'=SOMA\(A1\)"/);
});

// ------------------------------------------------------------------- A-04

test('A-04: conexões de tempo real têm teto', async (t) => {
  const { port } = await createServer(t);
  const abertas = [];

  try {
    let recusadas = 0;
    for (let i = 0; i < 25; i += 1) {
      const resultado = await new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/events/stream', headers: { Host: '127.0.0.1' } },
          (res) => resolve({ status: res.statusCode, req, res }),
        );
        req.on('error', () => resolve({ status: 0 }));
        req.end();
      });
      if (resultado.status === 503) recusadas += 1;
      else if (resultado.req) abertas.push(resultado.req);
    }
    assert.ok(recusadas > 0, 'o teto precisa recusar as conexões excedentes');
  } finally {
    for (const req of abertas) req.destroy();
  }
});

// ------------------------------------------------------------------- A-05

test('A-05: valor de classe hostil não escapa do atributo na tabela', async (t) => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  assert.match(
    app,
    /<span class="tag \$\{escapeHtml\(tag\.className\)\}">/,
    'a classe da etiqueta precisa passar por escapeHtml',
  );
});

// --------------------------------------------------------- higiene geral

test('nenhum segredo embutido nos arquivos versionados', async () => {
  const { execSync } = require('node:child_process');
  const raiz = path.resolve(__dirname, '..');
  const arquivos = execSync('git ls-files', { cwd: raiz, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !/\.(png|jpg|pdf)$/i.test(f));

  const padrao = /(api[_-]?key|client[_-]?secret|private[_-]?key|password)\s*[:=]\s*["'][^"']{8,}/i;
  const suspeitos = [];
  for (const arquivo of arquivos) {
    const conteudo = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
    if (padrao.test(conteudo)) suspeitos.push(arquivo);
  }
  assert.deepEqual(suspeitos, []);
});

test('dados pessoais e credencial de sessão continuam fora do versionamento', async () => {
  const { execSync } = require('node:child_process');
  const raiz = path.resolve(__dirname, '..');
  const versionados = execSync('git ls-files', { cwd: raiz, encoding: 'utf8' }).split('\n');

  // Comparação exata para .env — .env.example é um modelo sem segredo e deve
  // continuar versionado.
  assert.ok(!versionados.includes('.env'), '.env não pode estar versionado');
  assert.ok(versionados.includes('.env.example'), 'o modelo .env.example deve continuar versionado');

  for (const prefixo of ['data/seed-contacts.json', '.wwebjs_auth', 'docs/security-audit']) {
    assert.ok(
      !versionados.some((f) => f.startsWith(prefixo)),
      `${prefixo} não pode estar versionado`,
    );
  }
});
