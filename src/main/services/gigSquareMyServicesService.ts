export interface GigSquareMyServiceSource {
  id: string;
  serviceName?: string;
  displayName?: string;
  description?: string;
  price?: string;
  currency?: string;
  providerMetaId?: string;
  providerGlobalMetaId?: string;
  providerAddress?: string;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerSkill?: string | null;
  ratingAvg?: number;
  ratingCount?: number;
  updatedAt?: number;
}

export interface GigSquareMyServiceOrderSource {
  id: string;
  status: string;
  paymentTxid?: string | null;
  paymentAmount?: string | null;
  paymentCurrency?: string | null;
  servicePinId?: string | null;
  createdAt?: number | null;
  deliveredAt?: number | null;
  refundCompletedAt?: number | null;
  updatedAt?: number | null;
  counterpartyGlobalMetaid?: string | null;
  coworkSessionId?: string | null;
}

export interface GigSquareMyServiceRating {
  serviceId?: string;
  servicePaidTx?: string | null;
  rate?: number | null;
  comment?: string | null;
  raterGlobalMetaId?: string | null;
  raterMetaId?: string | null;
  createdAt?: number | null;
}

export interface GigSquareMyServiceSummary {
  id: string;
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerSkill?: string | null;
  successCount: number;
  refundCount: number;
  grossRevenue: string;
  netIncome: string;
  ratingAvg: number;
  ratingCount: number;
  updatedAt: number;
}

export interface GigSquareMyServiceOrderDetail {
  id: string;
  status: string;
  paymentTxid: string | null;
  paymentAmount: string;
  paymentCurrency: string;
  servicePinId: string | null;
  createdAt: number | null;
  deliveredAt: number | null;
  refundCompletedAt: number | null;
  counterpartyGlobalMetaid: string | null;
  coworkSessionId: string | null;
  rating: null | {
    rate: number;
    comment: string | null;
    createdAt: number | null;
    raterGlobalMetaId: string | null;
    raterMetaId: string | null;
  };
}

export interface GigSquarePageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const DECIMAL_SCALE = 8n;
const DECIMAL_MULTIPLIER = 10n ** DECIMAL_SCALE;
const COMPLETED_STATUS = 'completed';
const REFUNDED_STATUS = 'refunded';

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

const normalizePage = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.floor(value);
};

const normalizePageSize = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
};

export const clampPageSize = (value: number, maxPageSize: number): number => {
  const normalizedMax = normalizePageSize(maxPageSize, 1);
  const normalizedValue = normalizePageSize(value, normalizedMax);
  return Math.min(normalizedValue, normalizedMax);
};

const compareNumbersDesc = (a: number | null | undefined, b: number | null | undefined): number => {
  return toSafeNumber(b) - toSafeNumber(a);
};

const compareStringsDesc = (a: string | null | undefined, b: string | null | undefined): number => {
  return toSafeString(b).localeCompare(toSafeString(a));
};

const parseDecimalToUnits = (value: string | null | undefined): bigint => {
  const normalized = toSafeString(value).trim();
  if (!normalized) return 0n;
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return 0n;

  const sign = match[1] === '-' ? -1n : 1n;
  const integerPart = BigInt(match[2] || '0');
  const fractionPart = (match[3] || '').slice(0, Number(DECIMAL_SCALE)).padEnd(Number(DECIMAL_SCALE), '0');
  const fractionUnits = BigInt(fractionPart || '0');
  return sign * (integerPart * DECIMAL_MULTIPLIER + fractionUnits);
};

const formatUnitsToDecimal = (units: bigint): string => {
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  const integerPart = absolute / DECIMAL_MULTIPLIER;
  const fractionPart = (absolute % DECIMAL_MULTIPLIER).toString().padStart(Number(DECIMAL_SCALE), '0').replace(/0+$/, '');
  return fractionPart ? `${sign}${integerPart.toString()}.${fractionPart}` : `${sign}${integerPart.toString()}`;
};

