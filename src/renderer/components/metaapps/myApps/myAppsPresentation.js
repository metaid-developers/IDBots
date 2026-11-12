// Pure presentation helpers for the My Apps tab. Image resolution mirrors
// IDBots metaAppVisualService.resolveRemoteAssetUrl (accelerate content URL).

const METAFILE_ACCELERATE_CONTENT_API_BASE_URL =
  'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/';
const PIN_ID_PATTERN = /^[0-9a-f]{64}i0$/i;

export const buildShareUrl = (pinId) => `https://openagentinternet.org/browser/metaapp/${String(pinId || '').toLowerCase()}`;

export const formatRuntime = (runtime) => {
  const text = String(runtime || '').trim();
  if (!text) return '';
  return text.split('/').filter(Boolean).join(' · ');
};

export const resolveImageUrl = (reference, process) => {
  const text = String(reference || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text) || text.startsWith('data:')) return text;
  // metafile:// ref or bare pin → accelerate content URL
  const stripped = text.toLowerCase().startsWith('metafile://')
    ? text.slice('metafile://'.length)
    : text;
  const pin = stripped.replace(/\.[a-z0-9+-]+$/i, '').toLowerCase();
  if (PIN_ID_PATTERN.test(pin)) {
    const base = `${METAFILE_ACCELERATE_CONTENT_API_BASE_URL}${encodeURIComponent(pin)}`;
    // The accelerate image processor returns a JSON error body for SVG pins,
    // so svg references always resolve to the unprocessed original.
    if (process && !stripped.trim().toLowerCase().endsWith('.svg')) {
      return `${base}?process=${encodeURIComponent(process)}`;
    }
    return base;
  }
  return null;
};

// Returns the same URL without the `process` query param (for retrying the
// original image when a processed variant fails), or null when absent.
export const stripImageProcessParam = (src) => {
  const text = String(src || '').trim();
  const queryIndex = text.indexOf('?');
  if (!text || queryIndex < 0) return null;
  const hashIndex = text.indexOf('#', queryIndex);
  const base = text.slice(0, queryIndex);
  const query = text.slice(queryIndex + 1, hashIndex < 0 ? undefined : hashIndex);
  const hash = hashIndex < 0 ? '' : text.slice(hashIndex);
  const params = query.split('&').filter(Boolean);
  const kept = params.filter((param) => param.split('=')[0] !== 'process');
  if (kept.length === params.length) return null;
  return kept.length ? `${base}?${kept.join('&')}${hash}` : `${base}${hash}`;
};

export const getCardVisual = (record) => {
  const cover = resolveImageUrl(record.coverImg, 'preview');
  const icon = resolveImageUrl(record.icon, 'thumbnail');
  return { cover, icon };
};

export const getStatePill = (record) => {
  if (record.disabled) return { labelKey: 'myAppsDisabled', label: 'Disabled', tone: 'warn' };
  return { labelKey: 'myAppsRunnable', label: 'Runnable', tone: 'ok' };
};

export const getInitials = (name) => {
  const text = String(name || '').trim();
  if (!text) return 'MA';
  const parts = text.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '');
  return parts.join('') || text.slice(0, 2).toUpperCase();
};

export const getOwnerEmptyState = (t) => ({
  noBot: {
    title: t('myAppsNoBotTitle') || 'No local Bot',
    description: t('myAppsNoBotDesc') || 'Create a Bot first to manage its published MetaApps.',
  },
  noApps: {
    title: t('myAppsEmptyTitle') || 'No published MetaApps yet',
    description: t('myAppsEmptyDesc') || 'Publish your first MetaApp to see it here.',
  },
  noMvc: {
    title: t('myAppsNoMvcTitle') || 'Bot has no on-chain address',
    description: t('myAppsNoMvcDesc') || 'This Bot lacks an MVC address and cannot publish MetaApps.',
  },
});
