import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TOKEN_CARD_FENCE_TAG,
  deriveChangeDir,
  formatTokenAssetShortId,
  formatTokenStandardLabel,
  hasStandaloneTokenCardSegment,
  isTokenCardFenceLanguage,
  parseTokenCardFence,
  sanitizeTokenIconUrl,
  serializeTokenCardFence,
  splitTokenCardMessageSegments,
  type TokenCardData,
} from '../src/renderer/components/chat/tokenCardSyntax';
import TokenCard, {
  TokenCardStreamingPlaceholder,
  resolveTokenCardIconSources,
} from '../src/renderer/components/chat/TokenCard';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import { buildTokenCardSnapshot } from '../src/main/services/tokenCardService';
import { buildWalletAgentTools, type WalletToolsControl } from '../src/main/libs/walletAgentTools';
import {
  appendNftCardFencesToReply,
  extractEmittedNftCardFences,
  recordCapturedNftCardFences,
  selectMissingNftCardFences,
} from '../src/main/libs/nftCardTurnBackstop';
import { resolveConversationProfile } from '../src/main/libs/conversationProfile';
import {
  isMobileToolVisible,
  resolveMobileToolExpansions,
  resolveToolMountPolicy,
  TOOL_CAPABILITY_REGISTRY,
} from '../src/main/libs/toolCapabilityRegistry';
import { buildOwnerInteractionPrompt } from '../src/main/libs/ownerInteractionPrompt';
import { buildProjectorModePrompt } from '../src/main/libs/assistantModePrompt';
import { i18nService } from '../src/renderer/services/i18n';

const METAID_MRC20_ID = '8ce590914f2d21ad28dc67ef2ef8f6b5698207ee96ea0936d2d94545dc8b78f4i0';
const METAID_ASSET_KEY = `mrc20:${METAID_MRC20_ID}`;
const MSP_CODEHASH = 'a2421f1e90c6048c36745edd44fad682e8644693';
const MSP_GENESIS = '49c1a8b09d447711223344556677889900aabbccddee1122334455667788e210';
const MSP_ASSET_KEY = `mvc-ft:${MSP_CODEHASH}:${MSP_GENESIS}`;
const AVATAR_PIN_ID = `${'ab'.repeat(32)}i0`;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('tokenCardSyntax: round-trips simple & detailed cards, normalizes icons, and formats anti-spoofing short IDs', () => {
  assert.equal(isTokenCardFenceLanguage('token-card'), true);
  assert.equal(isTokenCardFenceLanguage('TOKENCARD'), true);
  assert.equal(isTokenCardFenceLanguage('json'), false);

  assert.equal(formatTokenAssetShortId(METAID_ASSET_KEY), '8ce590…78f4i0');
  assert.equal(formatTokenAssetShortId(MSP_ASSET_KEY), 'a242:49c1…e210');
  assert.equal(formatTokenAssetShortId('native:btc'), 'BTC Native');

  assert.equal(formatTokenStandardLabel('btc', 'idcoin'), 'BTC · ID-Coin');
  assert.equal(formatTokenStandardLabel('btc', 'mrc20'), 'BTC · MRC-20');
  assert.equal(formatTokenStandardLabel('mvc', 'mvc-ft'), 'MVC · MCP02');
  assert.equal(formatTokenStandardLabel('btc', 'native'), 'BTC · Native');

  assert.equal(
    sanitizeTokenIconUrl(`/content/${AVATAR_PIN_ID}`),
    `metafile://${AVATAR_PIN_ID}`,
  );
  assert.equal(sanitizeTokenIconUrl('https://www.metalet.space/icon.png'), 'https://www.metalet.space/icon.png');
  assert.equal(sanitizeTokenIconUrl('javascript:alert(1)'), undefined);
  assert.equal(sanitizeTokenIconUrl('http://insecure.example.com/a.png'), undefined);

  assert.equal(deriveChangeDir('+7.77%'), 'up');
  assert.equal(deriveChangeDir('-4.32%'), 'down');
  assert.equal(deriveChangeDir('0.00%'), 'flat');

  const sampleDetailed: TokenCardData = {
    mode: 'detailed',
    symbol: 'METAID',
    name: 'METAID',
    chain: 'btc',
    standard: 'idcoin',
    assetKey: METAID_ASSET_KEY,
    caVerified: true,
    icon: `metafile://${AVATAR_PIN_ID}`,
    snapshotAt: '2026-11-23T00:11:00.000Z',
    priceMain: '970',
    priceUnit: 'sat',
    priceNativeText: '≈ 0.0000097 BTC',
    priceUsdText: '$0.590',
    change24h: '+7.77%',
    changeDir: 'up',
    floorPriceText: '1,580 sat',
    floorUsdText: '$0.961',
    marketVsFloorPct: -38.6,
    marketCapMain: '48.5 BTC',
    marketCapUsd: 28600,
    volumeMain: '7.615 BTC',
    volumeUsd: 4630,
    holdersCount: 869,
    followersCount: 2718,
    supplyMain: '5,000,000',
    mintProgressPct: 100,
    mintable: false,
    botName: 'AI_Sunny',
    botBalanceText: '1,250 METAID',
    botBalanceUsdText: '≈ $737.50',
    quickActions: ['orders', 'trades', 'trade'],
  };

  const fence = serializeTokenCardFence(sampleDetailed);
  assert.ok(fence.startsWith(`\`\`\`${TOKEN_CARD_FENCE_TAG}\n`));
  const parsed = parseTokenCardFence(
    fence.replace(/^```token-card\n|\n```$/g, ''),
  );
  assert.ok(parsed);
  assert.equal(parsed.mode, 'detailed');
  assert.equal(parsed.symbol, 'METAID');
  assert.equal(parsed.marketVsFloorPct, -38.6);
  assert.equal(parsed.holdersCount, 869);
  assert.equal(parsed.mintable, false);
  assert.deepEqual(parsed.quickActions, ['orders', 'trades', 'trade']);

  // Invalid payloads return null cleanly
  assert.equal(parseTokenCardFence('{bad json'), null);
  assert.equal(parseTokenCardFence(JSON.stringify({ symbol: 'X' })), null);
});

