/**
 * Avatar source normalization (main process).
 *
 * The on-chain `/info/avatar` step and the stored profile column only accept a
 * base64 image `data:` URL with a supported image MIME (the canonical validator
 * is `parseDataUrlAvatar` in `services/metaidCore.ts`). The metabot agent tools,
 * however, advertise and accept an http(s) image URL (and a local image path)
 * and used to forward it verbatim: an http(s) value then either failed
 * `buildEditAvatarSyncStep` with "Invalid avatar data URL" (metabot_update) or
 * was silently dropped from the create sync plan — while the tool description
 * still claimed http(s) was supported. This module converts such a source into
 * a data URL *before* it reaches the sync validator, and — when that cannot be
 * done — returns a structured failure the caller degrades on (skip the avatar,
 * keep the bot) instead of aborting the create/update flow.
 *
 * Design constraints:
 * - No new dependency: uses the global `fetch` + `AbortSignal.timeout`, both
 *   already used elsewhere in the main process.
 * - The response Content-Type is a hint only; the actual payload must pass
 *   magic-byte sniffing, so a non-image (or an image/ header over HTML) is
 *   rejected rather than pinned on-chain.
 * - Hard size cap + timeout so a hostile or broken URL can never stall or
 *   bloat the flow.
 * - Local paths must be ABSOLUTE (same convention as the file-upload tools);
 *   relative paths are refused instead of being resolved against an implicit cwd.
 * - A `metafile://<pinId>[.ext]` reference (or a bare 66-character pinId) is
 *   resolved through the public MetaID content gateway, THUMBNAIL variant
 *   FIRST: an NFT cover is routinely ~1 MB (over the avatar cap) while its
 *   `?process=thumbnail` rendering is ~13 KB. The same size cap and magic-byte
 *   sniffing apply, so an oversized original degrades to a structured
 *   `too-large` instead of being pinned on-chain or aborting the flow.
 */

import fs from 'fs';
import path from 'path';

export const AVATAR_SUPPORTED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * Hard cap for a newly ingested (http/local) avatar. Mirrors the renderer
 * edit-UI limit `AVATAR_MAX_SIZE_BYTES` in MetaBotEditTabs.tsx (200 KB) so a
 * value that the UI would refuse cannot slip in through an agent tool. An
 * already-valid `data:` URL is passed through untouched (no new restriction on
 * a path that already works).
 */
export const AVATAR_MAX_BYTES = 200 * 1024;

/** Download timeout for an http(s) avatar. Bounds worst-case latency. */
export const AVATAR_FETCH_TIMEOUT_MS = 8_000;

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

// ---------------------------------------------------------------------------
// metafile:// resolution
// ---------------------------------------------------------------------------

/**
 * Public MetaID content gateway bases, mirroring `pinAssetService` (kept as
 * local constants so this module stays dependency-free and importable from a
 * plain node test process). Order matters: the `?process=thumbnail` variants
 * are asked FIRST because an NFT cover original is generally far over the
 * avatar cap; the original file endpoint is the last resort for small pins.
 */
export const METAFILE_ACCELERATE_CONTENT_BASE =
  'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
export const METAFILE_USER_AVATAR_ACCELERATE_BASE =
  'https://file.metaid.io/metafile-indexer/api/v1/users/avatar/accelerate';
export const METAFILE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';

/** A MetaID pin id: 64 lowercase hex characters + `i<output index>`. */
const PIN_ID_RE = /^[0-9a-f]{64}i\d+$/i;

const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|webp|gif)$/i;

function stripImageExtension(value: string): string {
  return value.replace(IMAGE_EXTENSION_RE, '');
}

/**
 * Extract the bare pinId from `metafile://<pinId>[.<ext>]` or a bare
 * `<pinId>[.<ext>]`. Returns null for anything else (wrong length, a path
 * separator, a stray scheme) so the caller keeps `unsupported-scheme`.
 */
