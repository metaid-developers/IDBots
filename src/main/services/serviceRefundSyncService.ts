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
import {
  verifyMrc20Transfer,
  type VerifyMrc20PaymentInput,
  type VerifyMrc20PaymentResult,
} from './mrc20PaymentVerification';
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
  resolveLocalMetabotIdByGlobalMetaId?: (globalMetaId: string) => number | null | undefined;
  resolveLocalMetabotIdByServicePinId?: (servicePinId: string) => number | null | undefined;
  buildRefundVerificationInput?: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => VerifyTransferInput;
  verifyTransferToRecipient?: (
    input: VerifyTransferInput
  ) => Promise<VerifyTransferResult>;
  resolveRefundMrc20RecipientAddress?: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => string;
  verifyMrc20Transfer?: (
    input: VerifyMrc20PaymentInput
  ) => Promise<VerifyMrc20PaymentResult>;
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
  private resolveLocalMetabotIdByGlobalMetaId: (globalMetaId: string) => number | null | undefined;
  private resolveLocalMetabotIdByServicePinId: (servicePinId: string) => number | null | undefined;
  private buildRefundVerificationInput: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => VerifyTransferInput;
  private verifyTransferToRecipient: (
    input: VerifyTransferInput
  ) => Promise<VerifyTransferResult>;
  private resolveRefundMrc20RecipientAddress: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => string;
  private verifyMrc20Transfer: (
    input: VerifyMrc20PaymentInput
  ) => Promise<VerifyMrc20PaymentResult>;
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
    this.resolveLocalMetabotIdByGlobalMetaId =
      options.resolveLocalMetabotIdByGlobalMetaId ?? (() => null);
    this.resolveLocalMetabotIdByServicePinId =
      options.resolveLocalMetabotIdByServicePinId ?? (() => null);
    this.buildRefundVerificationInput =
      options.buildRefundVerificationInput ?? ((order, payload) => this.buildDefaultVerificationInput(order, payload));
    this.verifyTransferToRecipient =
      options.verifyTransferToRecipient ?? verifyTransferToRecipient;
    this.resolveRefundMrc20RecipientAddress =
      options.resolveRefundMrc20RecipientAddress ?? (() => '');
    this.verifyMrc20Transfer =
      options.verifyMrc20Transfer ?? verifyMrc20Transfer;
    this.onOrderEvent = options.onOrderEvent;
  }

  async syncRequestPins(): Promise<void> {
    const pins = await this.fetchRefundRequestPins();
    for (const pin of pins) {
      const payload = parseRefundRequestPayload(pin.content);
      if (!payload) continue;

      const ordersByPaymentTxid = this.store
        .listOrdersByPaymentTxid(String(payload.paymentTxid || ''));
      let matchingOrders = ordersByPaymentTxid
        .filter((order) => this.matchesRefundRequestPayload(order, payload))
        .filter((order) => this.shouldApplyRefundRequest(order, pin.pinId));
      if (matchingOrders.length === 0) {
        const fallbackExistingSellerOrder = this.selectFallbackSellerOrderForRefundRequest(
          ordersByPaymentTxid,
          payload,
          pin.pinId
        );
        if (fallbackExistingSellerOrder) {
          matchingOrders = [fallbackExistingSellerOrder];
        }
      }
      if (matchingOrders.length === 0) {
        const synthesized = this.synthesizeSellerOrderForRefundRequest(payload);
        if (synthesized && this.shouldApplyRefundRequest(synthesized, pin.pinId)) {
          matchingOrders = [synthesized];
        }
      }
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

      if (this.shouldUseMrc20Verifier(verificationOrder, payload)) {
        const input = this.buildMrc20RefundVerificationInput(verificationOrder, payload);
        const verification = await this.verifyMrc20Transfer(input);
        if (!verification.valid) continue;
      } else {
        const verification = await this.verifyTransferToRecipient(
          this.buildRefundVerificationInput(verificationOrder, payload)
        );
        if (!verification.valid) continue;
      }

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

  private shouldUseMrc20Verifier(
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ): boolean {
    const refundCurrency = String(payload.refundCurrency ?? '').trim().toUpperCase();
    if (refundCurrency.endsWith('-MRC20')) return true;
    return order.settlementKind === 'mrc20';
  }

  private buildMrc20RefundVerificationInput(
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ): VerifyMrc20PaymentInput {
    const mrc20Id = String(payload.mrc20Id ?? order.mrc20Id ?? '').trim();
    const mrc20Ticker = String(payload.mrc20Ticker ?? order.mrc20Ticker ?? '').trim();
    const expectedAmountDisplay = String(payload.refundAmount ?? order.paymentAmount ?? '').trim();
    const recipientAddress = String(this.resolveRefundMrc20RecipientAddress(order, payload) ?? '').trim();

    return {
      txid: String(payload.refundTxid ?? '').trim(),
      recipientAddress,
      expectedAmountDisplay,
      mrc20Id,
      mrc20Ticker,
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

  private selectFallbackSellerOrderForRefundRequest(
    ordersByPaymentTxid: ServiceOrderRecord[],
    payload: Record<string, any>,
    refundRequestPinId: string
  ): ServiceOrderRecord | null {
    const sellerCandidates = ordersByPaymentTxid
      .filter((order) => order.role === 'seller')
      .filter((order) => this.shouldApplyRefundRequest(order, refundRequestPinId));
    if (sellerCandidates.length === 0) {
      return null;
    }

    if (sellerCandidates.length === 1) {
      return sellerCandidates[0];
    }

    const expectedBuyerGlobalMetaId = String(payload.buyerGlobalMetaId || '').trim();
    const expectedSellerGlobalMetaId = String(payload.sellerGlobalMetaId || '').trim();
    const expectedServicePinId = String(payload.servicePinId || '').trim();
    const scored = sellerCandidates
      .map((order) => {
        let score = 0;
        if (expectedServicePinId && order.servicePinId === expectedServicePinId) {
          score += 4;
        }
        if (
          expectedBuyerGlobalMetaId
          && order.counterpartyGlobalMetaid === expectedBuyerGlobalMetaId
        ) {
          score += 2;
        }
        const localGlobalMetaId = this.resolveLocalMetabotGlobalMetaId(order.localMetabotId)?.trim() || '';
        if (
          expectedSellerGlobalMetaId
          && localGlobalMetaId
          && localGlobalMetaId === expectedSellerGlobalMetaId
        ) {
          score += 2;
        }
        return { order, score };
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.order.updatedAt - left.order.updatedAt;
      });

    const best = scored[0];
    const second = scored[1];
    if (!best) {
      return null;
    }
    if (best.score === 0) {
      return null;
    }
    if (second && second.score === best.score) {
      return null;
    }
    return best.order;
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

  private synthesizeSellerOrderForRefundRequest(
    payload: Record<string, any>
  ): ServiceOrderRecord | null {
    const sellerGlobalMetaId = String(payload.sellerGlobalMetaId || '').trim();
    const buyerGlobalMetaId = String(payload.buyerGlobalMetaId || '').trim();
    const paymentTxid = String(payload.paymentTxid || '').trim();
    const servicePinId = String(payload.servicePinId || '').trim() || null;
    if (!sellerGlobalMetaId || !buyerGlobalMetaId || !paymentTxid) {
      return null;
    }

    const localMetabotId = this.resolveLocalMetabotIdForRefundRequest(
      sellerGlobalMetaId,
      servicePinId
    );
    if (typeof localMetabotId !== 'number' || !Number.isFinite(localMetabotId)) {
      return null;
    }

    const paymentChain = this.resolvePaymentChainFromRefundPayload(payload);
    const paymentAmount = String(payload.refundAmount || '').trim() || '0';
    const serviceName = String(payload.serviceName || '').trim() || 'Service Order';
    const orderMessagePinId = String(payload.orderMessagePinId || '').trim() || null;

    return this.store.createOrder({
      role: 'seller',
      localMetabotId,
      counterpartyGlobalMetaid: buyerGlobalMetaId,
      servicePinId,
      serviceName,
      paymentTxid,
      paymentChain,
      paymentAmount,
      paymentCurrency: String(payload.refundCurrency || '').trim() || undefined,
      settlementKind: String(payload.settlementKind || '').trim() || undefined,
      mrc20Ticker: String(payload.mrc20Ticker || '').trim() || undefined,
      mrc20Id: String(payload.mrc20Id || '').trim() || undefined,
      paymentCommitTxid: String(payload.paymentCommitTxid || '').trim() || undefined,
      orderMessagePinId,
      status: 'failed',
      now: this.resolveFailureDetectedAt(payload) ?? this.resolveRefundRequestedAt({ pinId: '', content: payload }, payload),
    });
  }

  private resolveLocalMetabotIdForRefundRequest(
    sellerGlobalMetaId: string,
    servicePinId: string | null
  ): number | null {
    const byGlobalMetaId = this.resolveLocalMetabotIdByGlobalMetaId(sellerGlobalMetaId);
    if (typeof byGlobalMetaId === 'number' && Number.isFinite(byGlobalMetaId)) {
      return byGlobalMetaId;
    }

    if (servicePinId) {
      const byServicePinId = this.resolveLocalMetabotIdByServicePinId(servicePinId);
      if (typeof byServicePinId === 'number' && Number.isFinite(byServicePinId)) {
        return byServicePinId;
      }
    }

    return null;
  }

  private resolvePaymentChainFromRefundPayload(payload: Record<string, any>): string {
    const explicitChain = String(payload.paymentChain || '').trim().toLowerCase();
    if (explicitChain === 'btc' || explicitChain === 'doge' || explicitChain === 'mvc') {
      return explicitChain;
    }

    const settlementKind = String(payload.settlementKind || '').trim().toLowerCase();
    const normalized = String(payload.refundCurrency || '').trim().toUpperCase();
    if (settlementKind === 'mrc20' || normalized.endsWith('-MRC20')) return 'btc';
    if (normalized === 'BTC') return 'btc';
    if (normalized === 'DOGE') return 'doge';
    return 'mvc';
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
