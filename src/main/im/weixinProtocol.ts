/**
 * Weixin (WeChat) iLink bot protocol helpers.
 *
 * RISK NOTICE — READ BEFORE CHANGING ANYTHING HERE
 * This talks to a NON-PUBLIC product interface (`ilinkai.weixin.qq.com`, the
 * endpoint family behind WeChat's bot / "ClawBot" capability). It is not a
 * documented open platform:
 *   - field names, headers and status values may change without notice;
 *   - the whole channel may stop working at any time (or be disabled server side);
 *   - there is no published versioning or support contract.
 * The shapes below were derived from the behavior observed on 2026-11-01 plus
 * public reverse-engineering notes. Every parser in this file is therefore
 * tolerant: unknown fields are ignored, missing fields degrade instead of throwing,
 * so a server-side tweak produces a readable error rather than a crash.
 *
 * COMPLIANCE — this module only supports the QR-authorization path. It does not
 * implement account/password login and does not speak the web WeChat protocol.
 *
 * SECRET HANDLING — the bot token is a bearer credential. Nothing in this file
 * logs it; callers must not pass it to console.* either.
 */

import { randomBytes } from 'crypto';
import type { IMMediaAttachment, IMMessage } from './types';

/** Default business API base. The QR login response may return a different one. */
export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** Fixed bot_type used by the official plugin. */
export const WEIXIN_BOT_TYPE = 3;
/** Value for base_info.channel_version. */
export const WEIXIN_CHANNEL_VERSION = '1.0.0';
/**
 * Outbound text is split at 1800 characters. The official plugin uses this value;
 * community implementations use 2000 as a conservative ceiling. Treated here as a
 * client-side compatibility choice, not a server-declared limit.
 */
export const WEIXIN_TEXT_CHUNK_LIMIT = 1800;
/** Client-side timeout for one `get_qrcode_status` long poll. */
export const WEIXIN_QR_POLL_TIMEOUT_MS = 35_000;
/** Client-side timeout for one `getupdates` long poll. */
export const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000;
/** `ret` / `errcode` value that means the session is gone and a re-scan is required. */
export const WEIXIN_SESSION_EXPIRED_CODE = -14;
/** Hard cap on chunks per single outbound message, to avoid runaway fan-out. */
export const WEIXIN_MAX_OUTBOUND_CHUNKS = 20;

/** Message types carried in item_list. */
export const WEIXIN_ITEM_TYPE_TEXT = 1;
export const WEIXIN_ITEM_TYPE_IMAGE = 2;
export const WEIXIN_ITEM_TYPE_VOICE = 3;
export const WEIXIN_ITEM_TYPE_FILE = 4;
export const WEIXIN_ITEM_TYPE_VIDEO = 5;
/** message_type: 1 = user, 2 = bot. */
export const WEIXIN_MESSAGE_TYPE_USER = 1;
export const WEIXIN_MESSAGE_TYPE_BOT = 2;
/** message_state: 2 = finished. */
export const WEIXIN_MESSAGE_STATE_FINISH = 2;

/**
 * Group messaging is DISABLED by the platform for these bot accounts. Evidence:
 * the channel was built and observed on 2026-11-01..04 as direct-chat only, and
 * `weixinGateway.ts` states it in its scope header ("the platform disables group
 * messaging for these accounts"). Exported so a capability manifest can cite the
 * fact instead of hard-coding the claim a second time.
 */
export const WEIXIN_GROUP_MESSAGING_SUPPORTED = false;

/**
 * Inbound voice audio is NOT downloaded: the gateway only reads the server-side
 * transcript (`voice_item.text`) and never runs speech-to-text itself
 * (docs/weixin-media.md). This is about INBOUND only: outbound has no voice
 * bubble either — audio leaves as a file attachment (§8 of the same doc).
 */
export const WEIXIN_INBOUND_VOICE_AUDIO_SUPPORTED = false;

/** Thrown when the server answers ret/errcode = -14 (session expired). */
export class WeixinSessionExpiredError extends Error {
  constructor(message = 'Weixin session expired; scan the QR code again') {
    super(message);
    this.name = 'WeixinSessionExpiredError';
  }
}

export interface WeixinQrCode {
  /** Opaque polling token passed to get_qrcode_status. */
  qrcode: string;
  /** URL that should be rendered as a QR code for the user to scan. */
  content: string;
}

