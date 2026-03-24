import {
  ServiceOrderStore,
  type ServiceOrderRecord,
} from '../serviceOrderStore';

export const SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE = 'open_order_exists';

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

  constructor(
    store: ServiceOrderStore,
    options: ServiceOrderLifecycleServiceOptions = {}
  ) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
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

  private getBuyerPairKey(
    localMetabotId: number,
    counterpartyGlobalMetaId: string
  ): string {
    return `${localMetabotId}:${counterpartyGlobalMetaId}`;
  }
}
