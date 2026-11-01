/**
 * Weixin (WeChat) media helpers: AES-128-ECB CDN crypto, remote filename and
 * path safety, inbound download + decrypt, outbound encrypt + upload priming.
 *
 * PROTOCOL (observed, not documented — see docs/weixin-media.md):
 *   1. `POST ilink/bot/getuploadurl` with the plaintext size (`rawsize`), the
 *      PKCS#7-padded ciphertext size (`filesize`), the plaintext MD5
 *      (`rawfilemd5`), a random `filekey` and the AES key as a 32-char hex
 *      string (`aeskey`) returns `upload_full_url` (preferred) or
 *      `upload_param` + the CDN base.
 *   2. The ciphertext is POSTed to the CDN as `application/octet-stream`.
 *      The response header `x-encrypted-param` is the DOWNLOAD credential.
 *   3. Download is `GET <cdn>/download?encrypted_query_param=<param>` and the
 *      body is AES-128-ECB/PKCS#7 ciphertext.
 *   4. `CDNMedia.aes_key` appears in two encodings in the wild:
 *        - base64(raw 16 bytes)          (images, `media.aes_key`)
 *        - base64(32-char hex string)    (file / video / voice, and everything
 *                                         we send)
 *      `image_item.aeskey` is the raw 16-byte key already hex-encoded.
 *
 * SECRET HANDLING — `aes_key`, `encrypt_query_param`, `upload_param` and the
 * derived URLs are download credentials. Nothing in this file logs them; error
 * messages carry sizes and kinds only.
 *
 * PATH SAFETY — every local write goes through `resolveInsideDir`, and every
 * remote-supplied filename goes through `sanitizeWeixinFileName` first. The
 * on-disk name is generated locally; the remote name is only kept as display
 * metadata (`IMMediaAttachment.fileName`).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { IMMediaAttachment, IMMediaType } from './types';
import {
  WEIXIN_ITEM_TYPE_FILE,
  WEIXIN_ITEM_TYPE_IMAGE,
  WEIXIN_ITEM_TYPE_VIDEO,
  type WeixinMessageItem,
} from './weixinProtocol';

/** CDN root used for both upload and download. */
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * Hosts we are willing to fetch media from. The `full_url` field comes from the
 * server, so it is treated as untrusted input: without an allowlist a hostile
 * (or compromised) response could point us at arbitrary internal addresses.
 */
export const WEIXIN_CDN_HOST_ALLOWLIST = new Set([
  'novac2c.cdn.weixin.qq.com',
  'ilinkai.weixin.qq.com',
]);

/** Per-image inbound cap (matches the Telegram channel's 30 MB image口径). */
export const WEIXIN_INBOUND_MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/**
 * Per-file inbound cap. 100 MB, read from the official plugin:
 * `@tencent-weixin/openclaw-weixin@2.4.10` `src/media/media-download.ts:9`
 * (`const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;`), used by the FILE branch.
 */
export const WEIXIN_INBOUND_MAX_FILE_BYTES = 100 * 1024 * 1024;
/**
 * Per-video inbound cap — deliberately its own constant: a video is not an image,
 * and reusing the 30 MB image guard would silently drop ordinary phone videos.
 *
 * Provenance (verified, not chosen): the official plugin carries ONE media
 * ceiling, `WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024`
 * (`@tencent-weixin/openclaw-weixin@2.4.10`, `src/media/media-download.ts:9`), and
 * its VIDEO branch passes exactly that number to `saveMedia(...)`
 * (`src/media/media-download.ts:145`). 100 MB is therefore the only video number
 * the vendor code actually states. It is a *client-side save guard*, not a
 * documented server limit; the plugin's other size knob `maxSingleMediaBytes`
 * (25 MB, `src/config/config-schema.ts:44`) is a quote-cache retention budget and
 * says nothing about transfer. Full table: `docs/weixin-media.md` §5.
 */
export const WEIXIN_INBOUND_MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Max attachments kept from ONE inbound message (Telegram parity). */
export const WEIXIN_INBOUND_MAX_ATTACHMENTS = 20;
/**
 * Outbound safety ceiling. NOT a documented platform limit: the official plugin
 * declares no server-side send limit and uses 100 MB as its media ceiling
 * (`WEIXIN_MEDIA_MAX_BYTES`), so we refuse above the same number instead of
 * inventing a smaller one.
 */