export interface WeixinLoginCredentials {
  token: string;
  baseUrl: string;
  botId: string | null;
  userId: string | null;
}

export type WeixinQrLoginState = 'wait' | 'scanned' | 'confirmed' | 'expired' | 'error';

export interface WeixinQrStatus {
  state: WeixinQrLoginState;
  credentials: WeixinLoginCredentials | null;
  error: string | null;
}

/** CDN reference carried by image / file / video items. */
export interface WeixinCdnMedia {
  /** Download credential; never logged. */
  encrypt_query_param?: string;
  /** AES key as base64(raw 16 bytes) or base64(32-char hex). */
  aes_key?: string;
  /** 1 = the payload is AES-ECB encrypted. */
  encrypt_type?: number;
  /** Server-supplied absolute download URL; preferred over the constructed one. */
  full_url?: string;
}

export interface WeixinImageItem {
  media?: WeixinCdnMedia;
  thumb_media?: WeixinCdnMedia;
  /** Raw AES key as a 32-char hex string; preferred over media.aes_key inbound. */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  hd_size?: number;
  thumb_size?: number;
  thumb_width?: number;
  thumb_height?: number;
}

export interface WeixinVoiceItem {
  media?: WeixinCdnMedia;
  encode_type?: number;
  sample_rate?: number;
  /** Voice length in milliseconds. */
  playtime?: number;
  /** Server-side speech-to-text transcript; read as text, audio is not transcoded. */
  text?: string;
}

export interface WeixinFileItem {
  media?: WeixinCdnMedia;
  file_name?: string;
  md5?: string;
  /** Plaintext size as a decimal string. */
  len?: string;
}

export interface WeixinVideoItem {
  media?: WeixinCdnMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: WeixinCdnMedia;
}

/**
 * Quoted-message reference carried by one inbound item.
 *
 * REAL capture (2026-11-04, dev + IDBOTS_WEIXIN_RAW_LOG=1):
 *   item_list[0].ref_msg.message_item = {
 *     type: 0, create_time_ms: 1793738959000, msg_id: "7523486488309966856",
 *     is_completed: true, button_item_list: [], at_bot_username_list: []
 *   }
 *
 * It carries NO text and NO sender. `type: 0` was observed only on a TEXT
 * quote, so no media type mapping is inferred here — unknown fields stay
 * unknown rather than becoming an invented protocol.
 */
export interface WeixinRefMessageItem {
  /** Server id of the quoted message. The only usable part of the reference. */
  msg_id?: number | string;
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  [key: string]: unknown;
}

export interface WeixinRefMessage {
  message_item?: WeixinRefMessageItem | null;
  [key: string]: unknown;
}

export interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string } | null;
  image_item?: WeixinImageItem | null;
  voice_item?: WeixinVoiceItem | null;
  file_item?: WeixinFileItem | null;
  video_item?: WeixinVideoItem | null;
  /** Present when this item is a reply to / quote of an earlier message. */
  ref_msg?: WeixinRefMessage | null;
  [key: string]: unknown;
}

export interface WeixinInboundMessage {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: WeixinMessageItem[];
  [key: string]: unknown;
}

export interface WeixinUpdates {
  messages: WeixinInboundMessage[];
  /** New opaque cursor; null when the response did not carry one. */
  nextBuf: string | null;
  longPollingTimeoutMs: number | null;
}

