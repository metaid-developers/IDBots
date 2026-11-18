#!/usr/bin/env node
/**
 * attach-cover.mjs — the IMAGE-CONVERSION STAGE of the MetaContract → MRC-721
 * swap pipeline. Not a per-item repair tool: this is the stage that makes
 * "every swapped item carries its legacy artwork" a property of the pipeline.
 *
 * The stage has three code paths over ONE engine (cli/lib/cover-core.mjs):
 *
 *   --snapshot   (free)        vault row → imgUrl → download → PNG gate → sha256,
 *                              recorded in the local cover catalog.
 *                              MUST run while the legacy token still sits in the
 *                              vault: after the burn the row disappears from
 *                              wallet-api and the artwork URL is lost.
 *   --preupload  (1 chain write) catalog image → host upload → metafile pin.
 *                              Optional; can be folded into --attach.
 *   --attach     (1 chain write) issuer-signed item_desc {pinid, cover, desc}
 *                              + adoption verification. This is the call the
 *                              post-mint hook makes — one line, O(1) when
 *                              --item-pin is passed.
 *
 * Dry-run is the DEFAULT. A real write needs BOTH --write AND an owner
 * approval record (--approval-id + --approval-file) AND a hard --max-sats
 * ceiling. The approval file is the owner's per-batch gate; this CLI refuses
 * to invent one for itself.
 *
 * Exit codes: 0 ok · 1 any failure/unverified · 2 refusal (gate/budget/usage).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_VAULT_ADDRESS,
  PIN_RE,
  log,
  sleep,
  nowStamp,
  errorText,
  readAllCollectionItems,
  readCollectionIndexCache,
  writeCollectionIndexCache,
  readItemInfo,
  fetchVaultHoldings,
  downloadPng,
  uploadPng,
  buildItemDescMetaidData,
  writeItemDesc,
  estimatePinFeeSats,
  estimateUploadFeeSats,
  sponsorStatus,
  journalPath,
  readJournal,
  appendJournal,
  preflight,
  verifyAdoption,
  indexItemsByToken,
  buildDesc,
  tokenIndexOfItem,
} from './lib/cover-core.mjs';

const PIPELINE = 'attach-cover/v1';
const FAILED_STATES = new Set([
  'LEGACY_NOT_IN_VAULT',
  'NO_LEGACY_IMAGE',
  'IMAGE_FAILED',
  'IMAGE_CHANGED',
  'UPLOAD_FAILED',
  'WRITE_FAILED',
  'AMBIGUOUS_TOKEN',
]);

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    mode: null,
    tokens: [],
    token: null,
    itemPin: null,
    all: false,
    write: false,
    dryRun: false,
    feeRate: 1,
    waitMs: 120_000,
    outDir: path.resolve('out', 'attach-cover'),
    vaultAddress: DEFAULT_VAULT_ADDRESS,
    collectionId: DEFAULT_COLLECTION_ID,
    metabotId: Number(process.env.IDBOTS_METABOT_ID || 0) || null,
    batchSize: 50,
    limit: null,
    delayMs: 250,
    maxConsecutiveFailures: 3,
    maxSats: null,
    approvalId: null,
    approvalFile: null,
    indexMaxAgeMs: 10 * 60 * 1000,
    refreshIndex: false,
    noResume: false,
    rehearseMissing: false,
  };
  const next = (arg, i) => {
    const value = argv[i + 1];
    if (value == null) throw new Error(`${arg} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--snapshot') args.mode = 'snapshot';
    else if (arg === '--preupload') args.mode = 'preupload';
    else if (arg === '--attach') args.mode = 'attach';
    else if (arg === '--audit') args.mode = 'audit';
    else if (arg === '--token') {
      const raw = next(arg, i);
      i++;
      for (const part of String(raw).split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(trimmed)) throw new Error(`invalid tokenIndex "${trimmed}" in --token`);
        args.tokens.push(Number(trimmed));
      }
      args.sawTokenFlag = true;
    } else if (arg === '--tokens') {
      args.sawTokensFlag = true;
      for (const part of next(arg, i).split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(trimmed)) throw new Error(`invalid tokenIndex "${trimmed}" in --tokens`);
        args.tokens.push(Number(trimmed));
      }
      i++;
    } else if (arg === '--item-pin') {
      args.itemPin = next(arg, i).trim();
      i++;
    } else if (arg === '--all') args.all = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--fee-rate') {
      args.feeRate = Number(next(arg, i));
      i++;
    } else if (arg === '--wait-ms') {
      args.waitMs = Number(next(arg, i));
      i++;
    } else if (arg === '--out-dir') {
      args.outDir = path.resolve(next(arg, i));
      i++;
    } else if (arg === '--vault-address') {
      args.vaultAddress = next(arg, i).trim();
      i++;
    } else if (arg === '--collection-id') {
      args.collectionId = next(arg, i).trim();
      i++;
    } else if (arg === '--metabot-id') {
      args.metabotId = Number(next(arg, i));
      i++;
    } else if (arg === '--batch-size') {
      args.batchSize = Number(next(arg, i));
      i++;
    } else if (arg === '--limit') {
      args.limit = Number(next(arg, i));
      i++;
    } else if (arg === '--delay-ms') {
      args.delayMs = Number(next(arg, i));
      i++;
    } else if (arg === '--max-consecutive-failures') {
      args.maxConsecutiveFailures = Number(next(arg, i));
      i++;
    } else if (arg === '--max-sats') {
      args.maxSats = Number(next(arg, i));
      i++;
    } else if (arg === '--approval-id') {
      args.approvalId = next(arg, i).trim();
      i++;
    } else if (arg === '--approval-file') {
      args.approvalFile = path.resolve(next(arg, i));
      i++;
    } else if (arg === '--index-max-age-ms') {
      args.indexMaxAgeMs = Number(next(arg, i));
      i++;
    } else if (arg === '--refresh-index') args.refreshIndex = true;
    else if (arg === '--no-resume') args.noResume = true;
    else if (arg === '--rehearse-missing') args.rehearseMissing = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(helpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.mode) args.mode = 'attach';
  if (args.dryRun && args.write) throw new Error('--dry-run and --write are mutually exclusive');
  if (args.sawTokenFlag && args.sawTokensFlag) throw new Error('--token and --tokens are mutually exclusive');
  if (args.itemPin && args.tokens.length !== 1) throw new Error('--item-pin applies to exactly one --token');
  if (args.itemPin && !PIN_RE.test(args.itemPin)) throw new Error(`--item-pin must be <64hex>i<n>: "${args.itemPin}"`);
  if (!Number.isFinite(args.feeRate) || args.feeRate <= 0) throw new Error('--fee-rate must be positive');
  if (!Number.isInteger(args.batchSize) || args.batchSize <= 0) throw new Error('--batch-size must be a positive integer');
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 0)) throw new Error('--limit must be >= 0');
  if (!Number.isInteger(args.metabotId) || args.metabotId <= 0) {
    throw new Error('--metabot-id (or IDBOTS_METABOT_ID) must be a positive integer');
  }
  if (args.write && args.mode === 'attach') {
    if (!Number.isFinite(args.maxSats) || args.maxSats <= 0) {
      throw new Error('--write requires an explicit --max-sats ceiling (no unbounded spend)');
    }
    if (!args.approvalId) throw new Error('--write requires --approval-id (the owner approval record for this batch)');
  }
  if (args.write && args.mode === 'preupload') {
    if (!Number.isFinite(args.maxSats) || args.maxSats <= 0) {
      throw new Error('--write requires an explicit --max-sats ceiling (no unbounded spend)');
    }
    if (!args.approvalId) throw new Error('--write requires --approval-id (the owner approval record for this batch)');
  }
  if (args.rehearseMissing && args.write) throw new Error('--rehearse-missing is a dry-run preview and cannot be combined with --write');
  if (!args.write && args.approvalId) {
    // harmless, but say it out loud: a dry run never needs an approval
    log('[args] approval id supplied in dry-run — ignored (no chain write)');
  }
  args.tokens = [...new Set(args.tokens)];
  if (args.tokens.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('tokenIndex must be a positive integer');
  if (args.mode === 'snapshot' && !args.all && !args.tokens.length) {
    throw new Error('--snapshot needs --all (whole vault) or --tokens/--token');
  }
  if (args.mode === 'preupload' && !args.all && !args.tokens.length) {
    throw new Error('--preupload needs --all (whole catalog) or --tokens/--token');
  }
  if (args.mode === 'attach' && !args.all && !args.tokens.length) {
    throw new Error('--attach needs --token/--tokens (the minted item) or --all (every minted item missing a cover)');
  }
  args.approvalFile = args.approvalFile || path.join(args.outDir, 'approvals.json');
  return args;
}

function helpText() {
  return `attach-cover.mjs — image-conversion stage of the MetaContract → MRC-721 swap

  --snapshot            capture legacy artwork (vault imgUrl → PNG gate → sha256) into
                        the local cover catalog. FREE. Run while the token is still in
                        the vault: after the burn the artwork URL is gone.
  --preupload          upload catalog images to the chain (1 write per image).
  --attach              write the issuer item_desc (cover+desc) for a MINTED item and
                        verify adoption (1 write). Default mode.
  --audit               report catalog coverage against the minted collection. FREE.

scope
  --token N             one tokenIndex      --tokens 1,2,3     a list
  --all                 snapshot: whole vault · attach: every minted cover-missing item
  --item-pin <pin>      the minted item pinId — skips the collection scan (O(1) mint hook)

write gates (all three required for a real write)
  --write --max-sats N --approval-id ID [--approval-file out/attach-cover/approvals.json]

scheduling
  --batch-size N        rows per checkpoint (default 50)
  --limit N             stop after N items
  --delay-ms N          pause between items (default 250)
  --max-consecutive-failures N   circuit breaker (default 3)
  --no-resume           reprocess catalog rows that are already done
  --refresh-index       re-page the collection instead of using the cache
  --rehearse-missing    dry-run only: plan the write as if the cover were absent
                        (what-if preview for an item that already has one)
  --index-max-age-ms N  collection index cache TTL (default 600000)

outputs
  out/attach-cover/cover-catalog.jsonl   the per-tokenIndex catalog (resume truth)
  out/attach-cover/batch-state.json      last-run checkpoint
  out/attach-cover/writes.jsonl          write journal (idempotency layer 2)
  out/attach-cover/approvals.json        owner approval records (per batch)

  --fee-rate N          fee rate for ESTIMATES only (default 1 sat/vB)
  --wait-ms N           adoption poll budget in write mode (default 120000)
  --out-dir DIR         artifact directory (default ./out/attach-cover)
`;
}

// ---------------------------------------------------------------------------
// approval gate — the owner's per-batch record, never self-issued
// ---------------------------------------------------------------------------

function readApprovals(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.approvals) ? parsed.approvals : [];
  } catch (error) {
    throw new Error(`APPROVAL_FILE_UNREADABLE: ${file}: ${errorText(error)}`);
  }
}

function requireApproval(args) {
  const approvals = readApprovals(args.approvalFile);
  const record = approvals.find((entry) => String(entry?.id || '') === args.approvalId);
  if (!record) {
    const sample = {
      approvals: [
        ...approvals,
        { id: args.approvalId, maxSats: args.maxSats, approvedAt: new Date().toISOString(), note: '<owner-approved batch>' },
      ],
    };
    throw new Error(
      `APPROVAL_NOT_FOUND: no approval "${args.approvalId}" in ${args.approvalFile}. `
        + `The owner must approve this batch first; the record to append (verbatim) is: `
        + JSON.stringify(sample, null, 2),
    );
  }
  const approvedMax = Number(record.maxSats);
  if (!Number.isFinite(approvedMax) || approvedMax <= 0) {
    throw new Error(`APPROVAL_INVALID: approval "${args.approvalId}" has no positive maxSats`);
  }
  if (args.maxSats > approvedMax) {
    throw new Error(
      `APPROVAL_CEILING: --max-sats ${args.maxSats} exceeds the owner-approved ceiling ${approvedMax} `
        + `for "${args.approvalId}"`,
    );
  }
  const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : null;
  if (expiresAt != null && Number.isFinite(expiresAt) && Date.now() > expiresAt) {
    throw new Error(`APPROVAL_EXPIRED: "${args.approvalId}" expired at ${record.expiresAt}`);
  }
  return { id: args.approvalId, maxSats: approvedMax, approvedAt: record.approvedAt ?? null, file: args.approvalFile };
}

// ---------------------------------------------------------------------------
// cover catalog — the per-tokenIndex truth, and the resume mechanism
// ---------------------------------------------------------------------------

function catalogPath(outDir) {
  return path.join(outDir, 'cover-catalog.jsonl');
}

function readCatalog(outDir) {
  const file = catalogPath(outDir);
  const state = new Map();
  if (!fs.existsSync(file)) return state;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry = null;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const tokenIndex = Number(entry?.tokenIndex);
    if (!Number.isInteger(tokenIndex) || tokenIndex <= 0) continue;
    const current = state.get(tokenIndex) || {};
    const merged = {
      ...current,
      ...entry,
      legacy: { ...(current.legacy || {}), ...(entry.legacy || {}) },
      image: { ...(current.image || {}), ...(entry.image || {}) },
      // sticky facts: once uploaded / written, never lost by a later phase row
      coverPinId: entry.coverPinId || current.coverPinId || null,
      coverUri: entry.coverUri || current.coverUri || null,
      itemPinId: entry.itemPinId || current.itemPinId || null,
      itemDescPinId: entry.itemDescPinId || current.itemDescPinId || null,
      phases: [...new Set([...(current.phases || []), ...(entry.phases || []), entry.phase].filter(Boolean))],
      sats: { ...(current.sats || {}), ...(entry.sats || {}) },
    };
    state.set(tokenIndex, merged);
  }
  return state;
}

/**
 * Content-addressed reuse: identical bytes never pay a second upload fee.
 * Key = image sha256, value = an existing metafile cover pin.
 */
