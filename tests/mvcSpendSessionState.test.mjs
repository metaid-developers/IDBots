import test from 'node:test';
import assert from 'node:assert/strict';

const {
  clearMvcExcludedOutpoints,
  getMvcSpendSessionSnapshot,
  recordMvcSpentOutpoints,
  replaceMvcPendingFundingUtxos,
  resetMvcSpendSessionStateForTests,
} = await import('../dist-electron/services/mvcSpendSessionState.js');

test('mvc spend session tracks excluded outpoints and pending change per metabot', () => {
  resetMvcSpendSessionStateForTests();
  const changeTxId = 'a'.repeat(64);
  const staleTxId = 'b'.repeat(64);

  replaceMvcPendingFundingUtxos(19, {
    txId: changeTxId,
    outputIndex: 1,
    satoshis: 1_500,
    address: 'mvc-address',
    height: -1,
  });
  recordMvcSpentOutpoints(19, [`${staleTxId}:0`]);

  const initialSnapshot = getMvcSpendSessionSnapshot(19);
  assert.deepEqual(initialSnapshot.excludeOutpoints, [`${staleTxId}:0`]);
  assert.deepEqual(initialSnapshot.preferredFundingUtxos, [
    {
      txId: changeTxId,
      outputIndex: 1,
      satoshis: 1_500,
      address: 'mvc-address',
      height: -1,
    },
  ]);

  recordMvcSpentOutpoints(19, [`${changeTxId}:1`]);
  const consumedSnapshot = getMvcSpendSessionSnapshot(19);
  assert.deepEqual(consumedSnapshot.excludeOutpoints, [`${staleTxId}:0`, `${changeTxId}:1`]);
  assert.deepEqual(consumedSnapshot.preferredFundingUtxos, []);
});

test('mvc spend session state is isolated per metabot and can clear exclusions after insufficient balance', () => {
  resetMvcSpendSessionStateForTests();
  const staleATxId = 'c'.repeat(64);
  const staleBTxId = 'd'.repeat(64);

  recordMvcSpentOutpoints(15, [`${staleATxId}:0`]);
  recordMvcSpentOutpoints(19, [`${staleBTxId}:1`]);

  clearMvcExcludedOutpoints(15);

  assert.deepEqual(getMvcSpendSessionSnapshot(15), {
    excludeOutpoints: [],
    preferredFundingUtxos: [],
  });
  assert.deepEqual(getMvcSpendSessionSnapshot(19), {
    excludeOutpoints: [`${staleBTxId}:1`],
    preferredFundingUtxos: [],
  });
});
