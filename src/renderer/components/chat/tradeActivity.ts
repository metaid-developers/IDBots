/**
 * Trade activity detection (S4 chat trade markers) — renderer side.
 *
 * Scans a chat message's markdown text for `nft-card` and `nft-*-card` fences
 * and classifies the trade kind the message announces:
 *
 *   'p2p'    — contract sale/listing (listed/sold/bought/delisted) or a
 *              direct transfer (transferred) — the wallet/mrc721/goods tool
 *              announcements.
 *   'escrow' — three-party escrow activity (action 'escrow', the
 *              syntax-layer reserved value group escrow emitters write).
 */

import {
  isNftCardFenceLanguage,
  isNftCardGroupFenceLanguage,
  parseNftCardFence,
  parseNftCardGroupFence,
  type NftCardData,
} from './nftCardSyntax';
import {
  isNftActionCardFenceLanguage,
  isNftFillCardFenceLanguage,
  isNftListingCardFenceLanguage,
  parseNftActionCardFence,
  parseNftFillCardFence,
  parseNftListingCardFence,
} from './nftSuiteSyntax';

export type TradeBadgeKind = 'p2p' | 'escrow';

export interface TradeActivity {
  kind: TradeBadgeKind;
  /** The card actions seen (lower-cased), strongest evidence first. */
  actions: string[];
}

const P2P_ACTIONS = new Set(['listed', 'sold', 'bought', 'delisted', 'transferred', 'selling']);
const ESCROW_ACTIONS = new Set(['escrow']);

const actionTradeKind = (action: string | undefined): TradeBadgeKind | null => {
  if (!action) return null;
  if (ESCROW_ACTIONS.has(action)) return 'escrow';
  if (P2P_ACTIONS.has(action)) return 'p2p';
  return null;
};

const mergeKind = (a: TradeBadgeKind | null, b: TradeBadgeKind | null): TradeBadgeKind | null => {
  if (a === 'escrow' || b === 'escrow') return 'escrow';
  if (a === 'p2p' || b === 'p2p') return 'p2p';
  return null;
};

const STAMP_PREFIX = 'v1.';

const stampSessionBound = (card: { hostStamp?: string }, sessionId: string | undefined): boolean => {
  const stamp = typeof card.hostStamp === 'string' ? card.hostStamp.trim() : '';
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

const recordP2pSuiteCard = (
  card: { hostStamp?: string },
  action: string,
  state: { kind: TradeBadgeKind | null; actions: string[] },
  context: { sessionId?: string } | undefined,
): void => {
  if (!stampSessionBound(card, context?.sessionId)) return;
  state.kind = mergeKind(state.kind, 'p2p');
  state.actions.push(action);
};

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
    const isListing = isNftListingCardFenceLanguage(tag);
    const isFill = isNftFillCardFenceLanguage(tag);
    const isAction = isNftActionCardFenceLanguage(tag);
    if (!isCard && !isGroup && !isListing && !isFill && !isAction) continue;

    let j = i + 1;
    const bodyLines: string[] = [];
    while (j < lines.length && !/^```[ \t]*$/.test(lines[j])) {
      bodyLines.push(lines[j]);
      j += 1;
    }
    if (j >= lines.length) continue;
    i = j;

    const body = bodyLines.join('\n').trim();
    if (!body) continue;
    if (isGroup) {
      const cards = parseNftCardGroupFence(body);
      if (cards) foldCards(cards, state, context);
    } else if (isCard) {
      const card = parseNftCardFence(body);
      if (card) foldCards([card], state, context);
    } else if (isListing) {
      const listing = parseNftListingCardFence(body);
      if (listing) {
        recordP2pSuiteCard(
          listing,
          listing.status === 'delisted' ? 'delisted' : 'listed',
          state,
          context,
        );
      }
    } else if (isFill) {
      const fill = parseNftFillCardFence(body);
      if (fill) {
        recordP2pSuiteCard(
          fill,
          fill.side === 'sold' ? 'sold' : 'bought',
          state,
          context,
        );
      }
    } else if (isAction) {
      const act = parseNftActionCardFence(body);
      if (act && act.kind === 'transfer') {
        recordP2pSuiteCard(act, 'transferred', state, context);
      }
    }
  }

  if (!state.kind) return null;
  return { kind: state.kind, actions: state.actions };
};
