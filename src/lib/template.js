const crypto = require('node:crypto');

const COMPANY_TOKEN = '{empresa}';
const MAX_COMPANY_LENGTH = 100;
const MAX_TEMPLATE_LENGTH = 4096;

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

function validateTemplate(template) {
  const value = String(template || '').trim();
  const errors = [];

  if (!value) errors.push('A mensagem não pode ficar vazia.');
  if (value.length > MAX_TEMPLATE_LENGTH) errors.push(`A mensagem deve ter no máximo ${MAX_TEMPLATE_LENGTH} caracteres.`);

  const unknownTokens = [...value.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[0])
    .filter((token) => token !== COMPANY_TOKEN);

  if (unknownTokens.length) {
    errors.push(`Variável desconhecida: ${[...new Set(unknownTokens)].join(', ')}.`);
  }

  return { valid: errors.length === 0, errors, value };
}

// {empresa} é opcional: quem importou uma lista só de números escreve a
// mensagem sem a variável e envia do mesmo jeito.
function usesCompanyToken(template) {
  return String(template || '').includes(COMPANY_TOKEN);
}

function renderTemplate(template, company) {
  const validation = validateTemplate(template);
  if (!validation.valid) {
    const error = new Error(validation.errors.join(' '));
    error.code = 'INVALID_TEMPLATE';
    throw error;
  }

  if (!usesCompanyToken(validation.value)) return validation.value;

  const safeCompany = normalizeCompanyName(company);
  if (!safeCompany) {
    const error = new Error('O contato não possui um nome de empresa válido.');
    error.code = 'INVALID_COMPANY';
    throw error;
  }

  return validation.value.split(COMPANY_TOKEN).join(safeCompany);
}

function hashMessage(message) {
  return crypto.createHash('sha256').update(String(message), 'utf8').digest('hex');
}

module.exports = {
  COMPANY_TOKEN,
  DEFAULT_TEMPLATE,
  MAX_TEMPLATE_LENGTH,
  normalizeCompanyName,
  validateTemplate,
  renderTemplate,
  usesCompanyToken,
  hashMessage,
};

