#!/usr/bin/env node
/**
 * Cover-gate self-test (2026-11-19 cover-loss fix, root-cause report §4.2).
 *
 * FULLY OFF-CHAIN: every I/O edge is injected (no network, no host adapter,
 * no wallet, no mnemonic); the ledger is a throwaway sqlite in a temp dir.
 *
 * Covers:
 *  1. vault-poll-lib row mapper keeps name/imgUrl on BOTH wire shapes
 *     (real v4 camelCase + lower-case alias fixture) and still dedupes;
 *  2. mintAndSend「缺图不铸」: broadcast aborts on COVER_UNAVAILABLE and the
 *     row lands in `rejected` (owner-approved refund path open); transient
 *     failures keep it claimed (retryable); a resolved cover mints and is
 *     persisted in the display; explicit --cover still wins; dry-runs only
 *     plan (coverStatus in the payload, no state change);
 *  3. item_desc resume guard: a cover-less recorded display is rebuilt with
 *     a resolved cover instead of being rewritten cover-less; without any
 *     cover producer the write is refused (row stays mint_pending);
 *  4. burn gate: cover-less candidates are ineligible and a broadcast refuses
 *     the whole batch with the roster (COVER_MISSING_BEFORE_BURN); covered
 *     candidates burn normally; missing fetchItemInfo fails closed;
 *  5. cover bridge: journal sha256 reuse (no second upload), dry-run planOnly
 *     (never uploads), and COVER_UNAVAILABLE without an imgUrl;
 *  6. partNameFromTitle round-trips the buildItemDisplay title rule.
 *
 * Run: node SKILLs/nft-swap/cli/cover-gate-selftest.mjs
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SwapLedger } from './lib/swap-ledger.mjs';
import {
  albumFromConfig,
  buildItemDisplay,
  mintAndSend,
  partNameFromTitle,
  planBurnBatch,
  runBurnBatch,
} from './lib/swap-engine.mjs';
import { fetchVaultTokenRows } from './lib/vault-poll-lib.mjs';
import {
  SWAP_COVER_PIPELINE,
  createCoverResolver,
  shaIndexFromJournal,
} from './lib/cover-bridge.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'nft-swap-cover-gate-'));
const ALBUM = albumFromConfig({
  genesis: 'aa'.repeat(32),
  codeHash: 'bb'.repeat(20),
  sensibleId: null,
  tokenSupply: 9560,
  issuerAddress: '1IssuerAddressPlaceholder11111111111111',
  collectionName: 'metabot-avatar',
  burnAddress: '1BurnAddressPlaceholder0000000000000000000',
  perSwapFeeCeilingSats: 5000,
});
const METABOT_ID = 15;
const PIN = (hexChar) => `${hexChar.repeat(64)}i0`;

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✘ ${name}: ${error.message}`);
  }
};

const openLedger = () => new SwapLedger(path.join(TMP, `ledger-${Math.random().toString(36).slice(2)}.sqlite`));

/** Create a ledger row at `claimed` for tokenIndex n with the given outpoint. */
function claimedRow(ledger, tokenIndex, outpoint = null) {
  const [txid, vout] = (outpoint ?? `${'ab'.repeat(32)}:${tokenIndex}`).split(':');
  const { row } = ledger.recordDetection({
    genesis: ALBUM.genesis,
    codeHash: ALBUM.codeHash,
    tokenIndex,
    sensibleId: null,
    depositTxid: txid,
    depositVout: Number(vout),
    depositHeight: 900,
  });
  return ledger.claim(row.id, { channel: 'selftest', messageId: null, claimantAddress: '1ClaimantAddressPlaceholder00000000000000' });
}

/** Drive a claimed row all the way to `sent` with stub receipts. */
function sentRow(ledger, tokenIndex, outpoint) {
  const row = claimedRow(ledger, tokenIndex, outpoint);
  const minted = ledger.recordMintBroadcast(row.id, {
    itemPath: `item-${String(tokenIndex).padStart(4, '0')}`,
    mintPinId: PIN('c'),
    txids: [],
    dualCheck: { display: buildItemDisplay({ tokenIndex, depositTxid: row.deposit_txid, album: ALBUM, cover: `metafile://${PIN('a')}` }) },
  });
  const confirmed = ledger.recordMintConfirmed(minted.id, { creatorMinted: true });
  const transferred = ledger.recordTransferBroadcast(confirmed.id, { transferTxid: 'ef'.repeat(32), feeSats: 300 });
  return ledger.recordTransferStable(transferred.id, { transferCount: 1 });
}

