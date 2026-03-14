const METAFILE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';

/** Resolve metafile://<pinid> to image URL (same as service list). Use for serviceIcon or provider avatar fallback. */
export const getServiceIconUrl = (serviceIcon: string | null | undefined): string | null => {
  if (!serviceIcon || typeof serviceIcon !== 'string') return null;
  const s = serviceIcon.trim();
  const prefix = 'metafile://';
  if (!s.toLowerCase().startsWith(prefix)) return null;
  const pinid = s.slice(prefix.length).trim();
  if (!pinid) return null;
  return `${METAFILE_CONTENT_BASE}/${encodeURIComponent(pinid)}`;
};

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
