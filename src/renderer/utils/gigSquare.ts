/** skill-service protocol: price and currency are human-readable (e.g. "0.001", "SPACE"). Display as-is. */
export const formatGigSquarePrice = (price: string, currency: string): { amount: string; unit: string } => {
  const amount = typeof price === 'string' ? price.trim() || '0' : String(price ?? '0');
  const unit = typeof currency === 'string' ? currency.trim() || '' : String(currency ?? '');
  return { amount, unit };
};

/** Return price string for transfer API (amountSpaceOrDoge: SPACE/DOGE/BTC in main units). */
export const getGigSquarePaymentAmount = (price: string): string => {
  return typeof price === 'string' ? price.trim() || '0' : String(price ?? '0');
};
