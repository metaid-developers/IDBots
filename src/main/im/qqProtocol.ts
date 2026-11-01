/**
 * QQ Open Platform protocol helpers.
 *
 * This channel speaks to the OFFICIAL QQ Open Platform through the official
 * `@tencent-connect/qqbot-nodejs` SDK. Unlike the Weixin channel there is no
 * reverse-engineered interface here: every shape below is taken from the
 * published SDK surface.
 *
 * Sources (all in `node_modules/@tencent-connect/qqbot-nodejs@1.0.5`):
 *   - `dist/QQBot.d.ts` — `ReplyTarget`, `QQBotInboundMessage`, `QQBotOptions`,
 *     high-level `sendText` / `sendImage` / `sendVideo` / `sendFile` / `sendTyping`.
 *   - `dist/protocol/gateway/event-dispatcher.d.ts` — `InboundMessage`,
 *     `InboundAttachment`, `InboundMsgElement`.
 *   - `dist/protocol/types.d.ts` — `GroupMessageEvent.mentions` and
 *     `MediaFileType` / `MEDIA_FILE_TYPE_INFO`.
 *   - `USAGE.md` §9.3 (typing indicator is C2C only), §10.2 (chunked upload
 *     above 5 MB), §10.3 (per-kind upload ceilings), §11.2 (a streaming reply
 *     must be based on an inbound message no older than 5 minutes).
 *
 * SECRET HANDLING — nothing in this file receives or returns `appSecret`. The
 * error helpers only carry sizes, kinds and platform status codes.
 */

import * as path from 'path';

import type { IMMediaAttachment, IMMediaType, IMMessage } from './types';

/** Default REST base, from `dist/protocol/api/api-client.js` (`DEFAULT_BASE_URL`). */
export const QQ_DEFAULT_API_BASE_URL = 'https://api.sgroup.qq.com';
/** Token endpoint base, from `dist/protocol/api/token.js` (`DEFAULT_TOKEN_BASE_URL`). */
export const QQ_DEFAULT_TOKEN_BASE_URL = 'https://bots.qq.com';
/** Token path, from `dist/protocol/api/token.js` (`TOKEN_PATH`). */
export const QQ_TOKEN_PATH = '/app/getAppAccessToken';

/**
 * Client-side text chunk ceiling.
 *
 * NOT a platform limit: neither the SDK nor its USAGE.md states a maximum text
 * length. We reuse the 1800-character conservative chunking already used by the
 * Weixin channel so one model answer cannot produce an unbounded single request.
 * If QQ ever publishes a number, replace this constant and cite it here.
 */
export const QQ_TEXT_CHUNK_LIMIT = 1800;
/** Hard cap on chunks per outbound message (runaway fan-out guard). */
export const QQ_MAX_OUTBOUND_CHUNKS = 20;

/**
 * Passive-reply window. `USAGE.md` §11.2 states that a streaming reply must be
 * based on an inbound message no older than 5 minutes. QQ's passive-reply rules
 * share that window; we therefore keep the inbound `msgId` for at most 5 minutes
 * and fall back to an active push afterwards (active pushes are quota-limited by
 * the platform, see `USAGE.md` §9.4).
 */
export const QQ_PASSIVE_REPLY_TTL_MS = 5 * 60 * 1000;

/**
 * Per-kind upload ceilings, copied from the SDK's `MEDIA_FILE_TYPE_INFO`
 * (`dist/protocol/utils/file-utils.js`). `getMaxUploadSize()` exposes the same
 * numbers at runtime; the test suite asserts these constants stay in sync.
 */
export const QQ_MEDIA_LIMITS_BYTES = {
  image: 30 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  voice: 20 * 1024 * 1024,
  file: 100 * 1024 * 1024,
} as const;

/** Above this size the SDK switches to the chunked upload path (`USAGE.md` §10.2). */
export const QQ_CHUNKED_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
/** Absolute ceiling on the chunked path (`CHUNKED_UPLOAD_MAX_SIZE`). */
export const QQ_CHUNKED_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Inbound per-attachment ceiling. Chosen, not documented: the platform push
 * payload carries no size contract, so we refuse anything larger than the
 * largest documented OUTBOUND ceiling (100 MB, video/file) instead of writing an
 * unbounded body to disk. Labelled a client-side save guard in the docs.
 */
export const QQ_INBOUND_MAX_BYTES = 100 * 1024 * 1024;
/** Max attachments persisted from one inbound message (client-side guard). */
export const QQ_INBOUND_MAX_ATTACHMENTS = 5;

/** How long an inbound reply target stays usable for a passive reply. */
export const QQ_TARGET_CACHE_MAX_ENTRIES = 500;

export type QQChatScope = 'c2c' | 'group';

/** The subset of `ReplyTarget` this gateway needs. */
export interface QQTarget {
  scope: QQChatScope;
  targetId: string;
  msgId?: string;
}

