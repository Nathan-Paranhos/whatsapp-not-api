const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { AppDatabase } = require('../src/database');
const { parseConsentCsv } = require('../src/import/parse-consents');

const BLOCKED_STATUSES = ['sent', 'replied', 'suppressed', 'invalid', 'uncertain'];

const args = process.argv.slice(2);
const apply = args.includes('--aplicar');
const sourcePath = args.find((value) => !value.startsWith('--'));

if (!sourcePath) {
  console.error('Uso: npm run import-consent -- <opt-ins.csv> [--aplicar]');
  console.error('');
  console.error('O arquivo precisa do cabeçalho: telefone,data,origem[,observacao]');
  console.error('Sem --aplicar o comando só simula e mostra o que faria.');
  process.exitCode = 1;
  return;
}

const filePath = path.resolve(sourcePath);
if (!fs.existsSync(filePath)) {
  console.error(`Arquivo não encontrado: ${filePath}`);
  console.error('Crie o arquivo com o cabeçalho telefone,data,origem — ou confira o caminho.');
  console.error('Se o caminho tiver espaços, coloque entre aspas.');
  process.exitCode = 1;
  return;
}

const parsed = parseConsentCsv(fs.readFileSync(filePath, 'utf8'));
for (const error of parsed.errors) console.warn(`linha ${error.line}: ${error.reason}`);

if (!parsed.rows.length) {
  console.error('Nenhuma linha utilizável no arquivo.');
  process.exitCode = 1;
  return;
}

const database = new AppDatabase({ databasePath: config.databasePath, seedPath: config.seedPath });
const report = { applied: 0, already: 0, notFound: 0, blocked: 0 };

try {
  for (const row of parsed.rows) {
    const contact = database.findContactByWhatsAppDigits(row.whatsappDigits);
    if (!contact) {
      report.notFound += 1;
      console.warn(`linha ${row.line}: nenhum contato com este telefone na base.`);
      continue;
    }
    if (contact.consent_status === 'confirmed') {
      report.already += 1;
      continue;
    }
    if (BLOCKED_STATUSES.includes(contact.status)) {
      report.blocked += 1;
      console.warn(`linha ${row.line}: ${contact.company_display} está como "${contact.status}" e não recebe opt-in.`);
      continue;
    }
    if (apply) database.confirmConsent(contact.id, row.note);
    report.applied += 1;
  }

  console.log('');
  console.log(apply ? 'Opt-ins registrados a partir do arquivo:' : 'Simulação (nada foi gravado):');
  console.log(`  ${report.applied} contato(s) ${apply ? 'receberam' : 'receberiam'} opt-in, com origem e data anotadas`);
  console.log(`  ${report.already} já estavam confirmados`);
  console.log(`  ${report.notFound} telefone(s) fora da base`);
  console.log(`  ${report.blocked} bloqueado(s) pelo estado atual`);
  console.log(`  ${parsed.errors.length} linha(s) descartada(s) por dado faltando`);
  if (!apply) console.log('\nRode de novo com --aplicar para gravar.');
} finally {
  database.close();
}
