import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SwapLedger } from '../SKILLs/nft-swap/cli/lib/swap-ledger.mjs';
import {
  SwapEngineError,
  buildItemDisplay,
  classifyItemPathProbe,
  createIndexReaders,
  itemPathForToken,
  mintAndSend,
  planBurnBatch,
  runBurnBatch,
  verifyAndClaim,
  waitForTransferStable,
} from '../SKILLs/nft-swap/cli/lib/swap-engine.mjs';

const ALBUM = {
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  codeHash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  sensibleId: '4e7a7d3e3e748c09f1eff46fe504c5fdc389014eab3e316685004d770225ea53 00000000',
  tokenSupply: 9560,
  issuerAddress: '176C9RPWDggnvdVcWG3wrZEJcm1bHTcKM5',
  collectionName: 'metabot-avatar',
  burnAddress: '1111111111111111111114oLvT2',
  perSwapFeeCeilingSats: 5000,
};
const CLAIMANT = '1ClaimantBotWalletAddress11111111';
const MINT_PIN = `${'a'.repeat(64)}i0`;
const DESC_PIN = `${'d'.repeat(64)}i0`;
const PROBE_ISSUER_PIN = `${'b'.repeat(64)}i0`;

let hexSeq = 0;
/** Unique 64-hex txid per call (test-local; vout 0 everywhere). */
function uniqueHex() {
  hexSeq = (hexSeq + 1) % 9000;
  return String(1000 + hexSeq).padStart(4, '0').repeat(16);
}

async function withTempLedger(name, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), `nft-swap-engine-${name}-`));
  const ledger = new SwapLedger(path.join(dir, 'ledger.sqlite'));
  try {
    return await fn(ledger);
  } finally {
    ledger.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // leftover temp dirs are harmless
    }
  }
}

function detect(ledger, tokenIndex, txid = uniqueHex()) {
  const { row } = ledger.recordDetection({
    genesis: ALBUM.genesis,
    codeHash: ALBUM.codeHash,
    tokenIndex,
    depositTxid: txid,
    depositVout: 0,
    depositHeight: 800_000,
  });
  return { row, txid };
}

function claim(ledger, tokenIndex, txid = uniqueHex()) {
  const { row } = detect(ledger, tokenIndex, txid);
  ledger.claim(row.id, { channel: 'chat', messageId: `msg-${row.id}`, claimantAddress: CLAIMANT });
  return { row: ledger.rowById(row.id), txid };
}

function minted(ledger, tokenIndex, txid = uniqueHex()) {
  const claimed = claim(ledger, tokenIndex, txid);
  ledger.recordMintBroadcast(claimed.row.id, {
    itemPath: itemPathForToken(tokenIndex),
    mintPinId: MINT_PIN,
    txids: [],
  });
  ledger.recordMintConfirmed(claimed.row.id, { creatorMinted: true });
  return { row: ledger.rowById(claimed.row.id), txid };
}

function sent(ledger, tokenIndex, txid = uniqueHex()) {
  const mintedRow = minted(ledger, tokenIndex, txid);
  ledger.recordTransferBroadcast(mintedRow.row.id, { transferTxid: uniqueHex() });
  ledger.recordTransferStable(mintedRow.row.id, { transferCount: 1 });
  return { row: ledger.rowById(mintedRow.row.id), txid };
}

function vaultRow(txid, tokenIndex, extra = {}) {
  return {
    txid,
    outIndex: 0,
    genesis: ALBUM.genesis,
    codehash: ALBUM.codeHash,
    tokenIndex,
    sensibleId: null,
    height: 800_000,
    satoshis: 1,
    ...extra,
  };
}