test('splitTokenCardMessageSegments: isolates standalone token-card bubbles from surrounding prose and handles streaming & nested fences', () => {
  const cardPayload: TokenCardData = {
    mode: 'simple',
    symbol: 'METAID',
    chain: 'btc',
    standard: 'idcoin',
    assetKey: METAID_ASSET_KEY,
    caVerified: true,
    priceMain: '970',
    priceUnit: 'sat',
    priceUsdText: '$0.590',
    change24h: '+7.77%',
    changeDir: 'up',
    botName: 'AI_Sunny',
    botBalanceText: '1,250 METAID',
    botBalanceUsdText: '≈ $737.50',
  };
  const cardFence = serializeTokenCardFence(cardPayload);

  // 1. Plain prose has no standalone token card
  const plainSegs = splitTokenCardMessageSegments('Hello owner, everything is ready.');
  assert.equal(plainSegs.length, 1);
  assert.equal(hasStandaloneTokenCardSegment(plainSegs), false);

  // 2. Prose before + token-card + prose after -> 3 ordered segments
  const mixed = `为你查到 $METAID 的最新行情：\n\n${cardFence}\n\n目前市价低于挂单地板价，需要帮你查看挂单列表吗？`;
  const mixedSegs = splitTokenCardMessageSegments(mixed);
  assert.equal(hasStandaloneTokenCardSegment(mixedSegs), true);
  assert.equal(mixedSegs.length, 3);
  assert.equal(mixedSegs[0].kind, 'markdown');
  assert.equal(mixedSegs[1].kind, 'token-card');
  assert.equal(mixedSegs[2].kind, 'markdown');
  if (mixedSegs[1].kind === 'token-card') {
    assert.equal(mixedSegs[1].data.symbol, 'METAID');
  }

  // 3. Nested inside 4-backtick outer markdown block stays literal markdown
  const nestedDoc = ['````markdown', cardFence, '````'].join('\n');
  const nestedSegs = splitTokenCardMessageSegments(nestedDoc);
  assert.equal(hasStandaloneTokenCardSegment(nestedSegs), false);
  assert.equal(nestedSegs.length, 1);

  // 4. Malformed JSON inside closed token-card fence stays in markdown (never lost)
  const malformed = 'Intro\n\n```token-card\n{"not":"complete"}\n```\n\nOutro';
  const malformedSegs = splitTokenCardMessageSegments(malformed);
  assert.equal(hasStandaloneTokenCardSegment(malformedSegs), false);
  assert.equal(malformedSegs.length, 1);
  if (malformedSegs[0].kind === 'markdown') {
    assert.ok(malformedSegs[0].content.includes('{"not":"complete"}'));
  }

  // 5. Unclosed trailing fence while streaming emits token-card-streaming placeholder
  const partialStream = '正在拉取实时盘口：\n\n```token-card\n{"mode":"detailed","symbol":"METAID"';
  const streamSegs = splitTokenCardMessageSegments(partialStream, { isStreaming: true });
  assert.equal(hasStandaloneTokenCardSegment(streamSegs), true);
  assert.equal(streamSegs.length, 2);
  assert.equal(streamSegs[0].kind, 'markdown');
  assert.equal(streamSegs[1].kind, 'token-card-streaming');
});

