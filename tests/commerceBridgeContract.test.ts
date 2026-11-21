// commerceBridgeContract — sanitizers + ownership gate for the commerce/social
// bridge methods (REQ-E-01). These tests pin the security posture: invalid
// pin ids / globalMetaIds are rejected, control characters and newlines are
// stripped (a listing name can never forge line breaks in a host modal),
// prices are bounded, and openPromoPack is owner-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanCommerceText,
  normalizeItemPinId,
  normalizeGlobalMetaId,
  normalizeMvcAddress,
  sanitizeAskTwinToBuy,
  sanitizeAddFriendPrompt,
  sanitizeOpenPromoPack,
  sanitizePromoFeaturedItems,
  checkPromoPackOwnership,
  isCommerceBridgeMethod,
  SanitizeFailure,
  COMMERCE_BRIDGE_METHODS,
  COMMERCE_INTENT_WINDOW_EVENT,
} from '../src/renderer/components/commerce/commerceBridgeContract.js';
import { formatMeMilli, formatCnyCents, tCommerce } from '../src/renderer/components/commerce/commercePromoI18n.js';

const VALID_PIN = '1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0';
const VALID_OWNER = 'idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47';

test('cleanCommerceText strips control chars, newlines and caps length', () => {
  assert.equal(cleanCommerceText('hello\nworld\r\nbye', 100), 'hello world bye');
  assert.equal(cleanCommerceText('tab\there\u0000nul\u0007bell', 100), 'tab here nul bell');
  assert.equal(cleanCommerceText('x'.repeat(300), 100).length, 100);
  assert.equal(cleanCommerceText(42, 10), '');
  assert.equal(cleanCommerceText(undefined, 10), '');
  assert.equal(cleanCommerceText('  padded  ', 10), 'padded');
});

test('normalizeItemPinId accepts only the 64hex+iN shape (case-insensitive)', () => {
  assert.equal(normalizeItemPinId(VALID_PIN.toUpperCase()), VALID_PIN);
  assert.equal(normalizeItemPinId(VALID_PIN), VALID_PIN);
  assert.equal(normalizeItemPinId('1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf'), '');
  assert.equal(normalizeItemPinId(`${VALID_PIN}extra`), '');
  assert.equal(normalizeItemPinId('zz288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0'), '');
  assert.equal(normalizeItemPinId('<script>alert(1)</script>'), '');
});

test('normalizeGlobalMetaId accepts idq1… ids and rejects everything else', () => {
  assert.equal(normalizeGlobalMetaId(VALID_OWNER), VALID_OWNER);
  assert.equal(normalizeGlobalMetaId(VALID_OWNER.toUpperCase()), VALID_OWNER);
  assert.equal(normalizeGlobalMetaId('idq1'), '');
  assert.equal(normalizeGlobalMetaId('idq1!!!not-base32-at-all!!!'), '');
  assert.equal(normalizeGlobalMetaId('https://evil.example/idq1w8ye'), '');
});

test('sanitizeAskTwinToBuy accepts a well-formed intent with defaults', () => {
  const value = sanitizeAskTwinToBuy({
    itemPinId: VALID_PIN,
    collectionName: 'metabot-avatar',
    itemName: 'MetaBot Avatar - Glasses #1310\n(second line injected)',
    sellerGlobalMetaId: VALID_OWNER,
    priceMeMilli: 15000,
    priceCnyCents: 990,
    mode: 'negotiate',
  });
  assert.ok(!(value instanceof SanitizeFailure));
  if (!(value instanceof SanitizeFailure)) {
    assert.equal(value.itemPinId, VALID_PIN);
    assert.equal(value.mode, 'negotiate');
    assert.ok(!value.itemName.includes('\n'), 'newline must be stripped');
    assert.equal(value.itemName, 'MetaBot Avatar - Glasses #1310 (second line injected)');
  }
});