export function extractAvatarPinId(reference: string | null | undefined): string | null {
  const raw = typeof reference === 'string' ? reference.trim() : '';
  if (!raw) return null;
  const withoutScheme = raw.toLowerCase().startsWith('metafile://')
    ? raw.slice('metafile://'.length).trim()
    : raw;
  const basePart = (withoutScheme.split(/[?#]/)[0] ?? '').trim();
  if (!basePart || basePart.includes('/') || basePart.includes('\\') || basePart.includes(':')) {
    return null;
  }
  const pinId = stripImageExtension(basePart);
  return PIN_ID_RE.test(pinId) ? pinId : null;
}

/**
 * Ordered resolution candidates for one pin: thumbnail variants first (the
 * avatar-sized rendering), the original file endpoint last.
 */
export function buildMetafileAvatarSourceUrls(pinId: string): string[] {
  const encoded = encodeURIComponent(pinId);
  return [
    `${METAFILE_ACCELERATE_CONTENT_BASE}/${encoded}?process=thumbnail`,
    `${METAFILE_USER_AVATAR_ACCELERATE_BASE}/${encoded}?process=thumbnail`,
    `${METAFILE_CONTENT_BASE}/${encoded}`,
  ];
}

export type AvatarNormalizeSource = 'data-url' | 'http-url' | 'local-file' | 'metafile';

export type AvatarNormalizeFailureReason =
  | 'empty'
  | 'invalid-data-url'
  | 'unsupported-scheme'
  | 'fetch-failed'
  | 'fetch-timeout'
  | 'non-image'
  | 'too-large'
  | 'empty-body'
  | 'read-failed';

export type AvatarNormalizeSuccess = {
  ok: true;
  dataUrl: string;
  mime: string;
  bytes: number;
  source: AvatarNormalizeSource;
};

export type AvatarNormalizeFailure = {
  ok: false;
  reason: AvatarNormalizeFailureReason;
  detail: string;
};

export type AvatarNormalizeResult = AvatarNormalizeSuccess | AvatarNormalizeFailure;

/**
 * Explicit type guard. The electron tsconfig has `strict`/`strictNullChecks`
 * off, where TypeScript does not reliably narrow a discriminated union on the
 * NEGATIVE branch of `if (result.ok)` — so callers branch on this guard.
 */
export function isAvatarNormalizeFailure(result: AvatarNormalizeResult): result is AvatarNormalizeFailure {
  return result.ok === false;
}

export interface AvatarNormalizeDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to fs.promises.readFile. */
  readFileImpl?: (filePath: string) => Promise<Buffer>;
  timeoutMs?: number;
  maxBytes?: number;
}

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function isSupportedImageMime(mime: string): boolean {
  return AVATAR_SUPPORTED_MIME_TYPES.includes(mime);
}

/**
 * True when `value` is a data URL the canonical sync validator
 * (`parseDataUrlAvatar`) would accept. Kept byte-for-byte compatible with that
 * validator; `tests/avatarNormalize.test.mjs` cross-checks the two so they
 * cannot silently diverge.
 */
export function isValidAvatarDataUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  const match = DATA_URL_RE.exec(value);
  if (!match) return false;
  if (!isSupportedImageMime(match[1].trim().toLowerCase())) return false;
  const base64 = match[2];
  if (!base64) return false;
  if (base64.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return false;
  try {
    const buffer = Buffer.from(base64, 'base64');
    return buffer.length > 0 && buffer.toString('base64') === base64;
  } catch {
    return false;
  }
}

/**
 * Identify an image from its magic bytes. Returns null when the payload is not
 * one of the four supported image formats, regardless of what the
 * Content-Type header (or file extension) claimed.
 */
export function sniffImageMimeFromBytes(buffer: Buffer): string | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6
    && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Extension → MIME hint, used only in human-readable failure details. */
function mimeHintFromExtension(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return '';
  }
}

function finalizeBuffer(
  buffer: Buffer,
  declaredMime: string,
  maxBytes: number,
  label: string,
  source: AvatarNormalizeSource,
): AvatarNormalizeResult {
  if (buffer.length === 0) {
    return { ok: false, reason: 'empty-body', detail: `${label} returned an empty body.` };
  }
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `${label} is ${buffer.length} bytes, over the ${maxBytes} byte avatar cap.`,
    };
  }
  const sniffed = sniffImageMimeFromBytes(buffer);
  if (!sniffed) {
    const declared = declaredMime ? ` (declared ${declaredMime})` : '';
    return {
      ok: false,
      reason: 'non-image',
      detail: `${label} is not a PNG/JPEG/WebP/GIF image${declared}.`,
    };
  }
  return {
    ok: true,
    dataUrl: `data:${sniffed};base64,${buffer.toString('base64')}`,
    mime: sniffed,
    bytes: buffer.length,
    source,
  };
}