test('tokenCardService: aggregates real ID-Coin market + Bot wallet holding and survives api.metaid.market timeout via Metalet fallback', async () => {
  // Case A: Full api.metaid.market + Metalet + MetaSo + Bot wallet response (matching session 7131445e)
  const mockFetchFull: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/wallet-api/v3/coin/price')) {
      return jsonResponse({
        code: 0,
        data: { coinPrice: { btc: 60857.95, mvc: 0.097, doge: 0.093 } },
      });
    }
    if (url.includes('/api/v1/id-coins/coins-info')) {
      return jsonResponse({
        code: 0,
        data: {
          list: [
            {
              tick: 'METAID',
              tokenName: 'METAID',
              mrc20Id: METAID_MRC20_ID,
              marketPrice: 970,
              marketPriceUsd: 0.59,
              floorPrice: 1580,
              floorPriceUsd: 0.961,
              change24h: '+7.77%',
              marketCap: 4850000000, // 48.5 BTC in sats
              marketCapUsd: 28600,
              totalVolume: 761515984, // ~7.615 BTC in sats
              holders: 869,
              followersCount: 2718,
              supply: '5000000',
              totalSupply: '5000000',
              mintable: false,
              deployerUserInfo: {
                name: 'MetaID',
                avatar: `/content/${AVATAR_PIN_ID}`,
              },
            },
          ],
        },
      });
    }
    if (url.includes('/api/v1/common/mrc20/tick/info')) {
      return jsonResponse({ code: 0, data: { list: [] } });
    }
    if (url.includes('/wallet-api/v3/coin/mrc20/price')) {
      return jsonResponse({
        code: 0,
        data: { [`${METAID_MRC20_ID}/METAID`]: 0.59 },
      });
    }
    if (url.includes('/api/ft/market/token/')) {
      return jsonResponse({
        code: 0,
        data: { caVerified: true, holderCount: 869 },
      });
    }
    return jsonResponse({ code: 404 }, 404);
  };

  const resFull = await buildTokenCardSnapshot(
    { query: '$METAID', mode: 'detailed', metabotId: 1 },
    {
      fetchImpl: mockFetchFull,
      getMetabotSummary: () => ({ id: 1, name: 'AI_Sunny', btcAddress: 'bc1qtest' }),
      listMrc20s: async () => [
        {
          metabotId: 1,
          address: 'bc1qtest',
          assets: [
            {
              kind: 'mrc20',
              chain: 'btc',
              mrc20Id: METAID_MRC20_ID,
              symbol: 'METAID',
              tokenName: 'METAID',
              address: 'bc1qtest',
              decimal: 8,
              balance: {
                confirmed: '1250',
                unconfirmed: '0',
                pendingIn: '0',
                pendingOut: '0',
                display: '1250',
              },
            },
          ],
        },
      ],
    },
  );

  assert.equal(resFull.card.mode, 'detailed');
  assert.equal(resFull.card.symbol, 'METAID');
  assert.equal(resFull.card.standard, 'idcoin');
  assert.equal(resFull.card.caVerified, true);
  assert.equal(resFull.card.icon, `metafile://${AVATAR_PIN_ID}`);
  assert.equal(resFull.card.priceMain, '970');
  assert.equal(resFull.card.priceUnit, 'sat');
  assert.equal(resFull.card.floorPriceText, '1,580 sat');
  assert.equal(resFull.card.marketVsFloorPct, -38.61);
  assert.equal(resFull.card.marketCapMain, '48.5 BTC');
  assert.equal(resFull.card.holdersCount, 869);
  assert.equal(resFull.card.followersCount, 2718);
  assert.equal(resFull.card.mintable, false);
  assert.equal(resFull.card.botName, 'AI_Sunny');
  assert.equal(resFull.card.botBalanceText, '1,250 METAID');
  assert.equal(resFull.card.botBalanceUsdText, '≈ $737.50');

  // Case B: api.metaid.market times out -> Metalet fast fallback still resolves price, sats, and Bot holding!
  const mockFetchTimeoutFallback: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.metaid.market')) {
      throw new Error('AbortError: api.metaid.market timed out');
    }
    if (url.includes('/wallet-api/v3/coin/price')) {
      return jsonResponse({
        code: 0,
        data: { coinPrice: { btc: 60000, mvc: 0.1, doge: 0.09 } },
      });
    }
    if (url.includes('/wallet-api/v3/coin/mrc20/price')) {
      return jsonResponse({
        code: 0,
        data: { [`${METAID_MRC20_ID}/METAID`]: 0.6 },
      });
    }
    if (url.includes('/wallet-api/v3/mrc20/tick/info')) {
      return jsonResponse({
        code: 0,
        data: {
          mrc20Id: METAID_MRC20_ID,
          tick: 'METAID',
          tokenName: 'METAID',
          holders: 870,
          totalMinted: '5000000',
          mintCount: '5000',
          amtPerMint: '1000',
        },
      });
    }
    return jsonResponse({ code: 0, data: {} });
  };

  const resFallback = await buildTokenCardSnapshot(
    { query: 'METAID', mode: 'simple', metabotId: 1 },
    {
      fetchImpl: mockFetchTimeoutFallback,
      getMetabotSummary: () => ({ id: 1, name: 'AI_Sunny' }),
      listMrc20s: async () => [],
    },
  );

  assert.equal(resFallback.card.symbol, 'METAID');
  assert.equal(resFallback.card.assetKey, METAID_ASSET_KEY);
  assert.equal(resFallback.card.priceMain, '1,000'); // $0.60 / $60,000 * 1e8 = 1,000 sat
  assert.equal(resFallback.card.priceUnit, 'sat');
  assert.equal(resFallback.card.botZeroHolding, true);
  assert.equal(resFallback.card.botBalanceText, '0 METAID');
});

