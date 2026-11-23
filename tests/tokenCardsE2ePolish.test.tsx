import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import initSqlJs from 'sql.js';
import { API_NET, mvc } from 'meta-contract';

import {
  convertGlobalMetaIdToAddresses,
  convertToGlobalMetaId,
  extractGlobalMetaIdCandidate,
} from '../src/main/services/globalMetaid';
import {
  buildFtQuoteCardSnapshot,
  buildTokenCardSnapshot,
  fetchLiveFtSellerOrders,
} from '../src/main/services/tokenCardService';
import {
  ensureFtOrderTables,
  listFtActiveOrders,
  markFtOrdersCanceledByOutpoint,
  registerFtActiveOrder,
} from '../src/main/services/ftOrderStore';
import {
  ensureMvcFtIssuanceTables,
  recordMvcFtIssuance,
} from '../src/main/services/mvcFtIssueService';
import { executeWalletTokenSend } from '../src/main/services/walletTokenSendService';
import { executeWalletMvcTransfer } from '../src/main/services/walletTransferService';
import { BotWalletTransferStore } from '../src/main/services/botWalletTransferStore';
import { resetMvcSpendSessionStateForTests } from '../src/main/services/mvcSpendSessionState';
import { buildMvcFtIssueRawTxLocally } from '../src/main/libs/buildMvcFtIssueRawTxWorker';
import { buildWalletAgentTools, type WalletToolsControl } from '../src/main/libs/walletAgentTools';
import { isNftCardBackstopTool } from '../src/main/libs/nftCardTurnBackstop';
import {
  getToolCapabilitySpec,
  isMobileToolVisible,
  resolveMobileToolExpansions,
} from '../src/main/libs/toolCapabilityRegistry';
import { buildOwnerInteractionPrompt } from '../src/main/libs/ownerInteractionPrompt';
import {
  parseFtActionCardFence,
  parseFtMyOrdersCardFence,
  parseFtOrderCardFence,
  parseFtQuoteCardFence,
} from '../src/renderer/components/chat/ftCardSyntax';
import FtQuoteCard from '../src/renderer/components/chat/FtQuoteCard';
import FtMyOrdersCard from '../src/renderer/components/chat/FtMyOrdersCard';
import FtOrderCard from '../src/renderer/components/chat/FtOrderCard';

const MONDAY_GLOBAL_METAID = 'idq1nrw42rsr9h6z7p977g8vx4y7xut39mvuumv0wm';
const MONDAY_MVC_ADDRESS = '1EwGrbMCpfPSpcJi9ixPwLMme5NCAiQAVr';
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const DERIVATION_PATH = "m/44'/10001'/0'/0/0";

const mockToolFactory = ((
  name: string,
  description: string,
  schema: unknown,
  handler: (...args: any[]) => any,
) => ({
  name,
  description,
  schema,
  handler,
})) as any;

function extractFencePayload(text: string, tag: string): string {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)\\n```', 'i');
  const m = re.exec(text);
  assert.ok(m, `Expected \`\`\`${tag} fenced block in:\n${text}`);
  return m[1];
}

test('Issue #3: GlobalMetaID offline decoder converts Monday idq1nrw42rsr9h6z7p977g8vx4y7xut39mvuumv0wm + metaid:// URI + idz1/idt1 accurately', () => {
  // Exact live E2E target from session 7131445e-93da-4253-8c89-b5890a4195a4
  assert.equal(
    extractGlobalMetaIdCandidate(MONDAY_GLOBAL_METAID),
    MONDAY_GLOBAL_METAID,
  );
  assert.equal(
    extractGlobalMetaIdCandidate(`metaid://${MONDAY_GLOBAL_METAID}/profile`),
    MONDAY_GLOBAL_METAID,
  );
  // Raw Base58 MVC address is NOT misidentified as GlobalMetaID
  assert.equal(extractGlobalMetaIdCandidate(MONDAY_MVC_ADDRESS), null);

  const monday = convertGlobalMetaIdToAddresses(MONDAY_GLOBAL_METAID);
  assert.ok(monday);
  assert.equal(monday.addressType, 'p2pkh');
  assert.equal(monday.mvcAddress, MONDAY_MVC_ADDRESS);
  assert.equal(monday.btcLegacyAddress, MONDAY_MVC_ADDRESS);
  assert.ok(monday.btcSegwitAddress?.startsWith('bc1q'));
  assert.ok(monday.dogeAddress?.startsWith('D'));
  assert.equal(convertToGlobalMetaId(MONDAY_MVC_ADDRESS), MONDAY_GLOBAL_METAID);

  // metaid:// URI form resolves identically
  const fromUri = convertGlobalMetaIdToAddresses(`metaid://${MONDAY_GLOBAL_METAID}/buzz`);
  assert.deepEqual(fromUri, monday);

  // SegWit P2WPKH bc1q... -> idz1... -> derives 20-byte MVC P2PKH + bc1q BTC address
  const segwitGmid = convertToGlobalMetaId(monday.btcSegwitAddress!);
  assert.ok(segwitGmid.startsWith('idz1'));
  const fromSegwit = convertGlobalMetaIdToAddresses(segwitGmid);
  assert.ok(fromSegwit);
  assert.equal(fromSegwit.addressType, 'p2wpkh');
  assert.equal(fromSegwit.mvcAddress, MONDAY_MVC_ADDRESS);
  assert.equal(fromSegwit.btcAddress, monday.btcSegwitAddress);

  // Taproot bc1p... -> idt1... -> returns BTC Taproot address + explicit non-MVC note
  const taprootAddr = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
  const taprootGmid = convertToGlobalMetaId(taprootAddr);
  assert.ok(taprootGmid.startsWith('idt1'));
  const fromTaproot = convertGlobalMetaIdToAddresses(taprootGmid);
  assert.ok(fromTaproot);
  assert.equal(fromTaproot.addressType, 'p2tr');
  assert.equal(fromTaproot.mvcAddress, undefined);
  assert.equal(fromTaproot.btcAddress, taprootAddr);
  assert.match(fromTaproot.note ?? '', /32-byte/i);
});

