/**
 * Trade activity detection (S4 chat trade markers) — renderer side.
 *
 * Scans a chat message's markdown text for `nft-card` fences (the S3 card
 * syntax) and classifies the trade kind the message announces:
 *
 *   'p2p'    — contract sale/listing (listed/sold/bought/delisted) or a
 *              direct transfer (transferred) — the wallet/mrc721 tool
 *              announcements.
 *   'escrow' — three-party escrow activity (action 'escrow', the
 *              syntax-layer reserved value group escrow emitters write).
 *
 * Detection reuses the same parser the cards themselves render through
 * (nftCardSyntax.parseNftCardFence / parseNftCardGroupFence), so a fence only
 * counts when it would actually render as a card — analysis text that quotes
 * a fence (line-number prefixes, truncated JSON) never validates and can
 * never fake a badge. DOM-free so SSR tests drive it directly.
 */

import {
  isNftCardFenceLanguage,
  isNftCardGroupFenceLanguage,
  parseNftCardFence,
  parseNftCardGroupFence,
  type NftCardData,
} from './nftCardSyntax';

export type TradeBadgeKind = 'p2p' | 'escrow';

export interface TradeActivity {
  kind: TradeBadgeKind;
  /** The card actions seen (lower-cased), strongest evidence first. */
  actions: string[];
}

/** Actions that announce peer-to-peer trade activity. */
const P2P_ACTIONS = new Set(['listed', 'sold', 'bought', 'delisted', 'transferred']);
/** Actions that announce escrow activity. */
const ESCROW_ACTIONS = new Set(['escrow']);

const actionTradeKind = (action: string | undefined): TradeBadgeKind | null => {
  if (!action) return null;
  if (ESCROW_ACTIONS.has(action)) return 'escrow';
  if (P2P_ACTIONS.has(action)) return 'p2p';
  return null;
};

/** Escrow outranks p2p — an escrow message subsumes the transfers around it. */
const mergeKind = (a: TradeBadgeKind | null, b: TradeBadgeKind | null): TradeBadgeKind | null => {
  if (a === 'escrow' || b === 'escrow') return 'escrow';
  if (a === 'p2p' || b === 'p2p') return 'p2p';
  return null;
};

/**
 * Host stamp structural check (renderer side, main-side HMAC verify mirror).
 *
 * The renderer cannot hold the HMAC secret (source-signing slice, owner
 * decision A), so this is a presence-shape + binding check only: the stamp
 * must parse as `v1.<issuedMs>.<sessionId>.<64hex>` and — when the viewing
 * context knows its session id — bind to THAT session (a card relayed from
 * another session's emit fails, killing the cross-session mislabel).
 * Authoritative HMAC verification lives main-side (tradeBadge.ts write
 * path); the renderer chip never fabricates a mark the store column lacks.
 */
const STAMP_PREFIX = 'v1.';

const stampSessionBound = (card: NftCardData, sessionId: string | undefined): boolean => {
  const row = card as unknown as Record<string, unknown>;
  const stamp = typeof row.hostStamp === 'string' ? row.hostStamp.trim() : '';
  if (!stamp.startsWith(STAMP_PREFIX)) return false;
  const tail = stamp.slice(STAMP_PREFIX.length);
  const first = tail.indexOf('.');
  if (first <= 0) return false;
  if (!/^\d+$/.test(tail.slice(0, first))) return false;
  const rest = tail.slice(first + 1);
  const second = rest.indexOf('.');
  if (second <= 0) return false;
  const bound = rest.slice(0, second);
  if (!bound || !/^[0-9a-f]{64}$/.test(rest.slice(second + 1))) return false;
  // Chain-side group transcripts have no cowork session id to bind to; the
  // shape check above is the strongest available there (trust model:
  // adversary-in-the-message is out of scope, HMAC truth stays main-side).
  return !sessionId || bound === sessionId;
};

const foldCards = (
  cards: NftCardData[],
  state: { kind: TradeBadgeKind | null; actions: string[] },
  context: { sessionId?: string } | undefined,
): void => {
  for (const card of cards) {
    const kind = actionTradeKind(card.action);
    if (!kind) continue;
    if (kind === 'p2p' && !stampSessionBound(card, context?.sessionId)) continue;
    state.kind = mergeKind(state.kind, kind);
    state.actions.push(card.action as string);
  }
};

/**
 * Detect the trade activity a message's text announces. Returns null for
 * messages with no trade-card fence (including every text that merely
 * mentions tools or quotes fences without valid card payloads).
 *
 * Source-signing slice (2026-11-03): p2p cards must carry a v1-shaped
 * hostStamp; when `context.sessionId` is known (cowork session detail / A2A)
 * the stamp must also bind to that session. Escrow keeps the reserved
 * hand-written contract.
 */
export const detectTradeActivity = (
  content: string,
  context?: { sessionId?: string },
): TradeActivity | null => {
  const text = typeof content === 'string' ? content : '';
  if (!text || !text.includes('```')) return null;

  const state: { kind: TradeBadgeKind | null; actions: string[] } = { kind: null, actions: [] };
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const open = /^```([A-Za-z0-9_-]*)[ \t]*$/.exec(lines[i]);
    if (!open) continue;
    const tag = open[1].trim().toLowerCase();
    const isCard = isNftCardFenceLanguage(tag);
    const isGroup = isNftCardGroupFenceLanguage(tag);
    if (!isCard && !isGroup) continue;

    let j = i + 1;
    const bodyLines: string[] = [];
    while (j < lines.length && !/^```[ \t]*$/.test(lines[j])) {
      bodyLines.push(lines[j]);
      j += 1;
    }
    if (j >= lines.length) continue; // unterminated fence — keep scanning the rest of the text
    i = j;

    const body = bodyLines.join('\n').trim();
    if (!body) continue;
    if (isGroup) {
      const cards = parseNftCardGroupFence(body);
      if (cards) foldCards(cards, state, context);
    } else {
      const card = parseNftCardFence(body);
      if (card) foldCards([card], state, context);
    }
  }

  if (!state.kind) return null;
  return { kind: state.kind, actions: state.actions };
};
