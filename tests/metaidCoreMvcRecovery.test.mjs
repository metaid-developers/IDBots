import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildMvcCreatePinSessionSnapshot,
  runMvcCreatePinWorkerWithSessionRecovery,
} = await import('../dist-electron/services/metaidCore.js');

const {
  getMvcSpendSessionSnapshot,
  recordMvcSpentOutpoints,
  resetMvcSpendSessionStateForTests,
} = await import('../dist-electron/services/mvcSpendSessionState.js');

test('buildMvcCreatePinSessionSnapshot does not recover pin funding when there are no stale exclusions', async () => {
  assert.equal(typeof buildMvcCreatePinSessionSnapshot, 'function');
  resetMvcSpendSessionStateForTests();
  let recoveryCalls = 0;

  const snapshot = await buildMvcCreatePinSessionSnapshot(
    {
      getMetabotById: () => ({ mvc_address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }),
      listRecentPinTransactionsByAddress: () => [
        { txid: 'a'.repeat(64), timestamp: 1_770_001_000 },
      ],
    },
    21,
    {
      recoverMvcFundingCandidates: async () => {
        recoveryCalls += 1;
        return [{
          txId: 'b'.repeat(64),
          outputIndex: 2,
          satoshis: 50_000,
          address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
          height: -1,
        }];
      },
    },
  );

  assert.equal(recoveryCalls, 0);
  assert.deepEqual(snapshot, {
    excludeOutpoints: [],
    preferredFundingUtxos: [],
  });
});

test('buildMvcCreatePinSessionSnapshot falls back to the provider snapshot when recovery fails', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 22;
  const staleOutpoint = `${'c'.repeat(64)}:0`;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  recordMvcSpentOutpoints(metabotId, [staleOutpoint]);

  let snapshot;
  try {
    snapshot = await buildMvcCreatePinSessionSnapshot(
      {
        getMetabotById: () => ({ mvc_address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }),
        listRecentPinTransactionsByAddress: () => [
          { txid: 'd'.repeat(64), timestamp: 1_770_001_000 },
        ],
      },
      metabotId,
      {
        recoverMvcFundingCandidates: async () => {
          throw new Error('local tx probe failed');
        },
      },
    );
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.deepEqual(snapshot, {
    excludeOutpoints: [staleOutpoint],
    preferredFundingUtxos: [],
  });
});

test('runMvcCreatePinWorkerWithSessionRecovery retries once with recovered funding after stale provider failure', async () => {
  assert.equal(typeof runMvcCreatePinWorkerWithSessionRecovery, 'function');
  resetMvcSpendSessionStateForTests();
  const metabotId = 23;
  const staleOutpoint = `${'e'.repeat(64)}:2`;
  const recoveredUtxo = {
    txId: 'f'.repeat(64),
    outputIndex: 1,
    satoshis: 50_000,
    address: 'mvc-address',
    height: -1,
  };
  const snapshots = [
    {
      excludeOutpoints: [],
      preferredFundingUtxos: [],
    },
    {
      excludeOutpoints: [staleOutpoint],
      preferredFundingUtxos: [recoveredUtxo],
    },
  ];
  const seenSnapshots = [];

  const result = await runMvcCreatePinWorkerWithSessionRecovery({
    metabotStore: {},
    metabotId,
    buildSessionSnapshot: async () => snapshots.shift(),
    runWorkerForSession: async (snapshot) => {
      seenSnapshots.push(snapshot);
      if (seenSnapshots.length === 1) {
        throw Object.assign(
          new Error('MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.'),
          { staleOutpoints: [staleOutpoint] },
        );
      }
      return {
        txids: ['1'.repeat(64)],
        pinId: `${'1'.repeat(64)}i0`,
        totalCost: 900,
        spentOutpoints: [`${recoveredUtxo.txId}:${recoveredUtxo.outputIndex}`],
        changeUtxo: null,
      };
    },
  });

  assert.equal(result.workerResult.pinId, `${'1'.repeat(64)}i0`);
  assert.equal(result.retriedAfterStaleFunding, true);
  assert.deepEqual(seenSnapshots, [
    {
      excludeOutpoints: [],
      preferredFundingUtxos: [],
    },
    {
      excludeOutpoints: [staleOutpoint],
      preferredFundingUtxos: [recoveredUtxo],
    },
  ]);
  assert.deepEqual(getMvcSpendSessionSnapshot(metabotId).excludeOutpoints, [staleOutpoint]);
});
