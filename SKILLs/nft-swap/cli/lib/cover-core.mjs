/**
 * cover-core.mjs — the ONE implementation of the "legacy artwork → metafile
 * upload → issuer item_desc (cover+desc)" stage of the MetaContract → MRC-721
 * swap pipeline.
 *
 * Two CLIs sit on top of this module and neither re-implements the logic:
 *   - cli/backfill-covers.mjs   repair / roster for ALREADY-MINTED items
 *   - cli/attach-cover.mjs      the pipeline stage: snapshot → preupload →
 *                               post-mint item_desc hook (batch + single)
 *
 * Stage contract (see docs/cover-pipeline-v1.md):
 *   snapshot  (pre-burn, free)    vault row → imgUrl → download → PNG gate → sha256
 *   preupload (1 chain write)     bytes → host upload-largefile → metafile pin
 *   attach    (1 chain write)     issuer-signed item_desc {pinid, cover, desc}
 *   verify                        cover visible in BOTH indexer views
 *
 * Safety: never touches a mnemonic (signing happens inside the host); the
 * issuer gate refuses to write an item_desc the indexer would silently drop.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ISSUER_CONFIG } from './issuer-config.mjs';

export const RPC_BASE = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
export const INDEXER_BASE = (process.env.IDBOTS_MRC721_INDEXER_API_BASE || 'https://so.metaid.io').replace(/\/+$/, '');
export const WALLET_API_BASE = (process.env.IDBOTS_WALLET_API_BASE || 'https://www.metalet.space').replace(/\/+$/, '');

/**
 * Ratified pilot constants (owner-ratified 2026-11-05; measured 2026-11-18).
 * Both the collection createAddress and the signing identity are re-verified on
 * every run (preflight), so a stale constant fails closed instead of writing
 * into a foreign album.
 */
export const DEFAULT_COLLECTION_ID = '26b335096639b7f049138501bd10ed6f1a315efd081d787a1c7b74ae6d70ffd8i0';
export const DEFAULT_VAULT_ADDRESS = '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET';

export const PIN_RE = /^[0-9a-f]{64}i\d+$/;
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Host RPC (local gateway; the token never leaves this process)
// ---------------------------------------------------------------------------

function resolveRpcToken() {
  const fromEnv = String(process.env.IDBOTS_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const authFile = String(process.env.IDBOTS_RPC_AUTHFILE || '').trim();
  if (!authFile) return '';
  try {
    return fs.readFileSync(authFile, 'utf8').trim();
  } catch {
    return '';
  }
}

const RPC_TOKEN = resolveRpcToken();

function rpcHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (RPC_TOKEN) headers.Authorization = `Bearer ${RPC_TOKEN}`;
  return headers;
}

