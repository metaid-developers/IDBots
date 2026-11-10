import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SwapLedger, LEDGER_STATES } from '../SKILLs/nft-swap/cli/lib/swap-ledger.mjs';

const ALBUM = {
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  codeHash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
};

/** House discipline: close the store first, then best-effort rm (Windows CI). */
function withTempLedger(name, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), `nft-swap-ledger-${name}-`));
  const ledger = new SwapLedger(path.join(dir, 'ledger.sqlite'));
  try {
    return fn(ledger);
  } finally {
    ledger.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // leftover temp dirs are harmless
    }
  }
}

const deposit = (tokenIndex, txidSeed) => ({
  genesis: ALBUM.genesis,
  codeHash: ALBUM.codeHash,
  tokenIndex,
  depositTxid: txidSeed ?? `${String(tokenIndex).padStart(4, '0')}f`.padEnd(64, '0'),
  depositVout: 0,
  depositHeight: 800_000,
});

test('happy path walks the full visible machine with pending states', () => {
  withTempLedger('happy', (ledger) => {
    const { row } = ledger.recordDetection(deposit(817));
    assert.equal(row.state, 'detected');

    ledger.claim(row.id, { channel: 'chat', messageId: 'msg-1', claimantAddress: '1UserAddr' });
    ledger.recordMintBroadcast(row.id, {
      itemPath: 'item-0817',
      mintPinId: 'a'.repeat(64) + 'i0',
      txids: ['b'.repeat(64)],
      dualCheck: { ledgerPlaceholder: true, itemPathPlaceholder: true },
    });
    assert.equal(ledger.rowById(row.id).state, 'mint_pending');

    ledger.recordMintConfirmed(row.id, { creatorMinted: true, createAddressMatch: true, outputValue: 1 });
    ledger.recordTransferBroadcast(row.id, { transferTxid: 'c'.repeat(64) });
    ledger.recordTransferStable(row.id, { transferCount: 2 });
    assert.equal(ledger.rowById(row.id).state, 'sent');

    assert.deepEqual(ledger.burnCandidates().map((r) => r.id), [row.id]);
    ledger.enterBurnBatch(row.id, 'batch-1');
    assert.equal(ledger.rowById(row.id).state, 'burn_pending');
    ledger.recordBurnBroadcast(row.id, { batchId: 'batch-1', burnTxid: 'd'.repeat(64), feeSats: 400 });
    assert.equal(ledger.rowById(row.id).state, 'burned');
    assert.deepEqual(ledger.burnCandidates(), []);

    // every step left one event row (每步一条链证据)
    const events = ledger.eventsFor(row.id).map((e) => e.event);
    assert.deepEqual(events, [
      'detected',
      'claim',
      'mint_broadcast',
      'mint_confirmed',
      'transfer_broadcast',
      'transfer_stable',
      'enter_burn_batch',
      'burn_broadcast',
    ]);
  });
});

test('tokenIndex single-lock: second deposit while active is rejected', () => {
  withTempLedger('single-lock', (ledger) => {
    const first = ledger.recordDetection(deposit(42)).row;
    ledger.claim(first.id, { channel: 'chat', messageId: 'm', claimantAddress: 'x' });
    const dup = ledger.recordDetection(deposit(42, 'e'.repeat(64))).row;
    assert.equal(dup.state, 'rejected');
    assert.match(dup.reject_reason, /duplicate deposit/);
    // refunded/burned/rejected rows do not block: after full refund cycle, redetect works
    ledger.reject(first.id, 'test');
    ledger.refund(first.id, { refundTxid: 'f'.repeat(64) });
    const again = ledger.recordDetection(deposit(42, 'a'.repeat(63) + '1')).row;
    assert.equal(again.state, 'detected');
  });
});

test('same outpoint re-seen refreshes instead of duplicating', () => {
  withTempLedger('outpoint-dedup', (ledger) => {
    const d = deposit(7);
    const first = ledger.recordDetection(d).row;
    const second = ledger.recordDetection({ ...d, depositHeight: 800_001 });
    assert.equal(second.created, false);
    assert.equal(second.row.id, first.id);
    assert.equal(ledger.rowById(first.id).deposit_height, 800_001);
  });
});

test('illegal transitions throw and leave state untouched', () => {
  withTempLedger('illegal', (ledger) => {
    const { row } = ledger.recordDetection(deposit(9));
    assert.throws(() => ledger.recordTransferStable(row.id, { transferCount: 1 }), /illegal ledger transition/);
    assert.throws(() => ledger.recordBurnBroadcast(row.id, { batchId: 'b', burnTxid: '1'.repeat(64) }), /illegal ledger transition/);
    assert.equal(ledger.rowById(row.id).state, 'detected');
  });
});

