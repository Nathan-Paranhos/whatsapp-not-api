const CITY_DDDS = new Map([
  ['Salvador', new Set(['71'])],
  ['Feira de Santana', new Set(['75'])],
  ['Vitória da Conquista', new Set(['77'])],
  ['Camaçari', new Set(['71'])],
  ['Itabuna', new Set(['73'])],
  ['Juazeiro', new Set(['74'])],
  ['Lauro de Freitas', new Set(['71'])],
]);

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeBrazilianPhone(rawPhone) {
  let digits = digitsOnly(rawPhone);

  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }

  if (digits.length !== 10 && digits.length !== 11) {
    return {
      valid: false,
      digits: digits || null,
      e164: null,
      kind: 'missing',
      ddd: digits.length >= 2 ? digits.slice(0, 2) : null,
    };
  }

  const subscriber = digits.slice(2);
  const kind = subscriber.length === 9 && subscriber.startsWith('9') ? 'mobile' : 'landline';

  return {
    valid: true,
    digits,
    e164: `+55${digits}`,
    whatsappDigits: `55${digits}`,
    kind,
    ddd: digits.slice(0, 2),
  };
}

function hasCityDddMismatch(city, ddd) {
  const expected = CITY_DDDS.get(city);
  return Boolean(expected && ddd && !expected.has(ddd));
}

function maskPhone(e164) {
  const digits = digitsOnly(e164);
  if (digits.length < 6) return '—';
  return `+${digits.slice(0, 4)} •••••-${digits.slice(-4)}`;
}

module.exports = {
  CITY_DDDS,
  digitsOnly,
  normalizeBrazilianPhone,
  hasCityDddMismatch,
  maskPhone,
};

