/**
 * Swap engine — the M1 pipeline behind the three CLI modes
 * (verify-claim / mint-and-send / burn-batch), on top of the merged
 * swap-ledger.mjs state machine and vault-poll-lib.mjs reader.
 *
 * PRD v1.2 anchors:
 *  §5.4  deposit acceptance: triple match + tokenIndex unused + 6 confirmations
 *  §5.5  mint pre-check (prereview #1): ledger placeholder AND itemPath not
 *        already taken by a non-official mint
 *  §5.6  confirm pipeline (prereview #6/#8): pinId → wait item/info →
 *        item/verify.creatorMinted ∧ collection/info.createAddress → output /
 *        outputValue both present (missing = index lag, retry, never fail)
 *  §5.7  ledger machine + crash-recovery invariant (prereview #2a):
 *        a broadcast pinId is resumed, NEVER re-minted
 *  §5.8  burn precondition (prereview #7/#10): only `sent` rows with a stable
 *        transferCount may enter a burn batch; mid-flight rows never do
 *  §9    no fund/token action without an explicit broadcast flag; the burn
 *        batch additionally requires an explicit owner sign-off flag
 *
 * This module is I/O-injected: readers and host writers come in through
 * `deps`, so the whole pipeline is unit-testable without a wallet or a
 * network. Nothing here prints; the CLIs own output and exit codes.
 */

import { createHash } from 'node:crypto';
import { MVP_CONFIRMATIONS } from './vault-poll-lib.mjs';
import { albumFromSeries, resolveSeries } from './series-registry.mjs';

export const ITEM_PATH_PAD = 4;
export const MANAPI_BASE_DEFAULT = 'https://manapi.metaid.io';
export const MRC721_READ_BASE_DEFAULT = 'https://so.metaid.io';
export const METALET_API_BASE_DEFAULT = 'https://www.metalet.space';
export const MVC_OPEN_API_BASE_DEFAULT = 'https://api.microvisionchain.com/open-api-mvc';
export const PATH_PROBE_PAGE_SIZE = 100;
export const MAX_PATH_PROBE_PAGES = 20;
export const ESTIMATE_PLACEHOLDER_PINID = `${'0'.repeat(64)}i0`;

/** States that mean "this tokenIndex already has a minted pin in the ledger". */
export const MINTED_STATES = Object.freeze(['mint_pending', 'minted', 'send_pending', 'sent', 'burn_pending', 'burned']);

export class SwapEngineError extends Error {
  /**
   * @param {string} code machine-readable refusal code
   * @param {string} message operator-facing detail
   * @param {object} [detail] extra structured evidence
   */
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'SwapEngineError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, message, detail) => {
  throw new SwapEngineError(code, message, detail);
};

/** `item-####` mapping (PRD §5.6; tokenIndex 0..9560 keeps it unambiguous). */
export function itemPathForToken(tokenIndex) {
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0) {
    fail('TOKEN_INDEX_INVALID', `tokenIndex must be a non-negative integer, got: ${tokenIndex}`);
  }
  const text = String(tokenIndex);
  if (text.length > ITEM_PATH_PAD) {
    fail('TOKEN_INDEX_INVALID', `tokenIndex ${tokenIndex} exceeds the ${ITEM_PATH_PAD}-digit item path space`);
  }
  return `item-${text.padStart(ITEM_PATH_PAD, '0')}`;
}

/**
 * item_desc display + metadata for one swap (PRD §7). Only mint-time values
 * are written — burnTxid never enters metadata (prereview #5: item_desc is
 * per-field first-write-wins, an after-the-fact burnTxid could never land).
 */
export function buildItemDisplay({ tokenIndex, depositTxid, album, cover, partName = null }) {
  const prefix = album.itemTitlePrefix || 'MetaBot Avatar';
  const title = partName ? `${prefix} - ${partName} #${tokenIndex}` : `${prefix} #${tokenIndex}`;
  const metadata = {
    title,
    ...(cover ? { cover } : {}),
    custom: {
      swap: {
        mode: 'mrc721-mint-on-demand',
        from: 'MetaContract',
        ...(album.collectionSlug ? { collectionSlug: album.collectionSlug } : {}),
        legacyGenesis: album.genesis,
        legacyCodeHash: album.codeHash,
        tokenIndex,
        depositTxid,
      },
    },
  };
  return { name: title, desc: null, cover: cover || undefined, metadata };
}

/**
 * Inverse of buildItemDisplay's title rule: recover partName from a
 * previously persisted display title ("MetaBot Avatar - Arms 8 #2671" →
 * "Arms 8"). Used when a cover-less recorded display must be rebuilt with a
 * cover on the item_desc resume path (cover-loss fix, 2026-11-19).
 */
export function partNameFromTitle(title, prefix = 'MetaBot Avatar') {
  const escaped = String(prefix || 'MetaBot Avatar').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^(?:${escaped}|MetaBot Avatar) - (.+) #\\d+$`).exec(String(title || ''));
  return match ? match[1] : null;
}

