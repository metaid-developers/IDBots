import type {
  CreateBuyerOrderInput,
  CreateSellerOrderInput,
  MarkBuyerOrderDeliveredInput,
  MarkBuyerOrderFirstResponseReceivedInput,
  MarkSellerOrderDeliveredInput,
  MarkSellerOrderFirstResponseSentInput,
  ServiceOrderLifecycleService,
} from '../services/serviceOrderLifecycleService';

export interface RequestTraceRuntime {
  createBuyerOrder(input: CreateBuyerOrderInput): unknown;
  createSellerOrder(input: CreateSellerOrderInput): unknown;
  markBuyerOrderFirstResponseReceived(input: MarkBuyerOrderFirstResponseReceivedInput): unknown;
  markSellerOrderFirstResponseSent(input: MarkSellerOrderFirstResponseSentInput): unknown;
  markBuyerDelivered(input: MarkBuyerOrderDeliveredInput): unknown;
  markBuyerOrderDelivered(input: MarkBuyerOrderDeliveredInput): unknown;
  markSellerDelivered(input: MarkSellerOrderDeliveredInput): unknown;
  markSellerOrderDelivered(input: MarkSellerOrderDeliveredInput): unknown;
}

type ServiceOrderLifecycleTrace = Pick<
  ServiceOrderLifecycleService,
  | 'createBuyerOrder'
  | 'createSellerOrder'
  | 'markBuyerOrderFirstResponseReceived'
  | 'markSellerOrderFirstResponseSent'
  | 'markBuyerOrderDelivered'
  | 'markSellerOrderDelivered'
>;

export function createRequestTraceRuntime(
  lifecycle?: ServiceOrderLifecycleTrace | null,
): RequestTraceRuntime {
  return {
    createBuyerOrder(input) {
      return lifecycle?.createBuyerOrder(input) ?? null;
    },
    createSellerOrder(input) {
      return lifecycle?.createSellerOrder(input) ?? null;
    },
    markBuyerOrderFirstResponseReceived(input) {
      return lifecycle?.markBuyerOrderFirstResponseReceived(input) ?? null;
    },
    markSellerOrderFirstResponseSent(input) {
      return lifecycle?.markSellerOrderFirstResponseSent(input) ?? null;
    },
    markBuyerDelivered(input) {
      return lifecycle?.markBuyerOrderDelivered(input) ?? null;
    },
    markBuyerOrderDelivered(input) {
      return lifecycle?.markBuyerOrderDelivered(input) ?? null;
    },
    markSellerDelivered(input) {
      return lifecycle?.markSellerOrderDelivered(input) ?? null;
    },
    markSellerOrderDelivered(input) {
      return lifecycle?.markSellerOrderDelivered(input) ?? null;
    },
  };
}
