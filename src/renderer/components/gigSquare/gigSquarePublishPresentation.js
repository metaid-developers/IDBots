export const GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS = [
  { label: 'BTC', value: 'BTC' },
  { label: 'SPACE', value: 'SPACE' },
  { label: 'DOGE', value: 'DOGE' },
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
  return GIG_SQUARE_PUBLISH_PRICE_LIMITS[normalized] || GIG_SQUARE_PUBLISH_PRICE_LIMITS.BTC;
}

export function getGigSquarePublishPriceLimitText(currency) {
  return `${getGigSquarePublishPriceLimit(currency)} ${getGigSquarePublishCurrencyLabel(currency)}`;
}
