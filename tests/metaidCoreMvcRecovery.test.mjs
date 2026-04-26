import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildMvcCreatePinSessionSnapshot,
  parseCreatePinWorkerResultForTests,
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
        recoverMvcAddressHistoryFundingCandidates: async () => {
          throw new Error('address history probe failed');
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

test('buildMvcCreatePinSessionSnapshot recovers address-history funding when local pin recovery is empty', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 25;
  const staleOutpoint = `${'a'.repeat(64)}:2`;
  const historyUtxo = {
    txId: 'b'.repeat(64),
    outputIndex: 2,
    satoshis: 88_000,
    address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
    height: -1,
  };

  recordMvcSpentOutpoints(metabotId, [staleOutpoint]);

  const snapshot = await buildMvcCreatePinSessionSnapshot(
    {
      getMetabotById: () => ({ mvc_address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }),
      listRecentPinTransactionsByAddress: () => [],
    },
    metabotId,
    {
      recoverMvcAddressHistoryFundingCandidates: async (params) => {
        assert.equal(params.address, '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
        assert.deepEqual(params.excludedOutpoints, [staleOutpoint]);
        return [historyUtxo];
      },
    },
  );

  assert.deepEqual(snapshot, {
    excludeOutpoints: [staleOutpoint],
    preferredFundingUtxos: [historyUtxo],
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

test('parseCreatePinWorkerResultForTests preserves stale outpoints when worker logs precede stderr JSON', () => {
  assert.equal(typeof parseCreatePinWorkerResultForTests, 'function');
  const staleOutpoint = `${'9'.repeat(64)}:2`;

  assert.throws(
    () => parseCreatePinWorkerResultForTests({
      stdout: '',
      stderr: [
        '[createPinWorker] Fetched MVC pin funding candidates {"attempt":1}',
        '[createPinWorker] MVC pin transaction attempt failed {"attempt":1,"error":"[-25]Missing inputs"}',
        JSON.stringify({
          success: false,
          error: 'MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.',
          staleOutpoints: [staleOutpoint],
        }),
      ].join('\n'),
      exitCode: 1,
    }),
    (error) => {
      assert.equal(error.message, 'MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.');
      assert.deepEqual(error.staleOutpoints, [staleOutpoint]);
      return true;
    },
  );
});

test('runMvcCreatePinWorkerWithSessionRecovery requests fresh funding when provider and recovered candidates are stale', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 24;
  const providerStaleOutpoint = `${'8'.repeat(64)}:2`;
  const recoveredStaleOutpoint = `${'7'.repeat(64)}:2`;
  let freshFundingRequests = 0;
  const seenSnapshots = [];

  const result = await runMvcCreatePinWorkerWithSessionRecovery({
    metabotStore: {},
    metabotId,
    buildSessionSnapshot: async () => {
      const snapshot = getMvcSpendSessionSnapshot(metabotId);
      if (
        snapshot.excludeOutpoints.includes(providerStaleOutpoint)
        && !snapshot.excludeOutpoints.includes(recoveredStaleOutpoint)
      ) {
        return {
          excludeOutpoints: snapshot.excludeOutpoints,
          preferredFundingUtxos: [{
            txId: '7'.repeat(64),
            outputIndex: 2,
            satoshis: 50_000,
            address: 'mvc-address',
            height: -1,
          }],
        };
      }
      return snapshot;
    },
    requestFreshFunding: async () => {
      freshFundingRequests += 1;
      return true;
    },
    runWorkerForSession: async (snapshot) => {
      seenSnapshots.push(snapshot);
      if (seenSnapshots.length === 1) {
        throw Object.assign(
          new Error('MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.'),
          { staleOutpoints: [providerStaleOutpoint] },
        );
      }
      if (seenSnapshots.length === 2) {
        throw Object.assign(
          new Error('MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.'),
          { staleOutpoints: [providerStaleOutpoint, recoveredStaleOutpoint] },
        );
      }
      return {
        txids: ['6'.repeat(64)],
        pinId: `${'6'.repeat(64)}i0`,
        totalCost: 900,
        spentOutpoints: [`${'5'.repeat(64)}:1`],
        changeUtxo: null,
      };
    },
  });

  assert.equal(result.workerResult.pinId, `${'6'.repeat(64)}i0`);
  assert.equal(result.retriedAfterStaleFunding, true);
  assert.equal(result.requestedFreshFundingAfterStale, true);
  assert.equal(freshFundingRequests, 1);
  assert.deepEqual(getMvcSpendSessionSnapshot(metabotId).excludeOutpoints, [
    providerStaleOutpoint,
    recoveredStaleOutpoint,
  ]);
  assert.equal(seenSnapshots.length, 3);
  assert.deepEqual(seenSnapshots[2], {
    excludeOutpoints: [providerStaleOutpoint, recoveredStaleOutpoint],
    preferredFundingUtxos: [],
  });
});

test('runMvcCreatePinWorkerWithSessionRecovery reports terminal stale funding when fresh funding cannot be obtained', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 26;
  const providerStaleOutpoint = `${'4'.repeat(64)}:2`;
  const recoveredStaleOutpoint = `${'3'.repeat(64)}:2`;

  await assert.rejects(
    runMvcCreatePinWorkerWithSessionRecovery({
      metabotStore: {},
      metabotId,
      buildSessionSnapshot: async () => {
        const snapshot = getMvcSpendSessionSnapshot(metabotId);
        if (
          snapshot.excludeOutpoints.includes(providerStaleOutpoint)
          && !snapshot.excludeOutpoints.includes(recoveredStaleOutpoint)
        ) {
          return {
            excludeOutpoints: snapshot.excludeOutpoints,
            preferredFundingUtxos: [{
              txId: '3'.repeat(64),
              outputIndex: 2,
              satoshis: 50_000,
              address: 'mvc-address',
              height: -1,
            }],
          };
        }
        return snapshot;
      },
      requestFreshFunding: async () => false,
      runWorkerForSession: async () => {
        const snapshot = getMvcSpendSessionSnapshot(metabotId);
        const staleOutpoints = snapshot.excludeOutpoints.includes(providerStaleOutpoint)
          ? [providerStaleOutpoint, recoveredStaleOutpoint]
          : [providerStaleOutpoint];
        throw Object.assign(
          new Error('MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.'),
          { staleOutpoints },
        );
      },
    }),
    (error) => {
      assert.match(error.message, /所有已知 MVC 手续费输入都已失效/);
      assert.deepEqual(error.staleOutpoints, [providerStaleOutpoint, recoveredStaleOutpoint]);
      return true;
    },
  );
});
