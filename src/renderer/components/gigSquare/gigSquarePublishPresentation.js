export const GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS = [
  { label: 'BTC', value: 'BTC' },
  { label: 'SPACE', value: 'SPACE' },
  { label: 'DOGE', value: 'DOGE' },
  { label: 'MRC20', value: 'MRC20' },
];

export const GIG_SQUARE_PUBLISH_PRICE_LIMITS = {
  BTC: 1,
  SPACE: 100000,
  DOGE: 10000,
};

export function getGigSquarePublishCurrencyLabel(currency) {
  const normalized = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const option = GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS.find((item) => item.value === normalized);
  return option?.label || normalized || 'BTC';
}

export function getGigSquarePublishPriceLimit(currency) {
  const normalized = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (normalized === 'MRC20') return null;
  return GIG_SQUARE_PUBLISH_PRICE_LIMITS[normalized] || GIG_SQUARE_PUBLISH_PRICE_LIMITS.BTC;
}

export function getSelectableGigSquareMrc20Assets(assets) {
  return (Array.isArray(assets) ? assets : []).filter((asset) => Number(asset?.balance?.display || 0) > 0);
}

export function getGigSquarePublishPriceLimitText(currency) {
  const limit = getGigSquarePublishPriceLimit(currency);
  if (limit === null) return '';
  return `${limit} ${getGigSquarePublishCurrencyLabel(currency)}`;
}