test('sanitizeAskTwinToBuy rejects invalid itemPinId / seller / prices', () => {
  const badPin = sanitizeAskTwinToBuy({
    itemPinId: 'not-a-pin',
    itemName: 'x',
    sellerGlobalMetaId: VALID_OWNER,
  });
  assert.ok(badPin instanceof SanitizeFailure);
  assert.equal((badPin as SanitizeFailure).error.code, 'invalid_item_pin_id');

  const badSeller = sanitizeAskTwinToBuy({
    itemPinId: VALID_PIN,
    itemName: 'x',
    sellerGlobalMetaId: '0xdeadbeef',
  });
  assert.ok(badSeller instanceof SanitizeFailure);
  assert.equal((badSeller as SanitizeFailure).error.code, 'invalid_global_meta_id');

  const badPrice = sanitizeAskTwinToBuy({
    itemPinId: VALID_PIN,
    itemName: 'x',
    sellerGlobalMetaId: VALID_OWNER,
    priceMeMilli: -5,
  });
  assert.ok(badPrice instanceof SanitizeFailure);
  assert.equal((badPrice as SanitizeFailure).error.code, 'invalid_price');

  const missingName = sanitizeAskTwinToBuy({
    itemPinId: VALID_PIN,
    itemName: '   ',
    sellerGlobalMetaId: VALID_OWNER,
  });
  assert.ok(missingName instanceof SanitizeFailure);

  const notObject = sanitizeAskTwinToBuy('buy it all');
  assert.ok(notObject instanceof SanitizeFailure);

  // defaults: mode falls back to buy_me, unknown mode strings rejected to default
  const defaulted = sanitizeAskTwinToBuy({
    itemPinId: VALID_PIN,
    itemName: 'x',
    sellerGlobalMetaId: VALID_OWNER,
    mode: 'hack_the_exchange',
  });
  assert.ok(!(defaulted instanceof SanitizeFailure));
  if (!(defaulted instanceof SanitizeFailure)) assert.equal(defaulted.mode, 'buy_me');
});

test('sanitizeAddFriendPrompt validates target and sanitizes greeting', () => {
  const value = sanitizeAddFriendPrompt({
    targetGlobalMetaId: VALID_OWNER,
    targetName: '小林',
    greeting: 'line1\nline2',
  });
  assert.ok(!(value instanceof SanitizeFailure));
  if (!(value instanceof SanitizeFailure)) {
    assert.equal(value.targetGlobalMetaId, VALID_OWNER);
    assert.equal(value.greeting, 'line1 line2');
  }
  const bad = sanitizeAddFriendPrompt({ targetGlobalMetaId: 'short' });
  assert.ok(bad instanceof SanitizeFailure);
  assert.equal((bad as SanitizeFailure).error.code, 'invalid_global_meta_id');
});

test('sanitizePromoFeaturedItems caps at 6, validates pins and cover URLs', () => {
  const items = sanitizePromoFeaturedItems([
    { itemPinId: VALID_PIN, itemName: '#1310 金框墨镜', coverUrl: 'metafile://1E288800FDEC1A5911A169E0CB499A3BC63E6083E5F035F5D552F73C601F2CF2I0', priceCnyCents: 990 },
    { itemPinId: VALID_PIN, itemName: 'x', coverUrl: 'javascript:alert(1)' },
  ]);
  assert.ok(!(items instanceof SanitizeFailure));
  if (!(items instanceof SanitizeFailure)) {
    assert.equal(items.length, 2);
    assert.equal(items[0].coverUrl, `metafile://${VALID_PIN}`);
    assert.equal(items[1].coverUrl, undefined);
  }
  const tooMany = sanitizePromoFeaturedItems(
    Array.from({ length: 7 }, () => ({ itemPinId: VALID_PIN, itemName: 'x' })),
  );
  assert.ok(tooMany instanceof SanitizeFailure);
  const badItem = sanitizePromoFeaturedItems([{ itemPinId: 'zz', itemName: 'x' }]);
  assert.ok(badItem instanceof SanitizeFailure);
});

