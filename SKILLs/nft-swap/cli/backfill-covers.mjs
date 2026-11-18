#!/usr/bin/env node
/**
 * backfill-covers.mjs — idempotent cover/desc repair for ALREADY-MINTED
 * MRC-721 items of the metabot-avatar swap collection.
 *
 * This CLI is the REPAIR surface. The pipeline stage itself lives in
 * cli/attach-cover.mjs; both sit on the same engine (cli/lib/cover-core.mjs) —
 * there is exactly one implementation of "resolve legacy artwork → upload →
 * issuer item_desc", never two.
 *
 * Dry-run is the DEFAULT: no upload, no chain write, no fee. `--dry-run` is
 * accepted explicitly for clarity. A real backfill also requires explicit
 * owner approval per the pilot rules; the flag alone is not that approval.
 *
 * Safety: never touches a mnemonic; signing happens inside the host. Refuses
 * to write unless the RPC identity's mvc_address equals the ratified issuer
 * address AND the collection's createAddress is that same address — the
 * indexer's issuer gate silently drops any other signer's item_desc.
 *
 * Usage:
 *   node cli/backfill-covers.mjs --tokens 2671,1310,5366 [--dry-run]
 *   node cli/backfill-covers.mjs --tokens 2671,5366 --probe-image
 *   node cli/backfill-covers.mjs --scan
 *   node cli/backfill-covers.mjs --tokens 2671 --write        # owner approval required
 *
 * Output: one JSON object on stdout; human-readable progress on stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_VAULT_ADDRESS,
  journalPath,
  log,
  nowStamp,
  errorText,
  readAllCollectionItems,
  fetchVaultHoldings,
  buildContext,
  preflight,
  planToken,
  writeOne,
  tokenIndexOfItem,
  downloadPng,
  defaultCatalogFile,
  readCoverCatalogLegacy,
} from './lib/cover-core.mjs';

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    tokens: [],
    scan: false,
    dryRun: false,
    write: false,
    probeImage: false,
    rehearseMissing: false,
    ignoreJournal: false,
    feeRate: 1,
    waitMs: 120_000,
    outDir: path.resolve('out', 'backfill-covers'),
    vaultAddress: DEFAULT_VAULT_ADDRESS,
    collectionId: DEFAULT_COLLECTION_ID,
    metabotId: Number(process.env.IDBOTS_METABOT_ID || 0) || null,
    catalogFile: defaultCatalogFile(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--tokens') {
      for (const part of next().split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(trimmed)) throw new Error(`invalid tokenIndex "${trimmed}" in --tokens`);
        args.tokens.push(Number(trimmed));
      }
    } else if (arg === '--scan') args.scan = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--probe-image') args.probeImage = true;
    else if (arg === '--rehearse-missing') args.rehearseMissing = true;
    else if (arg === '--ignore-journal') args.ignoreJournal = true;
    else if (arg === '--fee-rate') args.feeRate = Number(next());
    else if (arg === '--wait-ms') args.waitMs = Number(next());
    else if (arg === '--out-dir') args.outDir = path.resolve(next());
    else if (arg === '--vault-address') args.vaultAddress = next().trim();
    else if (arg === '--collection-id') args.collectionId = next().trim();
    else if (arg === '--metabot-id') args.metabotId = Number(next());
    else if (arg === '--catalog-file') args.catalogFile = path.resolve(next());
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`backfill-covers.mjs — idempotent cover/desc backfill for minted metabot-avatar items

  --tokens 2671,1310,5366   tokenIndex list to backfill (required unless --scan)
  --scan                    scan the whole collection; write the missing-cover roster
  --dry-run                 plan only (DEFAULT; kept explicit for clarity)
  --write                   upload + broadcast item_desc pins (owner approval required)
  --probe-image             dry-run: also download/hash the legacy image for covered items
  --rehearse-missing        dry-run only: plan the write as if the cover were missing
                            (a what-if preview for an item that already has a cover)
  --wait-ms N               adoption poll budget in write mode (default 120000)
  --fee-rate N              fee rate for the DRY-RUN estimate only (default 1 sat/vB)
  --out-dir DIR             artifact directory (default ./out/backfill-covers)
  --vault-address ADDR      vault holdings address (default ${DEFAULT_VAULT_ADDRESS})
  --collection-id PIN       collectionid (default ${DEFAULT_COLLECTION_ID})
  --metabot-id N            signing MetaBot id (default env IDBOTS_METABOT_ID)
  --catalog-file FILE       cover catalog (default ./out/attach-cover/cover-catalog.jsonl)
  --ignore-journal          ignore the local write journal (recovery only)
`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.dryRun && args.write) throw new Error('--dry-run and --write are mutually exclusive');
  if (args.rehearseMissing && args.write) throw new Error('--rehearse-missing is a dry-run preview and cannot be combined with --write');
  if (args.scan && args.write) throw new Error('--scan produces a roster only and cannot be combined with --write');
  if (args.scan && args.tokens.length) throw new Error('--scan scans the whole collection; do not pass --tokens');
  if (!args.scan && args.tokens.length === 0) throw new Error('--tokens is required unless --scan is used');
  if (!Number.isFinite(args.feeRate) || args.feeRate <= 0) throw new Error('--fee-rate must be positive');
  if (!Number.isFinite(args.waitMs) || args.waitMs < 0) throw new Error('--wait-ms must be >= 0');
  if (!Number.isInteger(args.metabotId) || args.metabotId <= 0) {
    throw new Error('--metabot-id (or IDBOTS_METABOT_ID) must be a positive integer');
  }
  args.tokens = [...new Set(args.tokens)];
  args.mode = args.scan ? 'scan' : args.write ? 'write' : 'dry-run';
  return args;
}

// ---------------------------------------------------------------------------
// Scan roster
// ---------------------------------------------------------------------------

function renderPendingMarkdown({ generatedAt, collection, vaultAddress, scanned, missing, unverifiedHolding, unmapped }) {
  const lines = [
    '# MetaBot Avatar — cover-missing roster',
    '',
    `- Generated: ${generatedAt}`,
    `- Collection: ${collection.name} (${collection.pinId})`,
    `- Issuer / createAddress: ${collection.createAddress}`,
    `- Vault: ${vaultAddress}`,
    `- Items scanned: ${scanned}`,
    `- Cover empty & still held: ${missing.length}`,
    '',
    '| # | tokenIndex | pinId | name | current cover | ownerAddress |',
    '|---|---|---|---|---|---|',
  ];
  missing.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.tokenIndex ?? '(unresolved)'} | ${row.itemPinId || ''} | `
        + `${String(row.name || '').replace(/\|/g, '\\|')} | \`${row.cover || ''}\` | ${row.ownerAddress || ''} |`,
    );
  });
  if (!missing.length) {
    lines.push('', '_No missing-cover held items. Nothing to backfill as of this scan._');
  }
  if (unverifiedHolding.length) {
    lines.push('', '## Cover empty but holding could not be confirmed (not auto-backfilled)', '');
    for (const row of unverifiedHolding) {
      lines.push(`- tokenIndex ${row.tokenIndex ?? '(unresolved)'} — ${row.itemPinId || '(no pinId)'} — ${row.name || '(no name)'}`);
    }
  }
  if (unmapped.length) {
    lines.push('', '## Items with no resolvable tokenIndex (needs manual mapping)', '');
    for (const row of unmapped) lines.push(`- ${row.itemPinId || '(no pinId)'} — ${row.name || '(no name)'}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function runScan({ args, ctx, preflightResult }) {
  const items = ctx.allItems;
  const coverEmpty = items.filter((item) => item && item.burned !== true && !String(item.cover || '').trim());
  const toRow = (item) => {
    const resolved = tokenIndexOfItem(item);
    return {
      tokenIndex: resolved?.tokenIndex ?? null,
      tokenIndexSource: resolved?.source ?? null,
      itemPinId: item.itemPinId || null,
      name: item.name || null,
      cover: item.cover || '',
      desc: item.desc || '',
      ownerAddress: item.ownerAddress || null,
      burned: item.burned === true,
    };
  };
  const byTokenAsc = (a, b) => (a.tokenIndex ?? Number.MAX_SAFE_INTEGER) - (b.tokenIndex ?? Number.MAX_SAFE_INTEGER);
  const missing = coverEmpty
    .filter((item) => String(item.ownerAddress || '').trim())
    .map(toRow)
    .sort(byTokenAsc);
  const unverifiedHolding = coverEmpty
    .filter((item) => !String(item.ownerAddress || '').trim())
    .map(toRow)
    .sort(byTokenAsc);

  const generatedAt = new Date().toISOString();
  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, 'pending-covers.json');
  const mdPath = path.join(args.outDir, 'pending-covers.md');
  const payload = {
    generatedAt,
    collection: preflightResult.collection,
    vaultAddress: args.vaultAddress,
    scanned: items.length,
    missing,
    unverifiedHolding,
    unmapped: ctx.unmapped,
    duplicates: ctx.duplicates,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(
    mdPath,
    renderPendingMarkdown({
      generatedAt,
      collection: preflightResult.collection,
      vaultAddress: args.vaultAddress,
      scanned: items.length,
      missing,
      unverifiedHolding,
      unmapped: ctx.unmapped,
    }),
  );
  log(`[scan] ${items.length} item(s) scanned; ${missing.length} cover-missing & held`);
  log(`[scan] roster: ${mdPath}`);
  return {
    ok: true,
    mode: 'scan',
    generatedAt,
    collection: preflightResult.collection,
    issuer: preflightResult.issuer,
    vaultAddress: args.vaultAddress,
    scanned: items.length,
    missingCount: missing.length,
    missing,
    unverifiedHolding,
    unmapped: ctx.unmapped,
    duplicates: ctx.duplicates,
    artifacts: { pendingJson: jsonPath, pendingMd: mdPath, journal: journalPath(args.outDir) },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  const preflightResult = await preflight(args);
  log(
    `[preflight] collection ${preflightResult.collection.name} (${preflightResult.collection.pinId}) `
      + `createAddress=${preflightResult.collection.createAddress}`,
  );
  log(
    `[preflight] identity metabot#${args.metabotId} mvc=${preflightResult.issuer.mvcAddress || '(unavailable)'} `
      + `issuerGate=${preflightResult.issuer.mvcAddress === preflightResult.issuer.ratifiedAddress ? 'PASS' : 'FAIL'}`,
  );

  const items = await readAllCollectionItems(args.collectionId);
  log(`[index] ${items.length} minted item(s), ${new Set(items.map((item) => tokenIndexOfItem(item)?.tokenIndex).filter(Boolean)).size} tokenIndex mapping(s)`);

  let vaultRows = [];
  let vaultError = null;
  try {
    vaultRows = await fetchVaultHoldings(args.vaultAddress);
    log(`[vault] ${vaultRows.length} legacy NFT row(s) in ${args.vaultAddress}`);
  } catch (error) {
    vaultError = errorText(error);
    log(`[vault] ERROR: ${vaultError}`);
  }

  // Artwork that survives a burn lives only in the cover catalog; use it when
  // the vault no longer holds the legacy token.
  const catalogLegacy = readCoverCatalogLegacy(args.catalogFile);
  let catalogMerged = 0;
  for (const [tokenIndex, row] of catalogLegacy) {
    if (!vaultRows.some((existing) => existing.tokenIndex === tokenIndex)) {
      vaultRows.push(row);
      catalogMerged++;
    }
  }
  if (catalogMerged) log(`[catalog] +${catalogMerged} legacy row(s) recovered from ${args.catalogFile}`);

  const ctx = buildContext({ args, preflightResult, items, vaultRows });
  if (ctx.duplicates.length) {
    log(`[index] WARNING: ${ctx.duplicates.length} duplicate tokenIndex mapping(s): ${JSON.stringify(ctx.duplicates)}`);
  }

  if (args.scan) {
    const result = await runScan({ args, ctx, preflightResult });
    result.vaultError = vaultError;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const plans = [];
  for (const tokenIndex of args.tokens) {
    const resolved = ctx.byToken.get(tokenIndex);
    if (!resolved) {
      log(`[${tokenIndex}] NOT_MINTED — no collection item maps to this tokenIndex`);
      plans.push({
        tokenIndex,
        status: 'NOT_MINTED',
        itemPinId: null,
        name: null,
        cover: '',
        desc: '',
        ownerAddress: null,
        burned: false,
      });
      continue;
    }
    const duplicate = ctx.duplicates.find((entry) => entry.tokenIndex === tokenIndex);
    if (duplicate) {
      log(`[${tokenIndex}] AMBIGUOUS_TOKEN — ${duplicate.pins.join(', ')}`);
      plans.push({
        tokenIndex,
        status: 'AMBIGUOUS_TOKEN',
        itemPinId: null,
        error: `multiple items map to tokenIndex ${tokenIndex}: ${duplicate.pins.join(', ')}`,
        pins: duplicate.pins,
      });
      continue;
    }
    const plan = await planToken({ tokenIndex, item: resolved.item, resolvedBy: resolved.source, ctx });
    if (plan.status === 'READY') {
      log(
        `[${tokenIndex}] READY — ${plan.itemPinId} ${plan.name || ''} `
          + `(${plan.image.bytes} B PNG ${plan.image.width}x${plan.image.height}, sha256 ${plan.image.sha256.slice(0, 16)}…) `
          + `fields=${plan.plannedFields.join('+')} est=${plan.estimateSats} sats`,
      );
    } else if (plan.probe?.ok) {
      log(`[${tokenIndex}] ${plan.status} (probe: ${plan.probe.bytes} B PNG ${plan.probe.width}x${plan.probe.height}, sha256 ${plan.probe.sha256.slice(0, 16)}…)`);
    } else if (plan.status === 'SKIP_HAS_COVER_AND_DESC') {
      log(`[${tokenIndex}] SKIP_HAS_COVER_AND_DESC — cover + desc already set (idempotent skip)`);
    } else if (plan.status === 'SKIP_JOURNAL_PENDING') {
      log(`[${tokenIndex}] SKIP_JOURNAL_PENDING — item_desc ${plan.journal?.itemDescPinId} already broadcast`);
    } else {
      log(`[${tokenIndex}] ${plan.status}${plan.error ? ` — ${plan.error}` : ''}`);
    }
    plans.push(plan);
  }

  let results = plans;
  if (args.write) {
    results = [];
    for (const plan of plans) {
      if (plan.status !== 'READY') {
        results.push(plan);
        continue;
      }
      const withBuffer = { ...plan };
      if (plan.reusedCoverPinId) {
        // A previous run already uploaded the cover but did not finish the
        // item_desc write — reuse that metafile pin, no second upload fee.
        withBuffer.image = plan.image;
      } else {
        // Re-download right before the write so the uploaded bytes are the
        // bytes we hashed (and the image is never carried in serialized state).
        let image;
        try {
          image = await downloadPng(plan.image.sourceUrl);
        } catch (error) {
          results.push({ ...plan, status: 'IMAGE_FAILED', error: errorText(error) });
          continue;
        }
        if (image.sha256 !== plan.image.sha256) {
          results.push({
            ...plan,
            status: 'IMAGE_CHANGED',
            error: `sha256 changed between plan (${plan.image.sha256}) and write (${image.sha256}) — refusing to write`,
          });
          continue;
        }
        withBuffer.image = { ...plan.image, bufferSafe: image.buffer };
      }
      const written = await writeOne({ plan: withBuffer, ctx });
      const serialized = { ...written, image: { ...written.image } };
      delete serialized.image.bufferSafe;
      results.push(serialized);
    }
  }

  // Serialize defensively: never leak a Buffer into the JSON.
  const safeResults = results.map((entry) => {
    const copy = { ...entry };
    if (copy.image && copy.image.bufferSafe) {
      const { bufferSafe, ...image } = copy.image;
      copy.image = image;
    }
    if (copy.image && Buffer.isBuffer(copy.image.buffer)) {
      const { buffer, ...image } = copy.image;
      copy.image = image;
    }
    return copy;
  });

  const plannedReady = plans.filter((entry) => entry.status === 'READY');
  const written = safeResults.filter((entry) => entry.status === 'WRITTEN_VERIFIED');
  const unverified = safeResults.filter((entry) => entry.status === 'WRITTEN_UNVERIFIED');
  const failed = safeResults.filter((entry) =>
    ['UPLOAD_FAILED', 'WRITE_FAILED', 'IMAGE_FAILED', 'IMAGE_CHANGED', 'NO_LEGACY_IMAGE', 'AMBIGUOUS_TOKEN']
      .includes(entry.status),
  );
  const estimatedSats = plannedReady.reduce((sum, entry) => sum + (entry.estimateSats || 0), 0);
  const spentSats = safeResults.reduce((sum, entry) => sum + Number(entry.totalCost || 0), 0);

  const summary = {
    requested: args.tokens.length,
    ready: plannedReady.length,
    written: written.length,
    writtenUnverified: unverified.length,
    failed: failed.length,
    skipped: safeResults.filter((entry) => String(entry.status).startsWith('SKIP_')).length,
    notMinted: safeResults.filter((entry) => entry.status === 'NOT_MINTED').length,
    estimatedSats: args.write ? null : estimatedSats,
    spentSats: args.write ? spentSats : 0,
    writesPlanned: args.write ? null : plannedReady.length,
  };

  const mode = args.write ? 'write' : 'dry-run';
  const generatedAt = new Date().toISOString();
  const artifactBase = path.join(args.outDir, `backfill-${mode}-${nowStamp()}`);
  const result = {
    ok: failed.length === 0 && unverified.length === 0,
    mode,
    generatedAt,
    collection: preflightResult.collection,
    issuer: preflightResult.issuer,
    vaultAddress: args.vaultAddress,
    vaultRows: vaultRows.length,
    vaultError,
    dryRun: !args.write,
    chainWrites: args.write ? safeResults.filter((entry) => entry.itemDescPinId).length : 0,
    tokens: safeResults,
    summary,
    artifacts: {
      outDir: args.outDir,
      runJson: `${artifactBase}.json`,
      journal: journalPath(args.outDir),
    },
  };

  fs.writeFileSync(`${artifactBase}.json`, JSON.stringify(result, null, 2) + '\n');
  log(`[done] mode=${mode} ${JSON.stringify(summary)}`);
  log(`[done] artifact: ${artifactBase}.json`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (args.write && (failed.length || unverified.length)) process.exitCode = 1;
  if (!args.write && failed.length) process.exitCode = 1;
}

main().catch((error) => {
  const payload = { ok: false, error: errorText(error) };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(1);
});
