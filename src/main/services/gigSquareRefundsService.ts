import type { ServiceOrderStatus } from './serviceOrderState';
import type { ProcessSellerRefundResult } from './serviceRefundSettlementService';

type MaybePromise<T> = T | Promise<T>;

export interface GigSquareRefundOrderRecord {
  id: string;
  role: 'buyer' | 'seller';
  localMetabotId: number;
  counterpartyGlobalMetaid: string;
  servicePinId: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentAmount: string;
  paymentCurrency: string;
  status: ServiceOrderStatus;
  failureReason: string | null;
  refundRequestPinId: string | null;
  refundTxid: string | null;
  refundRequestedAt: number | null;
  refundCompletedAt: number | null;
  coworkSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GigSquareRefundItem {
  orderId: string;
  role: 'buyer' | 'seller';
  servicePinId: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentAmount: string;
  paymentCurrency: string;
  status: ServiceOrderStatus;
  failureReason: string | null;
  refundRequestPinId: string | null;
  refundTxid: string | null;
  refundRequestedAt: number | null;
  refundCompletedAt: number | null;
  counterpartyGlobalMetaid: string;
  counterpartyName: string;
  counterpartyAvatar: string | null;
  createdAt: number;
  updatedAt: number;
  coworkSessionId: string | null;
  canProcessRefund: boolean;
}

export interface GigSquareRefundCollections {
  pendingForMe: GigSquareRefundItem[];
  initiatedByMe: GigSquareRefundItem[];
  pendingCount: number;
}

export interface GigSquareRefundProcessResult {
  orderId: string;
  refundTxid?: string;
  refundFinalizePinId?: string;
}

export interface GigSquareRefundCounterpartyInfo {
  name?: string | null;
  avatarUrl?: string | null;
}

interface GigSquareRefundsServiceOptions {
  listSellerRefundOrders: () => MaybePromise<GigSquareRefundOrderRecord[]>;
  listBuyerRefundOrders: () => MaybePromise<GigSquareRefundOrderRecord[]>;
  getOrderById?: (
    orderId: string
  ) => MaybePromise<GigSquareRefundOrderRecord | null | undefined>;
  resolveCounterpartyInfo?: (
    globalMetaId: string
  ) => MaybePromise<GigSquareRefundCounterpartyInfo | null | undefined>;
  resolveCoworkSessionIdForOrder?: (
    order: GigSquareRefundOrderRecord
  ) => MaybePromise<string | null | undefined>;
  processSellerRefundForOrderId: (
    orderId: string
  ) => MaybePromise<ProcessSellerRefundResult>;
}

const normalizeText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const normalizeOptionalText = (value: unknown): string | null => {
  const normalized = normalizeText(value);
  return normalized || null;
};

const normalizeTimestamp = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const getPendingRank = (status: ServiceOrderStatus): number => (
  status === 'refund_pending' ? 0 : 1
);

const isRefundListStatus = (status: ServiceOrderStatus): boolean => (
  status === 'refund_pending' || status === 'refunded'
);

const canProcessRefundOrder = (order: GigSquareRefundOrderRecord): boolean => (
  order.role === 'seller'
  && order.status === 'refund_pending'
  && Boolean(normalizeOptionalText(order.refundRequestPinId))
);

const isActionableSellerRefundOrder = (order: GigSquareRefundOrderRecord): boolean => (
  canProcessRefundOrder(order)
);

const getSellerSortTimestamp = (order: GigSquareRefundOrderRecord): number => (
  normalizeTimestamp(order.refundRequestedAt)
  ?? normalizeTimestamp(order.updatedAt)
  ?? normalizeTimestamp(order.createdAt)
  ?? 0
);

const getBuyerSortTimestamp = (order: GigSquareRefundOrderRecord): number => {
  if (order.status === 'refunded') {
    return normalizeTimestamp(order.refundCompletedAt)
      ?? normalizeTimestamp(order.updatedAt)
      ?? normalizeTimestamp(order.createdAt)
      ?? 0;
  }
  return normalizeTimestamp(order.refundRequestedAt)
    ?? normalizeTimestamp(order.updatedAt)
    ?? normalizeTimestamp(order.createdAt)
    ?? 0;
};

const compareSellerRefundOrders = (
  left: GigSquareRefundOrderRecord,
  right: GigSquareRefundOrderRecord
): number => {
  const rankDelta = getPendingRank(left.status) - getPendingRank(right.status);
  if (rankDelta !== 0) return rankDelta;

  const timeDelta = getSellerSortTimestamp(left) - getSellerSortTimestamp(right);
  if (timeDelta !== 0) return timeDelta;

  return left.id.localeCompare(right.id);
};

const compareBuyerRefundOrders = (
  left: GigSquareRefundOrderRecord,
  right: GigSquareRefundOrderRecord
): number => {
  const rankDelta = getPendingRank(left.status) - getPendingRank(right.status);
  if (rankDelta !== 0) return rankDelta;

  const timeDelta = getBuyerSortTimestamp(right) - getBuyerSortTimestamp(left);
  if (timeDelta !== 0) return timeDelta;

  return left.id.localeCompare(right.id);
};

export class GigSquareRefundsService {
  private listSellerRefundOrders: () => MaybePromise<GigSquareRefundOrderRecord[]>;
  private listBuyerRefundOrders: () => MaybePromise<GigSquareRefundOrderRecord[]>;
  private getOrderById?: (
    orderId: string
  ) => MaybePromise<GigSquareRefundOrderRecord | null | undefined>;
  private resolveCounterpartyInfo?: (
    globalMetaId: string
  ) => MaybePromise<GigSquareRefundCounterpartyInfo | null | undefined>;
  private resolveCoworkSessionIdForOrder?: (
    order: GigSquareRefundOrderRecord
  ) => MaybePromise<string | null | undefined>;
  private processSellerRefundForOrderId: (
    orderId: string
  ) => MaybePromise<ProcessSellerRefundResult>;