export async function rpcPost(pathname, body, timeoutMs = 120_000) {
  const res = await fetch(RPC_BASE + pathname, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new Error(`RPC ${pathname} HTTP ${res.status}: ${parsed?.error || text.slice(0, 500)}`);
  }
  if (parsed == null) throw new Error(`RPC ${pathname} returned non-JSON: ${text.slice(0, 300)}`);
  if (parsed.success === false) throw new Error(parsed.error || `RPC ${pathname} failed`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Indexer reads
// ---------------------------------------------------------------------------

export async function indexerData(pathname, params, { timeoutMs = 25_000 } = {}) {
  const url = new URL(INDEXER_BASE + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) throw new Error(`indexer ${pathname} HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!parsed || typeof parsed !== 'object') throw new Error(`indexer ${pathname} non-JSON: ${text.slice(0, 300)}`);
  if (parsed.code !== 1 && parsed.code !== 0) {
    throw new Error(`indexer ${pathname} code ${parsed.code}: ${parsed.message || ''}`);
  }
  return parsed.data;
}

export async function readCollectionInfo(collectionId) {
  return indexerData('/api/mrc721/collection/info', { pinId: collectionId });
}

export async function readAllCollectionItems(collectionId) {
  const items = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const data = await indexerData('/api/mrc721/collection/items/pageList', {
      pinid: collectionId,
      size: 100,
      cursor,
    });
    const list = Array.isArray(data?.list) ? data.list : [];
    items.push(...list);
    const next = data?.cursor;
    if (!list.length || !next || seenCursors.has(String(next))) break;
    seenCursors.add(String(next));
    cursor = next;
  }
  return items;
}

/**
 * Cached collection index — a 9560-item album is ~96 pages; batch runs and the
 * per-mint hook must not re-page it every time.
 */
export function readCollectionIndexCache(cacheFile, maxAgeMs) {
  try {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return Array.isArray(parsed?.items) ? parsed.items : null;
  } catch {
    return null;
  }
}

export function writeCollectionIndexCache(cacheFile, items) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ at: new Date().toISOString(), items }, null, 0) + '\n');
}

export async function readItemInfo(pinId, { confirmedOnly = false } = {}) {
  try {
    return await indexerData('/api/mrc721/item/info', {
      pinId,
      ...(confirmedOnly ? { confirmedOnly: 1 } : {}),
    });
  } catch (error) {
    const message = errorText(error);
    if (/HTTP 404|code 404/.test(message)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Vault holdings (legacy artwork source — ONLY available while the token is
// still held; after burn the row disappears, hence the pre-burn snapshot).
// ---------------------------------------------------------------------------

/**
 * Fetch EVERY legacy NFT row held by the vault, keeping imgUrl/name/icon.
 * Same flag-cursor house semantics as cli/lib/vault-poll-lib.mjs: the API
 * ignores genesis filters and paginates with the last row's `flag`.
 */
export async function fetchVaultHoldings(vaultAddress) {
  const rows = [];
  const seenRows = new Set();
  const seenFlags = new Set();
  let flag;
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${WALLET_API_BASE}/wallet-api/v4/mvc/address/contract/nft/utxo-list`);
    url.searchParams.set('net', 'livenet');
    url.searchParams.set('address', vaultAddress);
    if (flag) url.searchParams.set('flag', flag);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!res.ok) throw new Error(`wallet-api HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (!parsed || (parsed.code !== 0 && parsed.code !== 1)) {
      throw new Error(`wallet-api code ${parsed?.code}: ${parsed?.message || text.slice(0, 200)}`);
    }
    const list = Array.isArray(parsed?.data?.list) ? parsed.data.list : [];
    if (!list.length) break;
    let newRows = 0;
    for (const row of list) {
      const entry = {
        tokenIndex: Number(row.tokenIndex ?? row.tokenindex ?? 0),
        name: String(row.name || ''),
        imgUrl: String(row.imgUrl || row.imageUrl || ''),
        icon: String(row.icon || ''),
        genesis: String(row.genesis || ''),
        codeHash: String(row.codeHash || row.codehash || ''),
        txId: String(row.txId || row.txid || ''),
        txIndex: Number(row.txIndex ?? row.outIndex ?? 0),
        satoshi: Number(row.satoshi ?? 0),
        flag: row.flag,
      };
      // The house flag-cursor can re-serve the same page unchanged (a one-row
      // vault does this: flag "0" never advances). Dedupe by outpoint so the
      // reported count is the true holding count.
      const outpoint = `${entry.txId}:${entry.txIndex}`;
      if (seenRows.has(outpoint)) continue;
      seenRows.add(outpoint);
      rows.push(entry);
      newRows++;
    }
    const nextFlag = list[list.length - 1]?.flag;
    if (!newRows || !nextFlag || nextFlag === flag || seenFlags.has(String(nextFlag))) break;
    seenFlags.add(String(nextFlag));
    flag = nextFlag;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Image download + PNG verification
// ---------------------------------------------------------------------------

export function parsePngSize(buffer) {
  // 8-byte magic, then a 4-byte length, 'IHDR', width(4), height(4)
  if (buffer.length < 24) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export async function downloadPng(url) {
  if (!/^https:\/\//i.test(url)) throw new Error(`image url is not https: ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    headers: { Accept: 'image/png,image/*;q=0.8,*/*;q=0.5' },
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`);
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (content-length ${declared} > ${MAX_IMAGE_BYTES}): ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${buffer.length} > ${MAX_IMAGE_BYTES}): ${url}`);
  }
  if (buffer.length < PNG_MAGIC.length || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error(
      `not a PNG (magic ${buffer.subarray(0, 8).toString('hex')}, content-type "${contentType || 'unset'}"): ${url}`,
    );
  }
  const size = parsePngSize(buffer);
  return {
    buffer,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    contentType: contentType || 'unset',
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

// ---------------------------------------------------------------------------
// Write path (host RPC)
// ---------------------------------------------------------------------------

export async function uploadPng(metabotId, image) {
  const tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'nft-swap-cover-'));
  const tmpFile = path.join(tmpDir, `cover-${image.sha256.slice(0, 12)}.png`);
  fs.writeFileSync(tmpFile, image.buffer);
  try {
    const result = await rpcPost(
      '/api/idbots/files/upload-largefile',
      { metabot_id: metabotId, file_path: tmpFile, content_type: 'image/png', network: 'mvc' },
      180_000,
    );
    const pinId = String(result.pinId || '').trim().toLowerCase();
    if (!PIN_RE.test(pinId)) throw new Error(`upload returned an invalid pinId: "${pinId}"`);
    return {
      pinId,
      // Bare metafile URI (no extension) matches the already-adopted #2671
      // cover form: metafile://<64hex>i0.
      metafileUri: `metafile://${pinId}`,
      uploadMode: result.uploadMode ?? null,
      totalCost: Number.isFinite(Number(result.totalCost)) ? Number(result.totalCost) : null,
      feeAssist: result.feeAssist ?? null,
      txids: Array.isArray(result.txids) ? result.txids : [],
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export function buildItemDescMetaidData(collectionName, entries) {
  const payload = JSON.stringify({
    items: entries.map((entry) => ({
      pinid: entry.pinId,
      ...(entry.cover ? { cover: entry.cover } : {}),
      ...(entry.desc ? { desc: entry.desc } : {}),
    })),
  });
  return {
    operation: 'create',
    path: `/nft/mrc721/${collectionName}/item_desc`,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload,
  };
}

export async function writeItemDesc(metabotId, collectionName, entries) {
  const metaidData = buildItemDescMetaidData(collectionName, entries);
  const result = await rpcPost('/api/metaid/create-pin', {
    metabot_id: metabotId,
    network: 'mvc',
    metaidData,
  });
  const pinId = String(result.pinId || (Array.isArray(result.txids) ? `${result.txids[0]}i0` : '')).trim();
  if (!PIN_RE.test(pinId)) throw new Error(`create-pin returned an invalid pinId: "${pinId}"`);
  return {
    pinId,
    txids: Array.isArray(result.txids) ? result.txids : [],
    totalCost: Number.isFinite(Number(result.totalCost)) ? Number(result.totalCost) : null,
    feeAssist: result.feeAssist ?? null,
    payloadBytes: Buffer.byteLength(metaidData.payload),
  };
}

/**
 * Upper-bound fee estimate, mirroring mrc721Service.estimateMvcMrc721PinFeeSats:
 * base(62) + OP_RETURN script + 2 PPKH inputs(148 each) + 1 change output(34).
 * ESTIMATE only — the exact cost is on the write receipt.
 */
export function estimatePinFeeSats(payload, feeRate, collectionName = ISSUER_CONFIG.collectionName) {
  const parts = [
    'metaid',
    'create',
    `/nft/mrc721/${collectionName}/item_desc`.toLowerCase(),
    '0',
    '1.0.0',
    'application/json',
    Buffer.from(payload, 'utf8'),
  ];
  let scriptSize = 1;
  for (const part of parts) {
    const length = Buffer.isBuffer(part) ? part.length : Buffer.byteLength(String(part), 'utf8');
    if (length < 76) scriptSize += 1 + length;
    else if (length <= 0xff) scriptSize += 2 + length;
    else if (length <= 0xffff) scriptSize += 3 + length;
    else scriptSize += 5 + length;
  }
  const txSize = 62 + scriptSize + 2 * 148 + 34;
  return Math.ceil(txSize * feeRate);
}

/**
 * Fee estimate for an image upload. Measured 2026-11-18: a 12,437 B PNG cost
 * 12,906 sats (12,437 + ~469 B of tx envelope at 1 sat/vB). Estimate only.
 */
export function estimateUploadFeeSats(bytes, feeRate = 1) {
  const envelope = 469;
  return Math.ceil((Number(bytes || 0) + envelope) * feeRate);
}

/** Sponsor channel of a host receipt → a uniform, machine-readable status. */
export function sponsorStatus(feeAssist) {
  if (!feeAssist || typeof feeAssist !== 'object') {
    return { mode: 'self-pay', assisted: false, attempted: false, reason: 'no feeAssist in receipt', detail: null };
  }
  const attempted = feeAssist.attempted === true;
  const used = feeAssist.used === true;
  if (used) {
    return {
      mode: 'sponsor',
      assisted: true,
      attempted,
      reason: String(feeAssist.reason || 'applied'),
      billedBy: feeAssist.billedBy ?? null,
      meAmountMilli: Number.isFinite(Number(feeAssist.meAmountMilli)) ? Number(feeAssist.meAmountMilli) : null,
      sponsoredMinerFee: Number.isFinite(Number(feeAssist.sponsoredMinerFee))
        ? Number(feeAssist.sponsoredMinerFee)
        : null,
      orderId: feeAssist.orderId ?? null,
      detail: feeAssist,
    };
  }
  if (attempted) {
    return {
      mode: 'sponsor-fallback-self-pay',
      assisted: false,
      attempted,
      reason: String(feeAssist.reason || 'unknown'),
      stage: feeAssist.stage ?? null,
      orderId: feeAssist.orderId ?? null,
      detail: feeAssist,
    };
  }
  return { mode: 'self-pay', assisted: false, attempted: false, reason: String(feeAssist.reason || 'not attempted'), detail: feeAssist };
}

// ---------------------------------------------------------------------------
// Local write journal — the second idempotency layer (indexer lag safety)
// ---------------------------------------------------------------------------

export function journalPath(outDir) {
  return path.join(outDir, 'writes.jsonl');
}

export function readJournal(outDir) {
  const file = journalPath(outDir);
  const state = new Map();
  if (!fs.existsSync(file)) return state;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry = null;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry?.itemPinId) continue;
    const current = state.get(entry.itemPinId) || {};
    state.set(entry.itemPinId, {
      ...current,
      ...entry,
      coverPinId: entry.coverPinId || current.coverPinId || null,
      itemDescPinId: entry.itemDescPinId || current.itemDescPinId || null,
    });
  }
  return state;
}

export function appendJournal(outDir, entry) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(journalPath(outDir), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// ---------------------------------------------------------------------------
// Item ↔ tokenIndex mapping
// ---------------------------------------------------------------------------

export function parseItemMetadata(item) {
  const raw = item?.metadata ?? item?.metaData ?? null;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export function tokenIndexOfItem(item) {
  const metadata = parseItemMetadata(item);
  const candidates = [
    metadata?.custom?.swap?.tokenIndex,
    metadata?.swap?.tokenIndex,
    metadata?.tokenIndex,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value > 0) return { tokenIndex: value, source: 'metadata' };
  }
  const nameMatch = String(item?.name || '').match(/#(\d{1,7})(?!\d)/);
  if (nameMatch) {
    const value = Number(nameMatch[1]);
    if (Number.isInteger(value) && value > 0) return { tokenIndex: value, source: 'name' };
  }
  const number = Number(item?.number);
  if (Number.isInteger(number) && number > 0) return { tokenIndex: number, source: 'number' };
  return null;
}

export function indexItemsByToken(items) {
  const byToken = new Map();
  const duplicates = [];
  const unmapped = [];
  for (const item of items) {
    const resolved = tokenIndexOfItem(item);
    if (!resolved) {
      unmapped.push({ itemPinId: item?.itemPinId || null, name: item?.name || null });
      continue;
    }
    const existing = byToken.get(resolved.tokenIndex);
    if (existing && existing.item?.itemPinId !== item?.itemPinId) {
      duplicates.push({
        tokenIndex: resolved.tokenIndex,
        pins: [existing.item?.itemPinId, item?.itemPinId],
      });
      continue;
    }
    byToken.set(resolved.tokenIndex, { item, source: resolved.source });
  }
  return { byToken, duplicates, unmapped };
}

export function describeItem(item) {
  return {
    itemPinId: item?.itemPinId || null,
    name: item?.name || null,
    cover: item?.cover || '',
    desc: item?.desc || '',
    ownerAddress: item?.ownerAddress || null,
    burned: item?.burned === true,
    createTime: item?.createTime ?? null,
  };
}

export function legacyShortName(legacy) {
  return String(legacy?.name || '')
    .replace(/^MetaBot Avatar\s*[-–—:]?\s*/i, '')
    .trim();
}

export function buildDesc(tokenIndex, legacy) {
  const short = legacyShortName(legacy);
  return `由 MetaContract「MetaBot Avatar」原系列 #${tokenIndex}${short ? `（${short}）` : ''} 1:1 兑换而来，封面即旧版原图。`;
}

// ---------------------------------------------------------------------------
// Preflight — the issuer gate
// ---------------------------------------------------------------------------

export async function preflight(args) {
  const collection = await readCollectionInfo(args.collectionId);
  if (!collection) throw new Error(`COLLECTION_NOT_INDEXED: ${args.collectionId}`);
  const createAddress = String(collection.createAddress || collection.address || '').trim();
  if (createAddress !== ISSUER_CONFIG.issuerAddress) {
    throw new Error(
      `COLLECTION_NOT_OWNED: collection ${args.collectionId} createAddress=${createAddress || '(empty)'} `
        + `!= ratified issuer ${ISSUER_CONFIG.issuerAddress} — the indexer would drop our item_desc`,
    );
  }

  let identity = null;
  let identityError = null;
  try {
    const summary = await rpcPost('/api/idbots/metabot/account-summary', { metabot_id: args.metabotId });
    identity = {
      metabotId: args.metabotId,
      name: summary.name || null,
      mvcAddress: String(summary.mvc_address || '').trim() || null,
    };
  } catch (error) {
    identityError = errorText(error);
  }

  if (identity?.mvcAddress && identity.mvcAddress !== ISSUER_CONFIG.issuerAddress) {
    throw new Error(
      `NOT_ISSUER_IDENTITY: metabot ${args.metabotId} mvc_address=${identity.mvcAddress} `
        + `!= ratified issuer ${ISSUER_CONFIG.issuerAddress} — refusing to write a doomed item_desc`,
    );
  }
  if (!identity && args.write) {
    throw new Error(`IDENTITY_CHECK_UNAVAILABLE: ${identityError || 'account-summary failed'} (write refused)`);
  }

  return {
    collection: {
      name: collection.collectionName || collection.collectionname || ISSUER_CONFIG.collectionName,
      pinId: collection.pinid || args.collectionId,
      createAddress,
      totalSupply: collection.totalSupply ?? collection.totalsupply ?? null,
      mintedCount: collection.mintedCount ?? collection.confirmedMintedCount ?? collection.totalnum ?? null,
      confirmed: collection.confirmed === true,
    },
    issuer: {
      ratifiedAddress: ISSUER_CONFIG.issuerAddress,
      metabotId: args.metabotId,
      mvcAddress: identity?.mvcAddress ?? null,
      name: identity?.name ?? null,
      isIssuer: identity?.mvcAddress === ISSUER_CONFIG.issuerAddress,
      identityCheckError: identityError,
    },
  };
}

// ---------------------------------------------------------------------------
// Planning (read-only)
// ---------------------------------------------------------------------------

export async function planToken({ tokenIndex, item, resolvedBy, ctx }) {
  const base = {
    tokenIndex,
    resolvedBy,
    ...describeItem(item),
  };

  if (!item) return { ...base, status: 'NOT_MINTED' };
  if (item.burned === true) return { ...base, status: 'SKIP_BURNED' };

  const currentCover = String(item.cover || '').trim();
  const currentDesc = String(item.desc || '').trim();
  // --rehearse-missing plans the cover write for an item that already has one
  // (a what-if preview for the owner); it NEVER writes and never lies about
  // the current state — base.cover still carries the real value.
  const assumedMissing = Boolean(currentCover) && ctx.rehearseMissingEnabled === true;
  const coverMissing = !currentCover || assumedMissing;
  const descMissing = !currentDesc;

  if (!coverMissing && !descMissing && !ctx.probeImage) {
    return { ...base, status: 'SKIP_HAS_COVER_AND_DESC' };
  }

  const journal = ctx.journal.get(item.itemPinId) || null;
  if (journal?.itemDescPinId && !ctx.ignoreJournal) {
    return { ...base, status: 'SKIP_JOURNAL_PENDING', journal };
  }

  // Desc-only repair needs no image.
  if (!coverMissing) {
    const plannedDesc = descMissing ? buildDesc(tokenIndex, ctx.vaultByToken.get(tokenIndex)) : null;
    const entry = { ...base, status: 'SKIP_HAS_COVER', plannedDesc, writes: plannedDesc ? ['desc'] : [] };
    if (!ctx.probeImage) return entry;
    // --probe-image: still resolve/download the legacy artwork as evidence that
    // the pipeline works for a covered item. Strictly read-only.
    const legacy = ctx.vaultByToken.get(tokenIndex) || null;
    if (!legacy?.imgUrl) {
      return { ...entry, probe: { ok: false, error: 'no vault imgUrl for this tokenIndex' } };
    }
    try {
      const image = await downloadPng(legacy.imgUrl);
      return {
        ...entry,
        probe: {
          ok: true,
          sourceUrl: legacy.imgUrl,
          legacyName: legacy.name || null,
          bytes: image.bytes,
          contentType: image.contentType,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
          uploadedInDryRun: false,
        },
      };
    } catch (error) {
      return { ...entry, probe: { ok: false, error: errorText(error) } };
    }
  }

  // Cover is missing — resolve the legacy artwork.
  const legacy = ctx.vaultByToken.get(tokenIndex) || null;
  if (!legacy) {
    return {
      ...base,
      status: 'NO_LEGACY_IMAGE',
      error: assumedMissing
        ? `rehearsal only: tokenIndex ${tokenIndex} is not in vault ${ctx.vaultAddress}; the real item keeps its existing cover ${currentCover}`
        : `tokenIndex ${tokenIndex} is not in vault ${ctx.vaultAddress} and this item has no cover`,
    };
  }
  if (!legacy.imgUrl) {
    return { ...base, status: 'NO_LEGACY_IMAGE', error: `vault row for tokenIndex ${tokenIndex} carries no imgUrl`, legacy };
  }

  let image = null;
  try {
    image = await downloadPng(legacy.imgUrl);
  } catch (error) {
    return { ...base, status: 'IMAGE_FAILED', error: errorText(error), legacy };
  }

  const reusedCover = journal?.coverPinId && !ctx.ignoreJournal ? journal.coverPinId : null;
  const plannedDesc = descMissing ? buildDesc(tokenIndex, legacy) : null;
  const plannedEntries = [
    ...(reusedCover ? [] : [{ field: 'cover', fromBytes: image.bytes, sha256: image.sha256 }]),
    ...(plannedDesc ? [{ field: 'desc', value: plannedDesc }] : []),
  ];
  const placeholderCover = reusedCover ? `metafile://${reusedCover}` : `metafile://${'0'.repeat(64)}i0`;
  const metaidData = buildItemDescMetaidData(ctx.collectionName, [
    { pinId: item.itemPinId, cover: placeholderCover, desc: plannedDesc || '' },
  ]);

  return {
    ...base,
    status: 'READY',
    ...(assumedMissing ? { assumedMissing: true, note: 'cover already set on chain; this is a rehearsal plan only' } : {}),
    legacy: {
      tokenIndex: legacy.tokenIndex,
      name: legacy.name,
      imgUrl: legacy.imgUrl,
      txId: legacy.txId,
      txIndex: legacy.txIndex,
      genesis: legacy.genesis,
      codeHash: legacy.codeHash,
    },
    image: {
      sourceUrl: legacy.imgUrl,
      bytes: image.bytes,
      contentType: image.contentType,
      sha256: image.sha256,
      width: image.width,
      height: image.height,
      pngMagic: true,
      uploadedInDryRun: false,
    },
    reusedCoverPinId: reusedCover || null,
    plannedCover: reusedCover ? `metafile://${reusedCover}` : 'metafile://<metafile pin from upload>',
    plannedDesc,
    plannedFields: plannedEntries.map((entry) => entry.field),
    plannedPayloadPreview: metaidData.payload,
    plannedPayloadPreviewNote: reusedCover
      ? 'cover 引用 journal 中已上传的 metafile pin；预览即实际将广播的 payload'
      : 'cover 字段用 64 个 0 + i0 占位（真实 pin 要等上传后才知道），payload 只用于估算字节数与费用',
    estimateSats: estimatePinFeeSats(metaidData.payload, ctx.feeRate, ctx.collectionName),
    estimatePayloadBytes: Buffer.byteLength(metaidData.payload),
  };
}

// ---------------------------------------------------------------------------
// Write execution
// ---------------------------------------------------------------------------

export async function writeOne({ plan, ctx }) {
  const tokenIndex = plan.tokenIndex;
  const itemPinId = plan.itemPinId;
  let coverUri = plan.reusedCoverPinId ? `metafile://${plan.reusedCoverPinId}` : null;
  let upload = null;

  if (!coverUri) {
    log(`[${tokenIndex}] uploading ${plan.image.bytes} B PNG (sha256 ${plan.image.sha256.slice(0, 16)}…)`);
    try {
      upload = await uploadPng(ctx.metabotId, {
        buffer: plan.image.bufferSafe,
        sha256: plan.image.sha256,
      });
    } catch (error) {
      return { ...plan, status: 'UPLOAD_FAILED', error: errorText(error) };
    }
    coverUri = upload.metafileUri;
    appendJournal(ctx.outDir, {
      tokenIndex,
      itemPinId,
      phase: 'uploaded',
      coverPinId: upload.pinId,
      coverUri,
      totalCost: upload.totalCost,
      feeAssist: upload.feeAssist ?? null,
    });
  }

  const entries = [{ pinId: itemPinId, cover: coverUri, desc: plan.plannedDesc || '' }];
  log(`[${tokenIndex}] broadcasting item_desc pin (cover ${coverUri})…`);
  let write = null;
  try {
    write = await writeItemDesc(ctx.metabotId, ctx.collectionName, entries);
  } catch (error) {
    return { ...plan, status: 'WRITE_FAILED', coverUri, upload, error: errorText(error) };
  }

  appendJournal(ctx.outDir, {
    tokenIndex,
    itemPinId,
    phase: 'written',
    coverPinId: upload?.pinId || plan.reusedCoverPinId,
    coverUri,
    itemDescPinId: write.pinId,
    txids: write.txids,
    totalCost: write.totalCost,
    feeAssist: write.feeAssist,
  });

  log(`[${tokenIndex}] item_desc ${write.pinId} broadcast — waiting for indexer adoption…`);
  const verification = await verifyAdoption(itemPinId, coverUri, ctx.waitMs);
  return {
    ...plan,
    status: verification.adopted ? 'WRITTEN_VERIFIED' : 'WRITTEN_UNVERIFIED',
    coverUri,
    upload,
    itemDescPinId: write.pinId,
    txids: write.txids,
    totalCost: write.totalCost,
    feeAssist: write.feeAssist,
    verification,
    error: verification.adopted ? null : 'item_desc broadcast but the cover is not yet visible in BOTH indexer views',
  };
}

export async function verifyAdoption(itemPinId, expectedCover, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let plain = null;
  let persisted = null;
  for (;;) {
    try {
      plain = await readItemInfo(itemPinId);
    } catch (error) {
      plain = { error: errorText(error) };
    }
    try {
      persisted = await readItemInfo(itemPinId, { confirmedOnly: true });
    } catch (error) {
      persisted = { error: errorText(error) };
    }
    const plainOk = String(plain?.cover || '').trim() === expectedCover;
    const persistedOk = String(persisted?.cover || '').trim() === expectedCover;
    if (plainOk && persistedOk) {
      return {
        adopted: true,
        plainCover: plain.cover,
        persistedCover: persisted.cover,
        plainDesc: plain?.desc || '',
        checkedAt: new Date().toISOString(),
      };
    }
    if (Date.now() >= deadline) {
      return {
        adopted: false,
        plainCover: plain?.cover ?? null,
        persistedCover: persisted?.cover ?? null,
        plainError: plain?.error || null,
        persistedError: persisted?.error || null,
        checkedAt: new Date().toISOString(),
      };
    }
    await sleep(5000);
  }
}

// ---------------------------------------------------------------------------
// Cover catalog (produced by attach-cover --snapshot): the ONLY artwork record
// that survives a legacy burn. The repair CLI falls back to it when the vault
// row is already gone.
// ---------------------------------------------------------------------------

export function defaultCatalogFile(cwd = process.cwd()) {
  return path.resolve(cwd, 'out', 'attach-cover', 'cover-catalog.jsonl');
}

export function readCoverCatalogLegacy(catalogFile) {
  const map = new Map();
  if (!catalogFile || !fs.existsSync(catalogFile)) return map;
  for (const line of fs.readFileSync(catalogFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry = null;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const tokenIndex = Number(entry?.tokenIndex);
    const legacy = entry?.legacy;
    if (!Number.isInteger(tokenIndex) || tokenIndex <= 0 || !legacy?.imgUrl) continue;
    if (map.has(tokenIndex)) continue;
    map.set(tokenIndex, {
      tokenIndex,
      name: String(legacy.name || ''),
      imgUrl: String(legacy.imgUrl),
      icon: '',
      genesis: String(legacy.genesis || ''),
      codeHash: String(legacy.codeHash || ''),
      txId: String(legacy.txId || ''),
      txIndex: Number(legacy.txIndex ?? 0),
      satoshi: 0,
      flag: null,
      source: 'catalog',
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Shared context assembly (both CLIs plan/write through the same ctx shape)
// ---------------------------------------------------------------------------

export function buildContext({ args, preflightResult, items, vaultRows }) {
  const { byToken, duplicates, unmapped } = indexItemsByToken(items);
  const vaultByToken = new Map();
  for (const row of vaultRows) {
    if (Number.isInteger(row.tokenIndex) && row.tokenIndex > 0 && !vaultByToken.has(row.tokenIndex)) {
      vaultByToken.set(row.tokenIndex, row);
    }
  }
  return {
    ...args,
    ...preflightResult,
    collectionName: preflightResult.collection.name,
    metabotId: args.metabotId,
    probeImage: args.probeImage === true,
    rehearseMissingEnabled: args.rehearseMissing === true,
    ignoreJournal: args.ignoreJournal === true,
    journal: readJournal(args.outDir),
    byToken,
    allItems: items,
    duplicates,
    unmapped,
    vaultAddress: args.vaultAddress,
    vaultByToken,
    feeRate: args.feeRate,
    outDir: args.outDir,
    waitMs: args.waitMs,
  };
}
