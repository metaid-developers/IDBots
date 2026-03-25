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
  onOrderEvent?: (event: {
    type: 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;
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
  private onOrderEvent?: (event: {
    type: 'refunded';
    order: ServiceOrderRecord;
  }) => void | Promise<void>;

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
    this.onOrderEvent = options.onOrderEvent;
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
