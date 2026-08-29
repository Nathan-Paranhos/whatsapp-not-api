const fs = require('node:fs');
const path = require('node:path');
const { parseLeadList } = require('../src/import/parse-leads');

const sourcePath = process.argv[2];
const outputPath = process.argv[3] || path.resolve(__dirname, '../data/seed-contacts.json');

if (!sourcePath) {
  console.error('Uso: npm run import -- <lista.txt> [data/seed-contacts.json]');
  process.exitCode = 1;
} else {
  const source = fs.readFileSync(path.resolve(sourcePath), 'utf8');
  const parsed = parseLeadList(source);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  console.log(`Importação concluída: ${parsed.summary.total} contatos.`);
  console.log(JSON.stringify(parsed.summary, null, 2));
  if (parsed.warnings.length) {
    console.log(`${parsed.warnings.length} aviso(s) salvo(s) no arquivo de saída.`);
  }
}
