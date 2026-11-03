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
 * Source-signing correction slice (owner decision A, 2026-11-03): for the
 * wallet/NFT-tool trade actions ('p2p' family) the fence must carry a
 * `hostStamp` the host derives when it ACTUALLY executes the trade and the
 * stamp must still bind to the session being written to —
 * tradeActivityStamp.verifyNftCardHostStamp. Unsigned cards (relay/report
 * citations, hand-written demos — e.g. the "Pixel Sun #05 transferred" copy
 * that briefly mis-marked the MRC721-回填对接 session) never mark, and a copy
 * of a signed fence pasted into a DIFFERENT session fails the session
 * binding, so another session's real trade can no longer mark this one.
 * The 'escrow' action stays on its reserved hand-written syntax-layer
 * contract: group-card emitters predate host tooling and there is no host
 * emit point to sign them with.
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

import { verifyNftCardHostStamp } from './tradeActivityStamp';
import { NFT_CARD_RESULT_HINT } from './nftCardMarkdown';

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
 *
 * Signing (p2p family): the card must carry a `hostStamp` verified against
 * `context.sessionId` (the session the message is being written INTO) —
 * unsigned cards and out-of-session copies (cross-session relays) yield null.
 * Escrow action cards keep the reserved hand-written syntax-layer contract.
 */
export const scanMessageTradeBadge = (
  content: string,
  context?: { sessionId?: string },
): TradeBadgeKind | null => scanMessageTradeBadgeImpl(content, context, false);

/**
 * The pre-signing semantics, kept ONLY for the one-shot corrective migration
 * sweep that re-judges marks the old scanner planted. Historical messages
 * never carry stamps, so a p2p row survives the re-judge only as a HOST BARE
 * EMIT (the announcing message IS the tool output — its first line matches an
 * emit-station anchor; verified live: the transfer-test announcement, the
 * #6734/#9131-era purchase broadcasts) or as a verifiably signed card.
 * Design prose, demo cards and cross-session relay copies ("```nft-card"-first
 * mirrors, orchestration briefings embedding another session's card) fail the
 * anchors and unmark. Escrow keeps the unchanged hand-written contract. Never
 * call this on the write path — fresh marks require host stamps.
 */
export const scanMessageTradeBadgeLegacy = (content: string, sessionId?: string): TradeBadgeKind | null =>
  scanMessageTradeBadgeImpl(content, sessionId ? { sessionId } : undefined, true);

const scanMessageTradeBadgeImpl = (
  content: string,
  context: { sessionId?: string } | undefined,
  legacy: boolean,
): TradeBadgeKind | null => {
  const text = typeof content === 'string' ? content : '';
  if (!text || !text.includes('```')) return null;

  // Bare-emit facts are message-level: a real host emit IS the tool output,
  // so (legacy re-judge) one anchor pass per message, not per card row.
  const bareEmit = legacy && isBareTradeEmit(text);

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
        const rowKind = cardTradeKind(record);
        if (rowKind === 'p2p' && !p2pMarkAllowed(record, bareEmit, context)) continue;
        kind = mergeKind(kind, rowKind);
      }
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (!hasValidNftIdentity(record)) continue;
    const recordKind = cardTradeKind(record);
    if (recordKind === 'p2p' && !p2pMarkAllowed(record, bareEmit, context)) continue;
    kind = mergeKind(kind, recordKind);
  }

  return kind;
};

/**
 * p2p signing gate: fresh semantics require the fence to carry a host stamp
 * that still binds to the session being written INTO; the legacy re-judge
 * additionally accepts a bare host emit (tool output IS the message, stamped
 * eras predate the stamp mechanism). Unsigned and unanchored → no mark.
 */
const p2pMarkAllowed = (
  record: Record<string, unknown>,
  bareEmit: boolean,
  context?: { sessionId?: string },
): boolean => bareEmit || hostStampVerified(record, context);

/**
 * p2p-only signing gate...
 */
const hostStampVerified = (record: Record<string, unknown>, context?: { sessionId?: string }): boolean => {
  const sessionId = context?.sessionId;
  if (!sessionId) return false;
  const hostStamp = typeof record.hostStamp === 'string' ? record.hostStamp.trim() : '';
  if (!hostStamp) return false;
  return verifyNftCardHostStamp({ hostStamp, sessionId, fields: record as Parameters<typeof verifyNftCardHostStamp>[0]['fields'] });
};

/** Session-level rollup: escrow outranks p2p, null = no trade activity seen. */
export const mergeTradeBadge = (
  current: TradeBadgeKind | null | undefined,
  incoming: TradeBadgeKind | null | undefined,
): TradeBadgeKind | null => mergeKind(current ?? null, incoming ?? null);

/** The session column value to store for a kind (null → SQL NULL). */
export const tradeBadgeColumnValue = (kind: TradeBadgeKind | null): string | null => kind ?? null;

export const TRADE_BADGE_MAX_TEXT_FIELD = MAX_CARD_TEXT_FIELD;

/**
 * Legacy re-judge only: does this message text read as a HOST tool-output
 * trade emit rather than a quote/report of one? The emit site appends every
 * host-composed card to its tool result WITH the standard result hint line
 * (appendNftCardBlock's NFT_CARD_RESULT_HINT); a bare fence inside prose —
 * an orchestration relay copy, a demo emit, a design spec — omits it. This
 * is the anchor 阿码's interrupted slice referenced as "emit-station anchor";
 * the transfer-test and purchase-broadcast records verified live carry the
 * hint line verbatim.
 */
const isBareTradeEmit = (text: string): boolean => text.includes(NFT_CARD_RESULT_HINT);