const vaultRow = (tokenIndex, overrides = {}) => ({
  txid: 'ab'.repeat(32),
  outIndex: tokenIndex,
  genesis: ALBUM.genesis,
  codehash: ALBUM.codeHash,
  tokenIndex,
  sensibleId: null,
  height: 900,
  satoshis: 1,
  name: 'Arms 8',
  imgUrl: 'https://img.example/legacy.png',
  ...overrides,
});

const coverUri = () => `metafile://${PIN('a')}`;

async function expectSwapError(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.name, 'SwapEngineError', `expected SwapEngineError, got ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected SwapEngineError ${code}, but the call succeeded`);
}

// ---------------------------------------------------------------------------
// 1. row mapper
// ---------------------------------------------------------------------------

await check('mapper: real v4 camelCase row keeps name/imgUrl (with flag-page dedupe)', async () => {
  const pages = [
    {
      code: 0,
      data: {
        list: [
          { txId: 'ab'.repeat(32), txIndex: 11, genesis: ALBUM.genesis, codeHash: ALBUM.codeHash, tokenIndex: 300, height: 900, satoshi: 1, flag: 2, name: 'Arms 8', imgUrl: 'https://img.example/300.png' },
          { txId: 'cd'.repeat(32), txIndex: 0, genesis: ALBUM.genesis, codeHash: ALBUM.codeHash, tokenIndex: 301, height: 900, satoshi: 1, flag: 0, name: 'Leg 2', imgUrl: 'https://img.example/301.png' },
        ],
      },
    },
    // flag=0 follow-up repeats both rows — dedupe must keep each once
    {
      code: 0,
      data: {
        list: [
          { txId: 'ab'.repeat(32), txIndex: 11, genesis: ALBUM.genesis, codeHash: ALBUM.codeHash, tokenIndex: 300, height: 900, satoshi: 1, flag: 0, name: 'Arms 8', imgUrl: 'https://img.example/300.png' },
        ],
      },
    },
  ];
  let call = 0;
  const rows = await fetchVaultTokenRows({ address: '1Vault', fetchImpl: async () => ({ json: async () => pages[call++] }) });
  assert.equal(rows.length, 2, `expected deduped 2 rows, got ${rows.length}`);
  const row300 = rows.find((r) => r.tokenIndex === 300);
  assert.equal(row300.txid, 'ab'.repeat(32));
  assert.equal(row300.outIndex, 11);
  assert.equal(row300.codehash, ALBUM.codeHash);
  assert.equal(row300.name, 'Arms 8');
  assert.equal(row300.imgUrl, 'https://img.example/300.png');
  assert.equal(rows.find((r) => r.tokenIndex === 301).imgUrl, 'https://img.example/301.png');
});

