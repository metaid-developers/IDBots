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

const foldCards = (cards: NftCardData[], state: { kind: TradeBadgeKind | null; actions: string[] }): void => {
  for (const card of cards) {
    const kind = actionTradeKind(card.action);
    if (!kind) continue;
    state.kind = mergeKind(state.kind, kind);
    state.actions.push(card.action as string);
  }
};

/**
 * Detect the trade activity a message's text announces. Returns null for
 * messages with no trade-card fence (including every text that merely
 * mentions tools or quotes fences without valid card payloads).
 */
export const detectTradeActivity = (content: string): TradeActivity | null => {
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
      if (cards) foldCards(cards, state);
    } else {
      const card = parseNftCardFence(body);
      if (card) foldCards([card], state);
    }
  }

  if (!state.kind) return null;
  return { kind: state.kind, actions: state.actions };
};
