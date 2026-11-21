import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatFtAssetBadge,
  formatFtFillCardFence,
  formatFtOrderCardFence,
  formatFtQuoteCardFence,
  isFtFillCardFenceLanguage,
  isFtOrderCardFenceLanguage,
  isFtQuoteCardFenceLanguage,
  parseFtFillCardFence,
  parseFtOrderCardFence,
  parseFtQuoteCardFence,
} from '../src/renderer/components/chat/ftCardSyntax';
import FtQuoteCard from '../src/renderer/components/chat/FtQuoteCard';
import FtOrderCard from '../src/renderer/components/chat/FtOrderCard';
import FtFillCard from '../src/renderer/components/chat/FtFillCard';
import FtMandateConfirmModal from '../src/renderer/components/commerce/FtMandateConfirmModal';

const MRC20_ASSET_KEY = `mrc20:4f92${'ab'.repeat(28)}8c1i0`;
const MVC_FT_ASSET_KEY = `mvc-ft:a242${'11'.repeat(18)}:005d${'22'.repeat(18)}`;

test('ftCardSyntax: round-trips quote/order/fill cards, rejects invalid JSON, and formats anti-spoofing asset badges', () => {
  assert.equal(isFtQuoteCardFenceLanguage('ft-quote-card'), true);
  assert.equal(isFtOrderCardFenceLanguage('ft-order-card'), true);
  assert.equal(isFtFillCardFenceLanguage('ft-fill-card'), true);

  assert.match(formatFtAssetBadge(MRC20_ASSET_KEY), /^ID: 4f92ab…b8c1i0$/);
  assert.match(formatFtAssetBadge(MVC_FT_ASSET_KEY), /^ID: a242…:005d22…2222$/);

  const quoteFence = formatFtQuoteCardFence({
    assetKey: MRC20_ASSET_KEY,
    symbol: 'METAID',
    caVerified: true,
    quotes: [
      {
        rail: 'btc-psbt',
        label: 'MetaID.Market (BTC)',
        floorUnit: '9.8 sat',
        depthDisplay: '12,400',
        recommended: true,
      },
      {
        rail: 'me-escrow',
        label: 'ME Instant Desk',
        floorUnit: '0.145 ME',
        depthDisplay: '3,200',
      },
    ],
    suggestion: 'Combine 3 BTC lots for lowest average unit price',
  });
  const quoteBody = quoteFence.replace(/^```ft-quote-card\n|\n```$/g, '');
  const parsedQuote = parseFtQuoteCardFence(quoteBody);
  assert.ok(parsedQuote);
  assert.equal(parsedQuote.symbol, 'METAID');
  assert.equal(parsedQuote.quotes.length, 2);
  assert.equal(parsedQuote.quotes[0].recommended, true);

  const orderFence = formatFtOrderCardFence({
    batchGroupId: 'batch_20261121_01',
    assetKey: MRC20_ASSET_KEY,
    symbol: 'METAID',
    caVerified: false,
    rail: 'me-escrow',
    lotAmountDisplay: '200',
    totalLots: 5,
    filledLots: 2,
    unitPriceLabel: '0.145 ME / token (29 ME / lot)',
    autoFulfill: true,
    orderRefs: [`${'aa'.repeat(32)}i0`],
  });
  const parsedOrder = parseFtOrderCardFence(
    orderFence.replace(/^```ft-order-card\n|\n```$/g, ''),
  );
  assert.ok(parsedOrder);
  assert.equal(parsedOrder.totalLots, 5);
  assert.equal(parsedOrder.filledLots, 2);
  assert.equal(parsedOrder.autoFulfill, true);

  const fillFence = formatFtFillCardFence({
    side: 'buy',
    assetKey: MRC20_ASSET_KEY,
    symbol: 'METAID',
    totalTokenDisplay: '1,000',
    filledOrderCount: 3,
    totalPaidLabel: '0.00942 BTC',
    avgUnitPriceLabel: '9.10 sat / token',
    txids: ['11'.repeat(32), '22'.repeat(32)],
    nextActions: ['browse_token_goods', 'browse_paybuzz'],
  });
  const parsedFill = parseFtFillCardFence(
    fillFence.replace(/^```ft-fill-card\n|\n```$/g, ''),
  );
  assert.ok(parsedFill);
  assert.equal(parsedFill.filledOrderCount, 3);
  assert.deepEqual(parsedFill.nextActions, ['browse_token_goods', 'browse_paybuzz']);

  assert.equal(parseFtQuoteCardFence('{broken json'), null);
  assert.equal(parseFtOrderCardFence(JSON.stringify({ symbol: 'ONLY' })), null);
  assert.equal(parseFtFillCardFence(JSON.stringify({ side: 'invalid' })), null);
});

