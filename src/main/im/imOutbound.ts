/**
 * Desktop-initiated IM outbound ("电脑端主动发消息") — the pure layer.
 *
 * Why this exists: the gateways already know how to deliver into an existing
 * conversation (`IMConversationSender.sendToConversation`), but only an IM
 * session holding an inbound closure could use it. From a cowork_ui session the
 * agent had no tool at all, and the real-device failure was predictable: asked
 * to "给微信发消息", the model went looking for the WeChat desktop client and
 * tried to drive its window. This module gives the desktop one audited path —
 * channel API in, explicit result out.
 *
 * SAFETY BOUNDARY (load-bearing, do not widen without the owner):
 *   - the only allowed destination is the most recent DIRECT (private)
 *     conversation on that channel (`IMOutboundTransport.conversationId`),
 *     resolved by the manager from the persisted mapping rows / the gateway's
 *     last-inbound memory — group chats are never eligible;
 *   - an explicit `target` that is not exactly that id is REFUSED, never
 *     "best-effort" resolved into some other chat;
 *   - nothing here touches funds: no wallet, no transfer, no payment path.
 *
 * Everything in this file is pure/injectable so the tool's success, refusal and
 * degradation paths are unit-testable without a live gateway.
 */

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IMPlatform } from './types';

export type IMOutboundMediaKind = 'image' | 'video' | 'audio' | 'file';

/**
 * HOW the destination was established — a different question from "is it a
 * direct chat":
 *   - `owner-binding`: the channel binds the destination to a QR-verified owner
 *     identity (weixin `ownerUserId`, QQ `ownerUserOpenid`), so the id cannot be
 *     a stranger who happened to DM the bot;
 *   - `last-direct`: the most recent direct conversation seen on that channel,
 *     whoever started it. The recipient's identity is NOT verified.
 */
export type IMOutboundTargetIdentityBasis = 'owner-binding' | 'last-direct';

/** Fail-closed: only an explicit `true` from the gateway means owner-binding. */
export function imOutboundTargetBasis(
  transport: Pick<IMOutboundTransport, 'ownerIdentityBound'> | null | undefined
): IMOutboundTargetIdentityBasis {
  return transport?.ownerIdentityBound === true ? 'owner-binding' : 'last-direct';
}

/** The model-facing name of the destination, honest about the basis. */
function describeTargetIdentity(basis: IMOutboundTargetIdentityBasis): string {
  return basis === 'owner-binding' ? 'owner 私聊' : '最近一次私聊会话，未经身份校验';
}

export interface IMOutboundCapabilities {
  /** Extensions WITHOUT the leading dot. */
  extensionsByKind: {
    image: string[];
    video: string[];
    audio: string[];
    file: string[];
  };
  /** Per-kind byte ceiling; `file` is the fallback for anything unclassified. */
  maxBytesByKind: {
    image: number;
    video: number;
    audio: number;
    file: number;
  };
}

/** One row of the machine-readable channel inventory. */
export interface IMOutboundChannelView {
  platform: string;
  label: string;
  connected: boolean;
  /** connected AND has a resolvable private conversation with the owner. */
  sendable: boolean;
  /** Why not sendable (model-facing, Chinese). null when sendable. */
  reason: string | null;
  /** The resolved DIRECT destination, when known. Whether it is the owner's is
   *  a separate fact: see `targetIdentityBasis`. */
  conversationId: string | null;
  /** Whether that conversation is bound to the owner's identity, or merely the
   *  most recent direct chat (see IMOutboundTargetIdentityBasis). */
  targetIdentityBasis: IMOutboundTargetIdentityBasis;
  capabilities: IMOutboundCapabilities | null;
}

/** The injectable piece the manager supplies per channel. */
export interface IMOutboundTransport {
  platform: string;
  label: string;
  connected: boolean;
  /**
   * The most recent DIRECT (private) conversation with the owner, resolved by
   * the manager from the persisted `im_session_mappings` rows (validated as
   * `im:<platform>:direct`) or, as a fallback, the gateway's own last-inbound
   * memory. Group chats are never eligible.
   */
  conversationId: string | null;
  /**
   * `true` when the gateway binds that conversation to a QR-verified owner
   * identity. Optional and fail-closed on purpose: an absent method (every
   * channel added in the future, unless it opts in) reads as `false`, i.e.
   * "this is the last direct chat, identity not verified" — never as the owner.
   */
  ownerIdentityBound?: boolean;
  capabilities: IMOutboundCapabilities | null;
  sender: IMOutboundSender | null;
  /** Only for a gateway that truly cannot address a conversation by id. */
  unavailableReason?: string | null;
}

