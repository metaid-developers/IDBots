import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { grantCredit } from './creditService.js';

/**
 * Payment-success trigger for the bundle credit channel (NEW capability —
 * no C2/C3 contract change). A bundle order is "paid" when the upstream C4
 * status reaches PAID/CREDITED (the Metaso webhook credits the traffic and
 * LLM quota there); the client records that observation as a local order
 * voucher (src/main/services/bundleService.ts). This function is the
 * operator-side half: turn one paid order into exactly one credit_ledger row
 * — source 'bundle-order', reference_key = the upstream orderId — so the
 * control-plane ledger can be cross-checked against the client voucher and
 * the upstream orderId. Byte-level application to the tenant traffic account
 * stays on the tenant image's admin grant channel (see the creditService
 * scope note); nothing here guesses an upstream credential.
 *
 * Exactly-once comes from creditService's UNIQUE reference_key: calling this
 * twice for the same orderId returns the existing grant (duplicate: true)
 * instead of a second row, so replaying a payment notification is safe.
 */

/** The order fields the trigger needs (client voucher / C4 status shape). */
export interface PaidBundleOrder {
  orderId: string;
  planId: string;
  payAmount: string;
  payCurrency: string;
  trafficBytes: number;
}

export function recordBundleOrderCredit(
  app: Pick<AppContext, 'db'>,
  input: { userId: string; order: PaidBundleOrder },
  operator: string,
): ReturnType<typeof grantCredit> {
  const orderId = typeof input.order?.orderId === 'string' ? input.order.orderId.trim() : '';
  if (!orderId) {
    // A paid order without its upstream id has no idempotency key: refuse a
    // grant that a replayed notification could double-credit.
    throw new HttpError(
      400,
      'MISSING_ORDER_ID',
      'order.orderId is required (reference_key carries the upstream orderId for exactly-once crediting)',
    );
  }
  const order = input.order;
  return grantCredit(app, {
    userId: input.userId,
    bytes: order.trafficBytes,
    source: 'bundle-order',
    reason:
      `bundle order ${orderId} paid ${order.payAmount} ${order.payCurrency} ` +
      `(plan ${order.planId}, ${order.trafficBytes} bytes)`,
    actor: `admin:${operator}`,
    referenceKey: orderId,
  });
}
