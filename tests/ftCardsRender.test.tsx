import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatFtAssetBadge,
  formatFtFillCardFence,
  formatFtOrderBookCardFence,
  formatFtOrderCardFence,
  formatFtQuoteCardFence,
  isFtFillCardFenceLanguage,
  isFtOrderBookCardFenceLanguage,
  isFtOrderCardFenceLanguage,
  isFtQuoteCardFenceLanguage,
  parseFtFillCardFence,
  parseFtOrderBookCardFence,
  parseFtOrderCardFence,
  parseFtQuoteCardFence,
} from '../src/renderer/components/chat/ftCardSyntax';
import FtOrderBookCard from '../src/renderer/components/chat/FtOrderBookCard';
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

test('FtOrderCard & FtFillCard SSR: renders multi-lot progress & dual-flow receipt with all bottom promo/cancel/utility buttons stripped', () => {
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
  assert.doesNotMatch(orderHtml, /(Generate Promo Poster|生成社群推销海报)/);
  assert.doesNotMatch(orderHtml, /(Cancel All Remaining|一键全部撤单)/);

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
  assert.doesNotMatch(fillHtml, /(Shop with \$METAID|用 \$METAID 逛数字好物)/);
  assert.doesNotMatch(fillHtml, /(Unlock PayBuzz Articles|解锁链上付费文章)/);
});

test('FtOrderBookCard (OB-1) & FtFillCard (S-1 passive sell) SSR: renders 6-per-page paginated order book, #1 floor highlight, and passive sell receipt', () => {
  assert.equal(isFtOrderBookCardFenceLanguage('ft-orderbook-card'), true);
  assert.equal(isFtOrderBookCardFenceLanguage('ft-orders-card'), true);

  const orders = Array.from({ length: 18 }, (_, i) => ({
    rank: i + 1,
    orderId: `ord_metaid_${i + 1}`,
    rail: 'btc-psbt' as const,
    amountDisplay: String((i + 1) * 100),
    unitPricePrimary: `${1440 + i * 10} sat`,
    unitPriceSecondary: '0.0000144 BTC',
    totalPriceLabel: `${((1440 + i * 10) * (i + 1) * 100 / 1e8).toFixed(5)} BTC`,
    sellerAddress: 'bc1qseller0000000000000000000000000000',
  }));

  const obFence = formatFtOrderBookCardFence({
    assetKey: MRC20_ASSET_KEY,
    symbol: 'METAID',
    chain: 'btc',
    standard: 'idcoin',
    rail: 'btc-psbt',
    caVerified: true,
    floorPriceLabel: '1,440 sat',
    floorUsdText: '$0.98',
    holdersCount: 4128,
    totalOrdersCount: 42,
    pageSize: 6,
    totalCurrencyUnit: 'BTC',
    orders,
  });

  const parsedOb = parseFtOrderBookCardFence(
    obFence.replace(/^```ft-orderbook-card\n|\n```$/g, ''),
  );
  assert.ok(parsedOb);
  assert.equal(parsedOb.orders.length, 18);
  assert.equal(parsedOb.pageSize, 6);
  assert.equal(parsedOb.totalOrdersCount, 42);

  const obHtml = renderToStaticMarkup(React.createElement(FtOrderBookCard, { data: parsedOb }));
  assert.match(obHtml, /data-ft-card="orderbook"/);
  assert.match(obHtml, /data-ft-floor-row="true"/);
  assert.match(obHtml, /1,440 sat/);
  assert.match(obHtml, /\$0\.98/);
  assert.match(obHtml, /4,128/);
  assert.match(obHtml, /42/);
  // Page 1 of 3 shows 1/3 (1–6) and row #6, NOT row #7
  assert.match(obHtml, /1\/3/);
  assert.match(obHtml, /1–6/);
  assert.match(obHtml, /1490 sat/);
  assert.doesNotMatch(obHtml, /1500 sat/);
  assert.match(obHtml, /(Buy Lowest Lot|一键买最低 1 单)/);

  // Segment splitter & MarkdownContent fallback both render ft-orderbook-card
  const segs = splitTokenCardMessageSegments(`Current order book:\n\n${obFence}`);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].kind, 'ft-orderbook-card');
  if (segs[1].kind !== 'markdown') {
    const segHtml = renderToStaticMarkup(
      React.createElement(TokenSuiteSegmentCard, { segment: segs[1] }),
    );
    assert.match(segHtml, /data-ft-card="orderbook"/);
  }
  const mdHtml = renderToStaticMarkup(React.createElement(MarkdownContent, { content: obFence }));
  assert.match(mdHtml, /data-ft-card="orderbook"/);

  // Passive sell S-1 receipt via FtFillCard(side="sell")
  const passiveSellHtml = renderToStaticMarkup(
    React.createElement(FtFillCard, {
      data: {
        side: 'sell',
        assetKey: MRC20_ASSET_KEY,
        symbol: 'METAID',
        caVerified: true,
        rail: 'btc-psbt',
        chain: 'btc',
        totalTokenDisplay: '500',
        filledOrderCount: 1,
        totalPaidLabel: '0.0072 BTC (720,000 sats)',
        avgUnitPriceLabel: '1,440 sats',
        counterpartyName: '买家 bc1qar...5mdq',
        txids: ['dd'.repeat(32)],
        nextActions: [],
      },
    }),
  );
  assert.match(passiveSellHtml, /data-ft-card="fill"/);
  assert.match(passiveSellHtml, /-500 METAID/);
  assert.match(passiveSellHtml, /\+0\.0072 BTC/);
  assert.match(passiveSellHtml, /720,000 sats/);
  assert.match(passiveSellHtml, /bc1qar\.\.\.5mdq/);
  assert.doesNotMatch(passiveSellHtml, /(Shop with|逛数字好物|Unlock PayBuzz|解锁链上付费文章)/);
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