export interface IMOutboundSender {
  sendToConversation(conversationId: string, text: string): Promise<void>;
  /** Optional: channels without it report attachment sends as unsupported. */
  sendMediaToConversation?(conversationId: string, filePath: string): Promise<void>;
}

/**
 * The provider the cowork runner holds: inventory + send. Implemented by
 * IMGatewayManager (live gateways), injected in main.ts.
 */
export interface CoworkImOutboundProvider {
  listChannels(): IMOutboundChannelView[];
  send(request: IMOutboundSendRequest): Promise<IMOutboundSendResult>;
}

export interface IMOutboundSendRequest {
  channel: string;
  target?: string | null;
  text?: string | null;
  attachments?: string[] | null;
}

export interface IMOutboundAttachmentResult {
  path: string;
  bytes: number;
  kind: IMOutboundMediaKind;
}

export interface IMOutboundSendResult {
  ok: boolean;
  channel: string;
  label: string;
  target: string | null;
  /**
   * Kept for existing fixtures: it now means only "resolved to a direct
   * destination". Whether that destination is the OWNER is answered by
   * `targetIdentityBasis`, not by this boolean.
   */
  targetIsOwnerDirect: boolean;
  /** How `target` was established; only meaningful when `target` is set. */
  targetIdentityBasis: IMOutboundTargetIdentityBasis;
  textChars: number;
  attachments: IMOutboundAttachmentResult[];
  warnings: string[];
  errors: string[];
}

/** Human labels; the prompt and tool result both use these. */
export const IM_OUTBOUND_CHANNEL_LABELS: Record<string, string> = {
  weixin: '微信',
  feishu: '飞书',
  qq: 'QQ',
  dingtalk: '钉钉',
  telegram: 'Telegram',
  discord: 'Discord',
};

/**
 * `wechat` / `wx` / `im:weixin:direct` / `Feishu` all normalize to the platform
 * key. Unknown values are returned trimmed+lowercased so the refusal can quote
 * what the caller actually asked for.
 */
export function normalizeImOutboundChannel(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return '';
  const bare = value.startsWith('im:') ? value.split(':')[1] ?? '' : value;
  switch (bare) {
    case 'wx':
    case 'wechat':
    case 'weixin':
      return 'weixin';
    case 'lark':
    case 'feishu':
      return 'feishu';
    case 'qqbot':
    case 'qq':
      return 'qq';
    case 'dingtalk':
    case 'dingding':
      return 'dingtalk';
    case 'telegram':
    case 'tg':
      return 'telegram';
    case 'discord':
      return 'discord';
    default:
      return bare;
  }
}

export function channelLabel(platform: string): string {
  return IM_OUTBOUND_CHANNEL_LABELS[platform] ?? (platform || '未知通道');
}

/** `100 MB` / `3072 B` — derived from the constant, never hand-typed. */
export function formatOutboundByteLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (Number.isInteger(mb)) return `${mb} MB`;
  return `${bytes} B`;
}

const formatExtensions = (extensions: string[]): string =>
  extensions.length > 0 ? extensions.map((extension) => `.${extension}`).join(' ') : '(none)';

/** Classify one attachment against THIS channel's own extension tables. */
export function classifyOutboundMedia(
  filePath: string,
  capabilities: IMOutboundCapabilities
): IMOutboundMediaKind {
  const extension = path.extname(filePath || '').replace(/^\./, '').toLowerCase();
  if (capabilities.extensionsByKind.image.includes(extension)) return 'image';
  if (capabilities.extensionsByKind.video.includes(extension)) return 'video';
  if (capabilities.extensionsByKind.audio.includes(extension)) return 'audio';
  return 'file';
}

/**
 * One channel → its inventory row. `sendable` demands all four facts, because
 * advertising a channel that would then fail is worse than saying why it cannot
 * send.
 */
export const NO_DIRECT_CONVERSATION_REASON = '尚无与你的私聊会话，先给它发一条消息即可';

