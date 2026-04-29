import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildMvcTransferSessionSnapshot,
  runMvcTransferWorkerWithSessionRecovery,
} = await import('../dist-electron/services/transferService.js');

const {
  getMvcSpendSessionSnapshot,
  recordMvcSpentOutpoints,
  resetMvcSpendSessionStateForTests,
} = await import('../dist-electron/services/mvcSpendSessionState.js');

test('buildMvcTransferSessionSnapshot recovers local pin change outputs when provider funding is excluded as stale', async () => {
  assert.equal(typeof buildMvcTransferSessionSnapshot, 'function');
  resetMvcSpendSessionStateForTests();
  const metabotId = 8;
  const mvcAddress = '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx';
  const staleOutpoint = `${'a'.repeat(64)}:0`;
  const recoveredUtxo = {
    txId: 'b'.repeat(64),
    outputIndex: 2,
    satoshis: 50_000,
    address: mvcAddress,
    height: -1,
  };
  const recentPinTransactions = [
    { txid: 'c'.repeat(64), timestamp: 1_770_001_000 },
  ];
  const recoveryCalls = [];
  const originalLog = console.log;
  console.log = () => {};

  recordMvcSpentOutpoints(metabotId, [staleOutpoint]);

  let snapshot;
  try {
    snapshot = await buildMvcTransferSessionSnapshot(
      {
        getMetabotById: (id) => (id === metabotId ? { mvc_address: mvcAddress } : null),
        listRecentPinTransactionsByAddress: (address, limit) => {
          recoveryCalls.push({ address, limit });
          return recentPinTransactions;
        },
      },
      metabotId,
      {
        recoverMvcFundingCandidates: async (params) => {
          recoveryCalls.push({
            recentPinTransactions: params.recentPinTransactions,
            excludedOutpoints: params.excludedOutpoints,
          });
          return [recoveredUtxo];
        },
      },
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(snapshot.excludeOutpoints, [staleOutpoint]);
  assert.deepEqual(snapshot.preferredFundingUtxos, [recoveredUtxo]);
  assert.deepEqual(recoveryCalls, [
    { address: mvcAddress, limit: 8 },
    {
      recentPinTransactions,
      excludedOutpoints: [staleOutpoint],
    },
  ]);

  assert.deepEqual(getMvcSpendSessionSnapshot(metabotId).preferredFundingUtxos, []);
});

test('buildMvcTransferSessionSnapshot does not recover pin funding when there are no stale exclusions', async () => {
  resetMvcSpendSessionStateForTests();
  let recoveryCalls = 0;

  const snapshot = await buildMvcTransferSessionSnapshot(
    {
      getMetabotById: () => ({ mvc_address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }),
      listRecentPinTransactionsByAddress: () => [
        { txid: 'd'.repeat(64), timestamp: 1_770_001_000 },
      ],
    },
    9,
    {
      recoverMvcFundingCandidates: async () => {
        recoveryCalls += 1;
        return [{
          txId: 'e'.repeat(64),
          outputIndex: 1,
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

test('buildMvcTransferSessionSnapshot falls back to the provider snapshot when recovery fails', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 10;
  const staleOutpoint = `${'f'.repeat(64)}:0`;
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};

  recordMvcSpentOutpoints(metabotId, [staleOutpoint]);

  let snapshot;
  try {
    snapshot = await buildMvcTransferSessionSnapshot(
      {
        getMetabotById: () => ({ mvc_address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }),
        listRecentPinTransactionsByAddress: () => [
          { txid: '1'.repeat(64), timestamp: 1_770_001_000 },
        ],
      },
      metabotId,
      {
        recoverMvcFundingCandidates: async () => {
          throw new Error('local tx probe failed');
        },
        recoverMvcAddressHistoryFundingCandidates: async () => {
          throw new Error('address tx probe failed');
        },
      },
    );
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }

  assert.deepEqual(snapshot, {
    excludeOutpoints: [staleOutpoint],
    preferredFundingUtxos: [],
  });
});

test('buildMvcTransferSessionSnapshot recovers from address history when local pin history has no candidates', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 13;
  const mvcAddress = '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx';
  const staleOutpoint = `${'6'.repeat(64)}:0`;
  const recoveredUtxo = {
    txId: '7'.repeat(64),
    outputIndex: 1,
    satoshis: 70_000,
    address: mvcAddress,
    height: -1,
  };
  const recoveryCalls = [];
  const originalLog = console.log;
  console.log = () => {};

  recordMvcSpentOutpoints(metabotId, [staleOutpoint]);

  let snapshot;
  try {
    snapshot = await buildMvcTransferSessionSnapshot(
      {
        getMetabotById: (id) => (id === metabotId ? { mvc_address: mvcAddress } : null),
        listRecentPinTransactionsByAddress: (address, limit) => {
          recoveryCalls.push({ source: 'pin-list', address, limit });
          return [];
        },
      },
      metabotId,
      {
        recoverMvcFundingCandidates: async () => {
          recoveryCalls.push({ source: 'pin-history' });
          return [];
        },
        recoverMvcAddressHistoryFundingCandidates: async (params) => {
          recoveryCalls.push({
            source: 'address-history',
            address: params.address,
            excludedOutpoints: params.excludedOutpoints,
          });
          return [recoveredUtxo];
        },
      },
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(snapshot.excludeOutpoints, [staleOutpoint]);
  assert.deepEqual(snapshot.preferredFundingUtxos, [recoveredUtxo]);
  assert.deepEqual(recoveryCalls, [
    { source: 'pin-list', address: mvcAddress, limit: 8 },
    {
      source: 'address-history',
      address: mvcAddress,
      excludedOutpoints: [staleOutpoint],
    },
  ]);
});

test('runMvcTransferWorkerWithSessionRecovery retries once with recovered funding after stale provider failure', async () => {
  assert.equal(typeof runMvcTransferWorkerWithSessionRecovery, 'function');
  resetMvcSpendSessionStateForTests();
  const metabotId = 11;
  const staleOutpoint = `${'2'.repeat(64)}:0`;
  const recoveredUtxo = {
    txId: '3'.repeat(64),
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

  const result = await runMvcTransferWorkerWithSessionRecovery({
    metabotStore: {},
    metabotId,
    buildSessionSnapshot: async () => snapshots.shift(),
    runWorkerForSession: async (snapshot) => {
      seenSnapshots.push(snapshot);
      if (seenSnapshots.length === 1) {
        return {
          success: false,
          error: 'MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.',
          staleOutpoints: [staleOutpoint],
        };
      }
      return {
        success: true,
        txId: '4'.repeat(64),
        spentOutpoints: [`${recoveredUtxo.txId}:${recoveredUtxo.outputIndex}`],
        changeUtxo: null,
      };
    },
  });

  assert.equal(result.workerResult.success, true);
  assert.equal(result.workerResult.txId, '4'.repeat(64));
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

test('runMvcTransferWorkerWithSessionRecovery requests fresh funding when recovered transfer inputs are unavailable', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 14;
  const staleOutpoint = `${'8'.repeat(64)}:0`;
  const snapshots = [
    {
      excludeOutpoints: [],
      preferredFundingUtxos: [],
    },
    {
      excludeOutpoints: [staleOutpoint],
      preferredFundingUtxos: [],
    },
    {
      excludeOutpoints: [staleOutpoint],
      preferredFundingUtxos: [],
    },
  ];
  const seenSnapshots = [];
  let freshFundingRequests = 0;

  const result = await runMvcTransferWorkerWithSessionRecovery({
    metabotStore: {},
    metabotId,
    buildSessionSnapshot: async () => snapshots.shift(),
    requestFreshFunding: async () => {
      freshFundingRequests += 1;
      return true;
    },
    runWorkerForSession: async (snapshot) => {
      seenSnapshots.push(snapshot);
      if (seenSnapshots.length === 1) {
        return {
          success: false,
          error: 'MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.',
          staleOutpoints: [staleOutpoint],
        };
      }
      return {
        success: true,
        txId: '9'.repeat(64),
        spentOutpoints: [],
        changeUtxo: null,
      };
    },
  });

  assert.equal(result.workerResult.success, true);
  assert.equal(result.workerResult.txId, '9'.repeat(64));
  assert.equal(result.retriedAfterStaleFunding, true);
  assert.equal(result.requestedFreshFundingAfterStale, true);
  assert.equal(freshFundingRequests, 1);
  assert.deepEqual(seenSnapshots, [
    {
      excludeOutpoints: [],
      preferredFundingUtxos: [],
    },
    {
      excludeOutpoints: [staleOutpoint],
      preferredFundingUtxos: [],
    },
  ]);
  assert.deepEqual(getMvcSpendSessionSnapshot(metabotId).excludeOutpoints, [staleOutpoint]);
});
