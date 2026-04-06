import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWalletAssetsSectionsViewModel,
  validateTokenTransferDraft,
  buildTokenTransferPreviewPayload,
  buildTokenTransferExecutePayload,
} from '../src/renderer/components/metabots/metabotWalletPresentation.js';

test('wallet asset presentation helpers expose native, mrc20, and mvc sections with empty state', () => {
  const viewModel = buildWalletAssetsSectionsViewModel({
    assets: {
      nativeAssets: [],
      mrc20Assets: [],
      mvcFtAssets: [],
    },
    loading: false,
    error: '',
  });

  assert.deepEqual(
    viewModel.sections.map((section) => ({ title: section.title, state: section.state })),
    [
      { title: '原生币', state: 'empty' },
      { title: 'MRC20 Token', state: 'empty' },
      { title: 'MVC Token', state: 'empty' },
    ],
  );
});

test('wallet asset presentation helpers return error state labels for token sections', () => {
  const viewModel = buildWalletAssetsSectionsViewModel({ assets: null, loading: false, error: 'boom' });
  assert.equal(viewModel.sections[1].state, 'error');
  assert.equal(viewModel.sections[2].state, 'error');
});

test('token transfer helpers reject preview validation when amount is greater than displayed max', () => {
  const validation = validateTokenTransferDraft({
    amount: '2.5',
    receiver: 'btc-dest',
    maxDisplayBalance: '2.0',
  });

  assert.deepEqual(validation, {
    valid: false,
    errorKey: 'transferAmountExceedsBalance',
  });

  const asset = {
    kind: 'mrc20',
    chain: 'btc',
    symbol: 'MINE',
    tokenName: 'Mine',
    mrc20Id: 'mine-id',
    address: 'btc-address',
    decimal: 8,
    balance: {
      confirmed: '1.0',
      unconfirmed: '0',
      pendingIn: '0',
      pendingOut: '0',
      display: '2.0',
    },
  };

  const payload = buildTokenTransferPreviewPayload({
    metabotId: 1,
    kind: 'mrc20',
    asset,
    receiver: 'btc-dest',
    amount: '1.5',
    feeRate: 12,
  });

  assert.equal(payload.kind, 'mrc20');
  assert.equal(payload.amount, '1.5');
  assert.equal(payload.toAddress, 'btc-dest');
});

test('token transfer helpers build execution payloads for mvc ft assets', () => {
  const asset = {
    kind: 'mvc-ft',
    chain: 'mvc',
    symbol: 'MC',
    tokenName: 'Meta Coin',
    genesis: 'genesis',
    codeHash: 'code',
    address: 'mvc-address',
    decimal: 8,
    balance: {
      confirmed: '9.0',
      unconfirmed: '1.0',
      display: '9.0',
    },
  };

  const payload = buildTokenTransferExecutePayload({
    metabotId: 1,
    kind: 'mvc-ft',
    asset,
    receiver: 'mvc-dest',
    amount: '1.25',
    feeRate: 1,
  });

  assert.equal(payload.kind, 'mvc-ft');
  assert.equal(payload.toAddress, 'mvc-dest');
  assert.equal(payload.amount, '1.25');
  assert.equal(payload.asset.genesis, 'genesis');
});
