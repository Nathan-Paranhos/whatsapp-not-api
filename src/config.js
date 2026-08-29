const path = require('node:path');
const os = require('node:os');

const rootDir = path.resolve(__dirname, '..');
const runtimeRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'WhatsAppNotApi')
  : path.join(os.homedir(), '.whatsapp-not-api');

function resolveFromRoot(value, fallback) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? selected : path.resolve(rootDir, selected);
}

function parsePort(value) {
  const port = Number.parseInt(value || '3333', 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3333;
}

module.exports = {
  rootDir,
  host: '127.0.0.1',
  port: parsePort(process.env.PORT),
  runtimeRoot,
  databasePath: resolveFromRoot(process.env.DATABASE_PATH, path.join(runtimeRoot, 'data', 'whatsapp-not-api.db')),
  // Lista inicial opcional: se o arquivo não existir, o painel começa vazio.
  seedPath: resolveFromRoot(process.env.SEED_PATH, 'data/seed-contacts.json'),
  sessionPath: resolveFromRoot(process.env.WHATSAPP_SESSION_PATH, path.join(runtimeRoot, 'whatsapp-session')),
  whatsappAutostart: process.env.WHATSAPP_AUTOSTART !== 'false',
  minIntervalSeconds: 90,
  defaultIntervalSeconds: 180,
  // Cada espera sai sorteada dentro de ±35% do intervalo escolhido, sem nunca
  // descer abaixo de minIntervalSeconds.
  intervalJitterRatio: 0.35,
  maxBatchSize: 200,
  // Tetos de segurança. Eles não se somam: o que realmente limita o dia é o
  // intervalo mínimo. A 90 s por mensagem cabem no máximo 40 envios por hora e,
  // na janela 09h–18h, cerca de 360 por dia — dailyLimit é a trava final, não
  // uma meta alcançável.
  hourlyLimit: 40,
  dailyLimit: 500,
  businessHourStart: 9,
  businessHourEnd: 18,
};
