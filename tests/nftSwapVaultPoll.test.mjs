import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SwapLedger } from '../SKILLs/nft-swap/cli/lib/swap-ledger.mjs';
import { classifyVaultRows, fetchVaultTokenRows, pollVault, VAULT_POLL_PAGE_CAP } from '../SKILLs/nft-swap/cli/lib/vault-poll-lib.mjs';

const ALBUM = {
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  codeHash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  sensibleId: '4e7a7d3e3e748c09f1eff46fe504c5fdc389014eab3e316685004d770225ea53 00000000',
  tokenSupply: 9560,
};
const VAULT = '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET';

const albumRow = (tokenIndex, txidSeed, height = 800_000) => ({
  txid: (txidSeed ?? `${String(tokenIndex).padStart(4, '0')}a`).padEnd(64, '0'),
  outIndex: 0,
  genesis: ALBUM.genesis,
  codehash: ALBUM.codehash ?? ALBUM.codeHash,
  tokenIndex,
  sensibleId: ALBUM.sensibleId,
  height,
  satoshis: 1,
  flag: undefined,
});

async function withTempLedger(name, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), `nft-swap-vault-${name}-`));
  const ledger = new SwapLedger(path.join(dir, 'ledger.sqlite'));
  try {
    return await fn(ledger);
  } finally {
    ledger.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function fakeApi(pages) {
  // pages: array of { list, nextFlag } — served in order per flag state
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => ({
      json: async () => {
        calls.push(String(url));
        const page = pages[Math.min(calls.length - 1, pages.length - 1)];
        // the real API attaches the cursor to each ROW (mvcNftService reads list[last].flag)
        const list = page.list.map((r, i) => (i === page.list.length - 1 && page.nextFlag ? { ...r, flag: page.nextFlag } : r));
        return { code: 0, data: { list } };
      },
    }),
  };
}

test('fetchVaultTokenRows paginates via flag cursor until exhausted', async () => {
  const { fetchImpl, calls } = fakeApi([
    { list: [albumRow(1, 'a1'), albumRow(2, 'a2')], nextFlag: 'cursor-1' },
    { list: [albumRow(3, 'a3')], nextFlag: 'cursor-2' },
    { list: [], nextFlag: undefined },
  ]);
  const rows = await fetchVaultTokenRows({ address: VAULT, fetchImpl });
  assert.equal(rows.length, 3);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /address=/);
  assert.doesNotMatch(calls[0], /flag=/);
  assert.match(calls[1], /flag=cursor-1/);
  assert.match(calls[2], /flag=cursor-2/);
});