/** Attachment shape of `InboundAttachment`. */
export interface QQInboundAttachment {
  content_type?: string;
  url?: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export interface QQInboundMention {
  scope?: 'all' | 'single';
  id?: string;
  user_openid?: string;
  member_openid?: string;
  nickname?: string;
  username?: string;
  bot?: boolean;
  is_you?: boolean;
}

/** The subset of the SDK's `QQBotInboundMessage` consumed by the gateway. */
export interface QQInboundLike {
  kind: 'c2c' | 'group' | 'guild' | 'dm';
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  groupOpenid?: string;
  attachments?: QQInboundAttachment[];
  rawEventType?: string;
  mentions?: QQInboundMention[];
}

export type QQLoginState = 'wait' | 'scanned' | 'confirmed' | 'expired' | 'error';

export interface QQLoginCredentials {
  appId: string;
  /** Sensitive: never logged, never returned to the renderer. */
  appSecret: string;
  userOpenid?: string | null;
}

export interface QQMediaRef {
  kind: 'image' | 'video' | 'document';
  url: string;
  fileName?: string;
  size?: number;
  contentType?: string;
  width?: number;
  height?: number;
}

/** Raised for protocol/validation problems; messages never carry secrets. */
export class QQProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QQProtocolError';
  }
}

/**
 * Stable, scope-qualified conversation id.
 *
 * The id is used as the IM session-mapping key, so it MUST keep a private chat
 * and a group chat apart even when an OpenID collides: group conversations use
 * the group OpenID, C2C ones the user OpenID, and both are prefixed with `qq:`.
 */
export function qqConversationId(kind: 'c2c' | 'group', targetId: string): string {
  return `qq:${kind}:${targetId}`;
}

/** The reply target carried by an inbound message, or null when it has none. */
export function qqReplyTarget(msg: QQInboundLike): QQTarget | null {
  if (msg.kind === 'c2c') {
    const userId = (msg.senderId || '').trim();
    if (!userId) return null;
    return { scope: 'c2c', targetId: userId, msgId: msg.messageId || undefined };
  }
  if (msg.kind === 'group') {
    const groupId = (msg.groupOpenid || '').trim();
    if (!groupId) return null;
    return { scope: 'group', targetId: groupId, msgId: msg.messageId || undefined };
  }
  // The high-level facade does not derive a replyTarget for guild/dm (USAGE.md
  // §5.3), so those scopes are outside this channel's contract.
  return null;
}

/**
 * Group @-mention decision.
 *
 * Priority (same ordering the SDK's own `mentionGate` uses):
 *   1. `rawEventType === 'GROUP_AT_MESSAGE_CREATE'` — the platform only delivers
 *      this event when the bot was actually @-ed.
 *   2. `mentions[].is_you === true` — structured, server-marked.
 *   3. `<@!appId>` / `<@appId>` inside the content — compatibility fallback for
 *      payloads that also arrive as plain `GROUP_MESSAGE_CREATE`.
 *
 * C2C messages are always answerable.
 */
