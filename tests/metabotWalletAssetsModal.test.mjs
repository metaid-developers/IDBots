import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMvcNftItemDetailRows,
  buildMvcNftItemTileViewModel,
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
    viewModel.sections.map((section) => ({ titleKey: section.titleKey, state: section.state })),
    [
      { titleKey: 'metabotWalletNativeAssets', state: 'empty' },
      { titleKey: 'metabotWalletMrc20Assets', state: 'empty' },
      { titleKey: 'metabotWalletMvcFtAssets', state: 'empty' },
      { titleKey: 'metabotWalletMvcNftAssets', state: 'empty' },
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

test('mvc nft item tiles resolve the artwork chain imgUrl first, then icon metafile routes', () => {
  const tile = buildMvcNftItemTileViewModel({
    tokenIndex: '2671',
    name: 'MetaBot #2671',
    satoshi: 1000,
    imgUrl: 'https://metalet.space/art.png',
    icon: 'metafile://abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234i0.png',
  });

  assert.equal(tile.key, '2671');
  assert.equal(tile.title, 'MetaBot #2671');
  assert.equal(tile.badge, '#2671');
  assert.equal(tile.artworkSources[0], 'https://metalet.space/art.png');
  assert.ok(tile.artworkSources[1].includes('/files/accelerate/content/'));
  assert.ok(tile.artworkSources[2].includes('/files/content/'));
  assert.equal(tile.artworkInitials, 'ME');
});

test('mvc nft item tiles degrade to placeholder-only sources when no artwork reference exists', () => {
  const tile = buildMvcNftItemTileViewModel({ tokenIndex: '', name: '' });
  assert.deepEqual(tile.artworkSources, []);
  assert.equal(tile.title, 'NFT');
  assert.equal(tile.badge, '');

  const unnamed = buildMvcNftItemTileViewModel({ tokenIndex: '9', name: '' });
  assert.equal(unnamed.title, '#9');
  assert.equal(unnamed.badge, '#9');
});

test('mvc nft item detail rows carry series, serial, supply, genesis and holder with mono copy fields', () => {
  const rows = buildMvcNftItemDetailRows(
    {
      seriesName: 'MetaBot Avatar',
      genesis: '2b5f8a8400000000000000000000000000000000',
      codeHash: '1234000000000000000000000000000000000056',
      address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
      tokenSupply: 10000,
    },
    { tokenIndex: '2671', name: 'MetaBot #2671', satoshi: 1000 },
  );

  const byKey = Object.fromEntries(rows.map((row) => [row.labelKey, row]));
  assert.equal(byKey.metabotNftFieldSeries.value, 'MetaBot Avatar');
  assert.equal(byKey.metabotNftFieldTokenIndex.value, '#2671');
  assert.equal(byKey.metabotNftFieldSupply.value, '10000');
  assert.equal(byKey.metabotNftFieldNetwork.value, 'MVC');
  assert.equal(byKey.metabotNftFieldSatoshi.value, '1000 sats');
  assert.equal(byKey.metabotNftFieldGenesis.value, '2b5f8a8400000000000000000000000000000000');
  assert.equal(byKey.metabotNftFieldOwner.value, '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
  assert.equal(byKey.metabotNftFieldTokenIndex.mono, true);
  assert.equal(byKey.metabotNftFieldGenesis.mono, true);
  assert.equal(byKey.metabotNftFieldSeries.mono, false);
  // Absent facts drop their rows instead of rendering empty values.
  const sparse = buildMvcNftItemDetailRows(
    { seriesName: '', genesis: '', codeHash: '', address: '' },
    { tokenIndex: '', satoshi: 0 },
  );
  assert.equal(sparse.length, 1);
  assert.equal(sparse[0].labelKey, 'metabotNftFieldNetwork');
});
