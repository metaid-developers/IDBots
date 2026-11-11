/**
 * Avatar source normalization (main process).
 *
 * Binary `/info/avatar` uploads accept a base64 image `data:` URL with a
 * supported image MIME (the canonical validator is `parseDataUrlAvatar` in
 * `services/metaidCore.ts`). Built-in avatars may instead use a MetaFile
 * reference handled directly by the sync validator. The metabot agent tools,
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

export type AvatarNormalizeSource = 'data-url' | 'http-url' | 'local-file';

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
  return finalizeBuffer(buffer, declaredMime, deps.maxBytes, url, 'http-url');
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

  if (/^https?:\/\//i.test(raw)) {
    return normalizeRemoteUrl(raw, { ...deps, timeoutMs, maxBytes });
  }

  if (path.isAbsolute(raw)) {
    return normalizeLocalFile(raw, { ...deps, maxBytes });
  }

  return {
    ok: false,
    reason: 'unsupported-scheme',
    detail: 'Avatar must be a data URL, an http(s) image URL, or an absolute local image path.',
  };
}

/** One-line human-readable description of a normalization outcome. */
export function describeAvatarFailure(result: AvatarNormalizeResult): string {
  if (isAvatarNormalizeFailure(result)) {
    return `${result.reason} — ${result.detail}`;
  }
  return `avatar normalized to a ${result.mime} data URL (${result.bytes} bytes)`;
}
