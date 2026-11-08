/**
 * Local-image inlining for HTML reports rendered inside the chat.
 *
 * Inline HTML blocks (InlineHtmlReportBlock) and the document side panel
 * (MarkdownViewerPanel) render a bot-written local .html file in a srcdoc
 * iframe with a `<base href="file://<dir>/">`. The app CSP is
 * `img-src 'self' data: https: http:` — `file:` is NOT allowed — so every
 * local image such a page references renders blank. Instead of widening the
 * CSP, the host resolves those images itself and hands the renderer data URIs
 * to substitute.
 *
 * Boundary (security): only files inside the HTML file's OWN directory tree
 * are read — after resolving symlinks — and only when their bytes are a real
 * image (magic-byte sniff, not the extension). A report can therefore never
 * pull arbitrary local files (keys, documents, screenshots elsewhere) into a
 * frame whose scripts can reach the network.
 *
 * Pure module: filesystem access and thumbnailing are injected so tests run in
 * plain node; main.ts supplies fs.promises + an Electron nativeImage
 * thumbnailer.
 */

import path from 'node:path';

export type InlineHtmlImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';

/** Max distinct image sources resolved per document. */
export const INLINE_HTML_IMAGE_MAX_COUNT = 60;
/** Source files larger than this are skipped (never read whole). */
export const INLINE_HTML_IMAGE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Formats the thumbnailer cannot re-encode pass through only below this size. */
export const INLINE_HTML_IMAGE_MAX_PASSTHROUGH_BYTES = 2 * 1024 * 1024;
/** Total data-URI budget per document; images past it stay unresolved. */
export const INLINE_HTML_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Longest edge of generated thumbnails (sharp at 2x in a ~360px card). */
export const INLINE_HTML_IMAGE_THUMB_EDGE = 720;

export type InlineHtmlImageSkipReason =
  | 'unsupported_src'
  | 'outside_document_dir'
  | 'not_found'
  | 'not_a_file'
  | 'too_large'
  | 'not_an_image'
  | 'budget_exceeded'
  | 'error';

export interface InlineHtmlImageResult {
  /** src (exactly as written in the document) → data URI. */
  images: Record<string, string>;
  /** src → why it was left untouched. */
  skipped: Record<string, InlineHtmlImageSkipReason>;
}

export interface InlineHtmlImageDeps {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(target: string): Promise<Buffer>;
  /**
   * Re-encode a PNG/JPEG into a thumbnail no larger than maxEdge on its
   * longest side. Returns null when the image cannot be decoded; the caller
   * then falls back to the passthrough rules.
   */
  thumbnail?(buffer: Buffer, mime: 'image/png' | 'image/jpeg', maxEdge: number): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg' } | null>;
}

/** Sniff an image MIME from magic bytes (the extension is never trusted). */
export function sniffInlineHtmlImageMime(buffer: Buffer): InlineHtmlImageMime | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  // SVG: text document whose first element is <svg (optionally after an XML
  // declaration, doctype or comments). Scripts inside an SVG never run when it
  // is loaded through an <img> element.
  const textHead = buffer.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(textHead)) {
    return 'image/svg+xml';
  }
  return null;
}

/**
 * Map one `<img src>` value to a local filesystem path relative to the
 * document directory, or null when it is not a local reference (http(s),
 * data:, blob:, protocol-relative, fragment, other schemes).
 */
export function resolveInlineHtmlImagePath(documentDir: string, src: string): string | null {
  const raw = String(src ?? '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;
  // Strip query/fragment: a local file has neither.
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean) return null;
  let localPath: string;
  if (/^file:\/\//i.test(clean)) {
    try {
      localPath = decodeURIComponent(new URL(clean).pathname);
    } catch {
      return null;
    }
    // file:///C:/x on Windows parses to /C:/x.
    if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(clean) && !/^[A-Za-z]:[\\/]/.test(clean)) {
    return null;
  } else {
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      // Keep the raw form: a literal % in a file name is legal.
    }
    localPath = path.isAbsolute(decoded) ? decoded : path.resolve(documentDir, decoded);
  }
  return path.normalize(localPath);
}

/** True when `candidate` is `root` itself or lives under it. */
function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve the local images an HTML document references into data URIs.
 * Never throws: every unresolved src is reported in `skipped` and the caller
 * keeps the original reference for it.
 */
export async function inlineHtmlLocalImages(
  deps: InlineHtmlImageDeps,
  input: { htmlPath: string; srcs: string[] },
): Promise<InlineHtmlImageResult> {
  const result: InlineHtmlImageResult = { images: {}, skipped: {} };
  const unique = Array.from(new Set((Array.isArray(input.srcs) ? input.srcs : [])
    .map((src) => String(src ?? ''))
    .filter((src) => src.trim() !== '')));
  if (!unique.length) return result;

  let documentDir: string;
  try {
    documentDir = await deps.realpath(path.dirname(path.resolve(String(input.htmlPath ?? ''))));
  } catch {
    for (const src of unique) result.skipped[src] = 'error';
    return result;
  }

  let budget = INLINE_HTML_IMAGE_MAX_TOTAL_BYTES;
  for (const [index, src] of unique.entries()) {
    if (index >= INLINE_HTML_IMAGE_MAX_COUNT) {
      result.skipped[src] = 'budget_exceeded';
      continue;
    }
    const lexical = resolveInlineHtmlImagePath(documentDir, src);
    if (!lexical) {
      result.skipped[src] = 'unsupported_src';
      continue;
    }
    let realPath: string;
    try {
      realPath = await deps.realpath(lexical);
    } catch {
      result.skipped[src] = 'not_found';
      continue;
    }
    // Symlinks are resolved first, so a link inside the folder that points
    // outside it is refused too.
    if (!isWithinDirectory(documentDir, realPath)) {
      result.skipped[src] = 'outside_document_dir';
      continue;
    }
    try {
      const stats = await deps.stat(realPath);
      if (!stats.isFile()) {
        result.skipped[src] = 'not_a_file';
        continue;
      }
      if (stats.size > INLINE_HTML_IMAGE_MAX_SOURCE_BYTES) {
        result.skipped[src] = 'too_large';
        continue;
      }
      const buffer = await deps.readFile(realPath);
      const mime = sniffInlineHtmlImageMime(buffer);
      if (!mime) {
        result.skipped[src] = 'not_an_image';
        continue;
      }
      let data = buffer;
      let outMime: InlineHtmlImageMime = mime;
      if ((mime === 'image/png' || mime === 'image/jpeg') && deps.thumbnail) {
        const thumb = await deps.thumbnail(buffer, mime, INLINE_HTML_IMAGE_THUMB_EDGE).catch(() => null);
        if (thumb && thumb.data.length > 0) {
          data = thumb.data;
          outMime = thumb.mime;
        }
      }
      // Without a usable thumbnail the original bytes travel only when small.
      if (data === buffer && buffer.length > INLINE_HTML_IMAGE_MAX_PASSTHROUGH_BYTES) {
        result.skipped[src] = 'too_large';
        continue;
      }
      const dataUri = `data:${outMime};base64,${data.toString('base64')}`;
      if (dataUri.length > budget) {
        result.skipped[src] = 'budget_exceeded';
        continue;
      }
      budget -= dataUri.length;
      result.images[src] = dataUri;
    } catch {
      result.skipped[src] = 'error';
    }
  }
  return result;
}
