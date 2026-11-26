import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildNftAlbumGroups,
  buildNftArtworkSources,
  buildNftAvatarUri,
  buildNftDetailRows,
  buildNftTileViewModel,
  buildNftTransferPayload,
  buildPaginationTokens,
  filterAndSortNftItems,
  formatNftTime,
  isNftItemCertified,
  MRC721_MIN_SELL_PRICE_SATS,
  metafileToSourceUrls,
  mrc721SellOrderStatusKey,
  paginateNftItems,
  validateMrc721SellDraft,
  validateNftTransferDraft,
} from '../src/renderer/components/metabots/metabotNftPresentation.js';

test('MRC721_MIN_SELL_PRICE_SATS renderer mirror stays pinned to the main-side constant', () => {
  // metabotNftPresentation.js cannot import the main-side module (the tx
  // builder drags the meta-contract stack into the renderer bundle), so the
  // value is a declared mirror — this string audit is what keeps it honest.
  const mainSource = readFileSync(new URL('../src/main/libs/mrc721AtomicSwapTx.ts', import.meta.url), 'utf8');
  const match = mainSource.match(/export const MRC721_MIN_SELL_PRICE_SATS = (\d+)/);
  assert.ok(match, 'main-side MRC721_MIN_SELL_PRICE_SATS not found in mrc721AtomicSwapTx.ts');
  assert.equal(MRC721_MIN_SELL_PRICE_SATS, Number(match[1]));
});

test('metafileToSourceUrls expands metafile URIs and bare pin ids to accelerate→content routes', () => {
  const withExtension = metafileToSourceUrls('metafile://aaaa…i0.png');
  assert.deepEqual(withExtension, [
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/aaaa%E2%80%A6i0',
    'https://file.metaid.io/metafile-indexer/api/v1/files/content/aaaa%E2%80%A6i0',
  ]);

  const bare = metafileToSourceUrls('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbi0');
  assert.equal(bare.length, 2);
  assert.ok(bare[0].includes('/accelerate/content/'));
  assert.ok(bare[0].endsWith('i0'));

  assert.deepEqual(metafileToSourceUrls(''), []);
  assert.deepEqual(metafileToSourceUrls('https://example.com/img.png'), []);
  assert.deepEqual(metafileToSourceUrls('metafile://../etc'), []);
});

test('buildNftArtworkSources orders https direct link before metafile routes', () => {
  const sources = buildNftArtworkSources({
    imageUrl: 'https://cdn.example/x.png',
    imageRef: 'metafile://aaaa…i0',
  });
  assert.equal(sources[0], 'https://cdn.example/x.png');
  assert.equal(sources.length, 3);

  assert.deepEqual(buildNftArtworkSources({ imageRef: '', imageUrl: '' }), []);
});

test('buildNftTileViewModel titles, badges, and placeholder initials', () => {
  const mrc721 = buildNftTileViewModel({
    kind: 'mrc721',
    key: 'pin…i0',
    name: 'Sunny Cat',
    collectionName: 'sunny-cats',
    number: 12,
    imageRef: 'metafile://aaaa…i0',
  });
  assert.equal(mrc721.title, 'Sunny Cat');
  assert.equal(mrc721.badge, '#12');
  assert.equal(mrc721.subtitle, 'sunny-cats');
  assert.equal(mrc721.artworkInitials, 'SU');

  const metacontract = buildNftTileViewModel({
    kind: 'metacontract',
    key: 'gen:7',
    name: '',
    collectionName: 'Series One',
    tokenIndex: '7',
  });
  assert.equal(metacontract.title, '#7');
  assert.equal(metacontract.badge, '#7');
  assert.equal(metacontract.subtitle, 'Series One');
  assert.equal(metacontract.artworkSources.length, 0);

  const unnamed = buildNftTileViewModel({ kind: 'mrc721', key: 'k', name: '', collectionName: '', number: -1 });
  assert.equal(unnamed.badge, '');
  assert.equal(unnamed.title, 'NFT');
  assert.equal(unnamed.artworkInitials, 'NF');
});

