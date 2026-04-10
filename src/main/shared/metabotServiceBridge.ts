import path from 'node:path';

export interface SharedDelegationRequest {
  servicePinId: string;
  serviceName: string;
  providerGlobalMetaid: string;
  price: string;
  currency: string;
  userTask: string;
  taskContext: string;
  rawRequest: string;
}

export interface SharedRemoteServiceDescriptor {
  servicePinId?: string | null;
  pinId?: string | null;
  providerGlobalMetaId?: string | null;
  serviceName?: string | null;
  displayName?: string | null;
  description?: string | null;
  price?: string | null;
  currency?: string | null;
  ratingAvg?: number | null;
  ratingCount?: number | null;
}

export interface SharedManualRefundOrder {
  id: string;
  role: 'buyer' | 'seller';
  status: string;
  refundRequestPinId?: string | null;
  coworkSessionId?: string | null;
  paymentTxid?: string | null;
}

export type SharedManualRefundDecision =
  | {
      required: true;
      state: 'manual_action_required';
      code: 'manual_refund_required';
      message: string;
      ui: {
        kind: 'refund';
        orderId: string;
        sessionId: string | null;
        refundRequestPinId: string;
      };
    }
  | {
      required: false;
      state: 'not_required';
      code: 'refund_not_required';
      message: string;
    };

interface SharedRemoteCallModule {
  containsDelegationControlPrefix(content: string): boolean;
  getDelegationDisplayText(content: string): string;
  isExplicitMetaAppUserRequest(userText: string, appId?: string): boolean;
  normalizeDelegationPaymentTerms(rawPrice: unknown, rawCurrency: unknown): { price: string; currency: string };
  isDelegationPriceNumeric(value: string): boolean;
  parseDelegationMessage(content: string): SharedDelegationRequest | null;
  buildRemoteServicesPrompt(availableServices: SharedRemoteServiceDescriptor[]): string | null;
}

interface SharedOrderLifecycleModule {
  SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE: string;
  SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE: string;
  DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS: number;
  SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON: string;
  buildBuyerPaymentKey(
    localMetabotId: number,
    counterpartyGlobalMetaId: string,
    paymentTxid?: string | null
  ): string | null;
  isSelfDirectedPair(input: {
    localGlobalMetaId?: string | null;
    counterpartyGlobalMetaId?: string | null;
  }): boolean;
}

interface SharedManualRefundModule {
  resolveManualRefundDecision(order: SharedManualRefundOrder | null | undefined): SharedManualRefundDecision;
}

let cachedRemoteCallModule: SharedRemoteCallModule | null = null;
let cachedOrderLifecycleModule: SharedOrderLifecycleModule | null = null;
let cachedManualRefundModule: SharedManualRefundModule | null = null;

function resolveMetabotModulePath(relativePath: string): string {
  return path.resolve(__dirname, `../../metabot/dist/${relativePath}`);
}

function loadRemoteCallModule(): SharedRemoteCallModule {
  if (cachedRemoteCallModule) {
    return cachedRemoteCallModule;
  }
  cachedRemoteCallModule = require(resolveMetabotModulePath('core/delegation/remoteCall.js')) as SharedRemoteCallModule;
  return cachedRemoteCallModule;
}

function loadOrderLifecycleModule(): SharedOrderLifecycleModule {
  if (cachedOrderLifecycleModule) {
    return cachedOrderLifecycleModule;
  }
  cachedOrderLifecycleModule = require(resolveMetabotModulePath('core/orders/orderLifecycle.js')) as SharedOrderLifecycleModule;
  return cachedOrderLifecycleModule;
}

function loadManualRefundModule(): SharedManualRefundModule {
  if (cachedManualRefundModule) {
    return cachedManualRefundModule;
  }
  cachedManualRefundModule = require(resolveMetabotModulePath('core/orders/manualRefund.js')) as SharedManualRefundModule;
  return cachedManualRefundModule;
}

export const SHARED_SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE =
  loadOrderLifecycleModule().SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE;
export const SHARED_SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE =
  loadOrderLifecycleModule().SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE;
export const SHARED_DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS =
  loadOrderLifecycleModule().DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS;
export const SHARED_SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON =
  loadOrderLifecycleModule().SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON;

export function containsSharedDelegationControlPrefix(content: string): boolean {
  return loadRemoteCallModule().containsDelegationControlPrefix(content);
}

export function getSharedDelegationDisplayText(content: string): string {
  return loadRemoteCallModule().getDelegationDisplayText(content);
}

export function isSharedExplicitMetaAppUserRequest(userText: string, appId?: string): boolean {
  return loadRemoteCallModule().isExplicitMetaAppUserRequest(userText, appId);
}

export function normalizeSharedDelegationPaymentTerms(
  rawPrice: unknown,
  rawCurrency: unknown,
): { price: string; currency: string } {
  return loadRemoteCallModule().normalizeDelegationPaymentTerms(rawPrice, rawCurrency);
}

export function isSharedDelegationPriceNumeric(value: string): boolean {
  return loadRemoteCallModule().isDelegationPriceNumeric(value);
}

export function parseSharedDelegationMessage(content: string): SharedDelegationRequest | null {
  return loadRemoteCallModule().parseDelegationMessage(content);
}

export function buildSharedRemoteServicesPrompt(
  availableServices: SharedRemoteServiceDescriptor[]
): string | null {
  return loadRemoteCallModule().buildRemoteServicesPrompt(availableServices);
}

export function buildSharedBuyerPaymentKey(
  localMetabotId: number,
  counterpartyGlobalMetaId: string,
  paymentTxid?: string | null
): string | null {
  return loadOrderLifecycleModule().buildBuyerPaymentKey(
    localMetabotId,
    counterpartyGlobalMetaId,
    paymentTxid
  );
}

export function isSharedSelfDirectedPair(input: {
  localGlobalMetaId?: string | null;
  counterpartyGlobalMetaId?: string | null;
}): boolean {
  return loadOrderLifecycleModule().isSelfDirectedPair(input);
}

export function resolveSharedManualRefundDecision(
  order: SharedManualRefundOrder | null | undefined
): SharedManualRefundDecision {
  return loadManualRefundModule().resolveManualRefundDecision(order);
}