import {
  formatFtActionCardFence,
  formatFtBridgeCardFence,
  formatFtMyOrdersCardFence,
  formatFtPortfolioCardFence,
  formatFtRailLabel,
  inferFtChainAndStandard,
  isFtActionCardFenceLanguage,
  isFtBridgeCardFenceLanguage,
  isFtMyOrdersCardFenceLanguage,
  isFtPortfolioCardFenceLanguage,
  parseFtActionCardFence,
  parseFtBridgeCardFence,
  parseFtMyOrdersCardFence,
  parseFtPortfolioCardFence,
} from '../src/renderer/components/chat/ftCardSyntax';
import {
  hasStandaloneTokenCardSegment,
  splitTokenCardMessageSegments,
} from '../src/renderer/components/chat/tokenCardSyntax';
import FtMyOrdersCard from '../src/renderer/components/chat/FtMyOrdersCard';
import FtPortfolioCard from '../src/renderer/components/chat/FtPortfolioCard';
import FtBridgeCard from '../src/renderer/components/chat/FtBridgeCard';
import FtActionCard from '../src/renderer/components/chat/FtActionCard';
import TokenSuiteSegmentCard from '../src/renderer/components/chat/TokenSuiteSegmentCard';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import {
  appendNftCardFencesToReply,
  extractEmittedNftCardFences,
  recordCapturedNftCardFences,
  selectMissingNftCardFences,
  type CapturedNftCardFence,
} from '../src/main/libs/nftCardTurnBackstop';
import { buildWalletAgentTools, type WalletToolsControl } from '../src/main/libs/walletAgentTools';
import {
  TOOL_CAPABILITY_REGISTRY,
  isMobileToolVisible,
  resolveMobileToolExpansions,
} from '../src/main/libs/toolCapabilityRegistry';
import { buildProjectorModePrompt } from '../src/main/libs/assistantModePrompt';
import { buildOwnerInteractionPrompt } from '../src/main/libs/ownerInteractionPrompt';

