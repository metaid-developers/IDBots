const LOCAL_PREVIEW_URI_RE = /^(preview-metaapp|preview-file):\/\//i;

function decodePreviewPathnameTolerant(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

/**
 * Canonicalize a Bot Browser URI for equality checks across percent-encoded
 * host inputs (`previewMetaappUriForPath` encodes spaces as `%20`),
 * triple-slash forms (`preview-file:///...`), and decoded runtime URIs.
 */
export function canonicalBrowserUri(uri: string | null | undefined): string {
  const raw = String(uri ?? '').trim();
  if (!raw) return '';
  if (!LOCAL_PREVIEW_URI_RE.test(raw)) return raw;
  const sanitized = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i, (_, prefix, rest) => `${prefix}${rest.replace(/\\/g, '/')}`);
  try {
    const parsed = new URL(sanitized);
    const host = (parsed.host || 'localhost').toLowerCase();
    const decodedPath = decodePreviewPathnameTolerant(parsed.pathname);
    const normalizedPath = decodedPath.replace(/\/\/+/g, '/');
    return `${parsed.protocol.toLowerCase()}//${host}${normalizedPath}${parsed.search}${parsed.hash}`;
  } catch {
    return raw;
  }
}

export function browserUrisMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = canonicalBrowserUri(left).toLowerCase();
  const b = canonicalBrowserUri(right).toLowerCase();
  return a !== '' && a === b;
}

export function browserUriMatchesPrefix(
  candidate: string | null | undefined,
  prefix: string | null | undefined,
): boolean {
  const c = canonicalBrowserUri(candidate).toLowerCase();
  const p = canonicalBrowserUri(prefix).toLowerCase();
  return c !== '' && p !== '' && (c === p || c.startsWith(p));
}