test('Issue #3: wallet_resolve_global_metaid + direct GlobalMetaID in wallet_token_send, wallet_transfer, and wallet_balance', async () => {
  resetMvcSpendSessionStateForTests();
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const transferStore = new BotWalletTransferStore(db, () => {});

  const sunnyMvc = mvc.PrivateKey.fromRandom(API_NET.MAIN).toAddress(API_NET.MAIN).toString();
  const tdcCodehash = 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7';
  const tdcGenesis = 'be49f83d9e11223344556677889900aabbccddee';
  const tdcGenesisTxId = '66'.repeat(32);

  let broadcastedTo = '';
  let broadcastedGenesis = '';
  const fakeStore = {
    getMetabotById: (id: number) =>
      id === 1
        ? {
            id: 1,
            name: 'AI_Sunny',
            status: 'active',
            metabot_type: 'twin',
            mvc_address: sunnyMvc,
            btc_address: 'bc1qsunny',
            doge_address: 'Dsunny',
            public_key: '02' + '11'.repeat(32),
            globalmetaid: convertToGlobalMetaId(sunnyMvc),
          }
        : null,
    listMetabots: () => [
      {
        id: 1,
        name: 'AI_Sunny',
        status: 'active',
        metabot_type: 'twin',
        mvc_address: sunnyMvc,
        btc_address: 'bc1qsunny',
        doge_address: 'Dsunny',
        public_key: '02' + '11'.repeat(32),
        globalmetaid: convertToGlobalMetaId(sunnyMvc),
      },
    ],
    getMetabotWalletByMetabotId: () => ({ mnemonic: TEST_MNEMONIC, path: DERIVATION_PATH }),
  } as any;

  // Service-level: executeWalletTokenSend accepts Monday's idq1... directly AND 64-hex genesisTxId via sensibleId, returning token_codehash
  const sendOutcome = await executeWalletTokenSend(
    {
      metabotStore: fakeStore,
      transferStore,
      getFeeRate: () => 1,
      listAssetsImpl: async () => [
        {
          symbol: 'TDC',
          tokenName: 'Test Demo Coin',
          genesis: tdcGenesis,
          codeHash: tdcCodehash,
          sensibleId: `${tdcGenesisTxId}00000000`,
          decimal: 8,
          balance: {
            confirmed: '1000000000000000',
            unconfirmed: '0',
            total: '1000000000000000',
            display: '10000000.00000000',
          },
        } as any,
      ],
      executeTokenTransferImpl: async (_store, input) => {
        broadcastedTo = input.toAddress;
        broadcastedGenesis = input.asset.genesis;
        return { txId: 'ab'.repeat(32), rawTx: '00', amountCheckTxId: 'cd'.repeat(32) } as any;
      },
    },
    {
      metabotId: 1,
      to: MONDAY_GLOBAL_METAID,
      genesis: tdcGenesisTxId,
      amount: '1000',
      sessionId: 'sess-e2e',
      origin: 'tool:wallet_token_send',
      externalConfirmed: true,
    },
  );
  assert.equal(sendOutcome.success, true, !sendOutcome.success ? sendOutcome.error : '');
  if (sendOutcome.success) {
    assert.equal(broadcastedTo, MONDAY_MVC_ADDRESS);
    assert.equal(broadcastedGenesis, tdcGenesis);
    assert.equal(sendOutcome.token_genesis, tdcGenesis);
    assert.equal(sendOutcome.token_codehash, tdcCodehash);
    assert.equal(sendOutcome.channel, 'external');
  }

  // Service-level: executeWalletMvcTransfer accepts Monday's metaid://idq1... directly
  let mvcTransferredTo = '';
  const mvcOutcome = await executeWalletMvcTransfer(
    {
      metabotStore: fakeStore,
      transferStore,
      getFeeRate: () => 1,
      getBalanceSnapshotImpl: async () =>
        ({
          confirmed_sats: 10_000_000,
          unconfirmed_sats: 0,
          total_sats: 10_000_000,
        }) as any,
      executeTransferImpl: async (_store, input) => {
        mvcTransferredTo = input.toAddress;
        return { success: true, txId: 'ef'.repeat(32) } as any;
      },
    },
    {
      metabotId: 1,
      to: `metaid://${MONDAY_GLOBAL_METAID}`,
      amountSats: 1_000_000,
      externalConfirmed: true,
      origin: 'tool:wallet_transfer',
    },
  );
  assert.equal(mvcOutcome.success, true, !mvcOutcome.success ? mvcOutcome.error : '');
  if (mvcOutcome.success) {
    assert.equal(mvcTransferredTo, MONDAY_MVC_ADDRESS);
    assert.equal(mvcOutcome.channel, 'external');
  }

  // Agent tool layer: wallet_resolve_global_metaid + wallet_token_send + wallet_balance with GlobalMetaID
  // (Crucially verifies looksLikeMvcAddress does NOT misclassify idq1... as a raw base58 MVC address!)
  const queriedAddresses: Array<{ chain: string; address: string }> = [];
  let toolSendCalledTo = '';
  const mockControl: Partial<WalletToolsControl> = {
    getMetabotMvcAddress: () => sunnyMvc,
    resolveMetabotIdByName: (n) => (n === 'AI_Sunny' ? 1 : null),
    getMetabotSummary: (id) =>
      id === 1
        ? { id: 1, name: 'AI_Sunny', mvcAddress: sunnyMvc, btcAddress: 'bc1qsunny' }
        : null,
    getBalanceForAddress: async (chain, address) => {
      queriedAddresses.push({ chain, address });
      return {
        chain,
        address,
        unit: chain === 'mvc' ? 'SPACE' : chain.toUpperCase(),
        confirmed_sats: 1000,
        unconfirmed_sats: 0,
        total_sats: 1000,
        display: '0.00001',
        verdict: 'verified',
        sources: ['mock'],
      } as any;
    },
    sendToken: async (params) => {
      toolSendCalledTo = params.to;
      return {
        success: true,
        txid: '77'.repeat(32),
        token_symbol: 'TDC',
        token_genesis: tdcGenesis,
        token_codehash: tdcCodehash,
        amount: params.amount,
        channel: 'external',
        to_metabot_id: null,
        audit_id: 1,
      };
    },
  };

  const builtTools = buildWalletAgentTools({
    tool: mockToolFactory,
    sessionId: 'sess-e2e',
    resolveMetabotId: () => 1,
    control: mockControl as WalletToolsControl,
  });
  const byName = new Map(builtTools.map((t: any) => [t.name, t]));

  const resolveTool = byName.get('wallet_resolve_global_metaid')!;
  const resText = (await resolveTool.handler({ global_metaid: MONDAY_GLOBAL_METAID })).content[0].text as string;
  assert.match(resText, new RegExp(MONDAY_MVC_ADDRESS));
  assert.match(resText, /bc1q/);

  const sendTool = byName.get('wallet_token_send')!;
  const sendToolText = (
    await sendTool.handler({ to: MONDAY_GLOBAL_METAID, genesis: tdcGenesis, amount: '1000' })
  ).content[0].text as string;
  assert.equal(toolSendCalledTo, MONDAY_MVC_ADDRESS);
  const actionCard = parseFtActionCardFence(extractFencePayload(sendToolText, 'ft-action-card'));
  assert.ok(actionCard);
  assert.equal(actionCard.assetKey, `mvc-ft:${tdcCodehash}:${tdcGenesis}`);
  assert.equal(actionCard.receiverAddress, MONDAY_MVC_ADDRESS);

  // Taproot GlobalMetaID passed to MVC wallet_token_send fails fast with clear explanation
  const taprootGmid = convertToGlobalMetaId(
    'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
  );
  const taprootErr = await sendTool.handler({ to: taprootGmid, genesis: tdcGenesis, amount: '10' });
  assert.equal(taprootErr.isError, true);
  assert.match(taprootErr.content[0].text as string, /P2TR/i);

  // wallet_balance with GlobalMetaID decodes chain-specific addresses per chain
  const balTool = byName.get('wallet_balance')!;
  await balTool.handler({ address: MONDAY_GLOBAL_METAID });
  assert.equal(queriedAddresses.length, 3);
  assert.equal(queriedAddresses.find((q) => q.chain === 'mvc')?.address, MONDAY_MVC_ADDRESS);
  db.close();
});