export interface WeixinSendMessagePayload {
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;
    message_state: number;
    context_token?: string;
    item_list: WeixinMessageItem[];
  };
  base_info: { channel_version: string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickString(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function pickNumber(source: Record<string, unknown> | null, keys: string[]): number | null {
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

/**
 * Business error code carried by a response (`ret` wins, then `errcode`).
 * Returns null when the response carries neither.
 */
export function readWeixinErrorCode(raw: unknown): number | null {
  const record = asRecord(raw);
  if (!record) return null;
  const code = pickNumber(record, ['ret', 'errcode']);
  return code;
}

export function readWeixinErrorMessage(raw: unknown): string | null {
  return pickString(asRecord(raw), ['errmsg', 'err_msg', 'message']);
}

/**
 * Throw when a response is a business failure. `ret`/`errcode` -14 becomes a
 * WeixinSessionExpiredError so callers can react (clear credentials + cursor).
 */
export function assertWeixinOk(raw: unknown, context: string): void {
  const code = readWeixinErrorCode(raw);
  if (code === null || code === 0) return;
  const message = readWeixinErrorMessage(raw) || `unexpected error ${code}`;
  if (code === WEIXIN_SESSION_EXPIRED_CODE) {
    throw new WeixinSessionExpiredError(`Weixin session expired while calling ${context}: ${message}`);
  }
  throw new Error(`Weixin ${context} failed (ret ${code}): ${message}`);
}

/** Random uint32 -> decimal string -> base64, as required by X-WECHAT-UIN. */
export function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

/** Unique, traceable client_id for one outbound message. */
export function createWeixinClientId(now: number = Date.now()): string {
  return `idbots-weixin:${now}-${randomBytes(4).toString('hex')}`;
}

export function buildBaseInfo(): { channel_version: string } {
  return { channel_version: WEIXIN_CHANNEL_VERSION };
}

/**
 * Parse the get_bot_qrcode response.
 * Throws only when no polling token came back — without it nothing else works.
 */
export function parseQrCodeResponse(raw: unknown): WeixinQrCode {
  assertWeixinOk(raw, 'get_bot_qrcode');
  const record = asRecord(raw);
  const qrcode = pickString(record, ['qrcode', 'qr_code', 'qrcode_id']);
  if (!qrcode) {
    throw new Error('Weixin get_bot_qrcode returned no qrcode token');
  }
  const content = pickString(record, ['qrcode_img_content', 'qrcode_url', 'qr_content']) || qrcode;
  return { qrcode, content };
}

/**
 * Parse the get_qrcode_status response.
 * `wait`/`scaned` are long-poll progress signals, not failures.
 */
export function parseQrStatusResponse(raw: unknown): WeixinQrStatus {
  const record = asRecord(raw);
  const code = readWeixinErrorCode(record);
  if (code !== null && code !== 0 && code !== WEIXIN_SESSION_EXPIRED_CODE) {
    return {
      state: 'error',
      credentials: null,
      error: readWeixinErrorMessage(raw) || `unexpected error ${code}`,
    };
  }

  const rawStatus = (pickString(record, ['status', 'state', 'qrcode_status']) || '').toLowerCase();
  if (rawStatus === 'wait' || rawStatus === 'waiting' || rawStatus === 'pending' || rawStatus === '') {
    return { state: 'wait', credentials: null, error: null };
  }
  if (rawStatus === 'scaned' || rawStatus === 'scanned') {
    return { state: 'scanned', credentials: null, error: null };
  }
  if (rawStatus === 'expired' || rawStatus === 'timeout') {
    return { state: 'expired', credentials: null, error: null };
  }
  if (rawStatus === 'confirmed' || rawStatus === 'confirm' || rawStatus === 'success') {
    const token = pickString(record, ['bot_token', 'token', 'access_token']);
    if (!token) {
      return { state: 'error', credentials: null, error: 'Weixin login confirmed without a bot token' };
    }
    return {
      state: 'confirmed',
      credentials: {
        token,
        baseUrl: pickString(record, ['baseurl', 'base_url']) || WEIXIN_DEFAULT_BASE_URL,
        botId: pickString(record, ['ilink_bot_id', 'bot_id', 'account_id']),
        userId: pickString(record, ['ilink_user_id', 'user_id']),
      },
      error: null,
    };
  }
  return { state: 'error', credentials: null, error: `unknown qrcode status: ${rawStatus}` };
}

/**
 * Parse the getupdates response.
 * Throws WeixinSessionExpiredError on -14 so the poll loop can stop and ask for a re-scan.
 */
export function parseUpdatesResponse(raw: unknown): WeixinUpdates {
  assertWeixinOk(raw, 'getupdates');
  const record = asRecord(raw);
  const rawMessages = record && Array.isArray(record.msgs) ? record.msgs : [];
  const messages = rawMessages
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null) as WeixinInboundMessage[];
  const nextBuf = pickString(record, ['get_updates_buf', 'sync_buf']);
  const longPollingTimeoutMs = pickNumber(record, ['longpolling_timeout_ms', 'long_polling_timeout_ms']);
  return { messages, nextBuf, longPollingTimeoutMs };
}

// ---------------------------------------------------------------------------
// Raw inbound debug log (opt-in, default OFF)
// ---------------------------------------------------------------------------

/**
 * Environment variable that turns on the raw inbound dump. Off unless it is
 * exactly `1`; it exists to capture the REAL `getupdates` payload shape once
 * (e.g. to identify the field that carries a quoted/referenced message) and is
 * not a runtime feature.
 */
export const WEIXIN_RAW_LOG_ENV_VAR = 'IDBOTS_WEIXIN_RAW_LOG';
/** Cap for the serialized `item_list` in one debug line (characters). */
export const WEIXIN_RAW_LOG_ITEM_LIST_MAX_CHARS = 2000;

/**
 * Field names whose value must never reach a log line. Matched against the KEY
 * only, so unknown vendor fields still get redacted: `aes_key`, `aeskey`,
 * `encrypt_query_param`, `upload_param`, `token`, `cookie`, `signature`, ...
 */
const WEIXIN_RAW_LOG_SECRET_KEY = /token|cookie|secret|passw|credential|aes[_-\s]?key|file[_-\s]?key|query_param|upload_param|signature/i;
/**
 * Credentials that ride inside a URL/query string instead of a dedicated JSON
 * field (`.../download?encrypted_query_param=...`). Scrubbed on the serialized
 * text as a second pass, because the key-name pass cannot see them.
 */
const WEIXIN_RAW_LOG_SECRET_IN_TEXT = /((?:encrypted?_query_param|upload_param|file_?key|aes_?key|token|cookie|signature)=)[^&\s"']+/gi;
const WEIXIN_RAW_LOG_MAX_KEY_PATHS = 80;

export function isWeixinRawLogEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[WEIXIN_RAW_LOG_ENV_VAR] === '1';
}

/** Deep-copy with secret-looking values replaced by `[REDACTED]`. */
function redactRawLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redactRawLogValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = WEIXIN_RAW_LOG_SECRET_KEY.test(key)
        ? '[REDACTED]'
        : redactRawLogValue(child, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Collect dotted key paths (`image_item.aes_key`, `ref_msg.title`, ...) from the
 * UNREDACTED structure. The value dump below is capped at 2000 characters, but
 * the key skeleton is cheap and stays complete, so a field name is still
 * visible even when its value was cut.
 */
function collectRawLogKeyPaths(
  value: unknown,
  prefix: string,
  out: string[],
  depth: number
): void {
  if (out.length >= WEIXIN_RAW_LOG_MAX_KEY_PATHS || depth > 6) return;
  if (Array.isArray(value)) {
    // The top-level array IS item_list, so its element keys read as
    // `text_item.text`; only nested arrays keep the `[]` marker.
    const nextPrefix = prefix === '' ? '' : `${prefix}[]`;
    for (const item of value) collectRawLogKeyPaths(item, nextPrefix, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!out.includes(path)) out.push(path);
      collectRawLogKeyPaths(child, path, out, depth + 1);
    }
  }
}

/**
 * Build ONE single-line debug record for an inbound `msgs[]` entry.
 *
 * Shape:
 *   `[Weixin Raw Inbound] message_id="…" logged_at="…" create_time_ms=… seq=…
 *    message_type=… from_user_id="…" item_count=… truncated=…
 *    message_keys=[…] item_keys=[…] item_list=<JSON>`
 *
 * Only `item_list` VALUES are dumped. `message_keys` is a key-name skeleton of
 * the whole `msgs[]` entry, so a quote field carried at MESSAGE level (not
 * inside item_list) is still visible — as a name, never a value.
 * `context_token`, headers and the bot token never enter the value dump, and
 * secret-looking item fields are redacted. The serialized `item_list` is capped
 * at {@link WEIXIN_RAW_LOG_ITEM_LIST_MAX_CHARS} and the cut is marked in-line,
 * so a single runaway payload cannot flood the log.
 */
export function formatWeixinRawInboundLogLine(
  raw: WeixinInboundMessage,
  now: number = Date.now()
): string {
  const itemList = Array.isArray(raw?.item_list) ? raw.item_list : [];
  const serialized = (JSON.stringify(redactRawLogValue(itemList)) ?? '[]')
    .replace(WEIXIN_RAW_LOG_SECRET_IN_TEXT, '$1[REDACTED]');
  const truncated = serialized.length > WEIXIN_RAW_LOG_ITEM_LIST_MAX_CHARS;
  const payload = truncated
    ? `${serialized.slice(0, WEIXIN_RAW_LOG_ITEM_LIST_MAX_CHARS)}…[truncated: ${serialized.length} chars total]`
    : serialized;

  const keyPaths: string[] = [];
  collectRawLogKeyPaths(itemList, '', keyPaths, 0);

  const messageKeyPaths: string[] = [];
  const messageShape = redactRawLogValue({ ...raw, item_list: '[see item_keys]' });
  collectRawLogKeyPaths(messageShape, '', messageKeyPaths, 0);

  const fields: Array<[string, unknown]> = [
    ['message_id', raw?.message_id != null ? String(raw.message_id) : null],
    ['logged_at', new Date(now).toISOString()],
    ['create_time_ms', typeof raw?.create_time_ms === 'number' ? raw.create_time_ms : null],
    ['seq', typeof raw?.seq === 'number' ? raw.seq : null],
    ['message_type', typeof raw?.message_type === 'number' ? raw.message_type : null],
    ['from_user_id', typeof raw?.from_user_id === 'string' ? raw.from_user_id : null],
    ['item_count', itemList.length],
    ['truncated', truncated],
    ['message_keys', messageKeyPaths],
    ['item_keys', keyPaths],
  ];
  const head = fields.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  return `[Weixin Raw Inbound] ${head} item_list=${payload}`;
}

/**
 * Normalized content of a referenced message, produced by a LOCAL lookup keyed
 * by `ref_msg.message_item.msg_id`.
 *
 * The platform returns no text and no sender, so both fields can only come
 * from records this host stored itself. `kind` wins over `text`: a quoted media
 * message is labelled by TYPE and never downloaded.
 */
export interface WeixinQuoteSummary {
  /** Plain text of the quoted message, when the local record has it. */
  text?: string | null;
  /** Quoted media type, when the local record says the quoted message was media. */
  kind?: 'image' | 'file' | 'voice' | 'video';
}

/** Media label for a quote prefix; only the TYPE is stated — nothing is fetched. */
const WEIXIN_QUOTE_KIND_LABELS: Record<NonNullable<WeixinQuoteSummary['kind']>, string> = {
  image: '一张图片',
  file: '一个文件',
  voice: '一条语音',
  video: '一段视频',
};

/** Summary cap for the quoted text inside the prefix. */
export const WEIXIN_QUOTE_TEXT_MAX_CHARS = 120;

/**
 * Shown when the item HAS a `ref_msg` but the quoted message cannot be resolved
 * locally. Never replaced with guessed content.
 */
export const WEIXIN_QUOTE_UNRESOLVED_PREFIX = '（引用了一条此前的消息）';

/**
 * Read `item_list[*].ref_msg.message_item.msg_id` — the ONLY quote information
 * the Weixin platform returns (2026-11-04 capture). Malformed/missing refs are
 * ignored rather than throwing: the message itself must still be delivered.
 */
export function readWeixinQuoteRef(
  itemList: WeixinMessageItem[] | undefined
): { msgId: string } | null {
  if (!Array.isArray(itemList)) return null;
  for (const item of itemList) {
    const raw = item?.ref_msg?.message_item?.msg_id;
    if (typeof raw === 'string' && raw.trim()) return { msgId: raw.trim() };
    if (typeof raw === 'number' && Number.isFinite(raw)) return { msgId: String(raw) };
  }
  return null;
}

/**
 * Render the quote prefix.
 *
 *   text resolved   → `（引用：<120 字摘要>）`
 *   media resolved  → `（引用了一张图片）` / 一个文件 / 一条语音 / 一段视频
 *   nothing usable  → null (caller uses {@link WEIXIN_QUOTE_UNRESOLVED_PREFIX})
 */
export function formatWeixinQuotePrefix(quote: WeixinQuoteSummary | null | undefined): string | null {
  if (!quote) return null;
  const mediaLabel = quote.kind ? WEIXIN_QUOTE_KIND_LABELS[quote.kind] : '';
  if (mediaLabel) return `（引用了${mediaLabel}）`;

  const text = typeof quote.text === 'string'
    ? quote.text.replace(/\s+/g, ' ').trim()
    : '';
  if (!text) return null;
  // Count CODE POINTS, not UTF-16 units: an emoji must not be split in half.
  const chars = Array.from(text);
  const body = chars.length > WEIXIN_QUOTE_TEXT_MAX_CHARS
    ? `${chars.slice(0, WEIXIN_QUOTE_TEXT_MAX_CHARS).join('')}…`
    : text;
  return `（引用：${body}）`;
}

/**
 * Result of reading `ilink/bot/sendmessage`'s response.
 *
 * `rejection` exists so a present-but-unusable id is reported instead of being
 * silently dropped: the quote ledger then has no entry for this message, and
 * that is a fact the log should carry.
 */
export interface WeixinSendMessageResult {
  /** Exact server message id (the value a quote reference will carry). */
  messageId: string | null;
  rejection: 'unsafe-number' | 'malformed' | null;
}

/** Id fields the sendmessage response has been seen to use. */
function pickSendMessageId(record: Record<string, unknown> | null): unknown {
  if (!record) return undefined;
  if (record.message_id !== undefined) return record.message_id;
  const nested = asRecord(record.msg);
  if (nested && nested.message_id !== undefined) return nested.message_id;
  if (record.msg_id !== undefined) return record.msg_id;
  return undefined;
}

/**
 * Read the message id from a `sendmessage` response.
 *
 * REAL capture (2026-11-04, dev): `{"message_id":7523489994131519368}` — a bare
 * JSON number that is ALSO past Number.MAX_SAFE_INTEGER. The transport now
 * preserves such ids as exact strings; if a caller hands us an already-rounded
 * number we refuse it rather than store a key that can never match.
 */
export function parseSendMessageResponse(raw: unknown): WeixinSendMessageResult {
  const record = asRecord(raw);
  const value = pickSendMessageId(record);
  if (value === undefined || value === null) return { messageId: null, rejection: null };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { messageId: trimmed, rejection: null } : { messageId: null, rejection: 'malformed' };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      return { messageId: null, rejection: 'unsafe-number' };
    }
    return { messageId: String(value), rejection: null };
  }
  return { messageId: null, rejection: 'malformed' };
}

