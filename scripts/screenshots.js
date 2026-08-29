/**
 * Gera os prints usados na documentação.
 *
 * Roda sempre contra `test/fixtures/contacts.json` e um banco temporário, então
 * nenhuma captura contém contato real. O Chromium usado é o mesmo que o
 * whatsapp-web.js já instala — não há dependência extra.
 *
 *   node scripts/screenshots.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer');
const baseConfig = require('../src/config');
const { createSystem } = require('../src/server');

const PORT = 3410;
const OUT_DIR = path.resolve(__dirname, '../docs');
const FIXTURE = path.resolve(__dirname, '../test/fixtures/contacts.json');

class OfflineWhatsApp extends require('node:events') {
  getStatus() {
    return { status: 'disconnected', qrDataUrl: null, account: null, message: 'Aguardando conexão.', updatedAt: new Date().toISOString() };
  }

  async start() { return this.getStatus(); }
  async reconnect() { return this.getStatus(); }
  async destroy() {}
  async sendText() { throw new Error('Captura de tela não envia mensagem.'); }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wna-shots-'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const system = createSystem({
    whatsapp: new OfflineWhatsApp(),
    config: { ...baseConfig, port: PORT, whatsappAutostart: false, databasePath: path.join(tempDir, 'shots.db'), seedPath: FIXTURE },
  });

  // Alguns opt-ins para o painel mostrar números em vez de zeros.
  for (const contact of system.database.listContacts({ filter: 'consent', pageSize: 8 }).items.slice(0, 6)) {
    system.database.confirmConsent(contact.id, 'formulário do site · 12/08/2026');
  }

  const server = http.createServer(system.app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1150, deviceScaleFactor: 2 });
    // O painel mantém um EventSource aberto, então networkidle nunca acontece.
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await wait(2200);
    await page.evaluate(() => {
      const modal = document.querySelector('#qr-modal');
      if (modal?.open) modal.close();
    });
    await wait(400);

    await page.screenshot({ path: path.join(OUT_DIR, 'painel.png') });
    await (await page.$('.brand')).screenshot({ path: path.join(OUT_DIR, 'logo.png') });

    await page.evaluate(async () => {
      const preview = await fetch('/api/queue/preview?limit=6').then((response) => response.json());
      openRecipientsModal(preview.contacts, 180);
    });
    await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 2 });
    await wait(700);
    await (await page.$('#action-modal')).screenshot({ path: path.join(OUT_DIR, 'destinatarios.png') });

    console.log(`Prints salvos em ${OUT_DIR}`);
  } finally {
    await browser.close();
    system.runner.stop();
    system.hub.close();
    await new Promise((resolve) => server.close(resolve));
    system.database.close();
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