export const WEIXIN_OUTBOUND_MAX_BYTES = 100 * 1024 * 1024;
/** Images larger than this are re-encoded before upload (our own guard). */
export const WEIXIN_IMAGE_COMPRESS_BYTES = 4 * 1024 * 1024;
/** Images with a side longer than this are re-encoded before upload. */
export const WEIXIN_IMAGE_MAX_SIDE_PX = 4096;

/** `getuploadurl.media_type` values. */
export const WEIXIN_UPLOAD_MEDIA_TYPE = {
  image: 1,
  video: 2,
  file: 3,
  voice: 4,
} as const;

export type WeixinUploadMediaType = (typeof WEIXIN_UPLOAD_MEDIA_TYPE)[keyof typeof WEIXIN_UPLOAD_MEDIA_TYPE];

/** Raised for media protocol/validation problems; messages never carry secrets. */
export class WeixinMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeixinMediaError';
  }
}

// ---------------------------------------------------------------------------
// AES-128-ECB
// ---------------------------------------------------------------------------

/**
 * Ciphertext size after PKCS#7 padding to the 16-byte block boundary.
 * Equivalent to `Math.ceil((plaintextSize + 1) / 16) * 16`.
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  if (!Number.isFinite(plaintextSize) || plaintextSize < 0) {
    throw new WeixinMediaError(`invalid plaintext size: ${plaintextSize}`);
  }
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new WeixinMediaError('AES-128-ECB key must be 16 bytes');
  }
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new WeixinMediaError('AES-128-ECB key must be 16 bytes');
  }
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new WeixinMediaError(`ciphertext is not a whole number of AES blocks (${ciphertext.length} bytes)`);
  }
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Decode `CDNMedia.aes_key`.
 *
 * Two encodings are accepted, as required by the task brief:
 *   - base64 that decodes to 16 raw bytes        → the key itself (images)
 *   - base64 that decodes to 32 hex characters   → hex text of the key
 *     (file / video / voice, and everything we send)
 */
export function parseWeixinAesKey(aesKeyBase64: string): Buffer {
  if (typeof aesKeyBase64 !== 'string' || aesKeyBase64.trim() === '') {
    throw new WeixinMediaError('aes_key is empty');
  }
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32) {
    const text = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(text)) {
      return Buffer.from(text, 'hex');
    }
  }
  throw new WeixinMediaError(
    `aes_key must decode to 16 raw bytes or 32 hex characters, got ${decoded.length} bytes`
  );
}

/** AES key hex (32 chars) → the base64-of-hex form the CDNMedia field expects. */
export function weixinAesKeyToCdnField(aesKeyHex: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(aesKeyHex)) {
    throw new WeixinMediaError('aes key hex must be 32 hex characters');
  }
  return Buffer.from(aesKeyHex, 'ascii').toString('base64');
}

// ---------------------------------------------------------------------------
// CDN URLs
// ---------------------------------------------------------------------------