test('FtQuoteCard SSR: distinguishes CA-verified token from unverified homograph ticker with anti-spoofing ID badge', () => {
  const verifiedHtml = renderToStaticMarkup(
    React.createElement(FtQuoteCard, {
      data: {
        assetKey: MRC20_ASSET_KEY,
        symbol: 'METAID',
        caVerified: true,
        quotes: [
          {
            rail: 'btc-psbt',
            label: 'MetaID.Market (BTC)',
            floorUnit: '9.8 sat',
            depthDisplay: '12,400',
            recommended: true,
          },
        ],
        suggestion: 'Sweep 3 lots on BTC PSBT',
      },
    }),
  );
  assert.match(verifiedHtml, /data-ft-card="quote"/);
  assert.match(verifiedHtml, /data-ft-verified="true"/);
  assert.match(verifiedHtml, /9\.8 sat/);

  const unverifiedHtml = renderToStaticMarkup(
    React.createElement(FtQuoteCard, {
      data: {
        assetKey: MVC_FT_ASSET_KEY,
        symbol: 'METAID',
        caVerified: false,
        quotes: [
          {
            rail: 'mvc-tokensell',
            label: 'MVC Atomic Order',
            floorUnit: '0.0042 SPACE',
            depthDisplay: '5,000',
          },
        ],
      },
    }),
  );
  assert.match(unverifiedHtml, /data-ft-verified="false"/);
  assert.match(unverifiedHtml, /ID: a242…:005d22…2222/);
});

test('FtOrderCard & FtFillCard SSR: renders multi-lot progress, promo poster button, batch cancel, and utility handoffs', () => {
  const orderHtml = renderToStaticMarkup(
    React.createElement(FtOrderCard, {
      data: {
        batchGroupId: 'batch_mc_05',
        assetKey: MVC_FT_ASSET_KEY,
        symbol: 'MC',
        caVerified: false,
        rail: 'me-escrow',
        lotAmountDisplay: '500',
        totalLots: 5,
        filledLots: 2,
        unitPriceLabel: '0.05 ME / token',
        autoFulfill: true,
        orderRefs: [`${'bb'.repeat(32)}i0`],
      },
    }),
  );
  assert.match(orderHtml, /data-ft-card="order"/);
  assert.match(orderHtml, /500 MC × 5/);
  assert.match(orderHtml, /2\/5/);
  assert.match(orderHtml, /width:40%/);
  assert.match(orderHtml, /(Generate Promo Poster|生成社群推销海报)/);
  assert.match(orderHtml, /(Cancel All Remaining|一键全部撤单)/);

  const fillHtml = renderToStaticMarkup(
    React.createElement(FtFillCard, {
      data: {
        side: 'buy',
        assetKey: MRC20_ASSET_KEY,
        symbol: 'METAID',
        caVerified: true,
        totalTokenDisplay: '1,000',
        filledOrderCount: 3,
        totalPaidLabel: '145 ME',
        avgUnitPriceLabel: '0.145 ME',
        txids: ['cc'.repeat(32)],
        nextActions: ['browse_token_goods', 'browse_paybuzz'],
      },
    }),
  );
  assert.match(fillHtml, /data-ft-card="fill"/);
  assert.match(fillHtml, /\+1,000 METAID/);
  assert.match(fillHtml, /145 ME/);
  assert.match(fillHtml, /(Shop with \$METAID|用 \$METAID 逛数字好物)/);
  assert.match(fillHtml, /(Unlock PayBuzz Articles|解锁链上付费文章)/);
});

test('FtMandateConfirmModal SSR: gates ME escrow confirmation on spendable ME balance and surfaces inline QR top-up', () => {
  const promptPayload = {
    requestId: 'req_mandate_001',
    draft: {
      metabotId: 1,
      action: 'buy-sweep' as const,
      assetKey: MRC20_ASSET_KEY,
      symbol: 'METAID',
      rail: 'me-escrow' as const,
      totalTokenDisplay: '400',
      lotCount: 2,
      maxSpendDisplay: '58 ME',
      maxSpendAmount: '58000',
      estimatedGasDisplay: '0 sats (seller pays delivery gas)',
      caVerified: false,
    },
    expiresAt: Date.now() + 120_000,
    timeoutMs: 120_000,
  };

  // Insufficient ME: shows shortfall + inline QR top-up button and disables Approve Mandate
  const shortfallHtml = renderToStaticMarkup(
    React.createElement(FtMandateConfirmModal, {
      open: true,
      prompt: promptPayload,
      onResolved: () => {},
      initialTradeSpendableMilli: 20_000,
    }),
  );
  assert.match(shortfallHtml, /data-commerce-modal="ft-mandate-confirm"/);
  assert.match(shortfallHtml, /ID: 4f92ab…b8c1i0/);
  assert.match(shortfallHtml, /38 ME/);
  assert.match(shortfallHtml, /(Scan QR to Top Up ME|原地扫码补足 ME)/);
  assert.match(shortfallHtml, /disabled=""[^>]*>(Approve Mandate|确认单次授权)</);

  // Sufficient ME: enables Approve Mandate with zero shortfall banner
  const readyHtml = renderToStaticMarkup(
    React.createElement(FtMandateConfirmModal, {
      open: true,
      prompt: promptPayload,
      onResolved: () => {},
      initialTradeSpendableMilli: 80_000,
    }),
  );
  assert.doesNotMatch(readyHtml, /(Scan QR to Top Up ME|原地扫码补足 ME)/);
  assert.doesNotMatch(readyHtml, /disabled=""[^>]*>(Approve Mandate|确认单次授权)</);
});
