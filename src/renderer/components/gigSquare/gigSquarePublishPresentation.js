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
  if (normalized === 'MVC') return 'SPACE';
  const option = GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS.find((item) => item.value === normalized);
  return option?.label || normalized || 'BTC';
}

export function getGigSquarePublishPriceLimit(currency) {
  const normalized = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (normalized === 'MRC20') return null;
  return GIG_SQUARE_PUBLISH_PRICE_LIMITS[normalized] || GIG_SQUARE_PUBLISH_PRICE_LIMITS.BTC;
}

export function getGigSquareSettlementGridClassName(currency) {
  const normalized = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  return normalized === 'MRC20'
    ? 'grid grid-cols-1 gap-4 md:grid-cols-3'
    : 'grid grid-cols-1 gap-4 md:grid-cols-2';
}

export function getGigSquareMrc20SelectPlaceholder(assets) {
  return Array.isArray(assets) && assets.length > 0
    ? 'Select token'
    : 'No Token';
}

export function formatGigSquareMrc20OptionLabel(asset) {
  const symbol = typeof asset?.symbol === 'string' ? asset.symbol.trim().toUpperCase() : '';
  const tokenName = typeof asset?.tokenName === 'string' ? asset.tokenName.trim() : '';
  const mrc20Id = typeof asset?.mrc20Id === 'string' ? asset.mrc20Id.trim() : '';
  const parts = [symbol || 'MRC20'];
  if (tokenName && tokenName.toUpperCase() !== (symbol || '').toUpperCase()) {
    parts.push(tokenName);
  }
  if (mrc20Id) {
    parts.push(mrc20Id);
  }
  return parts.join(' - ');
}

export function getSelectableGigSquareMrc20Assets(assets) {
  return (Array.isArray(assets) ? assets : []).filter((asset) => Number(asset?.balance?.display || 0) > 0);
}

export function getNextGigSquareSelectedMrc20Id(assets, currentSelectedId) {
  const normalizedCurrentSelectedId = typeof currentSelectedId === 'string' ? currentSelectedId.trim() : '';
  if (!normalizedCurrentSelectedId) return '';
  return getSelectableGigSquareMrc20Assets(assets)
    .some((asset) => asset?.mrc20Id === normalizedCurrentSelectedId)
    ? normalizedCurrentSelectedId
    : '';
}

export function getSelectableGigSquareModifyMrc20Assets(assets, currentSelection) {
  const options = [...getSelectableGigSquareMrc20Assets(assets)];
  const currentMrc20Id = typeof currentSelection?.mrc20Id === 'string' ? currentSelection.mrc20Id.trim() : '';
  const currentTicker = typeof currentSelection?.mrc20Ticker === 'string' ? currentSelection.mrc20Ticker.trim() : '';
  if (!currentMrc20Id || !currentTicker || options.some((asset) => asset?.mrc20Id === currentMrc20Id)) {
    return options;
  }
  options.unshift({
    symbol: currentTicker,
    mrc20Id: currentMrc20Id,
    balance: {
      confirmed: '0',
      unconfirmed: '0',
      pendingIn: '0',
      pendingOut: '0',
      display: '0',
    },
  });
  return options;
}

export function getGigSquarePublishPriceLimitText(currency) {
  const limit = getGigSquarePublishPriceLimit(currency);
  if (limit === null) return '';
  return `${limit} ${getGigSquarePublishCurrencyLabel(currency)}`;
}