test('formatNftTime renders local YYYY/MM/DD HH:mm and null for falsy input', () => {
  // 2026-01-02 03:04 UTC → local rendering must contain the full shape.
  const rendered = formatNftTime(1767323040);
  assert.match(rendered, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.equal(formatNftTime(0), null);
  assert.equal(formatNftTime(undefined), null);
});

test('buildNftDetailRows emits kind-aware rows with mono ids', () => {
  const mrc721Rows = buildNftDetailRows({
    kind: 'mrc721',
    key: 'pin…i0',
    name: 'Sunny Cat',
    collectionName: 'sunny-cats',
    number: 3,
    createTime: 1767323040,
    raw: {
      desc: 'A sunny cat',
      ownerAddress: 'mxWx54abc',
      genesisTx: 'tx-genesis',
      contentType: 'image/png',
      outputValue: 678,
      transferCount: 2,
    },
  });
  const labelKeys = mrc721Rows.map((row) => row.labelKey);
  assert.ok(labelKeys.includes('metabotNftFieldCollection'));
  assert.ok(labelKeys.includes('metabotNftFieldOwner'));
  assert.ok(labelKeys.includes('metabotNftFieldItemId'));
  assert.ok(labelKeys.includes('metabotNftFieldMintTime'));
  const ownerRow = mrc721Rows.find((row) => row.labelKey === 'metabotNftFieldOwner');
  assert.equal(ownerRow.mono, true);
  const indexRow = mrc721Rows.find((row) => row.labelKey === 'metabotNftFieldTokenIndex');
  assert.equal(indexRow.value, '#3');

  const metacontractRows = buildNftDetailRows({
    kind: 'metacontract',
    key: 'gen:1',
    name: 'One',
    collectionName: 'Series One',
    tokenIndex: '1',
    height: 12345,
    raw: {
      satoshi: 1000,
      genesis: 'gen',
      codeHash: 'hash',
      txId: 'tx-1',
      metaTxId: 'meta-tx-1',
    },
  });
  const mcLabels = metacontractRows.map((row) => row.labelKey);
  assert.ok(mcLabels.includes('metabotNftFieldSeries'));
  assert.ok(mcLabels.includes('metabotNftFieldHeight'));
  assert.ok(mcLabels.includes('metabotNftFieldGenesis'));
  assert.ok(!mcLabels.includes('metabotNftFieldOwner'));
  const heightRow = metacontractRows.find((row) => row.labelKey === 'metabotNftFieldHeight');
  assert.equal(heightRow.value, '12345');
});

test('validateNftTransferDraft requires a base58 MVC address', () => {
  assert.equal(validateNftTransferDraft({ toAddress: '' }).valid, false);
  assert.equal(validateNftTransferDraft({ toAddress: 'short' }).valid, false);
  assert.equal(validateNftTransferDraft({ toAddress: '0xInvalidAddress!' }).valid, false);
  assert.equal(validateNftTransferDraft({ toAddress: '1MvcAddressLikeBase5812345' }).valid, true);
  assert.equal(
    validateNftTransferDraft({ toAddress: '' }).errorKey,
    'transferReceiverRequired',
  );
  assert.equal(
    validateNftTransferDraft({ toAddress: 'not valid' }).errorKey,
    'metabotNftTransferInvalidAddress',
  );
});

test('buildNftTransferPayload shapes per-kind transfer inputs', () => {
  const metacontract = buildNftTransferPayload({
    metabotId: 7,
    item: { kind: 'metacontract', key: 'gen:1', tokenIndex: '1', raw: { genesis: 'gen', codeHash: 'hash' } },
    toAddress: ' addr ',
    feeRate: 2,
  });
  assert.deepEqual(metacontract, {
    metabotId: 7,
    genesis: 'gen',
    codehash: 'hash',
    tokenIndex: '1',
    toAddress: 'addr',
    feeRate: 2,
  });

  const mrc721 = buildNftTransferPayload({
    metabotId: 7,
    item: { kind: 'mrc721', key: 'pin…i0' },
    toAddress: 'addr',
    feeRate: 1,
  });
  assert.deepEqual(mrc721, { metabotId: 7, pinId: 'pin…i0', toAddress: 'addr', feeRate: 1 });
});

test('validateMrc721SellDraft enforces the whole-sat price floor and base58 buyer', () => {
  assert.equal(MRC721_MIN_SELL_PRICE_SATS, 22000);

  assert.equal(validateMrc721SellDraft({ priceSats: '', buyerAddress: '1MvcAddressLikeBase5812345' }).errorKey, 'metabotNftSellPriceRequired');
  assert.equal(validateMrc721SellDraft({ priceSats: 'abc', buyerAddress: '1MvcAddressLikeBase5812345' }).errorKey, 'metabotNftSellPriceRequired');
  assert.equal(validateMrc721SellDraft({ priceSats: '22.5', buyerAddress: '1MvcAddressLikeBase5812345' }).errorKey, 'metabotNftSellPriceRequired');
  assert.equal(validateMrc721SellDraft({ priceSats: '21999', buyerAddress: '1MvcAddressLikeBase5812345' }).errorKey, 'metabotNftSellPriceBelowFloor');
  assert.equal(validateMrc721SellDraft({ priceSats: '22000', buyerAddress: '' }).errorKey, 'transferReceiverRequired');
  assert.equal(validateMrc721SellDraft({ priceSats: '22000', buyerAddress: 'not valid' }).errorKey, 'metabotNftTransferInvalidAddress');
  assert.deepEqual(
    validateMrc721SellDraft({ priceSats: '22000', buyerAddress: '1MvcAddressLikeBase5812345' }),
    { valid: true },
  );
});

test('mrc721SellOrderStatusKey maps every sell-order status onto an i18n key', () => {
  assert.equal(mrc721SellOrderStatusKey('valid'), 'metabotNftListingStatusValid');
  assert.equal(mrc721SellOrderStatusKey('invalid'), 'metabotNftListingStatusInvalid');
  assert.equal(mrc721SellOrderStatusKey('expired'), 'metabotNftListingStatusExpired');
  assert.equal(mrc721SellOrderStatusKey('nonsense'), 'metabotNftListingStatusInvalid');
});

test('isNftItemCertified matches verified CA MRC-721 collections and legacy MetaContract series only', () => {
  const verifiedRegistry = {
    verified: true,
    collections: [
      {
        collectionPinId: 'col-official-1i0',
        legacySeries: { genesis: 'gen-legacy-a', codehash: 'hash-a' },
      },
    ],
    officialBots: [
      {
        active: true,
        swapConfig: { supportedSeries: [{ genesis: 'gen-swap-b', codehash: 'hash-b' }] },
      },
      {
        active: false,
        swapConfig: { supportedSeries: [{ genesis: 'gen-inactive', codehash: 'hash-i' }] },
      },
    ],
  };

  const mrc721Certified = { kind: 'mrc721', key: 'p1', raw: { collectionPinId: 'COL-OFFICIAL-1I0' } };
  const mrc721Unknown = { kind: 'mrc721', key: 'p2', raw: { collectionPinId: 'col-other' } };
  const mcLegacy = { kind: 'metacontract', key: 'g:1', raw: { genesis: 'gen-legacy-a', codeHash: 'hash-a' } };
  const mcSwap = { kind: 'metacontract', key: 'g:2', raw: { genesis: 'gen-swap-b', codeHash: 'hash-b' } };
  const mcInactive = { kind: 'metacontract', key: 'g:3', raw: { genesis: 'gen-inactive', codeHash: 'hash-i' } };

  assert.equal(isNftItemCertified(verifiedRegistry, mrc721Certified), true);
  assert.equal(isNftItemCertified(verifiedRegistry, mrc721Unknown), false);
  assert.equal(isNftItemCertified(verifiedRegistry, mcLegacy), true);
  assert.equal(isNftItemCertified(verifiedRegistry, mcSwap), true);
  assert.equal(isNftItemCertified(verifiedRegistry, mcInactive), false);

  // Unverified or absent registry fails closed
  assert.equal(isNftItemCertified({ ...verifiedRegistry, verified: false }, mrc721Certified), false);
  assert.equal(isNftItemCertified(null, mrc721Certified), false);
});

test('buildNftAvatarUri constructs identity-bound nft://mrc721 URIs', () => {
  assert.equal(
    buildNftAvatarUri({ itemPinId: 'pin123i0', ownerAddress: '1MvcAddr', ownerGlobalMetaId: 'idq1meta' }),
    'nft://mrc721/pin123i0?owner=1MvcAddr&metaid=idq1meta',
  );
  assert.equal(
    buildNftAvatarUri({ itemPinId: 'pin123i0', ownerAddress: '1MvcAddr' }),
    'nft://mrc721/pin123i0?owner=1MvcAddr',
  );
  assert.equal(buildNftAvatarUri({ itemPinId: '', ownerAddress: '1MvcAddr' }), '');
  assert.equal(buildNftAvatarUri({ itemPinId: 'pin123i0', ownerAddress: '' }), '');
});

test('buildNftAlbumGroups groups items in acquisition order with CA badge and cover fallback', () => {
  const registry = {
    verified: true,
    collections: [{ collectionPinId: 'col-a' }],
  };
  const items = [
    { kind: 'mrc721', key: 'p1', name: 'A #1', collectionName: 'Alpha', raw: { collectionPinId: 'col-a' } },
    { kind: 'mrc721', key: 'p2', name: 'B #1', collectionName: 'Beta', imageUrl: 'https://cdn/b1.png', raw: { collectionPinId: 'col-b' } },
    { kind: 'mrc721', key: 'p3', name: 'A #2', collectionName: 'Alpha', imageUrl: 'https://cdn/a2.png', raw: { collectionPinId: 'col-a' } },
  ];

  const groups = buildNftAlbumGroups(items, registry);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, 'Alpha');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].certified, true);
  assert.deepEqual(groups[0].coverSources, ['https://cdn/a2.png']);
  assert.equal(groups[1].title, 'Beta');
  assert.equal(groups[1].count, 1);
  assert.equal(groups[1].certified, false);
});

