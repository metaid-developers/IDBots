import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseNftCardFence,
  serializeNftCardFence,
} from '../src/renderer/components/chat/nftCardSyntax';
import NftCard from '../src/renderer/components/chat/NftCard';
import SwapCompleteShopPromptCard from '../src/renderer/components/commerce/SwapCompleteShopPromptCard';
import PurchaseSuccessActionCard from '../src/renderer/components/commerce/PurchaseSuccessActionCard';
import GoodsPurchaseConfirmModal from '../src/renderer/components/commerce/GoodsPurchaseConfirmModal';

const ITEM_PIN_ID = `${'aa'.repeat(32)}i0`;
const SHOP_PIN_ID = `${'ff'.repeat(32)}i0`;
const SELLER_ADDR = '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c';
const SELLER_METAID = 'idq1seller00000000000000000000000000000000';

test('nftCardSyntax: preserves legacy key order and round-trips v2.1 commerce fields', () => {
  const card = parseNftCardFence(JSON.stringify({
    format: 'mrc721',
    pinId: ITEM_PIN_ID,
    name: 'AI Prompt Kit',
    series: 'prompt-kits',
    owner: SELLER_ADDR,
    priceSats: 120000,
    priceMeMilli: 12500,
    priceCnyCents: 1990,
    sellerGlobalMetaId: SELLER_METAID,
    sellerName: 'MerchantBot',
    sellerOnline: true,
    shopMetaAppPinId: SHOP_PIN_ID,
    caVerified: true,
    action: 'selling',
  }));

  assert.ok(card);
  assert.equal(card.priceMeMilli, 12500);
  assert.equal(card.priceCnyCents, 1990);
  assert.equal(card.sellerGlobalMetaId, SELLER_METAID);
  assert.equal(card.sellerName, 'MerchantBot');
  assert.equal(card.sellerOnline, true);
  assert.equal(card.shopMetaAppPinId, SHOP_PIN_ID);
  assert.equal(card.caVerified, true);

  const serialized = serializeNftCardFence(card);
  const body = serialized.replace(/^```nft-card\n|\n```$/g, '');
  const keys = Object.keys(JSON.parse(body));
  assert.equal(keys[0], 'format');
  assert.equal(keys[1], 'pinId');
  const reparsed = parseNftCardFence(body);
  assert.deepEqual(reparsed, card);
});

test('NftCard SSR: de-NFTified fallback title, Verified badge, dual ME/CNY currency, seller dot, and quick action capsules', () => {
  const html = renderToStaticMarkup(
    React.createElement(NftCard, {
      data: {
        format: 'mrc721',
        pinId: ITEM_PIN_ID,
        series: 'prompt-kits',
        owner: SELLER_ADDR,
        priceMeMilli: 12500,
        priceCnyCents: 1990,
        sellerGlobalMetaId: SELLER_METAID,
        sellerName: 'MerchantBot',
        sellerOnline: true,
        shopMetaAppPinId: SHOP_PIN_ID,
        caVerified: true,
        action: 'selling',
      },
    }),
  );

  // De-NFTified default item fallback + Verified badge + Dual pricing + Seller online + Action capsules
  assert.match(html, /Digital Item|数字商品/);
  assert.match(html, /Verified|官方认证/);
  assert.match(html, /12\.5 ME/);
  assert.match(html, /¥19\.90/);
  assert.match(html, /MerchantBot/);
  assert.match(html, /Buy with ME|用 ME 购买/);
  assert.match(html, /Negotiate|议价/);
  assert.match(html, /Visit Shop|逛店铺/);

  // Unverified card without selling actions omits Verified badge and Buy button
  const unverifiedHtml = renderToStaticMarkup(
    React.createElement(NftCard, {
      data: {
        format: 'mrc721',
        pinId: ITEM_PIN_ID,
        name: 'Plain Collectible',
        priceSats: 50000,
        action: 'minted',
      },
    }),
  );
  assert.doesNotMatch(unverifiedHtml, /Verified|官方认证/);
  assert.doesNotMatch(unverifiedHtml, /Buy with ME|用 ME 购买/);
  assert.match(unverifiedHtml, /50,000 sats/);
});

test('WS-D Commerce UI components SSR cleanly with expected conversion actions', () => {
  const swapHtml = renderToStaticMarkup(
    React.createElement(SwapCompleteShopPromptCard, {
      requestId: 'swap_123',
      collectionSlug: 'pixel-cats',
      completedItems: [{ tokenIndex: '42', itemPinId: ITEM_PIN_ID, itemName: 'Pixel Cat #42' }],
      shopMetaAppPinId: SHOP_PIN_ID,
      onDismiss: () => {},
      onListForSale: () => {},
      onExploreShop: () => {},
    }),
  );
  assert.match(swapHtml, /pixel-cats/);
  assert.match(swapHtml, /List for Sale|去店铺上架挂单/);
  assert.match(swapHtml, /Explore Market|逛逛数字商品市场/);

  const successHtml = renderToStaticMarkup(
    React.createElement(PurchaseSuccessActionCard, {
      orderId: 'ord_done_1',
      itemPinId: ITEM_PIN_ID,
      itemName: 'VIP Data Pack',
      amountMilli: 5000,
      shopMetaAppPinId: SHOP_PIN_ID,
      deliveryTxId: 'aa'.repeat(32),
      onDismiss: () => {},
      onViewAssets: () => {},
      onVisitSellerShop: () => {},
      onSetAvatarOrRelist: () => {},
    }),
  );
  assert.match(successHtml, /VIP Data Pack/);
  assert.match(successHtml, /5 ME/);
  assert.match(successHtml, /View My Assets|查看我的资产/);
  assert.match(successHtml, /Visit Shop|去卖家店铺逛逛/);
  assert.match(successHtml, /Avatar \/ Re-list|设为头像 \/ 转售/);

  const modalHtml = renderToStaticMarkup(
    React.createElement(GoodsPurchaseConfirmModal, {
      open: true,
      target: {
        itemPinId: ITEM_PIN_ID,
        itemName: 'VIP Data Pack',
        priceMeMilli: 5000,
        priceCnyCents: 990,
        sellerAddress: SELLER_ADDR,
        sellerGlobalMetaId: SELLER_METAID,
        sellerName: 'MerchantBot',
      },
      initialTradeSpendableMilli: 10000,
      onClose: () => {},
      onOrderSubmitted: () => {},
    }),
  );
  assert.match(modalHtml, /Confirm ME Escrow Purchase|确认 ME 担保购买/);
  assert.match(modalHtml, /VIP Data Pack/);
  assert.match(modalHtml, /5 ME/);

  const lowBalModalHtml = renderToStaticMarkup(
    React.createElement(GoodsPurchaseConfirmModal, {
      open: true,
      target: {
        itemPinId: ITEM_PIN_ID,
        itemName: 'VIP Data Pack',
        priceMeMilli: 5000,
        sellerAddress: SELLER_ADDR,
      },
      initialTradeSpendableMilli: 1000,
      onClose: () => {},
    }),
  );
  assert.match(lowBalModalHtml, /Top Up ME|充值 ME|Insufficient|余额不足/);
});