/** Album constants from the pilot config + SERIES_REGISTRY. */
export function albumFromConfig(config, options = {}) {
  const requestedSlug = options?.collectionSlug || config?.collectionSlug || null;
  const series = resolveSeries({
    collectionSlug: requestedSlug,
    genesis: requestedSlug ? null : config?.genesis,
    codeHash: requestedSlug ? null : config?.codeHash,
  });
  if (series) {
    return albumFromSeries(series, {
      ...(config?.genesis && !requestedSlug ? { genesis: config.genesis } : {}),
      ...(config?.codeHash && !requestedSlug ? { codeHash: config.codeHash } : {}),
      ...(config?.sensibleId !== undefined && !requestedSlug ? { sensibleId: config.sensibleId } : {}),
      ...(config?.tokenSupply != null && !requestedSlug ? { tokenSupply: config.tokenSupply } : {}),
      ...(config?.issuerAddress ? { issuerAddress: config.issuerAddress } : {}),
      ...(config?.collectionName && !requestedSlug ? { collectionName: config.collectionName } : {}),
      ...(config?.vaultAddress ? { vaultAddress: config.vaultAddress } : {}),
      ...(config?.burnAddress ? { burnAddress: config.burnAddress } : {}),
      ...(config?.perSwapFeeCeilingSats != null ? { perSwapFeeCeilingSats: config.perSwapFeeCeilingSats } : {}),
    });
  }
  return {
    collectionSlug: requestedSlug || 'metabot-avatar',
    genesis: config.genesis,
    codeHash: config.codeHash,
    sensibleId: config.sensibleId ?? null,
    tokenSupply: config.tokenSupply,
    issuerAddress: config.issuerAddress,
    collectionName: config.collectionName,
    vaultAddress: config.vaultAddress ?? null,
    collectionPinId: config.collectionPinId ?? null,
    itemTitlePrefix: config.itemTitlePrefix ?? 'MetaBot Avatar',
    burnAddress: config.burnAddress,
    perSwapFeeCeilingSats: config.perSwapFeeCeilingSats ?? 5000,
    minConfirmations: config.minConfirmations ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Index readers (thin, injectable, standalone from the Electron build)
// ---------------------------------------------------------------------------

/**
 * Build the read-side clients used by the engine and the CLIs.
 *  - path index  → manapi `/api/pin/path/list` (the raw pin index; MetaSo does
 *    not serve it). The exact-path probe sees mempool pins too, which is what
 *    makes the "no foreign mint at this path" gate airtight.
 *  - NFT reads   → the same MetaSo/manapi-compatible base the host uses
 *    (`IDBOTS_MRC721_INDEXER_API_BASE` doubles as the rollback lever).
 */
export function createIndexReaders({ fetchImpl = globalThis.fetch, manapiBase, nftBase } = {}) {
  // The app's local man-p2p proxy (IDBOTS_MAN_P2P_LOCAL_BASE) serves the same
  // read surface and is fresher than the public host; honor it when set.
  const localBase = (process.env.IDBOTS_MAN_P2P_LOCAL_BASE || '').replace(/\/+$/, '');
  const rawBase = (manapiBase || process.env.IDBOTS_MRC721_RAW_INDEX_BASE || localBase || MANAPI_BASE_DEFAULT).replace(/\/+$/, '');
  const readBase = (nftBase || process.env.IDBOTS_MRC721_INDEXER_API_BASE || localBase || MRC721_READ_BASE_DEFAULT).replace(/\/+$/, '');
  // A locally configured P2P base may not serve every route (chain-source
  // routes are feature-gated); fall back to the public host on transport/bad
  // JSON, never on a clean protocol answer. Explicitly passed bases (tests,
  // ops) never fall back.
  const rawFallback = manapiBase || rawBase === MANAPI_BASE_DEFAULT ? null : MANAPI_BASE_DEFAULT;
  const readFallback = nftBase || readBase === MRC721_READ_BASE_DEFAULT ? null : MRC721_READ_BASE_DEFAULT;

  const getJson = async (url, what) => {
    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      fail('INDEX_UNREACHABLE', `${what} request failed: ${error instanceof Error ? error.message : String(error)}`, { url });
    }
    let json;
    try {
      json = await response.json();
    } catch {
      fail('INDEX_BAD_RESPONSE', `${what} returned non-JSON`, { url, status: response?.status });
    }
    return json;
  };

  const getJsonWithFallback = async (pathAndQuery, primaryBase, fallbackBase, what) => {
    try {
      return await getJson(`${primaryBase}${pathAndQuery}`, what);
    } catch (error) {
      const retriable =
        error instanceof SwapEngineError && (error.code === 'INDEX_UNREACHABLE' || error.code === 'INDEX_BAD_RESPONSE');
      if (!retriable || !fallbackBase) throw error;
      return getJson(`${fallbackBase}${pathAndQuery}`, what);
    }
  };

  return {
    /**
     * All pins at `/nft/mrc721/{collection}/{itemPath}` (every page).
     * @returns {Promise<{ pins: Array<{pinId:string,address:string,globalMetaId:string,height:number}>, total:number }>}
     */
    async probeItemPath({ collectionName, itemPath, pageSize = PATH_PROBE_PAGE_SIZE, maxPages = MAX_PATH_PROBE_PAGES }) {
      const path = `/nft/mrc721/${collectionName}/${itemPath}`;
      const pins = [];
      let cursor;
      let total = null;
      for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams({ path, size: String(pageSize) });
        if (cursor) params.set('cursor', cursor);
        const json = await getJsonWithFallback(
          `/api/pin/path/list?${params.toString()}`,
          rawBase,
          rawFallback,
          'pin/path/list',
        );
        if (json?.code !== 1) {
          fail('INDEX_BAD_RESPONSE', `pin/path/list refused: ${json?.code} ${json?.message ?? ''}`.trim(), { path });
        }
        const list = Array.isArray(json?.data?.list) ? json.data.list : [];
        if (total == null) total = Number(json?.data?.total ?? 0);
        for (const row of list) {
          pins.push({
            pinId: String(row.id || row.pinId || ''),
            address: String(row.address || ''),
            globalMetaId: String(row.globalMetaId || ''),
            height: Number(row.genesisHeight ?? -1),
          });
        }
        const next = json?.data?.nextCursor;
        if (!list.length || !next) break;
        cursor = String(next);
      }
      return { pins, total: total ?? pins.length, path };
    },

    async fetchCollectionInfo(name) {
      const json = await getJsonWithFallback(
        `/api/mrc721/collection/info?name=${encodeURIComponent(name)}`,
        readBase,
        readFallback,
        'collection/info',
      );
      return json?.code === 1 && json.data && !Array.isArray(json.data) ? json.data : null;
    },

    async fetchItemInfo(pinId) {
      const json = await getJsonWithFallback(
        `/api/mrc721/item/info?pinId=${encodeURIComponent(pinId)}`,
        readBase,
        readFallback,
        'item/info',
      );
      return json?.code === 1 && json.data && !Array.isArray(json.data) ? json.data : null;
    },

    async fetchItemVerify(pinId) {
      const json = await getJsonWithFallback(
        `/api/mrc721/item/verify?pinId=${encodeURIComponent(pinId)}`,
        readBase,
        readFallback,
        'item/verify',
      );
      return json?.code === 1 && json.data && !Array.isArray(json.data) ? json.data : null;
    },

    /** Authoritative confirmation count for a txid (manapi `/api/tx/status`). */
    async fetchConfirmations(txid) {
      const json = await getJsonWithFallback(
        `/api/tx/status?chainName=mvc&txid=${encodeURIComponent(txid)}`,
        rawBase,
        rawFallback,
        'tx/status',
      );
      if (json?.code !== 1 || !json?.data?.found) return 0;
      const confs = Number(json.data.confirmations ?? 0);
      return Number.isFinite(confs) ? Math.max(0, confs) : 0;
    },

    /**
     * Resolve input/sender MVC addresses for a deposit transaction from its
     * on-chain raw transaction inputs (with open-api-mvc tx detail fallback).
     * Used by claim-handler to verify the claimant actually sent the deposit.
     */
    async fetchDepositSenderAddresses(txid) {
      const cleanTxid = String(txid ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(cleanTxid)) return [];
      const addrs = new Set();
      try {
        const res = await fetchImpl(
          `${METALET_API_BASE_DEFAULT}/wallet-api/v4/mvc/tx/raw?net=livenet&txId=${encodeURIComponent(cleanTxid)}`,
        );
        if (res && res.ok) {
          const json = await res.json().catch(() => null);
          const data = json?.data;
          const rawHex = typeof data === 'string' ? data : (data?.rawTx ?? data?.hex ?? '');
          if (rawHex) {
            for (const addr of deriveMvcInputAddressesFromRawTx(rawHex)) {
              addrs.add(addr);
            }
          }
        }
      } catch {
        // Fall through to open-api-mvc tx detail
      }
      if (addrs.size === 0) {
        try {
          const res = await fetchImpl(`${MVC_OPEN_API_BASE_DEFAULT}/tx/${encodeURIComponent(cleanTxid)}`);
          if (res && res.ok) {
            const json = await res.json().catch(() => null);
            const vin = Array.isArray(json?.vin) ? json.vin : Array.isArray(json?.data?.vin) ? json.data.vin : [];
            for (const input of vin) {
              const candidate = String(input?.address ?? input?.prevOut?.address ?? '').trim();
              if (/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(candidate)) addrs.add(candidate);
            }
          }
        } catch {
          // Return empty so caller fails closed in broadcast mode
        }
      }
      return Array.from(addrs);
    },
  };
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function readTxVarInt(buffer, offset) {
  if (offset >= buffer.length) throw new Error('varint out of bounds');
  const first = buffer[offset];
  if (first < 0xfd) return { value: first, nextOffset: offset + 1 };
  if (first === 0xfd) return { value: buffer.readUInt16LE(offset + 1), nextOffset: offset + 3 };
  if (first === 0xfe) return { value: buffer.readUInt32LE(offset + 1), nextOffset: offset + 5 };
  const lo = buffer.readUInt32LE(offset + 1);
  const hi = buffer.readUInt32LE(offset + 5);
  return { value: hi * 0x100000000 + lo, nextOffset: offset + 9 };
}

function base58CheckEncode(payload) {
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function pubkeyToMvcAddress(pubkey) {
  const hash160 = createHash('ripemd160')
    .update(createHash('sha256').update(pubkey).digest())
    .digest();
  return base58CheckEncode(Buffer.concat([Buffer.from([0x00]), hash160]));
}

function extractPubkeysFromScriptSig(script) {
  const pubkeys = [];
  let offset = 0;
  while (offset < script.length) {
    const op = script[offset];
    if (op >= 0x01 && op <= 0x4b) {
      const push = script.subarray(offset + 1, offset + 1 + op);
      if (
        (op === 33 && (push[0] === 0x02 || push[0] === 0x03)) ||
        (op === 65 && push[0] === 0x04)
      ) {
        pubkeys.push(push);
      }
      offset += 1 + op;
    } else if (op === 0x4c) {
      if (offset + 1 >= script.length) break;
      const len = script[offset + 1];
      const push = script.subarray(offset + 2, offset + 2 + len);
      if (
        (len === 33 && (push[0] === 0x02 || push[0] === 0x03)) ||
        (len === 65 && push[0] === 0x04)
      ) {
        pubkeys.push(push);
      }
      offset += 2 + len;
    } else if (op === 0x4d) {
      if (offset + 2 >= script.length) break;
      const len = script.readUInt16LE(offset + 1);
      offset += 3 + len;
    } else if (op === 0x4e) {
      if (offset + 4 >= script.length) break;
      const len = script.readUInt32LE(offset + 1);
      offset += 5 + len;
    } else {
      offset += 1;
    }
  }
  return pubkeys;
}

/**
 * Derive all unique P2PKH MVC addresses whose public keys appear in any
 * input's scriptSig of a raw MVC transaction hex. Handles MetaContract contract
 * unlock inputs (which may contain OP_PUSHDATA2) as well as standard P2PKH
 * fee inputs.
 */
export function deriveMvcInputAddressesFromRawTx(rawTxHex) {
  try {
    const buffer = Buffer.from(String(rawTxHex || '').trim(), 'hex');
    if (buffer.length < 10) return [];
    let offset = 4; // version
    if (buffer[offset] === 0x00 && buffer[offset + 1] !== 0x00) {
      offset += 2;
    }
    const inputCount = readTxVarInt(buffer, offset);
    offset = inputCount.nextOffset;
    if (inputCount.value < 1) return [];
    const addresses = new Set();
    for (let i = 0; i < inputCount.value; i += 1) {
      if (offset + 36 >= buffer.length) break;
      offset += 36; // prev txid (32) + vout (4)
      const scriptLen = readTxVarInt(buffer, offset);
      offset = scriptLen.nextOffset;
      const scriptSig = buffer.subarray(offset, offset + scriptLen.value);
      for (const pubkey of extractPubkeysFromScriptSig(scriptSig)) {
        addresses.add(pubkeyToMvcAddress(pubkey));
      }
      offset += scriptLen.value + 4; // scriptSig + nSequence
    }
    return Array.from(addresses);
  } catch {
    return [];
  }
}

/**
 * Classify the exact-path probe into the three cases the mint pre-check cares
 * about. Fail closed on a pin with no author address: an unattributable pin at
 * our path is a conflict, not "probably fine".
 */
export function classifyItemPathProbe({ pins, issuerAddress }) {
  const foreign = [];
  const official = [];
  for (const pin of pins) {
    if (pin.address && pin.address === issuerAddress) official.push(pin);
    else foreign.push(pin);
  }
  if (foreign.length) return { status: 'conflict', official, foreign };
  if (official.length) return { status: 'issuer-minted', official, foreign };
  return { status: 'free', official, foreign };
}

// ---------------------------------------------------------------------------
// verify-claim: live re-verification + ledger claim (PRD §5.4 / §5.5-a)
// ---------------------------------------------------------------------------

/**
 * Re-verify a ledger deposit against the live vault BEFORE the claim lands.
 * A deposit that no longer sits at its recorded outpoint must never be
 * claimed — the token moved, and a claim would mint for a token we do not
 * hold (the exact discrepancy a stale index would hide).
 */
export async function verifyDepositLive({ row, deps, minConfirmations = MVP_CONFIRMATIONS }) {
  const rows = await deps.fetchVaultRows();
  const outpoint = row.deposit_outpoint;
  const live = rows.find((r) => `${r.txid}:${r.outIndex}` === outpoint) ?? null;
  if (!live) {
    return {
      ok: false,
      code: 'DEPOSIT_NOT_IN_VAULT',
      detail: `outpoint ${outpoint} is not in the vault's utxo-list — the token moved; do not claim`,
    };
  }
  const tripleOk =
    live.genesis === row.genesis &&
    live.codehash === row.code_hash &&
    Number(live.tokenIndex) === Number(row.token_index);
  if (!tripleOk) {
    return {
      ok: false,
      code: 'TRIPLE_MISMATCH',
      detail: `live row genesis/codehash/tokenIndex (${live.genesis}/${live.codehash}/${live.tokenIndex}) does not match the ledger row`,
      live,
    };
  }
  const confirmations = await deps.fetchConfirmations(row.deposit_txid);
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      code: 'INSUFFICIENT_CONFIRMATIONS',
      detail: `deposit ${row.deposit_txid} has ${confirmations} confirmation(s); MVP requires ${minConfirmations}`,
      confirmations,
    };
  }
  return { ok: true, live, confirmations };
}

