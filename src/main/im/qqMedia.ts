/**
 * QQ channel media helpers: inbound download + path safety, outbound pre-checks.
 *
 * The QQ Open Platform delivers media as signed HTTPS URLs on the inbound event
 * (`InboundAttachment.url`, and `voice_wav_url` for voice). The SDK deliberately
 * does not bundle remote-fetch logic ("The SDK does NOT bundle SSRF / remote-fetch
 * logic — those are concerns of the host application", `dist/protocol/utils/file-utils.js`),
 * so this module is that host-side guard.
 *
 * PATH SAFETY — every write goes through `resolveInsideQQMediaDir`, and every
 * remote-supplied name goes through `sanitizeQQFileName` first. The on-disk name
 * is generated locally; the remote name is only kept as display metadata.
 *
 * SIZE POLICY — inbound: refuse any single attachment above
 * `QQ_INBOUND_MAX_BYTES` (a client-side guard, see qqProtocol.ts); outbound: the
 * per-kind numbers come from the SDK's `MEDIA_FILE_TYPE_INFO` and are enforced
 * before any upload starts.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { IMMediaAttachment } from './types';
import {
  QQ_INBOUND_MAX_BYTES,
  classifyQQInbound,
  qqMediaLimitFor,
  redactQQSecrets,
  type QQMediaRef,
} from './qqProtocol';

export const QQ_FALLBACK_FILE_NAME = 'qq-file';
const MAX_FILE_NAME_LENGTH = 120;

export class QQMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QQMediaError';
  }
}

// ---------------------------------------------------------------------------
// Remote name / path safety
// ---------------------------------------------------------------------------

/**
 * Reduce a remote-supplied name to a single safe display name.
 * Strips directories (`/` AND `\`), control chars, path-hostile characters,
 * leading dots (`..`, hidden files) and over-long names.
 */
export function sanitizeQQFileName(raw: string | null | undefined, fallback = QQ_FALLBACK_FILE_NAME): string {
  if (typeof raw !== 'string') return fallback;
  const flattened = raw.replace(/\\/g, '/');
  const base = flattened.slice(flattened.lastIndexOf('/') + 1);
  let name = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  if (!name) return fallback;

  if (name.length > MAX_FILE_NAME_LENGTH) {
    const ext = path.extname(name).slice(0, 16);
    const stem = name.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - ext.length));
    name = `${stem}${ext}`;
  }
  return name;
}

/** Join `fileName` under `baseDir`, refusing anything that resolves outside it. */
export function resolveInsideQQMediaDir(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, fileName);
  const relative = path.relative(resolvedBase, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new QQMediaError('refusing to write outside the media directory');
  }
  return target;
}

/** Conversation id → a single safe directory segment. */
export function qqConversationDirName(conversationId: string): string {
  const safe = (conversationId || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[.]+/, '')
    .slice(0, 80);
  return safe || 'qq-conversation';
}

/** Locally generated, collision-resistant on-disk name (never the remote name). */
export function generateQQMediaFileName(params: {
  extension: string;
  now?: number;
  randomHex?: string;
}): string {
  const stamp = params.now ?? Date.now();
  const random = params.randomHex ?? crypto.randomBytes(4).toString('hex');
  const rawExt = (params.extension || '').toLowerCase();
  const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : '.bin';
  return `qq_${stamp}_${random}${ext}`;
}

// ---------------------------------------------------------------------------
// URL guard (SSRF)
// ---------------------------------------------------------------------------

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

/**
 * Validate a media URL before fetching.
 *
 * The exact CDN host set of the QQ Open Platform is not documented, so a static
 * allowlist would be guesswork. Instead we enforce the properties that actually
 * stop SSRF: HTTPS only, no userinfo, and no loopback / private / link-local
 * literal host. DNS rebinding is out of scope here and is documented as such.
 */
export function assertQQMediaUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new QQMediaError('media url is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new QQMediaError('media url must use https');
  }
  if (url.username || url.password) {
    throw new QQMediaError('media url must not carry userinfo');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new QQMediaError('media url has no host');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new QQMediaError('media url points at localhost');
  }
  if (isPrivateIpv4(host)) {
    throw new QQMediaError('media url points at a private address');
  }
  if (host.includes(':') && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
    throw new QQMediaError('media url points at a private address');
  }
  return url;
}

// ---------------------------------------------------------------------------
// MIME sniffing
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
  '.mkv': 'video/x-matroska',
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
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function extensionForQQMimeType(mimeType: string | undefined): string {
  if (!mimeType) return '.bin';
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  const found = Object.entries(MIME_BY_EXTENSION).find(([, value]) => value === normalized);
  if (found) return found[0];
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized.startsWith('text/')) return '.txt';
  return '.bin';
}

export function mimeTypeForQQFileName(fileName: string | undefined): string {
  const ext = path.extname(fileName || '').toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

/** Content sniffing for the formats we can recognise without a dependency. */
export function sniffQQMediaMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return null;
}