test('fetchVaultTokenRows stops when the flag stops advancing (house termination)', async () => {
  const { fetchImpl, calls } = fakeApi([
    { list: [albumRow(1)], nextFlag: 'stuck' },
    { list: [albumRow(2)], nextFlag: 'stuck' }, // same flag → must stop
    { list: [albumRow(3)], nextFlag: 'stuck' },
  ]);
  const rows = await fetchVaultTokenRows({ address: VAULT, fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(calls.length, 2);
});

test('fetchVaultTokenRows enforces the 50-page hard cap', async () => {
  let seq = 0;
  const calls = [];
  const fetchImpl = async () => {
    seq += 1;
    calls.push(seq);
    return {
      json: async () => ({
        code: 0,
        // zero-padded seed: `p1` + zero padding would collide with `p10`
        data: { list: [{ ...albumRow(seq, `p${String(seq).padStart(3, '0')}`), flag: `f${seq}` }] },
      }),
    };
  };
  const rows = await fetchVaultTokenRows({ address: VAULT, fetchImpl });
  assert.equal(rows.length, VAULT_POLL_PAGE_CAP);
  assert.equal(calls.length, VAULT_POLL_PAGE_CAP);
});

test('classify splits album matches from foreign rows (sensibleId fallback tolerated)', () => {
  const rows = [
    albumRow(817),
    { ...albumRow(9561), genesis: 'ff', codehash: 'ee' },              // out of range + wrong triple
    { ...albumRow(700), sensibleId: 'different' },                     // triple ok → still matched
  ];
  const { matched, foreign } = classifyVaultRows(rows, ALBUM);
  assert.equal(matched.length, 2);
  assert.equal(foreign.length, 1);
});

test('pollVault records matured deposits and defers unconfirmed (6-conf MVP)', async () => {
  await withTempLedger('conf', async (ledger) => {
    const { fetchImpl } = fakeApi([
      {
        list: [albumRow(817, 'm1', 800_000), albumRow(818, 'm2', -1)], // mined vs mempool
        nextFlag: undefined,
      },
    ]);
    const result = await pollVault({
      ledger,
      album: ALBUM,
      vaultAddress: VAULT,
      chainTipHeight: 800_005, // mined row = 6 confs exactly
      fetchImpl,
    });
    assert.equal(result.newDeposits.length, 1);
    assert.equal(result.newDeposits[0].tokenIndex, 817);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.unconfirmed[0].confirmations, 0); // mempool
    assert.equal(ledger.rowsByStates(['detected']).length, 1);

    // second pass at tip+5: the mempool row matured and gets recorded
    const { fetchImpl: fetch2 } = fakeApi([{ list: [albumRow(818, 'm2', 800_005)], nextFlag: undefined }]);
    const second = await pollVault({ ledger, album: ALBUM, vaultAddress: VAULT, chainTipHeight: 800_010, fetchImpl: fetch2 });
    assert.equal(second.newDeposits.length, 1);
    assert.equal(second.newDeposits[0].tokenIndex, 818);
  });
});

test('pollVault records foreign tokens as rejected and never re-records known outpoints', async () => {
  await withTempLedger('foreign', async (ledger) => {
    const { fetchImpl } = fakeApi([
      {
        list: [
          albumRow(819, 'ok1'),
          { ...albumRow(1, 'fg1'), genesis: 'ffff', codehash: 'eeee' }, // foreign album
        ],
        nextFlag: undefined,
      },
    ]);
    const first = await pollVault({ ledger, album: ALBUM, vaultAddress: VAULT, chainTipHeight: 800_005, fetchImpl });
    assert.equal(first.newDeposits.length, 1);
    assert.equal(first.foreign.length, 1);
    assert.equal(ledger.rowsByStates(['rejected']).length, 1);
    assert.match(ledger.rowsByStates(['rejected'])[0].reject_reason, /foreign token/);

    // re-poll the same content: no new rows (outpoint dedup)
    const second = await pollVault({ ledger, album: ALBUM, vaultAddress: VAULT, chainTipHeight: 800_005, fetchImpl });
    assert.equal(second.newDeposits.length, 0);
    assert.equal(second.foreign.length, 0);
  });
});

test('pollVault flags a duplicate active deposit as rejected (single-lock) while keeping the first', async () => {
  await withTempLedger('dup', async (ledger) => {
    const { fetchImpl } = fakeApi([
      { list: [albumRow(55, 'd1'), albumRow(55, 'd2')], nextFlag: undefined },
    ]);
    const result = await pollVault({ ledger, album: ALBUM, vaultAddress: VAULT, chainTipHeight: 800_005, fetchImpl });
    assert.equal(result.newDeposits.length, 1);
    const states = ledger.rowsByStates(['detected', 'rejected']).map((r) => r.state).sort();
    assert.deepEqual(states, ['detected', 'rejected']);
  });
});

test('utxo-list server error propagates (no silent empty-vault success)', async () => {
  const fetchImpl = async () => ({ json: async () => ({ code: 500, message: 'boom' }) });
  await assert.rejects(
    () => fetchVaultTokenRows({ address: VAULT, fetchImpl }),
    /utxo-list failed/,
  );
});

// Verbatim wallet-api v4 payload, fetched 2026-11-16 from
// /wallet-api/v4/mvc/address/contract/nft/utxo-list?net=livenet&address=<vault>.
// The real wire names are camelCase (txId / txIndex / codeHash / satoshi); the
// deposit was still in the mempool at fetch time, hence height -1.
const REAL_V4_ROW_2671 = {
  address: VAULT,
  txId: 'cffd1f5514c5289adf3b1e15d45011dfaa2db403d8a2d9f41e85e1ec79e4e5d7',
  txIndex: 0,
  codeHash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  sensibleId: '4e7a7d3e3e748c09f1eff46fe504c5fdc389014eab3e316685004d770225ea5300000000',
  height: -1,
  metaTxId: '45988353a6933f5fb3700691a3ffb54621fe42f8f7be2208832dfa7fd49d3ee5',
  metaOutputIndex: 0,
  tokenSupply: 9560,
  tokenIndex: 2671,
  satoshi: 4101,
  satoshiString: '4101',
  name: 'MetaBot Avatar - Arms 8',
};

test('fetchVaultTokenRows normalizes the real v4 camelCase payload (txId/txIndex/codeHash)', async () => {
  const { fetchImpl } = fakeApi([{ list: [REAL_V4_ROW_2671], nextFlag: undefined }]);
  const rows = await fetchVaultTokenRows({ address: VAULT, fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].txid, REAL_V4_ROW_2671.txId);
  assert.equal(rows[0].outIndex, 0);
  assert.equal(rows[0].codehash, REAL_V4_ROW_2671.codeHash);
  assert.equal(rows[0].tokenIndex, 2671);

  // 2026-11-16 regression: this row was classified foreign because the empty
  // normalization made the triple compare blank-vs-blank.
  const { matched, foreign } = classifyVaultRows(rows, ALBUM);
  assert.equal(foreign.length, 0);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].txid, REAL_V4_ROW_2671.txId);

  await withTempLedger('v4-shape', async (ledger) => {
    const { fetchImpl: fetchAgain } = fakeApi([{ list: [REAL_V4_ROW_2671], nextFlag: undefined }]);
    const result = await pollVault({
      ledger,
      album: ALBUM,
      vaultAddress: VAULT,
      fetchImpl: fetchAgain,
      confirmationsResolver: async () => 6, // production path: manapi /api/tx/status
    });
    assert.equal(result.foreign.length, 0);
    assert.equal(result.newDeposits.length, 1);
    assert.equal(result.newDeposits[0].tokenIndex, 2671);
    assert.equal(ledger.rowsByStates(['rejected']).length, 0);
  });
});