/**
 * The claim step: live verification → itemPath pre-check → detected→claimed.
 * Path conflict aborts and leaves the row in `detected` (PRD §11-1: stop and
 * alert, never mint, never auto-refund).
 */
export async function verifyAndClaim({
  ledger,
  album,
  row,
  claimantAddress,
  claimChannel = 'cli',
  claimMessageId = null,
  deps,
  dryRun = false,
  minConfirmations = MVP_CONFIRMATIONS,
}) {
  if (!row) fail('LEDGER_ROW_MISSING', 'no ledger row to claim');
  if (row.genesis !== album.genesis || row.code_hash !== album.codeHash) {
    fail('FOREIGN_ALBUM_ROW', `ledger row ${row.id} does not belong to the MetaBot Avatar album`);
  }
  if (row.state !== 'detected') {
    if (row.state === 'rejected') {
      fail('ROW_REJECTED', `ledger row ${row.id} is rejected (${row.reject_reason ?? 'no reason'}); refund path, not claim`);
    }
    fail('ROW_STATE_NOT_DETECTED', `ledger row ${row.id} is ${row.state}, expected detected`);
  }
  if (!claimantAddress) fail('CLAIMANT_MISSING', 'claim requires the recipient bot MVC address (--claimant)');

  const verified = await verifyDepositLive({ row, deps, minConfirmations });
  if (!verified.ok) fail(verified.code, verified.detail, verified);

  const itemPath = itemPathForToken(Number(row.token_index));
  const probe = await deps.probeItemPath({ collectionName: album.collectionName, itemPath });
  const pathState = classifyItemPathProbe({ pins: probe.pins, issuerAddress: album.issuerAddress });
  if (pathState.status === 'conflict') {
    fail(
      'ITEM_PATH_CONFLICT',
      `${itemPath} already has a non-official pin — stop and alert the owner (PRD §11-1); the deposit stays detected`,
      { itemPath, foreign: pathState.foreign },
    );
  }

  const claimArgs = {
    channel: claimChannel,
    messageId: claimMessageId,
    claimantAddress,
  };
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      ledgerId: row.id,
      tokenIndex: Number(row.token_index),
      itemPath,
      confirmations: verified.confirmations,
      pathState: pathState.status,
      officialPins: pathState.official,
      wouldClaim: claimArgs,
    };
  }
  const claimed = ledger.claim(row.id, claimArgs);
  return {
    ok: true,
    ledgerId: row.id,
    tokenIndex: Number(row.token_index),
    itemPath,
    state: claimed.state,
    confirmations: verified.confirmations,
    pathState: pathState.status,
    officialPins: pathState.official,
  };
}

