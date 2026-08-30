const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { AppDatabase } = require('../src/database');
const { parseContactList } = require('../src/import/parse-contacts');

const USAGE = [
  'Uso: npm run import -- <arquivo> [--aplicar] [--sem-nome] [--cidade "Salvador"]',
  '',
  'Formatos aceitos (detectados sozinhos):',
  '  JSON   [{"empresa":"Padaria Aurora","telefone":"(71) 99111-1111"}]  ou  ["71991111111", ...]',
  '  CSV    empresa,telefone,cidade   (aceita ; ou TAB, e cabeçalho em qualquer ordem)',
  '  TXT    Padaria Aurora — (71) 99111-1111    (um por linha; só o número também vale)',
  '',
  'Sem --aplicar o comando só simula e mostra o que faria.',
  '--sem-nome libera a importação de contatos que vieram só com o número.',
].join('\n');

function parseArgs(argv) {
  const options = { file: null, apply: false, allowUnnamed: false, defaultCity: '' };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--aplicar') options.apply = true;
    else if (value === '--sem-nome') options.allowUnnamed = true;
    else if (value === '--cidade') {
      options.defaultCity = argv[index + 1] || '';
      index += 1;
    } else if (!value.startsWith('--') && !options.file) {
      options.file = value;
    }
  }

  return options;
}

function report(lines) {
  for (const line of lines) console.log(line);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.file) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const filePath = path.resolve(options.file);
  if (!fs.existsSync(filePath)) {
    console.error(`Arquivo não encontrado: ${filePath}`);
    console.error('Confira o caminho, ou use aspas se ele tiver espaços.');
    process.exitCode = 1;
    return;
  }

  const parsed = parseContactList(fs.readFileSync(filePath, 'utf8'), { defaultCity: options.defaultCity });
  for (const warning of parsed.warnings.slice(0, 40)) console.warn(`aviso: ${warning}`);
  if (parsed.warnings.length > 40) {
    console.warn(`aviso: mais ${parsed.warnings.length - 40} linha(s) com problema.`);
  }

  const { summary } = parsed;
  report([
    '',
    `Formato detectado: ${parsed.format}`,
    `  ${summary.total} contato(s) lidos`,
    `  ${summary.valid} com telefone válido, ${summary.invalid} sem`,
    `  ${summary.mobile} celular(es), ${summary.landline} fixo(s)`,
    `  ${summary.named} com nome de empresa, ${summary.unnamed} só com o número`,
    `  ${summary.needsReview} precisarão de revisão manual no painel`,
  ]);

  if (!summary.valid) {
    console.error('\nNenhum contato utilizável. Nada foi importado.');
    process.exitCode = 1;
    return;
  }

  // Nome por contato é o que permite usar {empresa} na mensagem. Quem não tem
  // os nomes pode seguir mesmo assim, mas precisa dizer isso de propósito.
  if (summary.unnamed && !options.allowUnnamed) {
    report([
      '',
      `${summary.unnamed} contato(s) vieram só com o número.`,
      'Coloque o nome da empresa antes do número (ex.: "Padaria Aurora — 71991111111"),',
      'ou repita o comando com --sem-nome para seguir apenas com os números.',
      'Sem nome, a mensagem não pode usar a variável {empresa}.',
    ]);
    process.exitCode = 1;
    return;
  }

  if (!options.apply) {
    report(['', 'Simulação: nada foi gravado. Repita com --aplicar para importar.']);
    return;
  }

  const database = new AppDatabase({ databasePath: config.databasePath, seedPath: null });
  try {
    const result = database.importContacts(parsed.contacts, {
      source: path.basename(filePath),
      format: parsed.format,
    });
    report([
      '',
      `Importação concluída (lote #${result.batchId}):`,
      `  ${result.inserted} contato(s) adicionados`,
      `  ${result.duplicated} já existiam e foram mantidos como estavam`,
      `  ${result.invalid} entraram marcados como telefone inválido`,
      '',
      'Nenhum contato entra na fila antes de você registrar o opt-in dele no painel.',
      'Se importou o arquivo errado, dá para desfazer o lote inteiro pelo painel.',
    ]);
  } finally {
    database.close();
  }
}

main();
