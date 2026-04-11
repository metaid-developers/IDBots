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
    { txId: 'first-change', outputIndex: 0, satoshis: 1500, height: -1 },
    { txId: 'older-large', outputIndex: 1, satoshis: 500000, height: 912345 },
    { txId: 'second-change', outputIndex: 2, satoshis: 1800, confirmed: true },
  ]);

  assert.deepEqual(
    selected.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    ['older-large:1', 'second-change:2', 'first-change:0'],
  );
});
