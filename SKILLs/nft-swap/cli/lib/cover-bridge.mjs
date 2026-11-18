/**
 * Cover bridge — produces the mint-time cover for the swap engine
 * (2026-11-19 cover-loss fix, root-cause report §4.2 steps 2+3).
 *
 * Contract with swap-engine.mjs `deps.resolveCover`:
 *   resolveCover({ row, live, broadcast, album }) →
 *     { ok: true,  cover: 'metafile://<pin>', source, image?, ... }
 *     { ok: false, code, message }   code ∈ COVER_UNAVAILABLE | COVER_FETCH_FAILED | COVER_UPLOAD_FAILED
 *
 *   COVER_UNAVAILABLE   permanent — no legacy image can be produced (no
 *                       imgUrl / window closed). The engine rejects the row
 *                       (owner-approved refund path) and never mints.
 *   COVER_FETCH_FAILED  transient (network/PNG gate) — engine refuses the
 *                       mint but leaves the row claimed: retry later.
 *   COVER_UPLOAD_FAILED transient (host RPC) — same retryable semantics.
 *
 * Reuse ladder (identical bytes never pay a second upload fee):
 *   1. swap-mint journal (writes.jsonl) by image sha256 — a crash between
 *      upload and the mint broadcast re-runs into the already-uploaded pin;
 *   2. attach-cover catalog (cover-catalog.jsonl) by image sha256 — an
 *      earlier snapshot/--preupload run already uploaded this artwork;
 *   3. downloadPng (https + PNG magic + IHDR + 8 MiB gate, sha256) from the
 *      vault row's `imgUrl`, upload ONCE (broadcast only), journal the pin.
 *
 * Reads (holdings lookup, download, catalog/journal scan) also happen in
 * dry-run; the upload happens only when broadcast=true. Nothing here touches
 * the issuer mnemonic — uploads go through the host RPC like every other
 * cover write (docs/cover-pipeline-v1.md).
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_VAULT_ADDRESS,
  defaultCatalogFile,
  downloadPng,
  errorText,
  fetchVaultHoldings,
  journalPath,
  uploadPng,
} from './cover-core.mjs';

export const SWAP_COVER_PIPELINE = 'swap-mint-cover/v1';
export const SWAP_COVER_OUT_DEFAULT = path.resolve(process.cwd(), 'out', 'swap-mint-cover');

/**
 * sha256 → { pinId, tokenIndex, from } index over the swap-mint journal.
 * Read raw (NOT via cover-core readJournal): swap-mint entries intentionally
 * carry no itemPinId (the item does not exist yet at cover resolution time),
 * and readJournal skips entries without one.
 */
export function shaIndexFromJournal(outDir) {
  const index = new Map();
  const file = journalPath(outDir);
  if (!fs.existsSync(file)) return index;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry = null;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry?.pipeline !== SWAP_COVER_PIPELINE) continue;
    const sha = entry?.sha256;
    const pin = entry?.coverPinId;
    if (sha && pin && !index.has(sha)) index.set(sha, { pinId: pin, tokenIndex: entry.tokenIndex ?? null, from: 'journal' });
  }
  return index;
}

/**
 * sha256 → { pinId, tokenIndex, from } index over the attach-cover catalog.
 * Catalog lines accumulate per tokenIndex (snapshot → preupload → attached),
 * so lines are merged by tokenIndex FIRST (a snapshot line carries
 * image.sha256, a later line carries coverPinId), then indexed by sha.
 */
export function shaIndexFromCatalog(catalogFile) {
  const index = new Map();
  if (!catalogFile || !fs.existsSync(catalogFile)) return index;
  const byToken = new Map();
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
    if (!Number.isInteger(tokenIndex) || tokenIndex <= 0) continue;
    const current = byToken.get(tokenIndex) || {};
    byToken.set(tokenIndex, {
      ...current,
      ...entry,
      coverPinId: entry.coverPinId || current.coverPinId || null,
      image: entry.image || current.image || null,
    });
  }
  for (const [tokenIndex, entry] of byToken) {
    const sha = entry?.image?.sha256;
    const pin = entry?.coverPinId;
    if (sha && pin && !index.has(sha)) index.set(sha, { pinId: pin, tokenIndex, from: 'catalog' });
  }
  return index;
}

/**
 * Build the resolver the engine consumes as `deps.resolveCover`.
 * Every I/O edge is injectable so dry-run tests stay hermetic.
 *
 * @param {object} [args]
 * @param {string} [args.vaultAddress]   vault to resolve token rows from (default: ratified)
 * @param {number|(() => number)} [args.metabotId]  uploader bot id (lazy ok; upload only)
 * @param {string} [args.catalogFile]    attach-cover catalog (default: out/attach-cover/cover-catalog.jsonl)
 * @param {string} [args.outDir]         swap-mint cover out dir (default: out/swap-mint-cover)
 * @param {(...args: any[]) => any} [args.holdings]  injectable fetchVaultHoldings
 * @param {(...args: any[]) => any} [args.download]  injectable downloadPng
 * @param {(...args: any[]) => any} [args.upload]    injectable uploadPng
 */