test('filterAndSortNftItems filters by query and verifiedOnly, and supports recent/serial/name sorting', () => {
  const registry = { verified: true, collections: [{ collectionPinId: 'col-a' }] };
  const items = [
    { kind: 'mrc721', key: 'p1', name: 'Zebra', collectionName: 'Alpha', number: 10, raw: { collectionPinId: 'col-a' } },
    { kind: 'mrc721', key: 'p2', name: 'Apple', collectionName: 'Beta', number: 2, raw: { collectionPinId: 'col-b' } },
    { kind: 'mrc721', key: 'p3', name: 'Mango', collectionName: 'Alpha', number: 5, raw: { collectionPinId: 'col-a' } },
  ];

  assert.deepEqual(
    filterAndSortNftItems(items, { verifiedOnly: true, registry }).map((x) => x.key),
    ['p1', 'p3'],
  );
  assert.deepEqual(
    filterAndSortNftItems(items, { query: '#5' }).map((x) => x.key),
    ['p3'],
  );
  assert.deepEqual(
    filterAndSortNftItems(items, { sortBy: 'serial' }).map((x) => x.key),
    ['p2', 'p3', 'p1'],
  );
  assert.deepEqual(
    filterAndSortNftItems(items, { sortBy: 'name' }).map((x) => x.key),
    ['p2', 'p3', 'p1'],
  );
});

test('paginateNftItems and buildPaginationTokens stay deterministic for 500+ holdings', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ key: `p-${i + 1}` }));

  const first = paginateNftItems(many, 1, 12);
  assert.equal(first.totalPages, 42);
  assert.equal(first.items.length, 12);
  assert.equal(first.startIndex, 0);
  assert.equal(first.endIndex, 12);

  // Out-of-bounds page clamps to last page
  const clamped = paginateNftItems(many, 999, 12);
  assert.equal(clamped.page, 42);
  assert.equal(clamped.items.length, 8);
  assert.equal(clamped.items[0].key, 'p-493');

  // Empty collection still reports page 1 / totalPages 1
  const empty = paginateNftItems([], 3, 12);
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.items.length, 0);

  // Pagination tokens
  assert.deepEqual(buildPaginationTokens(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(buildPaginationTokens(1, 42), [1, 2, 'ellipsis-end', 42]);
  assert.deepEqual(buildPaginationTokens(20, 42), [1, 'ellipsis-start', 19, 20, 21, 'ellipsis-end', 42]);
  assert.deepEqual(buildPaginationTokens(42, 42), [1, 'ellipsis-start', 41, 42]);
});

