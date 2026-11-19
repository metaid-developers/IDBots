/**
 * Private chat FILE messages — `/protocols/simplefilemsg`.
 *
 * The protocol payload is PLAINTEXT JSON (`to` / `encrypt` / `attachment` /
 * `fileType` / `timestamp` / `replyPin`); the attachment it points at is a
 * metafile whose BODY is AES-256-CBC ciphertext keyed by the two chat keys'
 * ECDH shared secret (raw 32 bytes, IV = 16 ASCII `0`, PKCS7).
 *
 * Why this module exists: the private-chat daemon used to feed the message
 * `content` through the TEXT decrypt path. For a file message that content is
 * the plaintext URI `metafile://<pin>`, so AES-decrypting it always failed,
 * the row stayed `is_processed = 0` forever, and the message never reached the
 * conversation — a silent loss. See the daemon's file-message branch.
 *
 * Display contract: the decrypted file is written to a local path and the
 * message body carries the app-wide attachment marker line
 * (`Attachment path: <abs>`), which the renderer already splits out into a
 * thumbnail strip (UserAttachmentBody) and the runner already stages for the
 * model (coworkRunner preparePromptForSandbox). Nothing new is invented.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'buffer';
import { decryptPrivateFileBuffer } from './metaWebCrypto';

export const PRIVATE_CHAT_FILE_MESSAGE_PROTOCOL = '/protocols/simplefilemsg';

const ACCELERATE_CONTENT_BASE =
  'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/';
const DIRECT_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content/';
const INBOUND_DIR_NAME = 'private-chat-inbound';
/** A chat attachment is not a file transfer: cap the body we pull into memory. */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type PrivateChatFileKind = 'image' | 'video' | 'audio' | 'file';

export interface PrivateChatFilePayload {
  /** Canonical `metafile://<pinId>` (no extension suffix). */
  attachment: string;
  /** Protocol `fileType`: `jpeg`, `png`, `pdf`, or a MIME string. */
  fileType: string;
  /** Protocol `encrypt`: `aes` / `ecdh` for encrypted bodies, `0`/`none` otherwise. */
  encrypt: string;
  nickName?: string;
  replyPin?: string;
}

export interface PrivateChatFileAttachment {
  kind: PrivateChatFileKind;
  /** Absolute path of the decrypted (or, when the sender skipped encryption, raw) body. */
  localPath: string;
  mimeType: string;
  fileName: string;
  metafileUri: string;
  size: number;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'avif', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
};

/** `jpeg` / `.jpeg` / `image/jpeg` → `jpeg`. */
export const normalizeFileType = (fileType: string | null | undefined): string => {
  const raw = String(fileType ?? '').trim().toLowerCase();
  if (!raw) return '';
  const leaf = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return leaf.replace(/^\./, '').replace(/[^a-z0-9]/g, '');
};

export const classifyFileType = (fileType: string | null | undefined): PrivateChatFileKind => {
  const ext = normalizeFileType(fileType);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'file';
};

export const mimeTypeForFileType = (fileType: string | null | undefined): string => {
  const ext = normalizeFileType(fileType);
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
};

/** `jpeg` and `jpg` name the same extension; keep one canonical spelling. */
const extensionForFileType = (fileType: string | null | undefined): string => {
  const ext = normalizeFileType(fileType);
  if (ext === 'jpeg') return 'jpg';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
};

/**
 * Does this row carry a private-chat FILE message? Accepts `/protocols/simplefilemsg`,
 * `simplefilemsg`, and any case/trailing-slash variant the indexer may hand us.
 */