test('Approved Suite Schemas & Labels: O1, P2, B1, M1/M2 round-trip cleanly and eliminate ME Instant Escrow jargon', () => {
  assert.equal(isFtMyOrdersCardFenceLanguage('ft-my-orders-card'), true);
  assert.equal(isFtPortfolioCardFenceLanguage('ft-portfolio-card'), true);
  assert.equal(isFtBridgeCardFenceLanguage('ft-bridge-card'), true);
  assert.equal(isFtActionCardFenceLanguage('ft-action-card'), true);

  assert.equal(formatFtRailLabel('me-escrow', 'en'), '✦ ME Points Trade');
  assert.equal(formatFtRailLabel('me-escrow', 'zh'), '✦ ME 积分交易');
  assert.equal(formatFtRailLabel('mvc-swap', 'zh'), 'MVC · MVCSwap 闪兑');
  assert.doesNotMatch(formatFtRailLabel('me-escrow', 'en'), /Escrow/i);

  assert.deepEqual(inferFtChainAndStandard(MRC20_ASSET_KEY), {
    chain: 'btc',
    standard: 'mrc20',
  });
  assert.deepEqual(inferFtChainAndStandard(MVC_FT_ASSET_KEY), {
    chain: 'mvc',
    standard: 'mvc-ft',
  });

  // O1 My Orders round-trip
  const myOrdersFence = formatFtMyOrdersCardFence({
    botName: 'AI_Sunny',
    metabotId: 1,
    totalOrdersCount: 2,
    orders: [
      {
        id: 'ord_me_1',
        batchGroupId: 'batch_me_1',
        assetKey: MVC_FT_ASSET_KEY,
        symbol: 'METAID',
        caVerified: true,
        rail: 'me-escrow',
        unitPriceLabel: '0.145 ME / 枚',
        lotSummaryText: '200 METAID × 3 包',
        filledLots: 1,
        totalLots: 3,
      },
      {
        id: 'ord_btc_2',
        assetKey: MRC20_ASSET_KEY,
        symbol: 'MSP',
        rail: 'btc-psbt',
        unitPriceLabel: '12 sat',
        lotSummaryText: '1,000 MSP × 1 包',
        filledLots: 0,
        totalLots: 1,
      },
    ],
  });
  const parsedMyOrders = parseFtMyOrdersCardFence(
    myOrdersFence.replace(/^```ft-my-orders-card\n|\n```$/g, ''),
  );
  assert.ok(parsedMyOrders);
  assert.equal(parsedMyOrders.orders.length, 2);
  assert.equal(parsedMyOrders.orders[0].rail, 'me-escrow');

  // P2 Portfolio round-trip
  const portfolioFence = formatFtPortfolioCardFence({
    botName: 'AI_Sunny',
    metabotId: 1,
    totalUsdEstimate: '≈ $1,420.50',
    btcGasText: '84,200 sats',
    mvcGasText: '12.45 SPACE',
    btcHoldings: [
      {
        assetKey: MRC20_ASSET_KEY,
        symbol: 'METAID',
        chain: 'btc',
        standard: 'idcoin',
        caVerified: true,
        totalDisplay: '1,250',
        usdEstimate: '≈ $737.50',
        bridgedPeer: true,
      },
    ],
    mvcHoldings: [
      {
        assetKey: MVC_FT_ASSET_KEY,
        symbol: 'METAID',
        chain: 'mvc',
        standard: 'mvc-ft',
        caVerified: true,
        totalDisplay: '3,500',
        availableDisplay: '3,000',
        lockedDisplay: '500',
        bridgedPeer: true,
      },
    ],
  });
  const parsedPortfolio = parseFtPortfolioCardFence(
    portfolioFence.replace(/^```ft-portfolio-card\n|\n```$/g, ''),
  );
  assert.ok(parsedPortfolio);
  assert.equal(parsedPortfolio.btcHoldings.length, 1);
  assert.equal(parsedPortfolio.mvcHoldings[0].lockedDisplay, '500');
  assert.equal(parsedPortfolio.mvcHoldings[0].bridgedPeer, true);

  // B1 Bridge round-trip
  const bridgeFence = formatFtBridgeCardFence({
    symbol: 'METAID',
    assetKey: MVC_FT_ASSET_KEY,
    direction: 'mvc-to-btc',
    status: 'bridging',
    sendAmountDisplay: '1,000',
    receiveAmountDisplay: '1,000',
    stepCurrent: 2,
    confirmationsText: '1 / 2 BTC blocks',
    txid: 'aa'.repeat(32),
  });
  const parsedBridge = parseFtBridgeCardFence(
    bridgeFence.replace(/^```ft-bridge-card\n|\n```$/g, ''),
  );
  assert.ok(parsedBridge);
  assert.equal(parsedBridge.direction, 'mvc-to-btc');
  assert.equal(parsedBridge.stepCurrent, 2);

  // M1 / M2 Action round-trip
  const issueFence = formatFtActionCardFence({
    action: 'issue',
    symbol: 'SUNNY',
    name: 'Sunny Agent Coin',
    chain: 'mvc',
    standard: 'mvc-ft',
    assetKey: MVC_FT_ASSET_KEY,
    amountDisplay: '21,000,000',
    decimals: 8,
    mintable: false,
    receiverAddress: '1TwinMvcAddr9999999999',
    genesisId: '005d2222222222222222',
    txid: 'dd'.repeat(32),
  });
  const parsedIssue = parseFtActionCardFence(
    issueFence.replace(/^```ft-action-card\n|\n```$/g, ''),
  );
  assert.ok(parsedIssue);
  assert.equal(parsedIssue.action, 'issue');
  assert.equal(parsedIssue.mintable, false);
});

