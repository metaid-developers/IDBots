import {
  ServiceOrderStore,
  type ServiceOrderRecord,
} from '../serviceOrderStore';
import {
  parseRefundRequestPayload,
  parseRefundFinalizePayload,
} from './serviceOrderProtocols.js';
import {
  verifyTransferToRecipient,
  type TransferChain,
  type VerifyTransferInput,
  type VerifyTransferResult,
} from './txTransferVerification';
import { shouldHideProviderForUnresolvedRefund } from './serviceOrderState';

export interface RefundFinalizePinRecord {
  pinId: string;
  content: unknown;
  timestampMs?: number | null;
}

export interface RefundRequestPinRecord {
  pinId: string;
  content: unknown;
  timestampMs?: number | null;
}

export interface ProviderRefundRiskSummary {
  providerGlobalMetaId: string;
  hasUnresolvedRefund: true;
  unresolvedRefundAgeHours: number;
  hidden: boolean;
}

interface ServiceRefundSyncServiceOptions {
  now?: () => number;
  fetchRefundRequestPins?: () => Promise<RefundRequestPinRecord[]>;
  fetchRefundFinalizePins?: () => Promise<RefundFinalizePinRecord[]>;
  resolveLocalMetabotGlobalMetaId?: (localMetabotId: number) => string | null | undefined;
  buildRefundVerificationInput?: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => VerifyTransferInput;
  verifyTransferToRecipient?: (
    input: VerifyTransferInput
  ) => Promise<VerifyTransferResult>;
  onOrderEvent?: (event: {
    type: 'refund_requested' | 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;
}

export class ServiceRefundSyncService {
  private store: ServiceOrderStore;
  private now: () => number;
  private fetchRefundRequestPins: () => Promise<RefundRequestPinRecord[]>;
  private fetchRefundFinalizePins: () => Promise<RefundFinalizePinRecord[]>;
  private resolveLocalMetabotGlobalMetaId: (localMetabotId: number) => string | null | undefined;
  private buildRefundVerificationInput: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => VerifyTransferInput;
  private verifyTransferToRecipient: (
    input: VerifyTransferInput
  ) => Promise<VerifyTransferResult>;
  private onOrderEvent?: (event: {
    type: 'refund_requested' | 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;

  constructor(
    store: ServiceOrderStore,
    options: ServiceRefundSyncServiceOptions = {}
  ) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.fetchRefundRequestPins = options.fetchRefundRequestPins ?? (async () => []);
    this.fetchRefundFinalizePins = options.fetchRefundFinalizePins ?? (async () => []);
    this.resolveLocalMetabotGlobalMetaId =
      options.resolveLocalMetabotGlobalMetaId ?? (() => null);
    this.buildRefundVerificationInput =
      options.buildRefundVerificationInput ?? ((order, payload) => this.buildDefaultVerificationInput(order, payload));
    this.verifyTransferToRecipient =
      options.verifyTransferToRecipient ?? verifyTransferToRecipient;
    this.onOrderEvent = options.onOrderEvent;
  }

  async syncRequestPins(): Promise<void> {
    const pins = await this.fetchRefundRequestPins();
    for (const pin of pins) {
      const payload = parseRefundRequestPayload(pin.content);
      if (!payload) continue;

      const matchingOrders = this.store
        .listOrdersByPaymentTxid(String(payload.paymentTxid || ''))
        .filter((order) => this.matchesRefundRequestPayload(order, payload))
        .filter((order) => this.shouldApplyRefundRequest(order, pin.pinId));
      if (matchingOrders.length === 0) continue;

      const requestedAt = this.resolveRefundRequestedAt(pin, payload);
      const failedAt = this.resolveFailureDetectedAt(payload) ?? requestedAt;
      const failureReason = this.resolveFailureReason(payload);
      const updatedOrders: ServiceOrderRecord[] = [];

      for (const order of matchingOrders) {
        const failedOrder = this.store.markFailed(order.id, failureReason, failedAt) ?? order;
        const updated = this.store.markRefundPending(
          failedOrder.id,
          pin.pinId,
          requestedAt
        );
        if (updated) {
          updatedOrders.push(updated);
        }
      }

      if (this.onOrderEvent) {
        for (const order of updatedOrders) {
          await this.onOrderEvent({
            type: 'refund_requested',
            order,
          });
        }
      }
    }
  }

  async syncFinalizePins(): Promise<void> {
    const pins = await this.fetchRefundFinalizePins();
    for (const pin of pins) {
      const payload = parseRefundFinalizePayload(pin.content);
      if (!payload) continue;

      const matchingOrders = this.store.listByRefundRequestPinId(payload.refundRequestPinId);
      if (matchingOrders.length === 0) continue;

      const verificationOrder = matchingOrders.find((order) => order.role === 'buyer') ?? matchingOrders[0];
      if (verificationOrder.status === 'refunded' || verificationOrder.refundFinalizePinId === pin.pinId) {
        continue;
      }
      if (payload.paymentTxid !== verificationOrder.paymentTxid) continue;
      if (
        verificationOrder.servicePinId
        && payload.servicePinId
        && payload.servicePinId !== verificationOrder.servicePinId
      ) {
        continue;
      }

      const verification = await this.verifyTransferToRecipient(
        this.buildRefundVerificationInput(verificationOrder, payload)
      );
      if (!verification.valid) continue;

      const refundCompletedAt = this.now();
      const updatedOrders: ServiceOrderRecord[] = [];
      for (const order of matchingOrders) {
        const updated = this.store.markRefunded(order.id, {
          refundTxid: payload.refundTxid,
          refundFinalizePinId: pin.pinId,
          refundCompletedAt,
        });
        if (updated) {
          updatedOrders.push(updated);
        }
      }

      if (this.onOrderEvent) {
        for (const order of updatedOrders) {
          await this.onOrderEvent({
            type: 'refunded',
            order,
          });
        }
      }
    }
  }

  listProviderRefundRiskSummaries(): ProviderRefundRiskSummary[] {
    const now = this.now();
    const oldestRefundByProvider = new Map<string, number>();
    const unresolvedOrders = [
      ...this.store.listOrdersByStatuses('buyer', ['refund_pending']),
      ...this.store.listOrdersByStatuses('seller', ['refund_pending']),
    ];

    for (const order of unresolvedOrders) {
      if (order.refundCompletedAt != null || order.refundRequestedAt == null) {
        continue;
      }

      const providerGlobalMetaId = this.resolveProviderGlobalMetaId(order);
      if (!providerGlobalMetaId) continue;

      const existing = oldestRefundByProvider.get(providerGlobalMetaId);
      if (existing == null || order.refundRequestedAt < existing) {
        oldestRefundByProvider.set(providerGlobalMetaId, order.refundRequestedAt);
      }
    }

    return Array.from(oldestRefundByProvider.entries())
      .map(([providerGlobalMetaId, oldestRefundRequestedAt]) => ({
        providerGlobalMetaId,
        hasUnresolvedRefund: true as const,
        unresolvedRefundAgeHours: Math.max(
          0,
          Math.floor((now - oldestRefundRequestedAt) / (60 * 60_000))
        ),
        hidden: shouldHideProviderForUnresolvedRefund({
          refundRequestedAt: oldestRefundRequestedAt,
          refundCompletedAt: null,
        }, now),
      }))
      .sort((a, b) => a.providerGlobalMetaId.localeCompare(b.providerGlobalMetaId));
  }

  private buildDefaultVerificationInput(
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ): VerifyTransferInput {
    return {
      chain: order.paymentChain as TransferChain,
      txid: payload.refundTxid,
      recipientAddress: '',
      expectedAmountSats: Math.floor(Number(order.paymentAmount) * 100_000_000),
    };
  }

  private matchesRefundRequestPayload(
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ): boolean {
    if (String(payload.paymentTxid || '') !== order.paymentTxid) {
      return false;
    }

    if (
      order.servicePinId
      && payload.servicePinId
      && String(payload.servicePinId) !== order.servicePinId
    ) {
      return false;
    }

    const localGlobalMetaId = this.resolveLocalMetabotGlobalMetaId(order.localMetabotId)?.trim() || '';
    if (order.role === 'buyer') {
      if (
        order.counterpartyGlobalMetaid
        && payload.sellerGlobalMetaId
        && String(payload.sellerGlobalMetaId).trim() !== order.counterpartyGlobalMetaid
      ) {
        return false;
      }
      if (
        localGlobalMetaId
        && payload.buyerGlobalMetaId
        && String(payload.buyerGlobalMetaId).trim() !== localGlobalMetaId
      ) {
        return false;
      }
      return true;
    }

    if (
      order.counterpartyGlobalMetaid
      && payload.buyerGlobalMetaId
      && String(payload.buyerGlobalMetaId).trim() !== order.counterpartyGlobalMetaid
    ) {
      return false;
    }
    if (
      localGlobalMetaId
      && payload.sellerGlobalMetaId
      && String(payload.sellerGlobalMetaId).trim() !== localGlobalMetaId
    ) {
      return false;
    }
    return true;
  }

  private shouldApplyRefundRequest(
    order: ServiceOrderRecord,
    refundRequestPinId: string
  ): boolean {
    if (order.status === 'completed' || order.status === 'refunded') {
      return false;
    }
    if (order.refundRequestPinId === refundRequestPinId) {
      return false;
    }
    if (order.status === 'refund_pending' && order.refundRequestPinId) {
      return false;
    }
    return true;
  }

  private resolveRefundRequestedAt(
    pin: RefundRequestPinRecord,
    payload: Record<string, any>
  ): number {
    return pin.timestampMs
      ?? this.resolveFailureDetectedAt(payload)
      ?? this.now();
  }

  private resolveFailureDetectedAt(payload: Record<string, any>): number | null {
    const raw = payload.failureDetectedAt;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw >= 1_000_000_000_000 ? Math.floor(raw) : Math.floor(raw * 1000);
    }
    if (typeof raw === 'string' && raw.trim()) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) {
        return numeric >= 1_000_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
      }
    }
    return null;
  }

  private resolveFailureReason(payload: Record<string, any>): string {
    const failureReason = String(payload.failureReason || '').trim();
    return failureReason || 'delivery_timeout';
  }

  private resolveProviderGlobalMetaId(order: ServiceOrderRecord): string | null {
    if (order.role === 'buyer') {
      return order.counterpartyGlobalMetaid || null;
    }
    const globalMetaId = this.resolveLocalMetabotGlobalMetaId(order.localMetabotId);
    return typeof globalMetaId === 'string' && globalMetaId.trim()
      ? globalMetaId.trim()
      : null;
  }
}
