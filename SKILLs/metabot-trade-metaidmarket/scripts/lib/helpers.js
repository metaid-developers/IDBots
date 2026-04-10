'use strict';

function normalizeTokenSymbol(value) {
  return String(value || '').trim().replace(/^\$/, '').toUpperCase();
}

function normalizeNetwork(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'testnet' ? 'testnet' : 'mainnet';
}

function requireDecimalString(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${label} must be a positive decimal`);
  }
  if (Number(text) <= 0) {
    throw new Error(`${label} must be a positive decimal`);
  }
  return text;
}

function normalizeDecimalString(value, label = 'value') {
  const text = String(value == null ? '' : value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${label} must be a decimal number`);
  }

  const sign = text.startsWith('-') ? '-' : '';
  const absolute = sign ? text.slice(1) : text;
  const [integerPartRaw, fractionPartRaw = ''] = absolute.split('.');
  const integerPart = integerPartRaw.replace(/^0+(?=\d)/, '') || '0';
  const fractionPart = fractionPartRaw.replace(/0+$/, '');
  return fractionPart ? `${sign}${integerPart}.${fractionPart}` : `${sign}${integerPart}`;
}

function shiftDecimalString(value, places) {
  const normalized = normalizeDecimalString(value);
  const sign = normalized.startsWith('-') ? '-' : '';
  const absolute = sign ? normalized.slice(1) : normalized;
  const [integerPartRaw, fractionPartRaw = ''] = absolute.split('.');
  const digits = `${integerPartRaw}${fractionPartRaw}`.replace(/^0+/, '') || '0';
  const decimalIndex = integerPartRaw.length + Number(places || 0);

  let integerPart = '';
  let fractionPart = '';
  if (decimalIndex <= 0) {
    integerPart = '0';
    fractionPart = `${'0'.repeat(Math.abs(decimalIndex))}${digits}`;
  } else if (decimalIndex >= digits.length) {
    integerPart = `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
    fractionPart = '';
  } else {
    integerPart = digits.slice(0, decimalIndex);
    fractionPart = digits.slice(decimalIndex);
  }

  integerPart = integerPart.replace(/^0+(?=\d)/, '') || '0';
  fractionPart = fractionPart.replace(/0+$/, '');
  const shifted = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  if (shifted === '0') return '0';
  return `${sign}${shifted}`;
}

function decimalToAtomic(value, decimals) {
  const text = requireDecimalString(value, 'value');
  const normalizedDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const [integerPart, fractionPart = ''] = text.split('.');
  if (fractionPart.length > normalizedDecimals) {
    throw new Error(`value exceeds ${normalizedDecimals} decimal places`);
  }
  const paddedFraction = fractionPart.padEnd(normalizedDecimals, '0');
  const raw = `${integerPart}${paddedFraction}`.replace(/^0+/, '');
  return BigInt(raw || '0');
}

function atomicToDisplay(value, decimals) {
  const normalizedDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const raw = typeof value === 'bigint' ? value : BigInt(String(value || '0'));
  const sign = raw < 0n ? '-' : '';
  const absolute = raw < 0n ? -raw : raw;
  if (normalizedDecimals === 0) {
    return `${sign}${absolute.toString()}`;
  }
  const base = 10n ** BigInt(normalizedDecimals);
  const integerPart = absolute / base;
  const fractionPart = absolute % base;
  return `${sign}${integerPart.toString()}.${fractionPart.toString().padStart(normalizedDecimals, '0')}`.replace(/\.?0+$/, '');
}

function satsToBtc(value) {
  return shiftDecimalString(value, -8);
}

function formatBtc(value) {
  return `${satsToBtc(value)} BTC`;
}

function multiplyUnitPriceByQuantity(unitPriceBtc, quantity, quantityDecimals) {
  const priceSatsPerWhole = decimalToAtomic(unitPriceBtc, 8);
  const quantityAtomic = decimalToAtomic(quantity, quantityDecimals);
  const divisor = 10n ** BigInt(quantityDecimals);
  return priceSatsPerWhole * quantityAtomic / divisor;
}

function clipMiddle(value, keep = 6) {
  const text = String(value || '');
  if (text.length <= keep * 2 + 3) return text;
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function sumDisplayValues(values, decimals) {
  let total = 0n;
  for (const value of values) {
    total += decimalToAtomic(String(value || '0'), decimals);
  }
  return total;
}

function compareDecimalStrings(left, right, decimals) {
  return decimalToAtomic(left, decimals) === decimalToAtomic(right, decimals);
}

module.exports = {
  normalizeTokenSymbol,
  normalizeNetwork,
  requireDecimalString,
  normalizeDecimalString,
  shiftDecimalString,
  decimalToAtomic,
  atomicToDisplay,
  satsToBtc,
  formatBtc,
  multiplyUnitPriceByQuantity,
  clipMiddle,
  sumDisplayValues,
  compareDecimalStrings,
};
