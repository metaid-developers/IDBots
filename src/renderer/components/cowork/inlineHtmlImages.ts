/**
 * Local-image inlining for HTML reports — renderer side (DOM-free).
 *
 * The app CSP has no `file:` in img-src, so `<img src="source/a.jpg">` in a
 * locally rendered report (inline HTML block, document side panel) shows
 * blank. These helpers collect the local `<img src>` values of a document and
 * swap them for the data URIs the host resolves through
 * `fs:inlineHtmlImages` (document-dir confined, real images only). Remote,
 * data:, blob: and fragment sources are never touched. Only `<img src>` is
 * handled — CSS `url()` and `srcset` stay as written.
 */

const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** True when a src may point at a local file (relative, absolute, or file://). */
export const isLocalInlineHtmlImageSrc = (src: string): boolean => {
  const value = src.trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return false;
  if (/^file:\/\//i.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
};

/** Distinct local `<img src>` values, exactly as written, in document order. */
export const collectLocalInlineHtmlImageSrcs = (html: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of String(html ?? '').matchAll(IMG_SRC_RE)) {
    const src = match[3] ?? match[4] ?? match[5] ?? '';
    if (!isLocalInlineHtmlImageSrc(src) || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
};

/** Replace resolved `<img src>` values with their data URIs (quotes normalized to double). */
export const applyInlineHtmlImageMap = (html: string, images: Record<string, string>): string => {
  if (!images || Object.keys(images).length === 0) return html;
  return String(html ?? '').replace(IMG_SRC_RE, (whole, prefix: string, _quoted: string, dq?: string, sq?: string, bare?: string) => {
    const src = dq ?? sq ?? bare ?? '';
    const dataUri = Object.prototype.hasOwnProperty.call(images, src) ? images[src] : undefined;
    return typeof dataUri === 'string' && dataUri.startsWith('data:image/') ? `${prefix}"${dataUri}"` : whole;
  });
};

/**
 * Resolve and inline a document's local images through the host bridge.
 * Best effort by design: no bridge (mobile/web), a denied channel, or any
 * failure returns the document unchanged — images then stay blank exactly as
 * before, never worse.
 */
export const inlineLocalHtmlImages = async (html: string, filePath: string): Promise<string> => {
  const srcs = collectLocalInlineHtmlImageSrcs(html);
  if (!srcs.length) return html;
  const bridge = (window as unknown as {
    electron?: { fs?: { inlineHtmlImages?: (htmlPath: string, srcs: string[]) => Promise<{ success: boolean; images?: Record<string, string> }> } };
  }).electron?.fs?.inlineHtmlImages;
  if (typeof bridge !== 'function') return html;
  try {
    const result = await bridge(filePath, srcs);
    return result?.success && result.images ? applyInlineHtmlImageMap(html, result.images) : html;
  } catch {
    return html;
  }
};