export const isPrivateChatFileMessageProtocol = (protocol: string | null | undefined): boolean => {
  const normalized = String(protocol ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (!normalized) return false;
  return normalized === PRIVATE_CHAT_FILE_MESSAGE_PROTOCOL
    || normalized === 'simplefilemsg'
    || normalized.endsWith('/simplefilemsg');
};

/** `metafile://<64-hex>i<n>` (with or without a trailing `.ext`) → pinId. */
export const metafilePinIdFromUri = (uri: string | null | undefined): string => {
  const raw = String(uri ?? '').trim();
  const match = /^metafile:\/\/([0-9a-fA-F]{64}i\d+)/.exec(raw);
  return match ? match[1] : '';
};

const canonicalMetafileUri = (uri: string): string => {
  const pinId = metafilePinIdFromUri(uri);
  return pinId ? `metafile://${pinId}` : '';
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const firstString = (record: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

/**
 * Parse a `/protocols/simplefilemsg` payload.
 *
 * Two shapes reach this function and both must work:
 *  - the indexer-normalized row `content` (a bare `metafile://<pin>` string);
 *  - the raw pin body (the protocol JSON, possibly wrapped as `{ content: "<json>" }`).
 */
export const parsePrivateChatFileMessagePayload = (
  raw: string | null | undefined,
  fileTypeHint?: string | null,
): PrivateChatFilePayload | null => {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const fromUri = (value: string): PrivateChatFilePayload | null => {
    const attachment = canonicalMetafileUri(value);
    if (!attachment) return null;
    return {
      attachment,
      fileType: normalizeFileType(fileTypeHint ?? ''),
      encrypt: 'aes',
    };
  };

  if (/^metafile:\/\//i.test(text)) return fromUri(text);

  let candidate = text;
  try {
    const outer = asRecord(JSON.parse(text));
    const inner = outer ? firstString(outer, ['content']) : '';
    if (inner) candidate = inner;
  } catch {
    // Not a wrapper; fall through to the payload parse.
  }

  // The indexer's `raw_data` carries the whole message and its `content` is
  // the normalized attachment URI, so the unwrapped candidate can be the URI
  // itself rather than the protocol JSON.
  if (/^metafile:\/\//i.test(candidate)) return fromUri(candidate);

  let payload: Record<string, unknown> | null = null;
  try {
    payload = asRecord(JSON.parse(candidate));
  } catch {
    payload = null;
  }
  if (!payload) return null;

  const rawAttachment = firstString(payload, ['attachment', 'attachments', 'file', 'url']);
  const attachment = canonicalMetafileUri(rawAttachment);
  if (!attachment) return null;

  return {
    attachment,
    fileType: normalizeFileType(firstString(payload, ['fileType', 'file_type', 'type']) || fileTypeHint || ''),
    encrypt: firstString(payload, ['encrypt', 'encryption']).toLowerCase(),
    nickName: firstString(payload, ['nickName', 'nickname', 'name']) || undefined,
    replyPin: firstString(payload, ['replyPin', 'reply_pin']) || undefined,
  };
};

const isEncryptedBody = (encrypt: string): boolean => {
  const value = encrypt.trim().toLowerCase();
  if (!value) return true; // private-chat file bodies are encrypted by default
  if (value === '0' || value === 'false' || value === 'none' || value === 'plain') return false;
  return true;
};

/** Magic-byte check so an unencrypted image body can be told apart from ciphertext. */
const looksLikeKnownImage = (bytes: Buffer): boolean => {
  if (!bytes || bytes.length < 12) return false;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true; // JPEG
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return true;
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  return false;
};

const resolveInboundDir = (): string => {
  let baseDir = '';
  try {
    // Lazy require: this module must stay loadable outside a running Electron
    // app (unit tests, headless harnesses) where `require('electron')` either
    // throws or resolves to a path string instead of the API object.
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } };
    baseDir = electron?.app?.getPath?.('userData') ?? '';
  } catch {
    baseDir = '';
  }
  return path.join(baseDir || os.tmpdir(), INBOUND_DIR_NAME);
};

/** The inbound directory name (under userData), shared with the read scope. */
export const PRIVATE_CHAT_INBOUND_DIR_NAME = INBOUND_DIR_NAME;

/**
 * Whether a resolved absolute path may be read for a PEER-attachment image
 * preview (`scope: 'peer-attachment'` on cowork:session:readLocalImage).
 *
 * A peer's message body is attacker-controlled text: without this scoping any
 * `Attachment path: C:\Users\victim\secret.png` marker line in an inbound
 * message would make the victim's app read that local file and render it in
 * the chat. Daemon-written markers always name this directory
 * (materializePrivateChatFileMessage writes only here), so the legit inbound
 * thumbnail feature keeps working while every other path is refused.
 * `baseDir` is the SAME base resolveInboundDir uses (userData; the tmpdir
 * fallback is the headless/test shape).
 */
export function isPeerAttachmentReadablePath(resolvedPath: string, baseDir: string): boolean {
  const root = path.resolve(baseDir || os.tmpdir(), INBOUND_DIR_NAME);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const candidate = path.resolve(String(resolvedPath || ''));
  const foldCase = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return foldCase(candidate).startsWith(foldCase(rootWithSep));
}

const fetchMetafileBytes = async (
  pinId: string,
  emitLog: (message: string) => void,
): Promise<Buffer | null> => {
  const encoded = encodeURIComponent(pinId);
  for (const base of [ACCELERATE_CONTENT_BASE, DIRECT_CONTENT_BASE]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${encoded}`, { signal: controller.signal });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) continue;
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        emitLog(
          `[PrivateChat] File message attachment ${pinId.slice(0, 12)}… is ${bytes.length} bytes, above the ${MAX_ATTACHMENT_BYTES}-byte chat limit; not materialized.`
        );
        return null;
      }
      return bytes;
    } catch (error) {
      emitLog(
        `[PrivateChat] File message attachment fetch failed (${pinId.slice(0, 12)}…, ${base.includes('accelerate') ? 'accelerate' : 'direct'}): ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};

/**
 * Download, decrypt and persist one file-message attachment.
 *
 * @returns the local attachment descriptor, or null when the body could not be
 * fetched/decrypted — the caller then still stores a visible notice instead of
 * dropping the message.
 */
export async function materializePrivateChatFileMessage(params: {
  payload: PrivateChatFilePayload;
  /**
   * ECDH shared secrets to try, in order. The reference client encrypts the
   * file body with the sha256 variant (`computeEcdhSharedSecretSha256`); the
   * raw secret is the legacy/second variant the text path also falls back to.
   */
  sharedSecretCandidates: string[];
  emitLog: (message: string) => void;
  /** Test seam: overrides the userData inbound directory. */
  inboundDir?: string;
}): Promise<PrivateChatFileAttachment | null> {
  const pinId = metafilePinIdFromUri(params.payload.attachment);
  if (!pinId) {
    params.emitLog('[PrivateChat] File message has no usable metafile pinId; skipping attachment.');
    return null;
  }

  const body = await fetchMetafileBytes(pinId, params.emitLog);
  if (!body) return null;

  let plain: Buffer | null = null;
  if (isEncryptedBody(params.payload.encrypt)) {
    for (const secret of params.sharedSecretCandidates) {
      if (!secret) continue;
      const candidate = decryptPrivateFileBuffer(body, secret);
      if (candidate) {
        plain = candidate;
        break;
      }
    }
  }
  // Sender-side clients disagree on `encrypt`; when the declared ciphertext
  // does not decrypt, an unencrypted image body is still the real payload.
  if (!plain && looksLikeKnownImage(body)) {
    plain = body;
  }
  if (!plain) {
    params.emitLog(
      `[PrivateChat] File message attachment ${pinId.slice(0, 12)}… could not be decrypted with any shared-secret variant.`
    );
    return null;
  }

  const extension = extensionForFileType(params.payload.fileType);
  const fileName = `${pinId}.${extension}`;
  const inboundDir = params.inboundDir ?? resolveInboundDir();
  const localPath = path.join(inboundDir, fileName);

  try {
    const existing = await fs.promises.stat(localPath).catch(() => null);
    if (!existing || existing.size !== plain.length) {
      await fs.promises.mkdir(inboundDir, { recursive: true });
      await fs.promises.writeFile(localPath, plain);
    }
  } catch (error) {
    params.emitLog(
      `[PrivateChat] File message attachment could not be written locally (${localPath}): ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  return {
    kind: classifyFileType(params.payload.fileType),
    localPath,
    mimeType: mimeTypeForFileType(params.payload.fileType),
    fileName,
    metafileUri: params.payload.attachment,
    size: plain.length,
  };
}

/**
 * The transcript body for a file message.
 *
 * The `Attachment path:` line is the app-wide marker: the renderer splits it
 * into a thumbnail strip (UserAttachmentBody) and the runner stages the file
 * for the model, so an inbound image behaves exactly like an attachment the
 * owner dropped into the composer.
 */
export function buildPrivateChatFileMessageContent(params: {
  payload: PrivateChatFilePayload;
  attachment: PrivateChatFileAttachment | null;
}): string {
  const kind = classifyFileType(params.payload.fileType);
  const label = kind === 'image'
    ? '[Image]'
    : kind === 'video'
      ? '[Video]'
      : kind === 'audio'
        ? '[Audio]'
        : `[File${params.payload.fileType ? ` ${params.payload.fileType}` : ''}]`;

  if (!params.attachment) {
    return `${label} The peer sent an attachment that could not be decrypted locally. On-chain copy: ${params.payload.attachment}`;
  }

  return `${label}\nAttachment path: ${params.attachment.localPath}`;
}
