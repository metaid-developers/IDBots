import { extractOrderSkillId, extractOrderSkillName } from './orderPayment';

export interface SellerOrderRepairServiceSource {
  id: string;
  providerGlobalMetaId?: string | null;
  providerSkill?: string | null;
  serviceName?: string | null;
  price?: string | null;
  currency?: string | null;
  updatedAt?: number | null;
}

export interface SellerOrderRepairSource {
  id: string;
  providerGlobalMetaId?: string | null;
  servicePinId?: string | null;
  serviceName?: string | null;
  paymentTxid?: string | null;
  paymentAmount?: string | null;
  paymentCurrency?: string | null;
  createdAt?: number | null;
}

export interface SellerOrderServiceMatch {
  serviceId: string;
  serviceName: string;
  matchedBy: 'existing' | 'rating_txid' | 'order_text_service_id' | 'skill_price_time' | 'price_time';
}

const DECIMAL_SCALE = 8n;
const DECIMAL_MULTIPLIER = 10n ** DECIMAL_SCALE;
const LEGACY_PLACEHOLDER_SERVICE_NAMES = new Set(['service order']);

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
};

const toSafeNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeSkillToken = (value: unknown): string => toSafeString(value).trim().toLowerCase();

const parseDecimalToUnits = (value: string | null | undefined): bigint => {
  const normalized = toSafeString(value).trim();
  if (!normalized) return 0n;
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return 0n;
  const sign = match[1] === '-' ? -1n : 1n;
  const integerPart = BigInt(match[2] || '0');
  const fractionPart = (match[3] || '').slice(0, Number(DECIMAL_SCALE)).padEnd(Number(DECIMAL_SCALE), '0');
  return sign * (integerPart * DECIMAL_MULTIPLIER + BigInt(fractionPart || '0'));
};

const normalizeServiceNameForFallback = (value: unknown): string => {
  const normalized = normalizeSkillToken(value);
  if (!normalized || LEGACY_PLACEHOLDER_SERVICE_NAMES.has(normalized)) {
    return '';
  }
  return normalized;
};

const isExactMoneyMatch = (
  order: SellerOrderRepairSource,
  service: SellerOrderRepairServiceSource
): boolean => {
  const orderCurrency = normalizeSkillToken(order.paymentCurrency).toUpperCase();
  const serviceCurrency = normalizeSkillToken(service.currency).toUpperCase();
  if (orderCurrency && serviceCurrency && orderCurrency !== serviceCurrency) {
    return false;
  }
  return parseDecimalToUnits(order.paymentAmount) === parseDecimalToUnits(service.price);
};

const compareVersionDistance = (
  left: SellerOrderRepairServiceSource,
  right: SellerOrderRepairServiceSource,
  orderCreatedAt: number,
): number => {
  const leftUpdatedAt = toSafeNumber(left.updatedAt);
  const rightUpdatedAt = toSafeNumber(right.updatedAt);
  const leftBefore = leftUpdatedAt > 0 && leftUpdatedAt <= orderCreatedAt;
  const rightBefore = rightUpdatedAt > 0 && rightUpdatedAt <= orderCreatedAt;
  if (leftBefore !== rightBefore) {
    return leftBefore ? -1 : 1;
  }
  if (leftBefore && rightBefore) {
    return rightUpdatedAt - leftUpdatedAt;
  }
  const leftDistance = Math.abs(orderCreatedAt - leftUpdatedAt);
  const rightDistance = Math.abs(orderCreatedAt - rightUpdatedAt);
  if (leftDistance !== rightDistance) {
    return leftDistance - rightDistance;
  }
  return rightUpdatedAt - leftUpdatedAt;
};

export function resolveSellerOrderServiceMatch(input: {
  order: SellerOrderRepairSource;
  services: SellerOrderRepairServiceSource[];
  ratingServiceIdByTxid: Map<string, string>;
  orderText?: string | null;
}): SellerOrderServiceMatch | null {
  const providerGlobalMetaId = toSafeString(input.order.providerGlobalMetaId).trim();
  const scopedServices = input.services.filter((service) => {
    const serviceId = toSafeString(service.id).trim();
    if (!serviceId) return false;
    if (!providerGlobalMetaId) return true;
    return toSafeString(service.providerGlobalMetaId).trim() === providerGlobalMetaId;
  });
  if (scopedServices.length === 0) {
    return null;
  }

  const serviceById = new Map(
    scopedServices.map((service) => [toSafeString(service.id).trim(), service] as const),
  );

  const existingServiceId = toSafeString(input.order.servicePinId).trim();
  if (existingServiceId && serviceById.has(existingServiceId)) {
    const service = serviceById.get(existingServiceId)!;
    return {
      serviceId: existingServiceId,
      serviceName: toSafeString(service.serviceName).trim() || existingServiceId,
      matchedBy: 'existing',
    };
  }

  const paymentTxid = toSafeString(input.order.paymentTxid).trim();
  const ratedServiceId = paymentTxid ? toSafeString(input.ratingServiceIdByTxid.get(paymentTxid)).trim() : '';
  if (ratedServiceId && serviceById.has(ratedServiceId)) {
    const service = serviceById.get(ratedServiceId)!;
    return {
      serviceId: ratedServiceId,
      serviceName: toSafeString(service.serviceName).trim() || ratedServiceId,
      matchedBy: 'rating_txid',
    };
  }

  const text = toSafeString(input.orderText).trim();
  const textServiceId = text ? toSafeString(extractOrderSkillId(text)).trim() : '';
  if (textServiceId && serviceById.has(textServiceId)) {
    const service = serviceById.get(textServiceId)!;
    return {
      serviceId: textServiceId,
      serviceName: toSafeString(service.serviceName).trim() || textServiceId,
      matchedBy: 'order_text_service_id',
    };
  }

  const resolvedSkillName = normalizeServiceNameForFallback(extractOrderSkillName(text))
    || normalizeServiceNameForFallback(input.order.serviceName);
  const orderCreatedAt = toSafeNumber(input.order.createdAt);
  const matchingCandidates = scopedServices
    .map((service) => {
      const providerSkill = normalizeSkillToken(service.providerSkill);
      const serviceName = normalizeSkillToken(service.serviceName);
      const exactMoneyMatch = isExactMoneyMatch(input.order, service);
      const skillMatched = Boolean(
        resolvedSkillName
        && (providerSkill === resolvedSkillName || serviceName === resolvedSkillName),
      );

      let score = 0;
      if (skillMatched) score += 100;
      if (exactMoneyMatch) score += 20;
      if (normalizeSkillToken(service.currency) === normalizeSkillToken(input.order.paymentCurrency)) {
        score += 5;
      }

      return {
        service,
        score,
        skillMatched,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return compareVersionDistance(left.service, right.service, orderCreatedAt);
    });

  const best = matchingCandidates[0];
  if (!best) {
    return null;
  }

  return {
    serviceId: toSafeString(best.service.id).trim(),
    serviceName: toSafeString(best.service.serviceName).trim() || toSafeString(best.service.id).trim(),
    matchedBy: best.skillMatched ? 'skill_price_time' : 'price_time',
  };
}
