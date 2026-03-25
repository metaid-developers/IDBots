import {
  ServiceOrderStore,
  type ServiceOrderRecord,
} from '../serviceOrderStore';
import {
  parseRefundFinalizePayload,
} from './serviceOrderProtocols.js';
import {
  verifyTransferToRecipient,
  type TransferChain,
  type VerifyTransferInput,
  type VerifyTransferResult,
} from './txTransferVerification';

export interface RefundFinalizePinRecord {
  pinId: string;
  content: unknown;
}

interface ServiceRefundSyncServiceOptions {
  now?: () => number;
  fetchRefundFinalizePins?: () => Promise<RefundFinalizePinRecord[]>;
  buildRefundVerificationInput?: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => VerifyTransferInput;
  verifyTransferToRecipient?: (
    input: VerifyTransferInput
  ) => Promise<VerifyTransferResult>;
}

export class ServiceRefundSyncService {
  private store: ServiceOrderStore;
  private now: () => number;
  private fetchRefundFinalizePins: () => Promise<RefundFinalizePinRecord[]>;
  private buildRefundVerificationInput: (
    order: ServiceOrderRecord,
    payload: Record<string, any>
  ) => VerifyTransferInput;
  private verifyTransferToRecipient: (
    input: VerifyTransferInput
  ) => Promise<VerifyTransferResult>;

  constructor(
    store: ServiceOrderStore,
    options: ServiceRefundSyncServiceOptions = {}
  ) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.fetchRefundFinalizePins = options.fetchRefundFinalizePins ?? (async () => []);
    this.buildRefundVerificationInput =
      options.buildRefundVerificationInput ?? ((order, payload) => this.buildDefaultVerificationInput(order, payload));
    this.verifyTransferToRecipient =
      options.verifyTransferToRecipient ?? verifyTransferToRecipient;
  }

  async syncFinalizePins(): Promise<void> {
    const pins = await this.fetchRefundFinalizePins();
    for (const pin of pins) {
      const payload = parseRefundFinalizePayload(pin.content);
      if (!payload) continue;

      const order = this.store.findByRefundRequestPinId(payload.refundRequestPinId);
      if (!order) continue;
      if (order.status === 'refunded' || order.refundFinalizePinId === pin.pinId) continue;
      if (payload.paymentTxid !== order.paymentTxid) continue;
      if (order.servicePinId && payload.servicePinId && payload.servicePinId !== order.servicePinId) continue;

      const verification = await this.verifyTransferToRecipient(
        this.buildRefundVerificationInput(order, payload)
      );
      if (!verification.valid) continue;

      this.store.markRefunded(order.id, {
        refundTxid: payload.refundTxid,
        refundFinalizePinId: pin.pinId,
        refundCompletedAt: this.now(),
      });
    }
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
}