function buildShaIndex(catalog) {
  const index = new Map();
  for (const entry of catalog.values()) {
    const sha = entry?.image?.sha256;
    const pin = entry?.coverPinId;
    if (sha && pin && !index.has(sha)) index.set(sha, { pinId: pin, tokenIndex: entry.tokenIndex });
  }
  return index;
}

function appendCatalog(outDir, entry) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(catalogPath(outDir), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// ---------------------------------------------------------------------------
// read-only retry (never used for money writes)
// ---------------------------------------------------------------------------

async function withRetry(label, fn, { attempts = 3, baseMs = 800 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      log(`[retry] ${label} attempt ${attempt}/${attempts} failed: ${errorText(error)}`);
      await sleep(baseMs * attempt);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// collection index (cached — a 9560-item album is ~96 pages)
// ---------------------------------------------------------------------------

async function loadCollectionItems(args) {
  const cacheFile = path.join(args.outDir, 'collection-index.json');
  if (!args.refreshIndex) {
    const cached = readCollectionIndexCache(cacheFile, args.indexMaxAgeMs);
    if (cached) {
      log(`[index] cache hit (${cached.length} item(s), ${cacheFile})`);
      return cached;
    }
  }
  const items = await withRetry('collection items', () => readAllCollectionItems(args.collectionId));
  writeCollectionIndexCache(cacheFile, items);
  log(`[index] ${items.length} minted item(s) paged from the collection; cache written`);
  return items;
}

// ---------------------------------------------------------------------------
// legacy resolution (catalog first, vault fallback) — the取数时机 rule
// ---------------------------------------------------------------------------

async function resolveLegacyForToken({ tokenIndex, catalog, vaultByToken, vaultError }) {
  const cached = catalog.get(tokenIndex);
  if (cached?.legacy?.imgUrl) {
    return { legacy: cached.legacy, source: 'catalog' };
  }
  const vaultRow = vaultByToken.get(tokenIndex);
  if (vaultRow?.imgUrl) {
    return { legacy: { ...vaultRow }, source: 'vault' };
  }
  return {
    legacy: null,
    source: 'none',
    error: vaultError
      ? `vault lookup failed: ${vaultError}`
      : `tokenIndex ${tokenIndex} is neither in the cover catalog nor in the vault `
        + `(after burn the wallet-api row is gone — snapshot BEFORE the burn batch)`,
  };
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

async function runSnapshot({ args, tokens, vaultRows, vaultByToken, vaultError }) {
  const catalog = readCatalog(args.outDir);
  const scope = tokens.length
    ? tokens
    : vaultRows.map((row) => row.tokenIndex).filter((n) => Number.isInteger(n) && n > 0);
  const items = [];
  let captured = 0;
  let failed = 0;

  for (const tokenIndex of scope) {
    const { legacy, source, error } = await resolveLegacyForToken({
      tokenIndex,
      catalog,
      vaultByToken,
      vaultError,
    });
    if (!legacy?.imgUrl) {
      failed++;
      items.push({ tokenIndex, status: 'LEGACY_NOT_IN_VAULT', error, source });
      log(`[${tokenIndex}] LEGACY_NOT_IN_VAULT — ${error}`);
      continue;
    }
    try {
      const image = await withRetry(`download ${tokenIndex}`, () => downloadPng(legacy.imgUrl));
      const row = {
        tokenIndex,
        phase: 'snapshot',
        status: 'SNAPSHOTTED',
        source,
        legacy: {
          tokenIndex,
          name: legacy.name || '',
          imgUrl: legacy.imgUrl,
          txId: legacy.txId || null,
          txIndex: legacy.txIndex ?? null,
          genesis: legacy.genesis || null,
          codeHash: legacy.codeHash || null,
        },
        image: {
          bytes: image.bytes,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
          contentType: image.contentType,
          sourceUrl: legacy.imgUrl,
        },
      };
      if (!args.write) {
        // dry-run: report, never persist a half-truth into the resume catalog
        items.push({ ...row, dryRun: true, persisted: false });
      } else {
        appendCatalog(args.outDir, row);
        items.push(row);
      }
      captured++;
      log(`[${tokenIndex}] SNAPSHOTTED ${image.bytes} B PNG ${image.width}x${image.height} sha256 ${image.sha256.slice(0, 16)}… (${source})`);
    } catch (err) {
      failed++;
      items.push({ tokenIndex, status: 'IMAGE_FAILED', error: errorText(err), source });
      log(`[${tokenIndex}] IMAGE_FAILED — ${errorText(err)}`);
    }
  }

  return {
    items,
    summary: {
      scope: scope.length,
      captured,
      failed,
      persisted: args.write,
      keyedBy: 'tokenIndex',
    },
    chainWrites: 0,
  };
}

// ---------------------------------------------------------------------------
// preupload
// ---------------------------------------------------------------------------

async function runPreupload({ args, tokens, ctx, approval, budget }) {
  const catalog = readCatalog(args.outDir);
  const shaIndex = buildShaIndex(catalog);
  const scope = tokens.length ? tokens : [...catalog.keys()].sort((a, b) => a - b);
  const items = [];
  let stopped = null;

  for (const tokenIndex of scope) {
    const entry = catalog.get(tokenIndex);
    if (!entry?.image?.sha256) {
      items.push({ tokenIndex, status: 'NOT_SNAPSHOTTED', error: 'no catalog image — run --snapshot first' });
      continue;
    }
    if (entry.coverPinId && !args.noResume) {
      items.push({ tokenIndex, status: 'SKIP_HAS_UPLOAD', upload: { pinId: entry.coverPinId, metafileUri: `metafile://${entry.coverPinId}` } });
      log(`[${tokenIndex}] SKIP_HAS_UPLOAD — reuse ${entry.coverPinId}`);
      continue;
    }
    const dup = shaIndex.get(entry.image.sha256);
    if (dup && !args.noResume) {
      // identical artwork already on chain — adopt that pin, zero fee
      appendCatalog(args.outDir, {
        tokenIndex,
        phase: 'preupload',
        status: 'PREUPLOADED',
        coverPinId: dup.pinId,
        coverUri: `metafile://${dup.pinId}`,
        sats: { upload: 0 },
        dedupe: { sha256: entry.image.sha256, reusedFromTokenIndex: dup.tokenIndex },
      });
      items.push({
        tokenIndex,
        status: 'PREUPLOADED',
        upload: { pinId: dup.pinId, metafileUri: `metafile://${dup.pinId}`, totalCost: 0, reused: true, dedupeFrom: dup.tokenIndex },
        estimateSats: 0,
        dedupe: 'sha256',
      });
      log(`[${tokenIndex}] PREUPLOADED (dedupe) → ${dup.pinId} (from #${dup.tokenIndex}), 0 sats`);
      continue;
    }
    const estimate = estimateUploadFeeSats(entry.image.bytes, args.feeRate);
    if (budget.wouldExceed(estimate)) {
      stopped = 'BUDGET_STOP';
      items.push({ tokenIndex, status: 'BUDGET_STOP', estimateSats: estimate, budget: budget.snapshot() });
      break;
    }

    let image = null;
    try {
      image = await withRetry(`download ${tokenIndex}`, () => downloadPng(entry.image.sourceUrl));
    } catch (error) {
      items.push({ tokenIndex, status: 'IMAGE_FAILED', error: errorText(error) });
      budget.noteFailure();
      if (budget.circuitOpen()) {
        stopped = 'CIRCUIT_OPEN';
        break;
      }
      continue;
    }
    if (image.sha256 !== entry.image.sha256) {
      items.push({
        tokenIndex,
        status: 'IMAGE_CHANGED',
        error: `sha256 changed since snapshot (${entry.image.sha256} → ${image.sha256}) — refusing to upload`,
      });
      budget.noteFailure();
      if (budget.circuitOpen()) {
        stopped = 'CIRCUIT_OPEN';
        break;
      }
      continue;
    }

    if (!args.write) {
      items.push({
        tokenIndex,
        status: 'READY_UPLOAD',
        image: { bytes: image.bytes, sha256: image.sha256, width: image.width, height: image.height },
        estimateSats: estimate,
      });
      log(`[${tokenIndex}] READY_UPLOAD ${image.bytes} B est=${estimate} sats`);
      continue;
    }

    let upload = null;
    try {
      upload = await uploadPng(args.metabotId, { buffer: image.buffer, sha256: image.sha256 });
    } catch (error) {
      items.push({ tokenIndex, status: 'UPLOAD_FAILED', error: errorText(error) });
      budget.noteFailure();
      appendJournal(args.outDir, { tokenIndex, phase: 'upload_failed', error: errorText(error) });
      if (budget.circuitOpen()) {
        stopped = 'CIRCUIT_OPEN';
        break;
      }
      await sleep(args.delayMs);
      continue;
    }
    budget.spend(upload.totalCost || estimate);
    budget.noteSuccess();
    shaIndex.set(image.sha256, { pinId: upload.pinId, tokenIndex });
    appendCatalog(args.outDir, {
      tokenIndex,
      phase: 'preupload',
      status: 'PREUPLOADED',
      coverPinId: upload.pinId,
      coverUri: upload.metafileUri,
      sats: { upload: upload.totalCost },
      sponsor: { upload: sponsorStatus(upload.feeAssist) },
    });
    appendJournal(args.outDir, {
      tokenIndex,
      phase: 'uploaded',
      coverPinId: upload.pinId,
      coverUri: upload.metafileUri,
      totalCost: upload.totalCost,
      feeAssist: upload.feeAssist ?? null,
    });
    items.push({
      tokenIndex,
      status: 'PREUPLOADED',
      upload: {
        pinId: upload.pinId,
        metafileUri: upload.metafileUri,
        totalCost: upload.totalCost,
        sponsor: sponsorStatus(upload.feeAssist),
      },
      estimateSats: estimate,
    });
    log(`[${tokenIndex}] PREUPLOADED ${upload.metafileUri} cost=${upload.totalCost} sats`);
    await sleep(args.delayMs);
  }

  return { items, stopped, approval };
}

// ---------------------------------------------------------------------------
// attach (post-mint hook)
// ---------------------------------------------------------------------------

async function resolveItem({ tokenIndex, args, byToken }) {
  if (args.itemPin) {
    const info = await withRetry('item info', () => readItemInfo(args.itemPin));
    if (!info) return null;
    return { item: info, resolvedBy: 'item-pin' };
  }
  return byToken.get(tokenIndex) || null;
}

async function runAttach({ args, tokens, ctx, approval, budget }) {
  const catalog = readCatalog(args.outDir);
  const shaIndex = buildShaIndex(catalog);
  const items = [];
  let stopped = null;
  const byToken = ctx.byToken;

  for (const tokenIndex of tokens) {
    const resolved = await resolveItem({ tokenIndex, args, byToken });
    if (!resolved?.item) {
      items.push({ tokenIndex, status: 'NOT_MINTED', itemPinId: null });
      log(`[${tokenIndex}] NOT_MINTED — no collection item maps to this tokenIndex`);
      continue;
    }
    const item = resolved.item;
    const itemPinId = item.itemPinId || args.itemPin;

    if (item.burned === true) {
      items.push({ tokenIndex, itemPinId, status: 'SKIP_BURNED' });
      continue;
    }

    const liveCover = String(item.cover || '').trim();
    const currentDesc = String(item.desc || '').trim();
    const assumedMissing = Boolean(liveCover) && args.rehearseMissing === true;
    const currentCover = assumedMissing ? '' : liveCover;
    if (currentCover && !args.noResume) {
      const entry = currentDesc
        ? { tokenIndex, itemPinId, status: 'SKIP_HAS_COVER_AND_DESC', cover: currentCover }
        : { tokenIndex, itemPinId, status: 'SKIP_HAS_COVER', cover: currentCover, note: 'cover present; desc repair belongs to backfill-covers' };
      items.push(entry);
      log(`[${tokenIndex}] ${entry.status} — idempotent skip`);
      continue;
    }

    const journal = ctx.journal.get(itemPinId) || null;
    if (journal?.itemDescPinId && !args.ignoreJournal) {
      items.push({
        tokenIndex,
        itemPinId,
        status: 'SKIP_JOURNAL_PENDING',
        itemDescPinId: journal.itemDescPinId,
        note: 'item_desc already broadcast; indexer may still be catching up',
      });
      log(`[${tokenIndex}] SKIP_JOURNAL_PENDING — item_desc ${journal.itemDescPinId}`);
      continue;
    }

    // ---- legacy artwork (catalog first; vault only as a fallback) ----
    const { legacy, source, error } = await resolveLegacyForToken({
      tokenIndex,
      catalog,
      vaultByToken: ctx.vaultByToken,
      vaultError: ctx.vaultError,
    });
    const catalogEntry = catalog.get(tokenIndex) || null;
    if (!legacy && !catalogEntry?.coverPinId) {
      items.push({ tokenIndex, itemPinId, status: 'NO_LEGACY_IMAGE', error });
      log(`[${tokenIndex}] NO_LEGACY_IMAGE — ${error}`);
      budget.noteFailure();
      if (budget.circuitOpen()) {
        stopped = 'CIRCUIT_OPEN';
        break;
      }
      continue;
    }

    const plannedDesc = currentDesc ? '' : buildDesc(tokenIndex, legacy);
    const reusedCoverPinId = catalogEntry?.coverPinId || (journal?.coverPinId && !args.ignoreJournal ? journal.coverPinId : null);

    // ---- preview payload / cost ----
    const previewCover = reusedCoverPinId
      ? `metafile://${reusedCoverPinId}`
      : `metafile://${'0'.repeat(64)}i0`;
    const previewPayload = buildItemDescMetaidData(ctx.collectionName, [
      { pinId: itemPinId, cover: previewCover, desc: plannedDesc || '' },
    ]).payload;
    const estItemDesc = estimatePinFeeSats(previewPayload, args.feeRate, ctx.collectionName);
    const needUpload = !reusedCoverPinId && !currentCover;
    const knownBytes = catalogEntry?.image?.bytes || 0;
    let estUpload = needUpload && legacy?.imgUrl && knownBytes ? estimateUploadFeeSats(knownBytes, args.feeRate) : 0;

    // ---- dry-run: plan only ----
    if (!args.write) {
      let imageEvidence = null;
      if (needUpload && legacy?.imgUrl) {
        try {
          const image = await withRetry(`download ${tokenIndex}`, () => downloadPng(legacy.imgUrl));
          imageEvidence = { bytes: image.bytes, sha256: image.sha256, width: image.width, height: image.height, sourceUrl: legacy.imgUrl };
          if (needUpload && !knownBytes) estUpload = estimateUploadFeeSats(image.bytes, args.feeRate);
          if (catalogEntry?.image?.sha256 && image.sha256 !== catalogEntry.image.sha256) {
            items.push({
              tokenIndex,
              itemPinId,
              status: 'IMAGE_CHANGED',
              error: `live image sha256 ${image.sha256} != catalog ${catalogEntry.image.sha256}`,
            });
            budget.noteFailure();
            continue;
          }
        } catch (err) {
          items.push({ tokenIndex, itemPinId, status: 'IMAGE_FAILED', error: errorText(err) });
          budget.noteFailure();
          if (budget.circuitOpen()) {
            stopped = 'CIRCUIT_OPEN';
            break;
          }
          continue;
        }
      }
      items.push({
        tokenIndex,
        itemPinId,
        status: 'READY_ATTACH',
        ...(assumedMissing ? { assumedMissing: true, note: 'cover already set on chain; rehearsal plan only' } : {}),
        resolvedBy: resolved.resolvedBy || 'index',
        coverSource: reusedCoverPinId ? 'catalog' : legacy ? source : 'none',
        plannedFields: [
          ...(currentCover ? [] : [needUpload ? 'cover(upload)' : 'cover(reuse)']),
          ...(plannedDesc ? ['desc'] : []),
        ],
        plannedDesc,
        image: imageEvidence,
        estimateSats: { itemDesc: estItemDesc, upload: estUpload, total: estItemDesc + estUpload },
        plannedPayloadPreview: previewPayload,
        dryRun: true,
      });
      log(`[${tokenIndex}] READY_ATTACH ${itemPinId} est=${estItemDesc + estUpload} sats (item_desc ${estItemDesc} + upload ${estUpload})`);
      continue;
    }

    // ---- real write ----
    const nextEstimate = estItemDesc + estUpload;
    if (budget.wouldExceed(nextEstimate)) {
      stopped = 'BUDGET_STOP';
      items.push({ tokenIndex, itemPinId, status: 'BUDGET_STOP', estimateSats: nextEstimate, budget: budget.snapshot() });
      log(`[${tokenIndex}] BUDGET_STOP — next ${nextEstimate} sats would exceed --max-sats ${budget.maxSats}`);
      break;
    }

    let upload = null;
    let coverUri = reusedCoverPinId ? `metafile://${reusedCoverPinId}` : null;
    if (!coverUri) {
      let image = null;
      try {
        image = await withRetry(`download ${tokenIndex}`, () => downloadPng(legacy.imgUrl));
      } catch (err) {
        items.push({ tokenIndex, itemPinId, status: 'IMAGE_FAILED', error: errorText(err) });
        budget.noteFailure();
        if (budget.circuitOpen()) {
          stopped = 'CIRCUIT_OPEN';
          break;
        }
        continue;
      }
      if (catalogEntry?.image?.sha256 && image.sha256 !== catalogEntry.image.sha256) {
        items.push({
          tokenIndex,
          itemPinId,
          status: 'IMAGE_CHANGED',
          error: `live image sha256 ${image.sha256} != catalog ${catalogEntry.image.sha256} — refusing to write`,
        });
        budget.noteFailure();
        if (budget.circuitOpen()) {
          stopped = 'CIRCUIT_OPEN';
          break;
        }
        continue;
      }
      const dup = shaIndex.get(image.sha256);
      if (dup && !args.noResume) {
        // identical bytes already on chain — adopt that pin, no second upload fee
        coverUri = `metafile://${dup.pinId}`;
        upload = { pinId: dup.pinId, metafileUri: coverUri, totalCost: 0, feeAssist: null, reused: true };
        appendCatalog(args.outDir, {
          tokenIndex,
          phase: 'preupload',
          status: 'PREUPLOADED',
          itemPinId,
          coverPinId: dup.pinId,
          coverUri,
          sats: { upload: 0 },
          dedupe: { sha256: image.sha256, reusedFromTokenIndex: dup.tokenIndex },
        });
        log(`[${tokenIndex}] cover dedupe → ${dup.pinId} (from #${dup.tokenIndex}), 0 sats`);
      } else {
        let uploadError = null;
        try {
          upload = await uploadPng(args.metabotId, { buffer: image.buffer, sha256: image.sha256 });
        } catch (err) {
          uploadError = err;
        }
        if (uploadError) {
          items.push({ tokenIndex, itemPinId, status: 'UPLOAD_FAILED', error: errorText(uploadError) });
          appendJournal(args.outDir, { tokenIndex, itemPinId, phase: 'upload_failed', error: errorText(uploadError) });
          budget.noteFailure();
          if (budget.circuitOpen()) {
            stopped = 'CIRCUIT_OPEN';
            break;
          }
          await sleep(args.delayMs);
          continue;
        }
      }
      coverUri = upload.metafileUri;
      shaIndex.set(image.sha256, { pinId: upload.pinId, tokenIndex });
      budget.spend(upload.totalCost || estUpload);
      appendCatalog(args.outDir, {
        tokenIndex,
        phase: 'preupload',
        status: 'PREUPLOADED',
        itemPinId,
        coverPinId: upload.pinId,
        coverUri,
        sats: { upload: upload.totalCost },
        sponsor: { upload: sponsorStatus(upload.feeAssist) },
      });
      appendJournal(args.outDir, {
        tokenIndex,
        itemPinId,
        phase: 'uploaded',
        coverPinId: upload.pinId,
        coverUri,
        totalCost: upload.totalCost,
        feeAssist: upload.feeAssist ?? null,
      });
      log(`[${tokenIndex}] uploaded ${upload.metafileUri} cost=${upload.totalCost} sats`);
    }

    let write = null;
    try {
      write = await writeItemDesc(args.metabotId, ctx.collectionName, [
        { pinId: itemPinId, cover: coverUri, desc: plannedDesc || '' },
      ]);
    } catch (err) {
      items.push({ tokenIndex, itemPinId, status: 'WRITE_FAILED', coverUri, upload, error: errorText(err) });
      appendJournal(args.outDir, { tokenIndex, itemPinId, phase: 'item_desc_failed', coverUri, error: errorText(err) });
      budget.noteFailure();
      if (budget.circuitOpen()) {
        stopped = 'CIRCUIT_OPEN';
        break;
      }
      await sleep(args.delayMs);
      continue;
    }
    budget.spend(write.totalCost || estItemDesc);
    appendCatalog(args.outDir, {
      tokenIndex,
      phase: 'attached',
      status: 'WRITTEN',
      itemPinId,
      coverPinId: upload?.pinId || reusedCoverPinId,
      coverUri,
      itemDescPinId: write.pinId,
      desc: plannedDesc || '',
      sats: { upload: upload?.totalCost ?? null, itemDesc: write.totalCost },
      sponsor: {
        ...(upload ? { upload: sponsorStatus(upload.feeAssist) } : {}),
        itemDesc: sponsorStatus(write.feeAssist),
      },
    });
    appendJournal(args.outDir, {
      tokenIndex,
      itemPinId,
      phase: 'written',
      coverPinId: upload?.pinId || reusedCoverPinId,
      coverUri,
      itemDescPinId: write.pinId,
      txids: write.txids,
      totalCost: write.totalCost,
      feeAssist: write.feeAssist,
    });
    log(`[${tokenIndex}] item_desc ${write.pinId} broadcast — waiting for adoption…`);

    // adoption check (read-only, retried inside)
    let verification = null;
    try {
      verification = await verifyAdoption(itemPinId, coverUri, args.waitMs);
    } catch (err) {
      verification = { adopted: false, error: errorText(err) };
    }
    const ok = verification?.adopted === true;
    if (ok) budget.noteSuccess();
    else budget.noteFailure();

    items.push({
      tokenIndex,
      itemPinId,
      status: ok ? 'WRITTEN_VERIFIED' : 'WRITTEN_UNVERIFIED',
      coverUri,
      upload: upload
        ? { pinId: upload.pinId, metafileUri: upload.metafileUri, totalCost: upload.totalCost, sponsor: sponsorStatus(upload.feeAssist) }
        : { pinId: reusedCoverPinId, metafileUri: coverUri, totalCost: 0, reused: true, sponsor: { mode: 'none', assisted: false, reason: 'reused catalog cover pin' } },
      itemDesc: {
        pinId: write.pinId,
        txids: write.txids,
        totalCost: write.totalCost,
        sponsor: sponsorStatus(write.feeAssist),
      },
      plannedDesc,
      verification,
      sats: { upload: upload?.totalCost ?? 0, itemDesc: write.totalCost ?? 0 },
      error: ok ? null : 'item_desc broadcast but the cover is not visible in BOTH indexer views yet',
    });
    if (!ok) log(`[${tokenIndex}] WRITTEN_UNVERIFIED — cover not yet visible in both indexer views`);
    if (budget.circuitOpen()) {
      stopped = 'CIRCUIT_OPEN';
      break;
    }
    await sleep(args.delayMs);
  }

  return { items, stopped, approval };
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

async function runAudit({ ctx, catalog }) {
  const minted = [...ctx.byToken.values()].map((entry) => entry.item).filter(Boolean);
  const live = minted.filter((item) => item.burned !== true);
  const missing = live.filter((item) => !String(item.cover || '').trim());
  const catalogued = [];
  const orphaned = [];
  for (const [tokenIndex, entry] of catalog.entries()) {
    const resolved = ctx.byToken.get(tokenIndex);
    if (resolved?.item) catalogued.push({ tokenIndex, itemPinId: resolved.item.itemPinId, cover: resolved.item.cover || '', hasUpload: Boolean(entry.coverPinId) });
    else orphaned.push({ tokenIndex, hasUpload: Boolean(entry.coverPinId), imgUrl: entry.legacy?.imgUrl || null });
  }
  return {
    summary: {
      minted: live.length,
      coverMissing: missing.length,
      catalogRows: catalog.size,
      cataloguedMinted: catalogued.length,
      orphanedCatalogRows: orphaned.length,
    },
    missing: missing.map((item) => ({
      itemPinId: item.itemPinId || null,
      name: item.name || null,
      ownerAddress: item.ownerAddress || null,
      tokenIndex: tokenIndexOfItem(item)?.tokenIndex ?? null,
    })),
    orphaned,
    chainWrites: 0,
  };
}

// ---------------------------------------------------------------------------
// budget / circuit breaker
// ---------------------------------------------------------------------------

function makeBudget({ maxSats, feeRate, maxConsecutiveFailures }) {
  let spent = 0;
  let consecutiveFailures = 0;
  return {
    maxSats: maxSats ?? null,
    feeRate,
    spend(sats) {
      spent += Number(sats || 0);
    },
    wouldExceed(estimate) {
      if (!Number.isFinite(maxSats) || maxSats <= 0) return false;
      return spent + Number(estimate || 0) > maxSats;
    },
    noteFailure() {
      consecutiveFailures++;
    },
    noteSuccess() {
      consecutiveFailures = 0;
    },
    circuitOpen() {
      return consecutiveFailures >= maxConsecutiveFailures;
    },
    snapshot() {
      return {
        maxSats: Number.isFinite(maxSats) ? maxSats : null,
        spentSats: spent,
        remainingSats: Number.isFinite(maxSats) ? Math.max(0, maxSats - spent) : null,
        consecutiveFailures,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  // --- gates BEFORE any read/write -------------------------------------
  let approval = null;
  const chainWriteMode = args.write && (args.mode === 'attach' || args.mode === 'preupload');
  if (chainWriteMode) approval = requireApproval(args);
  const budget = makeBudget({
    maxSats: args.maxSats,
    feeRate: args.feeRate,
    maxConsecutiveFailures: args.maxConsecutiveFailures,
  });

  const preflightResult = await preflight({ ...args, write: chainWriteMode });
  log(
    `[preflight] collection ${preflightResult.collection.name} createAddress=${preflightResult.collection.createAddress} `
      + `issuerGate=${preflightResult.issuer.isIssuer ? 'PASS' : 'FAIL'}`,
  );
  if (chainWriteMode && !preflightResult.issuer.isIssuer) {
    throw new Error('NOT_ISSUER_IDENTITY: write refused (issuer gate FAIL)');
  }

  // --- legacy source (needed by snapshot + attach) ----------------------
  let vaultRows = [];
  let vaultError = null;
  try {
    vaultRows = await withRetry('vault holdings', () => fetchVaultHoldings(args.vaultAddress));
    log(`[vault] ${vaultRows.length} legacy NFT row(s) in ${args.vaultAddress}`);
  } catch (error) {
    vaultError = errorText(error);
    log(`[vault] WARN: ${vaultError} (catalog-only mode)`);
  }

  let ctx = {
    ...args,
    ...preflightResult,
    collectionName: preflightResult.collection.name,
    vaultByToken: new Map(vaultRows.filter((r) => r.tokenIndex > 0).map((r) => [r.tokenIndex, r])),
    vaultError,
    byToken: new Map(),
    journal: readJournal(args.outDir),
    outDir: args.outDir,
    waitMs: args.waitMs,
  };

  // --- collection index (attach/audit only) -----------------------------
  if (args.mode === 'attach' || args.mode === 'audit') {
    if (args.itemPin && args.mode === 'attach') {
      log('[index] skipped (--item-pin supplied)');
    } else {
      const items = await loadCollectionItems(args);
      const { byToken, duplicates, unmapped } = indexItemsByToken(items);
      ctx = { ...ctx, byToken, duplicates, unmapped };
      log(`[index] ${items.length} minted item(s), ${byToken.size} tokenIndex mapping(s)`);
    }
  }

  // --- snapshot needs no collection index -------------------------------
  if (args.mode === 'snapshot' || args.mode === 'preupload') {
    if (args.all) log('[scope] --all');
  }

  let result;
  if (args.mode === 'snapshot') {
    result = await runSnapshot({ args, tokens: args.tokens, vaultRows, vaultByToken: ctx.vaultByToken, vaultError });
  } else if (args.mode === 'preupload') {
    result = await runPreupload({ args, tokens: args.tokens, ctx, approval, budget });
  } else if (args.mode === 'audit') {
    const catalog = readCatalog(args.outDir);
    result = await runAudit({ ctx, catalog });
  } else {
    // attach: batch scheduling knobs
    let tokens = args.tokens;
    if (args.all) {
      const all = [...ctx.byToken.entries()]
        .filter(([, r]) => r.item && r.item.burned !== true && !String(r.item.cover || '').trim())
        .map(([n]) => n)
        .sort((a, b) => a - b);
      tokens = all;
    }
    if (args.limit != null) tokens = tokens.slice(0, args.limit);
    result = await runAttach({ args, tokens, ctx, approval, budget });
  }

  const items = result.items || [];
  const written = items.filter((i) => i.status === 'WRITTEN_VERIFIED').length;
  const unverified = items.filter((i) => i.status === 'WRITTEN_UNVERIFIED').length;
  const failed = items.filter((i) => FAILED_STATES.has(i.status)).length;
  const skipped = items.filter((i) => String(i.status).startsWith('SKIP_')).length;
  const notMinted = items.filter((i) => i.status === 'NOT_MINTED').length;
  const spentSats = items.reduce((sum, i) => sum + Number(i.sats?.upload || 0) + Number(i.sats?.itemDesc || 0), 0);

  const stateFile = path.join(args.outDir, 'batch-state.json');
  const state = {
    pipeline: PIPELINE,
    lastRunAt: new Date().toISOString(),
    mode: args.mode,
    dryRun: !args.write,
    approval: approval ? { id: approval.id, maxSats: approval.maxSats } : null,
    budget: budget.snapshot(),
    summary: { items: items.length, written, unverified, failed, skipped, spentSats },
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

  const payload = {
    ok: failed === 0 && unverified === 0 && !result.stopped,
    pipeline: PIPELINE,
    mode: args.mode,
    dryRun: !args.write,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    collection: preflightResult.collection,
    issuer: preflightResult.issuer,
    gates: {
      issuer: preflightResult.issuer.isIssuer,
      approval: approval ? { id: approval.id, maxSats: approval.maxSats } : null,
      budget: budget.snapshot(),
    },
    summary: {
      ...result.summary,
      items: items.length,
      written,
      unverified,
      failed,
      skipped,
      notMinted,
      spentSats: args.write ? spentSats : 0,
    },
    stopped: result.stopped || null,
    items,
    artifacts: {
      outDir: args.outDir,
      catalog: catalogPath(args.outDir),
      journal: journalPath(args.outDir),
      batchState: stateFile,
      approvals: approval ? args.approvalFile : null,
    },
  };

  const artifactBase = path.join(args.outDir, `attach-${args.mode}-${args.write ? 'write' : 'dry-run'}-${nowStamp()}`);
  fs.writeFileSync(`${artifactBase}.json`, JSON.stringify(payload, null, 2) + '\n');
  payload.artifacts.runJson = `${artifactBase}.json`;

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  log(`[done] mode=${args.mode} write=${args.write} ${JSON.stringify(payload.summary)}`);

  if (!payload.ok) process.exitCode = 1;
  if (result.stopped === 'BUDGET_STOP' || result.stopped === 'CIRCUIT_OPEN') process.exitCode = 2;
}

// Exported for the mint-and-send hook: one line, in-process.
export async function attachCoverForToken(options) {
  const { tokenIndex, itemPinId, metabotId, write = false, maxSats, approvalId, approvalFile, outDir } = options || {};
  if (!Number.isInteger(tokenIndex) || tokenIndex <= 0) throw new Error('attachCoverForToken: tokenIndex required');
  const argv = ['--attach', '--token', String(tokenIndex)];
  if (itemPinId) argv.push('--item-pin', itemPinId);
  if (metabotId) argv.push('--metabot-id', String(metabotId));
  if (outDir) argv.push('--out-dir', outDir);
  if (write) argv.push('--write', '--max-sats', String(maxSats), '--approval-id', String(approvalId));
  if (approvalFile) argv.push('--approval-file', approvalFile);
  const parsed = parseArgs(argv);
  // Reuse the exact CLI path (one implementation, identical gates).
  const { spawnSync } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const res = spawnSync(process.execPath, [self, ...argv], { encoding: 'utf8', cwd: options.cwd || process.cwd() });
  if (res.status !== 0 && !res.stdout) throw new Error(res.stderr || `attach-cover exited ${res.status}`);
  const payload = JSON.parse(res.stdout);
  return { exitCode: res.status, receipt: payload.items?.[0] || null, payload, args: parsed };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    const refusal = /^(APPROVAL_|NOT_ISSUER|IDENTITY_CHECK|--|unknown argument)/.test(errorText(error));
    process.stdout.write(JSON.stringify({ ok: false, pipeline: PIPELINE, error: errorText(error) }, null, 2) + '\n');
    if (refusal) process.exitCode = 2;
    else process.exitCode = 1;
  });
}
