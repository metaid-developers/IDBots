/**
 * Local Weixin message ledger — `msg_id` → a short local summary.
 *
 * WHY THIS EXISTS
 * The platform's quote payload (`item_list[*].ref_msg.message_item`) carries
 * exactly ONE usable field: a 19-digit `msg_id`. No quoted text, no sender, no
 * media metadata (captured 2026-11-04 on a real reply). Everything a quote can
 * show therefore has to come from records this host made itself:
 *
 *   outbound → `message_id` returned by `ilink/bot/sendmessage`
 *   inbound  → the top-level `message_id` on the getupdates message
 *
 * With both directions stored, "quote my own earlier message" and "quote the
 * bot's reply" resolve through the same lookup.
 *
 * BOUNDARIES (deliberate)
 * - Convenience data, never a source of truth: a miss degrades the quote prefix
 *   to the honest fallback sentence; it must never fail a send or a delivery.
 * - Bounded by construction: TTL + per-conversation row cap (constants below),
 *   enforced by `IMStore` inside the insert path.
 * - No network: the quoted message is never re-fetched from the platform.
 */

import type { WeixinInboundMessage, WeixinQuoteSummary } from './weixinProtocol';
import {
  extractWeixinText,
  WEIXIN_ITEM_TYPE_FILE,
  WEIXIN_ITEM_TYPE_IMAGE,
  WEIXIN_ITEM_TYPE_VIDEO,
  WEIXIN_ITEM_TYPE_VOICE,
} from './weixinProtocol';

/** Stored text cap. The quote prefix further trims to 120 chars at render time. */
export const WEIXIN_LEDGER_TEXT_MAX_CHARS = 400;

/** Rows kept per conversation, newest first. Old rows are evicted on write. */
export const WEIXIN_LEDGER_MAX_ROWS_PER_CONVERSATION = 500;

/** Age cap for every row, regardless of conversation. */
export const WEIXIN_LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Runtime off-switch: `IDBOTS_WEIXIN_LEDGER=0` disables the ledger without a
 * rebuild (same convention as the raw-inbound log). Anything else keeps it on.
 */
export const WEIXIN_LEDGER_ENV_VAR = 'IDBOTS_WEIXIN_LEDGER';

export function isWeixinLedgerEnabledByEnv(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[WEIXIN_LEDGER_ENV_VAR] !== '0';
}

export type WeixinLedgerDirection = 'in' | 'out';

export type WeixinLedgerKind = 'text' | 'image' | 'file' | 'voice' | 'video';

export interface WeixinLedgerEntry {
  /** Server `msg_id` — the exact digits a quote reference carries. */
  msgId: string;
  /** Conversation key the message belongs to (`to_user_id` / `from_user_id`). */
  conversationId: string;
  direction: WeixinLedgerDirection;
  kind: WeixinLedgerKind;
  /** Plain-text summary, already capped; null for media-only messages. */
  text: string | null;
  createdAt: number;
}

export interface WeixinLedgerEntryInput {
  /** Raw id from the platform; validated by {@link buildWeixinLedgerEntry}. */
  msgId: unknown;
  conversationId: unknown;
  direction: WeixinLedgerDirection;
  kind: WeixinLedgerKind;
  text: string | null;
  createdAt: number;
}

/**
 * The storage contract the gateway depends on. `IMStore` adapts to it; tests
 * use an in-memory map. Both methods may throw — the gateway catches.
 */
export interface WeixinMessageLedger {
  put(entry: WeixinLedgerEntry): void;
  get(msgId: string): WeixinLedgerEntry | null;
}

/**
 * Accept a server id only in a form that can MATCH a quote reference.
 *
 * 19-digit ids do not survive `JSON.parse` as numbers (7523489994131519368
 * becomes …520000). A rounded value is refused instead of stored: a wrong key
 * looks like a working ledger but can never resolve, which is worse than no
 * entry (no entry at least logs as "unknown id").
 */
export function normalizeWeixinLedgerId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!Number.isSafeInteger(value)) return null;
    return String(value);
  }
  return null;
}

/** Cap stored text by CODE POINTS so an emoji is never cut in half. */
export function truncateWeixinLedgerText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const chars = Array.from(trimmed);
  if (chars.length <= WEIXIN_LEDGER_TEXT_MAX_CHARS) return trimmed;
  return chars.slice(0, WEIXIN_LEDGER_TEXT_MAX_CHARS).join('');
}

/** Build a storable entry, or null when the input cannot be keyed faithfully. */
export function buildWeixinLedgerEntry(input: WeixinLedgerEntryInput): WeixinLedgerEntry | null {
  const msgId = normalizeWeixinLedgerId(input.msgId);
  const conversationId = typeof input.conversationId === 'string'
    ? input.conversationId.trim()
    : '';
  if (!msgId || !conversationId) return null;
  if (input.direction !== 'in' && input.direction !== 'out') return null;
  return {
    msgId,
    conversationId,
    direction: input.direction,
    kind: input.kind,
    text: truncateWeixinLedgerText(input.text),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
  };
}

/** Item type → media kind, for the item_list we received. */
const ITEM_KIND_BY_TYPE: Record<number, WeixinLedgerKind> = {
  [WEIXIN_ITEM_TYPE_IMAGE]: 'image',
  [WEIXIN_ITEM_TYPE_VOICE]: 'voice',
  [WEIXIN_ITEM_TYPE_FILE]: 'file',
  [WEIXIN_ITEM_TYPE_VIDEO]: 'video',
};

/**
 * Content to store for one inbound message.
 *
 * Text wins over a media label on purpose: a voice item arrives with a server
 * side transcript, and quoting that transcript is more useful than the generic
 * "quoted a voice message". A media-only message stores kind + no text, which
 * renders as "（引用了一张图片）".
 */
export function readWeixinLedgerContent(
  raw: WeixinInboundMessage | null | undefined
): { kind: WeixinLedgerKind; text: string | null } {
  const text = extractWeixinText(raw?.item_list);
  if (text) return { kind: 'text', text };

  const itemList = Array.isArray(raw?.item_list) ? raw.item_list : [];
  for (const item of itemList) {
    const kind = item && typeof item.type === 'number' ? ITEM_KIND_BY_TYPE[item.type] : undefined;
    if (kind) return { kind, text: null };
  }
  return { kind: 'text', text: null };
}

/**
 * Map a stored entry to the quote summary the protocol formatter renders.
 * Returns null when the entry cannot say anything honest (empty text).
 */
export function weixinLedgerEntryToQuote(
  entry: WeixinLedgerEntry | null | undefined
): WeixinQuoteSummary | null {
  if (!entry) return null;
  if (entry.kind === 'text') {
    return entry.text ? { text: entry.text } : null;
  }
  return { kind: entry.kind };
}
