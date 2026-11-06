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