test('tokenCardService: supports MVC MetaContract FT ($MSP) and Native L1 coins ($BTC, $SPACE)', async () => {
  const mockFetchMvcAndNative: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/wallet-api/v3/coin/price')) {
      return jsonResponse({
        code: 0,
        data: { coinPrice: { btc: 62000, mvc: 0.1, doge: 0.095 } },
      });
    }
    if (url.includes('/wallet-api/v3/coin/contract/ft/price')) {
      return jsonResponse({
        code: 0,
        data: { contractFtPrice: { [MSP_GENESIS]: 0.02 } },
      });
    }
    if (url.includes('/wallet-api/v4/mvc/contract/ft/info')) {
      return jsonResponse({
        code: 0,
        data: {
          symbol: 'MSP',
          name: 'MetaSo Points',
          decimal: 8,
          totalSupply: '200000000000000', // 2,000,000 * 10^8
          holders: 1420,
          icon: `metafile://${'47'.repeat(32)}.png`,
        },
      });
    }
    if (url.includes('/api/ft/market/token/')) {
      return jsonResponse({
        code: 0,
        data: { caVerified: true, holderCount: 1420 },
      });
    }
    return jsonResponse({ code: 0, data: { list: [] } });
  };

  const mvcRes = await buildTokenCardSnapshot(
    { query: '$MSP', mode: 'detailed', chain: 'mvc', metabotId: 2 },
    {
      fetchImpl: mockFetchMvcAndNative,
      getMetabotSummary: () => ({ id: 2, name: 'TraderBot' }),
      listMvcFtTokens: async () => [
        {
          metabotId: 2,
          address: '1MvcTraderAddress',
          balance: {
            address: '1MvcTraderAddress',
            tokens: [
              {
                codeHash: MSP_CODEHASH,
                genesis: MSP_GENESIS,
                symbol: 'MSP',
                tokenName: 'MetaSo Points',
                decimal: 8,
                balance: '1580000000000', // 15,800 MSP in base units
              },
            ],
          },
        },
      ],
    },
  );

  assert.equal(mvcRes.card.chain, 'mvc');
  assert.equal(mvcRes.card.standard, 'mvc-ft');
  assert.equal(mvcRes.card.symbol, 'MSP');
  assert.equal(mvcRes.card.caVerified, true);
  assert.equal(mvcRes.card.priceUnit, 'SPACE');
  assert.equal(mvcRes.card.supplyMain, '2,000,000');
  assert.equal(mvcRes.card.botBalanceText, '15,800 MSP');
  assert.equal(mvcRes.card.botBalanceUsdText, '≈ $316.00');
  // MVC icon uses Metalet compress route first
  const iconSources = resolveTokenCardIconSources(mvcRes.card);
  assert.ok(iconSources[0]?.startsWith('https://metalet.space/metafile/compress/'));

  const btcRes = await buildTokenCardSnapshot(
    { query: '$BTC', mode: 'simple', metabotId: 2 },
    {
      fetchImpl: mockFetchMvcAndNative,
      getMetabotSummary: () => ({ id: 2, name: 'TraderBot' }),
      getBalances: async () =>
        ({
          entries: [
            {
              metabotId: 2,
              name: 'TraderBot',
              balances: {
                btc: {
                  confirmed_sats: 1_500_000,
                  unconfirmed_sats: 0,
                  total_sats: 1_500_000, // 0.015 BTC
                },
              },
            },
          ],
        }) as any,
    },
  );

  assert.equal(btcRes.card.standard, 'native');
  assert.equal(btcRes.card.symbol, 'BTC');
  assert.equal(btcRes.card.caVerified, true);
  assert.equal(btcRes.card.priceMain, '$62,000.00');
  assert.equal(btcRes.card.botBalanceText, '0.015 BTC');
  assert.equal(btcRes.card.botBalanceUsdText, '≈ $930.00');
});