test('Issue #1: wallet_token_quote builds Q1 4-rail ft-quote-card for bridged $METAID with 50 ME budget without caVerified false-positive block', async () => {
  const metaidMrc20Id = 'a393fd821be679ce7f8ad176b7dc02fb3f8c2a50d2a5c3ab08fb6bd9e11a68c5i0';
  const metaidCodehash = 'a2421f1e90c6048c36745edd44fad682e8644693';
  const metaidGenesis = '005d326939a40933b4ffbe6ad22fb46fa4be6f9f';
  const spoofGenesis = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('coin-price')) {
      return Response.json({ code: 0, data: { btc: 95000, space: 0.4 } });
    }
    if (url.includes('mrc20/price')) {
      return Response.json({
        code: 0,
        data: { priceInfo: { [`${metaidMrc20Id}/METAID`]: 0.0022 } },
      });
    }
    if (url.includes('contract/ft/price')) {
      return Response.json({ code: 0, data: { [metaidGenesis.toUpperCase()]: 0.0021 } });
    }
    if (url.includes('/api/v1/id-coins/coins-info')) {
      return Response.json({ code: 0, data: {} });
    }
    if (
      url.includes('/api/v1/common/mrc20/tick/info') ||
      url.includes('/wallet-api/v3/mrc20/tick/info')
    ) {
      return Response.json({
        code: 0,
        data: {
          mrc20Id: metaidMrc20Id,
          tick: 'METAID',
          tokenName: 'MetaID Token',
          decimals: '8',
          price: 2.32,
          floorPrice: 2.3,
          change24h: '+4.5%',
          marketCap: 230000000,
          totalSupply: '100000000',
          holders: 1200,
        },
      });
    }
    if (url.includes('api.metaid.market/api-market/api/v1/market/mrc20/orders')) {
      return Response.json({
        code: 0,
        data: {
          list: [
            {
              orderId: 'ord_btc_1',
              mrc20Id: metaidMrc20Id,
              tick: 'METAID',
              amountStr: '5000',
              askType: 0,
              priceAmount: 11500, // 2.30 sats / METAID
              tokenPriceRate: 2.3,
              sellerAddress: 'bc1qseller1',
            },
            {
              orderId: 'ord_btc_2',
              mrc20Id: metaidMrc20Id,
              tick: 'METAID',
              amountStr: '10000',
              askType: 0,
              priceAmount: 24000, // 2.40 sats / METAID
              tokenPriceRate: 2.4,
              sellerAddress: 'bc1qseller2',
            },
          ],
          total: 2,
        },
      });
    }
    if (url.includes('/api/ft/market/token/') && url.endsWith('/summary')) {
      // Reproduce exact live MetaSo condition where caVerified=false on summary
      return Response.json({
        code: 0,
        data: {
          assetKey: `mrc20:${metaidMrc20Id}`,
          symbol: 'METAID',
          caVerified: false,
        },
      });
    }
    if (url.includes('/api/ft/market/listings')) {
      return Response.json({
        code: 0,
        data: {
          items: [
            // Nested MetaSo response shape: rails.{mvcTokenSell, me}
            {
              listingKey: 'pin_mvc_1',
              asset: {
                assetKey: `mvc-ft:${metaidCodehash}:${metaidGenesis}`,
                chain: 'mvc',
                symbol: 'METAID',
                decimals: 8,
                caVerified: false,
              },
              lot: { amountDisplay: '1000' },
              seller: { isOnline: true, botMvcAddress: '1SellerMvc1' },
              rails: {
                mvcTokenSell: {
                  priceSats: 500_000, // 0.005 SPACE total = 0.000005 SPACE / METAID
                  sellTxid: 'aa'.repeat(32),
                  sellOutputIndex: 0,
                },
              },
            },
            // Legitimate ME Escrow online lots (1 nested + 1 flat shape: 25 ME for 12,000 METAID + 25 ME for 11,500 METAID = 50 ME -> 23,500 METAID!)
            {
              listingKey: 'pin_me_1',
              asset: {
                assetKey: `mvc-ft:${metaidCodehash}:${metaidGenesis}`,
                chain: 'mvc',
                symbol: 'METAID',
                decimals: 8,
                caVerified: false,
              },
              lot: { amountDisplay: '12000' },
              seller: { isOnline: true },
              rails: {
                me: { priceMeMilli: 25_000 }, // 25 ME
              },
            },
            {
              pinId: 'pin_me_2',
              assetKey: `mvc-ft:${metaidCodehash}:${metaidGenesis}`,
              chain: 'mvc',
              symbol: 'METAID',
              decimals: 8,
              rail: 'me-escrow',
              amountDisplay: '11500',
              priceMeMilli: 25_000, // 25 ME
              caVerified: false,
              sellerOnline: true,
            },
            // Spoofed unverified copycat with same ticker METAID -> must be filtered out!
            {
              pinId: 'pin_spoof_99',
              assetKey: `mvc-ft:${metaidCodehash}:${spoofGenesis}`,
              chain: 'mvc',
              symbol: 'METAID',
              decimals: 8,
              rail: 'mvc-tokensell',
              amountDisplay: '9999999',
              priceSats: 22_000,
              caVerified: false,
              sellerOnline: true,
            },
          ],
        },
      });
    }
    throw new Error(`Unexpected fetch URL in quote test: ${url}`);
  };

  const snap = await buildFtQuoteCardSnapshot(
    {
      query: '$METAID',
      budget: 50,
      budgetUnit: 'ME',
      metabotId: 1,
    },
    {
      fetchImpl: mockFetch,
      listMvcFtTokens: async () => [
        {
          metabotId: 1,
          address: '1SunnyMvcAddr111111111111111',
          balance: {
            address: '1SunnyMvcAddr111111111111111',
            tokens: [
              {
                symbol: 'METAID',
                codeHash: metaidCodehash,
                genesis: metaidGenesis,
                decimal: 8,
                balance: '300.00000000',
                confirmed: '300.00000000',
                unconfirmed: '0.00000000',
              },
            ],
          },
        },
      ],
    },
  );

  assert.equal(snap.card.symbol, 'METAID');
  assert.equal(snap.card.caVerified, true);
  assert.equal(snap.card.bridgedDualChain, true);
  assert.equal(snap.card.budgetLabel, '50 ME');
  // 4 rails: btc-psbt, mvc-tokensell, me-escrow, mvc-swap
  assert.deepEqual(
    snap.card.quotes.map((q) => q.rail),
    ['btc-psbt', 'mvc-tokensell', 'me-escrow', 'mvc-swap'],
  );
  // Spoofed 9,999,999 METAID order was excluded; mvc-tokensell depth is strictly 1,000 METAID (1 单)
  const mvcQuote = snap.card.quotes.find((q) => q.rail === 'mvc-tokensell')!;
  assert.match(mvcQuote.depthDisplay, /^1,000 METAID \(1 单\)$/);

  // 50 ME budget sweeps both 25 ME lots = 23,500 METAID, marked recommended
  const meQuote = snap.card.quotes.find((q) => q.rail === 'me-escrow')!;
  assert.equal(meQuote.recommended, true);
  assert.match(snap.card.suggestion ?? '', /23,500 METAID/);

  // Verify fence + SSR + registrations
  const parsedFence = parseFtQuoteCardFence(extractFencePayload(snap.fence, 'ft-quote-card'));
  assert.ok(parsedFence);
  const html = renderToStaticMarkup(<FtQuoteCard data={parsedFence} />);
  assert.match(html, /METAID/);
  assert.match(html, /23,500 METAID/);

  // Verify MVC FT display balance fix in buildTokenCardSnapshot (no double 10^8 division on mvcFtTokenBalanceFromAssets)
  const mvcCardSnap = await buildTokenCardSnapshot(
    { query: '$METAID', chain: 'mvc', mode: 'simple', metabotId: 1 },
    {
      fetchImpl: mockFetch,
      listMvcFtTokens: async () => [
        {
          metabotId: 1,
          address: '1SunnyMvcAddr111111111111111',
          balance: {
            address: '1SunnyMvcAddr111111111111111',
            tokens: [
              {
                symbol: 'METAID',
                codeHash: metaidCodehash,
                genesis: metaidGenesis,
                decimal: 8,
                balance: '300.00000000',
                confirmed: '300.00000000',
                unconfirmed: '0.00000000',
              },
            ],
          },
        },
      ],
    },
  );
  assert.equal(mvcCardSnap.card.botBalanceText, '300 METAID');

  // Verify registrations
  assert.equal(isNftCardBackstopTool('wallet_token_quote'), true);
  assert.equal(getToolCapabilitySpec('wallet_token_quote')?.domain, 'financial');
  assert.equal(getToolCapabilitySpec('wallet_token_quote')?.expansion, 'financial');
  assert.equal(getToolCapabilitySpec('wallet_resolve_global_metaid')?.domain, 'financial');
  assert.equal(getToolCapabilitySpec('wallet_resolve_global_metaid')?.expansion, 'financial');

  const mobileSteerExpansions = resolveMobileToolExpansions(
    undefined,
    `你用${MONDAY_GLOBAL_METAID} 这个转换一下地址就好`,
  );
  assert.ok(mobileSteerExpansions.includes('financial'));
  assert.equal(isMobileToolVisible('wallet_resolve_global_metaid', mobileSteerExpansions), true);
  assert.equal(isMobileToolVisible('wallet_token_quote', mobileSteerExpansions), true);
  const prompt = buildOwnerInteractionPrompt({ surface: 'desktop_studio', hasDesktopBrowser: true } as any);
  assert.match(prompt, /wallet_token_quote/);
  assert.match(prompt, /wallet_resolve_global_metaid/);
});

