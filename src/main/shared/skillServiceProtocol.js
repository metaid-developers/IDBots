const VALID_PAYMENT_TIMINGS = new Set(['prepaid', 'postpaid', 'free']);
const VALID_PROTOCOL_SETTLEMENT_KINDS = new Set(['native', 'fiat']);

function toSafeString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function normalizeProviderSkillList(value) {
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

function getPrimaryProviderSkill(value) {
  return normalizeProviderSkillList(value)[0] || '';
}

function normalizeProtocolSettlementKind(value) {
  const normalized = toSafeString(value).trim().toLowerCase();
  return VALID_PROTOCOL_SETTLEMENT_KINDS.has(normalized) ? normalized : 'native';
}

function normalizeSkillServiceCurrency(value) {
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
  const rawPrice = toSafeString(value).trim();
  if (!rawPrice) {
    return { isPositive: false, value: '0' };
  }

  const numericPrice = Number(rawPrice);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return { isPositive: false, value: '0' };
  }

  return { isPositive: true, value: rawPrice };
}

function resolveSkillServicePaymentTerms(input = {}) {
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

function buildSkillServiceOrderPayload(input = {}) {
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

exports.normalizeProviderSkillList = normalizeProviderSkillList;
exports.getPrimaryProviderSkill = getPrimaryProviderSkill;
exports.normalizeProtocolSettlementKind = normalizeProtocolSettlementKind;
exports.normalizeSkillServiceCurrency = normalizeSkillServiceCurrency;
exports.resolveSkillServicePaymentTerms = resolveSkillServicePaymentTerms;
exports.buildSkillServiceOrderPayload = buildSkillServiceOrderPayload;