export function createCoverResolver({
  vaultAddress = DEFAULT_VAULT_ADDRESS,
  metabotId = null,
  catalogFile = defaultCatalogFile(),
  outDir = SWAP_COVER_OUT_DEFAULT,
  holdings = fetchVaultHoldings,
  download = downloadPng,
  upload = uploadPng,
} = {}) {
  const metabotIdOf = typeof metabotId === 'function' ? metabotId : () => metabotId;
  return async function resolveCover({ row, live = null, broadcast = false } = {}) {
    const tokenIndex = Number(row?.token_index);
    if (!Number.isInteger(tokenIndex) || tokenIndex <= 0) {
      return { ok: false, code: 'COVER_UNAVAILABLE', message: `resolver needs row.token_index, got: ${row?.token_index}` };
    }

    // 1. The vault row carries imgUrl — the only pre-burn image source.
    //    `live` (the engine's own v4 read, post step-1 fix) is reused when
    //    handed over; otherwise resolve from a fresh holdings read.
    let legacy = live
      ? { tokenIndex, name: String(live.name || ''), imgUrl: String(live.imgUrl ?? live.imageUrl ?? '') }
      : null;
    if (!legacy) {
      let rows;
      try {
        rows = await holdings(vaultAddress);
      } catch (error) {
        return { ok: false, code: 'COVER_FETCH_FAILED', message: `vault holdings read failed: ${errorText(error)}`, tokenIndex };
      }
      legacy = rows.find((r) => Number(r.tokenIndex) === tokenIndex) ?? null;
    }
    const imgUrl = String(legacy?.imgUrl || '');
    if (!imgUrl) {
      return {
        ok: false,
        code: 'COVER_UNAVAILABLE',
        message: `no imgUrl for tokenIndex ${tokenIndex} in vault ${vaultAddress} — the legacy image source is gone (the window closes the moment the old token leaves the vault)`,
        tokenIndex,
      };
    }

    // 2. Download + validate (PNG magic / IHDR / 8 MiB gate) + sha256.
    let image;
    try {
      image = await download(imgUrl);
    } catch (error) {
      return { ok: false, code: 'COVER_FETCH_FAILED', message: `legacy image download/validation failed: ${errorText(error)}`, tokenIndex, sourceUrl: imgUrl };
    }
    const imageEvidence = { sha256: image.sha256, bytes: image.bytes, width: image.width, height: image.height, sourceUrl: imgUrl };

    // 3. Content-addressed reuse — never pay a second upload for identical bytes.
    const reused = shaIndexFromJournal(outDir).get(image.sha256) ?? shaIndexFromCatalog(catalogFile).get(image.sha256) ?? null;
    if (reused) {
      return {
        ok: true,
        cover: `metafile://${reused.pinId}`,
        source: `reuse:${reused.from}`,
        image: imageEvidence,
        reused: { sha256: image.sha256, pinId: reused.pinId, from: reused.from, tokenIndex: reused.tokenIndex },
      };
    }

    // 4. Dry-run: validate and report only — never upload, never pay.
    if (!broadcast) {
      return {
        ok: true,
        cover: null,
        source: 'would-upload',
        image: imageEvidence,
        planOnly: true,
        message: 'dry-run: legacy image validated, upload deferred to --broadcast',
      };
    }

    // 5. Broadcast: upload once, journal the pin (crash between here and the
    //    mint broadcast re-runs into step 3 via the journal).
    const uploaderId = metabotIdOf();
    if (!Number.isInteger(uploaderId) || uploaderId <= 0) {
      return { ok: false, code: 'COVER_UPLOAD_FAILED', message: 'metabotId missing — pass --metabot-id', tokenIndex };
    }
    let uploaded;
    try {
      uploaded = await upload(uploaderId, image);
    } catch (error) {
      return { ok: false, code: 'COVER_UPLOAD_FAILED', message: `cover upload failed: ${errorText(error)}`, tokenIndex, sourceUrl: imgUrl };
    }
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.appendFileSync(
        journalPath(outDir),
        `${JSON.stringify({
          at: new Date().toISOString(),
          pipeline: SWAP_COVER_PIPELINE,
          tokenIndex,
          phase: 'uploaded',
          sha256: image.sha256,
          bytes: image.bytes,
          sourceUrl: imgUrl,
          coverPinId: uploaded.pinId,
          coverUri: uploaded.metafileUri,
          totalCost: uploaded.totalCost,
          feeAssist: uploaded.feeAssist ?? null,
        })}\n`,
      );
    } catch {
      // journal is best-effort; the pinId still travels in the resolver
      // receipt and lands in the ledger dual_check with the mint broadcast
    }
    return {
      ok: true,
      cover: uploaded.metafileUri,
      source: 'upload',
      image: imageEvidence,
      upload: { pinId: uploaded.pinId, totalCost: uploaded.totalCost, feeAssist: uploaded.feeAssist ?? null },
    };
  };
}