// ---------------------------------------------------------------------------
// mint-and-send: mint → confirm → transfer → stabilize (PRD §5.5-§5.7)
// ---------------------------------------------------------------------------

/**
 * Resume-aware mint+send. The same call drives a fresh swap and a crash
 * recovery; the row state decides where it picks up:
 *
 *   claimed       → pre-check → (adopt existing official pin | mint) → item_desc
 *   mint_pending  → item_desc (if not recorded) → confirm pipeline
 *   minted        → transfer
 *   send_pending  → stability wait
 *   sent          → already done (no-op)
 *
 * Invariants (mechanically enforced, prereview #1/#2a/#6):
 *  - never mint when the row already carries a mint_pin_id;
 *  - never mint when the exact item path already holds an issuer pin (adopt
 *    it — that pin can only be ours, and it is the crash window between
 *    broadcast and the ledger write);
 *  - never mint when ANY other ledger row already carries a minted pin for
 *    this tokenIndex (one tokenIndex, one swap for life);
 *  - cover is MANDATORY at mint time (2026-11-19 cover-loss fix, report
 *    §4.2 step 3): the live vault row's `imgUrl` is the only pre-burn image
 *    source, so a mint without a produced cover is refused — on broadcast a
 *    COVER_UNAVAILABLE row is rejected (owner-approved refund path stays
 *    open), transient fetch/upload failures leave it claimed (retryable);
 *  - a missing output/outputValue in item/info is INDEX LAG: stay in
 *    mint_pending and retry, never report failure and never re-mint;
 *  - creatorMinted / createAddress mismatch is an ANOMALY: halt without a
 *    state move and let a human look (never auto-reject a minted pin).
 */
export async function mintAndSend({
  ledger,
  album,
  row,
  deps,
  recipientAddress = null,
  cover = null,
  broadcast = false,
  feeCeilingSats = album.perSwapFeeCeilingSats ?? 5000,
  itemInfoTimeoutMs = 360_000,
}) {
  if (!row) fail('LEDGER_ROW_MISSING', 'no ledger row to drive');
  if (!ledger?.lockExclusive || !ledger?.unlockExclusive) {
    return mintAndSendLocked({ ledger, album, row, deps, recipientAddress, cover, broadcast, feeCeilingSats, itemInfoTimeoutMs });
  }
  // Cross-process gate (2026-11-19 review P2): two concurrent `--broadcast`
  // runs previously BOTH passed the otherMinted check before either recorded
  // the mint — a duplicated broadcast (doubled fee, MULTIPLE_OFFICIAL_MINTS
  // cleanup). The whole command now runs under the ledger's exclusive lock:
  // the second run waits on busy_timeout, then either proceeds against the
  // committed state or fails SQLITE_BUSY. The lock is released on EVERY exit
  // path; intermediate writes commit at unlock, and the crash window
  // between broadcast and the ledger write stays covered by the itemPath
  // probe invariant below.
  ledger.lockExclusive();
  try {
    return await mintAndSendLocked({ ledger, album, row, deps, recipientAddress, cover, broadcast, feeCeilingSats, itemInfoTimeoutMs });
  } finally {
    ledger.unlockExclusive();
  }
}

