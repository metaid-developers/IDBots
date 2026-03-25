import {
  ServiceOrderStore,
  type ServiceOrderRecord,
} from '../serviceOrderStore';
import { getTimedOutOrderTransition } from './serviceOrderState';
import { buildRefundRequestPayload } from './serviceOrderProtocols.js';

export const SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE = 'open_order_exists';
export const DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS = 60_000;

export interface CreateBuyerOrderInput {
  localMetabotId: number;
  counterpartyGlobalMetaId: string;
  servicePinId?: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentChain?: string;
  paymentAmount: string;
  paymentCurrency?: string;
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

interface ServiceOrderLifecycleServiceOptions {
  now?: () => number;
  buildRefundRequestPayload?: (order: ServiceOrderRecord) => Record<string, unknown>;
  createRefundRequestPin?: (input: {
    order: ServiceOrderRecord;
    payload: Record<string, unknown>;
  }) => Promise<{ pinId?: string | null; txid?: string | null }>;
  refundRequestRetryDelayMs?: number;
  onOrderEvent?: (event: {
    type: 'refund_requested';
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

export class ServiceOrderLifecycleService {
  private store: ServiceOrderStore;
  private now: () => number;
  private pendingBuyerOrderPairs = new Set<string>();
  private buildRefundRequestPayload: (order: ServiceOrderRecord) => Record<string, unknown>;
  private createRefundRequestPin?: (input: {
    order: ServiceOrderRecord;
    payload: Record<string, unknown>;
  }) => Promise<{ pinId?: string | null; txid?: string | null }>;
  private refundRequestRetryDelayMs: number;
  private onOrderEvent?: (event: {
    type: 'refund_requested';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;

  constructor(
    store: ServiceOrderStore,
    options: ServiceOrderLifecycleServiceOptions = {}
  ) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.buildRefundRequestPayload =
      options.buildRefundRequestPayload ?? ((order) => this.buildDefaultRefundRequestPayload(order));
    this.createRefundRequestPin = options.createRefundRequestPin;
    this.refundRequestRetryDelayMs =
      options.refundRequestRetryDelayMs ?? DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS;
    this.onOrderEvent = options.onOrderEvent;
  }

  assertNoOpenBuyerOrderForPair(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): void {
    if (this.pendingBuyerOrderPairs.has(this.getBuyerPairKey(localMetabotId, counterpartyGlobalMetaId))) {
      throw new ServiceOrderOpenOrderExistsError(`pending:${localMetabotId}:${counterpartyGlobalMetaId}`);
    }
    this.assertNoPersistedOpenBuyerOrderForPair(
      localMetabotId,
      counterpartyGlobalMetaId
    );
  }

  getBuyerOrderAvailability(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): { allowed: true } | { allowed: false; errorCode: string; error: string } {
    try {
      this.assertNoOpenBuyerOrderForPair(localMetabotId, counterpartyGlobalMetaId);
      return { allowed: true };
    } catch (error) {
      if (error instanceof ServiceOrderOpenOrderExistsError) {
        return {
          allowed: false,
          errorCode: error.code,
          error: error.message,
        };
      }
      throw error;
    }
  }

  private assertNoPersistedOpenBuyerOrderForPair(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): void {
    const existing = this.store.findLatestOpenOrderForPair(
      'buyer',
      localMetabotId,
      counterpartyGlobalMetaId
    );
    if (existing) {
      throw new ServiceOrderOpenOrderExistsError(existing.id);
    }
  }

  reserveBuyerOrderCreation(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): () => void {
    this.assertNoOpenBuyerOrderForPair(localMetabotId, counterpartyGlobalMetaId);
    const pairKey = this.getBuyerPairKey(localMetabotId, counterpartyGlobalMetaId);
    this.pendingBuyerOrderPairs.add(pairKey);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingBuyerOrderPairs.delete(pairKey);
    };
  }

  createBuyerOrder(input: CreateBuyerOrderInput): ServiceOrderRecord {
    this.assertNoPersistedOpenBuyerOrderForPair(
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
      coworkSessionId: input.coworkSessionId ?? null,
      orderMessagePinId: input.orderMessagePinId ?? null,
      status: 'awaiting_first_response',
      now: this.now(),
    });
  }

  createSellerOrder(input: CreateSellerOrderInput): ServiceOrderRecord {
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

  async scanTimedOutOrders(): Promise<void> {
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

  async tryCreateRefundRequest(
    orderId: string,
    attemptedAt: number = this.now()
  ): Promise<ServiceOrderRecord | null> {
    const order = this.store.getOrderById(orderId);
    if (!order || order.role !== 'buyer') return order;
    if (order.status === 'refund_pending' || order.status === 'refunded' || order.refundRequestPinId) {
      return order;
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

  private getBuyerPairKey(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): string {
    return `${localMetabotId}:${counterpartyGlobalMetaId}`;
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
}