test('fetchVaultTokenRows dedupes an outpoint repeated across flag pages (real flag="0" replay)', async () => {
  // Measured 2026-11-16: page 1 returns the row carrying flag "0"; the flag=0
  // follow-up page returns the very same row and the cursor stops advancing.
  // Before the fix this reported scanned=2 for a single deposit.
  const { fetchImpl, calls } = fakeApi([
    { list: [REAL_V4_ROW_2671], nextFlag: '0' },
    { list: [REAL_V4_ROW_2671], nextFlag: '0' },
  ]);
  const rows = await fetchVaultTokenRows({ address: VAULT, fetchImpl });
  assert.equal(calls.length, 2); // both pages really were fetched
  assert.match(calls[1], /flag=0/);
  assert.equal(rows.length, 1);
  assert.equal(`${rows[0].txid}:${rows[0].outIndex}`, `${REAL_V4_ROW_2671.txId}:0`);

  await withTempLedger('v4-dedupe', async (ledger) => {
    const { fetchImpl: fetchAgain } = fakeApi([
      { list: [REAL_V4_ROW_2671], nextFlag: '0' },
      { list: [REAL_V4_ROW_2671], nextFlag: '0' },
    ]);
    const result = await pollVault({
      ledger,
      album: ALBUM,
      vaultAddress: VAULT,
      fetchImpl: fetchAgain,
      confirmationsResolver: async () => 6,
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.newDeposits.length, 1);
    // the duplicate used to surface a second time as an already-tracked "matured" row
    assert.equal(result.matured.length, 0);
  });
});

test('pollVault prefers the authoritative per-tx confirmation resolver over height math', async () => {
  await withTempLedger('resolver', async (ledger) => {
    const { fetchImpl } = fakeApi([{ list: [albumRow(900, 'r1', 800_000)], nextFlag: undefined }]);
    const seen = [];
    const result = await pollVault({
      ledger,
      album: ALBUM,
      vaultAddress: VAULT,
      minConfirmations: 6,
      chainTipHeight: 800_005, // height math alone would call this matured
      fetchImpl,
      confirmationsResolver: async (txid) => {
        seen.push(txid);
        return 2; // but the chain reports only 2 confirmations
      },
    });
    assert.deepEqual(seen, ['r1'.padEnd(64, '0')]);
    assert.equal(result.newDeposits.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.unconfirmed[0].confirmations, 2);
    assert.equal(ledger.rowsByStates(['detected']).length, 0);
  });
});
