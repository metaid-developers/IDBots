export interface SpendCap {
  amount: string;
  currency: 'SPACE' | 'BTC' | 'DOGE';
}

export interface SpendDecision {
  allowed: boolean;
  code?: 'invalid_price' | 'invalid_cap' | 'currency_mismatch' | 'spend_cap_exceeded';
  reason?: string;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSpendCurrency(value: unknown): 'SPACE' | 'BTC' | 'DOGE' | '' {
  const normalized = normalizeText(value).toUpperCase();
  if (normalized === 'MVC') return 'SPACE';
  if (normalized === 'SPACE' || normalized === 'BTC' || normalized === 'DOGE') {
    return normalized;
  }
  return '';
}

export function evaluateSpendCap(input: {
  price: string;
  currency: string;
  spendCap?: SpendCap | null;
}): SpendDecision {
  const normalizedPrice = normalizeText(input.price);
  const normalizedCurrency = normalizeSpendCurrency(input.currency);
  const numericPrice = Number(normalizedPrice);

  if (!normalizedPrice || !Number.isFinite(numericPrice) || numericPrice < 0) {
    return {
      allowed: false,
      code: 'invalid_price',
      reason: 'Remote service price is invalid.',
    };
  }

  if (!input.spendCap) {
    return { allowed: true };
  }

  const capCurrency = normalizeSpendCurrency(input.spendCap.currency);
  const capAmount = Number(normalizeText(input.spendCap.amount));
  if (!capCurrency || !Number.isFinite(capAmount) || capAmount < 0) {
    return {
      allowed: false,
      code: 'invalid_cap',
      reason: 'Spend cap is invalid.',
    };
  }

  if (capCurrency !== normalizedCurrency) {
    return {
      allowed: false,
      code: 'currency_mismatch',
      reason: `Spend cap currency ${capCurrency} does not match remote service currency ${normalizedCurrency || 'unknown'}.`,
    };
  }

  if (numericPrice > capAmount) {
    return {
      allowed: false,
      code: 'spend_cap_exceeded',
      reason: `Remote service price ${normalizedPrice} ${normalizedCurrency} exceeds the spend cap ${input.spendCap.amount} ${capCurrency}.`,
    };
  }

  return { allowed: true };
}