export function buildWeixinCdnDownloadUrl(
  encryptedQueryParam: string,
  cdnBaseUrl: string = WEIXIN_CDN_BASE_URL
): string {
  const base = cdnBaseUrl.replace(/\/+$/, '');
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildWeixinCdnUploadUrl(params: {
  uploadParam: string;
  filekey: string;
  cdnBaseUrl?: string;
}): string {
  const base = (params.cdnBaseUrl || WEIXIN_CDN_BASE_URL).replace(/\/+$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

/** Throws when a server-supplied URL points outside the WeChat CDN allowlist. */
export function assertWeixinCdnUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WeixinMediaError('media URL is not parseable');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WeixinMediaError(`media URL scheme ${parsed.protocol} is not allowed`);
  }
  if (!WEIXIN_CDN_HOST_ALLOWLIST.has(parsed.hostname)) {
    throw new WeixinMediaError(`media URL host ${parsed.hostname} is not a WeChat CDN host`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Filenames and paths
// ---------------------------------------------------------------------------

const FALLBACK_FILE_NAME = 'weixin-file';
const MAX_FILE_NAME_LENGTH = 120;

/**
 * Clean a remote filename for display/storage metadata.
 *
 * Remote names are attacker-controlled in the worst case: strip directory
 * components on both separators, control characters, Windows-reserved
 * characters, leading dots (hidden files) and trailing dots/spaces, then cap the
 * length while keeping the extension.
 */
export function sanitizeWeixinFileName(raw: string | null | undefined, fallback = FALLBACK_FILE_NAME): string {
  if (typeof raw !== 'string') return fallback;
  // Treat backslashes as separators too, so `..\..\x` cannot survive as one name.
  const flattened = raw.replace(/\\/g, '/');
  const base = flattened.slice(flattened.lastIndexOf('/') + 1);
  let name = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  // `.` / `..` and leading-dot hidden names carry no information we need.
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  if (!name) return fallback;

  if (name.length > MAX_FILE_NAME_LENGTH) {
    const ext = path.extname(name).slice(0, 16);
    const stem = name.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - ext.length));
    name = `${stem}${ext}`;
  }
  return name;
}

/**
 * Join `fileName` under `baseDir`, refusing anything that resolves outside it.
 * This is the only place local media paths are produced.
 */
export function resolveInsideDir(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, fileName);
  const relative = path.relative(resolvedBase, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WeixinMediaError('refusing to write outside the media directory');
  }
  return target;
}

/** Locally generated, collision-resistant on-disk name (never the remote name). */
export function generateWeixinMediaFileName(params: {
  extension: string;
  now?: number;
  randomHex?: string;
}): string {
  const stamp = params.now ?? Date.now();
  const random = params.randomHex ?? crypto.randomBytes(4).toString('hex');
  const ext = params.extension.startsWith('.') ? params.extension : `.${params.extension}`;
  return `weixin_${stamp}_${random}${ext}`;
}

// ---------------------------------------------------------------------------
// MIME sniffing (no new dependency)
// ---------------------------------------------------------------------------

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  // Text-ish MIME types: without these an inbound .txt/.md/.json/.csv lands as
  // `.bin`, which hides what the file actually is from the agent.
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
};

export function mimeFromFileName(fileName: string | null | undefined): string {
  if (!fileName) return 'application/octet-stream';
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] || '.bin';
}

/** Detect common image formats from magic bytes; null when not a known image. */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return null;
}

// ---------------------------------------------------------------------------
// Inbound: item_list → media references
// ---------------------------------------------------------------------------

export interface WeixinMediaRef {
  kind: 'image' | 'video' | 'file';
  /** CDN download credential (never logged). */
  encryptQueryParam: string | null;
  /** Server-supplied absolute URL; used instead of the constructed one when present. */
  fullUrl: string | null;
  /** `CDNMedia.aes_key` as received (base64), null when the item carries no key. */
  aesKeyBase64: string | null;
  /** `image_item.aeskey` as received (raw key hex), null when absent. */
  aesKeyHex: string | null;
  /** Remote filename, unsanitized. Sanitize before any use. */
  fileName: string | null;
  /** Server-reported plaintext size hint, when present. */
  sizeHint: number | null;
  /** `video_item.play_length` exactly as received; absent for non-video items. */
  playLength?: number | null;
}

/**
 * Unit of `video_item.play_length`.
 *
 * VERIFIED by a live sample on 2026-11-02: the WeChat client delivered a clip
 * whose measured duration is 9.0417 s (`ffprobe`) and `video_item.play_length`
 * was `9` — seconds, truncated to an integer. Vendor code alone could not settle
 * this: the field is declared in `@tencent-weixin/openclaw-weixin@2.4.10`
 * `src/api/types.ts:139` but never read anywhere in that package. The sample is
 * the proof; `docs/weixin-media-verification.md` keeps the log line and path.
 */
export const WEIXIN_VIDEO_PLAY_LENGTH_UNIT: 'unknown' | 's' | 'ms' = 's';

/** Convert `play_length` to seconds when (and only when) its unit is proven. */
export function weixinPlayLengthToSeconds(
  playLength: number | null | undefined,
  unit: 'unknown' | 's' | 'ms' = WEIXIN_VIDEO_PLAY_LENGTH_UNIT
): number | null {
  if (playLength == null || !Number.isFinite(playLength) || playLength < 0) return null;
  if (unit === 's') return playLength;
  if (unit === 'ms') return Math.round((playLength / 1000) * 10) / 10;
  return null;
}