  constructor(options: GigSquareRefundsServiceOptions) {
    this.listSellerRefundOrders = options.listSellerRefundOrders;
    this.listBuyerRefundOrders = options.listBuyerRefundOrders;
    this.getOrderById = options.getOrderById;
    this.resolveCounterpartyInfo = options.resolveCounterpartyInfo;
    this.resolveCoworkSessionIdForOrder = options.resolveCoworkSessionIdForOrder;
    this.processSellerRefundForOrderId = options.processSellerRefundForOrderId;
  }

  async listRefunds(): Promise<GigSquareRefundCollections> {
    const [sellerOrders, buyerOrders] = await Promise.all([
      Promise.resolve(this.listSellerRefundOrders()),
      Promise.resolve(this.listBuyerRefundOrders()),
    ]);

    const [pendingForMe, initiatedByMe] = await Promise.all([
      Promise.all(
        [...sellerOrders]
          .filter(isActionableSellerRefundOrder)
          .sort(compareSellerRefundOrders)
          .map((order) => this.buildRefundItem(order))
      ),
      Promise.all(
        [...buyerOrders]
          .filter((order) => isRefundListStatus(order.status))
          .sort(compareBuyerRefundOrders)
          .map((order) => this.buildRefundItem(order))
      ),
    ]);

    return {
      pendingForMe,
      initiatedByMe,
      pendingCount: pendingForMe.length,
    };
  }