test('crash recovery: mint_pending row keeps pinId and may only advance to minted', () => {
  withTempLedger('crash', (ledger) => {
    const { row } = ledger.recordDetection(deposit(100));
    ledger.claim(row.id, { channel: 'chat', messageId: 'm', claimantAddress: 'x' });
    ledger.recordMintBroadcast(row.id, { itemPath: 'item-0100', mintPinId: 'a'.repeat(64) + 'i0', txids: [] });
    // simulated crash: engine died after broadcast. Recovery resumes from the
    // recorded pinId (no API here re-mints) and confirms into minted.
    const recovered = ledger.rowById(row.id);
    assert.equal(recovered.state, 'mint_pending');
    assert.equal(recovered.mint_pin_id, 'a'.repeat(64) + 'i0');
    // and a re-deposit of the same index while mint_pending is blocked:
    const dup = ledger.recordDetection(deposit(100, '9'.repeat(64))).row;
    assert.equal(dup.state, 'rejected');
    ledger.recordMintConfirmed(row.id, { creatorMinted: true });
    assert.equal(ledger.rowById(row.id).state, 'minted');
    // minted rows may never jump straight to sent (must go through send_pending)
    assert.throws(() => ledger.recordTransferStable(row.id, { transferCount: 1 }), /illegal/);
  });
});

test('refund demands a plain 64-hex txid; redetect is the only way back to detected', () => {
  withTempLedger('refund', (ledger) => {
    const { row } = ledger.recordDetection(deposit(5));
    ledger.reject(row.id, 'foreign');
    assert.throws(() => ledger.refund(row.id, { refundTxid: 'not-a-txid' }), /64-hex/);
    ledger.refund(row.id, { refundTxid: 'f'.repeat(64) });
    assert.equal(ledger.rowById(row.id).state, 'refunded');
    // redetect (user re-deposits after refund)
    const redetected = ledger.redetectAfterRefund(row.id, {
      depositTxid: '1'.repeat(64),
      depositVout: 1,
      depositHeight: 800_500,
    });
    assert.equal(redetected.state, 'detected');
    assert.equal(redetected.deposit_outpoint, `${'1'.repeat(64)}:1`);
  });
});

test('recon counts follow the official/sent/holding definitions', () => {
  withTempLedger('recon', (ledger) => {
    const d1 = ledger.recordDetection(deposit(1)).row;          // vault holding
    const d2 = ledger.recordDetection(deposit(2)).row;
    const d3 = ledger.recordDetection(deposit(3)).row;
    const d4 = ledger.recordDetection(deposit(4)).row;
    // d1: sent
    ledger.claim(d1.id, { channel: 'chat', messageId: 'm', claimantAddress: 'x' });
    ledger.recordMintBroadcast(d1.id, { itemPath: 'item-0001', mintPinId: 'a'.repeat(64) + 'i0', txids: [] });
    ledger.recordMintConfirmed(d1.id, {});
    ledger.recordTransferBroadcast(d1.id, { transferTxid: 'c'.repeat(64) });
    ledger.recordTransferStable(d1.id, { transferCount: 1 });
    // d2: burned
    ledger.claim(d2.id, { channel: 'chat', messageId: 'm', claimantAddress: 'x' });
    ledger.recordMintBroadcast(d2.id, { itemPath: 'item-0002', mintPinId: 'b'.repeat(64) + 'i0', txids: [] });
    ledger.recordMintConfirmed(d2.id, {});
    ledger.recordTransferBroadcast(d2.id, { transferTxid: 'd'.repeat(64) });
    ledger.recordTransferStable(d2.id, { transferCount: 1 });
    ledger.enterBurnBatch(d2.id, 'b1');
    ledger.recordBurnBroadcast(d2.id, { batchId: 'b1', burnTxid: 'e'.repeat(64) });
    // d3: minted
    ledger.claim(d3.id, { channel: 'chat', messageId: 'm', claimantAddress: 'x' });
    ledger.recordMintBroadcast(d3.id, { itemPath: 'item-0003', mintPinId: 'f'.repeat(64) + 'i0', txids: [] });
    ledger.recordMintConfirmed(d3.id, {});
    // d4: rejected
    ledger.reject(d4.id, 'foreign');

    const counts = ledger.reconCounts();
    assert.equal(counts.officialMinted, 3); // sent + burned + minted (pin recorded)
    assert.equal(counts.sent, 2);           // sent + burned
    assert.equal(counts.vaultHolding, 2);   // minted + sent (burned has left the vault)
    assert.equal(counts.burned, 1);
    assert.equal(counts.rejected, 1);
  });
});

test('all states are enumerated and detectable rows list by state', () => {
  withTempLedger('enumerate', (ledger) => {
    assert.ok(LEDGER_STATES.includes('mint_pending'));
    const { row } = ledger.recordDetection(deposit(11));
    assert.deepEqual(ledger.rowsByStates(['detected']).map((r) => r.id), [row.id]);
  });
});