export interface WeixinMediaRefResult {
  refs: WeixinMediaRef[];
  /** Kinds present in the message but dropped by the image > video > file rule. */
  droppedKinds: string[];
  /** Items that matched a media kind but carried no usable credential. */
  unusable: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(source: Record<string, unknown> | null, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readCdnMedia(item: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const holder = asRecord(item[key]);
  return asRecord(holder?.media);
}

function toRef(item: WeixinMessageItem, kind: WeixinMediaRef['kind']): WeixinMediaRef | null {
  const record = asRecord(item);
  if (!record) return null;
  const itemKey = kind === 'image' ? 'image_item' : kind === 'video' ? 'video_item' : 'file_item';
  const holder = asRecord(record[itemKey]);
  const media = readCdnMedia(record, itemKey);
  const encryptQueryParam = readString(media, 'encrypt_query_param');
  const fullUrl = readString(media, 'full_url');
  if (!encryptQueryParam && !fullUrl) return null;

  return {
    kind,
    encryptQueryParam,
    fullUrl,
    aesKeyBase64: readString(media, 'aes_key'),
    aesKeyHex: kind === 'image' ? readString(holder, 'aeskey') : null,
    fileName: kind === 'file' ? readString(holder, 'file_name') : null,
    sizeHint: readNumber(holder, kind === 'image' ? ['mid_size', 'hd_size'] : kind === 'video' ? ['video_size'] : ['len']),
    playLength: kind === 'video' ? readNumber(holder, ['play_length']) : null,
  };
}

/**
 * Extract downloadable media references from one inbound message.
 *
 * Priority rule from the task brief: image > video > file. When a message mixes
 * kinds only the highest-priority kind is kept, and the dropped kinds are
 * reported so the caller can log them instead of dropping silently. Voice is
 * intentionally not downloaded (out of scope for this version; a voice item with
 * a `text` transcript is surfaced as text by the protocol layer).
 */
export function readWeixinMediaRefs(itemList: WeixinMessageItem[] | undefined): WeixinMediaRefResult {
  if (!Array.isArray(itemList) || itemList.length === 0) {
    return { refs: [], droppedKinds: [], unusable: 0 };
  }

  const buckets: Record<WeixinMediaRef['kind'], WeixinMediaRef[]> = { image: [], video: [], file: [] };
  let unusable = 0;

  for (const item of itemList) {
    const type = typeof item?.type === 'number' ? item.type : null;
    const kind: WeixinMediaRef['kind'] | null =
      type === WEIXIN_ITEM_TYPE_IMAGE ? 'image'
        : type === WEIXIN_ITEM_TYPE_VIDEO ? 'video'
          : type === WEIXIN_ITEM_TYPE_FILE ? 'file'
            : null;
    if (!kind) continue;
    const ref = toRef(item, kind);
    if (ref) {
      buckets[kind].push(ref);
    } else {
      unusable += 1;
    }
  }

  const order: Array<WeixinMediaRef['kind']> = ['image', 'video', 'file'];
  const chosen = order.find((kind) => buckets[kind].length > 0);
  if (!chosen) {
    return { refs: [], droppedKinds: [], unusable };
  }
  const droppedKinds = order.filter((kind) => kind !== chosen && buckets[kind].length > 0);
  return { refs: buckets[chosen], droppedKinds, unusable };
}

/** Map a media reference kind onto the shared IMMediaType contract. */
export function imMediaTypeFor(kind: WeixinMediaRef['kind']): IMMediaType {
  return kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'document';
}

// ---------------------------------------------------------------------------
// Inbound: download + decrypt + persist
// ---------------------------------------------------------------------------

export interface WeixinMediaFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WeixinMediaPostResult {
  status: number;
  /** `x-encrypted-param` — the download credential for the uploaded object. */
  encryptedParam: string | null;
  /** Short, already-redacted diagnostic body for non-200 responses. */
  errorText?: string;
}

/** Minimal network surface the media layer needs; injectable so tests stay offline. */
export interface WeixinMediaNetwork {
  /** GET a URL and return its body; must reject when the body exceeds `maxBytes`. */
  fetchBytes(url: string, options: WeixinMediaFetchOptions): Promise<Buffer>;
  /** POST raw bytes (the ciphertext) and return the download credential header. */
  postBytes(
    url: string,
    body: Buffer,
    options: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<WeixinMediaPostResult>;
}

function linkAbort(source: AbortSignal | undefined, controller: AbortController): void {
  if (!source) return;
  if (source.aborted) controller.abort();
  else source.addEventListener('abort', () => controller.abort(), { once: true });
}

export const defaultWeixinMediaNetwork: WeixinMediaNetwork = {
  async fetchBytes(url, options) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? 60_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    linkAbort(options.signal, controller);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new WeixinMediaError(`CDN download failed with HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get('content-length') || '');
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        throw new WeixinMediaError(`CDN download refused: declared size ${declared} exceeds ${options.maxBytes}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > options.maxBytes) {
        throw new WeixinMediaError(`CDN download refused: ${buffer.length} bytes exceeds ${options.maxBytes}`);
      }
      return buffer;
    } finally {
      clearTimeout(timer);
    }
  },

  async postBytes(url, body, options) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    linkAbort(options.signal, controller);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          status: response.status,
          encryptedParam: null,
          errorText: redactMediaSecrets(text.slice(0, 200)),
        };
      }
      const encryptedParam = response.headers.get('x-encrypted-param');
      return { status: response.status, encryptedParam: encryptedParam || null };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Mask the two CDN credentials that may ride inside error strings (for example a
 * fetch error quoting the request URL) before they reach a log line.
 */