async function normalizeRemoteUrl(
  url: string,
  deps: Required<Pick<AvatarNormalizeDeps, 'timeoutMs' | 'maxBytes'>> & Pick<AvatarNormalizeDeps, 'fetchImpl'>,
  source: AvatarNormalizeSource = 'http-url',
): Promise<AvatarNormalizeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(deps.timeoutMs),
      headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        reason: 'fetch-timeout',
        detail: `Timed out after ${deps.timeoutMs}ms downloading ${url}.`,
      };
    }
    return { ok: false, reason: 'fetch-failed', detail: `Could not download ${url}: ${errMessage(error)}` };
  }

  if (!response.ok) {
    return { ok: false, reason: 'fetch-failed', detail: `Avatar URL returned HTTP ${response.status}.` };
  }

  const declaredMime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > deps.maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `Avatar is ${declaredLength} bytes, over the ${deps.maxBytes} byte cap.`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, reason: 'fetch-failed', detail: `Could not read the response body: ${errMessage(error)}` };
  }
  return finalizeBuffer(buffer, declaredMime, deps.maxBytes, url, source);
}

/**
 * Resolve a `metafile://<pinId>[.ext]` / bare-pinId avatar reference.
 *
 * Candidates are walked thumbnail-first (see `buildMetafileAvatarSourceUrls`).
 * Failure handling:
 * - `too-large` is terminal: a resolvable-but-oversized payload cannot shrink
 *   by asking another endpoint for the same file, and re-downloading a ~1 MB
 *   original a second time only burns time. The structured reason is returned.
 * - transport / non-image failures fall through to the next candidate (one
 *   gateway route may be stale while another still serves the file).
 * - when every candidate fails, the most informative reason is returned — a
 *   pin that answered 200 with non-image bytes is reported as `non-image`,
 *   never flattened into a generic network error.
 */
async function normalizeMetafileReference(
  reference: string,
  deps: Required<Pick<AvatarNormalizeDeps, 'timeoutMs' | 'maxBytes'>> & Pick<AvatarNormalizeDeps, 'fetchImpl'>,
): Promise<AvatarNormalizeResult> {
  const pinId = extractAvatarPinId(reference);
  if (!pinId) {
    return {
      ok: false,
      reason: 'unsupported-scheme',
      detail: 'Avatar metafile reference must be metafile://<64-hex pinId>[.png|.jpg|.jpeg|.webp|.gif] or a bare pinId.',
    };
  }

  const deadline = Date.now() + deps.timeoutMs;
  const failures: AvatarNormalizeFailure[] = [];
  for (const url of buildMetafileAvatarSourceUrls(pinId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      failures.push({
        ok: false,
        reason: 'fetch-timeout',
        detail: `Timed out after ${deps.timeoutMs}ms resolving metafile pin ${pinId}.`,
      });
      break;
    }
    const result = await normalizeRemoteUrl(url, { ...deps, timeoutMs: remaining }, 'metafile');
    if (!isAvatarNormalizeFailure(result)) {
      return result;
    }
    failures.push(result);
    if (result.reason === 'too-large') {
      return result;
    }
  }

  const reasons = new Set(failures.map((failure) => failure.reason));
  const dominantReason: AvatarNormalizeFailureReason = failures.length === 0
    ? 'fetch-failed'
    : reasons.size === 1
      ? failures[0].reason
      : reasons.has('non-image')
        ? 'non-image'
        : reasons.has('fetch-timeout')
          ? 'fetch-timeout'
          : 'fetch-failed';
  return {
    ok: false,
    reason: dominantReason,
    detail: `Could not resolve metafile pin ${pinId}: ${failures.map((failure) => `${failure.reason} (${failure.detail})`).join('; ')}`,
  };
}

