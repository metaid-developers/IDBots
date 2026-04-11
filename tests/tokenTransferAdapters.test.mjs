import test from 'node:test';
import assert from 'node:assert/strict';

const {
  selectMvcFundingUtxos,
} = await import('../dist-electron/services/tokenTransferAdapters.js');

test('selectMvcFundingUtxos preserves provider order instead of sorting by satoshis', () => {
  assert.equal(
    typeof selectMvcFundingUtxos,
    'function',
    'selectMvcFundingUtxos() should be exported',
  );

  const selected = selectMvcFundingUtxos([
    { txId: 'first-change', outputIndex: 0, satoshis: 1500 },
    { txId: 'older-large', outputIndex: 1, satoshis: 500000 },
    { txId: 'second-change', outputIndex: 2, satoshis: 1800 },
  ]);

  assert.deepEqual(
    selected.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    ['first-change:0', 'older-large:1', 'second-change:2'],
  );
});
