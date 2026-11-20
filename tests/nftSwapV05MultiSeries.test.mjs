import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { SwapLedger } from '../SKILLs/nft-swap/cli/lib/swap-ledger.mjs';
import {
  DEFAULT_COLLECTION_SLUG,
  albumFromSeries,
  registerSeries,
  resolveSeries,
} from '../SKILLs/nft-swap/cli/lib/series-registry.mjs';
import { MVP_CONFIRMATIONS, pollVault } from '../SKILLs/nft-swap/cli/lib/vault-poll-lib.mjs';
import { handleClaimMessage } from '../SKILLs/nft-swap/cli/lib/claim-handler.mjs';

function withTempLedgerDir(name, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), `nft-swap-v05-${name}-`));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // leftover temp dirs are harmless on Windows CI
    }
  }
}

test('v0.5 MVP_CONFIRMATIONS defaults to 1 block confirmation', () => {
  assert.equal(MVP_CONFIRMATIONS, 1);
});

test('v0.5 ledger migration upgrades pre-0.5 swap_ledger seamlessly and allows same tokenIndex across two series', () => {
  withTempLedgerDir('migrate-multiseries', (dir) => {
    const dbPath = path.join(dir, 'legacy-v04.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE swap_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        genesis TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        token_index INTEGER NOT NULL,
        state TEXT NOT NULL,
        sensible_id TEXT,
        deposit_txid TEXT,
        deposit_vout INTEGER,
        deposit_outpoint TEXT UNIQUE,
        deposit_height INTEGER,
        detected_at INTEGER,
        claim_channel TEXT,
        claim_message_id TEXT,
        claimant_address TEXT,
        claimed_at INTEGER,
        item_path TEXT,
        mint_pin_id TEXT,
        item_desc_pin_id TEXT,
        mint_txids TEXT,
        dual_check_json TEXT,
        minted_at INTEGER,
        confirm_json TEXT,
        transfer_txid TEXT,
        transfer_count INTEGER,
        transfer_stable_since INTEGER,
        sent_at INTEGER,
        burn_batch_id TEXT,
        burn_txid TEXT,
        burned_at INTEGER,
        reject_reason TEXT,
        refund_txid TEXT,
        refunded_at INTEGER,
        fee_sats_json TEXT,
        notes TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO swap_ledger (
        genesis, code_hash, token_index, state, deposit_txid, deposit_vout, deposit_outpoint, updated_at
      ) VALUES (
        '005d69cba8c80e6978157e146f998c21288a9d49',
        'e205939ad9956673ce7da9fbd40514b30f66dc35',
        42,
        'sent',
        '${'11'.repeat(32)}',
        0,
        '${'11'.repeat(32)}:0',
        1700000000000
      );
    `);
    seed.close();

    const ledger = new SwapLedger(dbPath);
    try {
      const cols = ledger.db.prepare('PRAGMA table_info(swap_ledger)').all().map((c) => c.name);
      assert.ok(cols.includes('collection_slug'));

      const existing = ledger.rowById(1);
      assert.equal(existing.collection_slug, DEFAULT_COLLECTION_SLUG);
      assert.equal(existing.state, 'sent');
      assert.equal(existing.token_index, 42);

      // Register a second series and insert token_index=42 under that second series without conflict
      registerSeries({
        collectionSlug: 'second-series-v05',
        collectionPinId: `${'bb'.repeat(32)}i0`,
        codeHash: 'aa'.repeat(20),
        genesis: 'bb'.repeat(20),
        tokenSupply: 500,
        issuerAddress: '1SecondIssuer1111111111111111111111',
        vaultAddress: '1SecondVault11111111111111111111111',
        burnAddress: '1111111111111111111114oLvT2',
        itemPathPattern: '/nft/mrc721/second-series/item-{index4}',
        titleTemplate: 'Second Series #{index}',
        minConfirmations: 1,
      });

      const secondOut = ledger.recordDetection({
        collectionSlug: 'second-series-v05',
        genesis: 'bb'.repeat(20),
        codeHash: 'aa'.repeat(20),
        tokenIndex: 42,
        depositTxid: '22'.repeat(32),
        depositVout: 0,
        depositHeight: 900_000,
      });
      assert.equal(secondOut.created, true);
      assert.equal(secondOut.row.state, 'detected');
      assert.equal(secondOut.row.collection_slug, 'second-series-v05');
    } finally {
      ledger.close();
    }
  });
});

test('pollVault admits 1-confirmation deposit under v0.5 default minConfirmations', async () => {
  await withTempLedgerDir('poll-1conf', async (dir) => {
    const ledger = new SwapLedger(path.join(dir, 'ledger.sqlite'));
    try {
      const series = resolveSeries({ collectionSlug: DEFAULT_COLLECTION_SLUG });
      const album = albumFromSeries(series);
      const txid = '33'.repeat(32);
      const fetchImpl = async () => ({
        json: async () => ({
          code: 0,
          data: {
            list: [
              {
                txId: txid,
                txIndex: 0,
                genesis: album.genesis,
                codeHash: album.codeHash,
                tokenIndex: 99,
                height: 850_000,
              },
            ],
          },
        }),
      });
      const result = await pollVault({
        ledger,
        album,
        vaultAddress: series.vaultAddress,
        chainTipHeight: 850_000, // exactly 1 confirmation!
        fetchImpl,
      });
      assert.equal(result.newDeposits.length, 1);
      assert.equal(result.newDeposits[0].tokenIndex, 99);
      assert.equal(result.unconfirmed.length, 0);
    } finally {
      ledger.close();
    }
  });
});

test('handleClaimMessage returns SWAP_STATUS_V1 (pending_1_conf) on 0-conf and SWAP_COMPLETED_V1 on fulfillment', async () => {
  await withTempLedgerDir('claim-handler', async (dir) => {
    const ledger = new SwapLedger(path.join(dir, 'ledger.sqlite'));
    try {
      const series = resolveSeries({ collectionSlug: DEFAULT_COLLECTION_SLUG });
      const album = albumFromSeries(series);
      const txid0 = '44'.repeat(32);
      const txid1 = '55'.repeat(32);

      // Seed 101 as detected (0-conf simulated via INSUFFICIENT_CONFIRMATIONS) and 102 as already sent
      ledger.recordDetection({
        collectionSlug: series.collectionSlug,
        genesis: album.genesis,
        codeHash: album.codeHash,
        tokenIndex: 101,
        depositTxid: txid0,
        depositVout: 0,
        depositHeight: -1,
      });

      const pendingRow = ledger.recordDetection({
        collectionSlug: series.collectionSlug,
        genesis: album.genesis,
        codeHash: album.codeHash,
        tokenIndex: 102,
        depositTxid: txid1,
        depositVout: 0,
        depositHeight: 850_000,
      }).row;
      ledger.claim(pendingRow.id, { channel: 'a2a', messageId: 'req-done', claimantAddress: '1UserAddr' });
      ledger.recordMintBroadcast(pendingRow.id, {
        itemPath: 'item-0102',
        mintPinId: `${'66'.repeat(32)}i0`,
        txids: ['77'.repeat(32)],
      });
      ledger.recordMintConfirmed(pendingRow.id, { creatorMinted: true, createAddressMatch: true, outputValue: 1 });
      ledger.recordTransferBroadcast(pendingRow.id, { transferTxid: '88'.repeat(32) });
      ledger.recordTransferStable(pendingRow.id, { transferCount: 2 });

      const pendingResp = await handleClaimMessage({
        ledger,
        rawMessage: [
          '```idbots-swap-v1',
          JSON.stringify({
            type: 'SWAP_CLAIM_V1',
            requestId: 'req-pending',
            collectionSlug: series.collectionSlug,
            codehash: album.codeHash,
            genesis: album.genesis,
            recipientAddress: '1UserAddr',
            recipientGlobalMetaId: 'idq1user000000000000000000000000000000',
            items: [{ tokenIndex: '101', depositTxId: txid0 }],
          }),
          '```',
        ].join('\n'),
        broadcast: true,
        deps: {
          fetchImpl: async () => ({
            json: async () => ({
              code: 0,
              data: {
                list: [
                  {
                    txId: txid0,
                    txIndex: 0,
                    genesis: album.genesis,
                    codeHash: album.codeHash,
                    tokenIndex: 101,
                    height: -1,
                  },
                ],
              },
            }),
          }),
          fetchConfirmations: async () => 0,
        },
      });
      assert.equal(pendingResp.ok, true);
      assert.equal(pendingResp.pending, true);
      assert.equal(pendingResp.replyPayload.type, 'SWAP_STATUS_V1');
      assert.equal(pendingResp.replyPayload.status, 'pending_1_conf');

      const completedResp = await handleClaimMessage({
        ledger,
        rawMessage: [
          '```idbots-swap-v1',
          JSON.stringify({
            type: 'SWAP_CLAIM_V1',
            requestId: 'req-done',
            collectionSlug: series.collectionSlug,
            codehash: album.codeHash,
            genesis: album.genesis,
            recipientAddress: '1UserAddr',
            recipientGlobalMetaId: 'idq1user000000000000000000000000000000',
            items: [{ tokenIndex: '102', depositTxId: txid1 }],
          }),
          '```',
        ].join('\n'),
        broadcast: true,
        deps: {
          fetchImpl: async () => ({
            json: async () => ({
              code: 0,
              data: { list: [] },
            }),
          }),
        },
      });
      assert.equal(completedResp.ok, true);
      assert.equal(completedResp.pending, false);
      assert.equal(completedResp.replyPayload.type, 'SWAP_COMPLETED_V1');
      assert.equal(completedResp.replyPayload.results[0].status, 'completed');
      assert.equal(completedResp.replyPayload.results[0].itemPinId, `${'66'.repeat(32)}i0`);
      assert.match(completedResp.replyText, /```idbots-swap-v1/);
    } finally {
      ledger.close();
    }
  });
});