test('SSR Suite Verification: L2 long-decimal fix, Q1 4-rail + MVCSwap, F2 dual-flow, O1, P2, B1 (active & paused), and M1/M2', () => {
  // 1. L2 Order Card: long 8-decimal lot amount + long unit price on separate ledger rows, clean ME Points label
  const l2BugFixHtml = renderToStaticMarkup(
    React.createElement(FtOrderCard, {
      data: {
        batchGroupId: 'batch_long_dec_01',
        assetKey: MVC_FT_ASSET_KEY,
        symbol: 'METAID',
        caVerified: true,
        rail: 'me-escrow',
        lotAmountDisplay: '1.04842259',
        totalLots: 1,
        filledLots: 0,
        unitPriceLabel: '9.538139 ME / 枚 (每包 10 ME)',
        totalValueLabel: '10 ME',
        autoFulfill: true,
      },
    }),
  );
  assert.match(l2BugFixHtml, /1\.04842259 METAID × 1/);
  assert.match(l2BugFixHtml, /9\.538139 ME \/ 枚 \(每包 10 ME\)/);
  assert.match(l2BugFixHtml, /(MVC · MetaContract|MVC·Contract|MVC·合约)/);
  assert.match(l2BugFixHtml, /(✦ ME Points Trade|✦ ME 积分交易)/);
  assert.doesNotMatch(l2BugFixHtml, /Instant Escrow/);
  assert.doesNotMatch(l2BugFixHtml, /text-white[^>]*>(Generate Promo Poster|生成社群推销海报)/);

  // 2. Q1 Quote Card: auto-appends MVC · MVCSwap coming_soon preview row & uses dark ink on #ffdc51
  const q1Html = renderToStaticMarkup(
    React.createElement(FtQuoteCard, {
      data: {
        assetKey: MRC20_ASSET_KEY,
        symbol: 'METAID',
        caVerified: true,
        bridgedDualChain: true,
        budgetLabel: 'Budget ≤ 100 ME',
        quotes: [
          {
            rail: 'me-escrow',
            label: 'ME Points',
            floorUnit: '0.142 ME',
            depthDisplay: '8,500',
            recommended: true,
          },
          {
            rail: 'btc-psbt',
            label: 'metaid.market',
            floorUnit: '9.8 sat',
            depthDisplay: '12,400',
          },
          {
            rail: 'mvc-tokensell',
            label: 'TokenSell',
            floorUnit: '0.0041 SPACE',
            depthDisplay: '5,000',
          },
        ],
        suggestion: 'Sweep 2 ME lots for zero buyer gas',
      },
    }),
  );
  assert.match(q1Html, /MVCSwap/);
  assert.match(q1Html, /(Coming Soon|即将开放)/);
  assert.match(q1Html, /(Best Route|最划算)/);
  assert.match(q1Html, /text-\[#24210c\]/);
  assert.match(q1Html, /(Sweep Best Quote|按最优方案扫货)/);

  // 3. F2 Fill Card: sell side dual-flow ("Delivered" -> "Net Proceeds")
  const f2SellHtml = renderToStaticMarkup(
    React.createElement(FtFillCard, {
      data: {
        side: 'sell',
        assetKey: MVC_FT_ASSET_KEY,
        symbol: 'METAID',
        caVerified: true,
        rail: 'me-escrow',
        totalTokenDisplay: '500',
        filledOrderCount: 1,
        totalPaidLabel: '+72.5 ME',
        avgUnitPriceLabel: '0.145 ME',
        txids: ['ef'.repeat(32)],
      },
    }),
  );
  assert.match(f2SellHtml, /data-ft-side="sell"/);
  assert.match(f2SellHtml, /-500 METAID/);
  assert.match(f2SellHtml, /\+72\.5 ME/);
  assert.match(f2SellHtml, /MVC · MetaContract|MVC·Contract|MVC·合约/);

  // 4. O1 My Orders Card
  const o1Html = renderToStaticMarkup(
    React.createElement(FtMyOrdersCard, {
      data: {
        botName: 'AI_Sunny',
        totalOrdersCount: 2,
        orders: [
          {
            id: 'ord_1',
            batchGroupId: 'batch_1',
            assetKey: MVC_FT_ASSET_KEY,
            symbol: 'METAID',
            caVerified: true,
            rail: 'me-escrow',
            unitPriceLabel: '0.145 ME',
            lotSummaryText: '200 METAID × 4',
            filledLots: 1,
            totalLots: 4,
          },
          {
            id: 'ord_2',
            assetKey: MRC20_ASSET_KEY,
            symbol: 'MSP',
            rail: 'btc-psbt',
            unitPriceLabel: '12 sat',
            lotSummaryText: '1,000 MSP × 1',
            filledLots: 0,
            totalLots: 1,
          },
        ],
      },
    }),
  );
  assert.match(o1Html, /data-ft-card="my-orders"/);
  assert.match(o1Html, /width:25%/);
  assert.match(o1Html, /(Cancel All|全部撤单)/);
  assert.match(o1Html, /(New Listing|新增挂牌)/);

  // 5. P2 Portfolio Card: partitioned BTC & MVC sections + bridged indicator
  const p2Html = renderToStaticMarkup(
    React.createElement(FtPortfolioCard, {
      data: {
        botName: 'AI_Sunny',
        btcGasText: '84,200 sats',
        mvcGasText: '12.45 SPACE',
        btcHoldings: [
          {
            assetKey: MRC20_ASSET_KEY,
            symbol: 'METAID',
            chain: 'btc',
            standard: 'idcoin',
            caVerified: true,
            totalDisplay: '1,250',
            bridgedPeer: true,
          },
        ],
        mvcHoldings: [
          {
            assetKey: MVC_FT_ASSET_KEY,
            symbol: 'METAID',
            chain: 'mvc',
            standard: 'mvc-ft',
            caVerified: true,
            totalDisplay: '3,500',
            availableDisplay: '3,000',
            lockedDisplay: '500',
            bridgedPeer: true,
          },
        ],
      },
    }),
  );
  assert.match(p2Html, /data-ft-card="portfolio"/);
  assert.match(p2Html, /Bitcoin/);
  assert.match(p2Html, /MetaContract/);
  assert.match(p2Html, /84,200 sats/);
  assert.match(p2Html, /12\.45 SPACE/);
  assert.match(p2Html, /⇄/);

  // 6. B1 Bridge Card: active mvc-to-btc 3-step tracker & paused btc-to-mvc maintenance fallback
  const b1ActiveHtml = renderToStaticMarkup(
    React.createElement(FtBridgeCard, {
      data: {
        symbol: 'METAID',
        direction: 'mvc-to-btc',
        status: 'bridging',
        sendAmountDisplay: '1,000',
        receiveAmountDisplay: '1,000',
        stepCurrent: 2,
        confirmationsText: '1/2 confirmations',
        txid: 'ab'.repeat(32),
      },
    }),
  );
  assert.match(b1ActiveHtml, /data-ft-card="bridge"/);
  assert.match(b1ActiveHtml, /data-bridge-status="bridging"/);
  assert.match(b1ActiveHtml, /1\/2 confirmations/);

  const b1PausedHtml = renderToStaticMarkup(
    React.createElement(FtBridgeCard, {
      data: {
        symbol: 'METAID',
        direction: 'btc-to-mvc',
        status: 'paused',
        sendAmountDisplay: '500',
      },
    }),
  );
  assert.match(b1PausedHtml, /data-bridge-status="paused"/);
  assert.match(b1PausedHtml, /PSBT/);
  assert.match(b1PausedHtml, /ME/);

  // 7. M1 Genesis Certificate vs M2 Compact Mint/Transfer Receipt
  const m1IssueHtml = renderToStaticMarkup(
    React.createElement(FtActionCard, {
      data: {
        action: 'issue',
        symbol: 'SUNNY',
        name: 'Sunny Coin',
        chain: 'mvc',
        standard: 'mvc-ft',
        assetKey: MVC_FT_ASSET_KEY,
        amountDisplay: '21,000,000',
        decimals: 8,
        mintable: false,
        receiverAddress: '1TwinMvcAddr9999999999',
        genesisId: '005d2222222222222222',
        txid: 'cd'.repeat(32),
      },
    }),
  );
  assert.match(m1IssueHtml, /data-ft-action-variant="m1-certificate"/);
  assert.match(m1IssueHtml, /21,000,000/);
  assert.match(m1IssueHtml, /(Fixed Supply|固定总量)/);
  assert.match(m1IssueHtml, /(List for Sale|去挂牌上架)/);

  const m2TransferHtml = renderToStaticMarkup(
    React.createElement(FtActionCard, {
      data: {
        action: 'transfer',
        symbol: 'SUNNY',
        chain: 'mvc',
        standard: 'mvc-ft',
        amountDisplay: '250',
        receiverLabel: 'MetaBot #2',
        receiverAddress: '1WorkerMvcAddr88888888',
        txid: 'ef'.repeat(32),
      },
    }),
  );
  assert.match(m2TransferHtml, /data-ft-action-variant="m2-receipt"/);
  assert.match(m2TransferHtml, /250 SUNNY/);
  assert.match(m2TransferHtml, /MetaBot #2/);
});

test('Standalone segment splitting & MarkdownContent fallback cover all 8 Token/FT suite fences', () => {
  const orderFence = formatFtOrderCardFence({
    batchGroupId: 'b_split_1',
    assetKey: MVC_FT_ASSET_KEY,
    symbol: 'METAID',
    caVerified: true,
    rail: 'me-escrow',
    lotAmountDisplay: '100',
    totalLots: 2,
    filledLots: 0,
    unitPriceLabel: '0.15 ME',
  });
  const actionFence = formatFtActionCardFence({
    action: 'mint',
    symbol: 'SUNNY',
    chain: 'mvc',
    standard: 'mvc-ft',
    amountDisplay: '5,000',
    txid: '12'.repeat(32),
  });

  const mixedMessage = `Here is your active listing:\n\n${orderFence}\n\nAnd your mint receipt:\n\n${actionFence}`;
  const segments = splitTokenCardMessageSegments(mixedMessage);
  assert.equal(hasStandaloneTokenCardSegment(segments), true);
  assert.equal(segments.length, 4);
  assert.equal(segments[0].kind, 'markdown');
  assert.equal(segments[1].kind, 'ft-order-card');
  assert.equal(segments[2].kind, 'markdown');
  assert.equal(segments[3].kind, 'ft-action-card');

  // Render via TokenSuiteSegmentCard
  if (segments[1].kind !== 'markdown' && segments[3].kind !== 'markdown') {
    const seg1Html = renderToStaticMarkup(
      React.createElement(TokenSuiteSegmentCard, { segment: segments[1] }),
    );
    const seg3Html = renderToStaticMarkup(
      React.createElement(TokenSuiteSegmentCard, { segment: segments[3] }),
    );
    assert.match(seg1Html, /data-ft-card="order"/);
    assert.match(seg3Html, /data-ft-action-variant="m2-receipt"/);
  }

  // Streaming unclosed new suite fence produces token-card-streaming placeholder
  const streamingMsg = ' fetching portfolio...\n```ft-portfolio-card\n{"botName":"AI_Sunny"';
  const streamSegs = splitTokenCardMessageSegments(streamingMsg, { isStreaming: true });
  assert.equal(hasStandaloneTokenCardSegment(streamSegs), true);
  assert.equal(streamSegs.length, 2);
  assert.equal(streamSegs[1].kind, 'token-card-streaming');

  // MarkdownContent fallback also renders new fences when embedded directly
  const bridgeFence = formatFtBridgeCardFence({
    symbol: 'METAID',
    direction: 'btc-to-mvc',
    status: 'paused',
    sendAmountDisplay: '200',
  });
  const mdHtml = renderToStaticMarkup(
    React.createElement(MarkdownContent, { content: bridgeFence }),
  );
  assert.match(mdHtml, /data-ft-card="bridge"/);
});

test('Host wallet tools, capability registry, prompts, and turn backstop wire FT suite cards end-to-end', async () => {
  // 1. Capability registry & mobile intent expansion
  for (const toolName of [
    'wallet_token_portfolio',
    'wallet_token_my_orders',
    'wallet_token_bridge_card',
  ]) {
    assert.equal(TOOL_CAPABILITY_REGISTRY.get(toolName)?.domain, 'financial');
    assert.equal(isMobileToolVisible(toolName, []), false);
  }
  const bridgeExpand = resolveMobileToolExpansions(undefined, '查询跨链桥进度');
  assert.ok(bridgeExpand.includes('financial'));
  assert.equal(isMobileToolVisible('wallet_token_bridge_card', bridgeExpand), true);

  // 2. Assistant & Owner prompts whitelist all new suite card fences
  const projectorZh = buildProjectorModePrompt('zh');
  const projectorEn = buildProjectorModePrompt('en');
  for (const tag of [
    'ft-my-orders-card',
    'ft-portfolio-card',
    'ft-bridge-card',
    'ft-action-card',
  ]) {
    assert.ok(projectorZh.includes(tag), `zh prompt missing ${tag}`);
    assert.ok(projectorEn.includes(tag), `en prompt missing ${tag}`);
  }
  const ownerPrompt = buildOwnerInteractionPrompt({
    surface: 'desktop_studio',
    hasOwnerUpdate: true,
    hasProjector: true,
    hasDesktopBrowser: true,
    hasWebSearch: true,
  });
  assert.ok(ownerPrompt.includes('wallet_token_portfolio'));
  assert.ok(ownerPrompt.includes('wallet_token_my_orders'));
  assert.ok(ownerPrompt.includes('wallet_token_bridge_card'));

  // 3. Execute built-in wallet tools and verify emitted fences + backstop capture
  const mockControl = {
    resolveMetabotIdByName: (name: string) => (name === 'AI_Sunny' ? 1 : null),
    getMetabotSummary: () => ({ id: 1, name: 'AI_Sunny' }),
    getMetabotMvcAddress: () => '1TwinMvcAddr1111111111',
    getBalances: async () => ({
      entries: [
        {
          metabot_id: 1,
          name: 'AI_Sunny',
          balances: {
            btc: { total_sats: 55_000, confirmed_sats: 55_000, unconfirmed_sats: 0 },
            mvc: { total_sats: 250_000_000, confirmed_sats: 250_000_000, unconfirmed_sats: 0 },
          },
        },
      ],
    }),
    listMrc20s: async () => [
      {
        metabot_id: 1,
        assets: [
          {
            mrc20Id: MRC20_ASSET_KEY.replace(/^mrc20:/, ''),
            symbol: 'METAID',
            tokenName: 'MetaID Coin',
            balance: { display: '1200', confirmed: '1200' },
          },
        ],
      },
    ],
    listMvcFtTokens: async () => [
      {
        metabot_id: 1,
        balance: {
          tokens: [
            {
              symbol: 'METAID',
              codeHash: 'a242' + '11'.repeat(18),
              genesis: '005d' + '22'.repeat(18),
              decimal: 8,
              balance: '30000000000', // 300 METAID
            },
          ],
        },
      },
    ],
    listActiveFtOrders: () => [
      {
        listingKey: 'lk_1',
        batchGroupId: 'batch_sunny_01',
        metabotId: 1,
        chain: 'mvc',
        rail: 'me-escrow',
        assetKey: MVC_FT_ASSET_KEY,
        symbol: 'METAID',
        amountBase: '5000000000',
        amountDisplay: '50',
        priceMeMilli: 7500,
        status: 'active',
      },
    ],
    sellToken: async () => ({
      txId: '77'.repeat(32),
      fundingTxIds: ['66'.repeat(32)],
      listing: {
        sell_txid: '77'.repeat(32),
        sell_output_index: 0,
        sell_price_sats: 500_000,
        seller_address: '1TwinMvcAddr1111111111',
      },
    }),
    takeToken: async () => ({
      txId: '88'.repeat(32),
      fundingTxIds: ['99'.repeat(32)],
    }),
    sendToken: async () => ({
      success: true,
      txid: 'aa'.repeat(32),
      token_symbol: 'METAID',
      token_genesis: '005d' + '22'.repeat(18),
      amount: '25.5',
      to_metabot_id: 2,
    }),
    getTxStatus: async () => ({
      confirmed: true,
      confirmations: 1,
    }),
  } as unknown as WalletToolsControl;

  const built = buildWalletAgentTools({
    tool: ((name: string, description: string, schema: unknown, handler: (...args: any[]) => any) => ({
      name,
      description,
      schema,
      handler,
    })) as any,
    sessionId: 'sess_suite_test',
    resolveMetabotId: () => 1,
    control: mockControl,
  });
  const byName = new Map(built.map((t: any) => [t.name, t]));

  const portfolioOut = await byName.get('wallet_token_portfolio').handler({});
  const portfolioText = portfolioOut.content[0].text as string;
  assert.match(portfolioText, /```ft-portfolio-card/);
  const portfolioSegs = splitTokenCardMessageSegments(portfolioText);
  const portfolioCardSeg = portfolioSegs.find((s) => s.kind === 'ft-portfolio-card');
  assert.ok(portfolioCardSeg && portfolioCardSeg.kind === 'ft-portfolio-card');
  assert.equal(portfolioCardSeg.data.btcHoldings[0].bridgedPeer, true);
  assert.equal(portfolioCardSeg.data.mvcHoldings[0].lockedDisplay, '50');

  const myOrdersOut = await byName.get('wallet_token_my_orders').handler({});
  const myOrdersText = myOrdersOut.content[0].text as string;
  assert.match(myOrdersText, /```ft-my-orders-card/);
  const myOrdersSeg = splitTokenCardMessageSegments(myOrdersText).find(
    (s) => s.kind === 'ft-my-orders-card',
  );
  assert.ok(myOrdersSeg && myOrdersSeg.kind === 'ft-my-orders-card');
  assert.equal(myOrdersSeg.data.orders.length, 1);
  assert.equal(myOrdersSeg.data.orders[0].batchGroupId, 'batch_sunny_01');

  const bridgeOut = await byName.get('wallet_token_bridge_card').handler({
    symbol: 'METAID',
    direction: 'mvc-to-btc',
    amount: '250',
    txid: 'ab'.repeat(32),
  });
  const bridgeText = bridgeOut.content[0].text as string;
  assert.match(bridgeText, /```ft-bridge-card/);

  const sellOut = await byName.get('wallet_token_sell').handler({
    genesis: '22'.repeat(32),
    codehash: 'a242' + '11'.repeat(18),
    price_sats: 500_000,
    token_amount: '5000000000',
  });
  const sellText = sellOut.content[0].text as string;
  assert.match(sellText, /TokenSell LISTING broadcast on-chain\./);
  assert.match(sellText, /```ft-order-card/);

  const sendOut = await byName.get('wallet_token_send').handler({
    to: '1WorkerMvcAddr22222222',
    genesis: '22'.repeat(32),
    codehash: 'a242' + '11'.repeat(18),
    amount: '25.5',
    external_confirmed: true,
  });
  const sendText = sendOut.content[0].text as string;
  assert.match(sendText, /```ft-action-card/);

  // 4. Turn backstop captures & appends omitted suite cards, and skips already-included ones
  let captured: CapturedNftCardFence[] = [];
  captured = recordCapturedNftCardFences(
    captured,
    extractEmittedNftCardFences('wallet_token_portfolio', portfolioText),
  );
  captured = recordCapturedNftCardFences(
    captured,
    extractEmittedNftCardFences('wallet_token_my_orders', myOrdersText),
  );
  captured = recordCapturedNftCardFences(
    captured,
    extractEmittedNftCardFences('wallet_token_send', sendText),
  );
  assert.equal(captured.length, 3);

  const missingAll = selectMissingNftCardFences(captured, [
    'Done! Checked your tokens and sent 25.5 METAID.',
  ]);
  assert.equal(missingAll.length, 3);

  const patchedReply = appendNftCardFencesToReply('Done!', missingAll);
  const missingAfterAppend = selectMissingNftCardFences(captured, [patchedReply]);
  assert.equal(missingAfterAppend.length, 0);
});
