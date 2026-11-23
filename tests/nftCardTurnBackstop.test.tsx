import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import {
  appendNftCardFencesToReply,
  extractEmittedNftCardFences,
  extractEmittedSkillBashCardFences,
  isEligibleBackstopTargetMessage,
  isNftCardBackstopTool,
  recordCapturedNftCardFences,
  selectMissingNftCardFences,
} from '../src/main/libs/nftCardTurnBackstop';
import { DshStreamUiGate } from '../src/main/libs/dshStreamUiGate';
import { buildMrc721AgentTools } from '../src/main/libs/mrc721AgentTools';
import { buildProjectorModePrompt } from '../src/main/libs/assistantModePrompt';
import { buildOwnerInteractionPrompt } from '../src/main/libs/ownerInteractionPrompt';
import { parseNftCardFence } from '../src/renderer/components/chat/nftCardSyntax';
import NftCard from '../src/renderer/components/chat/NftCard';

const ITEM_PIN = `${'91'.repeat(32)}i0`;
const COLLECTION_PIN = '26b335096639b7f049138501bd10ed6f1a315efd081d787a1c7b74ae6d70ffd8i0';
const SELL_PIN = `${'ab'.repeat(32)}i0`;

test('Projector Mode and Owner Interaction prompts carve out host-emitted structured protocol card fences', () => {
  const projectorPrompt = buildProjectorModePrompt();
  assert.match(projectorPrompt, /nft-card/);
  assert.match(projectorPrompt, /nft-collection-card/);

  const ownerPrompt = buildOwnerInteractionPrompt({
    surface: 'desktop_studio',
    presentation: 'projector_right_pane',
    hasOwnerUpdate: true,
    hasProjector: true,
    hasDesktopBrowser: true,
    hasWebSearch: true,
  });
  assert.match(ownerPrompt, /right-pane projector via projection_begin/);
  assert.match(ownerPrompt, /nft-card/);
});