test('checkPromoPackOwnership is owner-only (forbidden otherwise, including no actor)', () => {
  const pack = sanitizeOpenPromoPack({
    shopOwnerGlobalMetaId: VALID_OWNER,
    shopOwnerName: '小林',
    shopSlogan: '老藏家清仓小铺 · 积分拍下 24 小时自动秒发',
    featuredItems: [{ itemPinId: VALID_PIN, itemName: '#1310' }],
  });
  assert.ok(!(pack instanceof SanitizeFailure));
  if (pack instanceof SanitizeFailure) return;
  const params = pack;

  assert.equal(checkPromoPackOwnership(params, VALID_OWNER), true);
  const stranger = checkPromoPackOwnership(params, 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5');
  assert.ok(stranger instanceof SanitizeFailure);
  assert.equal((stranger as SanitizeFailure).error.code, 'forbidden');
  const noActor = checkPromoPackOwnership(params, '');
  assert.ok(noActor instanceof SanitizeFailure);
  assert.equal((noActor as SanitizeFailure).error.code, 'forbidden');
  const nullActor = checkPromoPackOwnership(params, null);
  assert.ok(nullActor instanceof SanitizeFailure);
});

test('sanitizeOpenPromoPack rejects invalid owner ids and shapes', () => {
  const bad = sanitizeOpenPromoPack({ shopOwnerGlobalMetaId: 'x' });
  assert.ok(bad instanceof SanitizeFailure);
  assert.equal((bad as SanitizeFailure).error.code, 'invalid_global_meta_id');
  const badItems = sanitizeOpenPromoPack({ shopOwnerGlobalMetaId: VALID_OWNER, featuredItems: 'nope' });
  assert.ok(badItems instanceof SanitizeFailure);
});

test('isCommerceBridgeMethod and method→intent mapping stay in sync', () => {
  for (const method of COMMERCE_BRIDGE_METHODS) {
    assert.ok(isCommerceBridgeMethod(method));
  }
  assert.ok(!isCommerceBridgeMethod('browser.nft.buy'));
  assert.ok(!isCommerceBridgeMethod(undefined));
  assert.equal(COMMERCE_INTENT_WINDOW_EVENT, 'idbots:commerce-intent');
});

test('price formatting: milli-ME ⚡ and CNY ¥, both tolerant of junk', () => {
  assert.equal(formatMeMilli(15000), '⚡ 15 ME');
  assert.equal(formatMeMilli(12345), '⚡ 12.35 ME');
  assert.equal(formatMeMilli(150000), '⚡ 150 ME');
  assert.equal(formatMeMilli(-1), '');
  assert.equal(formatMeMilli(undefined), '');
  assert.equal(formatCnyCents(990), '¥9.90');
  assert.equal(formatCnyCents(100), '¥1.00');
  assert.equal(formatCnyCents(null), '');
});

test('tCommerce falls back to English for unknown languages and both dicts cover all keys', () => {
  assert.equal(tCommerce('commerceSendToTwin', 'zh'), '交给我的 AI 助手处理');
  assert.equal(tCommerce('commerceSendToTwin', 'zh-Hans-CN'), '交给我的 AI 助手处理');
  assert.equal(tCommerce('commerceSendToTwin', 'en'), 'Send to My Twin');
  assert.equal(tCommerce('commerceSendToTwin', 'fr'), 'Send to My Twin');
  assert.ok(tCommerce('commerceConfirmIntroBuy', 'zh').length > 10);
});

test('sanitizeAskTwinToBuy carries sellerAddress (MVC address) and degrades invalid values to undefined', () => {
  const ok = sanitizeAskTwinToBuy({
    itemPinId: VALID_PIN,
    itemName: 'x',
    sellerGlobalMetaId: VALID_OWNER,
    sellerAddress: '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET',
    tokenIndex: '1310',
    shopMetaAppPinId: VALID_PIN,
  });
  assert.ok(!(ok instanceof SanitizeFailure));
  if (!(ok instanceof SanitizeFailure)) {
    assert.equal(ok.sellerAddress, '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET');
    assert.equal(ok.tokenIndex, '1310');
    assert.equal(ok.shopMetaAppPinId, VALID_PIN);
  }
  // invalid / empty / wrong-typed sellerAddress must NOT reject the intent
  for (const bad of ['0xdeadbeef', 'bc1qxyz', '', '   ', 42, null, undefined, '1IIII0OIlinvalid']) {
    const res = sanitizeAskTwinToBuy({
      itemPinId: VALID_PIN,
      itemName: 'x',
      sellerGlobalMetaId: VALID_OWNER,
      sellerAddress: bad,
    });
    assert.ok(!(res instanceof SanitizeFailure), `sellerAddress ${JSON.stringify(bad)} must not reject`);
    if (!(res instanceof SanitizeFailure)) assert.equal(res.sellerAddress, undefined);
  }
});

test('normalizeMvcAddress keeps base58 case and rejects non-mainnet shapes', () => {
  assert.equal(normalizeMvcAddress('1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx'), '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
  assert.equal(normalizeMvcAddress(' 1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET '), '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET');
  assert.equal(normalizeMvcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), '');
  assert.equal(normalizeMvcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), '');
  assert.equal(normalizeMvcAddress('1with0zerO'), '');
});
