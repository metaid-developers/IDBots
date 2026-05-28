const VALID_PAYMENT_TIMINGS = new Set(['prepaid', 'free']);
const VALID_PROTOCOL_SETTLEMENT_KINDS = new Set(['native', 'fiat']);
const PLAIN_NON_NEGATIVE_DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

function toSafeString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

export function normalizeProviderSkillList(value) {
  const rawSkills = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const skills = [];

  for (const rawSkill of rawSkills) {
    const skill = toSafeString(rawSkill).trim();
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    skills.push(skill);
  }

  return skills;
}

export function getLegacyProviderSkillFallback(value) {
  return normalizeProviderSkillList(value)[0] || '';
}

// Compatibility wrapper for legacy single-skill consumers. The normalized
// providerSkill array remains an unordered allow-list, not an execution order.
export function getPrimaryProviderSkill(value) {
  return getLegacyProviderSkillFallback(value);
}

export function normalizeProtocolSettlementKind(value) {
  const normalized = toSafeString(value).trim().toLowerCase();
  return VALID_PROTOCOL_SETTLEMENT_KINDS.has(normalized) ? normalized : 'native';
}

export function normalizeSkillServiceCurrency(value) {
  const normalized = toSafeString(value).trim().toUpperCase();
  if (!normalized || normalized === 'MVC' || normalized === 'MICROVISIONCHAIN') {
    return 'SPACE';
  }
  if (normalized === 'BITCOIN') return 'BTC';
  if (normalized === 'DOGECOIN') return 'DOGE';
  return normalized;
}

function normalizePaymentTiming(value) {
  const normalized = toSafeString(value).trim().toLowerCase();
  return VALID_PAYMENT_TIMINGS.has(normalized) ? normalized : '';
}

function parsePositivePrice(value) {
  if (typeof value !== 'string') {
    return { isPositive: false, value: '0' };
  }

  const rawPrice = value.trim();
  if (!PLAIN_NON_NEGATIVE_DECIMAL_PATTERN.test(rawPrice)) {
    return { isPositive: false, value: '0' };
  }

  const isPositive = /[1-9]/.test(rawPrice);
  return { isPositive, value: isPositive ? rawPrice : '0' };
}

export function resolveSkillServicePaymentTerms(input = {}) {
  const price = parsePositivePrice(input.price);
  const requestedTiming = normalizePaymentTiming(input.paymentTiming);
  const isFree = requestedTiming === 'free' || !price.isPositive;
  const paymentTiming = isFree
    ? 'free'
    : requestedTiming || 'prepaid';
  const effectivePrice = isFree ? '0' : price.value;

  return {
    paymentTiming,
    effectivePrice,
    currency: normalizeSkillServiceCurrency(input.currency),
    protocolSettlementKind: normalizeProtocolSettlementKind(
      input.protocolSettlementKind ?? input.settlementKind,
    ),
    isFree,
  };
}

export function buildSkillServiceOrderPayload(input = {}) {
  const paymentTerms = resolveSkillServicePaymentTerms(input);

  return {
    servicePinId: toSafeString(input.servicePinId).trim(),
    paymentTxid: toSafeString(input.paymentTxid).trim(),
    price: paymentTerms.effectivePrice,
    currency: paymentTerms.currency,
    settlementKind: paymentTerms.protocolSettlementKind,
    metadata: toSafeString(input.metadata),
  };
}