export function describeImOutboundChannel(transport: IMOutboundTransport): IMOutboundChannelView {
  const label = transport.label || channelLabel(transport.platform);
  let reason: string | null = null;
  if (!transport.connected) {
    reason = '未连接';
  } else if (!transport.sender) {
    reason = transport.unavailableReason ?? '该网关未实现按会话发送';
  } else if (!transport.capabilities) {
    reason = '该通道未登记可发类型与大小上限（未审校，不能承诺能发）';
  } else if (!transport.conversationId) {
    reason = NO_DIRECT_CONVERSATION_REASON;
  }
  return {
    platform: transport.platform,
    label,
    connected: transport.connected,
    sendable: reason === null,
    reason,
    conversationId: transport.conversationId,
    targetIdentityBasis: imOutboundTargetBasis(transport),
    capabilities: transport.capabilities,
  };
}

/**
 * Model-facing capability line(s) for ONE channel. Extension lists and byte
 * ceilings come from the channel's own constants through `capabilities`.
 */
export function renderOutboundChannelForPrompt(view: IMOutboundChannelView): string {
  const head = `${view.label}（${view.platform}）`;
  if (!view.connected) return `- ${head}：未连接`;
  if (!view.sendable) {
    return `- ${head}：已连接，但${view.reason ?? '暂不可发送'}`;
  }
  const caps = view.capabilities!;
  const audio = new Set(caps.extensionsByKind.audio);
  const files = caps.extensionsByKind.file.filter((extension) => !audio.has(extension));
  const segments: string[] = [];
  if (caps.extensionsByKind.image.length > 0) {
    segments.push(`图片 ${formatExtensions(caps.extensionsByKind.image)}`);
  }
  if (caps.extensionsByKind.video.length > 0) {
    segments.push(`视频 ${formatExtensions(caps.extensionsByKind.video)}`);
  } else {
    segments.push('视频：按普通文件发送');
  }
  if (caps.extensionsByKind.audio.length > 0) {
    segments.push(`音频 ${formatExtensions(caps.extensionsByKind.audio)}`);
  }
  segments.push(files.length > 0 ? `其他文件 ${formatExtensions(files)}（未列出的扩展名同样按普通文件发送）` : '其他文件：任意扩展名按普通文件发送');
  const limits = new Set(Object.values(caps.maxBytesByKind));
  const limitText = limits.size === 1
    ? `单文件上限 ${formatOutboundByteLimit(caps.maxBytesByKind.file)}`
    : `单文件上限：图片 ${formatOutboundByteLimit(caps.maxBytesByKind.image)}｜视频 ${formatOutboundByteLimit(caps.maxBytesByKind.video)}｜音频 ${formatOutboundByteLimit(caps.maxBytesByKind.audio)}｜文件 ${formatOutboundByteLimit(caps.maxBytesByKind.file)}`;
  const destination = view.targetIdentityBasis === 'owner-binding'
    ? '可主动发送到 owner 私聊'
    : '可主动发送到该通道最近一次私聊会话（未经身份校验：该通道没有 owner 身份绑定）';
  return `- ${head}：已连接，${destination}。${segments.join('；')}；${limitText}`;
}

const failure = (
  channel: string,
  label: string,
  errors: string[],
  extras: Partial<IMOutboundSendResult> = {}
): IMOutboundSendResult => ({
  ok: false,
  channel,
  label,
  target: null,
  targetIsOwnerDirect: false,
  // No destination resolved, so there is no identity claim to make. Any caller
  // that DOES resolve a target overrides this with the transport's real basis.
  targetIdentityBasis: 'last-direct',
  textChars: 0,
  attachments: [],
  warnings: [],
  errors,
  ...extras,
});

/**
 * A send that THROWS (a manager/transport bug, not a refused delivery) is still
 * an attempt the human must see in the transcript. Normalizing it into the same
 * result shape keeps the echo path on one contract instead of two.
 */
export function outboundSendResultFromError(channel: string, error: unknown): IMOutboundSendResult {
  const normalized = normalizeImOutboundChannel(channel);
  return failure(normalized, channelLabel(normalized), [
    `发送时发生未预期错误：${error instanceof Error ? error.message : String(error)}`,
  ]);
}

