const SATS_PER_UNIT = 1e8;

const formatAmount = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
};

const formatPaymentAmount = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(8);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

export const formatGigSquarePrice = (price: number, currency: string): { amount: string; unit: string } => {
  const normalizedCurrency = (currency || '').toUpperCase();
  const unit = normalizedCurrency.includes('DOGE') ? 'DOGE' : 'BTC';
  const amountValue = price / SATS_PER_UNIT;
  return { amount: formatAmount(amountValue), unit };
};

export const getGigSquarePaymentAmount = (price: number): string => {
  const amountValue = price / SATS_PER_UNIT;
  return formatPaymentAmount(amountValue);
};