  async processRefundOrder(input: {
    orderId: string;
  }): Promise<GigSquareRefundProcessResult> {
    const orderId = normalizeText(input?.orderId);
    if (!orderId) {
      throw new Error('Refund order id is required');
    }

    const order = await this.loadOrderForProcessing(orderId);
    if (!order) {
      throw new Error('Refund order not found');
    }
    if (order.role !== 'seller') {
      throw new Error('Only seller refund orders can be processed');
    }
    if (order.status !== 'refund_pending') {
      throw new Error('Refund order is not pending');
    }
    if (!normalizeOptionalText(order.refundRequestPinId)) {
      throw new Error('No pending refund request found for this seller order');
    }

    const result = await Promise.resolve(this.processSellerRefundForOrderId(orderId));
    return {
      orderId,
      refundTxid: normalizeOptionalText(result.refundTxid) ?? undefined,
      refundFinalizePinId: normalizeOptionalText(result.refundFinalizePinId) ?? undefined,
    };
  }

  private async buildRefundItem(
    order: GigSquareRefundOrderRecord
  ): Promise<GigSquareRefundItem> {
    const counterpartyGlobalMetaid = normalizeText(order.counterpartyGlobalMetaid);
    const [counterpartyInfo, coworkSessionId] = await Promise.all([
      this.loadCounterpartyInfo(counterpartyGlobalMetaid),
      this.loadCoworkSessionId(order),
    ]);

    return {
      orderId: normalizeText(order.id),
      role: order.role,
      servicePinId: normalizeOptionalText(order.servicePinId),
      serviceName: normalizeText(order.serviceName),
      paymentTxid: normalizeText(order.paymentTxid),
      paymentAmount: normalizeText(order.paymentAmount),
      paymentCurrency: normalizeText(order.paymentCurrency),
      status: order.status,
      failureReason: normalizeOptionalText(order.failureReason),
      refundRequestPinId: normalizeOptionalText(order.refundRequestPinId),
      refundTxid: normalizeOptionalText(order.refundTxid),
      refundRequestedAt: normalizeTimestamp(order.refundRequestedAt),
      refundCompletedAt: normalizeTimestamp(order.refundCompletedAt),
      counterpartyGlobalMetaid,
      counterpartyName: normalizeOptionalText(counterpartyInfo?.name) || counterpartyGlobalMetaid,
      counterpartyAvatar: normalizeOptionalText(counterpartyInfo?.avatarUrl),
      createdAt: normalizeTimestamp(order.createdAt) ?? 0,
      updatedAt: normalizeTimestamp(order.updatedAt) ?? 0,
      coworkSessionId,
      canProcessRefund: canProcessRefundOrder(order),
    };
  }

  private async loadOrderForProcessing(
    orderId: string
  ): Promise<GigSquareRefundOrderRecord | null> {
    if (this.getOrderById) {
      return (await Promise.resolve(this.getOrderById(orderId))) ?? null;
    }

    const sellerOrders = await Promise.resolve(this.listSellerRefundOrders());
    const sellerOrder = sellerOrders.find((candidate) => normalizeText(candidate.id) === orderId);
    if (sellerOrder) {
      return sellerOrder;
    }

    const buyerOrders = await Promise.resolve(this.listBuyerRefundOrders());
    return buyerOrders.find((candidate) => normalizeText(candidate.id) === orderId) ?? null;
  }

  private async loadCounterpartyInfo(
    globalMetaId: string
  ): Promise<GigSquareRefundCounterpartyInfo | null> {
    if (!this.resolveCounterpartyInfo || !globalMetaId) {
      return null;
    }
    try {
      return (await Promise.resolve(this.resolveCounterpartyInfo(globalMetaId))) ?? null;
    } catch {
      return null;
    }
  }

  private async loadCoworkSessionId(
    order: GigSquareRefundOrderRecord
  ): Promise<string | null> {
    const directSessionId = normalizeOptionalText(order.coworkSessionId);
    if (directSessionId) {
      return directSessionId;
    }
    if (!this.resolveCoworkSessionIdForOrder) {
      return null;
    }
    try {
      return normalizeOptionalText(
        await Promise.resolve(this.resolveCoworkSessionIdForOrder(order))
      );
    } catch {
      return null;
    }
  }
}
