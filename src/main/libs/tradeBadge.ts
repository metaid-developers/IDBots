/**
 * Trade badge scanner (S4 chat trade markers) — detects NFT trade activity in
 * a chat message's text and classifies it into the two trade kinds the UI
 * distinguishes:
 *
 *   'p2p'    — peer-to-peer NFT trading: contract sale/listing (sell/buy/
 *              cancel) and direct transfers. On the wire these are the
 *              nft-card announcements the wallet/mrc721 tools emit with
 *              action listed | sold | bought | delisted | transferred.
 *   'escrow' — escrow trade activity (the group-chat three-party scenario B
 *              convention). On the wire: action 'escrow' (syntax-layer
 *              reserved value; group escrow emitters write it by hand).
 *
 * Detection basis, honestly scoped: the chat store (cowork_messages) keeps
 * the conversation bubbles, not tool-call records — tool-call details live in
 * the agent transcript and never reach the message table (code-level fact,
 * 2026-11-02). The message-side visible product of a wallet trade tool call
 * IS the nft-card fence appended to the tool result and broadcast by the bot,
 * so the fence is the detection basis. A bare tool name in prose (worker/
 * analysis text) is NOT evidence — analysis quotes carry line-number noise
 * and fail the strict fence validation below by construction.
 *
 * Fence contract mirrors the renderer's nftCardSyntax.ts parser (identity
 * validation included) and the main-side emitter nftCardMarkdown.ts; the two
 * sides are pinned together by tests so they cannot drift. This module is
 * DOM-free and dependency-free so the store write path can call it inline.
 */

export type TradeBadgeKind = 'p2p' | 'escrow';

/** Fence tags that switch a code block into NFT card rendering (renderer contract). */
const NFT_CARD_FENCE_TAGS = new Set(['nft-card', 'nftcard', 'nft']);
const NFT_CARD_GROUP_FENCE_TAG = 'nft-card-group';

/** Actions that count as peer-to-peer trade activity (sale/listing/transfer). */
const P2P_ACTIONS = new Set(['listed', 'sold', 'bought', 'delisted', 'transferred']);
/** Actions that count as escrow activity. */
const ESCROW_ACTIONS = new Set(['escrow']);

// Same shapes the renderer validates (nftCardSyntax.ts): MetaContract genesis
// ids on MVC are 40 hex live (64 accepted for future shapes), codehash 40 hex,
// MRC-721 item pinId `<64-hex txid>i<output>`.
const GENESIS_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const CODEHASH_RE = /^[0-9a-fA-F]{40}$/;
const TOKEN_INDEX_RE = /^\d{1,10}$/;
const MRC721_PIN_ID_RE = /^[0-9a-f]{64}i\d{1,6}$/;

const MAX_CARD_TEXT_FIELD = 64;

/**
 * Does this parsed card payload carry a valid NFT identity? Mirrors the
 * renderer parse rules: format "mrc721" needs a pinId, "metacontract" (or a
 * legacy payload with no format field) needs the genesis triple; a format-less
 * pinId-only payload counts as MRC-721.
 */
const hasValidNftIdentity = (row: Record<string, unknown>): boolean => {
  const formatRaw = typeof row.format === 'string' ? row.format.trim().toLowerCase() : '';
  if (formatRaw && formatRaw !== 'metacontract' && formatRaw !== 'mrc721') return false;

  const genesis = typeof row.genesis === 'string' ? row.genesis.trim().toLowerCase() : '';
  const codehash = typeof row.codehash === 'string' ? row.codehash.trim().toLowerCase() : '';
  const tokenIndex = typeof row.tokenIndex === 'string' || typeof row.tokenIndex === 'number'
    ? String(row.tokenIndex).trim()
    : '';
  const tripleOk = GENESIS_RE.test(genesis) && CODEHASH_RE.test(codehash) && TOKEN_INDEX_RE.test(tokenIndex);

  const pinIdRaw = typeof row.pinId === 'string' ? row.pinId.trim().toLowerCase().replace(/^metafile:\/\//, '') : '';
  const pinIdOk = MRC721_PIN_ID_RE.test(pinIdRaw);

  if (formatRaw === 'mrc721') return pinIdOk;
  if (formatRaw === 'metacontract') return tripleOk;
  return tripleOk || pinIdOk;
};

const cleanAction = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.replace(/\s+/g, ' ').slice(0, 16) || undefined;
};

/**
 * Classify one parsed card payload into a trade kind, or null when the card
 * is not a trade announcement (minted/info/no action).
 */
const cardTradeKind = (row: Record<string, unknown>): TradeBadgeKind | null => {
  const action = cleanAction(row.action);
  if (!action) return null;
  if (ESCROW_ACTIONS.has(action)) return 'escrow';
  if (P2P_ACTIONS.has(action)) return 'p2p';
  return null;
};

/** Escrow outranks p2p when one text carries both — the escrow reading subsumes the transfers around it. */
const mergeKind = (a: TradeBadgeKind | null, b: TradeBadgeKind | null): TradeBadgeKind | null => {
  if (a === 'escrow' || b === 'escrow') return 'escrow';
  if (a === 'p2p' || b === 'p2p') return 'p2p';
  return null;
};

/**
 * Scan one chat message's text for nft-card trade activity.
 * Returns 'p2p' | 'escrow' | null.
 *
 * Column-0 fences only (same rule as the renderer's group preprocessing):
 * indented or nested fences are markdown quotes/noise and are skipped. Every
 * candidate body must survive the strict identity validation — analysis text
 * that quotes a fence carries line-number prefixes and fails JSON.parse by
 * construction.
 */
export const scanMessageTradeBadge = (content: string): TradeBadgeKind | null => {
  const text = typeof content === 'string' ? content : '';
  if (!text || !text.includes('```')) return null;

  const lines = text.split('\n');
  let kind: TradeBadgeKind | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const open = /^```([A-Za-z0-9_-]*)[ \t]*$/.exec(lines[i]);
    if (!open) continue;
    const tag = open[1].trim().toLowerCase();
    if (!NFT_CARD_FENCE_TAGS.has(tag) && tag !== NFT_CARD_GROUP_FENCE_TAG) continue;

    // Collect the fence body.
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // analysis quote / truncated fence — not evidence
    }

    if (tag === NFT_CARD_GROUP_FENCE_TAG) {
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const record = row as Record<string, unknown>;
        if (!hasValidNftIdentity(record)) continue;
        kind = mergeKind(kind, cardTradeKind(record));
      }
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (!hasValidNftIdentity(record)) continue;
    kind = mergeKind(kind, cardTradeKind(record));
  }

  return kind;
};

/** Session-level rollup: escrow outranks p2p, null = no trade activity seen. */
export const mergeTradeBadge = (
  current: TradeBadgeKind | null | undefined,
  incoming: TradeBadgeKind | null | undefined,
): TradeBadgeKind | null => mergeKind(current ?? null, incoming ?? null);

/** The session column value to store for a kind (null → SQL NULL). */
export const tradeBadgeColumnValue = (kind: TradeBadgeKind | null): string | null => kind ?? null;

export const TRADE_BADGE_MAX_TEXT_FIELD = MAX_CARD_TEXT_FIELD;