async function mintAndSendLocked({
  ledger,
  album,
  row,
  deps,
  recipientAddress = null,
  cover = null,
  broadcast = false,
  feeCeilingSats = album.perSwapFeeCeilingSats ?? 5000,
  itemInfoTimeoutMs = 360_000,
}) {
  const steps = [];
  /** item_desc display, decided once (partName comes from the live vault row) and persisted in the ledger. */
  let display = null;
  let current = ledger.rowById(row.id);
  const albumOk = current.genesis === album.genesis && current.code_hash === album.codeHash;
  if (!albumOk) fail('FOREIGN_ALBUM_ROW', `ledger row ${current.id} does not belong to the MetaBot Avatar album`);
  const tokenIndex = Number(current.token_index);
  const itemPath = itemPathForToken(tokenIndex);

  if (current.state === 'sent') {
    return { ok: true, state: 'sent', ledgerId: current.id, tokenIndex, itemPath, alreadyDone: true, steps };
  }
  if (current.state === 'detected') {
    fail('ROW_NOT_CLAIMED', `ledger row ${current.id} is detected — run verify-claim first`);
  }
  if (['rejected', 'refunded', 'burn_pending', 'burned'].includes(current.state)) {
    fail('ROW_STATE_NOT_ACTIONABLE', `ledger row ${current.id} is ${current.state}; mint-and-send does not apply`);
  }

  // ---- mint phase -------------------------------------------------------
  if (current.state === 'claimed' && !current.mint_pin_id) {
    const collectionKey = current.collection_slug || album.collectionSlug || album.genesis;
    const otherMinted = ledger.mintedRowsByToken(collectionKey, tokenIndex).filter((r) => r.id !== current.id);
    if (otherMinted.length) {
      fail(
        'TOKEN_INDEX_ALREADY_MINTED',
        `tokenIndex ${tokenIndex} already carries a minted pin on ledger row ${otherMinted[0].id} (${otherMinted[0].mint_pin_id}); refusing a second mint`,
        { rows: otherMinted.map((r) => ({ id: r.id, state: r.state, mintPinId: r.mint_pin_id })) },
      );
    }

    // Belt and braces: the token must still sit at the recorded vault
    // outpoint. A claim whose deposit moved (manual rescue, wrong claim)
    // must never mint.
    let live = null;
    let partName = null;
    if (deps.fetchVaultRows) {
      const vaultRows = await deps.fetchVaultRows();
      live = vaultRows.find((r) => `${r.txid}:${r.outIndex}` === current.deposit_outpoint) ?? null;
      if (!live) {
        fail('DEPOSIT_NOT_IN_VAULT', `outpoint ${current.deposit_outpoint} left the vault after the claim — refusing to mint`);
      }
      const tripleOk =
        live.genesis === current.genesis &&
        live.codehash === current.code_hash &&
        Number(live.tokenIndex) === tokenIndex;
      if (!tripleOk) {
        fail('TRIPLE_MISMATCH', `vault row at ${current.deposit_outpoint} no longer matches the ledger triple — refusing to mint`);
      }
      partName = live.name || null;
    }

    // ---- cover gate (2026-11-19 cover-loss fix, report §4.2 step 3) ------
    // The legacy image is only fetchable while the old token sits in the
    // vault — and the DEPOSIT_NOT_IN_VAULT assert above just proved that
    // window is open. Minting without a produced cover is exactly the
    // silent data loss this gate exists to stop: no cover ⇒ no mint.
    let coverFinal = cover;
    let coverSource = cover ? 'explicit' : null;
    let coverPlan = null; // dry-run-only: what the cover WOULD be
    if (!coverFinal) {
      if (deps.resolveCover) {
        const resolved = await deps.resolveCover({ row: current, live, broadcast, album });
        if (resolved?.cover) {
          coverFinal = resolved.cover;
          coverSource = resolved.source ?? 'resolver';
        } else if (broadcast && resolved?.code === 'COVER_UNAVAILABLE') {
          // Permanent: no image can be produced. Reject the row — this opens
          // the owner-approved refund path (rejected → refunded); the deposit
          // is never consumed by this run and the old token stays in the
          // vault, so the attach-cover window stays open too.
          const reason = `cover unavailable: ${resolved?.message ?? 'no legacy image could be produced'}`;
          ledger.reject(current.id, reason);
          steps.push({ step: 'cover_unavailable_reject', ledgerId: current.id, code: 'COVER_UNAVAILABLE' });
          fail('COVER_UNAVAILABLE', `${reason} — mint aborted, ledger row ${current.id} rejected (refund path available)`, {
            tokenIndex,
            itemPath,
            sourceUrl: resolved?.sourceUrl ?? null,
          });
        } else if (broadcast) {
          // Transient infra (download/upload): retryable — the row stays
          // claimed and nothing was broadcast.
          fail(
            resolved?.code ?? 'COVER_FETCH_FAILED',
            `${resolved?.message ?? 'cover resolution failed'} — retryable; the row stays claimed and no mint was broadcast`,
            { tokenIndex, itemPath, retryable: true },
          );
        } else {
          // Dry-run: surface the resolver's plan in the returned plan payload
          // instead of failing (ok+planOnly = image validates, upload is
          // deferred to --broadcast; ok:false = the gap itself).
          coverPlan = resolved ?? { ok: false, code: 'COVER_UNAVAILABLE', message: 'resolver returned nothing' };
        }
      } else if (broadcast) {
        fail(
          'COVER_UNAVAILABLE',
          'no explicit --cover and no deps.resolveCover — minting here would silently drop the legacy image (cover-loss root cause); pass --cover or wire a resolver',
          { tokenIndex, itemPath },
        );
      } else {
        coverPlan = { ok: false, code: 'COVER_UNAVAILABLE', message: 'no resolver wired and no explicit --cover', sourceUrl: live?.imgUrl ?? null };
      }
    }

    display = buildItemDisplay({
      tokenIndex,
      depositTxid: current.deposit_txid,
      album,
      cover: coverFinal,
      partName,
    });
    // Belt and braces (report §4.2 step 3 item 4): never persist a cover-less
    // display — that is what made crash recovery replay the no-cover decision
    // (report §3.2d). Guards BOTH the fresh mint and the adopt path below:
    // adopting a pre-fix orphan pin whose image is gone cannot pass here —
    // resolve that pin's cover via attach-cover/backfill and resume with an
    // explicit --cover.
    if (broadcast && !display.cover) {
      fail('COVER_MISSING_BEFORE_MINT', `display for ${itemPath} has no cover — refusing to record any mint broadcast`, {
        tokenIndex,
        itemPath,
        coverSource,
      });
    }

    const probe = await deps.probeItemPath({ collectionName: album.collectionName, itemPath });
    const pathState = classifyItemPathProbe({ pins: probe.pins, issuerAddress: album.issuerAddress });
    if (pathState.status === 'conflict') {
      fail('ITEM_PATH_CONFLICT', `${itemPath} already has a non-official pin — stop and alert the owner`, {
        itemPath,
        foreign: pathState.foreign,
      });
    }

    if (pathState.status === 'issuer-minted') {
      if (pathState.official.length > 1) {
        fail(
          'MULTIPLE_OFFICIAL_MINTS',
          `${itemPath} has ${pathState.official.length} issuer pins — a double mint already happened; human review required`,
          { pins: pathState.official },
        );
      }
      const adopted = pathState.official[0];
      const bound = ledger
        .rowsByStates(MINTED_STATES)
        .find((r) => r.mint_pin_id === adopted.pinId && r.id !== current.id);
      if (bound) {
        fail(
          'MINT_PIN_BOUND_TO_OTHER_ROW',
          `${itemPath} pin ${adopted.pinId} is already bound to ledger row ${bound.id}`,
          { pinId: adopted.pinId, ledgerId: bound.id },
        );
      }
      current = ledger.recordMintBroadcast(current.id, {
        itemPath,
        mintPinId: adopted.pinId,
        txids: [],
        dualCheck: {
          adoptedFromPathProbe: true,
          pinHeight: adopted.height,
          recoveredWithoutRebroadcast: true,
          display,
        },
      });
      steps.push({ step: 'mint_adopt', itemPath, mintPinId: adopted.pinId, note: 'resumed from an already-broadcast pin — no re-mint' });
    } else {
      const estimate = deps.estimateMintPins
        ? await deps.estimateMintPins({ collectionName: album.collectionName, itemPath, display })
        : null;
      if (estimate && estimate.totalSats > feeCeilingSats) {
        fail(
          'FEE_CEILING_EXCEEDED',
          `mint pins would cost ~${estimate.totalSats} sats, over the ${feeCeilingSats} sats/swap ceiling — paused before broadcast (COST-BUDGET §5-1)`,
          estimate,
        );
      }
      if (!broadcast) {
        return {
          ok: true,
          dryRun: true,
          ledgerId: current.id,
          tokenIndex,
          itemPath,
          state: current.state,
          plan: {
            itemPath,
            display,
            estimate,
            feeCeilingSats,
            coverStatus: coverFinal ? { decided: true, cover: coverFinal, source: coverSource } : { decided: false, plan: coverPlan },
          },
          next: 'mint_broadcast',
          steps,
        };
      }
      let receipt;
      try {
        receipt = await deps.mintItemPin({ collectionName: album.collectionName, itemPath });
      } catch (error) {
        // No receipt means no recorded pin. If the broadcast actually landed,
        // the next run's exact-path probe adopts it — never blindly re-mint.
        fail(
          'MINT_BROADCAST_FAILED',
          `mint broadcast failed (${error instanceof Error ? error.message : String(error)}); re-run to resume — the itemPath probe prevents a double mint`,
          { itemPath },
        );
      }
      if (!receipt?.pinId) fail('MINT_RECEIPT_MISSING', 'mint broadcaster returned no pinId');
      current = ledger.recordMintBroadcast(current.id, {
        itemPath,
        mintPinId: receipt.pinId,
        txids: receipt.txids ?? [],
        dualCheck: {
          ledgerPlaceholder: true,
          pathProbe: pathState.status,
          estimate,
          feeCeilingSats,
          mintTotalCostSats: receipt.totalCost ?? null,
          display,
        },
      });
      steps.push({ step: 'mint_broadcast', itemPath, mintPinId: receipt.pinId, totalCostSats: receipt.totalCost ?? null });
    }
  }

  // ---- item_desc (retryable display layer) ------------------------------
  current = ledger.rowById(current.id);
  if (current.state === 'mint_pending' && !current.item_desc_pin_id) {
    // Reuse the display recorded at mint time; only rebuild when resuming a
    // ledger written before the display was persisted.
    let recordedDisplay = null;
    try {
      recordedDisplay = JSON.parse(current.dual_check_json ?? '{}')?.display ?? null;
    } catch {
      recordedDisplay = null;
    }
    let descDisplay =
      recordedDisplay ||
      display ||
      buildItemDisplay({ tokenIndex, depositTxid: current.deposit_txid, album, cover });
    // Cover guard on the ONLY other display write site (2026-11-19 fix):
    // item_desc is per-field first-write-wins, so a cover-less write here
    // would repeat the original mistake permanently (report §3.2d). Rebuild
    // the display with a resolved cover when possible; refuse the write when
    // none can be produced — the row stays mint_pending and retryable (the
    // mint pin already exists on chain, so this path never rejects the row).
    if (!descDisplay.cover && broadcast) {
      let resolvedCover = cover;
      if (!resolvedCover && deps.resolveCover) {
        const resolved = await deps.resolveCover({ row: current, live: null, broadcast, album });
        if (resolved?.cover) {
          resolvedCover = resolved.cover;
        } else {
          fail(
            resolved?.code ?? 'COVER_UNAVAILABLE',
            `item_desc cover unavailable (${resolved?.message ?? 'no image could be produced'}) — display write refused; the row stays mint_pending (retryable)`,
            { tokenIndex, itemPath, mintPinId: current.mint_pin_id },
          );
        }
      }
      if (!resolvedCover) {
        fail(
          'COVER_MISSING_BEFORE_ITEM_DESC',
          'item_desc would be written without a cover and no resolver is wired — refusing a permanently coverless display; pass --cover',
          { tokenIndex, itemPath, mintPinId: current.mint_pin_id },
        );
      }
      descDisplay = buildItemDisplay({
        tokenIndex,
        depositTxid: current.deposit_txid,
        album,
        cover: resolvedCover,
        partName: partNameFromTitle(descDisplay.name),
      });
      steps.push({ step: 'cover_resolved_for_item_desc', cover: resolvedCover });
    }
    if (!broadcast) {
      return {
        ok: true,
        dryRun: true,
        ledgerId: current.id,
        tokenIndex,
        itemPath,
        state: 'mint_pending',
        mintPinId: current.mint_pin_id,
        plan: { display: descDisplay },
        next: 'item_desc_broadcast',
        steps,
      };
    }
    let desc;
    try {
      desc = await deps.writeItemDesc({
        collectionName: album.collectionName,
        item: { pinId: current.mint_pin_id, ...descDisplay },
      });
    } catch (error) {
      // The mint pin is already recorded; item_desc is display-only and
      // retryable. Never let this failure invalidate the mint.
      fail(
        'ITEM_DESC_BROADCAST_FAILED',
        `item_desc broadcast failed after the mint pin ${current.mint_pin_id} was recorded — retry is safe (no re-mint): ${error instanceof Error ? error.message : String(error)}`,
        { mintPinId: current.mint_pin_id, itemPath },
      );
    }
    if (!desc?.pinId) fail('ITEM_DESC_RECEIPT_MISSING', 'item_desc writer returned no pinId');
    current = ledger.recordItemDescPin(current.id, { itemDescPinId: desc.pinId });
    steps.push({ step: 'item_desc_broadcast', itemDescPinId: desc.pinId, totalCostSats: desc.totalCost ?? null });
  }

  // ---- confirm pipeline (§5.6) -----------------------------------------
  current = ledger.rowById(current.id);
  if (current.state === 'mint_pending') {
    if (!broadcast) {
      return {
        ok: true,
        dryRun: true,
        ledgerId: current.id,
        tokenIndex,
        itemPath,
        state: 'mint_pending',
        mintPinId: current.mint_pin_id,
        next: 'confirm_pipeline',
        steps,
      };
    }
    const waited = await deps.waitItemInfo({ pinId: current.mint_pin_id, timeoutMs: itemInfoTimeoutMs });
    if (!waited?.hit) {
      return {
        ok: false,
        pending: true,
        reason: 'ITEM_INFO_NOT_INDEXED',
        ledgerId: current.id,
        tokenIndex,
        itemPath,
        mintPinId: current.mint_pin_id,
        state: current.state,
        lastError: waited?.lastError ?? null,
        steps: [...steps, { step: 'confirm_wait', hit: false }],
      };
    }
    const info = waited.hit;
    const verify = await deps.fetchItemVerify(current.mint_pin_id);
    const collection = await deps.fetchCollectionInfo(album.collectionName);
    const checks = {
      creatorMinted: verify?.creatorMinted === true,
      createAddressMatch: Boolean(collection?.createAddress) && collection.createAddress === album.issuerAddress,
      hasOutput: /^[0-9a-f]{64}:\d+$/i.test(String(info?.output ?? '')) && Number(info?.outputValue) > 0,
      itemPinId: current.mint_pin_id,
    };
    if (!checks.creatorMinted || !checks.createAddressMatch) {
      fail(
        'MINT_VERIFY_FAILED',
        `official-mint verification failed (creatorMinted=${checks.creatorMinted}, createAddressMatch=${checks.createAddressMatch}) — halt and alert the owner; the pin stays mint_pending`,
        { checks, verify, collection },
      );
    }
    if (!checks.hasOutput) {
      return {
        ok: false,
        pending: true,
        reason: 'OUTPUT_FIELDS_PENDING',
        ledgerId: current.id,
        tokenIndex,
        itemPath,
        mintPinId: current.mint_pin_id,
        state: current.state,
        checks,
        steps: [...steps, { step: 'confirm_output_pending', checks }],
      };
    }
    current = ledger.recordMintConfirmed(current.id, checks);
    steps.push({ step: 'mint_confirmed', checks });
  }

  // ---- transfer (发货) --------------------------------------------------
  current = ledger.rowById(current.id);
  if (current.state === 'minted') {
    const recipient = current.claimant_address || recipientAddress;
    if (!recipient) fail('RECIPIENT_MISSING', `ledger row ${current.id} has no claimant address and --recipient was not given`);
    if (!broadcast) {
      return {
        ok: true,
        dryRun: true,
        ledgerId: current.id,
        tokenIndex,
        itemPath,
        state: 'minted',
        mintPinId: current.mint_pin_id,
        plan: { transferTo: recipient },
        next: 'transfer_broadcast',
        steps,
      };
    }
    let receipt;
    try {
      receipt = await deps.transferItem({ pinId: current.mint_pin_id, toAddress: recipient });
    } catch (error) {
      // A failed broadcast may still have landed. The item UTXO can only be
      // spent once, so a retry cannot double-send — but check item/info
      // before retrying, and never fake a transfer_txid.
      fail(
        'TRANSFER_BROADCAST_FAILED',
        `item transfer failed (${error instanceof Error ? error.message : String(error)}); check item/info before retrying — the row stays minted`,
        { pinId: current.mint_pin_id, toAddress: recipient },
      );
    }
    if (!receipt?.txId) fail('TRANSFER_RECEIPT_MISSING', 'transfer broadcaster returned no txid');
    current = ledger.recordTransferBroadcast(current.id, {
      transferTxid: receipt.txId,
      feeSats: receipt.feeSats ?? null,
    });
    steps.push({ step: 'transfer_broadcast', transferTxid: receipt.txId, toAddress: recipient, feeSats: receipt.feeSats ?? null });
  }

  // ---- stability → sent (§5.7) -----------------------------------------
  current = ledger.rowById(current.id);
  if (current.state === 'send_pending') {
    if (!broadcast) {
      return {
        ok: true,
        dryRun: true,
        ledgerId: current.id,
        tokenIndex,
        itemPath,
        state: 'send_pending',
        mintPinId: current.mint_pin_id,
        transferTxid: current.transfer_txid,
        next: 'transfer_stability',
        steps,
      };
    }
    const stable = await deps.waitTransferStable({ pinId: current.mint_pin_id, minCount: 1 });
    if (!stable?.ok) {
      return {
        ok: false,
        pending: true,
        reason: 'TRANSFER_NOT_STABLE',
        ledgerId: current.id,
        tokenIndex,
        itemPath,
        mintPinId: current.mint_pin_id,
        transferTxid: current.transfer_txid,
        transferCount: stable?.transferCount ?? null,
        state: current.state,
        steps: [...steps, { step: 'transfer_stability', stable: false }],
      };
    }
    current = ledger.recordTransferStable(current.id, { transferCount: stable.transferCount });
    steps.push({ step: 'transfer_stable', transferCount: stable.transferCount });
  }

  current = ledger.rowById(current.id);
  let resolvedDisplayCover = null;
  try {
    const parsedDual = current.dual_check_json ? JSON.parse(current.dual_check_json) : null;
    resolvedDisplayCover = String(parsedDual?.display?.cover ?? '').trim() || null;
  } catch {
    resolvedDisplayCover = null;
  }
  if (!resolvedDisplayCover && cover) {
    resolvedDisplayCover = String(cover).trim() || null;
  }
  return {
    ok: current.state === 'sent',
    collectionSlug: current.collection_slug || album.collectionSlug || 'metabot-avatar',
    state: current.state,
    ledgerId: current.id,
    tokenIndex,
    itemPath,
    mintPinId: current.mint_pin_id,
    itemDescPinId: current.item_desc_pin_id,
    transferTxid: current.transfer_txid,
    transferCount: current.transfer_count,
    cover: resolvedDisplayCover,
    steps,
  };
}

