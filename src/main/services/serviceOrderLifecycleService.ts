import {
  ServiceOrderStore,
  type ServiceOrderRecord,
} from '../serviceOrderStore';
import {
  buildSharedBuyerPaymentKey,
  isSharedSelfDirectedPair,
  SHARED_DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS,
  SHARED_SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON,
  SHARED_SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE,
  SHARED_SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE,
} from '../shared/metabotServiceBridge';
import { getTimedOutOrderTransition } from './serviceOrderState';
import { buildRefundRequestPayload } from './serviceOrderProtocols.js';

export const SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE = SHARED_SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE;
export const SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE = SHARED_SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE;
export const DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS = SHARED_DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS;
export const SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON = SHARED_SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON;

export interface CreateBuyerOrderInput {
  localMetabotId: number;
  counterpartyGlobalMetaId: string;
  servicePinId?: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentChain?: string;
  paymentAmount: string;
  paymentCurrency?: string;
  settlementKind?: string;
  mrc20Ticker?: string;
  mrc20Id?: string;
  paymentCommitTxid?: string;
  coworkSessionId?: string | null;
  orderMessagePinId?: string | null;
}

export interface CreateSellerOrderInput {
  localMetabotId: number;
  counterpartyGlobalMetaId: string;
  servicePinId?: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentChain?: string;
  paymentAmount: string;
  paymentCurrency?: string;
  settlementKind?: string;
  mrc20Ticker?: string;
  mrc20Id?: string;
  paymentCommitTxid?: string;
  coworkSessionId?: string | null;
  orderMessagePinId?: string | null;
}

export interface ServiceOrderPaymentMatchInput {
  localMetabotId: number;
  counterpartyGlobalMetaId: string;
  paymentTxid: string;
}

export interface MarkBuyerOrderDeliveredInput extends ServiceOrderPaymentMatchInput {
  deliveryMessagePinId?: string | null;
  deliveredAt?: number;
}

export interface MarkSellerOrderDeliveredInput extends ServiceOrderPaymentMatchInput {
  deliveryMessagePinId?: string | null;
  deliveredAt?: number;
}

export interface MarkBuyerOrderFirstResponseReceivedInput extends ServiceOrderPaymentMatchInput {
  receivedAt?: number;
}

export interface MarkSellerOrderFirstResponseSentInput extends ServiceOrderPaymentMatchInput {
  sentAt?: number;
}

export interface AttachSellerCoworkSessionInput extends ServiceOrderPaymentMatchInput {
  coworkSessionId: string;
}

