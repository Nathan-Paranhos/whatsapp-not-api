const { digitsOnly, normalizeBrazilianPhone, hasCityDddMismatch } = require('../lib/phones');

// Cabeçalhos aceitos em CSV e chaves aceitas em JSON. Tudo é comparado sem
// acento e em minúsculas, então "Telefone", "TELEFONE" e "telefone" valem igual.
const PHONE_KEYS = ['telefone', 'numero', 'phone', 'celular', 'whatsapp', 'fone', 'contato'];
const NAME_KEYS = ['empresa', 'nome', 'name', 'company', 'cliente', 'razao social'];
const CITY_KEYS = ['cidade', 'city', 'municipio'];

const TRAILING_PHONE_RUN = /[\d\s().+-]+$/;
const LEADING_NUMBERING = /^\s*\d+\s*[.)]\s+/;
const TRAILING_SEPARATORS = /[\s\-—–,;:|.()[\]+]+$/;
const BOM = /^\uFEFF/;
const LINE_BREAK = /\r?\n/;

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

function cleanName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(LEADING_NUMBERING, '')
    .replace(TRAILING_SEPARATORS, '')
    .trim();
}

/**
 * Detecta o formato da lista. JSON é reconhecido pelo primeiro caractere; CSV
 * exige uma linha de cabeçalho com uma coluna de telefone reconhecível; o resto
 * é tratado como texto livre, uma empresa por linha.
 */
function detectFormat(text) {
  const trimmed = String(text || '').replace(BOM, '').trim();
  if (!trimmed) return 'empty';
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';

  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const delimiter = pickDelimiter(firstLine);
  if (delimiter) {
    const header = splitCsvRow(firstLine, delimiter).map(fold);
    if (header.some((column) => PHONE_KEYS.includes(column))) return 'csv';
  }
  return 'text';
}