await check('mapper: lower-case alias fixture row still maps + carries imgUrl/imageUrl alias', async () => {
  const rows = await fetchVaultTokenRows({
    address: '1Vault',
    fetchImpl: async () => ({
      json: async () => ({
        code: 0,
        data: { list: [{ txid: '12'.repeat(32), outIndex: 3, genesis: ALBUM.genesis, codehash: ALBUM.codeHash, tokenIndex: 42, height: 1, value: 2, name: 'Head 1', imageUrl: 'https://img.example/42.png' }] },
      }),
    }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Head 1');
  assert.equal(rows[0].imgUrl, 'https://img.example/42.png');
});

// ---------------------------------------------------------------------------
// 2. mintAndSend「缺图不铸」
// ---------------------------------------------------------------------------

await check('mint gate: broadcast without resolver or --cover refuses to mint (row untouched, still claimed)', async () => {
  const ledger = openLedger();
  const row = claimedRow(ledger, 500);
  const mintCalls = [];
  const error = await expectSwapError(
    mintAndSend({
      ledger,
      album: ALBUM,
      row,
      deps: {
        probeItemPath: async () => ({ pins: [] }),
        fetchVaultRows: async () => [vaultRow(500, { outIndex: 500 })],
        mintItemPin: async (input) => mintCalls.push(input),
      },
      broadcast: true,
    }),
    'COVER_UNAVAILABLE',
  );
  assert.match(error.message, /silently drop the legacy image/);
  assert.equal(ledger.rowById(row.id).state, 'claimed', 'row must stay claimed (no cover, no reject — resolver simply missing)');
  assert.equal(mintCalls.length, 0, 'no mint call may happen');
  ledger.close();
});

await check('mint gate: resolver COVER_UNAVAILABLE on broadcast → mint aborted AND row rejected (refund path open)', async () => {
  const ledger = openLedger();
  const row = claimedRow(ledger, 501);
  const mintCalls = [];
  const error = await expectSwapError(
    mintAndSend({
      ledger,
      album: ALBUM,
      row,
      deps: {
        probeItemPath: async () => ({ pins: [] }),
        fetchVaultRows: async () => [vaultRow(501, { imgUrl: '', outIndex: 501 })],
        resolveCover: async () => ({ ok: false, code: 'COVER_UNAVAILABLE', message: 'no imgUrl for tokenIndex 501' }),
        mintItemPin: async (input) => mintCalls.push(input),
      },
      broadcast: true,
    }),
    'COVER_UNAVAILABLE',
  );
  const rejected = ledger.rowById(row.id);
  assert.equal(rejected.state, 'rejected', 'COVER_UNAVAILABLE must reject the row (owner refund path)');
  assert.match(rejected.reject_reason, /cover unavailable/i);
  assert.ok(ledger.eventsFor(row.id).some((e) => e.event === 'reject'), 'a reject event must be in the ledger trail');
  assert.equal(mintCalls.length, 0, 'no mint call may happen');
  ledger.close();
});

await check('mint gate: transient resolver failure keeps the row claimed (retryable, nothing broadcast)', async () => {
  const ledger = openLedger();
  const row = claimedRow(ledger, 502);
  const error = await expectSwapError(
    mintAndSend({
      ledger,
      album: ALBUM,
      row,
      deps: {
        probeItemPath: async () => ({ pins: [] }),
        fetchVaultRows: async () => [vaultRow(502, { outIndex: 502 })],
        resolveCover: async () => ({ ok: false, code: 'COVER_UPLOAD_FAILED', message: 'host rpc down' }),
        mintItemPin: async () => assert.fail('must not mint'),
      },
      broadcast: true,
    }),
    'COVER_UPLOAD_FAILED',
  );
  assert.equal(ledger.rowById(row.id).state, 'claimed', 'transient failure must NOT reject the row');
  assert.match(error.message, /retryable/);
  ledger.close();
});

await check('mint gate: resolved cover mints, and the cover is persisted in the recorded display (with partName)', async () => {
  const ledger = openLedger();
  const row = claimedRow(ledger, 503);
  const descSpy = [];
  const result = await mintAndSend({
    ledger,
    album: ALBUM,
    row,
    deps: {
      probeItemPath: async () => ({ pins: [] }),
      fetchVaultRows: async () => [vaultRow(503, { outIndex: 503 })],
      resolveCover: async () => ({ ok: true, cover: coverUri(), source: 'upload' }),
      mintItemPin: async () => ({ pinId: PIN('b'), txids: [] }),
      writeItemDesc: async (input) => {
        descSpy.push(input);
        return { pinId: PIN('c'), totalCost: 796 };
      },
      waitItemInfo: async () => ({ hit: { output: `${'ab'.repeat(32)}:0`, outputValue: 1000 } }),
      fetchItemVerify: async () => ({ creatorMinted: true }),
      fetchCollectionInfo: async () => ({ createAddress: ALBUM.issuerAddress }),
      transferItem: async () => ({ txId: 'ef'.repeat(32), feeSats: 300 }),
      waitTransferStable: async () => ({ ok: true, transferCount: 1 }),
    },
    broadcast: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const sent = ledger.rowById(row.id);
  assert.equal(sent.state, 'sent');
  const display = JSON.parse(sent.dual_check_json).display;
  assert.equal(display.cover, coverUri(), 'the recorded display must carry the cover');
  assert.equal(display.name, 'MetaBot Avatar - Arms 8 #503', 'partName from the live vault row must feed the title');
  assert.equal(descSpy[0]?.item?.cover, coverUri(), 'item_desc write must carry the cover too');
  ledger.close();
});

await check('mint gate: explicit --cover still wins over the resolver (resolver not consulted)', async () => {
  const ledger = openLedger();
  const row = claimedRow(ledger, 504);
  let resolverCalled = false;
  const result = await mintAndSend({
    ledger,
    album: ALBUM,
    row,
    deps: {
      probeItemPath: async () => ({ pins: [] }),
      fetchVaultRows: async () => [vaultRow(504, { outIndex: 504 })],
      resolveCover: async () => {
        resolverCalled = true;
        return { ok: true, cover: `metafile://${PIN('9')}` };
      },
      mintItemPin: async () => ({ pinId: PIN('b'), txids: [] }),
      writeItemDesc: async () => ({ pinId: PIN('c'), totalCost: 796 }),
      waitItemInfo: async () => ({ hit: { output: `${'ab'.repeat(32)}:0`, outputValue: 1000 } }),
      fetchItemVerify: async () => ({ creatorMinted: true }),
      fetchCollectionInfo: async () => ({ createAddress: ALBUM.issuerAddress }),
      transferItem: async () => ({ txId: 'ef'.repeat(32), feeSats: 300 }),
      waitTransferStable: async () => ({ ok: true, transferCount: 1 }),
    },
    cover: coverUri(),
    broadcast: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.steps ?? result));
  assert.equal(resolverCalled, false, 'explicit cover bypasses the resolver');
  assert.equal(JSON.parse(ledger.rowById(row.id).dual_check_json).display.cover, coverUri());
  ledger.close();
});

await check('mint dry-run: resolver planOnly → coverStatus undecided, upload deferred, state untouched', async () => {
  const ledger = openLedger();
  const row = claimedRow(ledger, 505);
  let uploaded = false;
  const result = await mintAndSend({
    ledger,
    album: ALBUM,
    row,
    deps: {
      probeItemPath: async () => ({ pins: [] }),
      fetchVaultRows: async () => [vaultRow(505, { outIndex: 505 })],
      resolveCover: async () => ({ ok: true, cover: null, source: 'would-upload', planOnly: true, message: 'dry-run: legacy image validated, upload deferred to --broadcast' }),
      uploadPngLike: async () => {
        uploaded = true;
      },
      mintItemPin: async () => {
        uploaded = true;
        return { pinId: PIN('b'), txids: [] };
      },
    },
    broadcast: false,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.coverStatus.decided, false, JSON.stringify(result.plan.coverStatus));
  assert.equal(result.plan.coverStatus.plan.source, 'would-upload');
  assert.equal(uploaded, false, 'dry-run must not mint or upload');
  assert.equal(ledger.rowById(row.id).state, 'claimed');
  ledger.close();
});

await check('mint dry-run: resolver unavailable → plan carries COVER_UNAVAILABLE (no fail, no state change)', async () => {
  const ledger = openLedger();
  const row = claimedRow(ledger, 506);
  const result = await mintAndSend({
    ledger,
    album: ALBUM,
    row,
    deps: {
      probeItemPath: async () => ({ pins: [] }),
      fetchVaultRows: async () => [vaultRow(506, { imgUrl: '', outIndex: 506 })],
      resolveCover: async () => ({ ok: false, code: 'COVER_UNAVAILABLE', message: 'no imgUrl for tokenIndex 506' }),
      mintItemPin: async () => assert.fail('must not mint'),
    },
    broadcast: false,
  });
  assert.equal(result.plan.coverStatus.plan.code, 'COVER_UNAVAILABLE');
  assert.equal(ledger.rowById(row.id).state, 'claimed', 'dry-run never moves the state');
  ledger.close();
});

// ---------------------------------------------------------------------------
// 3. item_desc resume guard (§3.2d: never rewrite the no-cover decision)
// ---------------------------------------------------------------------------

async function mintPendingRow(ledger, tokenIndex, { withCover }) {
  const row = claimedRow(ledger, tokenIndex);
  return ledger.recordMintBroadcast(row.id, {
    itemPath: `item-${String(tokenIndex).padStart(4, '0')}`,
    mintPinId: PIN('b'),
    txids: [],
    dualCheck: {
      display: buildItemDisplay({ tokenIndex, depositTxid: row.deposit_txid, album: ALBUM, cover: withCover ? coverUri() : null }),
    },
  });
}

await check('item_desc resume guard: cover-less recorded display is REBUILT with a resolved cover', async () => {
  const ledger = openLedger();
  const row = await mintPendingRow(ledger, 507, { withCover: false });
  const descSpy = [];
  const result = await mintAndSend({
    ledger,
    album: ALBUM,
    row,
    deps: {
      resolveCover: async () => ({ ok: true, cover: coverUri(), source: 'upload' }),
      writeItemDesc: async (input) => {
        descSpy.push(input);
        return { pinId: PIN('c'), totalCost: 796 };
      },
      waitItemInfo: async () => ({ hit: { output: `${'ab'.repeat(32)}:0`, outputValue: 1000 } }),
      fetchItemVerify: async () => ({ creatorMinted: true }),
      fetchCollectionInfo: async () => ({ createAddress: ALBUM.issuerAddress }),
      transferItem: async () => ({ txId: 'ef'.repeat(32), feeSats: 300 }),
      waitTransferStable: async () => ({ ok: true, transferCount: 1 }),
    },
    broadcast: true,
  });
  assert.ok(result.steps.some((s) => s.step === 'cover_resolved_for_item_desc'), 'guard must record the rebuild');
  assert.equal(descSpy[0]?.item?.cover, coverUri(), 'the rewritten item_desc must carry the cover');
  const sent = ledger.rowById(row.id);
  assert.equal(sent.state, 'sent');
  // NOTE: the ledger's mint-time display is intentionally NOT rewritten on
  // this resume path (no ledger API for it) — the cover rides the on-chain
  // item_desc write asserted above. The stale mint-time display is inert:
  // once item_desc_pin_id is recorded this block never runs again.
  ledger.close();
});

await check('item_desc resume guard: no resolver + cover-less recorded display → write refused, row stays mint_pending', async () => {
  const ledger = openLedger();
  const row = await mintPendingRow(ledger, 508, { withCover: false });
  await expectSwapError(
    mintAndSend({
      ledger,
      album: ALBUM,
      row,
      deps: { writeItemDesc: async () => assert.fail('must not write a coverless item_desc') },
      broadcast: true,
    }),
    'COVER_MISSING_BEFORE_ITEM_DESC',
  );
  assert.equal(ledger.rowById(row.id).state, 'mint_pending', 'refusal must leave the row retryable');
  ledger.close();
});

// ---------------------------------------------------------------------------
// 4. burn gate
// ---------------------------------------------------------------------------

await check('burn gate: missing deps.fetchItemInfo fails closed (COVER_GATE_UNAVAILABLE)', async () => {
  const ledger = openLedger();
  await expectSwapError(planBurnBatch({ ledger, deps: { fetchVaultRows: async () => [] } }), 'COVER_GATE_UNAVAILABLE');
  ledger.close();
});

await check('burn gate: cover-less candidate is ineligible and a broadcast refuses the whole batch with the roster', async () => {
  const ledger = openLedger();
  const sent = sentRow(ledger, 510);
  const burnCalls = [];
  const deps = {
    fetchVaultRows: async () => [vaultRow(510, { outIndex: 510 })],
    fetchItemInfo: async () => ({ cover: '' }),
    transferLegacyToken: async (input) => burnCalls.push(input),
  };
  const plan = await planBurnBatch({ ledger, deps });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].eligible, false);
  assert.equal(plan.candidates[0].reason, 'COVER_MISSING_BEFORE_BURN');
  assert.equal(plan.candidates[0].cover, null);
  const dry = await runBurnBatch({ ledger, album: ALBUM, batchId: 'b1', deps, broadcast: false, ownerConfirmed: true });
  assert.equal(dry.plan[0].eligible, false, 'dry-run must also show the block');
  const error = await expectSwapError(
    runBurnBatch({ ledger, album: ALBUM, batchId: 'b1', deps, broadcast: true, ownerConfirmed: true }),
    'COVER_MISSING_BEFORE_BURN',
  );
  assert.equal(error.detail.blockedTokens[0].tokenIndex, 510, 'the alert roster must name the token');
  assert.equal(burnCalls.length, 0, 'no burn tx may be broadcast');
  assert.equal(ledger.rowById(sent.id).state, 'sent', 'the row must stay sent (burn refused)');
  ledger.close();
});

await check('burn gate: covered candidate + token in vault burns normally (one tx)', async () => {
  const ledger = openLedger();
  const sent = sentRow(ledger, 511);
  const burnCalls = [];
  const deps = {
    fetchVaultRows: async () => [vaultRow(511, { outIndex: 511 })],
    fetchItemInfo: async () => ({ cover: coverUri() }),
    transferLegacyToken: async (input) => {
      burnCalls.push(input);
      return { txId: '12'.repeat(32), feeSats: 300 };
    },
    sleep: async () => {},
  };
  const result = await runBurnBatch({ ledger, album: ALBUM, batchId: 'b2', deps, broadcast: true, ownerConfirmed: true });
  assert.equal(result.ok, true);
  assert.equal(burnCalls.length, 1);
  assert.equal(burnCalls[0].tokenIndex, '511');
  assert.equal(ledger.rowById(sent.id).state, 'burned');
  ledger.close();
});

await check('burn gate: cover-less burn_pending recovery row blocks the broadcast (dry-run flags it)', async () => {
  const ledger = openLedger();
  const sent = sentRow(ledger, 512);
  ledger.enterBurnBatch(sent.id, 'b3'); // simulated crash: no burn_txid yet
  const deps = {
    fetchVaultRows: async () => [vaultRow(512, { outIndex: 512 })],
    fetchItemInfo: async () => ({}), // no cover key at all
    transferLegacyToken: async () => assert.fail('must not burn'),
  };
  const dry = await runBurnBatch({ ledger, album: ALBUM, batchId: 'b3', deps, broadcast: false, ownerConfirmed: true });
  assert.equal(dry.recovery[0].reason, 'COVER_MISSING_BEFORE_BURN');
  const error = await expectSwapError(
    runBurnBatch({ ledger, album: ALBUM, batchId: 'b3', deps, broadcast: true, ownerConfirmed: true }),
    'COVER_MISSING_BEFORE_BURN',
  );
  assert.equal(error.detail.blockedTokens[0].itemPinId, PIN('c'));
  ledger.close();
});

// ---------------------------------------------------------------------------
// 5. cover bridge (hermetic: injected holdings/download/upload)
// ---------------------------------------------------------------------------

const bridgeImageBuffer = Buffer.from('89504e470d0a1a0a' + '00'.repeat(32), 'hex');
const bridgeImageSha = crypto.createHash('sha256').update(bridgeImageBuffer).digest('hex');
const bridgeImage = () => ({ buffer: bridgeImageBuffer, sha256: bridgeImageSha, bytes: bridgeImageBuffer.length, width: 8, height: 8, contentType: 'image/png' });

function bridgeDirs() {
  const outDir = path.join(TMP, `bridge-out-${Math.random().toString(36).slice(2)}`);
  const catalogFile = path.join(outDir, 'attach-cover', 'cover-catalog.jsonl');
  mkdirSync(path.dirname(catalogFile), { recursive: true });
  return { outDir, catalogFile };
}

await check('bridge: broadcast uploads once, journals the pin, and a re-run reuses it by sha256 (no second upload)', async () => {
  const { outDir, catalogFile } = bridgeDirs();
  let uploads = 0;
  const resolver = createCoverResolver({
    vaultAddress: '1Vault',
    metabotId: METABOT_ID,
    catalogFile,
    outDir,
    holdings: async () => [{ tokenIndex: 600, name: 'Arms 8', imgUrl: 'https://img.example/600.png' }],
    download: async () => bridgeImage(),
    upload: async () => {
      uploads++;
      return { pinId: PIN('e'), metafileUri: `metafile://${PIN('e')}`, totalCost: 12906, feeAssist: null };
    },
  });
  const row = { token_index: 600 };
  const first = await resolver({ row, live: null, broadcast: true });
  assert.equal(first.ok, true);
  assert.equal(first.source, 'upload');
  assert.equal(first.cover, `metafile://${PIN('e')}`);
  assert.equal(uploads, 1);
  assert.equal(shaIndexFromJournal(outDir).size, 1, 'the upload must be journaled with its sha256');
  const second = await resolver({ row, live: null, broadcast: true });
  assert.equal(second.source, 'reuse:journal');
  assert.equal(second.cover, `metafile://${PIN('e')}`);
  assert.equal(uploads, 1, 'identical bytes must never pay a second upload');
});

await check('bridge: dry-run validates and plans only — never uploads', async () => {
  const { outDir, catalogFile } = bridgeDirs();
  const resolver = createCoverResolver({
    vaultAddress: '1Vault',
    metabotId: METABOT_ID,
    catalogFile,
    outDir,
    holdings: async () => [{ tokenIndex: 601, name: 'Arms 8', imgUrl: 'https://img.example/601.png' }],
    download: async () => bridgeImage(),
    upload: async () => assert.fail('dry-run must not upload'),
  });
  const plan = await resolver({ row: { token_index: 601 }, live: null, broadcast: false });
  assert.equal(plan.ok, true);
  assert.equal(plan.cover, null);
  assert.equal(plan.planOnly, true);
  assert.equal(plan.image.sha256, bridgeImageSha);
});

await check('bridge: no imgUrl → COVER_UNAVAILABLE (permanent code the engine rejects on)', async () => {
  const { outDir, catalogFile } = bridgeDirs();
  const resolver = createCoverResolver({
    vaultAddress: '1Vault',
    metabotId: METABOT_ID,
    catalogFile,
    outDir,
    holdings: async () => [{ tokenIndex: 602, name: 'Arms 8', imgUrl: '' }],
    download: async () => assert.fail('must not download without an url'),
    upload: async () => assert.fail('must not upload'),
  });
  const result = await resolver({ row: { token_index: 602 }, live: null, broadcast: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COVER_UNAVAILABLE');
});

await check('bridge: the engine consumes the real bridge end-to-end (mint gate + persisted cover, all I/O injected)', async () => {
  const ledger = openLedger();
  const { outDir, catalogFile } = bridgeDirs();
  let uploads = 0;
  const row = claimedRow(ledger, 603);
  const resolver = createCoverResolver({
    vaultAddress: '1Vault',
    metabotId: METABOT_ID,
    catalogFile,
    outDir,
    holdings: async () => [{ tokenIndex: 603, name: 'Arms 8', imgUrl: 'https://img.example/603.png' }],
    download: async () => bridgeImage(),
    upload: async () => {
      uploads++;
      return { pinId: PIN('e'), metafileUri: `metafile://${PIN('e')}`, totalCost: 12906, feeAssist: null };
    },
  });
  const result = await mintAndSend({
    ledger,
    album: ALBUM,
    row,
    deps: {
      probeItemPath: async () => ({ pins: [] }),
      fetchVaultRows: async () => [vaultRow(603, { outIndex: 603 })],
      resolveCover: resolver,
      mintItemPin: async () => ({ pinId: PIN('b'), txids: [] }),
      writeItemDesc: async () => ({ pinId: PIN('c'), totalCost: 796 }),
      waitItemInfo: async () => ({ hit: { output: `${'ab'.repeat(32)}:0`, outputValue: 1000 } }),
      fetchItemVerify: async () => ({ creatorMinted: true }),
      fetchCollectionInfo: async () => ({ createAddress: ALBUM.issuerAddress }),
      transferItem: async () => ({ txId: 'ef'.repeat(32), feeSats: 300 }),
      waitTransferStable: async () => ({ ok: true, transferCount: 1 }),
    },
    broadcast: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.steps ?? result));
  assert.equal(uploads, 1);
  const display = JSON.parse(ledger.rowById(row.id).dual_check_json).display;
  assert.equal(display.cover, `metafile://${PIN('e')}`);
  ledger.close();
});

// ---------------------------------------------------------------------------
// 6. title round-trip
// ---------------------------------------------------------------------------

await check('partNameFromTitle round-trips buildItemDisplay titles', () => {
  const display = buildItemDisplay({ tokenIndex: 2671, depositTxid: 'tx', album: ALBUM, cover: null, partName: 'Arms 8' });
  assert.equal(partNameFromTitle(display.name), 'Arms 8');
  assert.equal(partNameFromTitle('MetaBot Avatar #2671'), null);
});

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? 'cover-gate selftest: all green' : `cover-gate selftest: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
