const crypto = require('node:crypto');

const COMPANY_TOKEN = '{empresa}';
const MAX_COMPANY_LENGTH = 100;
const MAX_TEMPLATE_LENGTH = 4096;
const MAX_CUSTOM_VARIABLES = 20;
const MAX_VARIABLE_VALUE = 500;
const VARIABLE_NAME = /^[a-z][a-z0-9_]{1,23}$/;

/**
 * Variáveis derivadas do contato. O valor sai da linha importada, então cada
 * destinatário recebe o seu — e um contato sem o dado bloqueia o lote em vez de
 * deixar um buraco no meio da mensagem.
 */
const CONTACT_VARIABLES = {
  empresa: { label: 'Nome da empresa', read: (contact) => contact?.company_display || '' },
  cidade: { label: 'Cidade do contato', read: (contact) => contact?.city || '' },
  telefone: { label: 'Telefone do contato', read: (contact) => contact?.phone_raw || '' },
};

const CONTACT_VARIABLE_NAMES = Object.keys(CONTACT_VARIABLES);

const DEFAULT_TEMPLATE = `Olá, {empresa}! Aqui é [seu nome], da [sua empresa].

[Troque este parágrafo pelo motivo do contato, em uma ou duas frases, escrito para quem já autorizou receber esta mensagem.]

Se preferir não receber mais nada, responda SAIR que eu removo o seu número na hora.`;

function normalizeCompanyName(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_COMPANY_LENGTH);
}

function normalizeVariableName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Valida e normaliza a lista de variáveis personalizadas. Elas têm valor fixo:
 * o mesmo texto entra na mensagem de todo mundo.
 */
function validateCustomVariables(list) {
  const errors = [];
  const entries = Array.isArray(list) ? list : [];

  if (entries.length > MAX_CUSTOM_VARIABLES) {
    errors.push(`No máximo ${MAX_CUSTOM_VARIABLES} variáveis personalizadas.`);
  }

  const seen = new Set();
  const value = [];
  for (const entry of entries.slice(0, MAX_CUSTOM_VARIABLES)) {
    const name = normalizeVariableName(entry?.name);
    if (!name) {
      errors.push('Toda variável precisa de um nome.');
      continue;
    }
    if (!VARIABLE_NAME.test(name)) {
      errors.push(`"${name}" não serve como nome: use de 2 a 24 letras minúsculas, números ou _, começando por letra.`);
      continue;
    }
    if (CONTACT_VARIABLE_NAMES.includes(name)) {
      errors.push(`"${name}" já é uma variável do contato e não pode ser redefinida.`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`"${name}" aparece mais de uma vez.`);
      continue;
    }

    const texto = String(entry?.value ?? '');
    if (texto.length > MAX_VARIABLE_VALUE) {
      errors.push(`O valor de "${name}" passa de ${MAX_VARIABLE_VALUE} caracteres.`);
      continue;
    }
    // Chave dentro do valor viraria uma variável fantasma na hora de substituir.
    if (/[{}]/.test(texto)) {
      errors.push(`O valor de "${name}" não pode conter { ou }.`);
      continue;
    }

    seen.add(name);
    value.push({ name, value: texto });
  }

  return { valid: errors.length === 0, errors, value };
}

// Nomes que a mensagem pode usar: as do contato mais as personalizadas.
function knownVariableNames(customVariables = []) {
  return [...CONTACT_VARIABLE_NAMES, ...customVariables.map((item) => item.name)];
}

// Variáveis que a mensagem realmente usa, na ordem em que aparecem.
function variablesUsed(template) {
  const usadas = [...String(template || '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  return [...new Set(usadas)];
}

function contactVariablesUsed(template) {
  return variablesUsed(template).filter((name) => CONTACT_VARIABLE_NAMES.includes(name));
}

function validateTemplate(template, customVariables = []) {
  const value = String(template || '').trim();
  const errors = [];

  if (!value) errors.push('A mensagem não pode ficar vazia.');
  if (value.length > MAX_TEMPLATE_LENGTH) errors.push(`A mensagem deve ter no máximo ${MAX_TEMPLATE_LENGTH} caracteres.`);

  const conhecidas = knownVariableNames(customVariables);
  const desconhecidas = variablesUsed(value).filter((name) => !conhecidas.includes(name));
  if (desconhecidas.length) {
    errors.push(`Variável desconhecida: ${desconhecidas.map((name) => `{${name}}`).join(', ')}.`);
  }

  return { valid: errors.length === 0, errors, value };
}

// {empresa} é opcional: quem importou uma lista só de números escreve a
// mensagem sem a variável e envia do mesmo jeito.
function usesCompanyToken(template) {
  return String(template || '').includes(COMPANY_TOKEN);
}

/**
 * Monta os valores para um contato. As do contato saem da linha importada; as
 * personalizadas são iguais para todo mundo.
 */
function variablesForContact(contact, customVariables = []) {
  const valores = {};
  for (const [name, spec] of Object.entries(CONTACT_VARIABLES)) valores[name] = spec.read(contact);
  for (const item of customVariables) valores[item.name] = item.value;
  return valores;
}

// Variáveis do contato que a mensagem usa e este contato não tem como preencher.
function missingVariablesFor(template, contact, customVariables = []) {
  const valores = variablesForContact(contact, customVariables);
  return contactVariablesUsed(template).filter((name) => !String(valores[name] || '').trim());
}

function renderTemplate(template, variables = {}, customVariables = []) {
  const validation = validateTemplate(template, customVariables);
  if (!validation.valid) {
    const error = new Error(validation.errors.join(' '));
    error.code = 'INVALID_TEMPLATE';
    throw error;
  }

  let saida = validation.value;
  for (const name of variablesUsed(saida)) {
    const bruto = variables[name];
    const valor = name === 'empresa' ? normalizeCompanyName(bruto) : String(bruto ?? '').trim();

    if (!valor && CONTACT_VARIABLE_NAMES.includes(name)) {
      const error = new Error(`O contato não tem valor para a variável {${name}}.`);
      error.code = name === 'empresa' ? 'INVALID_COMPANY' : 'MISSING_VARIABLE';
      throw error;
    }
    saida = saida.split(`{${name}}`).join(valor);
  }
  return saida;
}

function hashMessage(message) {
  return crypto.createHash('sha256').update(String(message), 'utf8').digest('hex');
}

module.exports = {
  COMPANY_TOKEN,
  CONTACT_VARIABLES,
  CONTACT_VARIABLE_NAMES,
  DEFAULT_TEMPLATE,
  MAX_TEMPLATE_LENGTH,
  MAX_CUSTOM_VARIABLES,
  MAX_VARIABLE_VALUE,
  normalizeCompanyName,
  normalizeVariableName,
  validateCustomVariables,
  knownVariableNames,
  variablesUsed,
  contactVariablesUsed,
  variablesForContact,
  missingVariablesFor,
  validateTemplate,
  renderTemplate,
  usesCompanyToken,
  hashMessage,
};
