/**
 * Mobile ME purchase submission (S9 §5).
 *
 * Extracted from MePurchaseScreen's submit() so both branches are unit-testable
 * without a DOM. Subscribe goes to /v1/me/subscription/order with the planId,
 * period and channel=mobile; topup keeps the package channel. Before this split
 * the screen sent a planId to submitTopupOrder, which the backend reads as a
 * packageId — a free tier could never open a subscription.
 */

import type { MePeriod } from './mePointsStore';

export type MePurchaseSubmitSection = 'subscribe' | 'topup';

export interface MeSubscriptionOrderInput {
  planId: string;
  period: MePeriod;
  channel: 'mobile';
  voucherUrl?: string;
  voucherRemark?: string;
  idempotencyKey: string;
}

export interface MeTopupOrderInput {
  packageId: string;
  periodDays?: number;
  voucherUrl?: string;
  voucherRemark?: string;
  idempotencyKey: string;
}

export type MePurchaseOrderRequest =
  | { kind: 'subscribe'; input: MeSubscriptionOrderInput }
  | { kind: 'topup'; input: MeTopupOrderInput };

export interface MePurchaseOrderResponse {
  success: boolean;
  error?: string;
  errorCode?: string;
  featureUnavailable?: boolean;
}

export interface MeSubscriptionOrderResponse extends MePurchaseOrderResponse {
  subscriptionOrder?: { orderId: string; payAmount?: number };
}

export interface MeTopupOrderResponse extends MePurchaseOrderResponse {
  submission?: { order?: { orderId: string; payAmount?: number } };
}

/** The two IPC methods the screen drives (structurally satisfied by window.electron.mePoints). */
export interface MePurchaseSubmitApi {
  submitSubscriptionOrder: (input: MeSubscriptionOrderInput) => Promise<MeSubscriptionOrderResponse>;
  submitTopupOrder: (input: MeTopupOrderInput) => Promise<MeTopupOrderResponse>;
}

export interface MePurchaseSubmitResult {
  ok: boolean;
  orderId: string;
  /**
   * The server-priced amount (CNY) when the order response carries one — the
   * screen prefers it over the locally computed tag so the displayed amount
   * can never drift from the charged amount.
   */
  payAmount?: number;
  error?: string;
  errorCode?: string;
}

/**
 * Pick the subject (planId vs packageId) the current section may submit and
 * assemble the matching IPC request. Returns null when no subject is selected,
 * which is the screen's existing early return.
 */
export function buildMePurchaseOrderRequest(args: {
  section: MePurchaseSubmitSection;
  planId?: string | null;
  packageId?: string | null;
  period: MePeriod;
  periodDays?: number;
  voucherUrl?: string;
  voucherRemark?: string;
  now?: number;
}): MePurchaseOrderRequest | null {
  const subjectId = args.section === 'subscribe' ? args.planId : args.packageId;
  if (!subjectId) return null;
  const common = {
    voucherUrl: args.voucherUrl,
    voucherRemark: args.voucherRemark,
    idempotencyKey: `mobile-${args.section}-${subjectId}-${args.now ?? Date.now()}`,
  };
  if (args.section === 'subscribe') {
    return {
      kind: 'subscribe',
      input: { planId: subjectId, period: args.period, channel: 'mobile', ...common },
    };
  }
  return { kind: 'topup', input: { packageId: subjectId, periodDays: args.periodDays, ...common } };
}

/**
 * Exactly one IPC call per submission and no retry: a 404 (endpoint absent,
 * featureUnavailable) must surface as-is, never be replayed into a duplicate order.
 */
export async function submitMePurchaseOrder(
  api: MePurchaseSubmitApi,
  request: MePurchaseOrderRequest,
): Promise<MePurchaseSubmitResult> {
  if (request.kind === 'subscribe') {
    const res = await api.submitSubscriptionOrder(request.input);
    return res.success
      ? {
          ok: true,
          orderId: res.subscriptionOrder?.orderId ?? '',
          ...(typeof res.subscriptionOrder?.payAmount === 'number' && Number.isFinite(res.subscriptionOrder.payAmount)
            ? { payAmount: res.subscriptionOrder.payAmount }
            : {}),
        }
      : { ok: false, orderId: '', error: res.error, errorCode: res.errorCode };
  }
  const res = await api.submitTopupOrder(request.input);
  return res.success
    ? {
        ok: true,
        orderId: res.submission?.order?.orderId ?? '',
        ...(typeof res.submission?.order?.payAmount === 'number' && Number.isFinite(res.submission.order.payAmount)
          ? { payAmount: res.submission.order.payAmount }
          : {}),
      }
    : { ok: false, orderId: '', error: res.error, errorCode: res.errorCode };
}