/** Read the typing ticket returned by getconfig (used by sendtyping). */
export function parseTypingTicket(raw: unknown): string | null {
  assertWeixinOk(raw, 'getconfig');
  return pickString(asRecord(raw), ['typing_ticket', 'typingTicket']);
}

export interface WeixinUploadUrl {
  /** Complete CDN URL returned by the server; preferred when present. */
  uploadFullUrl: string | null;
  /** Pre-signed upload token; the caller pairs it with the filekey. */
  uploadParam: string | null;
}

/**
 * Parse the getuploadurl response. Both `upload_full_url` and `upload_param` are
 * optional individually, but at least one must be present to upload anything —
 * callers turn "neither" into a readable error.
 */
export function parseUploadUrlResponse(raw: unknown): WeixinUploadUrl {
  assertWeixinOk(raw, 'getuploadurl');
  const record = asRecord(raw);
  return {
    uploadFullUrl: pickString(record, ['upload_full_url', 'uploadFullUrl']),
    uploadParam: pickString(record, ['upload_param', 'uploadParam']),
  };
}

/**
 * Concatenate the text carried by one inbound message.
 *
 * Both `text_item.text` and `voice_item.text` are read: the voice transcript is
 * already produced server side, so it costs nothing to surface (audio itself is
 * out of scope for this version).
 */
