export const normalizeGigSquareDisplayCurrency = (currency: string): string => {
  const normalized = typeof currency === 'string' ? currency.trim() : String(currency ?? '');
  if (!normalized) return '';
  return normalized.toUpperCase() === 'MVC' ? 'SPACE' : normalized;
};

const PLAIN_NON_NEGATIVE_DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

export const isGigSquareFreeServicePrice = (
  price: string,
  paymentTiming?: string | null,
): boolean => {
  if (String(paymentTiming || '').trim().toLowerCase() === 'free') return true;
  const amount = typeof price === 'string' ? price.trim() : String(price ?? '').trim();
  if (!PLAIN_NON_NEGATIVE_DECIMAL_PATTERN.test(amount)) return true;
  return !/[1-9]/.test(amount);
};

/** skill-service protocol: price and currency are human-readable (e.g. "0.001", "SPACE"). */
export const formatGigSquarePrice = (
  price: string,
  currency: string,
  options?: {
    paymentTiming?: string | null;
    freeLabel?: string;
    treatZeroAsFree?: boolean;
  },
): { amount: string; unit: string; isFree: boolean } => {
  if (
    String(options?.paymentTiming || '').trim().toLowerCase() === 'free'
    || (options?.treatZeroAsFree === true && isGigSquareFreeServicePrice(price, options?.paymentTiming))
  ) {
    return {
      amount: options?.freeLabel || 'Free',
      unit: '',
      isFree: true,
    };
  }
  const amount = typeof price === 'string' ? price.trim() || '0' : String(price ?? '0');
  const unit = normalizeGigSquareDisplayCurrency(currency);
  return { amount, unit, isFree: false };
};

/** Return price string for transfer API (amountSpaceOrDoge: SPACE/DOGE/BTC in main units). */
export const getGigSquarePaymentAmount = (price: string): string => {
  return typeof price === 'string' ? price.trim() || '0' : String(price ?? '0');
};
