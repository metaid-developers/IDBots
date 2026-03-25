import {
  ServiceOrderStore,
  type ServiceOrderRecord,
} from '../serviceOrderStore';
import {
  buildRefundFinalizePayload,
  parseRefundRequestPayload,
} from './serviceOrderProtocols.js';

export interface RefundRequestPinDetail {
  pinId: string;
  content: unknown;
}

interface ProcessSellerRefundTransferInput {
  order: ServiceOrderRecord;
  refundRequestPinId: string;
  refundRequestPayload: Record<string, any>;
  refundToAddress: string;
  refundAmount: string;
  refundCurrency: string;
}

interface ServiceRefundSettlementServiceOptions {
  now?: () => number;
  fetchRefundRequestPin: (pinId: string) => Promise<RefundRequestPinDetail>;
  executeRefundTransfer: (
    input: ProcessSellerRefundTransferInput
  ) => Promise<{ txId?: string | null }>;
  createRefundFinalizePin: (input: {
    order: ServiceOrderRecord;
    payload: Record<string, unknown>;
    refundRequestPayload: Record<string, any>;
  }) => Promise<{ pinId?: string | null; txid?: string | null }>;
  resolveLocalMetabotGlobalMetaId?: (localMetabotId: number) => string | null | undefined;
  onOrderEvent?: (event: {
    type: 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;
}

export class ServiceRefundSettlementService {
  private store: ServiceOrderStore;
  private now: () => number;
  private fetchRefundRequestPin: (pinId: string) => Promise<RefundRequestPinDetail>;
  private executeRefundTransfer: (
    input: ProcessSellerRefundTransferInput
  ) => Promise<{ txId?: string | null }>;
  private createRefundFinalizePin: (input: {
    order: ServiceOrderRecord;
    payload: Record<string, unknown>;
    refundRequestPayload: Record<string, any>;
  }) => Promise<{ pinId?: string | null; txid?: string | null }>;
  private resolveLocalMetabotGlobalMetaId: (localMetabotId: number) => string | null | undefined;
  private onOrderEvent?: (event: {
    type: 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;

  constructor(
    store: ServiceOrderStore,
    options: ServiceRefundSettlementServiceOptions
  ) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.fetchRefundRequestPin = options.fetchRefundRequestPin;
    this.executeRefundTransfer = options.executeRefundTransfer;
    this.createRefundFinalizePin = options.createRefundFinalizePin;
    this.resolveLocalMetabotGlobalMetaId =
      options.resolveLocalMetabotGlobalMetaId ?? (() => null);
    this.onOrderEvent = options.onOrderEvent;
  }

  async processSellerRefundForSession(
    sessionId: string
  ): Promise<{
    order: ServiceOrderRecord;
    refundTxid: string;
    refundFinalizePinId: string;
  }> {
    const order = this.store.findLatestOrderBySessionId(sessionId);
    if (!order) {
      throw new Error('Refund order not found for this session');
    }
    if (order.role !== 'seller') {
      throw new Error('Only seller sessions can process manual refunds');
    }
    if (order.status === 'refunded') {
      throw new Error('Refund already completed for this order');
    }
    if (order.status !== 'refund_pending' || !order.refundRequestPinId) {
      throw new Error('No pending refund request found for this seller session');
    }

    const refundRequestPayload = await this.loadAndValidateRefundRequestPayload(order);
    const refundAmount = this.resolveRefundAmount(order, refundRequestPayload);
    const refundCurrency = this.resolveRefundCurrency(order, refundRequestPayload);
    const refundToAddress = String(refundRequestPayload.refundToAddress || '').trim();
    if (!refundToAddress) {
      throw new Error('Refund request is missing the refund destination address');
    }

    const refundTxid = await this.resolveRefundTxid(order, {
      order,
      refundRequestPinId: order.refundRequestPinId,
      refundRequestPayload,
      refundToAddress,
      refundAmount,
      refundCurrency,
    });
    const finalizePayload = buildRefundFinalizePayload({
      refundRequestPinId: order.refundRequestPinId,
      paymentTxid: order.paymentTxid,
      servicePinId: order.servicePinId,
      refundTxid,
      refundAmount,
      refundCurrency,
      buyerGlobalMetaId: refundRequestPayload.buyerGlobalMetaId,
      sellerGlobalMetaId: refundRequestPayload.sellerGlobalMetaId,
      comment: '',
    });
    const finalizeResult = await this.createRefundFinalizePin({
      order,
      payload: finalizePayload,
      refundRequestPayload,
    });
    const refundFinalizePinId = String(finalizeResult.pinId || finalizeResult.txid || '').trim();
    if (!refundFinalizePinId) {
      throw new Error('Refund finalize proof broadcast did not return a pin id');
    }

    const refundCompletedAt = this.now();
    const updatedOrders = this.store
      .listOrdersByPaymentTxid(order.paymentTxid)
      .map((candidate) => this.store.markRefunded(candidate.id, {
        refundTxid,
        refundFinalizePinId,
        refundCompletedAt,
      }))
      .filter(Boolean) as ServiceOrderRecord[];

    if (this.onOrderEvent) {
      for (const updatedOrder of updatedOrders) {
        await this.onOrderEvent({
          type: 'refunded',
          order: updatedOrder,
        });
      }
    }

    const sellerOrder = updatedOrders.find((candidate) => candidate.id === order.id)
      ?? this.store.getOrderById(order.id);
    if (!sellerOrder) {
      throw new Error('Failed to reload refunded seller order');
    }

    return {
      order: sellerOrder,
      refundTxid,
      refundFinalizePinId,
    };
  }

  private async loadAndValidateRefundRequestPayload(
    order: ServiceOrderRecord
  ): Promise<Record<string, any>> {
    const detail = await this.fetchRefundRequestPin(String(order.refundRequestPinId || ''));
    const payload = parseRefundRequestPayload(detail?.content);
    if (!payload) {
      throw new Error('Refund request proof payload is invalid');
    }
    if (String(payload.paymentTxid || '') !== order.paymentTxid) {
      throw new Error('Refund request payment txid does not match the local order');
    }
    if (
      order.servicePinId
      && payload.servicePinId
      && String(payload.servicePinId).trim() !== order.servicePinId
    ) {
      throw new Error('Refund request service pin does not match the local order');
    }
    if (
      order.counterpartyGlobalMetaid
      && payload.buyerGlobalMetaId
      && String(payload.buyerGlobalMetaId).trim() !== order.counterpartyGlobalMetaid
    ) {
      throw new Error('Refund request buyer identity does not match the local order');
    }

    const localSellerGlobalMetaId = this.resolveLocalMetabotGlobalMetaId(order.localMetabotId);
    if (
      localSellerGlobalMetaId
      && payload.sellerGlobalMetaId
      && String(payload.sellerGlobalMetaId).trim() !== localSellerGlobalMetaId.trim()
    ) {
      throw new Error('Refund request seller identity does not match this local MetaBot');
    }

    return payload;
  }

  private resolveRefundAmount(
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ): string {
    const raw = String(payload.refundAmount || '').trim();
    return raw || order.paymentAmount;
  }

  private resolveRefundCurrency(
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ): string {
    const raw = String(payload.refundCurrency || '').trim();
    return raw || order.paymentCurrency;
  }

  private async resolveRefundTxid(
    order: ServiceOrderRecord,
    input: ProcessSellerRefundTransferInput
  ): Promise<string> {
    const existing = String(order.refundTxid || '').trim();
    if (existing) {
      return existing;
    }

    const result = await this.executeRefundTransfer(input);
    const refundTxid = String(result.txId || '').trim();
    if (!refundTxid) {
      throw new Error('Refund transfer did not return a transaction id');
    }

    const recordedAt = this.now();
    for (const candidate of this.store.listOrdersByPaymentTxid(order.paymentTxid)) {
      this.store.recordRefundTransfer(candidate.id, {
        refundTxid,
        recordedAt,
      });
    }
    return refundTxid;
  }
}