function makeDeps({ vaultRows = [], probePins = [], overrides = {} } = {}) {
  const calls = { mint: 0, desc: 0, transfer: 0, burn: 0, estimate: 0 };
  const deps = {
    probeItemPath: async () => ({ pins: probePins, total: probePins.length }),
    fetchVaultRows: async () => vaultRows,
    fetchConfirmations: async () => 6,
    estimateMintPins: async () => {
      calls.estimate += 1;
      return { feeRate: 1, itemPinSats: 1000, itemDescSats: 1000, totalSats: 2000 };
    },
    mintItemPin: async () => {
      calls.mint += 1;
      return { pinId: MINT_PIN, txids: [uniqueHex()], totalCost: 1500 };
    },
    writeItemDesc: async () => {
      calls.desc += 1;
      return { pinId: DESC_PIN, totalCost: 900 };
    },
    waitItemInfo: async () => ({ hit: { output: `${uniqueHex()}:0`, outputValue: 1, transferCount: 0 } }),
    fetchItemVerify: async () => ({ creatorMinted: true }),
    fetchItemInfo: async () => ({ cover: '/test-covers/legacy.png' }),
    fetchCollectionInfo: async () => ({ createAddress: ALBUM.issuerAddress }),
    transferItem: async () => {
      calls.transfer += 1;
      return { txId: uniqueHex() };
    },
    waitTransferStable: async () => ({ ok: true, transferCount: 1 }),
    transferLegacyToken: async () => {
      calls.burn += 1;
      return { txId: uniqueHex(), feeSats: 420 };
    },
    sleep: async () => {},
    // Cover-preservation guard (2026-11-19): mint/broadcast fail closed when
    // neither an explicit --cover nor deps.resolveCover exists. The engine's
    // own behavior tests stay focused on the mint/burn lifecycle, so the
    // default deps carry a stub resolver; cover-guard tests override it via
    // `overrides` to assert the COVER_UNAVAILABLE paths.
    resolveCover: async () => ({ cover: '/test-covers/legacy.png', source: 'test-resolver' }),
    ...overrides,
  };
  return { deps, calls };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SwapEngineError, `expected SwapEngineError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// cross-process serialization (2026-11-19 review P2)
// ---------------------------------------------------------------------------

test('concurrent mint-and-send runs serialize: the second cannot start while the first broadcast is in flight', async () => {
  await withTempLedger('mint-lock-serialize', async (ledger) => {
    const { row, txid } = claim(ledger, 842);
    let releaseMint;
    const mintGate = new Promise((resolve) => { releaseMint = resolve; });
    let mintCalls = 0;
    const first = makeDeps({
      vaultRows: [vaultRow(txid, 842)],
      overrides: {
        mintItemPin: async () => {
          mintCalls += 1;
          await mintGate;
          return { pinId: MINT_PIN, txids: [uniqueHex()], totalCost: 1500 };
        },
      },
    });
    const firstRun = mintAndSend({ ledger, album: ALBUM, row, deps: first.deps, broadcast: true });
    // The first run holds the ledger's exclusive lock synchronously from
    // entry; a second run starting now must be refused, not double-mint.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(
      () => mintAndSend({ ledger, album: ALBUM, row, deps: makeDeps().deps, broadcast: true }),
      /within a transaction|database is locked|SQLITE_BUSY/i,
      'a run starting inside the exclusive lock must refuse',
    );
    releaseMint();
    const result = await firstRun;
    assert.equal(result.state, 'sent');
    assert.equal(mintCalls, 1, 'exactly one mint broadcast for the tokenIndex');
    assert.equal(ledger.mintedRowsByToken(ALBUM.genesis, 842).length, 1);
  });
});

test('the ledger lock releases on failure paths: a failed run leaves the lock free', async () => {
  await withTempLedger('mint-lock-release', async (ledger) => {
    const { row } = claim(ledger, 843);
    const { deps } = makeDeps({ vaultRows: [] });
    // DEPOSIT_NOT_IN_VAULT fails inside the lock; the finally must release it
    // so the very next command can acquire it again.
    await expectCode(
      mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true }),
      'DEPOSIT_NOT_IN_VAULT',
    );
    ledger.lockExclusive();
    ledger.unlockExclusive();
  });
});

// ---------------------------------------------------------------------------
// item path + probe classification
// ---------------------------------------------------------------------------

test('itemPathForToken pads to four digits and refuses out-of-range indexes', () => {
  assert.equal(itemPathForToken(1), 'item-0001');
  assert.equal(itemPathForToken(817), 'item-0817');
  assert.equal(itemPathForToken(9560), 'item-9560');
  assert.throws(() => itemPathForToken(0), (error) => error.code === 'TOKEN_INDEX_INVALID');
  assert.throws(() => itemPathForToken(1.5), (error) => error.code === 'TOKEN_INDEX_INVALID');
  assert.throws(() => itemPathForToken(10000), (error) => error.code === 'TOKEN_INDEX_INVALID');
});

test('classifyItemPathProbe: free / issuer-minted / conflict (unattributable pin = conflict)', () => {
  assert.equal(classifyItemPathProbe({ pins: [], issuerAddress: ALBUM.issuerAddress }).status, 'free');
  assert.equal(
    classifyItemPathProbe({
      pins: [{ pinId: PROBE_ISSUER_PIN, address: ALBUM.issuerAddress }],
      issuerAddress: ALBUM.issuerAddress,
    }).status,
    'issuer-minted',
  );
  assert.equal(
    classifyItemPathProbe({
      pins: [{ pinId: 'x'.repeat(64) + 'i0', address: '1ForeignMinter' }],
      issuerAddress: ALBUM.issuerAddress,
    }).status,
    'conflict',
  );
  assert.equal(
    classifyItemPathProbe({
      pins: [{ pinId: 'y'.repeat(64) + 'i0', address: '' }],
      issuerAddress: ALBUM.issuerAddress,
    }).status,
    'conflict',
  );
});

test('probeItemPath walks every page and normalizes the pin rows', async () => {
  const urls = [];
  const pages = [
    { list: [{ id: `${'1'.repeat(64)}i0`, address: ALBUM.issuerAddress, globalMetaId: 'idq1a', genesisHeight: 800_000 }], nextCursor: 'c2', total: 2 },
    { list: [{ id: `${'2'.repeat(64)}i0`, address: ALBUM.issuerAddress, globalMetaId: 'idq1b', genesisHeight: 800_001 }], nextCursor: '', total: 2 },
  ];
  const readers = createIndexReaders({
    manapiBase: 'https://index.example',
    nftBase: 'https://read.example',
    fetchImpl: async (url) => {
      urls.push(url);
      return { json: async () => ({ code: 1, message: 'ok', data: pages[urls.length - 1] }) };
    },
  });
  const probe = await readers.probeItemPath({ collectionName: 'metabot-avatar', itemPath: 'item-0817' });
  assert.equal(probe.pins.length, 2);
  assert.equal(probe.total, 2);
  assert.equal(probe.pins[1].height, 800_001);
  assert.match(urls[0], /\/api\/pin\/path\/list\?path=%2Fnft%2Fmrc721%2Fmetabot-avatar%2Fitem-0817/);
  assert.match(urls[1], /cursor=c2/);
});

// ---------------------------------------------------------------------------
// verify-claim
// ---------------------------------------------------------------------------

test('verify-claim: live vault + triple + 6 confirmations → detected becomes claimed', async () => {
  await withTempLedger('claim-happy', async (ledger) => {
    const { row, txid } = detect(ledger, 817);
    const { deps } = makeDeps({ vaultRows: [vaultRow(txid, 817)] });
    const result = await verifyAndClaim({
      ledger,
      album: ALBUM,
      row,
      claimantAddress: CLAIMANT,
      claimChannel: 'chat',
      claimMessageId: 'msg-42',
      deps,
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'claimed');
    assert.equal(result.confirmations, 6);
    assert.equal(result.itemPath, 'item-0817');
    const stored = ledger.rowById(row.id);
    assert.equal(stored.state, 'claimed');
    assert.equal(stored.claimant_address, CLAIMANT);
    assert.equal(stored.claim_message_id, 'msg-42');
  });
});

test('verify-claim refuses when the deposit left the vault', async () => {
  await withTempLedger('claim-gone', async (ledger) => {
    const { row } = detect(ledger, 818);
    const { deps } = makeDeps({ vaultRows: [] });
    await expectCode(
      verifyAndClaim({ ledger, album: ALBUM, row, claimantAddress: CLAIMANT, deps }),
      'DEPOSIT_NOT_IN_VAULT',
    );
    assert.equal(ledger.rowById(row.id).state, 'detected'); // no state move on refusal
  });
});

test('verify-claim refuses under minConfirmations (default 1-conf) and on a triple mismatch', async () => {
  await withTempLedger('claim-gates', async (ledger) => {
    const { row, txid } = detect(ledger, 819);
    await expectCode(
      verifyAndClaim({
        ledger,
        album: ALBUM,
        row,
        claimantAddress: CLAIMANT,
        deps: makeDeps({ vaultRows: [vaultRow(txid, 819)], overrides: { fetchConfirmations: async () => 0 } }).deps,
      }),
      'INSUFFICIENT_CONFIRMATIONS',
    );
    await expectCode(
      verifyAndClaim({
        ledger,
        album: ALBUM,
        row,
        claimantAddress: CLAIMANT,
        minConfirmations: 6,
        deps: makeDeps({ vaultRows: [vaultRow(txid, 819)], overrides: { fetchConfirmations: async () => 5 } }).deps,
      }),
      'INSUFFICIENT_CONFIRMATIONS',
    );
    await expectCode(
      verifyAndClaim({
        ledger,
        album: ALBUM,
        row,
        claimantAddress: CLAIMANT,
        deps: makeDeps({ vaultRows: [vaultRow(txid, 819, { codehash: 'ff'.repeat(20) })] }).deps,
      }),
      'TRIPLE_MISMATCH',
    );
    assert.equal(ledger.rowById(row.id).state, 'detected');
  });
});

test('verify-claim accepts 1 confirmation under v0.5 default minConfirmations', async () => {
  await withTempLedger('claim-1conf', async (ledger) => {
    const { row, txid } = detect(ledger, 821);
    const out = await verifyAndClaim({
      ledger,
      album: ALBUM,
      row,
      claimantAddress: CLAIMANT,
      deps: makeDeps({ vaultRows: [vaultRow(txid, 821)], overrides: { fetchConfirmations: async () => 1 } }).deps,
    });
    assert.equal(out.ok, true);
    assert.equal(out.state, 'claimed');
    assert.equal(ledger.rowById(row.id).state, 'claimed');
  });
});

test('verify-claim aborts on a foreign pin at the item path (stop-and-alert)', async () => {
  await withTempLedger('claim-conflict', async (ledger) => {
    const { row, txid } = detect(ledger, 820);
    const { deps } = makeDeps({
      vaultRows: [vaultRow(txid, 820)],
      probePins: [{ pinId: 'f'.repeat(64) + 'i0', address: '1ForeignMinter', height: 800_050 }],
    });
    await expectCode(
      verifyAndClaim({ ledger, album: ALBUM, row, claimantAddress: CLAIMANT, deps }),
      'ITEM_PATH_CONFLICT',
    );
    assert.equal(ledger.rowById(row.id).state, 'detected');
  });
});

test('verify-claim dry-run does not move the ledger', async () => {
  await withTempLedger('claim-dry', async (ledger) => {
    const { row, txid } = detect(ledger, 821);
    const { deps, calls } = makeDeps({ vaultRows: [vaultRow(txid, 821)] });
    const result = await verifyAndClaim({
      ledger,
      album: ALBUM,
      row,
      claimantAddress: CLAIMANT,
      deps,
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldClaim.claimantAddress, CLAIMANT);
    assert.equal(ledger.rowById(row.id).state, 'detected');
    assert.equal(calls.mint, 0);
  });
});

// ---------------------------------------------------------------------------
// mint-and-send
// ---------------------------------------------------------------------------

test('mint-and-send dry-run plans the mint with PRD §7 metadata and writes nothing', async () => {
  await withTempLedger('mint-dry', async (ledger) => {
    const { row, txid } = claim(ledger, 817);
    const { deps, calls } = makeDeps({ vaultRows: [vaultRow(txid, 817)] });
    const result = await mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: false });
    assert.equal(result.dryRun, true);
    assert.equal(result.next, 'mint_broadcast');
    assert.equal(result.plan.itemPath, 'item-0817');
    assert.equal(result.plan.display.metadata.custom.swap.legacyGenesis, ALBUM.genesis);
    assert.equal(result.plan.display.metadata.custom.swap.tokenIndex, 817);
    assert.equal(result.plan.display.metadata.custom.swap.depositTxid, txid);
    assert.equal(calls.mint, 0);
    assert.equal(calls.transfer, 0);
    assert.equal(ledger.rowById(row.id).state, 'claimed');
  });
});

test('mint-and-send happy path: claimed → mint_pending → minted → send_pending → sent', async () => {
  await withTempLedger('mint-happy', async (ledger) => {
    const { row, txid } = claim(ledger, 817);
    const { deps, calls } = makeDeps({ vaultRows: [vaultRow(txid, 817)] });
    const result = await mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'sent');
    assert.equal(calls.mint, 1);
    assert.equal(calls.desc, 1);
    assert.equal(calls.transfer, 1);

    const stored = ledger.rowById(row.id);
    assert.equal(stored.mint_pin_id, MINT_PIN);
    assert.equal(stored.item_desc_pin_id, DESC_PIN);
    assert.equal(stored.item_path, 'item-0817');
    assert.ok(stored.transfer_txid);
    assert.equal(stored.transfer_count, 1);

    const events = ledger.eventsFor(row.id).map((e) => e.event);
    assert.deepEqual(events, [
      'detected',
      'claim',
      'mint_broadcast',
      'item_desc_broadcast',
      'mint_confirmed',
      'transfer_broadcast',
      'transfer_stable',
    ]);
  });
});

test('crash recovery: a recorded mint pin is resumed — the mint is NEVER repeated', async () => {
  await withTempLedger('mint-resume', async (ledger) => {
    const { row } = claim(ledger, 830);
    ledger.recordMintBroadcast(row.id, { itemPath: 'item-0830', mintPinId: MINT_PIN, txids: [] });
    assert.equal(ledger.rowById(row.id).state, 'mint_pending');

    const { deps, calls } = makeDeps();
    const result = await mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true });
    assert.equal(result.state, 'sent');
    assert.equal(calls.mint, 0, 'mint must not be called on a mint_pending row');
    assert.equal(calls.desc, 1);
    assert.equal(ledger.rowById(row.id).mint_pin_id, MINT_PIN);
  });
});

test('crash recovery: an already-broadcast issuer pin at the path is ADOPTED (no re-mint)', async () => {
  await withTempLedger('mint-adopt', async (ledger) => {
    const { row, txid } = claim(ledger, 831);
    const { deps, calls } = makeDeps({
      vaultRows: [vaultRow(txid, 831)],
      probePins: [{ pinId: PROBE_ISSUER_PIN, address: ALBUM.issuerAddress, height: 800_100 }],
    });
    const result = await mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true });
    assert.equal(result.ok, true);
    assert.equal(calls.mint, 0, 'an existing issuer pin must be adopted, never re-minted');
    const stored = ledger.rowById(row.id);
    assert.equal(stored.mint_pin_id, PROBE_ISSUER_PIN);
    assert.equal(stored.state, 'sent');
    const adoptEvent = ledger.eventsFor(row.id).find((e) => e.event === 'mint_broadcast');
    assert.match(adoptEvent.evidence_json, /recoveredWithoutRebroadcast/);
  });
});

test('adoption refuses a pin already bound to another ledger row', async () => {
  await withTempLedger('mint-bound', async (ledger) => {
    // Manufacture the anomaly: another row (different token) carries the pin
    // the path probe is about to return for THIS token's path.
    const other = claim(ledger, 900);
    ledger.recordMintBroadcast(other.row.id, { itemPath: 'item-0900', mintPinId: PROBE_ISSUER_PIN, txids: [] });
    const { row, txid } = claim(ledger, 832);
    const { deps, calls } = makeDeps({
      vaultRows: [vaultRow(txid, 832)],
      probePins: [{ pinId: PROBE_ISSUER_PIN, address: ALBUM.issuerAddress, height: 800_100 }],
    });
    await expectCode(mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true }), 'MINT_PIN_BOUND_TO_OTHER_ROW');
    assert.equal(calls.mint, 0);
    assert.equal(ledger.rowById(row.id).state, 'claimed');
  });
});

test('item_desc failure leaves the row mint_pending; a retry completes without a second mint', async () => {
  await withTempLedger('mint-desc-retry', async (ledger) => {
    const { row, txid } = claim(ledger, 833);
    const first = makeDeps({
      vaultRows: [vaultRow(txid, 833)],
      overrides: {
        writeItemDesc: async () => {
          throw new Error('relay 502');
        },
      },
    });
    await expectCode(
      mintAndSend({ ledger, album: ALBUM, row, deps: first.deps, broadcast: true }),
      'ITEM_DESC_BROADCAST_FAILED',
    );
    assert.equal(first.calls.mint, 1);
    let stored = ledger.rowById(row.id);
    assert.equal(stored.state, 'mint_pending');
    assert.equal(stored.mint_pin_id, MINT_PIN);
    assert.equal(stored.item_desc_pin_id, null);

    const second = makeDeps();
    const result = await mintAndSend({ ledger, album: ALBUM, row, deps: second.deps, broadcast: true });
    assert.equal(result.state, 'sent');
    assert.equal(second.calls.mint, 0, 'retry after item_desc failure must not re-mint');
    assert.equal(second.calls.desc, 1);
    stored = ledger.rowById(row.id);
    assert.equal(stored.item_desc_pin_id, DESC_PIN);
  });
});

test('missing output/outputValue is index lag: pending, retryable, never a failure or a re-mint', async () => {
  await withTempLedger('mint-output-lag', async (ledger) => {
    const { row, txid } = claim(ledger, 834);
    const first = makeDeps({
      vaultRows: [vaultRow(txid, 834)],
      overrides: {
        waitItemInfo: async () => ({ hit: { output: '', outputValue: 0, transferCount: 0 } }),
      },
    });
    const pending = await mintAndSend({ ledger, album: ALBUM, row, deps: first.deps, broadcast: true });
    assert.equal(pending.ok, false);
    assert.equal(pending.pending, true);
    assert.equal(pending.reason, 'OUTPUT_FIELDS_PENDING');
    assert.equal(first.calls.mint, 1);
    assert.equal(ledger.rowById(row.id).state, 'mint_pending');

    const second = makeDeps();
    const done = await mintAndSend({ ledger, album: ALBUM, row, deps: second.deps, broadcast: true });
    assert.equal(done.state, 'sent');
    assert.equal(second.calls.mint, 0);
  });
});

test('official-mint verification mismatch halts with the pin kept in mint_pending', async () => {
  await withTempLedger('mint-verify-fail', async (ledger) => {
    const { row, txid } = claim(ledger, 835);
    const { deps, calls } = makeDeps({
      vaultRows: [vaultRow(txid, 835)],
      overrides: { fetchItemVerify: async () => ({ creatorMinted: false }) },
    });
    await expectCode(mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true }), 'MINT_VERIFY_FAILED');
    assert.equal(calls.transfer, 0);
    const stored = ledger.rowById(row.id);
    assert.equal(stored.state, 'mint_pending');
    assert.equal(stored.mint_pin_id, MINT_PIN);
  });
});

test('fee ceiling pauses BEFORE the mint broadcast', async () => {
  await withTempLedger('mint-fee', async (ledger) => {
    const { row, txid } = claim(ledger, 836);
    const { deps, calls } = makeDeps({
      vaultRows: [vaultRow(txid, 836)],
      overrides: { estimateMintPins: async () => ({ totalSats: 6000 }) },
    });
    await expectCode(mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true }), 'FEE_CEILING_EXCEEDED');
    assert.equal(calls.mint, 0);
    assert.equal(ledger.rowById(row.id).state, 'claimed');
  });
});

test('mint-and-send refuses an un-claimed row and a second mint for the same tokenIndex', async () => {
  await withTempLedger('mint-guards', async (ledger) => {
    const { row } = detect(ledger, 837);
    await expectCode(
      mintAndSend({ ledger, album: ALBUM, row, deps: makeDeps().deps, broadcast: true }),
      'ROW_NOT_CLAIMED',
    );

    // A burned row already carries a minted pin for this tokenIndex; a later
    // (impossible in practice, but mechanically reachable) re-deposit must
    // never mint the number twice.
    const burned = sent(ledger, 838);
    ledger.enterBurnBatch(burned.row.id, 'b1');
    ledger.recordBurnBroadcast(burned.row.id, { batchId: 'b1', burnTxid: uniqueHex() });
    const { row: secondDeposit, txid } = claim(ledger, 838);
    const { deps, calls } = makeDeps({ vaultRows: [vaultRow(txid, 838)] });
    await expectCode(
      mintAndSend({ ledger, album: ALBUM, row: secondDeposit, deps, broadcast: true }),
      'TOKEN_INDEX_ALREADY_MINTED',
    );
    assert.equal(calls.mint, 0);
  });
});

// ---------------------------------------------------------------------------
// burn-batch
// ---------------------------------------------------------------------------

test('burn plan: only sent rows with a live vault outpoint are eligible', async () => {
  await withTempLedger('burn-plan', async (ledger) => {
    const eligible = sent(ledger, 841);
    const gone = sent(ledger, 842);
    const midFlight = minted(ledger, 843);
    const { deps } = makeDeps({ vaultRows: [vaultRow(eligible.txid, 841)] });
    const plan = await planBurnBatch({ ledger, deps });
    const byId = new Map(plan.candidates.map((c) => [c.ledgerId, c]));
    assert.deepEqual(plan.candidates.map((c) => c.ledgerId), [eligible.row.id, gone.row.id]);
    assert.equal(byId.get(eligible.row.id).eligible, true);
    assert.equal(byId.get(gone.row.id).eligible, false);
    assert.equal(byId.get(gone.row.id).reason, 'TOKEN_NOT_IN_VAULT');
    assert.equal(byId.has(midFlight.row.id), false);
    assert.equal(midFlight.row.state, 'minted');
  });
});

test('burn-batch dry-run plans without an owner flag; broadcast demands --confirm-owner', async () => {
  await withTempLedger('burn-gates', async (ledger) => {
    const { row, txid } = sent(ledger, 844);
    const deps = makeDeps({ vaultRows: [vaultRow(txid, 844)] });
    const plan = await runBurnBatch({ ledger, album: ALBUM, batchId: 'b-dry', deps: deps.deps, broadcast: false });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.plan.length, 1);
    assert.equal(deps.calls.burn, 0);

    await expectCode(
      runBurnBatch({ ledger, album: ALBUM, batchId: 'b-1', deps: deps.deps, broadcast: true, ownerConfirmed: false }),
      'OWNER_CONFIRMATION_REQUIRED',
    );
    assert.equal(deps.calls.burn, 0);
    assert.equal(ledger.rowById(row.id).state, 'sent');
  });
});

test('burn-batch happy path: sent → burn_pending → burned with the txid recorded', async () => {
  await withTempLedger('burn-happy', async (ledger) => {
    const { row, txid } = sent(ledger, 845);
    const { deps, calls } = makeDeps({ vaultRows: [vaultRow(txid, 845)] });
    const result = await runBurnBatch({
      ledger,
      album: ALBUM,
      batchId: 'b-20261117',
      deps,
      broadcast: true,
      ownerConfirmed: true,
      settleMs: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.burn, 1);
    assert.equal(result.executed.length, 1);
    assert.equal(result.executed[0].ledgerId, row.id);
    const stored = ledger.rowById(row.id);
    assert.equal(stored.state, 'burned');
    assert.equal(stored.burn_batch_id, 'b-20261117');
    assert.ok(stored.burn_txid);
    assert.equal(stored.fee_sats_json, JSON.stringify({ burn: 420 }));
    assert.deepEqual(ledger.burnCandidates(), []);
    const events = ledger.eventsFor(row.id).map((e) => e.event);
    assert.deepEqual(events.slice(-2), ['enter_burn_batch', 'burn_broadcast']);
  });
});

test('burn recovery: token gone with no txid blocks the batch (manual reconciliation)', async () => {
  await withTempLedger('burn-blocked', async (ledger) => {
    const { row } = sent(ledger, 846);
    ledger.enterBurnBatch(row.id, 'b-crash');
    const { deps, calls } = makeDeps({ vaultRows: [] });
    await expectCode(
      runBurnBatch({ ledger, album: ALBUM, batchId: 'b-crash', deps, broadcast: true, ownerConfirmed: true, settleMs: 0 }),
      'BURN_RECOVERY_TXID_UNKNOWN',
    );
    assert.equal(calls.burn, 0);
    assert.equal(ledger.rowById(row.id).state, 'burn_pending');
  });
});

test('burn recovery: burn_pending row with the token still in the vault is resumed once', async () => {
  await withTempLedger('burn-resume', async (ledger) => {
    const { row, txid } = sent(ledger, 847);
    ledger.enterBurnBatch(row.id, 'b-resume');
    const { deps, calls } = makeDeps({ vaultRows: [vaultRow(txid, 847)] });
    const result = await runBurnBatch({
      ledger,
      album: ALBUM,
      batchId: 'b-resume',
      deps,
      broadcast: true,
      ownerConfirmed: true,
      settleMs: 0,
    });
    assert.equal(calls.burn, 1);
    assert.deepEqual(result.resumed, [row.id]);
    assert.equal(ledger.rowById(row.id).state, 'burned');
  });
});

// ---------------------------------------------------------------------------
// transfer stability clock
// ---------------------------------------------------------------------------

test('waitForTransferStable requires the count to stay unchanged for the window', async () => {
  let now = 0;
  const clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  const ok = await waitForTransferStable({
    pinId: MINT_PIN,
    fetchItemInfo: async () => ({ transferCount: 1 }),
    minCount: 1,
    windowMs: 30_000,
    timeoutMs: 180_000,
    intervalMs: 5_000,
    clock,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.transferCount, 1);

  now = 0;
  const never = await waitForTransferStable({
    pinId: MINT_PIN,
    fetchItemInfo: async () => ({ transferCount: 0 }),
    minCount: 1,
    windowMs: 30_000,
    timeoutMs: 20_000,
    intervalMs: 5_000,
    clock,
  });
  assert.equal(never.ok, false);
  assert.equal(never.reason, 'TRANSFER_NOT_STABLE');
});

// ---------------------------------------------------------------------------
// metadata shape (PRD §7)
// ---------------------------------------------------------------------------

test('buildItemDisplay writes only mint-time values (no burnTxid slot)', () => {
  const display = buildItemDisplay({
    tokenIndex: 817,
    depositTxid: 'c'.repeat(64),
    album: ALBUM,
    cover: `metafile://${'e'.repeat(64)}i0`,
    partName: 'Left Wing',
  });
  assert.equal(display.name, 'MetaBot Avatar - Left Wing #817');
  assert.equal(display.metadata.custom.swap.mode, 'mrc721-mint-on-demand');
  assert.equal(display.metadata.custom.swap.from, 'MetaContract');
  assert.equal(display.metadata.custom.swap.tokenIndex, 817);
  assert.ok(!JSON.stringify(display).includes('burnTxid'));
});

