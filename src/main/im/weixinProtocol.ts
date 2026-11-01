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
import type { IMMessage } from './types';

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
/** message_type: 1 = user, 2 = bot. */
export const WEIXIN_MESSAGE_TYPE_USER = 1;
export const WEIXIN_MESSAGE_TYPE_BOT = 2;
/** message_state: 2 = finished. */
export const WEIXIN_MESSAGE_STATE_FINISH = 2;

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

export interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string } | null;
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
    item_list: Array<{ type: number; text_item: { text: string } }>;
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

/** Read the typing ticket returned by getconfig (used by sendtyping). */
export function parseTypingTicket(raw: unknown): string | null {
  assertWeixinOk(raw, 'getconfig');
  return pickString(asRecord(raw), ['typing_ticket', 'typingTicket']);
}

/** Concatenate the text items of one inbound message; null when it carries no text. */export function extractWeixinText(itemList: WeixinMessageItem[] | undefined): string | null {
  if (!Array.isArray(itemList) || itemList.length === 0) return null;
  const parts: string[] = [];
  for (const item of itemList) {
    const text = item && item.text_item && typeof item.text_item.text === 'string'
      ? item.text_item.text
      : '';
    if (text) parts.push(text);
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

/**
 * Convert an inbound Weixin message into the shared IMMessage contract.
 * Returns null for messages the gateway must ignore (bot echoes, empty bodies).
 */
export function toIMMessage(raw: WeixinInboundMessage, now: number = Date.now()): IMMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.message_type === WEIXIN_MESSAGE_TYPE_BOT) return null;

  const conversationId = typeof raw.from_user_id === 'string' && raw.from_user_id
    ? raw.from_user_id
    : (typeof raw.session_id === 'string' ? raw.session_id : '');
  if (!conversationId) return null;

  const text = extractWeixinText(raw.item_list);
  const content = text ?? describeUnsupportedItems(raw.item_list);
  if (!content) return null;

  const timestamp = typeof raw.create_time_ms === 'number' && Number.isFinite(raw.create_time_ms)
    ? raw.create_time_ms
    : now;
  const messageId = raw.message_id != null
    ? String(raw.message_id)
    : (typeof raw.client_id === 'string' && raw.client_id ? raw.client_id : `${conversationId}:${timestamp}`);

  return {
    platform: 'weixin',
    messageId,
    conversationId,
    senderId: conversationId,
    content,
    chatType: 'direct',
    timestamp,
  };
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

export function buildSendMessagePayload(params: {
  toUserId: string;
  text: string;
  contextToken?: string | null;
  clientId: string;
}): WeixinSendMessagePayload {
  const msg: WeixinSendMessagePayload['msg'] = {
    from_user_id: '',
    to_user_id: params.toUserId,
    client_id: params.clientId,
    message_type: WEIXIN_MESSAGE_TYPE_BOT,
    message_state: WEIXIN_MESSAGE_STATE_FINISH,
    item_list: [{ type: WEIXIN_ITEM_TYPE_TEXT, text_item: { text: params.text } }],
  };
  if (params.contextToken) {
    msg.context_token = params.contextToken;
  }
  return { msg, base_info: buildBaseInfo() };
}
