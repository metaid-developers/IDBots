/**
 * Host stamp for trade-announcing nft-card fences — the S4 correction slice
 * (owner decision A, 2026-11-03: sign at the emit source).
 *
 * Problem it fixes: the S4 trade badge marked every chat message carrying a
 * structurally-valid trade-action nft-card fence. That made a cross-session
 * RELAY copy (an orchestration session's tool_result mirroring a worker
 * session's real tool emit — e.g. the "MRC721回填UTXO修复任务对接" session
 * whose briefly-embedded "Pixel Sun #05 transferred" card pointed at a trade
 * that never ran in that session) look like a trade that happened there.
 *
 * Contract: when the HOST (main process) actually executes a wallet/NFT trade
 * tool and appends the announcement card to the result, it also embeds a
 * `hostStamp` field derived from what only the host can attest — the emitting
 * cowork session id, the announced action, the card's NFT identity and the
 * issue time, HMAC'd with a secret kept in main-process memory. The sender is
 * a faithful copy of a genuinely-executed emit, not a hand-written skeleton.
 *
 * Trust model, stated honestly:
 *  - Main-side scan verifies the stamp with the session that is being written
 *    to, so a card signed in session X silently stops marking session Y: the
 *    cross-session relay copy that caused the mislabel fails out of scope.
 *  - The renderer cannot hold the HMAC secret; its detectors do a
 *    presence-only structural check (format + bound-session equality). That
 *    keeps the accidental false mark out (relay/demo cards carry no valid
 *    stamp text) while an adversary-in-the-message-out is out of scope — a
 *    bot fabricating fields can claim anything, which is not the failure this
 *    slice targets.
 *  - Stamps are ephemeral (per-run in-memory secret). Only fresh writes need
 *    verification — the emitting session bumps its badge at write time, so a
 *    later replay of old signed text into a rebuilt secret is a non-event
 *    (upgrade-only badges, no unsigning).
 *
 * This module is DOM-free and dependency-free besides node:crypto so the
 * store write path can call it inline.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Emitted card shape subset the stamp binds to (structural — no import cycle). */
export interface NftCardStampFields {
  format?: string;
  genesis?: string;
  codehash?: string;
  tokenIndex?: string | number;
  pinId?: string;
  action?: string;
}

const STAMP_PREFIX = 'v1.';

/** The field name the fence carries (`hostStamp` — owner proposal field name). */
export const NFT_CARD_HOST_STAMP_FIELD = 'hostStamp';

/** Per-process secret: only the host main process can produce valid stamps. */
let stampSecret: Buffer | null = null;
const getStampSecret = (): Buffer => {
  if (!stampSecret) stampSecret = randomBytes(32);
  return stampSecret;
};

/** Normalized identity string a stamp binds to (genesis triple or item pinId). */
export const nftCardStampIdentity = (fields: NftCardStampFields): string => {
  const genesis = typeof fields.genesis === 'string' ? fields.genesis.trim().toLowerCase() : '';
  const codehash = typeof fields.codehash === 'string' ? fields.codehash.trim().toLowerCase() : '';
  const tokenIndex = fields.tokenIndex == null ? '' : String(fields.tokenIndex).trim();
  const pinId = typeof fields.pinId === 'string' ? fields.pinId.trim().toLowerCase().replace(/^metafile:\/\//, '') : '';
  const triple = genesis && codehash && tokenIndex ? `g:${genesis}:${codehash}:${tokenIndex}` : '';
  const pin = /^[0-9a-f]{64}i\d+$/.test(pinId) ? `p:${pinId}` : '';
  if (triple && pin) return `${triple};${pin}`;
  return triple || pin || '';
};

const stampHmac = (sessionId: string, action: string, identity: string, issuedAt: string): string =>
  createHmac('sha256', getStampSecret())
    .update(`${sessionId}\u0000${action}\u0000${identity}\u0000${issuedAt}`)
    .digest('hex');

const cleanActionForStamp = (action: unknown): string => (
  typeof action === 'string' ? action.trim().toLowerCase().slice(0, 16) : ''
);

/**
 * Build the hostStamp for one emitted card. Returns undefined for cards
 * without a usable identity (nothing attested) or an empty session id — the
 * fence then simply carries no stamp (fail-open on the emit side only; the
 * mark side fails closed).
 */
export const buildNftCardHostStamp = (input: { sessionId: string; fields: NftCardStampFields }): string | undefined => {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return undefined;
  const identity = nftCardStampIdentity(input?.fields ?? {});
  if (!identity) return undefined;
  const action = cleanActionForStamp(input?.fields?.action);
  const issuedAt = String(Date.now());
  return `${STAMP_PREFIX}${issuedAt}.${sessionId}.${stampHmac(sessionId, action, identity, issuedAt)}`;
};

/** Parsed stamp parts (valid shape only). */
export interface NftCardStampParts {
  issuedAtMs: number;
  sessionId: string;
}

/** Parse stamp text without verifying: `v1.<issuedAt>.<sessionId>.<hmac64>`. */
export const parseNftCardHostStamp = (hostStamp: string): NftCardStampParts | null => {
  const text = typeof hostStamp === 'string' ? hostStamp : '';
  if (!text.startsWith(STAMP_PREFIX)) return null;
  const tail = text.slice(STAMP_PREFIX.length);
  const first = tail.indexOf('.');
  if (first <= 0) return null;
  const issuedAtMs = Number(tail.slice(0, first));
  if (!Number.isInteger(issuedAtMs) || issuedAtMs <= 0) return null;
  const rest = tail.slice(first + 1);
  const second = rest.indexOf('.');
  if (second <= 0) return null;
  const sessionId = rest.slice(0, second);
  const mac = rest.slice(second + 1);
  if (!sessionId || !/^[0-9a-f]{64}$/.test(mac)) return null;
  return { issuedAtMs, sessionId };
};

const constantTimeEqualHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  try {
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
};

/**
 * Verify a fence's hostStamp against THIS write context. A copy relayed into
 * a different session (the mislabel case this slice fixes) fails the session
 * binding → false. Any malformed stamp → false.
 */
export const verifyNftCardHostStamp = (input: {
  hostStamp: string;
  sessionId: string;
  fields: NftCardStampFields;
}): boolean => {
  const parts = parseNftCardHostStamp(input?.hostStamp ?? '');
  if (!parts) return false;
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId || parts.sessionId !== sessionId) return false;
  const identity = nftCardStampIdentity(input?.fields ?? {});
  if (!identity) return false;
  const action = cleanActionForStamp(input?.fields?.action);
  const expected = stampHmac(parts.sessionId, action, identity, String(parts.issuedAtMs));
  const mac = (input.hostStamp.slice(input.hostStamp.lastIndexOf('.') + 1));
  return constantTimeEqualHex(mac, expected);
};

/**
 * Attach the stamp to an emit-fields object (mutates and returns the object —
 * the emit sites build their fields inline). No-op without a valid identity
 * or session: an unsigned fence simply never marks.
 */
export const withNftCardHostStamp = <T extends NftCardStampFields>(fields: T, sessionId: string): T => {
  const stamp = buildNftCardHostStamp({ sessionId, fields });
  if (stamp) (fields as { hostStamp?: string }).hostStamp = stamp;
  return fields;
};
