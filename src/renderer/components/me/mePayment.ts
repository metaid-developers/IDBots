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
// Period pricing (product-style price tag: current price + original +
// discount). Mirrors the order the server will price: monthly xN against
// the plan's explicit discounts. original is null when the period carries
// no discount (month) or the computed price is not actually cheaper.
// ---------------------------------------------------------------------------

export type MeSubscriptionPeriodOption = 'month' | 'quarter' | 'year';

export interface MePeriodPricing {
  price: number;
  original: number | null;
}

export function mePeriodPricing(input: {
  monthly: number;
  period: MeSubscriptionPeriodOption;
  quarterlyDiscountPct?: number;
  annualPriceCny?: number;
}): MePeriodPricing {
  const { monthly, period } = input;
  if (period === 'month') {
    return { price: monthly, original: null };
  }
  if (period === 'quarter') {
    const original = Math.round(monthly * 3);
    const pct = input.quarterlyDiscountPct;
    const price = pct && pct > 0 && pct < 100 ? Math.round(monthly * 3 * (pct / 100)) : original;
    return { price, original: price < original ? original : null };
  }
  const original = Math.round(monthly * 12);
  const price = input.annualPriceCny != null && input.annualPriceCny > 0
    ? Math.round(input.annualPriceCny)
    : original;
  return { price, original: price < original ? original : null };
}

export interface MeDiscountParts {
  /** zh 折数 as display text: "9", "8.5" (pay/original x10, trailing zeros trimmed). */
  zhe: string;
  /** Percent saved for the en "% off" rendering, 0-99. */
  pctOff: number;
}

/** null when the pair does not describe a real discount (original <= price). */
export function meDiscountParts(price: number, original: number): MeDiscountParts | null {
  if (!Number.isFinite(price) || !Number.isFinite(original) || original <= 0 || price <= 0) {
    return null;
  }
  if (price >= original) {
    return null;
  }
  const ratio = price / original;
  const zheValue = ratio * 10;
  const zhe = (Math.round(zheValue * 10) / 10).toString();
  const pctOff = Math.min(99, Math.max(1, Math.round((1 - ratio) * 100)));
  return { zhe, pctOff };
}