// ---------------------------------------------------------------------------
// End-to-end ledger walk (M1 acceptance: the whole visible machine)
// ---------------------------------------------------------------------------

test('full lifecycle in one run: detected → claimed → minted → sent → burned', async () => {
  await withTempLedger('lifecycle', async (ledger) => {
    const { row, txid } = detect(ledger, 850);
    const { deps } = makeDeps({ vaultRows: [vaultRow(txid, 850)] });

    const claimed = await verifyAndClaim({
      ledger,
      album: ALBUM,
      row,
      claimantAddress: CLAIMANT,
      deps,
    });
    assert.equal(claimed.state, 'claimed');

    const delivered = await mintAndSend({ ledger, album: ALBUM, row, deps, broadcast: true });
    assert.equal(delivered.state, 'sent');
    assert.deepEqual(
      ledger.eventsFor(row.id).map((e) => e.to_state),
      ['detected', 'claimed', 'mint_pending', 'mint_pending', 'minted', 'send_pending', 'sent'],
    );

    const burned = await runBurnBatch({
      ledger,
      album: ALBUM,
      batchId: 'lifecycle-batch',
      deps,
      broadcast: true,
      ownerConfirmed: true,
      settleMs: 0,
    });
    assert.equal(burned.ok, true);
    assert.equal(ledger.rowById(row.id).state, 'burned');
    assert.deepEqual(ledger.eventsFor(row.id).map((e) => e.state ?? e.to_state).slice(-2), [
      'burn_pending',
      'burned',
    ]);
    assert.equal(ledger.reconCounts().burned, 1);
    assert.equal(ledger.reconCounts().sent, 1);
  });
});
