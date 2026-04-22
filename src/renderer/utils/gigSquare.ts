export const normalizeGigSquareDisplayCurrency = (currency: string): string => {
  const normalized = typeof currency === 'string' ? currency.trim() : String(currency ?? '');
  if (!normalized) return '';
  return normalized.toUpperCase() === 'MVC' ? 'SPACE' : normalized;
};

/** skill-service protocol: price and currency are human-readable (e.g. "0.001", "SPACE"). */
export const formatGigSquarePrice = (price: string, currency: string): { amount: string; unit: string } => {
  const amount = typeof price === 'string' ? price.trim() || '0' : String(price ?? '0');
  const unit = normalizeGigSquareDisplayCurrency(currency);
  return { amount, unit };
};

/** Return price string for transfer API (amountSpaceOrDoge: SPACE/DOGE/BTC in main units). */
export const getGigSquarePaymentAmount = (price: string): string => {
  return typeof price === 'string' ? price.trim() || '0' : String(price ?? '0');
};