async function normalizeLocalFile(
  filePath: string,
  deps: Required<Pick<AvatarNormalizeDeps, 'maxBytes'>> & Pick<AvatarNormalizeDeps, 'readFileImpl'>,
): Promise<AvatarNormalizeResult> {
  const readFileImpl = deps.readFileImpl ?? ((target: string) => fs.promises.readFile(target));
  let buffer: Buffer;
  try {
    buffer = await readFileImpl(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: 'read-failed',
      detail: `Could not read local avatar file ${filePath}: ${errMessage(error)}`,
    };
  }
  return finalizeBuffer(buffer, mimeHintFromExtension(filePath), deps.maxBytes, filePath, 'local-file');
}

/**
 * Normalize an avatar source to a base64 image data URL.
 *
 * - a valid `data:` URL is returned unchanged (`source: 'data-url'`);
 * - an `http(s)` URL is downloaded (timeout + size cap + magic-byte sniff)
 *   and converted (`source: 'http-url'`);
 * - a `metafile://<pinId>` reference or a bare pinId is resolved through the
 *   MetaID content gateway thumbnail-first (`source: 'metafile'`);
 * - an absolute local path is read and converted (`source: 'local-file'`).
 *
 * Never throws: every failure is a structured `{ ok: false, reason, detail }`
 * so callers can degrade instead of aborting the bot create/update flow.
 */
export async function normalizeAvatarToDataUrl(
  source: string | null | undefined,
  deps: AvatarNormalizeDeps = {},
): Promise<AvatarNormalizeResult> {
  const raw = typeof source === 'string' ? source.trim() : '';
  if (!raw) {
    return { ok: false, reason: 'empty', detail: 'Avatar source is empty.' };
  }

  const maxBytes = deps.maxBytes ?? AVATAR_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? AVATAR_FETCH_TIMEOUT_MS;

  if (raw.startsWith('data:')) {
    const match = DATA_URL_RE.exec(raw);
    if (isValidAvatarDataUrl(raw) && match) {
      return {
        ok: true,
        dataUrl: raw,
        mime: match[1].trim().toLowerCase(),
        bytes: Buffer.from(match[2], 'base64').length,
        source: 'data-url',
      };
    }
    return {
      ok: false,
      reason: 'invalid-data-url',
      detail: 'Not a supported image data URL (expected data:image/png|jpeg|webp|gif;base64,...).',
    };
  }

  if (raw.toLowerCase().startsWith('metafile://')) {
    return normalizeMetafileReference(raw, { ...deps, timeoutMs, maxBytes });
  }

  // A bare pin id is the reference shape the NFT wallet hands over (the item's
  // `cover` is `metafile://…`, but localized/legacy records can carry the bare
  // id). Checked before path.isAbsolute: a 66-char id is never a path.
  if (extractAvatarPinId(raw)) {
    return normalizeMetafileReference(raw, { ...deps, timeoutMs, maxBytes });
  }

  if (/^https?:\/\//i.test(raw)) {
    return normalizeRemoteUrl(raw, { ...deps, timeoutMs, maxBytes });
  }

  if (path.isAbsolute(raw)) {
    return normalizeLocalFile(raw, { ...deps, maxBytes });
  }

  return {
    ok: false,
    reason: 'unsupported-scheme',
    detail: 'Avatar must be a data URL, an http(s) image URL, a metafile:// pin reference, or an absolute local image path.',
  };
}

/** One-line human-readable description of a normalization outcome. */
export function describeAvatarFailure(result: AvatarNormalizeResult): string {
  if (isAvatarNormalizeFailure(result)) {
    return `${result.reason} — ${result.detail}`;
  }
  return `avatar normalized to a ${result.mime} data URL (${result.bytes} bytes)`;
}
