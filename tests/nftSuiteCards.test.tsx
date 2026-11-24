/**
 * Comprehensive verification suite for the 9-Scenario NFT / Digital Goods Chat
 * Card Suite (`N1`, `C2`, `L2`, `F1`, `O1`, `P1`, `S2`, `A1`, `Q1`) + standalone
 * bubble splitter + backend tool emissions + turn backstop + trade badge gates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MarkdownContent from '../src/renderer/components/MarkdownContent';
import NftCard, { NftCardGroup } from '../src/renderer/components/chat/NftCard';
import NftCollectionCard from '../src/renderer/components/chat/NftCollectionCard';
import NftListingCard from '../src/renderer/components/chat/NftListingCard';
import NftFillCard from '../src/renderer/components/chat/NftFillCard';
import NftMyListingsCard from '../src/renderer/components/chat/NftMyListingsCard';
import NftPortfolioCard from '../src/renderer/components/chat/NftPortfolioCard';
import NftSwapCard from '../src/renderer/components/chat/NftSwapCard';
import NftActionCard from '../src/renderer/components/chat/NftActionCard';
import NftNegotiateCard from '../src/renderer/components/chat/NftNegotiateCard';
import TokenSuiteSegmentCard from '../src/renderer/components/chat/TokenSuiteSegmentCard';
import { splitTokenCardMessageSegments } from '../src/renderer/components/chat/tokenCardSyntax';
import {
  parseNftCardFence,
  parseNftCollectionCardFence,
} from '../src/renderer/components/chat/nftCardSyntax';
import {
  isAnyNftSuiteFenceLanguage,
  parseNftActionCardFence,
  parseNftFillCardFence,
  parseNftListingCardFence,
  parseNftMyListingsCardFence,
  parseNftNegotiateCardFence,
  parseNftPortfolioCardFence,
  parseNftSwapCardFence,
} from '../src/renderer/components/chat/nftSuiteSyntax';
import { detectTradeActivity } from '../src/renderer/components/chat/tradeActivity';
import { serializeEscrowCardFence } from '../src/renderer/components/chat/escrowCardCore';

import {
  buildNftActionCardFence,
  buildNftCardFence,
  buildNftCollectionCardFence,
  buildNftFillCardFence,
  buildNftListingCardFence,
  buildNftMyListingsCardFence,
  buildNftNegotiateCardFence,
  buildNftPortfolioCardFence,
  buildNftSwapCardFence,
} from '../src/main/libs/nftCardMarkdown';
import { withNftCardHostStamp } from '../src/main/libs/tradeActivityStamp';
import { scanMessageTradeBadge } from '../src/main/libs/tradeBadge';
import {
  appendNftCardFencesToReply,
  extractEmittedNftCardFences,
  isNftCardBackstopTool,
  recordCapturedNftCardFences,
  selectMissingNftCardFences,
} from '../src/main/libs/nftCardTurnBackstop';
import { buildProjectorModePrompt } from '../src/main/libs/assistantModePrompt';
import { buildOwnerInteractionPrompt } from '../src/main/libs/ownerInteractionPrompt';
import { buildGoodsTradeAgentTools } from '../src/main/libs/goodsTradeAgentTools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SAMPLE_PIN_1 = `${'a1'.repeat(32)}i0`;
const SAMPLE_PIN_2 = `${'b2'.repeat(32)}i0`;
const SAMPLE_PIN_3 = `${'c3'.repeat(32)}i0`;
const SAMPLE_COLLECTION_ID = `${'d4'.repeat(32)}i0`;
const SAMPLE_INTENT_PIN = `${'e5'.repeat(32)}i0`;
const SAMPLE_TX_ID = 'f6'.repeat(32);
const SAMPLE_GENESIS = '12'.repeat(20);
const SAMPLE_CODEHASH = '34'.repeat(20);
const SELLER_ADDR = '1L8me3xT5G1R3gJ8zQ5cS6oX2Y9wQ7hP8c';
const SELLER_METAID = 'idq1seller00000000000000000000000000000000';
const BUYER_ADDR = '1Lbcfr7sAHTD9CgdQo3HTMTkV8LK4ZnX71';
const BUYER_METAID = 'idq1buyer000000000000000000000000000000000';

function fenceBody(fence: string): string {
  const lines = fence.trim().split('\n');
  return lines.slice(1, -1).join('\n');
}

function makeFakeSdkTool() {
  return (name: string, description: string, schema: unknown, handler: (args: any) => Promise<any>) => ({
    name,
    description,
    schema,
    handler,
  });
}

// ---------------------------------------------------------------------------
// 1. Main-side builder -> renderer parser round-trips & malformed degradation
// ---------------------------------------------------------------------------

test('nftCardMarkdown builders round-trip cleanly through nftCardSyntax & nftSuiteSyntax parsers', () => {
  const c1 = buildNftCardFence({
    format: 'mrc721',
    pinId: SAMPLE_PIN_1,
    collectionId: SAMPLE_COLLECTION_ID,
    name: 'Cyber Punk #088',
    series: 'Cyber Punks',
    number: 88,
    caVerified: true,
    priceMeMilli: 12500,
    priceCnyCents: 1990,
  });
  const p1 = parseNftCardFence(fenceBody(c1));
  assert.ok(p1);
  assert.equal(p1.pinId, SAMPLE_PIN_1);
  assert.equal(p1.caVerified, true);
  assert.equal(p1.priceMeMilli, 12500);

  const c2 = buildNftCollectionCardFence({
    collectionId: SAMPLE_COLLECTION_ID,
    collectionName: 'pixel-cats',
    name: 'Pixel Cats',
    totalSupply: 100,
    minted: 24,
    listedCount: 6,
    floorPriceMeMilli: 8000,
    caVerified: true,
    previewItems: [
      { pinId: SAMPLE_PIN_1, name: 'Pixel Cat #1', number: 1, priceMeMilli: 8000 },
      { pinId: SAMPLE_PIN_2, name: 'Pixel Cat #2', number: 2, priceMeMilli: 9500 },
      { pinId: SAMPLE_PIN_3, name: 'Pixel Cat #3', number: 3, priceSats: 25000 },
    ],
  });
  const p2 = parseNftCollectionCardFence(fenceBody(c2));
  assert.ok(p2);
  assert.equal(p2.listedCount, 6);
  assert.equal(p2.floorPriceMeMilli, 8000);
  assert.equal(p2.previewItems?.length, 3);

  const l2 = buildNftListingCardFence({
    status: 'active',
    rail: 'multi-intent',
    format: 'mrc721',
    pinId: SAMPLE_PIN_1,
    name: 'Cyber Punk #088',
    series: 'Cyber Punks',
    intentPinId: SAMPLE_INTENT_PIN,
    priceMeMilli: 15000,
    priceCnyCents: 2900,
    priceTokens: [{ assetKey: 'mrc20:metaid', chain: 'btc', symbol: 'METAID', decimals: 8, amountBase: '20000000000', amountDisplay: '200' }],
    autoFulfill: true,
  });
  const parsedL2 = parseNftListingCardFence(fenceBody(l2));
  assert.ok(parsedL2);
  assert.equal(parsedL2.status, 'active');
  assert.equal(parsedL2.rail, 'multi-intent');
  assert.equal(parsedL2.priceMeMilli, 15000);
  assert.equal(parsedL2.priceTokens?.length, 1);

  const f1 = buildNftFillCardFence({
    side: 'token_bought',
    rail: 'token-for-goods',
    format: 'mrc721',
    pinId: SAMPLE_PIN_1,
    name: 'Cyber Punk #088',
    series: 'Cyber Punks',
    tokenSymbol: 'MSP',
    tokenAmountDisplay: '500',
    txId: SAMPLE_TX_ID,
    paymentTxId: SAMPLE_TX_ID,
    counterpartyName: 'Alice Shop',
  });
  const parsedF1 = parseNftFillCardFence(fenceBody(f1));
  assert.ok(parsedF1);
  assert.equal(parsedF1.side, 'token_bought');
  assert.equal(parsedF1.tokenSymbol, 'MSP');
  assert.equal(parsedF1.tokenAmountDisplay, '500');

  const o1 = buildNftMyListingsCardFence({
    metabotId: 1,
    sellerName: 'Alice Bot',
    items: [
      {
        format: 'mrc721',
        pinId: SAMPLE_PIN_1,
        name: 'Cyber Punk #088',
        series: 'Cyber Punks',
        rail: 'multi-intent',
        intentPinId: SAMPLE_INTENT_PIN,
        priceMeMilli: 15000,
      },
    ],
  });
  const parsedO1 = parseNftMyListingsCardFence(fenceBody(o1));
  assert.ok(parsedO1);
  assert.equal(parsedO1.items.length, 1);
  assert.equal(parsedO1.items[0]?.pinId, SAMPLE_PIN_1);

  const pPortfolio = buildNftPortfolioCardFence({
    ownerName: 'TwinBot',
    ownerAddress: BUYER_ADDR,
    isThirdParty: false,
    totalCount: 5,
    mrc721Count: 3,
    legacyCount: 2,
    mrc721Collections: [
      {
        collectionId: SAMPLE_COLLECTION_ID,
        name: 'Cyber Punks',
        collectionName: 'cyber-punks',
        count: 3,
        caVerified: true,
      },
    ],
    previewItems: [{ format: 'mrc721', pinId: SAMPLE_PIN_1, name: 'Cyber Punk #088', number: 88 }],
    legacySeries: [
      {
        name: 'Genesis MetaBot',
        seriesName: 'Genesis MetaBot',
        genesis: SAMPLE_GENESIS,
        codehash: SAMPLE_CODEHASH,
        count: 2,
        swappable: true,
        sampleIndexes: ['1', '2'],
      },
    ],
  });
  const parsedPortfolio = parseNftPortfolioCardFence(fenceBody(pPortfolio));
  assert.ok(parsedPortfolio);
  assert.equal(parsedPortfolio.mrc721Count, 3);
  assert.equal(parsedPortfolio.legacyCount, 2);
  assert.equal(parsedPortfolio.legacySeries[0]?.swappable, true);

  const s2 = buildNftSwapCardFence({
    requestId: 'swap-req-001',
    status: 'completed',
    collectionSlug: 'genesis-metabot',
    collectionName: 'Genesis MetaBot',
    targetCollectionPinId: SAMPLE_COLLECTION_ID,
    stationGlobalMetaId: 'idq1officialstation000000000000000000',
    stationName: 'Official Swap Station',
    caVerified: true,
    totalCount: 1,
    completedCount: 1,
    items: [
      {
        tokenIndex: '42',
        name: 'Genesis MetaBot #42',
        status: 'completed',
        depositTxId: SAMPLE_TX_ID,
        newItemPinId: SAMPLE_PIN_1,
      },
    ],
  });
  const parsedS2 = parseNftSwapCardFence(fenceBody(s2));
  assert.ok(parsedS2);
  assert.equal(parsedS2.status, 'completed');
  assert.equal(parsedS2.items[0]?.newItemPinId, SAMPLE_PIN_1);

  const a1 = buildNftActionCardFence({
    kind: 'avatar',
    format: 'mrc721',
    pinId: SAMPLE_PIN_1,
    name: 'Cyber Punk #088',
    series: 'Cyber Punks',
    senderLabel: 'Nova',
    avatarPath: '/info/nftAvatar',
    caVerified: true,
  });
  const parsedA1 = parseNftActionCardFence(fenceBody(a1));
  assert.ok(parsedA1);
  assert.equal(parsedA1.kind, 'avatar');

  const q1 = buildNftNegotiateCardFence({
    kind: 'quote_accepted',
    pinId: SAMPLE_PIN_1,
    name: 'Cyber Punk #088',
    series: 'Cyber Punks',
    originalPriceMeMilli: 20000,
    agreedPriceMeMilli: 15000,
    quoteExpiresAt: Math.floor(Date.now() / 1000) + 900,
    sellerName: 'Alice Shop',
    buyerName: 'Bob',
    inquiryId: 'inq-99',
  });
  const parsedQ1 = parseNftNegotiateCardFence(fenceBody(q1));
  assert.ok(parsedQ1);
  assert.equal(parsedQ1.kind, 'quote_accepted');
  assert.equal(parsedQ1.originalPriceMeMilli, 20000);
  assert.equal(parsedQ1.agreedPriceMeMilli, 15000);

  // Malformed payloads degrade cleanly to null
  assert.equal(parseNftListingCardFence('{broken'), null);
  assert.equal(parseNftFillCardFence('{"side":"unknown"}'), null);
  assert.equal(parseNftSwapCardFence('{"requestId":""}'), null);
  assert.equal(parseNftActionCardFence('{"kind":"avatar"}'), null);
  assert.equal(parseNftNegotiateCardFence('{"kind":"quote_accepted"}'), null);
  assert.equal(isAnyNftSuiteFenceLanguage('nft-swap-card'), true);
  assert.equal(isAnyNftSuiteFenceLanguage('javascript'), false);
});

// ---------------------------------------------------------------------------
// 2. SSR rendering across all 9 approved scenario variants
// ---------------------------------------------------------------------------

test('SSR renders all 9 approved NFT suite scenario variants (N1, C2, L2, F1, O1, P1, S2, A1, Q1)', () => {
  // Scenario 1: N1 (legacy userSide -> upgrade + transfer; MRC-721 userSide -> list + avatar + transfer; group)
  const n1LegacyData = parseNftCardFence(
    fenceBody(
      buildNftCardFence({
        format: 'metacontract',
        genesis: SAMPLE_GENESIS,
        codehash: SAMPLE_CODEHASH,
        tokenIndex: '7',
        name: 'Legacy Bot #7',
        series: 'Legacy Bots',
      }),
    ),
  )!;
  const n1LegacyUserHtml = renderToStaticMarkup(React.createElement(NftCard, { data: n1LegacyData, userSide: true }));
  assert.match(n1LegacyUserHtml, /data-nft-user-side="true"/);
  assert.match(n1LegacyUserHtml, /data-nft-user-action="upgrade"/);
  assert.match(n1LegacyUserHtml, /data-nft-user-action="transfer"/);

  const n1MrcData = parseNftCardFence(
    fenceBody(
      buildNftCardFence({
        format: 'mrc721',
        pinId: SAMPLE_PIN_1,
        name: 'Cyber Punk #088',
        series: 'Cyber Punks',
      }),
    ),
  )!;
  const n1MrcUserHtml = renderToStaticMarkup(React.createElement(NftCard, { data: n1MrcData, userSide: true }));
  assert.match(n1MrcUserHtml, /data-nft-user-action="list"/);
  assert.match(n1MrcUserHtml, /data-nft-user-action="avatar"/);
  assert.match(n1MrcUserHtml, /data-nft-user-action="transfer"/);

  const groupHtml = renderToStaticMarkup(React.createElement(NftCardGroup, { cards: [n1LegacyData, n1MrcData] }));
  assert.match(groupHtml, /data-nft-card-group="true"/);

  // Scenario 2: C2 market summary & album receipt
  const c2MarketData = parseNftCollectionCardFence(
    fenceBody(
      buildNftCollectionCardFence({
        collectionId: SAMPLE_COLLECTION_ID,
        collectionName: 'cyber-punks',
        name: 'Cyber Punks',
        totalSupply: 1000,
        minted: 512,
        listedCount: 14,
        floorPriceMeMilli: 12500,
        caVerified: true,
        previewItems: [
          { pinId: SAMPLE_PIN_1, name: 'Cyber Punk #1', number: 1, priceMeMilli: 12500 },
          { pinId: SAMPLE_PIN_2, name: 'Cyber Punk #2', number: 2, priceMeMilli: 14000 },
          { pinId: SAMPLE_PIN_3, name: 'Cyber Punk #3', number: 3, priceMeMilli: 18000 },
        ],
      }),
    ),
  )!;
  const c2Html = renderToStaticMarkup(React.createElement(NftCollectionCard, { data: c2MarketData }));
  assert.match(c2Html, /data-nft-collection-card="true"/);
  assert.match(c2Html, /512 \/ 1000/);
  assert.match(c2Html, /12\.5 ME/);

  // Scenario 3: L2 active multi-rail & delisted
  const l2Active = parseNftListingCardFence(
    fenceBody(
      buildNftListingCardFence({
        status: 'active',
        rail: 'multi-intent',
        format: 'mrc721',
        pinId: SAMPLE_PIN_1,
        name: 'Cyber Punk #088',
        series: 'Cyber Punks',
        intentPinId: SAMPLE_INTENT_PIN,
        priceMeMilli: 15000,
        priceCnyCents: 2900,
        priceTokens: [{ assetKey: 'mrc20:metaid', chain: 'btc', symbol: 'METAID', decimals: 8, amountBase: '20000000000', amountDisplay: '200' }],
        autoFulfill: true,
      }),
    ),
  )!;
  const l2ActiveHtml = renderToStaticMarkup(React.createElement(NftListingCard, { data: l2Active }));
  assert.match(l2ActiveHtml, /data-nft-listing-card="true"/);
  assert.match(l2ActiveHtml, /data-nft-listing-status="active"/);
  assert.match(l2ActiveHtml, /15 ME/);
  assert.match(l2ActiveHtml, /¥29\.00/);
  assert.match(l2ActiveHtml, /200 \$METAID/);
  assert.match(l2ActiveHtml, /data-nft-listing-action="promo-pack"/);

  const l2Delisted = parseNftListingCardFence(
    fenceBody(
      buildNftListingCardFence({
        status: 'delisted',
        rail: 'multi-intent',
        format: 'mrc721',
        pinId: SAMPLE_PIN_1,
        name: 'Cyber Punk #088',
        cancelPinId: SAMPLE_PIN_2,
      }),
    ),
  )!;
  const l2DelistedHtml = renderToStaticMarkup(React.createElement(NftListingCard, { data: l2Delisted }));
  assert.match(l2DelistedHtml, /data-nft-listing-status="delisted"/);

  // Scenario 4: F1 sold, bought, token_bought
  for (const side of ['sold', 'bought', 'token_bought'] as const) {
    const fData = parseNftFillCardFence(
      fenceBody(
        buildNftFillCardFence({
          side,
          rail: side === 'token_bought' ? 'token-for-goods' : 'me-escrow',
          format: 'mrc721',
          pinId: SAMPLE_PIN_1,
          name: 'Cyber Punk #088',
          series: 'Cyber Punks',
          priceMeMilli: side === 'token_bought' ? undefined : 15000,
          tokenSymbol: side === 'token_bought' ? 'MSP' : undefined,
          tokenAmountDisplay: side === 'token_bought' ? '500' : undefined,
          txId: SAMPLE_TX_ID,
          counterpartyName: 'Alice',
        }),
      ),
    )!;
    const fHtml = renderToStaticMarkup(React.createElement(NftFillCard, { data: fData }));
    assert.match(fHtml, /data-nft-fill-card="true"/);
    assert.match(fHtml, new RegExp(`data-nft-fill-side="${side}"`));
  }

  // Scenario 5: O1 active & empty
  const o1Active = parseNftMyListingsCardFence(
    fenceBody(
      buildNftMyListingsCardFence({
        metabotId: 1,
        sellerName: 'Alice Bot',
        items: [
          {
            format: 'mrc721',
            pinId: SAMPLE_PIN_1,
            name: 'Cyber Punk #088',
            series: 'Cyber Punks',
            rail: 'multi-intent',
            intentPinId: SAMPLE_INTENT_PIN,
            priceMeMilli: 15000,
          },
        ],
      }),
    ),
  )!;
  const o1Html = renderToStaticMarkup(React.createElement(NftMyListingsCard, { data: o1Active }));
  assert.match(o1Html, /data-nft-my-listings-card="true"/);
  assert.match(o1Html, /data-nft-listings-count="1"/);
  assert.match(o1Html, /Cyber Punk #088/);

  const o1Empty = parseNftMyListingsCardFence(
    fenceBody(buildNftMyListingsCardFence({ metabotId: 1, items: [] })),
  )!;
  const o1EmptyHtml = renderToStaticMarkup(React.createElement(NftMyListingsCard, { data: o1Empty }));
  assert.match(o1EmptyHtml, /data-nft-listings-count="0"/);

  // Scenario 6: P1 dual-protocol & third-party holder view
  const p1Dual = parseNftPortfolioCardFence(
    fenceBody(
      buildNftPortfolioCardFence({
        ownerName: 'TwinBot',
        isThirdParty: false,
        totalCount: 5,
        mrc721Count: 2,
        legacyCount: 3,
        mrc721Collections: [
          {
            collectionId: SAMPLE_COLLECTION_ID,
            name: 'Cyber Punks',
            collectionName: 'cyber-punks',
            count: 2,
            caVerified: true,
          },
        ],
        previewItems: [{ format: 'mrc721', pinId: SAMPLE_PIN_1, name: 'Cyber Punk #088' }],
        legacySeries: [
          {
            name: 'Genesis MetaBot',
            seriesName: 'Genesis MetaBot',
            genesis: SAMPLE_GENESIS,
            codehash: SAMPLE_CODEHASH,
            count: 3,
            swappable: true,
            sampleIndexes: ['1', '2', '3'],
          },
        ],
      }),
    ),
  )!;
  const p1Html = renderToStaticMarkup(React.createElement(NftPortfolioCard, { data: p1Dual }));
  assert.match(p1Html, /data-nft-portfolio-card="true"/);
  assert.match(p1Html, /data-nft-portfolio-legacy="true"/);
  assert.match(p1Html, /data-nft-portfolio-action="upgrade"/);

  const p1ThirdParty = parseNftPortfolioCardFence(
    fenceBody(
      buildNftPortfolioCardFence({
        ownerName: 'CollectorX',
        isThirdParty: true,
        totalCount: 1,
        mrc721Count: 1,
        legacyCount: 0,
        mrc721Collections: [{ collectionId: SAMPLE_COLLECTION_ID, name: 'Cyber Punks', collectionName: 'cyber-punks', count: 1 }],
        legacySeries: [],
      }),
    ),
  )!;
  const p1ThirdPartyHtml = renderToStaticMarkup(React.createElement(NftPortfolioCard, { data: p1ThirdParty }));
  assert.match(p1ThirdPartyHtml, /data-nft-portfolio-third-party="true"/);

  // Scenario 7: S2 swap matrix (confirming & completed)
  for (const status of ['confirming', 'completed'] as const) {
    const sData = parseNftSwapCardFence(
      fenceBody(
        buildNftSwapCardFence({
          requestId: `req-${status}`,
          status,
          collectionSlug: 'genesis-metabot',
          collectionName: 'Genesis MetaBot',
          stationName: 'Official Swap Station',
          caVerified: true,
          totalCount: 1,
          completedCount: status === 'completed' ? 1 : 0,
          items: [
            {
              tokenIndex: '42',
              name: 'Genesis MetaBot #42',
              status: status === 'completed' ? 'completed' : 'confirming',
              depositTxId: SAMPLE_TX_ID,
              newItemPinId: status === 'completed' ? SAMPLE_PIN_1 : undefined,
            },
          ],
        }),
      ),
    )!;
    const sHtml = renderToStaticMarkup(React.createElement(NftSwapCard, { data: sData }));
    assert.match(sHtml, /data-nft-swap-card="true"/);
    assert.match(sHtml, new RegExp(`data-nft-swap-status="${status}"`));
  }

  // Scenario 8: A1 avatar, mint, transfer
  for (const kind of ['avatar', 'mint', 'transfer'] as const) {
    const aData = parseNftActionCardFence(
      fenceBody(
        buildNftActionCardFence({
          kind,
          format: 'mrc721',
          pinId: SAMPLE_PIN_1,
          name: 'Cyber Punk #088',
          series: 'Cyber Punks',
          senderLabel: 'Alice',
          recipientLabel: 'Bob',
          avatarPath: kind === 'avatar' ? '/info/nftAvatar' : undefined,
          txId: SAMPLE_TX_ID,
        }),
      ),
    )!;
    const aHtml = renderToStaticMarkup(React.createElement(NftActionCard, { data: aData }));
    assert.match(aHtml, /data-nft-action-card="true"/);
    assert.match(aHtml, new RegExp(`data-nft-action-kind="${kind}"`));
  }

  // Scenario 9: Q1 negotiate modes
  for (const kind of ['quote_accepted', 'inquiry_received', 'inquiry_sent', 'open_offer'] as const) {
    const qData = parseNftNegotiateCardFence(
      fenceBody(
        buildNftNegotiateCardFence({
          kind,
          pinId: SAMPLE_PIN_1,
          name: 'Cyber Punk #088',
          series: 'Cyber Punks',
          originalPriceMeMilli: 20000,
          proposedPriceMeMilli: 15000,
          agreedPriceMeMilli: 15000,
          offerPriceSats: kind === 'open_offer' ? 45000 : undefined,
          quoteExpiresAt: Math.floor(Date.now() / 1000) + 1200,
          sellerName: 'Alice',
          buyerName: 'Bob',
        }),
      ),
    )!;
    const qHtml = renderToStaticMarkup(React.createElement(NftNegotiateCard, { data: qData }));
    assert.match(qHtml, /data-nft-negotiate-card="true"/);
    assert.match(qHtml, new RegExp(`data-nft-negotiate-kind="${kind}"`));
  }
});

// ---------------------------------------------------------------------------
// 3. Standalone bubble splitter + MarkdownContent fallback + UI surface wiring
// ---------------------------------------------------------------------------

test('splitTokenCardMessageSegments isolates all NFT suite & escrow cards as standalone bubbles and coalesces adjacent nft-cards', () => {
  const cardA = buildNftCardFence({ format: 'mrc721', pinId: SAMPLE_PIN_1, name: 'Item #1' });
  const cardB = buildNftCardFence({ format: 'mrc721', pinId: SAMPLE_PIN_2, name: 'Item #2' });
  const fillFence = buildNftFillCardFence({
    side: 'bought',
    rail: 'me-escrow',
    format: 'mrc721',
    pinId: SAMPLE_PIN_1,
    priceMeMilli: 12000,
  });
  const escrowFence = serializeEscrowCardFence({
    orderId: 'esc-100',
    title: 'Cyber Punk #088',
    kind: 'mrc721',
    amountCents: 2900,
    state: 'ITEM_ESCROWED',
    stateEnteredAt: Date.now() - 60_000,
    timerHours: 24,
    parties: { seller: 'Alice', buyer: 'Bob', agent: 'EscrowBot' },
  });

  const combined = [
    'Here are the two items and your fill receipt:',
    cardA,
    cardB,
    'Settlement completed below:',
    fillFence,
    escrowFence,
  ].join('\n\n');

  const segments = splitTokenCardMessageSegments(combined, { isStreaming: false });
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['markdown', 'nft-card-group', 'markdown', 'nft-fill-card', 'escrow-card'],
  );

  // TokenSuiteSegmentCard renders every non-markdown segment cleanly
  for (const seg of segments) {
    if (seg.kind === 'markdown') continue;
    const html = renderToStaticMarkup(React.createElement(TokenSuiteSegmentCard, { segment: seg }));
    assert.ok(html.length > 40);
  }

  // MarkdownContent fallback also renders all 7 new suite cards when embedded inside nested contexts
  const mdHtml = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: [
        buildNftListingCardFence({ status: 'active', rail: 'multi-intent', format: 'mrc721', pinId: SAMPLE_PIN_1, priceMeMilli: 9000 }),
        fillFence,
        buildNftMyListingsCardFence({ metabotId: 1, items: [] }),
        buildNftPortfolioCardFence({
          ownerName: 'Twin',
          totalCount: 0,
          mrc721Count: 0,
          legacyCount: 0,
          mrc721Collections: [],
          legacySeries: [],
        }),
        buildNftSwapCardFence({
          requestId: 'swap-md-1',
          status: 'confirming',
          collectionSlug: 'genesis-metabot',
          totalCount: 1,
          completedCount: 0,
          items: [{ tokenIndex: '1', status: 'confirming' }],
        }),
        buildNftActionCardFence({ kind: 'mint', format: 'mrc721', pinId: SAMPLE_PIN_1 }),
        buildNftNegotiateCardFence({ kind: 'inquiry_sent', pinId: SAMPLE_PIN_1, proposedPriceMeMilli: 8000 }),
      ].join('\n\n'),
    }),
  );
  assert.match(mdHtml, /data-nft-listing-card="true"/);
  assert.match(mdHtml, /data-nft-fill-card="true"/);
  assert.match(mdHtml, /data-nft-my-listings-card="true"/);
  assert.match(mdHtml, /data-nft-portfolio-card="true"/);
  assert.match(mdHtml, /data-nft-swap-card="true"/);
  assert.match(mdHtml, /data-nft-action-card="true"/);
  assert.match(mdHtml, /data-nft-negotiate-card="true"/);

  // Verify standalone user-side & assistant-side wiring across Desktop, Studio, Mobile, A2A, and Wallet modal
  for (const rel of [
    'src/renderer/components/cowork/CoworkSessionDetail.tsx',
    'src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx',
    'src/mobile/app/screens/ChatScreen.tsx',
    'src/renderer/components/cowork/A2AMessageItem.tsx',
  ]) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.match(src, /splitTokenCardMessageSegments/, `${rel} must split standalone card segments`);
    assert.match(src, /TokenSuiteSegmentCard/, `${rel} must render TokenSuiteSegmentCard outside prose bubbles`);
  }

  const walletModalSrc = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/components/metabots/MetaBotNftWalletModal.tsx'),
    'utf8',
  );
  assert.match(walletModalSrc, /metabot-nft-send-to-chat/);
});

// ---------------------------------------------------------------------------
// 4. Turn backstop + TradeBadge / TradeActivity session-stamp verification + prompts
// ---------------------------------------------------------------------------

test('nftCardTurnBackstop, tradeBadge, tradeActivity, and Projector/Owner prompts cover all NFT suite fences', () => {
  for (const tool of [
    'goods_market_summary',
    'goods_holder_lookup',
    'goods_buy_with_me',
    'goods_buy_with_token',
    'goods_send_inquiry',
    'goods_accept_inquiry',
    'wallet_nft_balance',
    'wallet_nft_sell_orders',
    'mrc721_balance',
    'mrc721_sell_orders',
    'mrc721_sell_intents',
    'mrc721_sell_intent_cancel',
    'mrc721_offer_cancel',
    'nft_swap_submit_batch',
    'nft_swap_order_status',
    'metabot_update',
  ]) {
    assert.equal(isNftCardBackstopTool(tool), true, `${tool} must be registered in backstop`);
  }
  assert.equal(isNftCardBackstopTool('goods_market_search'), false);

  const sessionId = 'sess-nft-suite-42';
  const stampedFill = buildNftFillCardFence(
    withNftCardHostStamp(
      {
        side: 'sold',
        rail: 'me-escrow',
        format: 'mrc721',
        pinId: SAMPLE_PIN_1,
        priceMeMilli: 15000,
        txId: SAMPLE_TX_ID,
      },
      sessionId,
    ),
  );
  const stampedListing = buildNftListingCardFence(
    withNftCardHostStamp(
      {
        status: 'delisted',
        rail: 'multi-intent',
        format: 'mrc721',
        pinId: SAMPLE_PIN_2,
        intentPinId: SAMPLE_INTENT_PIN,
      },
      sessionId,
    ),
  );
  const stampedAvatar = buildNftActionCardFence(
    withNftCardHostStamp(
      {
        kind: 'avatar',
        format: 'mrc721',
        pinId: SAMPLE_PIN_3,
        avatarPath: '/info/nftAvatar',
      },
      sessionId,
    ),
  );
  const stampedTransfer = buildNftActionCardFence(
    withNftCardHostStamp(
      {
        kind: 'transfer',
        format: 'mrc721',
        pinId: SAMPLE_PIN_3,
        txId: SAMPLE_TX_ID,
      },
      sessionId,
    ),
  );

  // Backstop extraction & deduplication
  const extracted = extractEmittedNftCardFences('goods_buy_with_me', `Done!\n\n${stampedFill}`);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0]?.tag, 'nft-fill-card');
  const ledger = recordCapturedNftCardFences([], extracted);
  const missing = selectMissingNftCardFences(ledger, ['Your purchase is complete!']);
  assert.equal(missing.length, 1);
  const backstopped = appendNftCardFencesToReply('Your purchase is complete!', missing);
  assert.match(backstopped, /```nft-fill-card/);
  assert.equal(selectMissingNftCardFences(ledger, [backstopped]).length, 0);

  // TradeBadge (main) & detectTradeActivity (renderer) session-bound verification
  assert.equal(scanMessageTradeBadge(stampedFill, { sessionId }), 'p2p');
  assert.equal(scanMessageTradeBadge(stampedFill, { sessionId: 'other-session' }), null);
  assert.equal(scanMessageTradeBadge(stampedListing, { sessionId }), 'p2p');
  assert.equal(scanMessageTradeBadge(stampedTransfer, { sessionId }), 'p2p');
  assert.equal(scanMessageTradeBadge(stampedAvatar, { sessionId }), null);

  assert.deepEqual(detectTradeActivity(stampedFill, { sessionId }), {
    kind: 'p2p',
    actions: ['sold'],
  });
  assert.equal(detectTradeActivity(stampedFill, { sessionId: 'other-session' }), null);
  assert.deepEqual(detectTradeActivity(stampedListing, { sessionId }), {
    kind: 'p2p',
    actions: ['delisted'],
  });
  assert.deepEqual(detectTradeActivity(stampedTransfer, { sessionId }), {
    kind: 'p2p',
    actions: ['transferred'],
  });
  assert.equal(detectTradeActivity(stampedAvatar, { sessionId }), null);

  // Prompts carve out all 7 new NFT suite fences so Studio/Owner modes never strip them
  const projectorPrompt = buildProjectorModePrompt();
  const ownerPrompt = buildOwnerInteractionPrompt({
    surface: 'desktop_studio',
    hasOwnerUpdate: true,
    hasProjector: true,
    hasDesktopBrowser: true,
  });
  assert.ok(ownerPrompt.includes('nft-*-card'), 'Owner interaction prompt must allowlist nft-*-card');
  for (const tag of [
    'nft-listing-card',
    'nft-fill-card',
    'nft-my-listings-card',
    'nft-portfolio-card',
    'nft-swap-card',
    'nft-action-card',
    'nft-negotiate-card',
  ]) {
    assert.ok(projectorPrompt.includes(tag), `Projector prompt must allowlist ${tag}`);
  }
});

// ---------------------------------------------------------------------------
// 5. End-to-end backend tool emissions (goods_market_summary, holder, inquiry)
// ---------------------------------------------------------------------------

test('goodsTradeAgentTools emit C2 collection summary, P1 holder portfolio, and Q1 negotiation fences', async () => {
  const sentMessages: Array<{ toGlobalMetaId: string; content: string }> = [];

  const buyerTools = buildGoodsTradeAgentTools({
    tool: makeFakeSdkTool() as any,
    sessionId: 'sess-e2e-buyer',
    resolveMetabotId: () => 1,
    confirmGoodsPurchase: async () => true,
    confirmGoodsQuoteAcceptance: async () => true,
    control: {
      getMetabotIdentity: () => ({ name: 'BuyerBot', mvcAddress: BUYER_ADDR, globalMetaId: BUYER_METAID }),
      getTradeBalance: async () => ({
        botAddress: BUYER_ADDR,
        tradeSpendableMilli: 50_000,
        frozenMilli: 0,
        totalAvailableMilli: 50_000,
        weeklyRemainingMilli: 50_000,
        earnedMilli: 0,
        topupMilli: 50_000,
        bonusMilli: 0,
        raw: {},
      }),
      createEscrowOrder: async () => { throw new Error('unused'); },
      getEscrowOrder: async () => { throw new Error('unused'); },
      sendTradeMessage: async (input: any) => {
        sentMessages.push({ toGlobalMetaId: input.toGlobalMetaId, content: input.content });
        return { txids: [SAMPLE_TX_ID], pinId: SAMPLE_PIN_2 };
      },
      fetchCaRegistry: async () => ({
        verified: true,
        collections: [{ collectionPinId: SAMPLE_COLLECTION_ID, collectionName: 'cyber-punks' }],
      }),
      fetchMarketCollections: async () => ({
        items: [{
          collectionPinId: SAMPLE_COLLECTION_ID,
          collectionName: 'cyber-punks',
          displayTitle: 'Cyber Punks',
          listedCount: 8,
          floorPriceMeMilli: 9500,
          floorPriceCnyCents: 1990,
          caVerified: true,
        }],
      }),
      fetchMarketTrades: async () => ({ items: [] }),
      fetchMarketListings: async () => ({
        items: [{
          intentPinId: SAMPLE_INTENT_PIN,
          itemPinId: SAMPLE_PIN_1,
          itemName: 'Cyber Punk #088',
          collectionPinId: SAMPLE_COLLECTION_ID,
          collectionName: 'cyber-punks',
          prices: { me: { amountMilli: 15000 } },
          autoFulfillMe: true,
          negotiable: true,
          caVerified: true,
          seller: { address: SELLER_ADDR, globalMetaId: SELLER_METAID, name: 'SellerBot', isOnline: true },
        }],
      }),
      fetchItemInfo: async () => ({
        itemPinId: SAMPLE_PIN_1,
        collectionPinId: SAMPLE_COLLECTION_ID,
        name: 'Cyber Punk #088',
        collectionName: 'cyber-punks',
        ownerAddress: SELLER_ADDR,
        ownerMetaId: SELLER_METAID,
        burned: false,
      }),
      fetchAddressCollections: async () => ([
        {
          pinid: SAMPLE_COLLECTION_ID,
          collectionName: 'cyber-punks',
          name: 'Cyber Punks',
          mintedCount: 5,
        },
      ]),
      fetchAddressItems: async () => ([
        { itemPinId: SAMPLE_PIN_1, collectionPinId: SAMPLE_COLLECTION_ID, name: 'Cyber Punk #1', collectionName: 'cyber-punks' },
        { itemPinId: SAMPLE_PIN_2, collectionPinId: SAMPLE_COLLECTION_ID, name: 'Cyber Punk #2', collectionName: 'cyber-punks' },
        { itemPinId: SAMPLE_PIN_3, collectionPinId: SAMPLE_COLLECTION_ID, name: 'Cyber Punk #3', collectionName: 'cyber-punks' },
      ]),
    } as any,
  }) as Array<{ name: string; handler: (args: any) => Promise<any> }>;

  const summaryTool = buyerTools.find((t) => t.name === 'goods_market_summary')!;
  const holderTool = buyerTools.find((t) => t.name === 'goods_holder_lookup')!;
  const inquiryTool = buyerTools.find((t) => t.name === 'goods_send_inquiry')!;

  const summaryRes = await summaryTool.handler({});
  const summaryText = summaryRes.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  assert.match(summaryText, /```nft-collection-card/);
  const summaryCaptured = extractEmittedNftCardFences('goods_market_summary', summaryText);
  assert.equal(summaryCaptured.length, 1);
  assert.equal(summaryCaptured[0]?.tag, 'nft-collection-card');

  const holderRes = await holderTool.handler({ address: SELLER_ADDR });
  const holderText = holderRes.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  assert.match(holderText, /```nft-portfolio-card/);

  const inquiryRes = await inquiryTool.handler({
    item_pin_id: SAMPLE_PIN_1,
    offer_me: 12,
    note: 'Can we do 12 ME?',
  });
  const inquiryText = inquiryRes.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  assert.match(inquiryText, /```nft-negotiate-card/);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]!.content, /GOODS_INQUIRY_V1/);
  assert.match(sentMessages[0]!.content, /```nft-negotiate-card/);

  // Seller accept-inquiry emits Q1 quote_accepted in both wire DM and tool result
  const sellerTools = buildGoodsTradeAgentTools({
    tool: makeFakeSdkTool() as any,
    sessionId: 'sess-e2e-seller',
    resolveMetabotId: () => 2,
    confirmGoodsPurchase: async () => true,
    confirmGoodsQuoteAcceptance: async () => true,
    control: {
      getMetabotIdentity: () => ({ name: 'SellerBot', mvcAddress: SELLER_ADDR, globalMetaId: SELLER_METAID }),
      getTradeBalance: async () => { throw new Error('unused'); },
      createEscrowOrder: async () => { throw new Error('unused'); },
      getEscrowOrder: async () => { throw new Error('unused'); },
      sendTradeMessage: async (input: any) => {
        sentMessages.push({ toGlobalMetaId: input.toGlobalMetaId, content: input.content });
        return { txids: [SAMPLE_TX_ID], pinId: SAMPLE_PIN_3 };
      },
      recordSellerAuthorizedQuote: (metabotId: number, quote: any) => ({
        ...quote,
        metabotId,
        status: 'active' as const,
        createdAt: 1,
        updatedAt: 1,
      }),
      fetchItemInfo: async () => ({
        itemPinId: SAMPLE_PIN_1,
        collectionPinId: SAMPLE_COLLECTION_ID,
        name: 'Cyber Punk #088',
        collectionName: 'cyber-punks',
        ownerAddress: SELLER_ADDR,
        ownerMetaId: SELLER_METAID,
        burned: false,
      }),
    } as any,
  }) as Array<{ name: string; handler: (args: any) => Promise<any> }>;

  const acceptTool = sellerTools.find((t) => t.name === 'goods_accept_inquiry')!;
  const acceptRes = await acceptTool.handler({
    inquiry_id: 'inq-e2e-1',
    item_pin_id: SAMPLE_PIN_1,
    buyer_global_metaid: BUYER_METAID,
    buyer_nft_address: BUYER_ADDR,
    agreed_me: 12,
  });
  const acceptText = acceptRes.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  assert.match(acceptText, /```nft-negotiate-card/);
  assert.match(acceptText, /"kind":"quote_accepted"/);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1]!.content, /GOODS_QUOTE_ACCEPT_V1/);
  assert.match(sentMessages[1]!.content, /```nft-negotiate-card/);
});

test('nftSwapAgentTools keeps content[0] pure JSON and emits S2 nft-swap-card in content[1]', async () => {
  const { buildNftSwapAgentTools } = await import('../src/main/libs/nftSwapAgentTools');
  const swapTools = buildNftSwapAgentTools({
    tool: makeFakeSdkTool() as any,
    sessionId: 'sess-swap-card-1',
    resolveMetabotId: () => 1,
    confirmSwapBatch: async () => true,
    control: {
      getOrder: (reqId: string) => ({
        requestId: reqId,
        metabotId: 1,
        collectionSlug: 'genesis-metabot',
        targetCollectionPinId: SAMPLE_COLLECTION_ID,
        stationGlobalMetaId: 'idq1officialstation000000000000000000',
        vaultAddress: SELLER_ADDR,
        codehash: SAMPLE_CODEHASH,
        genesis: SAMPLE_GENESIS,
        status: 'completed',
        items: [{ tokenIndex: '42', depositTxId: SAMPLE_TX_ID }],
        completedItems: [
          {
            tokenIndex: '42',
            status: 'completed',
            itemPinId: SAMPLE_PIN_1,
            itemName: 'Genesis MetaBot #42',
            deliveryTxId: SAMPLE_TX_ID,
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      }),
    } as any,
  }) as Array<{ name: string; handler: (args: any) => Promise<any> }>;

  const statusTool = swapTools.find((t) => t.name === 'nft_swap_order_status')!;
  const res = await statusTool.handler({ requestId: 'swap-req-77' });
  // content[0] MUST parse as pure JSON (contract pinned by officialSwapStationVerify.test.ts)
  const parsedJson = JSON.parse(res.content[0].text);
  assert.equal(parsedJson.requestId, 'swap-req-77');
  assert.equal(res.content.length, 2);
  assert.match(res.content[1].text, /```nft-swap-card/);

  const joined = res.content.map((c: { text?: string }) => c.text ?? '').join('\n\n');
  const captured = extractEmittedNftCardFences('nft_swap_order_status', joined);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.tag, 'nft-swap-card');
});
