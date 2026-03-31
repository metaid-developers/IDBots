import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTransactionExplorerUrl } from '../src/main/services/serviceOrderPresentation.js';

test('buildTransactionExplorerUrl uses mvcscan for mvc payments', () => {
  assert.equal(
    buildTransactionExplorerUrl('mvc', 'a'.repeat(64)),
    `https://www.mvcscan.com/tx/${'a'.repeat(64)}`
  );
});

test('buildTransactionExplorerUrl uses mempool.space for btc payments', () => {
  assert.equal(
    buildTransactionExplorerUrl('btc', 'b'.repeat(64)),
    `https://mempool.space/tx/${'b'.repeat(64)}`
  );
});
