import type { MeSubscriptionOrderInfo, MeTopupOrderInfo } from '../../types/electron';

export interface MePaymentCheckout {
  orderId: string;
  status: string;
  approvalUrl: string;
  qrCode: string;
  payAmount: number;
  payCurrency: string;
}

type PaymentOrder = Partial<MeSubscriptionOrderInfo & MeTopupOrderInfo>;

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
};

const amountOf = (value: unknown): number | undefined => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

const httpUrl = (value: unknown): string => {
  const text = textOf(value);
  return /^https?:\/\//i.test(text) ? text : '';
};

export function extractMeApprovalUrl(gatewayParams: unknown): string {
  const record = recordOf(gatewayParams);
  if (!record) return '';
  for (const key of ['approvalUrl', 'approval_url', 'approveLink', 'approve_url', 'paymentUrl', 'payment_url']) {
    const url = httpUrl(record[key]);
    if (url) return url;
  }
  return '';
}

export function extractMeQrCode(gatewayParams: unknown): string {
  const record = recordOf(gatewayParams);
  if (!record) return '';
  for (const key of ['qrCode', 'qr_code', 'qrCodeContent', 'codeUrl', 'code_url']) {
    const content = textOf(record[key]);
    if (content) return content;
  }
  return '';
}

export function normalizeMePaymentCheckout(
  order: PaymentOrder | null | undefined,
  fallbackAmount: number,
): MePaymentCheckout | null {
  const orderId = textOf(order?.orderId);
  if (!orderId) return null;
  return {
    orderId,
    status: textOf(order?.status) || 'created',
    approvalUrl: extractMeApprovalUrl(order?.gatewayParams),
    qrCode: extractMeQrCode(order?.gatewayParams),
    payAmount: amountOf(order?.payAmount) ?? amountOf(order?.amountCny) ?? amountOf(order?.priceCny) ?? fallbackAmount,
    payCurrency: textOf(order?.payCurrency) || 'CNY',
  };
}

export function mePaymentPhase(status: string | number): 'pending' | 'credited' | 'closed' {
  const normalized = textOf(status).toLowerCase();
  if (normalized === '3' || /^(confirmed|credited|active|completed|succeeded|success)$/.test(normalized)) {
    return 'credited';
  }
  if (normalized === '4' || /^(closed|rejected|expired|cancelled|canceled|failed)$/.test(normalized)) {
    return 'closed';
  }
  return 'pending';
}

// ---------------------------------------------------------------------------
// Period pricing — uniform monthly-rate model (owner decision 2026-11-07):
// the price tag always shows a per-month rate. Quarter bills 3 months at
// 90% of the monthly price, year bills 12 months at 80%; the one-payment
// total is monthly × months × pct. The server prices orders with the exact
// same arithmetic (assist-base-service PriceSubscriptionOrderCny) so the
// tag amount always equals the charged amount — keep both in sync.
// plan.quarterlyDiscountPct / annualPriceCny are no longer read for pricing.
// ---------------------------------------------------------------------------

export type MeSubscriptionPeriodOption = 'month' | 'quarter' | 'year';

/** Discount percent of the monthly price per period (100 = no discount). */
export const ME_QUARTER_DISCOUNT_PCT = 90;
export const ME_YEAR_DISCOUNT_PCT = 80;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface MePeriodPricing {
  /** Billed months in one payment (1 / 3 / 12). */
  months: number;
  /** Discount percent applied to the monthly price (100 = none). */
  discountPct: number;
  /** Effective monthly rate shown on the price tag (2dp), e.g. 44.1. */
  monthlyRate: number;
  /** The one-payment total actually charged (2dp) — authoritative amount. */
  total: number;
  /** Undiscounted monthly price for the strikethrough; null on month. */
  originalMonthly: number | null;
}

export function mePeriodPricing(input: {
  monthly: number;
  period: MeSubscriptionPeriodOption;
}): MePeriodPricing {
  const { monthly, period } = input;
  if (period === 'month') {
    return { months: 1, discountPct: 100, monthlyRate: monthly, total: monthly, originalMonthly: null };
  }
  const months = period === 'quarter' ? 3 : 12;
  const discountPct = period === 'quarter' ? ME_QUARTER_DISCOUNT_PCT : ME_YEAR_DISCOUNT_PCT;
  return {
    months,
    discountPct,
    monthlyRate: round2(monthly * discountPct / 100),
    // Round the lump sum once, from the undiscounted monthly price — the
    // rate is display-only so the tag can never drift from the charge.
    total: round2(monthly * months * discountPct / 100),
    originalMonthly: monthly,
  };
}

export interface MeDiscountParts {
  /** zh 折数 as display text: "9", "8.5" (pay/original x10, trailing zeros trimmed). */
  zhe: string;
  /** Percent saved for the en "% off" rendering, 0-99. */
  pctOff: number;
}

/** Discount badge parts from the applied percent; null when there is none. */
export function meDiscountFromPct(discountPct: number): MeDiscountParts | null {
  if (!Number.isFinite(discountPct) || discountPct >= 100 || discountPct <= 0) {
    return null;
  }
  const zheValue = discountPct / 10;
  const zhe = (Math.round(zheValue * 10) / 10).toString();
  const pctOff = Math.min(99, Math.max(1, Math.round(100 - discountPct)));
  return { zhe, pctOff };
}