export function extractWeixinText(itemList: WeixinMessageItem[] | undefined): string | null {
  if (!Array.isArray(itemList) || itemList.length === 0) return null;
  const parts: string[] = [];
  for (const item of itemList) {
    const text = item && item.text_item && typeof item.text_item.text === 'string'
      ? item.text_item.text
      : '';
    if (text) {
      parts.push(text);
      continue;
    }
    const transcript = item && item.voice_item && typeof item.voice_item.text === 'string'
      ? item.voice_item.text
      : '';
    if (transcript) parts.push(transcript);
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

/** Human-readable placeholder for a message we do not translate (MVP is text only). */
function describeUnsupportedItems(itemList: WeixinMessageItem[] | undefined): string | null {
  if (!Array.isArray(itemList) || itemList.length === 0) return null;
  const labels: Record<number, string> = { 2: 'image', 3: 'voice', 4: 'file', 5: 'video' };
  const kinds = itemList
    .map((item) => (item && typeof item.type === 'number' ? labels[item.type] : undefined))
    .filter((label): label is string => Boolean(label));
  if (kinds.length === 0) return null;
  return `[unsupported weixin message: ${Array.from(new Set(kinds)).join(', ')}]`;
}

/** Human-readable size for the one-line media description (e.g. `12.3MB`). */
export function formatWeixinMediaSize(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  const kb = bytes / 1024;
  return kb >= 1 ? `${kb.toFixed(0)}KB` : `${bytes}B`;
}

/**
 * One-line Chinese description for a media-only message, so the agent always
 * receives something it can act on instead of an empty body.
 */
export function describeWeixinAttachments(attachments: IMMediaAttachment[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  const images = attachments.filter((item) => item.type === 'image').length;
  const videos = attachments.filter((item) => item.type === 'video').length;
  const documents = attachments.length - images - videos;

  if (attachments.length === 1 && documents === 1) {
    const name = attachments[0].fileName;
    return name ? `用户发送了文件「${name}」` : '用户发送了文件 1 个';
  }

  if (attachments.length === 1 && videos === 1) {
    const size = formatWeixinMediaSize(attachments[0].fileSize);
    return size ? `用户发送了一个视频 ${size}` : '用户发送了一个视频';
  }

  const parts: string[] = [];
  if (images > 0) parts.push(`图片 ${images} 张`);
  if (videos > 0) parts.push(`视频 ${videos} 段`);
  if (documents > 0) parts.push(`文件 ${documents} 个`);
  return `用户发送了${parts.join('、')}`;
}

export interface WeixinInboundAttachmentInfo {
  /** Attachments already downloaded to disk by the gateway. */
  attachments?: IMMediaAttachment[];
  /** How many media items could not be downloaded/decrypted (kept as a note). */
  failed?: number;
}

export interface WeixinInboundQuoteResolver {
  /**
   * Resolve a quoted message from LOCAL records by its server `msg_id`.
   *
   * The platform's `ref_msg` carries only that id. Return null when the id is
   * unknown — the caller then writes the honest fallback instead of guessing.
   *
   * Production wires this to `IMStore`'s local message ledger
   * (`im_weixin_message_ledger`, filled from the outbound `sendmessage`
   * response and from every inbound message). The resolver is OPTIONAL: with no
   * ledger, or with a ledger that throws, every quote falls back to
   * {@link WEIXIN_QUOTE_UNRESOLVED_PREFIX} and delivery is unaffected.
   */
  resolveQuote?: (msgId: string) => WeixinQuoteSummary | null;
}

/**
 * Convert an inbound Weixin message into the shared IMMessage contract.
 * Returns null for messages the gateway must ignore (bot echoes, empty bodies).
 *
 * Media: the gateway downloads attachments first and passes them in. A media-only
 * message gets a generated description; a partially failed one keeps its text or
 * description plus an explicit "附件下载失败" note — the message is never dropped.
 *
 * Quote: when `item.ref_msg.message_item.msg_id` is present, the body is
 * prefixed with the resolved summary, or with the honest fallback sentence when
 * no local record matches. Only the reply's OWN attachments are downloaded;
 * the quoted message is never fetched.
 */
export function toIMMessage(
  raw: WeixinInboundMessage,
  now: number = Date.now(),
  attachmentInfo: WeixinInboundAttachmentInfo = {},
  quoteResolver: WeixinInboundQuoteResolver = {}
): IMMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.message_type === WEIXIN_MESSAGE_TYPE_BOT) return null;

  const conversationId = typeof raw.from_user_id === 'string' && raw.from_user_id
    ? raw.from_user_id
    : (typeof raw.session_id === 'string' ? raw.session_id : '');
  if (!conversationId) return null;

  const attachments = Array.isArray(attachmentInfo.attachments) ? attachmentInfo.attachments : [];
  const failed = typeof attachmentInfo.failed === 'number' && attachmentInfo.failed > 0
    ? attachmentInfo.failed
    : 0;

  const text = extractWeixinText(raw.item_list);
  let content: string | null = text;
  if (!content) {
    content = describeWeixinAttachments(attachments)
      ?? (failed > 0 ? '用户发送了附件，但下载失败' : describeUnsupportedItems(raw.item_list));
  }
  if (!content) return null;
  if (failed > 0 && attachments.length > 0) {
    content = `${content}\n（附件下载失败：${failed} 个）`;
  }

  // Quote: the wire carries only an id, so this is a LOCAL lookup. Unresolvable
  // → a plain sentence; never a fabricated body or sender.
  const quoteRef = readWeixinQuoteRef(raw.item_list);
  if (quoteRef) {
    let quoted: WeixinQuoteSummary | null = null;
    try {
      quoted = quoteResolver.resolveQuote?.(quoteRef.msgId) ?? null;
    } catch {
      quoted = null;
    }
    const prefix = formatWeixinQuotePrefix(quoted) ?? WEIXIN_QUOTE_UNRESOLVED_PREFIX;
    content = `${prefix}${content}`;
  }

  const timestamp = typeof raw.create_time_ms === 'number' && Number.isFinite(raw.create_time_ms)
    ? raw.create_time_ms
    : now;
  const messageId = raw.message_id != null
    ? String(raw.message_id)
    : (typeof raw.client_id === 'string' && raw.client_id ? raw.client_id : `${conversationId}:${timestamp}`);

  const message: IMMessage = {
    platform: 'weixin',
    messageId,
    conversationId,
    senderId: conversationId,
    content,
    chatType: 'direct',
    timestamp,
  };
  if (attachments.length > 0) {
    message.attachments = attachments;
  }
  return message;
}

/**
 * Split text into chunks no longer than `limit` code units.
 * Prefers paragraph, then line, then space boundaries near the end of the window.
 * Appends an explicit truncation marker when `maxChunks` cuts the body short —
 * silently dropping text would be worse than telling the user.
 */
export function splitWeixinText(
  text: string,
  limit: number = WEIXIN_TEXT_CHUNK_LIMIT,
  maxChunks: number = WEIXIN_MAX_OUTBOUND_CHUNKS
): string[] {
  if (!text) return [];
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeMax = Math.max(1, Math.floor(maxChunks));
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > safeLimit && chunks.length < safeMax) {
    const window = remaining.slice(0, safeLimit);
    const floor = Math.floor(safeLimit * 0.5);
    let cut = -1;

    const paragraph = window.lastIndexOf('\n\n');
    if (paragraph >= floor) {
      cut = paragraph + 2;
    } else {
      const line = window.lastIndexOf('\n');
      if (line >= floor) cut = line + 1;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      if (space >= floor) cut = space + 1;
    }
    if (cut <= 0) cut = safeLimit;

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  if (remaining.length > 0) {
    if (chunks.length >= safeMax) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n…(truncated)`;
      return chunks;
    }
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Build one outbound `sendmessage` payload around a single item.
 *
 * The official plugin sends caption text and a media item as SEPARATE messages
 * (one item per `sendmessage`), so this stays item-oriented.
 */
export function buildSendItemsPayload(params: {
  toUserId: string;
  items: WeixinMessageItem[];
  contextToken?: string | null;
  clientId: string;
}): WeixinSendMessagePayload {
  const msg: WeixinSendMessagePayload['msg'] = {
    from_user_id: '',
    to_user_id: params.toUserId,
    client_id: params.clientId,
    message_type: WEIXIN_MESSAGE_TYPE_BOT,
    message_state: WEIXIN_MESSAGE_STATE_FINISH,
    item_list: params.items,
  };
  if (params.contextToken) {
    msg.context_token = params.contextToken;
  }
  return { msg, base_info: buildBaseInfo() };
}

export function buildSendMessagePayload(params: {
  toUserId: string;
  text: string;
  contextToken?: string | null;
  clientId: string;
}): WeixinSendMessagePayload {
  return buildSendItemsPayload({
    toUserId: params.toUserId,
    contextToken: params.contextToken,
    clientId: params.clientId,
    items: [{ type: WEIXIN_ITEM_TYPE_TEXT, text_item: { text: params.text } }],
  });
}