interface ServiceOrderLifecycleServiceOptions {
  now?: () => number;
  resolveLocalMetabotGlobalMetaId?: (localMetabotId: number) => string | null | undefined;
  buildRefundRequestPayload?: (order: ServiceOrderRecord) => Record<string, unknown>;
  createRefundRequestPin?: (input: {
    order: ServiceOrderRecord;
    payload: Record<string, unknown>;
  }) => Promise<{ pinId?: string | null; txid?: string | null }>;
  refundRequestRetryDelayMs?: number;
  onOrderEvent?: (event: {
    type: 'refund_requested' | 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;
}

export class ServiceOrderOpenOrderExistsError extends Error {
  code: string;
  existingOrderId: string;

  constructor(existingOrderId: string) {
    super('Open order already exists for this buyer and provider.');
    this.name = 'ServiceOrderOpenOrderExistsError';
    this.code = SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE;
    this.existingOrderId = existingOrderId;
  }
}

export class ServiceOrderSelfOrderNotAllowedError extends Error {
  code: string;

  constructor() {
    super('A MetaBot cannot order its own service.');
    this.name = 'ServiceOrderSelfOrderNotAllowedError';
    this.code = SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE;
  }
}

export class ServiceOrderLifecycleService {
  private store: ServiceOrderStore;
  private now: () => number;
  private resolveLocalMetabotGlobalMetaId: (localMetabotId: number) => string | null | undefined;
  private pendingBuyerOrderPayments = new Set<string>();
  private buildRefundRequestPayload: (order: ServiceOrderRecord) => Record<string, unknown>;
  private createRefundRequestPin?: (input: {
    order: ServiceOrderRecord;
    payload: Record<string, unknown>;
  }) => Promise<{ pinId?: string | null; txid?: string | null }>;
  private refundRequestRetryDelayMs: number;
  private onOrderEvent?: (event: {
    type: 'refund_requested' | 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;

  constructor(
    store: ServiceOrderStore,
    options: ServiceOrderLifecycleServiceOptions = {}
  ) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.resolveLocalMetabotGlobalMetaId =
      options.resolveLocalMetabotGlobalMetaId ?? (() => null);
    this.buildRefundRequestPayload =
      options.buildRefundRequestPayload ?? ((order) => this.buildDefaultRefundRequestPayload(order));
    this.createRefundRequestPin = options.createRefundRequestPin;
    this.refundRequestRetryDelayMs =
      options.refundRequestRetryDelayMs ?? DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS;
    this.onOrderEvent = options.onOrderEvent;
  }

  getBuyerOrderAvailability(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): { allowed: true } | { allowed: false; errorCode: string; error: string } {
    this.repairSelfDirectedOrders();
    try {
      this.assertNotSelfDirectedOrder(localMetabotId, counterpartyGlobalMetaId);
      return { allowed: true };
    } catch (error) {
      if (
        error instanceof ServiceOrderSelfOrderNotAllowedError
      ) {
        return {
          allowed: false,
          errorCode: error.code,
          error: error.message,
        };
      }
      throw error;
    }
  }

  private assertNoPendingBuyerOrderForPayment(
    localMetabotId: number,
    counterpartyGlobalMetaId: string,
    paymentTxid?: string | null
  ): void {
    const key = this.getBuyerPaymentKey(localMetabotId, counterpartyGlobalMetaId, paymentTxid);
    if (!key) return;
    if (this.pendingBuyerOrderPayments.has(key)) {
      throw new ServiceOrderOpenOrderExistsError(`pending:${key}`);
    }
  }

  reserveBuyerOrderCreation(
    localMetabotId: number,
    counterpartyGlobalMetaId: string,
    paymentTxid?: string | null
  ): () => void {
    this.repairSelfDirectedOrders();
    this.assertNotSelfDirectedOrder(localMetabotId, counterpartyGlobalMetaId);
    this.assertNoPendingBuyerOrderForPayment(localMetabotId, counterpartyGlobalMetaId, paymentTxid);
    const paymentKey = this.getBuyerPaymentKey(localMetabotId, counterpartyGlobalMetaId, paymentTxid);
    if (paymentKey) {
      this.pendingBuyerOrderPayments.add(paymentKey);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (paymentKey) {
        this.pendingBuyerOrderPayments.delete(paymentKey);
      }
    };
  }

  createBuyerOrder(input: CreateBuyerOrderInput): ServiceOrderRecord {
    this.assertNotSelfDirectedOrder(
      input.localMetabotId,
      input.counterpartyGlobalMetaId
    );

    return this.store.createOrder({
      role: 'buyer',
      localMetabotId: input.localMetabotId,
      counterpartyGlobalMetaid: input.counterpartyGlobalMetaId,
      servicePinId: input.servicePinId ?? null,
      serviceName: input.serviceName,
      paymentTxid: input.paymentTxid,
      paymentChain: input.paymentChain,
      paymentAmount: input.paymentAmount,
      paymentCurrency: input.paymentCurrency,
      settlementKind: input.settlementKind,
      mrc20Ticker: input.mrc20Ticker,
      mrc20Id: input.mrc20Id,
      paymentCommitTxid: input.paymentCommitTxid,
      coworkSessionId: input.coworkSessionId ?? null,
      orderMessagePinId: input.orderMessagePinId ?? null,
      status: 'awaiting_first_response',
      now: this.now(),
    });
  }

  createSellerOrder(input: CreateSellerOrderInput): ServiceOrderRecord {
    this.assertNotSelfDirectedOrder(
      input.localMetabotId,
      input.counterpartyGlobalMetaId
    );
    return this.store.createOrder({
      role: 'seller',
      localMetabotId: input.localMetabotId,
      counterpartyGlobalMetaid: input.counterpartyGlobalMetaId,
      servicePinId: input.servicePinId ?? null,
      serviceName: input.serviceName,
      paymentTxid: input.paymentTxid,
      paymentChain: input.paymentChain,
      paymentAmount: input.paymentAmount,
      paymentCurrency: input.paymentCurrency,
      settlementKind: input.settlementKind,
      mrc20Ticker: input.mrc20Ticker,
      mrc20Id: input.mrc20Id,
      paymentCommitTxid: input.paymentCommitTxid,
      coworkSessionId: input.coworkSessionId ?? null,
      orderMessagePinId: input.orderMessagePinId ?? null,
      status: 'awaiting_first_response',
      now: this.now(),
    });
  }

  markBuyerOrderFirstResponseReceived(
    input: MarkBuyerOrderFirstResponseReceivedInput
  ): ServiceOrderRecord | null {
    const order = this.store.findOrderByPayment({
      role: 'buyer',
      localMetabotId: input.localMetabotId,
      counterpartyGlobalMetaid: input.counterpartyGlobalMetaId,
      paymentTxid: input.paymentTxid,
    });
    if (!order) return null;
    return this.store.markFirstResponseReceived(
      order.id,
      input.receivedAt ?? this.now()
    );
  }

  markSellerOrderFirstResponseSent(
    input: MarkSellerOrderFirstResponseSentInput
  ): ServiceOrderRecord | null {
    const order = this.store.findOrderByPayment({
      role: 'seller',
      localMetabotId: input.localMetabotId,
      counterpartyGlobalMetaid: input.counterpartyGlobalMetaId,
      paymentTxid: input.paymentTxid,
    });
    if (!order) return null;
    return this.store.markFirstResponseReceived(
      order.id,
      input.sentAt ?? this.now()
    );
  }

  markBuyerOrderDelivered(input: MarkBuyerOrderDeliveredInput): ServiceOrderRecord | null {
    const order = this.store.findOrderByPayment({
      role: 'buyer',
      localMetabotId: input.localMetabotId,
      counterpartyGlobalMetaid: input.counterpartyGlobalMetaId,
      paymentTxid: input.paymentTxid,
    });
    if (!order) return null;
    return this.store.markDelivered(order.id, {
      deliveryMessagePinId: input.deliveryMessagePinId ?? null,
      deliveredAt: input.deliveredAt ?? this.now(),
    });
  }

  markSellerOrderDelivered(input: MarkSellerOrderDeliveredInput): ServiceOrderRecord | null {
    const order = this.store.findOrderByPayment({
      role: 'seller',
      localMetabotId: input.localMetabotId,
      counterpartyGlobalMetaid: input.counterpartyGlobalMetaId,
      paymentTxid: input.paymentTxid,
    });
    if (!order) return null;
    return this.store.markDelivered(order.id, {
      deliveryMessagePinId: input.deliveryMessagePinId ?? null,
      deliveredAt: input.deliveredAt ?? this.now(),
    });
  }

  attachCoworkSessionToSellerOrder(
    input: AttachSellerCoworkSessionInput
  ): ServiceOrderRecord | null {
    const order = this.store.findOrderByPayment({
      role: 'seller',
      localMetabotId: input.localMetabotId,
      counterpartyGlobalMetaid: input.counterpartyGlobalMetaId,
      paymentTxid: input.paymentTxid,
    });
    if (!order) return null;
    return this.store.setCoworkSessionId(order.id, input.coworkSessionId);
  }

  async scanTimedOutOrders(): Promise<void> {
    this.repairSelfDirectedOrders();
    const now = this.now();
    const openBuyerOrders = this.store.listOrdersByStatuses('buyer', [
      'awaiting_first_response',
      'in_progress',
    ]);

    for (const order of openBuyerOrders) {
      const transition = getTimedOutOrderTransition(order, now);
      if (!transition) continue;
      const failedOrder = this.store.markFailed(order.id, transition, now);
      if (!failedOrder) continue;
      await this.tryCreateRefundRequest(failedOrder.id, now);
    }

    const retryCandidates = this.store.listRefundRequestRetryCandidates('buyer', now);
    for (const order of retryCandidates) {
      await this.tryCreateRefundRequest(order.id, now);
    }
  }

  repairSelfDirectedOrders(): ServiceOrderRecord[] {
    const paymentTxids = new Set<string>();
    const candidateStatuses = [
      'awaiting_first_response',
      'in_progress',
      'failed',
      'refund_pending',
    ] as const;

    for (const role of ['buyer', 'seller'] as const) {
      for (const order of this.store.listOrdersByStatuses(role, [...candidateStatuses])) {
        if (this.isSelfDirectedOrder(order)) {
          paymentTxids.add(order.paymentTxid);
        }
      }
    }

    if (paymentTxids.size === 0) {
      return [];
    }

    const resolvedAt = this.now();
    const repaired: ServiceOrderRecord[] = [];
    for (const paymentTxid of paymentTxids) {
      for (const order of this.store.listOrdersByPaymentTxid(paymentTxid)) {
        if (order.status === 'completed' || order.status === 'refunded') {
          continue;
        }
        const updated = this.store.markRefundedLocally(order.id, {
          resolvedAt,
          failureReason: SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE,
        });
        if (updated) {
          repaired.push(updated);
        }
      }
    }

    return repaired;
  }

  async tryCreateRefundRequest(
    orderId: string,
    attemptedAt: number = this.now()
  ): Promise<ServiceOrderRecord | null> {
    const order = this.store.getOrderById(orderId);
    if (!order || order.role !== 'buyer') return order;
    if (order.status === 'refund_pending' || order.status === 'refunded' || order.refundRequestPinId) {
      return order;
    }
    if (this.isZeroAmount(order.paymentAmount)) {
      const updatedOrders = this.store
        .listOrdersByPaymentTxid(order.paymentTxid)
        .map((candidate) => this.store.markRefundedLocally(candidate.id, {
          resolvedAt: attemptedAt,
          failureReason: SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON,
        }))
        .filter(Boolean) as ServiceOrderRecord[];
      await this.emitRefundResolvedEvents(updatedOrders);
      return updatedOrders.find((candidate) => candidate.id === order.id)
        ?? this.store.getOrderById(order.id);
    }

    try {
      if (!this.createRefundRequestPin) {
        throw new Error('Refund request broadcaster is not configured');
      }
      const payload = this.buildRefundRequestPayload(order);
      const result = await this.createRefundRequestPin({ order, payload });
      const updatedOrder = this.store.markRefundPending(
        order.id,
        result.pinId ?? result.txid ?? null,
        attemptedAt
      );
      const mirroredOrders = this.mirrorRefundPendingToCounterparts(
        order,
        result.pinId ?? result.txid ?? null,
        attemptedAt
      );
      await this.emitRefundRequestedEvents([
        ...mirroredOrders,
        ...(updatedOrder ? [updatedOrder] : []),
      ]);
      return updatedOrder;
    } catch {
      return this.store.markRefundRequestRetry(order.id, {
        attemptedAt,
        nextRetryAt: attemptedAt + this.refundRequestRetryDelayMs,
      });
    }
  }

  private buildDefaultRefundRequestPayload(order: ServiceOrderRecord): Record<string, unknown> {
    return buildRefundRequestPayload({
      paymentTxid: order.paymentTxid,
      servicePinId: order.servicePinId,
      serviceName: order.serviceName,
      refundAmount: order.paymentAmount,
      refundCurrency: order.paymentCurrency,
      paymentChain: order.paymentChain,
      settlementKind: order.settlementKind,
      mrc20Ticker: order.mrc20Ticker,
      mrc20Id: order.mrc20Id,
      paymentCommitTxid: order.paymentCommitTxid,
      refundToAddress: '',
      buyerGlobalMetaId: '',
      sellerGlobalMetaId: order.counterpartyGlobalMetaid,
      orderMessagePinId: order.orderMessagePinId,
      failureReason: order.failureReason ?? 'delivery_timeout',
      failureDetectedAt: Math.floor((order.failedAt ?? this.now()) / 1000),
      reasonComment: '服务超时',
      evidencePinIds: [order.orderMessagePinId].filter(Boolean),
    });
  }

  private getBuyerPaymentKey(
    localMetabotId: number,
    counterpartyGlobalMetaId: string,
    paymentTxid?: string | null
  ): string | null {
    return buildSharedBuyerPaymentKey(localMetabotId, counterpartyGlobalMetaId, paymentTxid);
  }

  private isSelfDirectedOrder(order: ServiceOrderRecord): boolean {
    return this.isSelfDirectedPair(order.localMetabotId, order.counterpartyGlobalMetaid);
  }

  private isSelfDirectedPair(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): boolean {
    return isSharedSelfDirectedPair({
      localGlobalMetaId: this.normalizeGlobalMetaId(
        this.resolveLocalMetabotGlobalMetaId(localMetabotId)
      ),
      counterpartyGlobalMetaId: this.normalizeGlobalMetaId(counterpartyGlobalMetaId),
    });
  }

  private assertNotSelfDirectedOrder(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): void {
    if (this.isSelfDirectedPair(localMetabotId, counterpartyGlobalMetaId)) {
      throw new ServiceOrderSelfOrderNotAllowedError();
    }
  }

  private normalizeGlobalMetaId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private mirrorRefundPendingToCounterparts(
    order: ServiceOrderRecord,
    refundRequestPinId: string | null,
    requestedAt: number
  ): ServiceOrderRecord[] {
    const counterparts = this.store
      .listOrdersByPaymentTxid(order.paymentTxid)
      .filter((candidate) => candidate.id !== order.id && candidate.role !== order.role);

    const mirroredOrders: ServiceOrderRecord[] = [];
    for (const counterpart of counterparts) {
      const updated = this.store.markRefundPending(
        counterpart.id,
        refundRequestPinId,
        requestedAt
      );
      if (updated) {
        mirroredOrders.push(updated);
      }
    }
    return mirroredOrders;
  }

  private async emitRefundRequestedEvents(orders: ServiceOrderRecord[]): Promise<void> {
    if (!this.onOrderEvent) return;
    for (const order of orders) {
      await this.onOrderEvent({
        type: 'refund_requested',
        order,
      });
    }
  }

  private async emitRefundResolvedEvents(orders: ServiceOrderRecord[]): Promise<void> {
    if (!this.onOrderEvent) return;
    for (const order of orders) {
      await this.onOrderEvent({
        type: 'refunded',
        order,
      });
    }
  }

  private isZeroAmount(value: string): boolean {
    const numeric = Number(String(value || '').trim());
    return Number.isFinite(numeric) && numeric === 0;
  }
}