test('Issue #2: wallet_token_my_orders merges local SQLite ft_active_orders + live metaid.market BTC PSBT + MetaSo seller orders without duplicates', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  ensureFtOrderTables(db);

  const sunnyMvc = '1SunnyMvcAddr111111111111111';
  const sunnyBtc = 'bc1qsunnyselleraddress00000000000000000000';
  const sharedSellTxid = 'aa'.repeat(32);

  // Local SQLite: 1 ME Escrow multi-token order (1.048 METAID for 10 ME) + 1 off-index MVC TokenSell order
  registerFtActiveOrder(db, {
    listingKey: 'me-escrow:pin_local_me',
    batchGroupId: 'batch_local_me',
    metabotId: 1,
    assetKey: 'mvc-ft:a242:005d',
    chain: 'mvc',
    symbol: 'METAID',
    decimals: 8,
    rail: 'me-escrow',
    amountBase: '104800000',
    amountDisplay: '1.048',
    utxoOutpoint: `${'bb'.repeat(32)}:0`,
    priceMeMilli: 10_000, // 10 ME per lot -> ~9.542 ME / METAID (10 ME)
    sellPinId: 'pin_local_me',
    sellerAddress: sunnyMvc,
  });
  registerFtActiveOrder(db, {
    listingKey: `mvc-tokensell:${sharedSellTxid}:0`,
    batchGroupId: `tokensell_${sharedSellTxid.slice(0, 12)}`,
    metabotId: 1,
    assetKey: 'mvc-ft:c9cc:be49',
    chain: 'mvc',
    symbol: 'TDC',
    decimals: 8,
    rail: 'mvc-tokensell',
    amountBase: '10000000000',
    amountDisplay: '100',
    utxoOutpoint: `${sharedSellTxid}:0`,
    priceSats: 10_000_000, // 0.1 SPACE
    sellerAddress: sunnyMvc,
    tokenSellJson: JSON.stringify({
      sell_txid: sharedSellTxid,
      sell_output_index: 0,
      sell_price_sats: 10_000_000,
      seller_address: sunnyMvc,
    }),
  });

  // Live external venues: 1 BTC PSBT order on metaid.market + 1 duplicate of sharedSellTxid on MetaSo
  const mockLiveFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.metaid.market/api-market/api/v1/market/mrc20/orders')) {
      return Response.json({
        code: 0,
        data: {
          list: [
            {
              orderId: 'btc_live_ord_01',
              mrc20Id: 'a393i0',
              tick: 'METAID',
              amountStr: '1000',
              askType: 0,
              priceAmount: 2500,
              tokenPriceRate: 2.5,
              sellerAddress: sunnyBtc,
            },
          ],
          total: 1,
        },
      });
    }
    if (url.includes('/api/ft/market/listings')) {
      return Response.json({
        code: 0,
        data: {
          items: [
            // Duplicate of the local MVC TokenSell listing -> must be deduplicated!
            {
              pinId: 'pin_dup_tokensell',
              assetKey: 'mvc-ft:c9cc:be49',
              chain: 'mvc',
              symbol: 'TDC',
              rail: 'mvc-tokensell',
              amountDisplay: '100',
              priceSats: 10_000_000,
              utxoOutpoint: `${sharedSellTxid}:0`,
              sellerAddress: sunnyMvc,
              tokenSellJson: JSON.stringify({
                sell_txid: sharedSellTxid,
                sell_output_index: 0,
                sell_price_sats: 10_000_000,
                seller_address: sunnyMvc,
              }),
            },
          ],
        },
      });
    }
    throw new Error(`Unexpected live orders URL: ${url}`);
  };

  const builtTools = buildWalletAgentTools({
    tool: mockToolFactory,
    sessionId: 'sess-orders',
    resolveMetabotId: () => 1,
    control: {
      getMetabotMvcAddress: () => sunnyMvc,
      getMetabotSummary: () => ({
        id: 1,
        name: 'AI_Sunny',
        mvcAddress: sunnyMvc,
        btcAddress: sunnyBtc,
      }),
      listActiveFtOrders: () => listFtActiveOrders(db, { metabotId: 1, status: 'active' }),
      fetchLiveSellerFtOrders: (inp) => fetchLiveFtSellerOrders(inp, { fetchImpl: mockLiveFetch }),
    } as unknown as WalletToolsControl,
  });
  const byName = new Map(builtTools.map((t: any) => [t.name, t]));

  const myOrdersTool = byName.get('wallet_token_my_orders')!;
  const outText = (await myOrdersTool.handler({})).content[0].text as string;
  const parsed = parseFtMyOrdersCardFence(extractFencePayload(outText, 'ft-my-orders-card'));
  assert.ok(parsed);
  // 2 local + 1 live BTC PSBT (duplicate MVC TokenSell deduplicated!) = 3 total orders!
  assert.equal(parsed.totalOrdersCount, 3);
  assert.deepEqual(
    parsed.orders.map((o) => o.rail),
    ['me-escrow', 'mvc-tokensell', 'btc-psbt'],
  );
  // ME Escrow shows per-token unit price AND lot total
  assert.match(parsed.orders[0].unitPriceLabel, /ME \/ METAID \(10 ME\)/);
  // Valuation combines BTC sats + MVC SPACE + ME
  assert.match(parsed.totalValuationText ?? '', /2,500 sats/);
  assert.match(parsed.totalValuationText ?? '', /0\.1 SPACE/);
  assert.match(parsed.totalValuationText ?? '', /10 ME/);

  const html = renderToStaticMarkup(<FtMyOrdersCard data={parsed} />);
  assert.match(html, /TDC/);
  assert.match(html, /btc-psbt|BTC PSBT|2\.5/);
  db.close();
});