export function redactMediaSecrets(text: string): string {
  return text
    .replace(/(encrypted_query_param=)([^&#\s"']+)/gi, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(/(upload_param=)([^&#\s"']+)/gi, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(/("aes_key"\s*:\s*")([^"]+)(")/gi, (_match, prefix: string, _value: string, suffix: string) => `${prefix}[REDACTED]${suffix}`);
}

export interface WeixinDownloadParams {
  /** Media directory; every write is confined to it. */
  dir: string;
  network?: WeixinMediaNetwork;
  now?: () => number;
  signal?: AbortSignal;
  /** Cap for this item; defaults to the per-kind inbound cap. */
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Download one media reference, decrypt it, and persist it under `dir`.
 *
 * Throws WeixinMediaError on missing credentials, oversize bodies, decrypt
 * failures and path escapes. Callers must degrade (warn + keep the message),
 * never drop the whole inbound message.
 */
export async function downloadWeixinMedia(
  ref: WeixinMediaRef,
  params: WeixinDownloadParams
): Promise<IMMediaAttachment> {
  const network = params.network ?? defaultWeixinMediaNetwork;
  const maxBytes = params.maxBytes
    ?? (ref.kind === 'image'
      ? WEIXIN_INBOUND_MAX_IMAGE_BYTES
      : ref.kind === 'video'
        ? WEIXIN_INBOUND_MAX_VIDEO_BYTES
        : WEIXIN_INBOUND_MAX_FILE_BYTES);

  let url: string;
  if (ref.fullUrl) {
    url = assertWeixinCdnUrl(ref.fullUrl).toString();
  } else if (ref.encryptQueryParam) {
    url = buildWeixinCdnDownloadUrl(ref.encryptQueryParam);
    assertWeixinCdnUrl(url);
  } else {
    throw new WeixinMediaError('media item has neither encrypt_query_param nor full_url');
  }

  const encrypted = await network.fetchBytes(url, {
    maxBytes,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  let key: Buffer | null = null;
  if (ref.aesKeyHex) {
    if (!/^[0-9a-fA-F]{32}$/.test(ref.aesKeyHex)) {
      throw new WeixinMediaError('image aeskey is not 32 hex characters');
    }
    key = Buffer.from(ref.aesKeyHex, 'hex');
  } else if (ref.aesKeyBase64) {
    key = parseWeixinAesKey(ref.aesKeyBase64);
  }

  let plaintext = encrypted;
  if (key) {
    try {
      plaintext = decryptAesEcb(encrypted, key);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WeixinMediaError(`AES decrypt failed: ${reason}`);
    }
  }

  const sniffed = sniffImageMime(plaintext);
  const fallbackName = sniffed
    ? `weixin-image${extensionForMime(sniffed)}`
    : ref.kind === 'video'
      ? 'weixin-video.mp4'
      : undefined;
  const displayName = sanitizeWeixinFileName(ref.fileName, fallbackName);
  const mimeType = sniffed
    || (ref.fileName
      ? mimeFromFileName(ref.fileName)
      // The vendor plugin saves every inbound video as video/mp4
      // (`src/media/media-download.ts:145`), so that is the honest default here.
      : ref.kind === 'image'
        ? 'image/jpeg'
        : ref.kind === 'video'
          ? 'video/mp4'
          : 'application/octet-stream');
  const extension = sniffed ? extensionForMime(sniffed) : extensionForMime(mimeType);

  fs.mkdirSync(params.dir, { recursive: true });
  const diskName = generateWeixinMediaFileName({
    extension,
    now: params.now ? params.now() : undefined,
  });
  const localPath = resolveInsideDir(params.dir, diskName);
  fs.writeFileSync(localPath, plaintext, { mode: 0o600 });

  const attachment: IMMediaAttachment = {
    type: imMediaTypeFor(ref.kind),
    localPath,
    mimeType,
    fileName: displayName,
    fileSize: plaintext.length,
  };
  // Video metadata: duration only once its unit is proven, and width/height not at
  // all — the protocol's only dimension fields are `thumb_width` / `thumb_height`,
  // which describe the THUMBNAIL, not the video frame. Copying those into
  // `width`/`height` would be a fabricated fact.
  if (ref.kind === 'video') {
    const seconds = weixinPlayLengthToSeconds(ref.playLength);
    if (seconds != null) attachment.duration = seconds;
  }
  return attachment;
}

// ---------------------------------------------------------------------------
// Outbound: prepare ciphertext + build the item_list entry
// ---------------------------------------------------------------------------

export interface PreparedWeixinUpload {
  /** 32-char hex AES key; also the `aeskey` field of getuploadurl. */
  aesKeyHex: string;
  filekey: string;
  /** Plaintext size, sent as `rawsize`. */
  rawsize: number;
  /** PKCS#7-padded ciphertext size, sent as `filesize`. */
  filesize: number;
  /** Plaintext MD5, sent as `rawfilemd5`. */
  rawfilemd5: string;
  ciphertext: Buffer;
}

export function prepareWeixinUpload(plaintext: Buffer, options?: { randomBytes?: (n: number) => Buffer }): PreparedWeixinUpload {
  const random = options?.randomBytes ?? ((n: number) => crypto.randomBytes(n));
  const aesKey = random(16);
  if (aesKey.length !== 16) {
    throw new WeixinMediaError('generated AES key is not 16 bytes');
  }
  const filekey = random(16).toString('hex');
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  return {
    aesKeyHex: aesKey.toString('hex'),
    filekey,
    rawsize: plaintext.length,
    filesize: ciphertext.length,
    rawfilemd5: crypto.createHash('md5').update(plaintext).digest('hex'),
    ciphertext,
  };
}

/**
 * Build the `sendmessage.item_list` media entry.
 *
 * Shape per kind (from the official plugin):
 *   image → `image_item { media, mid_size: <ciphertext bytes> }`
 *   video → `video_item { media, video_size: <ciphertext bytes> }`
 *   file  → `file_item  { media, file_name, len: "<plaintext bytes>" }`
 * `media.aes_key` is base64(hex text) — NOT base64(raw key); sending the raw
 * form makes the receiver render a grey box.
 */
export function buildWeixinMediaItem(params: {
  kind: WeixinMediaRef['kind'];
  downloadEncryptedQueryParam: string;
  prepared: PreparedWeixinUpload;
  fileName?: string | null;
}): WeixinMessageItem {
  const media = {
    encrypt_query_param: params.downloadEncryptedQueryParam,
    aes_key: weixinAesKeyToCdnField(params.prepared.aesKeyHex),
    encrypt_type: 1,
  };

  if (params.kind === 'image') {
    return { type: WEIXIN_ITEM_TYPE_IMAGE, image_item: { media, mid_size: params.prepared.filesize } };
  }
  if (params.kind === 'video') {
    return { type: WEIXIN_ITEM_TYPE_VIDEO, video_item: { media, video_size: params.prepared.filesize } };
  }
  return {
    type: WEIXIN_ITEM_TYPE_FILE,
    file_item: {
      media,
      file_name: sanitizeWeixinFileName(params.fileName, 'weixin-file.bin'),
      len: String(params.prepared.rawsize),
    },
  };
}

/** Which upload media_type a local file should use. */
export function uploadKindForFile(fileName: string): { kind: WeixinMediaRef['kind']; mediaType: WeixinUploadMediaType } {
  const mime = mimeFromFileName(fileName);
  if (mime.startsWith('image/')) return { kind: 'image', mediaType: WEIXIN_UPLOAD_MEDIA_TYPE.image };
  if (mime.startsWith('video/')) return { kind: 'video', mediaType: WEIXIN_UPLOAD_MEDIA_TYPE.video };
  return { kind: 'file', mediaType: WEIXIN_UPLOAD_MEDIA_TYPE.file };
}
