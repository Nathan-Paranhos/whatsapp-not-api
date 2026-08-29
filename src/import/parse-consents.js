const { normalizeBrazilianPhone } = require('../lib/phones');

const REQUIRED_COLUMNS = ['telefone', 'data', 'origem'];

function foldHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function detectDelimiter(headerLine) {
  return (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ';' : ',';
}

// Divisor de CSV suficiente para arquivo exportado de planilha: aspas duplas com
// escape por aspas repetidas, sem quebra de linha dentro do campo.
function splitRow(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char !== '"') current += char;
      else if (line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Lê um arquivo de comprovação de opt-in. Cada linha precisa dizer de quem é o
 * número, quando a pessoa autorizou e por qual canal — sem isso não há registro
 * a importar, apenas uma marcação em branco.
 */
function parseConsentCsv(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return { rows: [], errors: [{ line: 0, reason: 'Arquivo vazio.' }], columns: [] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const columns = splitRow(lines[0], delimiter).map(foldHeader);
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length) {
    return {
      rows: [],
      columns,
      errors: [{ line: 1, reason: `Cabeçalho sem a(s) coluna(s): ${missing.join(', ')}.` }],
    };
  }

  const indexOf = (name) => columns.indexOf(name);
  const rows = [];
  const errors = [];

  lines.slice(1).forEach((line, offset) => {
    const lineNumber = offset + 2;
    const cells = splitRow(line, delimiter);
    const read = (name) => (indexOf(name) === -1 ? '' : String(cells[indexOf(name)] || '').trim());

    const phone = normalizeBrazilianPhone(read('telefone'));
    const date = read('data');
    const source = read('origem');
    const remark = read('observacao');

    if (!phone.valid) {
      errors.push({ line: lineNumber, reason: `Telefone inválido: "${read('telefone') || 'vazio'}".` });
      return;
    }
    if (!date) {
      errors.push({ line: lineNumber, reason: 'Falta a data em que o contato autorizou.' });
      return;
    }
    if (!source) {
      errors.push({ line: lineNumber, reason: 'Falta a origem do opt-in (onde/como a pessoa autorizou).' });
      return;
    }

    rows.push({
      line: lineNumber,
      e164: phone.e164,
      whatsappDigits: phone.whatsappDigits,
      date,
      source,
      note: [source, date, remark].filter(Boolean).join(' · ').slice(0, 240),
    });
  });

  return { rows, errors, columns };
}

module.exports = { parseConsentCsv, REQUIRED_COLUMNS };