// ---------------------------------------------------------------------------
// burn-batch: sent → burn_pending → burned (PRD §5.8, prereview #7/#10)
// ---------------------------------------------------------------------------

/**
 * Burn candidates for a batch: only `sent` rows with a stable transferCount
 * (the ledger's burnCandidates() predicate) are eligible, and each one is
 * re-checked against the live vault. A row whose token already left the vault
 * is an anomaly (it must be in the vault until the burn spends it) and is
 * reported, never burned blind.
 *
 * Cover gate (2026-11-19 cover-loss fix, report §4.2 step 4): each candidate's
 * minted item must ALSO carry a non-empty cover (item/info read). A cover-less
 * item must never be burned — the burn destroys the last chance to fetch the
 * legacy artwork. Requires deps.fetchItemInfo.
 */
export async function planBurnBatch({ ledger, deps, limit = 50 }) {
  if (typeof deps.fetchItemInfo !== 'function') {
    fail('COVER_GATE_UNAVAILABLE', "burn gate needs deps.fetchItemInfo to read each item's cover (cover-loss fix 2026-11-19)");
  }
  const rows = ledger.burnCandidates().slice(0, Math.max(0, limit));
  const vaultRows = await deps.fetchVaultRows();
  const present = new Set(vaultRows.map((r) => `${r.txid}:${r.outIndex}`));
  const candidates = [];
  for (const row of rows) {
    const inVault = present.has(row.deposit_outpoint);
    const outpointMatches = inVault
      ? vaultRows.some(
          (r) =>
            `${r.txid}:${r.outIndex}` === row.deposit_outpoint &&
            r.genesis === row.genesis &&
            r.codehash === row.code_hash &&
            Number(r.tokenIndex) === Number(row.token_index),
        )
      : false;
    const info = row.mint_pin_id ? await deps.fetchItemInfo(row.mint_pin_id) : null;
    const cover = String(info?.cover || '').trim() || null;
    const coverOk = Boolean(cover);
    candidates.push({
      ledgerId: row.id,
      tokenIndex: Number(row.token_index),
      itemPath: row.item_path,
      depositOutpoint: row.deposit_outpoint,
      itemPinId: row.mint_pin_id ?? null,
      transferCount: row.transfer_count,
      state: row.state,
      cover,
      eligible: inVault && outpointMatches && coverOk,
      reason: !inVault
        ? 'TOKEN_NOT_IN_VAULT'
        : !outpointMatches
        ? 'OUTPOINT_TRIPLE_MISMATCH'
        : !coverOk
        ? 'COVER_MISSING_BEFORE_BURN'
        : null,
    });
  }
  return { candidates, vaultScanned: vaultRows.length };
}

