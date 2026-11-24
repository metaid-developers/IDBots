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
import {
  buildSocialFriendPromptDraft,
  resolveCommerceIntentAction,
} from '../src/renderer/components/commerce/commerceTradeEvents';

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

  // De-NFTified default item fallback + LISTED badge + Verified badge + Dual pricing + Seller online + Action capsules
  assert.match(html, /LISTED/);
  assert.match(html, /Digital Item|数字商品/);
  assert.match(html, /Verified|官方认证/);
  assert.match(html, /12\.5 ME/);
  assert.match(html, /¥19\.90/);
  assert.match(html, /MerchantBot/);
  assert.match(html, /Buy with ME|ME 购买|用 ME 购买/);
  assert.match(html, /Negotiate|议价/);
  assert.match(html, /Visit Shop|进店|逛店铺/);

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
  assert.doesNotMatch(unverifiedHtml, /Buy with ME|ME 购买|用 ME 购买/);
  assert.match(unverifiedHtml, /50,000 sats/);

  // Default non-negotiable listing (negotiable: false) hides Negotiate capsule while keeping Buy CTA
  const nonNegotiableCard = parseNftCardFence(JSON.stringify({
    format: 'mrc721',
    pinId: ITEM_PIN_ID,
    name: 'Fixed Price NFT',
    series: 'prompt-kits',
    owner: SELLER_ADDR,
    priceMeMilli: 8000,
    sellerGlobalMetaId: SELLER_METAID,
    sellerName: 'MerchantBot',
    caVerified: true,
    negotiable: false,
    action: 'selling',
  }));
  assert.ok(nonNegotiableCard);
  assert.equal(nonNegotiableCard.negotiable, false);
  const nonNegHtml = renderToStaticMarkup(React.createElement(NftCard, { data: nonNegotiableCard }));
  assert.match(nonNegHtml, /Buy with ME|ME 购买|用 ME 购买/);
  assert.doesNotMatch(nonNegHtml, /Negotiate|议价/);
  assert.doesNotMatch(nonNegHtml, /24h|秒发/);
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

  // WS-E askTwinToBuy may omit sellerAddress when priceMeMilli > 0
  const omittedSellerModalHtml = renderToStaticMarkup(
    React.createElement(GoodsPurchaseConfirmModal, {
      open: true,
      target: {
        itemPinId: ITEM_PIN_ID,
        itemName: 'Shop Item #7',
        priceMeMilli: 3000,
        sellerGlobalMetaId: SELLER_METAID,
        sellerName: 'ShopBot',
      },
      initialTradeSpendableMilli: 5000,
      onClose: () => {},
    }),
  );
  assert.match(omittedSellerModalHtml, /Shop Item #7/);
  assert.match(omittedSellerModalHtml, /ShopBot/);
});

test('WS-E commerce-intent (askTwinToBuy) and social-friend-prompt resolve correctly', () => {
  const COLLECTION_PIN_ID = `${'cc'.repeat(32)}i0`;

  // 1. WS-E standard nested params buy_me with priceMeMilli > 0 -> open_confirm_modal with mapped collectionPinId & series
  const buyAction = resolveCommerceIntentAction({
    intent: 'askTwinToBuy',
    source: 'bot-browser',
    params: {
      mode: 'buy_me',
      itemPinId: ITEM_PIN_ID,
      collectionId: COLLECTION_PIN_ID,
      collectionName: 'Pixel Cats',
      itemName: 'Avatar #42',
      sellerGlobalMetaId: SELLER_METAID,
      sellerAddress: undefined,
      priceMeMilli: 4000,
    },
  });
  assert.equal(buyAction?.kind, 'open_confirm_modal');
  if (buyAction?.kind === 'open_confirm_modal') {
    assert.equal(buyAction.target.itemPinId, ITEM_PIN_ID);
    assert.equal(buyAction.target.collectionPinId, COLLECTION_PIN_ID);
    assert.equal(buyAction.target.series, 'Pixel Cats');
    assert.equal(buyAction.target.priceMeMilli, 4000);
    assert.equal(buyAction.target.sellerAddress, undefined);
  }

  // 2. WS-E nested params buy_me without ME price -> draft_chat guiding goods_send_inquiry
  const noPriceAction = resolveCommerceIntentAction({
    intent: 'askTwinToBuy',
    source: 'inline-metaapp',
    params: {
      mode: 'buy_me',
      itemPinId: ITEM_PIN_ID,
      collectionName: 'Pixel Cats',
      itemName: 'Avatar #42',
      sellerGlobalMetaId: SELLER_METAID,
    },
  });
  assert.equal(noPriceAction?.kind, 'draft_chat');
  if (noPriceAction?.kind === 'draft_chat') {
    assert.match(noPriceAction.text, /goods_send_inquiry/);
    assert.match(noPriceAction.text, new RegExp(ITEM_PIN_ID));
  }

  // 3. WS-E nested params negotiate and inquire_unlisted -> draft_chat guiding goods_send_inquiry
  const negotiateAction = resolveCommerceIntentAction({
    intent: 'askTwinToBuy',
    source: 'bot-browser',
    params: {
      mode: 'negotiate',
      itemPinId: ITEM_PIN_ID,
      collectionName: 'Pixel Cats',
      itemName: 'Avatar #42',
      priceMeMilli: 4000,
      sellerGlobalMetaId: SELLER_METAID,
    },
  });
  assert.equal(negotiateAction?.kind, 'draft_chat');
  if (negotiateAction?.kind === 'draft_chat') {
    assert.match(negotiateAction.text, /goods_send_inquiry/);
  }

  const unlistedAction = resolveCommerceIntentAction({
    intent: 'askTwinToBuy',
    source: 'bot-browser',
    params: {
      mode: 'inquire_unlisted',
      itemPinId: ITEM_PIN_ID,
      collectionName: 'Pixel Cats',
      itemName: 'Avatar #42',
      sellerGlobalMetaId: SELLER_METAID,
    },
  });
  assert.equal(unlistedAction?.kind, 'draft_chat');
  if (unlistedAction?.kind === 'draft_chat') {
    assert.match(unlistedAction.text, /goods_send_inquiry/);
    assert.doesNotMatch(unlistedAction.text, /Send a求购/);
  }

  // 4. Flat payload compatibility fallback still works
  const flatBuyAction = resolveCommerceIntentAction({
    intent: 'askTwinToBuy',
    mode: 'buy_me',
    itemPinId: ITEM_PIN_ID,
    collectionPinId: COLLECTION_PIN_ID,
    series: 'Flat Series',
    priceMeMilli: 2500,
    sellerGlobalMetaId: SELLER_METAID,
  });
  assert.equal(flatBuyAction?.kind, 'open_confirm_modal');
  if (flatBuyAction?.kind === 'open_confirm_modal') {
    assert.equal(flatBuyAction.target.collectionPinId, COLLECTION_PIN_ID);
    assert.equal(flatBuyAction.target.series, 'Flat Series');
  }

  // 5. social-friend-prompt nested params addFriendPrompt -> draft referencing targetGlobalMetaId and greeting
  const friendDraft = buildSocialFriendPromptDraft({
    intent: 'addFriendPrompt',
    source: 'inline-metaapp',
    params: {
      targetGlobalMetaId: SELLER_METAID,
      targetName: 'SellerBot',
      greeting: 'Hi there, interested in your Pixel Cats collection!',
    },
  });
  assert.ok(friendDraft);
  assert.match(friendDraft, new RegExp(SELLER_METAID));
  assert.match(friendDraft, /Hi there, interested in your Pixel Cats collection!/);
});