function pickDelimiter(line) {
  const semicolons = (line.match(/;/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  const tabs = (line.match(/\t/g) || []).length;
  const best = Math.max(semicolons, commas, tabs);
  if (!best) return null;
  if (best === tabs) return '\t';
  return best === semicolons ? ';' : ',';
}

// Divisor de CSV suficiente para arquivo de planilha: aspas duplas com escape
// por aspas repetidas, sem quebra de linha dentro do campo.
function splitCsvRow(line, delimiter) {
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
 * Corta a linha no ponto onde começam os últimos `count` dígitos. É assim que
 * "Loja 2 - 71999999999" devolve o nome "Loja 2" em vez de "Loja".
 */
function indexOfLastDigits(line, count) {
  let seen = 0;
  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (!/\d/.test(line[index])) continue;
    seen += 1;
    if (seen === count) return index;
  }
  return 0;
}

/**
 * Separa "nome" e "telefone" em uma linha de texto livre. Aceita traço, vírgula,
 * ponto e vírgula, dois pontos, barra vertical ou simplesmente espaço antes do
 * número — e aceita a linha ser só o número.
 */
function splitNameAndPhone(line) {
  const run = line.match(TRAILING_PHONE_RUN);
  if (!run) return null;

  const digits = digitsOnly(run[0]);
  if (!digits) return null;

  for (const length of [13, 12, 11, 10]) {
    if (digits.length < length) continue;
    const phone = normalizeBrazilianPhone(digits.slice(-length));
    if (!phone.valid) continue;

    const cut = indexOfLastDigits(line, length);
    return { name: cleanName(line.slice(0, cut)), phoneRaw: line.slice(cut).trim(), phone };
  }
  return null;
}

function readField(row, keys) {
  for (const [key, value] of Object.entries(row)) {
    if (keys.includes(fold(key))) return value;
  }
  return '';
}

function buildContact({ name, phoneRaw, city }, index) {
  const phone = normalizeBrazilianPhone(phoneRaw);
  const company = cleanName(name);
  const cityName = cleanName(city);
  const dddMismatch = cityName ? hasCityDddMismatch(cityName, phone.ddd) : false;

  return {
    sourceIndex: index,
    companyRaw: company,
    companyDisplay: company,
    city: cityName,
    phoneRaw: String(phoneRaw ?? '').trim(),
    phoneDigits: phone.digits,
    phoneE164: phone.e164,
    whatsappDigits: phone.whatsappDigits || null,
    phoneKind: phone.kind,
    sourceTag: null,
    dddMismatch,
    // Fixo e DDD fora da cidade pedem conferência humana antes de entrar na fila.
    needsReview: phone.kind === 'landline' || dddMismatch,
    reviewApproved: phone.kind === 'mobile' && !dddMismatch,
    consentStatus: 'unknown',
    status: phone.valid ? 'pending' : 'invalid',
    sentAt: null,
  };
}

function parseJsonList(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { rows: [], warnings: [`JSON inválido: ${error.message}`] };
  }

  const list = Array.isArray(payload)
    ? payload
    : payload?.contacts || payload?.contatos || payload?.lista;
  if (!Array.isArray(list)) {
    return { rows: [], warnings: ['O JSON precisa ser uma lista, ou um objeto com a chave "contacts".'] };
  }

  const rows = [];
  const warnings = [];
  list.forEach((entry, offset) => {
    const position = offset + 1;
    if (typeof entry === 'string' || typeof entry === 'number') {
      rows.push({ name: '', phoneRaw: String(entry), city: '' });
      return;
    }
    if (!entry || typeof entry !== 'object') {
      warnings.push(`item ${position}: formato não reconhecido, ignorado.`);
      return;
    }
    const phoneRaw = readField(entry, PHONE_KEYS);
    if (!String(phoneRaw ?? '').trim()) {
      warnings.push(`item ${position}: sem campo de telefone, ignorado.`);
      return;
    }
    rows.push({
      name: readField(entry, NAME_KEYS),
      phoneRaw: String(phoneRaw),
      city: readField(entry, CITY_KEYS),
    });
  });

  return { rows, warnings };
}

function parseCsvList(text) {
  const lines = text.replace(BOM, '').split(LINE_BREAK).filter((line) => line.trim());
  const delimiter = pickDelimiter(lines[0]) || ',';
  const header = splitCsvRow(lines[0], delimiter).map(fold);

  const rows = [];
  const warnings = [];
  lines.slice(1).forEach((line, offset) => {
    const lineNumber = offset + 2;
    const cells = splitCsvRow(line, delimiter);
    const record = Object.fromEntries(header.map((column, index) => [column, cells[index] ?? '']));

    const phoneRaw = readField(record, PHONE_KEYS);
    if (!String(phoneRaw).trim()) {
      warnings.push(`linha ${lineNumber}: sem telefone, ignorada.`);
      return;
    }
    rows.push({
      name: readField(record, NAME_KEYS),
      phoneRaw,
      city: readField(record, CITY_KEYS),
    });
  });

  return { rows, warnings };
}

function parseTextList(text) {
  const rows = [];
  const warnings = [];

  text.split(/\r?\n/).forEach((rawLine, offset) => {
    const line = rawLine.trim();
    if (!line) return;
    const lineNumber = offset + 1;

    const parsed = splitNameAndPhone(line);
    if (!parsed) {
      warnings.push(`linha ${lineNumber}: nenhum telefone reconhecido em "${line.slice(0, 60)}".`);
      return;
    }
    rows.push({ name: parsed.name, phoneRaw: parsed.phoneRaw, city: '' });
  });

  return { rows, warnings };
}

/**
 * Lê uma lista de contatos em JSON, CSV ou texto livre e devolve registros
 * normalizados. O nome da empresa é opcional em todos os formatos: quem só tem
 * números consegue importar assim mesmo, e o resumo informa quantos ficaram sem
 * nome para que a mensagem possa ser escrita de acordo.
 */
function parseContactList(text, { defaultCity = '' } = {}) {
  const format = detectFormat(text);
  if (format === 'empty') {
    return { format, contacts: [], warnings: ['A lista está vazia.'], summary: emptySummary() };
  }

  const parsers = { json: parseJsonList, csv: parseCsvList, text: parseTextList };
  const { rows, warnings } = parsers[format](String(text));

  const seenPhones = new Set();
  const contacts = [];
  rows.forEach((row) => {
    const contact = buildContact({ ...row, city: row.city || defaultCity }, contacts.length + 1);

    if (contact.phoneE164) {
      if (seenPhones.has(contact.phoneE164)) {
        warnings.push(`telefone repetido ignorado: ${contact.phoneRaw}`);
        return;
      }
      seenPhones.add(contact.phoneE164);
    } else {
      warnings.push(`telefone inválido: "${contact.phoneRaw || 'vazio'}"`);
    }
    contacts.push(contact);
  });

  return { format, contacts, warnings, summary: summarize(contacts) };
}

function emptySummary() {
  return { total: 0, valid: 0, invalid: 0, mobile: 0, landline: 0, named: 0, unnamed: 0, needsReview: 0 };
}

function summarize(contacts) {
  const summary = emptySummary();
  for (const contact of contacts) {
    summary.total += 1;
    if (contact.phoneE164) summary.valid += 1;
    else summary.invalid += 1;
    if (contact.phoneKind === 'mobile') summary.mobile += 1;
    if (contact.phoneKind === 'landline') summary.landline += 1;
    if (contact.companyDisplay) summary.named += 1;
    else summary.unnamed += 1;
    if (contact.needsReview) summary.needsReview += 1;
  }
  return summary;
}

module.exports = {
  parseContactList,
  detectFormat,
  splitNameAndPhone,
  PHONE_KEYS,
  NAME_KEYS,
  CITY_KEYS,
};
