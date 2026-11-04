import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNftArtworkSources,
  buildNftAvatarImageRef,
  buildNftDetailRows,
  buildNftTileViewModel,
  buildNftTransferPayload,
  formatNftTime,
  MRC721_MIN_SELL_PRICE_SATS,
  metafileToSourceUrls,
  mrc721SellOrderStatusKey,
  validateMrc721SellDraft,
  validateNftTransferDraft,
} from '../src/renderer/components/metabots/metabotNftPresentation.js';

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

test('buildNftAvatarImageRef picks the artwork reference the avatar IPC should resolve', () => {
  const pinId = '14158a127fa1d7b66d821413abad64bc833cf145e7abd2b40838fde703609b45i0';

  // mrc721: the cover metafile reference wins (that is what the chain knows).
  assert.equal(
    buildNftAvatarImageRef({ kind: 'mrc721', imageRef: `metafile://${pinId}.jpg` }),
    `metafile://${pinId}.jpg`,
  );
  assert.equal(buildNftAvatarImageRef({ kind: 'mrc721', imageRef: pinId }), pinId);
  // A bare pin on the item and an https fallback coexist → the pin wins.
  assert.equal(
    buildNftAvatarImageRef({ kind: 'mrc721', imageRef: pinId, imageUrl: 'https://cdn.example/a.png' }),
    pinId,
  );

  // MetaContract: imgUrl (https) is the artwork the http branch can fetch.
  assert.equal(
    buildNftAvatarImageRef({ kind: 'metacontract', imageRef: 'metafile://x', imageUrl: 'https://cdn.example/nft.png' }),
    'https://cdn.example/nft.png',
  );
  // No https imgUrl → fall back to whatever reference the item carries.
  assert.equal(
    buildNftAvatarImageRef({ kind: 'metacontract', imageRef: `metafile://${pinId}` }),
    `metafile://${pinId}`,
  );

  // No artwork at all → empty string; the picker surfaces the structured
  // `empty` failure from metabot:setNftAvatar instead of guessing a reference.
  assert.equal(buildNftAvatarImageRef({ kind: 'mrc721' }), '');
  assert.equal(buildNftAvatarImageRef({ kind: 'metacontract', imageUrl: 'not-a-url' }), 'not-a-url');
  assert.equal(buildNftAvatarImageRef(null), '');
});