test('Issue #4a: wallet_token_sell accepts 40-hex & 64-hex genesis, auto-splits 100 $TDC from 10M balance, registers ft_active_orders, and cancels cleanly', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  ensureFtOrderTables(db);
  ensureMvcFtIssuanceTables(db);

  const sunnyMvc = '1SunnyMvcAddr111111111111111';
  const tdcCodehash = 'c9cc7bbd1010b44873959a8b1a2bcedeb62302b7';
  const tdcGenesis = 'be49f83d9e11223344556677889900aabbccddee'; // 40-hex MCP02 genesis!
  const tdcGenesisTxId = '55'.repeat(32); // 64-hex genesis txid!
  const splitTxId = '12'.repeat(32);
  const listTxId = '34'.repeat(32);

  recordMvcFtIssuance(db, {
    metabotId: 1,
    issuerAddress: sunnyMvc,
    receiverAddress: sunnyMvc,
    tokenName: 'Test Demo Coin',
    tokenSymbol: 'TDC',
    decimals: 8,
    codehash: tdcCodehash,
    genesis: tdcGenesis,
    sensibleId: `${tdcGenesisTxId}00000000`,
    assetKey: `mvc-ft:${tdcCodehash}:${tdcGenesis}`,
    allowIncreaseMints: false,
    totalMintedBase: '1000000000000000',
    genesisTxId: tdcGenesisTxId,
    genesisTxHex: '01000000',
    latestMintTxId: '99'.repeat(32),
  });

  let splitCalledWith: any = null;
  let sellCalledWith: any = null;

  const builtTools = buildWalletAgentTools({
    tool: mockToolFactory,
    sessionId: 'sess-sell',
    resolveMetabotId: () => 1,
    control: {
      getMetabotMvcAddress: () => sunnyMvc,
      listIssuedTokens: () => [
        {
          id: 1,
          metabotId: 1,
          issuerAddress: sunnyMvc,
          receiverAddress: sunnyMvc,
          tokenName: 'Test Demo Coin',
          tokenSymbol: 'TDC',
          decimals: 8,
          codehash: tdcCodehash,
          genesis: tdcGenesis,
          sensibleId: `${tdcGenesisTxId}00000000`,
          assetKey: `mvc-ft:${tdcCodehash}:${tdcGenesis}`,
          allowIncreaseMints: false,
          totalMintedBase: '1000000000000000',
          genesisTxId: tdcGenesisTxId,
          genesisTxHex: '01000000',
          latestMintTxId: '99'.repeat(32),
          continuationGenesisOutpoint: null,
          continuationGenesisTxHex: null,
          memo: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      // Real mvcFtTokenBalanceFromAssets format (display string with decimal point + confirmed/unconfirmed)
      listMvcFtTokens: async () => [
        {
          metabotId: 1,
          address: sunnyMvc,
          balance: {
            address: sunnyMvc,
            count: 1,
            tokens: [
              {
                symbol: 'TDC',
                codeHash: tdcCodehash,
                genesis: tdcGenesis,
                decimal: 8,
                balance: '10000000.00000000',
                confirmed: '10000000.00000000',
                unconfirmed: '0.00000000',
                count: 1,
              },
            ],
          },
        },
      ],
      splitMvcFtForSell: async (params) => {
        splitCalledWith = params;
        return {
          txId: splitTxId,
          outputIndex: 0,
          amountBase: params.amountBase,
          rawTx: 'deadbeef01',
        };
      },
      sellToken: async (params) => {
        sellCalledWith = params;
        return {
          txId: listTxId,
          fundingTxIds: ['ab'.repeat(32), 'cd'.repeat(32)],
          listing: {
            sell_txid: listTxId,
            sell_output_index: 0,
            sell_price_sats: params.priceSats,
            seller_address: sunnyMvc,
            seed_txid: 'cd'.repeat(32),
            seed_vout: 0,
            token_txid: splitTxId,
            token_vout: 0,
            token_genesis: tdcGenesis,
            token_codehash: tdcCodehash,
            token_amount: params.tokenAmount!,
          },
        };
      },
      cancelTokenSell: async () => ({
        txId: 'ef'.repeat(32),
        fundingTxIds: ['f0'.repeat(32)],
      }),
      registerActiveFtOrder: (inp) => registerFtActiveOrder(db, inp),
      cancelActiveFtOrderByOutpoint: (mid, outpoint) =>
        markFtOrdersCanceledByOutpoint(db, mid, outpoint),
    } as unknown as WalletToolsControl,
  });
  const byName = new Map(builtTools.map((t: any) => [t.name, t]));

  const sellTool = byName.get('wallet_token_sell')!;
  // Test passing 64-hex genesisTxId -> resolves to canonical 40-hex tdcGenesis + splits 100 TDC (10_000_000_000 base)
  const sellRes = await sellTool.handler({
    genesis: tdcGenesisTxId,
    codehash: tdcCodehash,
    amount: '100',
    price_space: 0.1,
  });
  assert.ok(!sellRes.isError, sellRes.content[0].text);
  assert.deepEqual(splitCalledWith, {
    metabotId: 1,
    codehash: tdcCodehash,
    genesis: tdcGenesis,
    amountBase: '10000000000',
  });
  assert.equal(sellCalledWith.genesis, tdcGenesis);
  assert.equal(sellCalledWith.tokenTxid, splitTxId);
  assert.equal(sellCalledWith.tokenVout, 0);
  assert.equal(sellCalledWith.tokenTxHex, 'deadbeef01');
  assert.equal(sellCalledWith.priceSats, 10_000_000);

  const orderCard = parseFtOrderCardFence(
    extractFencePayload(sellRes.content[0].text as string, 'ft-order-card'),
  );
  assert.ok(orderCard);
  assert.equal(orderCard.symbol, 'TDC');
  assert.equal(orderCard.lotAmountDisplay, '100');
  assert.equal(orderCard.totalValueLabel, '0.1 SPACE');
  assert.match(orderCard.unitPriceLabel, /0\.001 SPACE \/ TDC/);

  const html = renderToStaticMarkup(<FtOrderCard data={orderCard} />);
  assert.match(html, /TDC/);

  // Active order was persisted in SQLite ft_active_orders
  const activeBeforeCancel = listFtActiveOrders(db, { metabotId: 1, status: 'active' });
  assert.equal(activeBeforeCancel.length, 1);
  assert.equal(activeBeforeCancel[0].utxoOutpoint, `${listTxId}:0`);
  assert.equal(activeBeforeCancel[0].amountDisplay, '100');

  // Canceling marks the order canceled in ft_active_orders
  const cancelTool = byName.get('wallet_token_cancel_sell')!;
  const cancelRes = await cancelTool.handler({
    sell_txid: listTxId,
    sell_output_index: 0,
    sell_price_sats: 10_000_000,
    seller_address: sunnyMvc,
  });
  assert.ok(!cancelRes.isError, cancelRes.content[0].text);
  const activeAfterCancel = listFtActiveOrders(db, { metabotId: 1, status: 'active' });
  assert.equal(activeAfterCancel.length, 0);
  db.close();
});

test('Issue #4b: compiled buildMvcTokenSellRawTxWorker.js builds real TokenSell LIST from 0-conf unindexed 40-hex genesis FT UTXO + single P2PKH UTXO', async () => {
  const hd = mvc.Mnemonic.fromString(TEST_MNEMONIC)
    .toHDPrivateKey('', API_NET.MAIN)
    .deriveChild(DERIVATION_PATH);
  const privKey = hd.privateKey;
  const walletAddress = privKey.toAddress(API_NET.MAIN);

  // 1. Build real MCP02 FT ($TDC, 100 supply, 8 decimals -> 40-hex genesis) locally
  const issueFundingTx = new mvc.Transaction();
  issueFundingTx.version = 10;
  issueFundingTx.from({
    txId: '11'.repeat(32),
    outputIndex: 0,
    script: mvc.Script.buildPublicKeyHashOut(walletAddress).toHex(),
    satoshis: 300_000,
  });
  issueFundingTx.to(walletAddress, 250_000);
  const issueFundingHex = issueFundingTx.uncheckedSerialize();

  const issued = await buildMvcFtIssueRawTxLocally(
    {
      senderWif: privKey.toWIF(),
      senderAddress: walletAddress.toString(),
      tokenName: 'Test Demo Coin',
      tokenSymbol: 'TDC',
      decimals: 8,
      initialSupplyBase: '10000000000', // 100 TDC
      allowIncreaseMints: false,
      feeRate: 1,
    },
    {
      fetchFundingUtxos: async () => [
        {
          txId: issueFundingTx.id,
          outputIndex: 0,
          satoshis: 250_000,
          height: 100,
        },
      ],
      fetchRawTxHex: async (txId) => {
        if (txId.toLowerCase() === issueFundingTx.id.toLowerCase()) return issueFundingHex;
        throw new Error(`Unexpected raw tx fetch during issuance: ${txId}`);
      },
    },
  );

  assert.equal(issued.genesis.length, 40);
  assert.ok(issued.mintTxHex && issued.mintTxId);

  // Build ONE synthetic P2PKH funding UTXO (tests single-UTXO chaining: checkerMint -> TxA seed via checkerMint change!)
  const singleP2pkhTx = new mvc.Transaction();
  singleP2pkhTx.version = 10;
  singleP2pkhTx.from({
    txId: '22'.repeat(32),
    outputIndex: 0,
    script: mvc.Script.buildPublicKeyHashOut(walletAddress).toHex(),
    satoshis: 200_000,
  });
  singleP2pkhTx.to(walletAddress, 180_000);

  // 2. Stand up local mock indexer that returns EMPTY for both FT UTXO list and P2PKH UTXO list
  //    (reproducing exact 0-conf split lag where APIMVC has indexed neither the split FT UTXO nor P2PKH change!)
  const rawTxMap = new Map<string, string>([
    [issued.genesisTxId.toLowerCase(), issued.genesisTxHex],
    [issued.mintTxId!.toLowerCase(), issued.mintTxHex!],
    [singleP2pkhTx.id.toLowerCase(), singleP2pkhTx.uncheckedSerialize()],
  ]);

  const server = http.createServer((req, res) => {
    const u = req.url || '';
    res.setHeader('Content-Type', 'application/json');
    if (u.includes('/contract/ft/address/') || u.includes('/contract/ft/utxo-list')) {
      res.end(JSON.stringify([]));
      return;
    }
    if (u.includes('/address/utxo-list') || (u.includes('/address/') && u.includes('/utxo'))) {
      res.end(JSON.stringify({ code: 0, data: { list: [] } }));
      return;
    }
    const txHexMatch = /\/tx\/([0-9a-f]{64})\/hex/i.exec(u);
    if (txHexMatch) {
      const hex = rawTxMap.get(txHexMatch[1].toLowerCase());
      if (hex) {
        res.end(hex);
        return;
      }
    }
    const rawInfoMatch = /[?&]txId=([0-9a-f]{64})/i.exec(u);
    if (rawInfoMatch) {
      const hex = rawTxMap.get(rawInfoMatch[1].toLowerCase());
      if (hex) {
        res.end(JSON.stringify({ code: 0, data: { hex } }));
        return;
      }
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `not found: ${u}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const mockBase = `http://127.0.0.1:${port}`;

  try {
    const workerPath = path.resolve(
      __dirname,
      '../dist-electron/main/libs/buildMvcTokenSellRawTxWorker.js',
    );
    const workerPayload = {
      path: DERIVATION_PATH,
      action: 'sell',
      genesis: issued.genesis, // 40-hex MCP02 genesis!
      codehash: issued.codehash,
      tokenTxid: issued.mintTxId,
      tokenVout: issued.tokenOutputIndex,
      tokenTxHex: issued.mintTxHex,
      tokenAmount: '10000000000',
      sellPriceSats: 10_000_000, // 0.1 SPACE
      feeRate: 1,
      preferredFundingUtxos: [
        {
          txId: singleP2pkhTx.id,
          outputIndex: 0,
          satoshis: 180_000,
          address: walletAddress.toString(),
          height: -1,
        },
      ],
    };

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath], {
        env: {
          ...process.env,
          IDBOTS_METABOT_MNEMONIC: TEST_MNEMONIC,
          IDBOTS_MVC_API_HOST: mockBase,
          IDBOTS_METALET_HOST: mockBase,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker exited ${code}: stdout=${out} stderr=${err}`));
        } else {
          resolve(out);
        }
      });
      child.stdin.write(JSON.stringify(workerPayload));
      child.stdin.end();
    });

    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1]);
    assert.ok(parsed.txHex);
    assert.equal(parsed.fundingTxs.length, 2); // checkerMint + TxA seed (chained from single P2PKH UTXO!)
    assert.ok(parsed.listing);
    assert.equal(parsed.listing.token_genesis, issued.genesis);
    assert.equal(parsed.listing.token_codehash, issued.codehash);
    assert.equal(parsed.listing.token_amount, '10000000000');
    assert.equal(parsed.listing.sell_price_sats, 10_000_000);
    assert.equal(parsed.listing.seller_address, walletAddress.toString());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