test('wallet_token_card tool, Studio/Mobile governance, prompt contracts, and turn backstop work end-to-end', async () => {
  // 1. Registry & Studio/Mobile profile governance
  assert.equal(TOOL_CAPABILITY_REGISTRY.get('wallet_token_card')?.domain, 'financial');
  const studioProfile = resolveConversationProfile({
    serverMode: false,
    session: { assistantMode: true, sessionType: 'browser' },
    executionRole: 'twin',
  });
  assert.equal(studioProfile.isStudioOwnerChat, true);
  assert.equal(resolveToolMountPolicy(studioProfile, []).financial, true);

  // Mobile regex intent expansion triggers on $TICKER / 币价 / 行情, NOT on casual chat
  assert.equal(isMobileToolVisible('wallet_token_card', []), false);
  const tickerExpansions = resolveMobileToolExpansions(undefined, '$METAID 现在多少钱？');
  assert.ok(tickerExpansions.includes('financial'));
  assert.equal(isMobileToolVisible('wallet_token_card', tickerExpansions), true);

  const overviewExpansions = resolveMobileToolExpansions(undefined, '帮我看下 MSP 的地板价和市值行情');
  assert.ok(overviewExpansions.includes('financial'));
  const casualExpansions = resolveMobileToolExpansions(
    undefined,
    '我今天任务好多，先发个链接看看行业动态，明天再说',
  );
  assert.equal(casualExpansions.includes('financial'), false);

  // 2. Owner & Projector prompts explicitly whitelist ```token-card and guide mode selection
  const ownerPrompt = buildOwnerInteractionPrompt({
    surface: 'desktop_studio',
    hasOwnerUpdate: true,
    hasProjector: true,
    hasDesktopBrowser: true,
    hasWebSearch: true,
  });
  assert.ok(ownerPrompt.includes('```token-card'));
  assert.ok(ownerPrompt.includes('wallet_token_card'));
  assert.ok(buildProjectorModePrompt().includes('```token-card'));

  // 3. Host tool execution & turn-end backstop
  const mockControl: WalletToolsControl = {
    async getBalances() {
      return {} as any;
    },
    async listMrc20s() {
      return [];
    },
    async transferAsset() {
      return {} as any;
    },
    async listNfts() {
      return [];
    },
    async transferNft() {
      return {} as any;
    },
    async listNftSellOrders() {
      return [];
    },
    async sellNft() {
      return {} as any;
    },
    async cancelSellNft() {
      return {} as any;
    },
    async buyNft() {
      return {} as any;
    },
    async listMvcFtTokens() {
      return [];
    },
    async sendMvcFtToken() {
      return {} as any;
    },
    async listMvcFtSellOrders() {
      return [];
    },
    async sellMvcFtToken() {
      return {} as any;
    },
    async buyMvcFtToken() {
      return {} as any;
    },
    async cancelSellMvcFtToken() {
      return {} as any;
    },
    async getTokenCard(input) {
      const card: TokenCardData = {
        mode: input.mode,
        symbol: 'METAID',
        chain: 'btc',
        standard: 'idcoin',
        assetKey: METAID_ASSET_KEY,
        caVerified: true,
        priceMain: '970',
        priceUnit: 'sat',
        priceUsdText: '$0.590',
        change24h: '+7.77%',
        changeDir: 'up',
        botName: 'AI_Sunny',
        botBalanceText: '1,250 METAID',
        botBalanceUsdText: '≈ $737.50',
      };
      const fence = serializeTokenCardFence(card);
      return {
        card,
        fence,
        summaryText: `Token Card ready:\n\n${fence}`,
      };
    },
  };

  const registeredTools = new Map<string, (args: any) => Promise<any>>();
  buildWalletAgentTools({
    tool: (name, _desc, _schema, handler) => {
      registeredTools.set(name, handler);
      return { name };
    },
    control: mockControl,
    sessionId: 'sess_test',
    resolveMetabotId: () => 1,
  });
  const tokenCardHandler = registeredTools.get('wallet_token_card');
  assert.ok(tokenCardHandler, 'wallet_token_card is mounted in buildWalletAgentTools');

  const toolRes = await tokenCardHandler({
    token: '$METAID',
    mode: 'simple',
  });
  const toolText = toolRes.content[0].text as string;
  assert.ok(toolText.includes('```token-card'));

  // Turn backstop captures wallet_token_card fences, upgrades simple -> detailed for same assetKey, and appends if omitted
  const capturedSimple = extractEmittedNftCardFences('mcp__idbots__wallet_token_card', toolText);
  assert.equal(capturedSimple.length, 1);
  assert.equal(capturedSimple[0].tag, 'token-card');

  const toolResDetailed = await tokenCardHandler({
    token: 'METAID',
    mode: 'detailed',
  });
  const capturedDetailed = extractEmittedNftCardFences(
    'wallet_token_card',
    toolResDetailed.content[0].text,
  );
  const ledger = recordCapturedNftCardFences(capturedSimple, capturedDetailed);
  assert.equal(ledger.length, 1, 'same assetKey deduplicates and upgrades to latest mode');
  assert.ok(ledger[0].fence.includes('"mode":"detailed"'));

  const missingWhenOmitted = selectMissingNftCardFences(ledger, [
    '我已经帮你查好了 $METAID 的最新盘口。',
  ]);
  assert.equal(missingWhenOmitted.length, 1);
  const patchedReply = appendNftCardFencesToReply(
    '我已经帮你查好了 $METAID 的最新盘口。',
    missingWhenOmitted,
  );
  assert.ok(patchedReply.includes('```token-card'));

  const missingWhenIncluded = selectMissingNftCardFences(ledger, [patchedReply]);
  assert.equal(missingWhenIncluded.length, 0);
});

