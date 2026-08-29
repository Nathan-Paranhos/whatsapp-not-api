const crypto = require('node:crypto');
const { normalizeBrazilianPhone, hasCityDddMismatch } = require('../lib/phones');
const { normalizeCompanyName } = require('../lib/template');

const CITY_HEADER_PATTERN = /^---\s*(.+?)\s*---$/;
const CONTACT_PATTERN = /^(\d+)\.\s*(.*?)\s+[\u2013\u2014-]\s*(.*)$/u;
const PHONE_PATTERN = /\((\d{2})\)\s*(\d{4,5})-(\d{4})/;
const TAG_PATTERN = /\[([^\]]+)\]\s*$/;
const SENT_PATTERN = /^J[aá]\s+enviado:\s*(\d+)\.\s*(.*?)\s+-\s*(.*?)\s+-\s*(\(\d{2}\)\s*\d{4,5}-\d{4})\s*$/iu;

function parseLeadList(source) {
  const normalizedSource = String(source || '').normalize('NFC');
  const lines = normalizedSource.split(/\r?\n/);
  const contacts = [];
  const warnings = [];
  let currentCity = null;
  let sectionOccurrence = 0;
  const cityOccurrences = new Map();

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line || /^=+$/.test(line) || /^Leads\s+/i.test(line)) continue;

    const sentMatch = line.match(SENT_PATTERN);
    if (sentMatch) {
      const [, sourceIndex, company, city, phoneRaw] = sentMatch;
      contacts.push(buildContact({
        sourceIndex: Number(sourceIndex),
        company,
        city,
        phoneRaw,
        tag: 'JÁ ENVIADO',
        lineNumber: lineNumber + 1,
        sectionOccurrence: 0,
        sent: true,
      }));
      continue;
    }

    const cityMatch = line.match(CITY_HEADER_PATTERN);
    if (cityMatch) {
      currentCity = normalizeCompanyName(cityMatch[1]);
      sectionOccurrence = (cityOccurrences.get(currentCity) || 0) + 1;
      cityOccurrences.set(currentCity, sectionOccurrence);
      continue;
    }

    const contactMatch = line.match(CONTACT_PATTERN);
    if (!contactMatch) {
      warnings.push({ lineNumber: lineNumber + 1, line, reason: 'Linha não reconhecida' });
      continue;
    }

    const [, sourceIndex, company, remainder] = contactMatch;
    const phoneMatch = remainder.match(PHONE_PATTERN);
    const tagMatch = remainder.match(TAG_PATTERN);
    const phoneRaw = phoneMatch ? phoneMatch[0] : null;
    const tag = tagMatch ? tagMatch[1].trim().toUpperCase() : null;

    contacts.push(buildContact({
      sourceIndex: Number(sourceIndex),
      company,
      city: currentCity,
      phoneRaw,
      tag,
      lineNumber: lineNumber + 1,
      sectionOccurrence,
      sent: false,
    }));
  }

  contacts.sort((a, b) => a.sourceIndex - b.sourceIndex);
  validateSequenceAndDuplicates(contacts, warnings);

  return {
    sourceHash: crypto.createHash('sha256').update(normalizedSource, 'utf8').digest('hex'),
    importedAt: new Date().toISOString(),
    contacts,
    warnings,
    summary: summarize(contacts),
  };
}

function buildContact({ sourceIndex, company, city, phoneRaw, tag, lineNumber, sectionOccurrence, sent }) {
  const phone = normalizeBrazilianPhone(phoneRaw);
  const dddMismatch = hasCityDddMismatch(city, phone.ddd);
  const sourceReview = tag === 'REVISAR';
  const sourceLandline = tag === 'FIXO';
  const needsReview = !phone.valid || phone.kind === 'landline' || sourceReview || dddMismatch;

  return {
    sourceIndex,
    sourceLine: lineNumber,
    sectionOccurrence,
    city: city || 'Sem cidade',
    companyRaw: String(company || '').normalize('NFC').trim(),
    companyDisplay: normalizeCompanyName(company),
    phoneRaw,
    phoneDigits: phone.digits,
    phoneE164: phone.e164,
    whatsappDigits: phone.whatsappDigits || null,
    phoneKind: phone.kind,
    sourceTag: tag,
    dddMismatch,
    needsReview,
    reviewApproved: !needsReview,
    consentStatus: sent ? 'legacy' : 'unknown',
    status: sent ? 'sent' : phone.valid ? 'pending' : 'invalid',
    sentAt: null,
  };
}

function validateSequenceAndDuplicates(contacts, warnings) {
  const indexes = new Set();
  const phones = new Map();

  for (const contact of contacts) {
    if (indexes.has(contact.sourceIndex)) {
      warnings.push({ sourceIndex: contact.sourceIndex, reason: 'Índice duplicado' });
    }
    indexes.add(contact.sourceIndex);

    if (contact.phoneE164) {
      const duplicateIndex = phones.get(contact.phoneE164);
      if (duplicateIndex) {
        warnings.push({
          sourceIndex: contact.sourceIndex,
          reason: `Telefone duplicado do registro ${duplicateIndex}`,
        });
      } else {
        phones.set(contact.phoneE164, contact.sourceIndex);
      }
    }
  }

  if (contacts.length) {
    for (let expected = contacts[0].sourceIndex; expected <= contacts.at(-1).sourceIndex; expected += 1) {
      if (!indexes.has(expected)) warnings.push({ sourceIndex: expected, reason: 'Índice ausente' });
    }
  }
}

function summarize(contacts) {
  const result = {
    total: contacts.length,
    pending: 0,
    sent: 0,
    mobile: 0,
    landline: 0,
    missing: 0,
    review: 0,
    dddMismatch: 0,
  };

  for (const contact of contacts) {
    if (contact.status === 'sent') result.sent += 1;
    if (contact.status === 'pending') result.pending += 1;
    if (contact.phoneKind === 'mobile') result.mobile += 1;
    if (contact.phoneKind === 'landline') result.landline += 1;
    if (contact.phoneKind === 'missing') result.missing += 1;
    if (contact.needsReview) result.review += 1;
    if (contact.dddMismatch) result.dddMismatch += 1;
  }

  return result;
}

module.exports = { parseLeadList };