/**
 * Execute (or dry-run) one burn batch. Broadcasting requires BOTH
 * `broadcast:true` and `ownerConfirmed:true` (PRD §9: owner sign-off is the
 * gate for burn actions). Each burn is one tx for one token (prereview #7 —
 * the wallet capability has no multi-token batch).
 *
 * Crash recovery inside a batch: a `burn_pending` row in this batch with no
 * recorded burn_txid is resumed ONLY when its token still sits in the vault.
 * If the token is gone and no txid was recorded, the broadcast may have
 * landed — the row is reported for manual txid reconciliation and is never
 * re-broadcast (double-spending an already-spent token input cannot succeed,
 * but a blind retry would hide the missing evidence).
 *
 * Cover gate (2026-11-19 cover-loss fix): a broadcast refuses the WHOLE batch
 * while any candidate or recoverable burn_pending row points at a cover-less
 * item (COVER_MISSING_BEFORE_BURN with the roster) — burning would destroy
 * the last chance to fetch the legacy artwork. Backfill/attach covers first,
 * then re-run.
 */
export async function runBurnBatch({
  ledger,
  album,
  batchId,
  deps,
  broadcast = false,
  ownerConfirmed = false,
  limit = 50,
  settleMs = 3_000,
}) {
  if (!batchId) fail('BATCH_ID_MISSING', 'burn-batch requires --batch-id (it is the batch audit key)');
  const plan = await planBurnBatch({ ledger, deps, limit });

  const pendingRows = ledger
    .rowsByStates(['burn_pending'])
    .filter((row) => row.burn_batch_id === batchId && !row.burn_txid);
  const vaultRows = await deps.fetchVaultRows();
  const vaultByOutpoint = new Map(vaultRows.map((r) => [`${r.txid}:${r.outIndex}`, r]));
  const recovery = [];
  for (const row of pendingRows) {
    const live = vaultByOutpoint.get(row.deposit_outpoint) ?? null;
    const tripleOk =
      Boolean(live) &&
      live.genesis === row.genesis &&
      live.codehash === row.code_hash &&
      Number(live.tokenIndex) === Number(row.token_index);
    const info = row.mint_pin_id ? await deps.fetchItemInfo(row.mint_pin_id) : null;
    const cover = String(info?.cover || '').trim() || null;
    const coverOk = Boolean(cover);
    recovery.push({
      ledgerId: row.id,
      tokenIndex: Number(row.token_index),
      depositOutpoint: row.deposit_outpoint,
      itemPath: row.item_path ?? null,
      itemPinId: row.mint_pin_id ?? null,
      cover,
      inVault: Boolean(live),
      tripleOk,
      coverOk,
      reason: !live
        ? 'TOKEN_NOT_IN_VAULT'
        : !tripleOk
        ? 'OUTPOINT_TRIPLE_MISMATCH'
        : !coverOk
        ? 'COVER_MISSING_BEFORE_BURN'
        : null,
    });
  }

  const blocked = recovery.filter((r) => !r.tripleOk || !r.coverOk);
  const blockedForTxidFail = recovery.filter((r) => !r.tripleOk);
  if (!broadcast) {
    return {
      ok: true,
      dryRun: true,
      batchId,
      burnAddress: album.burnAddress,
      plan: plan.candidates,
      recovery,
      blockedRecovery: blocked,
      vaultScanned: plan.vaultScanned,
    };
  }
  if (!ownerConfirmed) {
    fail('OWNER_CONFIRMATION_REQUIRED', 'burn-batch broadcast requires explicit owner sign-off (--confirm-owner)');
  }
  if (blockedForTxidFail.length) {
    fail(
      'BURN_RECOVERY_TXID_UNKNOWN',
      'a burn_pending row is no longer in the vault but has no recorded txid — reconcile the txid manually before continuing',
      { blocked: blockedForTxidFail },
    );
  }
  // Cover gate (report §4.2 step 4): refuse the whole broadcast while ANY
  // candidate or recoverable row points at a cover-less item, and surface
  // the roster as the alert.
  const coverBlocked = [
    ...plan.candidates.filter((c) => c.reason === 'COVER_MISSING_BEFORE_BURN'),
    ...recovery.filter((r) => r.reason === 'COVER_MISSING_BEFORE_BURN'),
  ];
  if (coverBlocked.length) {
    fail(
      'COVER_MISSING_BEFORE_BURN',
      `${coverBlocked.length} token(s) have no cover on their new item — burning now would destroy the last chance to fetch the legacy image. Backfill/attach covers first (cli/attach-cover.mjs / cli/backfill-covers.mjs), then re-run this batch`,
      {
        blockedTokens: coverBlocked.map((r) => ({
          ledgerId: r.ledgerId,
          tokenIndex: r.tokenIndex,
          itemPath: r.itemPath ?? null,
          itemPinId: r.itemPinId ?? null,
        })),
      },
    );
  }

  const executed = [];
  const executable = [
    ...plan.candidates.filter((candidate) => candidate.eligible).map((candidate) => ({ ledgerId: candidate.ledgerId, resumed: false })),
    ...recovery.filter((r) => r.tripleOk && r.coverOk).map((r) => ({ ledgerId: r.ledgerId, resumed: true })),
  ];
  for (const item of executable) {
    const row = ledger.rowById(item.ledgerId);
    if (!row) fail('LEDGER_ROW_MISSING', `ledger row ${item.ledgerId} vanished mid-batch`);
    if (row.state === 'sent') ledger.enterBurnBatch(row.id, batchId);
    const receipt = await deps.transferLegacyToken({
      genesis: row.genesis,
      codehash: row.code_hash,
      tokenIndex: String(row.token_index),
      toAddress: album.burnAddress,
    });
    if (!receipt?.txId) fail('BURN_RECEIPT_MISSING', 'burn broadcaster returned no txid');
    ledger.recordBurnBroadcast(row.id, {
      batchId,
      burnTxid: receipt.txId,
      feeSats: receipt.feeSats ?? null,
    });
    executed.push({
      ledgerId: row.id,
      tokenIndex: Number(row.token_index),
      resumed: item.resumed,
      burnTxid: receipt.txId,
      feeSats: receipt.feeSats ?? null,
      feeOverCeiling: receipt.feeSats != null && receipt.feeSats > (album.perSwapFeeCeilingSats ?? 5000),
    });
    if (settleMs > 0 && deps.sleep) await deps.sleep(settleMs);
  }

  const resumed = recovery.filter((r) => r.tripleOk).map((r) => r.ledgerId);
  return {
    ok: true,
    batchId,
    burnAddress: album.burnAddress,
    executed,
    resumed,
    skipped: plan.candidates.filter((c) => !c.eligible),
    remainingCandidates: ledger.burnCandidates().length,
  };
}

// ---------------------------------------------------------------------------
// Transfer stability (§5.7 sent gate)
// ---------------------------------------------------------------------------

/**
 * Wait until the item's transferCount reaches `minCount` and stays unchanged
 * for `windowMs`. Injectable clock so tests are deterministic.
 */
export async function waitForTransferStable({
  pinId,
  fetchItemInfo,
  minCount = 1,
  windowMs = 30_000,
  timeoutMs = 180_000,
  intervalMs = 5_000,
  clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
}) {
  const start = clock.now();
  let last = null;
  let stableSince = null;
  while (clock.now() - start <= timeoutMs) {
    const info = await fetchItemInfo(pinId);
    const count = Number(info?.transferCount ?? 0);
    if (count >= minCount) {
      if (last !== count) {
        last = count;
        stableSince = clock.now();
      } else if (stableSince != null && clock.now() - stableSince >= windowMs) {
        return { ok: true, transferCount: count };
      }
    } else {
      last = count;
      stableSince = null;
    }
    await clock.sleep(intervalMs);
  }
  return { ok: false, transferCount: last ?? 0, reason: 'TRANSFER_NOT_STABLE' };
}
