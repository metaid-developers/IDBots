const LOCAL_PREVIEW_URI_RE = /^(preview-metaapp|preview-file):\/\//i;

/**
 * Canonicalize a Bot Browser URI for equality checks across percent-encoded
 * host inputs (`previewMetaappUriForPath` encodes spaces as `%20`) and
 * ABC-normalized runtime URIs (`parsePreviewMetaAppUri` / `parsePreviewFileUri`
 * decode `url.pathname` back to literal characters and collapse slashes).
 */
export function canonicalBrowserUri(uri: string | null | undefined): string {
  const raw = String(uri ?? '').trim();
  if (!raw) return '';
  if (!LOCAL_PREVIEW_URI_RE.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    let decodedPath = parsed.pathname;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      decodedPath = parsed.pathname;
    }
    const normalizedPath = decodedPath.replace(/\/\/+/g, '/');
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${normalizedPath}${parsed.search}${parsed.hash}`;
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