export function qqMentionDecision(
  msg: QQInboundLike,
  appId: string
): { mentioned: boolean; via: 'event' | 'mentions' | 'content' | 'c2c' | 'none' } {
  if (msg.kind === 'c2c') return { mentioned: true, via: 'c2c' };
  if (msg.kind !== 'group') return { mentioned: false, via: 'none' };
  if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return { mentioned: true, via: 'event' };
  if (Array.isArray(msg.mentions) && msg.mentions.some((mention) => mention?.is_you === true)) {
    return { mentioned: true, via: 'mentions' };
  }
  if (appId && containsQQMentionMarker(msg.content, appId)) {
    return { mentioned: true, via: 'content' };
  }
  return { mentioned: false, via: 'none' };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsQQMentionMarker(content: string, appId: string): boolean {
  if (!content || !appId) return false;
  return new RegExp(`<@!?${escapeRegExp(appId)}>`, 'i').test(content);
}

/** Remove `<@!bot>` / `<@bot>` markers so the model sees the sentence, not tags. */
export function stripQQMentionMarkers(content: string, appId: string): string {
  if (!content) return '';
  const pattern = appId
    ? new RegExp(`<@!?${escapeRegExp(appId)}>`, 'gi')
    : /<@!?[^>\s]+>/g;
  return content.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
}

/** Parse the SDK's ISO-8601 timestamp string; fall back to now on garbage. */
export function parseQQTimestamp(timestamp: string | undefined, now: number): number {
  if (!timestamp) return now;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : now;
}

export interface QQToIMMessageOptions {
  appId: string;
  now: number;
  attachments?: IMMediaAttachment[];
  failedAttachments?: number;
  /** Set when the message came in through a known @-mention path (diagnostics). */
  mentionedVia?: string;
}

/**
 * Convert one SDK inbound message into the framework-neutral `IMMessage`.
 * Returns null for scopes this channel does not answer (guild/dm) or when the
 * message has no usable reply target.
 */
export function toQQIMMessage(msg: QQInboundLike, options: QQToIMMessageOptions): IMMessage | null {
  if (msg.senderIsBot) return null;
  const target = qqReplyTarget(msg);
  if (!target) return null;

  const plain = stripQQMentionMarkers(msg.content || '', options.appId);
  const failed = options.failedAttachments ?? 0;
  const content = failed > 0
    ? `${plain}${plain ? '\n' : ''}[${failed} attachment(s) failed to download]`.trim()
    : plain;

  const attachments = options.attachments && options.attachments.length > 0
    ? options.attachments
    : undefined;

  const isGroup = target.scope === 'group';
  return {
    platform: 'qq',
    messageId: msg.messageId,
    conversationId: qqConversationId(target.scope, target.targetId),
    senderId: msg.senderId,
    senderName: msg.senderName,
    content: content || (attachments ? '' : '[empty message]'),
    chatType: isGroup ? 'group' : 'direct',
    timestamp: parseQQTimestamp(msg.timestamp, options.now),
    ...(attachments ? { attachments } : {}),
  };
}

/**
 * Split text for outbound delivery. Prefers paragraph boundaries, then hard
 * splits, and marks an over-budget tail as truncated instead of dropping it
 * silently.
 */
export function splitQQText(text: string, limit = QQ_TEXT_CHUNK_LIMIT, maxChunks = QQ_MAX_OUTBOUND_CHUNKS): string[] {
  const value = (text || '').trim();
  if (!value) return [];
  const safeLimit = Math.max(1, limit);
  const safeMax = Math.max(1, maxChunks);
  if (value.length <= safeLimit) return [value];

  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > 0) {
    if (remaining.length <= safeLimit) {
      chunks.push(remaining);
      break;
    }
    if (chunks.length >= safeMax) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n…(truncated)`;
      break;
    }
    let cut = remaining.lastIndexOf('\n', safeLimit);
    if (cut < Math.floor(safeLimit * 0.5)) cut = safeLimit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/** Which SDK sender a local file should use. */
export function classifyQQOutbound(filePath: string): 'image' | 'video' | 'voice' | 'file' {
  const ext = path.extname(filePath || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'].includes(ext)) return 'video';
  if (['.silk', '.amr', '.slk'].includes(ext)) return 'voice';
  return 'file';
}

export function qqMediaLimitFor(kind: 'image' | 'video' | 'voice' | 'file'): number {
  return QQ_MEDIA_LIMITS_BYTES[kind];
}

/** Map an inbound attachment's declared content type to the unified media type. */
export function classifyQQInbound(contentType: string | undefined, fileName: string | undefined): IMMediaType {
  const type = (contentType || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'voice';
  const ext = path.extname(fileName || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.ogg', '.silk', '.amr'].includes(ext)) return 'voice';
  return 'document';
}

/**
 * Turn inbound attachments into download refs.
 *
 * VOICE URLs come in two flavours: `voice_wav_url` (server-side WAV conversion)
 * and the generic `url`. The WAV URL is preferred because it is directly
 * playable; the ASR text is carried separately for the message body.
 */
export function readQQMediaRefs(
  attachments: QQInboundAttachment[] | undefined
): { refs: QQMediaRef[]; skipped: number; asrTexts: string[] } {
  const refs: QQMediaRef[] = [];
  const asrTexts: string[] = [];
  let skipped = 0;

  for (const attachment of attachments || []) {
    if (!attachment || typeof attachment !== 'object') {
      skipped += 1;
      continue;
    }
    if (attachment.asr_refer_text) asrTexts.push(attachment.asr_refer_text);
    const isVoice = (attachment.content_type || '').toLowerCase().startsWith('audio/');
    const url = isVoice && attachment.voice_wav_url ? attachment.voice_wav_url : attachment.url;
    if (!url || !/^https:\/\//i.test(url)) {
      skipped += 1;
      continue;
    }
    const kind = classifyQQInbound(attachment.content_type, attachment.filename);
    refs.push({
      kind: kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'document',
      url,
      fileName: attachment.filename,
      size: typeof attachment.size === 'number' ? attachment.size : undefined,
      contentType: attachment.content_type,
      width: attachment.width,
      height: attachment.height,
    });
  }

  return { refs, skipped, asrTexts };
}

/**
 * Mask anything that looks like an AppSecret before it reaches a log line.
 * AppSecrets are 32-64 chars of base64url-ish text; matching them broadly would
 * eat useful text, so this only masks values adjacent to a `secret`-ish key.
 */
export function redactQQSecrets(text: string): string {
  return (text || '')
    .replace(/(appSecret\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/(clientSecret\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/(access_token\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}