test('TokenCard SSR (S1 Simple & D1 Detailed) and standalone bubble wiring across Studio, Cowork, and Mobile', () => {
  const prevLang = i18nService.getLanguage();
  try {
    i18nService.setLanguage('zh', { persist: false });

    const s1Verified: TokenCardData = {
      mode: 'simple',
      symbol: 'METAID',
      chain: 'btc',
      standard: 'idcoin',
      assetKey: METAID_ASSET_KEY,
      caVerified: true,
      priceMain: '970',
      priceUnit: 'sat',
      priceUsdText: '$0.590',
      change24h: '+7.77%',
      changeDir: 'up',
      botName: 'AI_Sunny',
      botBalanceText: '1,250 METAID',
      botBalanceUsdText: '≈ $737.50',
    };

    const s1Html = renderToStaticMarkup(<TokenCard data={s1Verified} />);
    assert.ok(s1Html.includes('data-token-card="simple"'));
    assert.ok(s1Html.includes('$METAID'));
    assert.ok(s1Html.includes('data-token-verified="true"'));
    assert.ok(s1Html.includes('970'));
    assert.ok(s1Html.includes('+7.77%'));
    assert.ok(s1Html.includes('1,250 METAID'));
    assert.ok(s1Html.includes('≈ $737.50'));

    const d1Unverified: TokenCardData = {
      mode: 'detailed',
      symbol: 'DOGEAI',
      name: 'Doge Agent Meme',
      chain: 'btc',
      standard: 'mrc20',
      assetKey: `mrc20:9b18${'cc'.repeat(28)}31e4i0`,
      caVerified: false,
      snapshotAt: '2026-11-23T00:11:00.000Z',
      priceMain: '12',
      priceUnit: 'sat',
      priceNativeText: '≈ 0.00000012 BTC',
      priceUsdText: '$0.0073',
      change24h: '+42.80%',
      changeDir: 'up',
      floorPriceText: '14 sat',
      floorUsdText: '$0.0085',
      marketVsFloorPct: -14.3,
      marketCapMain: '1.2 BTC',
      marketCapUsd: 73000,
      volumeMain: '6.4 BTC',
      volumeUsd: 390000,
      holdersCount: 186,
      supplyMain: '6.2M / 10M',
      mintProgressPct: 62,
      mintable: true,
      botName: 'AI_Sunny',
      botBalanceText: '0 DOGEAI',
      botZeroHolding: true,
      quickActions: ['orders', 'trades', 'trade'],
    };

    const d1Html = renderToStaticMarkup(<TokenCard data={d1Unverified} />);
    assert.ok(d1Html.includes('data-token-card="detailed"'));
    assert.ok(d1Html.includes('data-token-verified="false"'));
    assert.ok(d1Html.includes('未认证'));
    assert.ok(d1Html.includes('地板价'));
    assert.ok(d1Html.includes('低于地板 -14.3%'));
    assert.ok(d1Html.includes('总市值'));
    assert.ok(d1Html.includes('累计成交'));
    assert.ok(d1Html.includes('186 持有人'));
    assert.ok(d1Html.includes('已铸 62.0% · 可继续 Mint'));
    assert.ok(d1Html.includes('暂未持有'));
    assert.ok(d1Html.includes('data-token-action="orders"'));
    assert.ok(d1Html.includes('data-token-action="trades"'));
    assert.ok(d1Html.includes('data-token-action="trade"'));

    // Streaming placeholder renders cleanly
    const streamHtml = renderToStaticMarkup(<TokenCardStreamingPlaceholder />);
    assert.ok(streamHtml.includes('data-token-card="streaming"'));

    // MarkdownContent fallback renders TokenCard for valid fence and code block for malformed fence
    const mdValidHtml = renderToStaticMarkup(
      <MarkdownContent content={serializeTokenCardFence(s1Verified)} />,
    );
    assert.ok(mdValidHtml.includes('data-token-card="simple"'));

    const mdInvalidHtml = renderToStaticMarkup(
      <MarkdownContent content={'```token-card\n{"broken":true}\n```'} />,
    );
    assert.equal(mdInvalidHtml.includes('data-token-card='), false);
    assert.ok(mdInvalidHtml.includes('broken'));

    // Verify all 3 chat surfaces (Studio panel, Desktop Cowork, Mobile ChatScreen) mount standalone token bubbles outside .assistant-bubble / .twin-message-assistant
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const panelSrc = fs.readFileSync(
      path.join(repoRoot, 'src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx'),
      'utf8',
    );
    const detailSrc = fs.readFileSync(
      path.join(repoRoot, 'src/renderer/components/cowork/CoworkSessionDetail.tsx'),
      'utf8',
    );
    const mobileSrc = fs.readFileSync(
      path.join(repoRoot, 'src/mobile/app/screens/ChatScreen.tsx'),
      'utf8',
    );

    assert.match(panelSrc, /splitTokenCardMessageSegments/);
    assert.match(panelSrc, /data-standalone-token-bubble="true"/);
    assert.match(detailSrc, /splitTokenCardMessageSegments/);
    assert.match(detailSrc, /data-standalone-token-bubble="true"/);
    assert.match(mobileSrc, /splitTokenCardMessageSegments/);
    assert.match(mobileSrc, /data-standalone-token-bubble="true"/);
    assert.match(mobileSrc, /window\.addEventListener\('cowork:focus-input'/);
  } finally {
    i18nService.setLanguage(prevLang, { persist: false });
  }
});