const createPageResult = <T>(items: T[], page: number, pageSize: number): GigSquarePageResult<T> => {
  const normalizedPage = normalizePage(page);
  const normalizedPageSize = normalizePageSize(pageSize, items.length || 1);
  const total = items.length;
  const totalPages = total > 0 ? Math.ceil(total / normalizedPageSize) : 0;
  const start = (normalizedPage - 1) * normalizedPageSize;
  return {
    items: items.slice(start, start + normalizedPageSize),
    page: normalizedPage,
    pageSize: normalizedPageSize,
    total,
    totalPages,
  };
};

const isClosedSellerStatus = (status: string): boolean => {
  return status === COMPLETED_STATUS || status === REFUNDED_STATUS;
};

const getOrderFinalizedAt = (order: GigSquareMyServiceOrderSource): number => {
  if (order.status === REFUNDED_STATUS) {
    return toSafeNumber(order.refundCompletedAt ?? order.updatedAt ?? order.createdAt);
  }
  return toSafeNumber(order.deliveredAt ?? order.updatedAt ?? order.createdAt);
};

const pickRatingDetail = (
  ratingOrList: GigSquareMyServiceRating | GigSquareMyServiceRating[] | undefined,
  counterpartyGlobalMetaid?: string | null,
): GigSquareMyServiceOrderDetail['rating'] => {
  if (!ratingOrList) return null;
  const ratings = Array.isArray(ratingOrList) ? [...ratingOrList] : [ratingOrList];
  const normalizedBuyerGlobalMetaId = toSafeString(counterpartyGlobalMetaid).trim();
  const sortByNewest = (left: GigSquareMyServiceRating, right: GigSquareMyServiceRating) =>
    compareNumbersDesc(left.createdAt, right.createdAt);

  let rating: GigSquareMyServiceRating | undefined;
  if (!normalizedBuyerGlobalMetaId) {
    rating = ratings.sort(sortByNewest)[0];
  } else {
    const exactMatches = ratings
      .filter((candidate) => toSafeString(candidate.raterGlobalMetaId).trim() === normalizedBuyerGlobalMetaId)
      .sort(sortByNewest);
    if (exactMatches.length > 0) {
      rating = exactMatches[0];
    } else {
      const txOnlyCandidates = ratings
        .filter((candidate) => !toSafeString(candidate.raterGlobalMetaId).trim())
        .sort(sortByNewest);
      rating = txOnlyCandidates[0];
    }
  }
  if (!rating) return null;
  const rate = toSafeNumber(rating.rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return {
    rate,
    comment: toSafeString(rating.comment).trim() || null,
    createdAt: rating.createdAt == null ? null : toSafeNumber(rating.createdAt),
    raterGlobalMetaId: toSafeString(rating.raterGlobalMetaId).trim() || null,
    raterMetaId: toSafeString(rating.raterMetaId).trim() || null,
  };
};

export function buildMyServiceSummaries(input: {
  ownedGlobalMetaIds: Set<string>;
  services: GigSquareMyServiceSource[];
  sellerOrders: GigSquareMyServiceOrderSource[];
  page: number;
  pageSize: number;
}): GigSquarePageResult<GigSquareMyServiceSummary> {
  const orderStatsByServiceId = new Map<string, {
    successCount: number;
    refundCount: number;
    grossRevenueUnits: bigint;
    netIncomeUnits: bigint;
  }>();

  for (const order of input.sellerOrders) {
    const serviceId = toSafeString(order.servicePinId).trim();
    if (!serviceId || !isClosedSellerStatus(order.status)) continue;
    const existing = orderStatsByServiceId.get(serviceId) ?? {
      successCount: 0,
      refundCount: 0,
      grossRevenueUnits: 0n,
      netIncomeUnits: 0n,
    };
    const amountUnits = parseDecimalToUnits(order.paymentAmount);
    existing.grossRevenueUnits += amountUnits;
    if (order.status === COMPLETED_STATUS) {
      existing.successCount += 1;
      existing.netIncomeUnits += amountUnits;
    } else if (order.status === REFUNDED_STATUS) {
      existing.refundCount += 1;
    }
    orderStatsByServiceId.set(serviceId, existing);
  }

  const items = input.services
    .filter((service) => input.ownedGlobalMetaIds.has(toSafeString(service.providerGlobalMetaId).trim()))
    .sort((left, right) => {
      const updatedSort = compareNumbersDesc(left.updatedAt, right.updatedAt);
      return updatedSort !== 0 ? updatedSort : compareStringsDesc(left.id, right.id);
    })
    .map((service) => {
      const stats = orderStatsByServiceId.get(service.id);
      return {
        id: service.id,
        serviceName: toSafeString(service.serviceName).trim(),
        displayName: toSafeString(service.displayName).trim() || toSafeString(service.serviceName).trim() || 'Service',
        description: toSafeString(service.description).trim(),
        price: toSafeString(service.price).trim(),
        currency: toSafeString(service.currency).trim(),
        providerMetaId: toSafeString(service.providerMetaId).trim(),
        providerGlobalMetaId: toSafeString(service.providerGlobalMetaId).trim(),
        providerAddress: toSafeString(service.providerAddress).trim(),
        avatar: service.avatar ?? null,
        serviceIcon: service.serviceIcon ?? null,
        providerSkill: toSafeString(service.providerSkill).trim() || null,
        successCount: stats?.successCount ?? 0,
        refundCount: stats?.refundCount ?? 0,
        grossRevenue: formatUnitsToDecimal(stats?.grossRevenueUnits ?? 0n),
        netIncome: formatUnitsToDecimal(stats?.netIncomeUnits ?? 0n),
        ratingAvg: toSafeNumber(service.ratingAvg),
        ratingCount: toSafeNumber(service.ratingCount),
        updatedAt: toSafeNumber(service.updatedAt),
      };
    });

  return createPageResult(items, input.page, input.pageSize);
}

export function buildMyServiceOrderDetails(input: {
  serviceId: string;
  sellerOrders: GigSquareMyServiceOrderSource[];
  ratingsByPaymentTxid: Map<string, GigSquareMyServiceRating | GigSquareMyServiceRating[]>;
  page: number;
  pageSize: number;
}): GigSquarePageResult<GigSquareMyServiceOrderDetail> {
  const normalizedServiceId = toSafeString(input.serviceId).trim();
  const items = input.sellerOrders
    .filter((order) => toSafeString(order.servicePinId).trim() === normalizedServiceId && isClosedSellerStatus(order.status))
    .sort((left, right) => {
      const finalizedSort = compareNumbersDesc(getOrderFinalizedAt(left), getOrderFinalizedAt(right));
      if (finalizedSort !== 0) return finalizedSort;
      if (left.status !== right.status) {
        return left.status === REFUNDED_STATUS ? -1 : 1;
      }
      const updatedSort = compareNumbersDesc(left.updatedAt, right.updatedAt);
      if (updatedSort !== 0) return updatedSort;
      const createdSort = compareNumbersDesc(left.createdAt, right.createdAt);
      if (createdSort !== 0) return createdSort;
      return compareStringsDesc(left.id, right.id);
    })
    .map((order) => {
      const paymentTxid = toSafeString(order.paymentTxid).trim();
      return {
        id: order.id,
        status: order.status,
        paymentTxid: paymentTxid || null,
        paymentAmount: toSafeString(order.paymentAmount).trim(),
        paymentCurrency: toSafeString(order.paymentCurrency).trim(),
        servicePinId: toSafeString(order.servicePinId).trim() || null,
        createdAt: order.createdAt == null ? null : toSafeNumber(order.createdAt),
        deliveredAt: order.deliveredAt == null ? null : toSafeNumber(order.deliveredAt),
        refundCompletedAt: order.refundCompletedAt == null ? null : toSafeNumber(order.refundCompletedAt),
        counterpartyGlobalMetaid: toSafeString(order.counterpartyGlobalMetaid).trim() || null,
        coworkSessionId: toSafeString(order.coworkSessionId).trim() || null,
        rating: paymentTxid
          ? pickRatingDetail(input.ratingsByPaymentTxid.get(paymentTxid), order.counterpartyGlobalMetaid)
          : null,
      };
    });

  return createPageResult(items, input.page, input.pageSize);
}