// ---------------------------------------------------------------------------
// Network surface
// ---------------------------------------------------------------------------

export interface QQMediaFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra request headers (the QQ CDN may require the inbound auth header). */
  headers?: Record<string, string>;
}

export interface QQMediaFetchResult {
  bytes: Buffer;
  contentType: string | null;
}

export interface QQMediaNetwork {
  /** GET a URL and return its body; must reject when the body exceeds `maxBytes`. */
  fetchBytes(url: string, options: QQMediaFetchOptions): Promise<QQMediaFetchResult>;
}

function linkAbort(source: AbortSignal | undefined, controller: AbortController): void {
  if (!source) return;
  if (source.aborted) controller.abort();
  else source.addEventListener('abort', () => controller.abort(), { once: true });
}

export const defaultQQMediaNetwork: QQMediaNetwork = {
  async fetchBytes(url, options) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? 60_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    linkAbort(options.signal, controller);
    try {
      assertQQMediaUrl(url);
      const response = await fetch(url, { signal: controller.signal, headers: options.headers });
      if (!response.ok) {
        throw new QQMediaError(`media download failed with HTTP ${response.status}`);
      }
      // `fetch` follows redirects. Re-validate the FINAL hop so a signed CDN URL
      // cannot bounce the request onto a private/loopback host.
      if (response.url) {
        assertQQMediaUrl(response.url);
      }
      const declared = Number(response.headers.get('content-length') || '');
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        throw new QQMediaError(`media download refused: declared size ${declared} exceeds ${options.maxBytes}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > options.maxBytes) {
        throw new QQMediaError(`media download refused: ${bytes.length} bytes exceeds ${options.maxBytes}`);
      }
      return { bytes, contentType: response.headers.get('content-type') };
    } finally {
      clearTimeout(timer);
    }
  },
};

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface QQDownloadParams {
  /** Directory the media root lives in; a per-conversation subdir is created. */
  mediaRootDir: string;
  conversationId: string;
  network?: QQMediaNetwork;
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra headers forwarded to the CDN request. */
  headers?: Record<string, string>;
}

export async function downloadQQMedia(ref: QQMediaRef, params: QQDownloadParams): Promise<IMMediaAttachment> {
  const network = params.network ?? defaultQQMediaNetwork;
  const now = params.now ?? (() => Date.now());
  const maxBytes = QQ_INBOUND_MAX_BYTES;

  if (typeof ref.size === 'number' && ref.size > maxBytes) {
    throw new QQMediaError(`media refused before download: declared ${ref.size} bytes exceeds ${maxBytes}`);
  }

  const fetched = await network.fetchBytes(ref.url, {
    maxBytes,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    headers: params.headers,
  });

  const sniffed = sniffQQMediaMime(fetched.bytes);
  const declaredType = (fetched.contentType || ref.contentType || '').split(';')[0].trim().toLowerCase();
  const mimeType = sniffed
    || (declaredType && declaredType !== 'application/octet-stream' ? declaredType : mimeTypeForQQFileName(ref.fileName));

  const kind = classifyQQInbound(mimeType, ref.fileName);
  const fallbackExt = extensionForQQMimeType(mimeType);
  const displayName = sanitizeQQFileName(ref.fileName, `qq-${kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'file'}${fallbackExt}`);
  const extension = path.extname(displayName) || fallbackExt;

  const dir = path.join(params.mediaRootDir, qqConversationDirName(params.conversationId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileName = generateQQMediaFileName({ extension, now: now() });
  const filePath = resolveInsideQQMediaDir(dir, fileName);
  fs.writeFileSync(filePath, fetched.bytes, { mode: 0o600 });

  return {
    type: kind,
    localPath: filePath,
    mimeType,
    fileName: displayName,
    fileSize: fetched.bytes.length,
    ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
    ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
  };
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * Validate one outbound file before the SDK starts an upload.
 * Returns the resolved kind and size; throws with a non-secret message when the
 * file is missing, empty or above the documented per-kind ceiling.
 */
export function checkQQOutboundFile(
  filePath: string,
  kind: 'image' | 'video' | 'voice' | 'file'
): { size: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new QQMediaError(`outbound media does not exist: ${path.basename(filePath)}`);
  }
  if (!stat.isFile()) {
    throw new QQMediaError(`outbound media is not a regular file: ${path.basename(filePath)}`);
  }
  if (stat.size <= 0) {
    throw new QQMediaError(`outbound media is empty: ${path.basename(filePath)}`);
  }
  const limit = qqMediaLimitFor(kind);
  if (stat.size > limit) {
    throw new QQMediaError(
      `outbound ${kind} is ${stat.size} bytes, above the platform ceiling of ${limit} bytes`
    );
  }
  return { size: stat.size };
}

/** Never let a fetch error that quotes a URL leak a query-string credential. */
export function describeQQMediaError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactQQSecrets(message.slice(0, 300));
}