/**
 * The single send path. Every refusal returns `ok:false` with an explicit
 * reason — a silent no-op would leave the model believing it delivered.
 */
export async function sendImOutboundMessage(
  transport: IMOutboundTransport | null,
  request: IMOutboundSendRequest
): Promise<IMOutboundSendResult> {
  const channel = normalizeImOutboundChannel(request.channel);
  const label = transport?.label ?? channelLabel(channel);
  if (!transport) {
    return failure(channel, label, [
      channel
        ? `未知通道「${request.channel}」：本机只登记了微信（weixin）、飞书（feishu）、QQ（qq）、钉钉、Telegram、Discord 六个通道。`
        : '缺少 channel 参数。',
    ]);
  }
  if (!transport.connected) {
    return failure(channel, label, [
      `${label}通道未连接：请先在设置里连接该通道，再让我发送。本次没有发出任何内容。`,
    ]);
  }
  if (!transport.sender) {
    return failure(channel, label, [
      `${label}通道无法按会话发送：${transport.unavailableReason ?? '网关未实现按会话发送'}。本次没有发出任何内容。`,
    ]);
  }
  const ownerConversationId = transport.conversationId;
  if (!ownerConversationId) {
    return failure(channel, label, [
      `${label}通道${NO_DIRECT_CONVERSATION_REASON}。本次没有发出任何内容。`,
    ]);
  }
  // Resolved once, from the gateway's own answer — never from a platform list
  // hard-coded here. Absent/false ⇒ last-direct ⇒ the copy says "unverified".
  const targetIdentityBasis = imOutboundTargetBasis(transport);

  const requestedTarget = typeof request.target === 'string' ? request.target.trim() : '';
  if (requestedTarget && requestedTarget !== ownerConversationId) {
    return failure(channel, label, [
      `拒绝发送：本工具只允许发往该通道上最近一次与你的私聊会话，target「${requestedTarget}」不是该会话。`,
    ]);
  }

  const text = typeof request.text === 'string' ? request.text : '';
  const attachments = (Array.isArray(request.attachments) ? request.attachments : [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  if (!text.trim() && attachments.length === 0) {
    return failure(channel, label, ['没有可发的内容：text 与 attachments 至少提供一个。'], {
      target: ownerConversationId,
      targetIsOwnerDirect: true,
      targetIdentityBasis,
    });
  }

  const capabilities = transport.capabilities;
  const errors: string[] = [];
  // Validate EVERY attachment before the first outbound byte: a bad path or an
  // over-limit file must not leave the chat with a half-sent batch whose reason
  // the model has to guess.
  const validated: Array<{ path: string; bytes: number; kind: IMOutboundMediaKind }> = [];
  for (const attachment of attachments) {
    if (!path.isAbsolute(attachment)) {
      errors.push(`附件必须是本地绝对路径：${attachment}`);
      continue;
    }
    let stats: fs.Stats;
    try {
      stats = fs.statSync(attachment);
    } catch {
      errors.push(`附件不存在：${attachment}`);
      continue;
    }
    if (!stats.isFile()) {
      errors.push(`附件不是普通文件：${attachment}`);
      continue;
    }
    if (stats.size <= 0) {
      errors.push(`附件是空文件，拒绝发送：${attachment}`);
      continue;
    }
    if (!capabilities) {
      errors.push(`${label}通道未登记可发类型与上限，拒绝发送附件：${attachment}`);
      continue;
    }
    const kind = classifyOutboundMedia(attachment, capabilities);
    const limit = capabilities.maxBytesByKind[kind] ?? capabilities.maxBytesByKind.file;
    if (stats.size > limit) {
      errors.push(
        `附件 ${path.basename(attachment)} 为 ${stats.size} bytes，超过${label} ${kind} 上限 ${limit} bytes：拒绝发送。`
      );
      continue;
    }
    if (typeof transport.sender.sendMediaToConversation !== 'function') {
      errors.push(`${label}通道不支持发送附件（网关未实现媒体发送）：${attachment}`);
      continue;
    }
    validated.push({ path: attachment, bytes: stats.size, kind });
  }

  // Text first, then media: the caption-less file arrives after the sentence
  // that introduces it, which is how a human sends it.
  let textChars = 0;
  if (text.trim()) {
    try {
      await transport.sender.sendToConversation(ownerConversationId, text);
      textChars = text.length;
    } catch (error) {
      errors.push(`${label}文本发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const accepted: IMOutboundAttachmentResult[] = [];
  for (const attachment of validated) {
    try {
      await transport.sender.sendMediaToConversation!(ownerConversationId, attachment.path);
      accepted.push(attachment);
    } catch (error) {
      errors.push(`${label}附件发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    channel,
    label,
    target: ownerConversationId,
    targetIsOwnerDirect: true,
    targetIdentityBasis,
    textChars,
    attachments: accepted,
    warnings: [],
    errors,
  };
}

// ==================== Record of an outbound send in the IM conversation =====
//
// Owner-corrected requirement (2026-11-04): a proactive send must show up IN THE
// CHAT IT WENT TO — the WeChat conversation's own cowork session — not in the
// desktop session that triggered it. Opening that IM session then shows what was
// sent, with which files and when, next to the inbound/reply bubbles.
//
// Shape of the record (owner ruling 2026-11-04, third correction — the real
// device read the first shape as "an audit card", not as a sent message):
//   - `system` type — NOT `assistant`. Two concrete reasons, not cosmetics:
//     (a) the turn-context filter drops `system` rows, so this echo never
//     becomes model history on the chat's next turn; (b) the IM out-of-turn
//     forwarder treats the newest non-thinking `assistant` row of a turn as the
//     reply to deliver — an `assistant` echo could be delivered back to the
//     phone as if it were an answer. A `system` row can do neither; the
//     renderer draws an OK row as a normal outbound chat bubble (v2) and the
//     old card only where the card is the point (see v1 below).
//   - v2 (this version): `content` is the sent body VERBATIM — the exact string
//     handed to the channel, newlines intact, no prefix, no field labels, no
//     200-char truncation. Attachments travel as structured items in metadata,
//     so the transcript can draw each one as its own image/file bubble instead
//     of a filename list.
//   - v1 rows (written before this version) keep the audit card text in
//     `content`; the renderer must NOT put that text in a bubble. Hence
//     `imOutboundRecordVersion`, which lets old rows keep their old rendering
//     instead of showing 方向/目标/摘要 labels inside a chat bubble.
//   - failed / partially delivered attempts keep the v1 card shape even at v2:
//     the failure reason must stay visible, and that card is the shape the
//     human already reads.
//   - one record per attempt (one row, carrying all its attachment bubbles);
//     deterministic id: `addMessageWithId` returns the existing row when the id
//     already exists, so a retried write can never duplicate the echo;
//   - written for failures too — an attempt that silently left no trace is
//     exactly what this record exists to prevent.
//
// The desktop/initiating session gets nothing extra: the tool result already
// reports the outcome there, and a second copy would be a second truth.

/**
 * Version of the in-chat echo record.
 *   1 = audit card only (legacy rows on disk, and every failed attempt).
 *   2 = verbatim body bubble + structured attachment items.
 */
export const IM_OUTBOUND_RECORD_VERSION = 2;

/** Char budget for the body preview inside the LEGACY/failure card (owner: 200 字). */
export const IM_OUTBOUND_RECORD_PREVIEW_CHARS = 200;

/** One delivered attachment, shaped for the transcript (draw it or open it). */
export interface IMOutboundRecordAttachment {
  /** Basename: thumbnail caption / file-chip label. */
  name: string;
  /** Absolute local path of the file the channel delivered. */
  path: string;
  kind: IMOutboundMediaKind;
  bytes: number;
}

/** Metadata the IM session record carries (structured, not parsed back from text). */
export interface IMOutboundRecordMetadata {
  imOutboundSend: true;
  imOutboundDirection: 'outgoing';
  imOutboundOk: boolean;
  imOutboundChannel: string;
  imOutboundConversationId: string;
  imOutboundAt: number;
  /** 2 = bubble; absent/1 = legacy audit card (never re-rendered as a bubble). */
  imOutboundRecordVersion: number;
  /** Basenames, in request order (kept: the card lists them by name). */
  imOutboundAttachments: string[];
  /** Delivered attachments, in send order — one bubble each in the transcript. */
  imOutboundAttachmentItems: IMOutboundRecordAttachment[];
  /** Matches CoworkMessageMetadata's open shape (the store passes it through verbatim). */
  [key: string]: unknown;
}

export interface IMOutboundConversationRecord {
  /** Deterministic per attempt: the store treats a repeated id as the same row. */
  id: string;
  type: 'system';
  content: string;
  metadata: IMOutboundRecordMetadata;
}

const padTwo = (value: number): string => String(value).padStart(2, '0');

/**
 * Local wall-clock time for the record. Local (not UTC) because the human
 * reads this trace against the phone that just buzzed.
 */
export function formatImOutboundRecordTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '（未知时间）';
  return [
    `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`,
    `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}:${padTwo(date.getSeconds())}`,
  ].join(' ');
}

/**
 * One-line, codepoint-safe body preview. Codepoints (not UTF-16 units) so a
 * CJK/emoji body is neither cut mid-surrogate nor miscounted in the "共 N 字".
 */
export function summarizeImOutboundText(
  text: string,
  limit: number = IM_OUTBOUND_RECORD_PREVIEW_CHARS
): { preview: string; chars: number; truncated: boolean } {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { preview: '', chars: 0, truncated: false };
  const codepoints = Array.from(normalized);
  const chars = codepoints.length;
  if (chars <= limit) return { preview: normalized, chars, truncated: false };
  return { preview: `${codepoints.slice(0, limit).join('')}…`, chars, truncated: true };
}

const requestedAttachmentsOf = (request: IMOutboundSendRequest): string[] =>
  (Array.isArray(request.attachments) ? request.attachments : [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);

/**
 * The echo written into the destination IM session for ONE send attempt.
 *
 * A delivered send becomes a normal outbound bubble: `content` IS the body the
 * channel received, verbatim. Everything the human does not see in a chat
 * bubble (channel, destination, counts, time) lives in metadata, where the
 * renderer can use it without putting labels in the text.
 *
 * A refused / partial attempt becomes the audit card instead (v1 shape): the
 * failure reason is the message, and it must not be dressed up as a normal
 * outgoing bubble the phone never received.
 */
export function buildImOutboundConversationRecord(input: {
  request: IMOutboundSendRequest;
  result: IMOutboundSendResult;
  timestamp?: number;
  /**
   * The conversation this record is filed in. Only differs from `result.target`
   * when the send was refused before a destination was resolved (channel
   * disconnected / no direct chat yet): the failure is still filed in the
   * channel's last known private chat, and the bubble must not pretend that
   * chat was the target.
   */
  conversationId?: string | null;
}): IMOutboundConversationRecord {
  const { request, result } = input;
  const timestamp = Number.isFinite(input.timestamp) ? Number(input.timestamp) : Date.now();
  const filedIn = (input.conversationId ?? result.target ?? '').trim();
  const requested = requestedAttachmentsOf(request);
  const attachmentNames = requested.map((attachment) => path.basename(attachment) || attachment);
  // The delivered files, shaped for the transcript: one image/file bubble each.
  const deliveredItems: IMOutboundRecordAttachment[] = result.attachments.map((attachment) => ({
    name: path.basename(attachment.path) || attachment.path,
    path: attachment.path,
    kind: attachment.kind,
    bytes: attachment.bytes,
  }));

  const id = `imout-${crypto.createHash('sha1')
    .update([
      result.channel,
      filedIn,
      String(timestamp),
      typeof request.text === 'string' ? request.text : '',
      requested.join('\u0000'),
    ].join('\u0001'))
    .digest('hex')
    .slice(0, 24)}`;

  const metadata: IMOutboundRecordMetadata = {
    imOutboundSend: true,
    imOutboundDirection: 'outgoing',
    imOutboundOk: result.ok,
    imOutboundChannel: result.channel,
    imOutboundConversationId: filedIn,
    imOutboundAt: timestamp,
    imOutboundRecordVersion: IM_OUTBOUND_RECORD_VERSION,
    imOutboundAttachments: attachmentNames,
    imOutboundAttachmentItems: deliveredItems,
  };

  // Delivered: the bubble body is exactly what the channel received. The
  // literal string, not a normalized/truncated view of it — the owner asked for
  // "发多少显示多少", newlines included. Whitespace-only text was never sent
  // (`sendImOutboundMessage` requires `text.trim()`), so an attachment-only
  // send keeps an empty body instead of a bubble full of blanks.
  if (result.ok) {
    const sentText = typeof request.text === 'string' ? request.text : '';
    return {
      id,
      type: 'system',
      content: sentText.trim() ? sentText : '',
      metadata,
    };
  }

  // Failed / partial: the audit card (v1 shape), unchanged — the visible reason
  // is the whole point of this row.
  const body = summarizeImOutboundText(typeof request.text === 'string' ? request.text : '');
  const delivered = new Set(result.attachments.map((attachment) => attachment.path));
  const deliveredCount = requested.filter((attachment) => delivered.has(attachment)).length;
  // "失败" over a half-delivered batch would tell the human nothing went out
  // while their phone already has the text — say what actually happened.
  const partiallyDelivered = result.textChars > 0 || result.attachments.length > 0;

  // The channel label stays in the card: the same record shape is written for
  // every channel, so the text has to say which one failed to deliver.
  const lines: string[] = [
    `⚠️ 方向：已发出 · ${result.label}（${result.channel}）· ${formatImOutboundRecordTime(timestamp)}`,
  ];
  // Target: the actual resolved direct chat, or an explicit "not resolved" on a
  // refusal that never got that far. Never the id of the chat we FILE in by
  // inference — that would claim a destination the send never had. The name
  // follows targetIdentityBasis: a channel without an owner binding says
  // "unverified" instead of calling a stranger's chat the owner's.
  lines.push(result.target
    ? (result.targetIdentityBasis === 'owner-binding'
      ? `目标：owner 私聊（${result.target}）`
      : `目标：最近一次私聊会话（未经身份校验，${result.target}）`)
    : '目标：未解析（本次没有发出）');
  if (body.chars === 0) {
    lines.push('摘要：（无正文，仅附件）');
  } else {
    lines.push(body.truncated ? `摘要：${body.preview}（共 ${body.chars} 字）` : `摘要：${body.preview}`);
  }
  if (attachmentNames.length === 0) {
    lines.push('附件：无');
  } else {
    const tally = deliveredCount === requested.length
      ? `${requested.length} 个`
      : `请求 ${requested.length} 个，成功 ${deliveredCount} 个`;
    lines.push(`附件：${attachmentNames.join('、')}（${tally}）`);
  }
  if (partiallyDelivered) {
    lines.push(`结果：部分成功（文本 ${result.textChars} 字，附件 ${deliveredCount}/${requested.length} 个）`);
  } else {
    lines.push('结果：失败（未送达）');
  }
  for (const error of result.errors) lines.push(`- ${error}`);

  return {
    id,
    type: 'system',
    content: lines.join('\n'),
    metadata,
  };
}

/** Plain-text rendering for the tool result. */
export function formatImOutboundSendResult(result: IMOutboundSendResult): string {
  if (!result.ok) {
    const lines = [`im_send_message 失败：${result.label}（${result.channel}）`];
    if (result.target) {
      lines.push(`目标：${result.target}（${describeTargetIdentity(result.targetIdentityBasis)}）`);
    }
    for (const error of result.errors) lines.push(`- ${error}`);
    if (result.attachments.length > 0) {
      lines.push(`已发出 ${result.attachments.length} 个附件（部分成功）：`);
      for (const attachment of result.attachments) {
        lines.push(`  - ${attachment.path}（${attachment.bytes} bytes，${attachment.kind}）`);
      }
    }
    lines.push('本次没有静默丢弃：以上即为失败原因。');
    // Filing the record can fail on its own (no IM session, storage error).
    // The send's verdict must not absorb that, but the model/user must see it
    // instead of it living only in the log.
    for (const warning of result.warnings) lines.push(`注意：${warning}`);
    return lines.join('\n');
  }
  const lines = [
    `im_send_message 成功：${result.label}（${result.channel}）→ ${describeTargetIdentity(result.targetIdentityBasis)}`,
    `目标：${result.target}`,
    `文本：${result.textChars} 字`,
  ];
  if (result.attachments.length === 0) {
    lines.push('附件：无');
  } else {
    lines.push(`附件：${result.attachments.length} 个`);
    for (const attachment of result.attachments) {
      lines.push(`  - ${attachment.path}（${attachment.bytes} bytes，${attachment.kind}）`);
    }
  }
  for (const warning of result.warnings) lines.push(`注意：${warning}`);
  return lines.join('\n');
}