test('nftCardTurnBackstop captures announcing tools, ignores read-only market searches, and upgrades same-item state', () => {
  assert.equal(isNftCardBackstopTool('mrc721_sell_intent'), true);
  assert.equal(isNftCardBackstopTool('mcp__idbots__mrc721_mint'), true);
  assert.equal(isNftCardBackstopTool('wallet_nft_sell'), true);
  assert.equal(isNftCardBackstopTool('goods_market_search'), false);
  assert.equal(isNftCardBackstopTool('mrc721_item_info'), false);

  const mintResult = [
    'Minted item.',
    '```nft-card',
    JSON.stringify({ format: 'mrc721', pinId: ITEM_PIN, name: 'MetaBot Avatar #9131', action: 'minted' }),
    '```',
  ].join('\n');

  const sellIntentResult = [
    'Sell intent declared.',
    '```nft-card',
    JSON.stringify({
      format: 'mrc721',
      pinId: ITEM_PIN,
      name: 'MetaBot Avatar #9131',
      priceMeMilli: 2000,
      priceCnyCents: 1990,
      caVerified: true,
      action: 'selling',
    }),
    '```',
  ].join('\n');

  assert.deepEqual(extractEmittedNftCardFences('goods_market_search', sellIntentResult), []);

  const capturedAfterMint = recordCapturedNftCardFences([], extractEmittedNftCardFences('mrc721_mint', mintResult));
  assert.equal(capturedAfterMint.length, 1);

  // Subsequent sell_intent on the same itemPinId supersedes the earlier minted card.
  const capturedAfterListing = recordCapturedNftCardFences(
    capturedAfterMint,
    extractEmittedNftCardFences('mrc721_sell_intent', sellIntentResult),
  );
  assert.equal(capturedAfterListing.length, 1);
  assert.match(capturedAfterListing[0].fence, /"action":"selling"/);

  // When the assistant omitted the fence (e.g. projected HTML + prose summary), it is selected as missing.
  const proseOnlyReply = '已将 MetaBot Avatar #9131 按 2 ME / ¥19.90 完成上架广播，详情见右侧投影报告。';
  const missing = selectMissingNftCardFences(capturedAfterListing, [proseOnlyReply]);
  assert.equal(missing.length, 1);

  const backstoppedReply = appendNftCardFencesToReply(proseOnlyReply, missing);
  assert.match(backstoppedReply, /```nft-card\n\{.*"pinId":/);

  // Once present in any visible assistant message of the turn, backstop is a no-op (zero duplicate cards).
  assert.deepEqual(selectMissingNftCardFences(capturedAfterListing, [backstoppedReply]), []);
});

test('isEligibleBackstopTargetMessage skips thinking, narration, turnAckReply, and ownerUpdate bubbles', () => {
  assert.equal(isEligibleBackstopTargetMessage({ type: 'assistant', content: 'Final reply' }), true);
  assert.equal(isEligibleBackstopTargetMessage({ type: 'assistant', content: '   ' }), false);
  assert.equal(isEligibleBackstopTargetMessage({ type: 'user', content: 'Hello' }), false);
  assert.equal(
    isEligibleBackstopTargetMessage({ type: 'assistant', content: 'Thinking...', metadata: { isThinking: true } }),
    false,
  );
  assert.equal(
    isEligibleBackstopTargetMessage({ type: 'assistant', content: '收到，马上处理', metadata: { turnAckReply: true } }),
    false,
  );
  assert.equal(
    isEligibleBackstopTargetMessage({ type: 'assistant', content: '正在广播…', metadata: { ownerUpdate: true } }),
    false,
  );
});

test('DshStreamUiGate: finalizing session overlays before backstop write prevents teardown from overwriting appended nft-card', () => {
  const persisted = new Map<string, string>();
  const gate = new DshStreamUiGate({
    throttleMs: 90,
    emitUpdate: () => {},
    persistFinalize: (_sid, mid, content) => {
      persisted.set(mid, content);
    },
  });

  gate.onUpdate('sess-1', 'msg-1', '已完成上架广播。');
  gate.onFinalize('sess-1', 'msg-1', '已完成上架广播。');

  // 1. Flush and clear DshStreamUiGate BEFORE writing the backstop fence.
  gate.finalizeSession('sess-1');
  const withCard = `${persisted.get('msg-1')}\n\n\`\`\`nft-card\n{"format":"mrc721","pinId":"${ITEM_PIN}","action":"selling"}\n\`\`\``;
  persisted.set('msg-1', withCard);

  // 2. Later removeActiveSession -> finalizeSession must NOT clobber persisted content.
  gate.finalizeSession('sess-1');
  assert.equal(persisted.get('msg-1'), withCard);
});

test('mrc721_sell_intent enriches emitted nft-card with caVerified, sellerName, dual ME/CNY pricing, and renders LISTED badge', async () => {
  const registered = new Map<string, (args: any) => Promise<any>>();
  const toolFactory = (name: string, _desc: string, _schema: Record<string, unknown>, handler: (args: any) => Promise<any>) => {
    registered.set(name, handler);
    return { name, handler };
  };

  buildMrc721AgentTools({
    tool: toolFactory,
    sessionId: '7131445e-93da-4253-8c89-b5890a4195a4',
    resolveMetabotId: () => 1,
    control: {
      getMetabotMvcAddress: () => '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
      resolveMetabotIdByName: () => 1,
      getMetabotName: () => 'AI_Sunny',
      getMetabotMetaId: () => 'idq1sunny000000000000000000000000000000000',
      fetchItemInfo: async () => ({
        pinId: ITEM_PIN,
        collectionPinId: COLLECTION_PIN,
        collectionName: 'metabot-avatar',
        name: 'MetaBot Avatar #9131',
        number: 9131,
        cover: `metafile://${'cc'.repeat(32)}i0`,
        ownerAddress: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
      }),
      fetchCollectionInfo: async () => ({
        pinId: COLLECTION_PIN,
        collectionName: 'metabot-avatar',
        name: 'MetaBot Avatar',
        issuerAddress: '176C9RPWDggnvdVcWG3wrZEJcm1bHTcKM5',
      }),
      fetchCaRegistry: async () => ({
        verified: true,
        pinId: '651cf54aa6b3f0e5bf651a2cb94c0e6c5479378df0118bbe180847c27916be88i0',
        collections: [
          {
            collectionPinId: COLLECTION_PIN,
            collectionName: 'metabot-avatar',
          },
        ],
        officialBots: [],
      }),
      collectionCreate: async () => { throw new Error('unused'); },
      collectionUpdate: async () => { throw new Error('unused'); },
      mint: async () => { throw new Error('unused'); },
      itemDescBatch: async () => { throw new Error('unused'); },
      transfer: async () => { throw new Error('unused'); },
      sell: async () => { throw new Error('unused'); },
      buy: async () => { throw new Error('unused'); },
      listMySellOrders: async () => [],
      sellIntentDeclare: async () => ({
        sellPinId: SELL_PIN,
        txids: ['ab'.repeat(32)],
        totalCost: 600,
        intent: {
          version: '2.2',
          itemPinId: ITEM_PIN,
          collectionName: 'metabot-avatar',
          collectionPinId: COLLECTION_PIN,
          sellerAddress: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
          sellerMetaId: 'idq1sunny000000000000000000000000000000000',
          prices: {
            me: { amountMilli: 2000 },
            fiat: { currency: 'CNY', amountCents: 1990 },
          },
          acceptedCurrencies: ['ME'],
          settlement: ['me_escrow'],
          autoFulfillMe: true,
          autoFulfillTokens: true,
          negotiable: true,
          active: true,
        } as any,
      }),
      sellIntentCancel: async () => { throw new Error('unused'); },
      listSellIntents: async () => [],
      offerPublish: async () => { throw new Error('unused'); },
      offerCancel: async () => { throw new Error('unused'); },
      listOffers: async () => [],
      takeOffer: async () => { throw new Error('unused'); },
    },
  });

  const handler = registered.get('mrc721_sell_intent');
  assert.ok(handler, 'mrc721_sell_intent must register');
  const res = await handler({
    item_pin_id: ITEM_PIN,
    price_me: 2,
    price_cny_yuan: 19.9,
  });
  const toolText = res.content[0].text as string;
  const captured = extractEmittedNftCardFences('mrc721_sell_intent', toolText);
  assert.equal(captured.length, 1);

  const fenceBody = captured[0].fence.replace(/^```nft-card\n|\n```$/g, '');
  const parsed = parseNftCardFence(fenceBody);
  assert.ok(parsed);
  assert.equal(parsed.caVerified, true);
  assert.equal(parsed.sellerName, 'AI_Sunny');
  assert.equal(parsed.sellerOnline, true);
  assert.equal(parsed.ownerLabel, 'AI_Sunny');
  assert.equal(parsed.priceMeMilli, 2000);
  assert.equal(parsed.priceCnyCents, 1990);
  assert.equal(parsed.action, 'selling');

  const html = renderToStaticMarkup(React.createElement(NftCard, { data: parsed }));
  assert.match(html, /LISTED/);
  assert.match(html, /Verified|官方认证/);
  assert.match(html, /2 ME/);
  assert.match(html, /¥19\.90/);
  assert.match(html, /AI_Sunny/);
  assert.ok(z);
});

test('nftCardTurnBackstop captures wallet_token_orders and structured bash skill JSON card envelopes while ignoring plain docs', () => {
  assert.equal(isNftCardBackstopTool('wallet_token_orders'), true);
  const sampleObFence = [
    '```ft-orderbook-card',
    JSON.stringify({
      assetKey: `mrc20:${'44'.repeat(32)}i0`,
      symbol: 'METAID',
      chain: 'btc',
      standard: 'idcoin',
      rail: 'btc-psbt',
      totalOrdersCount: 12,
      pageSize: 6,
      orders: [
        {
          rank: 1,
          orderId: 'ord_1',
          rail: 'btc-psbt',
          amountDisplay: '500',
          unitPricePrimary: '1,440 sat',
          totalPriceLabel: '0.0072 BTC',
        },
      ],
    }),
    '```',
  ].join('\n');

  const hostCaptured = extractEmittedNftCardFences(
    'wallet_token_orders',
    `$METAID order book:\n\n${sampleObFence}`,
  );
  assert.equal(hostCaptured.length, 1);
  assert.equal(hostCaptured[0].tag, 'ft-orderbook-card');

  // Structured skill JSON stdout via bash (`trade.js` / `broker.js`)
  const skillStdout = JSON.stringify(
    {
      success: true,
      cardType: 'ft-orderbook-card',
      message: `Found 12 active orders.\n\n${sampleObFence}`,
    },
    null,
    2,
  );
  const bashCaptured = extractEmittedSkillBashCardFences(skillStdout);
  assert.equal(bashCaptured.length, 1);
  assert.equal(bashCaptured[0].tag, 'ft-orderbook-card');

  // Reading SKILL.md or grepping source files (non-JSON envelope) must NEVER trigger false captures
  const docReadOutput = `# SKILL.md\nInclude verbatim:\n\n${sampleObFence}\n"cardType": "ft-orderbook-card" "message": "example"`;
  assert.equal(extractEmittedSkillBashCardFences(docReadOutput).length, 0);
});
