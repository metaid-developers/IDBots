import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import * as bitcoin from 'bitcoinjs-lib';
import { BtcWallet, CoinType, AddressType } from '@metalet/utxo-wallet-service';
import { ensureAssetBridgeSchema, AssetBridgeStore } from '../src/main/services/assetBridgeStore';
import { OctopusBridgeClient, extractOctopusApiErrorMessage } from '../src/main/services/octopusBridgeClient';
import { AssetBridgeService } from '../src/main/services/assetBridgeService';
import { calculateBtcMintMaxAmount, deriveAssetBridgeWalletContext, signBtcBridgeSend } from '../src/main/services/assetBridgeSigner';
import { executeMrc20Transfer } from '../src/main/services/mrc20Service';
import { summarizeRawTx } from '../src/main/services/btcMultisigScript';
import { CoworkCrossSessionService } from '../src/main/services/coworkCrossSession';
import { extractEmittedNftCardFences, recordCapturedNftCardFences, selectMissingNftCardFences } from '../src/main/libs/nftCardTurnBackstop';
import { formatAssetBridgeCardFence, parseAssetBridgeCardFence, parseAssetBridgeNoticeFence, formatAssetBridgeNoticeFence } from '../src/renderer/components/chat/assetBridgeCardSyntax';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NETWORK = bitcoin.networks.bitcoin;

function response(text: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
}

async function memoryDb() {
  const SQL = await initSqlJs();
  return new SQL.Database() as any;
}

function btcPair() {
  return {
    network: 'BTC', originName: 'Bitcoin', originSymbol: 'BTC', originTokenId: 'btc', targetName: 'Wrapped Bitcoin', targetSymbol: 'WBTC', targetTokenId: 'wbtc',
    targetTokenCodeHash: 'cc'.repeat(32), targetTokenGenesis: 'gg'.repeat(32), decimals: 8, trimDecimals: 0, isEnableMint: true, isEnableRedeem: true,
  } as any;
}
function mrcPair() {
  return {
    network: 'MRC20', originName: 'MetaID', originSymbol: 'METAID', originTokenId: 'mrc-id', targetName: 'MetaID', targetSymbol: 'METAID', targetTokenId: 'mvc-id',
    targetTokenCodeHash: 'dd'.repeat(32), targetTokenGenesis: 'ee'.repeat(32), decimals: 8, trimDecimals: 4, isEnableMint: true, isEnableRedeem: true,
  } as any;
}
function assetList() {
  return {
    feeBtc: 2, feeMvc: 1, amountLimitMaximum: 100_000_000, amountLimitMinimum: 1000,
    confirmSequence: [[0, 10_000, 1, 1], [10_000, null, 3, 2]] as any,
    assetList: [btcPair(), mrcPair()],
  };
}
function feeQuote(overrides: Record<string, unknown> = {}) {
  return {
    btcFeeRate: 2, mvcFeeRate: 1, btcServiceFeeSats: 700, mvcServiceFeeSats: 600,
    estNetworkMinerBtcSats: 500, estNetworkMinerMvcSats: 900,
    btcBridgeMinerFeeSats: 200, btcPostageSats: 100, mvcBridgeMinerFeeSats: 300,
    btcFeeSats: 1000, btcFeeAddress: '1FeeAddress111111111111111111111', mvcFeeSats: 800, mvcFeeAddress: '1MvcFee1111111111111111111111',
    ...overrides,
  } as any;
}
function context() {
  return { wallet: {} as any, btcAddress: '1TestBtc1111111111111111111111', mvcAddress: '1TestMvc1111111111111111111111', publicKey: '02' + '11'.repeat(32), publicKeySign: 'sig', mnemonic: MNEMONIC, addressIndex: 0 };
}
function metabotStore() {
  return { getMetabotById: () => ({ id: 1, name: 'Bot' }), getMetabotWalletByMetabotId: () => ({ mnemonic: MNEMONIC, path: "m/44'/10001'/0'/0/0" }) } as any;
}
function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls = { submit: 0, create: 0, orderStatus: 0 };
  const client = {
    calls,
    assetList: async () => assetList(),
    feeQuote: async () => feeQuote(),
    createPrepayOrder: async () => {
      calls.create += 1;
      return { orderId: 'aa'.repeat(32), bridgeAddress: '1Bridge11111111111111111111', btcFeeSats: 1000, btcFeeAddress: '1FeeAddress111111111111111111111', confirmNumber: 2 };
    },
    submitPrepayOrder: async () => {
      calls.submit += 1;
      return { success: true };
    },
    getOrderStatus: async () => ({ kind: 'not_found' }),
    queryTransactionsByAddress: async () => [],
    ...overrides,
  } as any;
  return client;
}
async function makeService(client = fakeClient(), extraDeps: Record<string, unknown> = {}) {
  const db = await memoryDb();
  ensureAssetBridgeSchema(db);
  const events: any[] = [];
  const service = new AssetBridgeService(metabotStore(), db, {
    client,
    deriveWalletContext: async () => context(),
    fetchBtcUtxos: async () => [{ txId: '11'.repeat(32), outputIndex: 0, satoshis: 100_000, address: '1TestBtc1111111111111111111111' }],
    fetchMvcUtxos: async () => [{ satoshis: 50_000 } as any],
    listMrc20Assets: async () => [{ mrc20Id: 'mrc-id', balance: { display: '1000' } } as any],
    listMvcFtAssets: async () => [
      { genesis: 'ee'.repeat(32), codeHash: 'dd'.repeat(32), balance: { display: '900' } },
      { genesis: 'gg'.repeat(32), codeHash: 'cc'.repeat(32), balance: { display: '0.001' } },
    ] as any,
    signBtc: async () => ({ txid: '22'.repeat(32), txHex: '', feeSats: 300, outputs: [], spentUtxos: [] }),
    signScenario: async () => ({ scenario: 'btc_mint', sourceTxid: '33'.repeat(32), txHex: 'aa', walletMinerBtcSats: 300, walletMinerMvcSats: 0 }),
    emitJobUpdated: (view) => events.push(view),
    ...(extraDeps as any),
  } as any);
  return { service, db, events };
}

test('octopus client distinguishes unsupported and not_found, and extracts error text', async () => {
  let now = 1_000;
  const calls: string[] = [];
  const client = new OctopusBridgeClient({
    baseUrl: 'https://example.test',
    now: () => now,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return response(JSON.stringify({ message: 'Cannot GET /api-bridge-v3/orderStatus' }), 404);
      return response(JSON.stringify({ message: 'orderId not found' }), 404);
    },
  });
  assert.deepEqual(await client.getOrderStatus('aa'.repeat(32)), { kind: 'unsupported' });
  assert.deepEqual(await client.getOrderStatus('bb'.repeat(32)), { kind: 'unsupported' });
  assert.equal(calls.length, 1, 'unsupported decision is cached for ten minutes');
  now += 10 * 60_000 + 1;
  assert.deepEqual(await client.getOrderStatus('bb'.repeat(32)), { kind: 'not_found' });
  assert.equal(extractOctopusApiErrorMessage('{"msg":"bad amount"}'), 'bad amount');
  assert.equal(extractOctopusApiErrorMessage({ message: ['first', 'second'] }), 'first');
});

test('asset bridge schema is idempotent', async () => {
  const db = await memoryDb();
  ensureAssetBridgeSchema(db);
  ensureAssetBridgeSchema(db);
  const cols = db.exec('PRAGMA table_info(asset_bridge_jobs)')[0].values.map((row) => row[1]);
  assert.ok(cols.includes('job_id'));
  assert.ok(cols.includes('signed_json'));
});

test('quote resolves aliases/units/ETA and composes mint fees and blockers', async () => {
  const client = fakeClient();
  const { service } = await makeService(client);
  const job = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005' });
  assert.equal(job.scenario, 'btc_mint');
  assert.equal(job.symbol, 'BTC');
  assert.equal(job.targetSymbol, 'WBTC');
  assert.equal(job.fees.serviceBtcSats, 1000);
  assert.equal(job.fees.walletMinerBtcSats, 300);
  assert.equal(job.eta.blocks, 1);
  assert.equal(job.blockers.length, 0);

  const low = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.000005' });
  assert.ok(low.blockers.some((item) => item.code === 'below_minimum'));

  const token = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: '$METAID', fromChain: 'btc', amount: '10.12345' });
  assert.equal(token.scenario, 'mrc20_mint');
  assert.ok(token.blockers.some((item) => item.code === 'precision'));
  assert.throws(() => service.resolveScenario(assetList() as any, 'NOPE', 'btc'), /Supported/);
  const redeem = service.resolveScenario(assetList() as any, 'WBTC', 'mvc');
  assert.equal(redeem.scenario, 'btc_redeem');
});

test('mrc20 mint quote dry-runs exact commit/reveal miner fee without broadcast', async () => {
  const calls: any[] = [];
  const { service } = await makeService(fakeClient(), {
    executeMrc20Transfer: async (_store: any, input: any, _deps: any, options: any) => {
      calls.push({ input, options });
      return { commitTxId: '', revealTxId: '', totalFeeSats: 456 };
    },
  });
  const job = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: '$METAID', fromChain: 'btc', amount: '10.1234' });
  assert.equal(job.blockers.length, 0);
  assert.equal(job.fees.walletMinerBtcSats, 456);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.dryRun, true);
  assert.deepEqual(calls[0].options.service, { address: '1FeeAddress111111111111111111111', satoshis: 1000 });
});


test('quote exposes every blocker family with needed-versus-available context', async () => {
  const base = await makeService();
  const tooMuchToken = await base.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'METAID', fromChain: 'btc', amount: '1001' });
  assert.ok(tooMuchToken.blockers.some((item) => item.code === 'insufficient_asset' && /Need 1001, available 1000/.test(item.messageEn)));

  const lowBtc = await makeService(fakeClient(), { fetchBtcUtxos: async () => [{ txId: '11'.repeat(32), outputIndex: 0, satoshis: 100, address: '1TestBtc1111111111111111111111' }] });
  const btcBlocked = await lowBtc.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00001' });
  assert.ok(btcBlocked.blockers.some((item) => item.code === 'insufficient_btc_fee'));

  const lowMvc = await makeService(fakeClient(), { fetchMvcUtxos: async () => [{ satoshis: 1 }] });
  const mvcBlocked = await lowMvc.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'METAID', fromChain: 'mvc', amount: '10' });
  assert.ok(mvcBlocked.blockers.some((item) => item.code === 'insufficient_mvc_fee' && /Need 1500.*available 1/.test(item.messageEn)));

  const high = await base.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '2' });
  assert.ok(high.blockers.some((item) => item.code === 'above_maximum'));

  const poolClient = fakeClient({ feeQuote: async () => feeQuote({ maxSingleMintAmount: '5' }) });
  const pool = await makeService(poolClient);
  const capped = await pool.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'METAID', fromChain: 'btc', amount: '6' });
  assert.ok(capped.blockers.some((item) => item.code === 'pool_cap'));
  assert.equal(capped.poolCapDisplay, '5');

  const disabledList = assetList() as any;
  disabledList.assetList[1].isEnableMint = false;
  const disabledClient = fakeClient({ assetList: async () => disabledList });
  const disabled = await makeService(disabledClient);
  const disabledJob = await disabled.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'METAID', fromChain: 'btc', amount: '1' });
  assert.ok(disabledJob.blockers.some((item) => item.code === 'direction_disabled'));
});

test('redeem quote composes service, bridge miner, and estimated wallet MVC fees', async () => {
  const { service } = await makeService();
  const job = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'METAID', fromChain: 'mvc', amount: '10' });
  assert.equal(job.scenario, 'mrc20_redeem');
  assert.equal(job.fees.serviceBtcSats, 700);
  assert.equal(job.fees.serviceMvcSats, 600);
  assert.equal(job.fees.bridgeMinerBtcSats, 300);
  assert.equal(job.fees.bridgeMinerMvcSats, 300);
  assert.equal(job.fees.walletMinerMvcSats, 600);
  assert.equal(job.fees.walletMinerMvcEstimated, true);
  assert.equal(job.fees.totalMvcSats, 1500);
});

test('confirm success persists signed data before submit and enters bridging', async () => {
  const client = fakeClient();
  const { service, events } = await makeService(client);
  const quote = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005' });
  const result = await service.confirm(quote.jobId);
  assert.equal(result.ok, true);
  assert.equal(result.job?.state, 'bridging');
  assert.equal(client.calls.create, 1);
  assert.equal(client.calls.submit, 1);
  const record = service.getRecord(quote.jobId);
  assert.equal(record?.signedJson?.txHex, 'aa');
  assert.equal(record?.view.sourceTxid, '33'.repeat(32));
  assert.ok(events.some((view) => view.state === 'signing'));
  service.stopPolling();
});

test('confirm success signs and submits every scenario shape', async () => {
  const cases = [
    { asset: 'BTC', fromChain: 'btc' as const, amount: '0.00005', scenario: 'btc_mint', submitKey: 'txHex' },
    { asset: 'METAID', fromChain: 'btc' as const, amount: '10', scenario: 'mrc20_mint', submitKey: 'txHexList' },
    { asset: 'WBTC', fromChain: 'mvc' as const, amount: '0.0001', scenario: 'btc_redeem', submitKey: 'txHexList' },
    { asset: 'METAID', fromChain: 'mvc' as const, amount: '10', scenario: 'mrc20_redeem', submitKey: 'txHexList' },
  ];
  for (const item of cases) {
    const submitted: any[] = [];
    const client = fakeClient({
      submitPrepayOrder: async (_scenario: string, input: any) => { submitted.push(input); return { success: true }; },
    });
    const { service } = await makeService(client, {
      executeMrc20Transfer: async () => ({ commitTxId: '', revealTxId: '', totalFeeSats: 456 }),
      signScenario: async (params: any) => ({
        scenario: params.scenario,
        sourceTxid: '33'.repeat(32),
        txid: params.scenario.includes('redeem') ? '33'.repeat(32) : undefined,
        txHex: 'aa',
        txHexList: ['cc', 'dd'],
        mvcFeeTxHex: 'ee',
        btcFeeTxHex: 'ff',
        walletMinerBtcSats: 300,
        walletMinerMvcSats: 0,
      }),
    });
    const quote = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: item.asset, fromChain: item.fromChain, amount: item.amount });
    assert.equal(quote.scenario, item.scenario);
    assert.equal(quote.blockers.length, 0, `${item.scenario} blockers ${JSON.stringify(quote.blockers)}`);
    const result = await service.confirm(quote.jobId);
    assert.equal(result.ok, true, `${item.scenario}: ${result.error}`);
    assert.equal(result.job?.state, 'bridging');
    assert.equal(result.job?.requiredConfirmations, item.scenario === 'mrc20_mint' ? 3 : 2);
    assert.ok(submitted[0]?.[item.submitKey], `${item.scenario} missing ${item.submitKey}`);
    service.stopPolling();
  }
});


test('confirm fee guard requotes state without signing or submit', async () => {
  const client = fakeClient({
    createPrepayOrder: async () => ({ orderId: 'aa'.repeat(32), bridgeAddress: '1Bridge11111111111111111111', btcFeeSats: 2000, btcFeeAddress: 'x', confirmNumber: 2 }),
  });
  let signed = 0;
  const { service } = await makeService(client, {
    signScenario: async () => { signed += 1; throw new Error('must not sign'); },
  });
  const quote = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005' });
  const result = await service.confirm(quote.jobId);
  assert.equal(result.ok, false);
  assert.equal(result.job?.state, 'quote');
  assert.equal(result.job?.error?.fundsMoved, false);
  assert.equal(signed, 0);
  assert.equal(client.calls.submit, 0);
});

test('submit failure with server sourceTxid resumes as bridging; otherwise fails fundsMoved false', async () => {
  const resumed = fakeClient({
    submitPrepayOrder: async () => { throw new Error('network dropped'); },
    getOrderStatus: async () => ({ kind: 'ok', data: { sourceTxid: '44'.repeat(32) } }),
  });
  const a = await makeService(resumed);
  const q1 = await a.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005' });
  assert.equal((await a.service.confirm(q1.jobId)).job?.state, 'bridging');
  a.service.stopPolling();

  const failed = fakeClient({
    submitPrepayOrder: async () => { throw new Error('rejected'); },
    getOrderStatus: async () => ({ kind: 'ok', data: { sourceTxid: null } }),
  });
  const b = await makeService(failed);
  const q2 = await b.service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005' });
  const result = await b.service.confirm(q2.jobId);
  assert.equal(result.job?.state, 'failed');
  assert.equal(result.job?.error?.fundsMoved, false);
});

test('poller uses wallet confirmations, falls back to list, completes exactly once, and wakes on_complete', async () => {
  let orderCalls = 0;
  const client = fakeClient({
    getOrderStatus: async () => {
      orderCalls += 1;
      return { kind: 'unsupported' };
    },
    queryTransactionsByAddress: async () => [{ originTxid: '33'.repeat(32), status: 'success', targetTxid: '55'.repeat(32) }],
  });
  const notices: string[] = [];
  const wakes: string[] = [];
  const { service } = await makeService(client, {
    getWalletTxStatus: async () => ({ confirmations: 2 }),
    notifyJob: (record: any, target: string) => { notices.push(`${record.view.jobId}:${target}`); },
    wakeOnComplete: (record: any, target: string) => { wakes.push(`${record.view.jobId}:${target}`); },
    resolveNoticeSession: () => 'focused',
  });
  const quote = await service.createQuote({ sessionId: 'origin', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005', onComplete: 'then report it' });
  await service.confirm(quote.jobId);
  const before = service.getRecord(quote.jobId)?.view.lastConfirmationAt;
  await service.pollOnce();
  const done = service.get(quote.jobId);
  assert.equal(done?.state, 'completed');
  assert.equal(done?.targetTxid, '55'.repeat(32));
  assert.equal(done?.confirmations, 2);
  assert.ok((done?.lastConfirmationAt ?? 0) >= (before ?? 0));
  assert.equal(notices.length, 1);
  assert.equal(notices[0], `${quote.jobId}:focused`);
  assert.equal(wakes.length, 1);
  await service.pollOnce();
  assert.equal(notices.length, 1);
  assert.equal(wakes.length, 1);
  service.stopPolling();
});

test('poller adopts server required confirmations and emits only when the view changes', async () => {
  let requiredConfirmations = 2;
  const client = fakeClient({
    getOrderStatus: async () => ({
      kind: 'ok',
      data: {
        status: 'doing',
        stage: 'confirming',
        sourceTxid: '33'.repeat(32),
        sourceConfirmations: 0,
        requiredConfirmations,
        targetTxid: null,
        targetTxids: [],
        failureReason: null,
      },
    }),
  });
  const { service, events } = await makeService(client, {
    getWalletTxStatus: async () => { throw new Error('wallet status unavailable'); },
  });
  const quote = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005' });
  await service.confirm(quote.jobId);
  events.length = 0;
  await service.pollOnce();
  await service.pollOnce();
  assert.equal(events.length, 0, 'unchanged polling ticks must not persist/emit');

  requiredConfirmations = 5;
  await service.pollOnce();
  assert.equal(service.get(quote.jobId)?.requiredConfirmations, 5);
  assert.equal(events.length, 1);
  await service.pollOnce();
  assert.equal(events.length, 1, 'adopting the same value again is not a change');
  service.stopPolling();
});

test('poller uses MVC wallet address for MVC sources and never decreases confirmations', async () => {
  let serverConfirmations = 3;
  let walletResult: any = { confirmed: false, confirmations: 0 };
  const receivers: Array<string | undefined> = [];
  const client = fakeClient({
    getOrderStatus: async () => ({
      kind: 'ok',
      data: {
        status: 'doing',
        stage: 'confirming',
        sourceTxid: '33'.repeat(32),
        sourceConfirmations: serverConfirmations,
        requiredConfirmations: 5,
        targetTxid: null,
        targetTxids: [],
        failureReason: null,
      },
    }),
  });
  const { service } = await makeService(client, {
    getWalletTxStatus: async (_deps: any, input: any) => {
      receivers.push(input.receiver);
      return walletResult;
    },
  });
  const quote = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'WBTC', fromChain: 'mvc', amount: '0.0001' });
  await service.confirm(quote.jobId);
  const record = service.getRecord(quote.jobId)!;
  const mvcAddress = record.view.mvcAddress;

  await service.pollOnce();
  assert.equal(service.get(quote.jobId)?.confirmations, 3);
  assert.ok(receivers.length > 0);
  assert.ok(receivers.every((receiver) => receiver === mvcAddress));

  serverConfirmations = 1;
  walletResult = { confirmed: false, confirmations: 0 };
  await service.pollOnce();
  assert.equal(service.get(quote.jobId)?.confirmations, 3, 'unconfirmed MVC wallet evidence cannot decrease the count');

  walletResult = { confirmed: true };
  await service.pollOnce();
  assert.equal(service.get(quote.jobId)?.confirmations, 3, 'confirmed-without-count is clamped to one but cannot decrease the count');

  walletResult = { confirmed: true, confirmations: 4 };
  await service.pollOnce();
  assert.equal(service.get(quote.jobId)?.confirmations, 4);
  service.stopPolling();
});

test('startup recovery marks interrupted signing rows failed or bridging from order status', async () => {
  const client = fakeClient({ getOrderStatus: async () => ({ kind: 'ok', data: { sourceTxid: null } }) });
  const { service } = await makeService(client);
  const quote = await service.createQuote({ sessionId: 's1', metabotId: 1, asset: 'BTC', fromChain: 'btc', amount: '0.00005' });
  const record = service.getRecord(quote.jobId)!;
  record.view.state = 'signing';
  record.orderJson = { orderId: 'aa'.repeat(32) };
  service.store.update(quote.jobId, { view: record.view, orderJson: record.orderJson });
  await service.recoverStartup();
  assert.equal(service.get(quote.jobId)?.state, 'failed');
  assert.equal(service.get(quote.jobId)?.error?.fundsMoved, false);
  service.stopPolling();
});

function fakeFunding(address: string, value: number, seed: number) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, seed), 0);
  tx.addOutput(bitcoin.address.toOutputScript(address, NETWORK), value);
  return { txid: tx.getId(), rawTx: tx.toHex() };
}

test('signer real SDK builds btc mint outputs bridge+fee+change and audits stranded outputs', async () => {
  const wallet = new BtcWallet({ coinType: CoinType.MVC, addressType: AddressType.SameAsMvc, addressIndex: 0, network: 'livenet', mnemonic: MNEMONIC });
  const address = wallet.getAddress();
  const funding = fakeFunding(address, 100_000, 7);
  const store = { getMetabotWalletByMetabotId: () => ({ mnemonic: MNEMONIC, path: "m/44'/10001'/0'/0/0" }) } as any;
  const ctx = await deriveAssetBridgeWalletContext(store, 1);
  const signed = await signBtcBridgeSend({
    context: ctx,
    outputs: [
      { address, satoshis: 5_000 },
      { address, satoshis: 1_000 },
    ],
    feeRate: 2,
    utxos: [{ txId: funding.txid, outputIndex: 0, satoshis: 100_000, address, rawTx: funding.rawTx }],
  });
  const summary = summarizeRawTx(signed.txHex);
  const values = summary.outputs.map((output) => output.value).sort((a, b) => a - b);
  assert.deepEqual(values.slice(0, 2), [1000, 5000]);
  assert.ok(values.length >= 2);
  assert.ok(signed.feeSats > 0);

  let refused = false;
  for (const sats of Array.from({ length: 4000 }, (_, index) => 6_001 + index)) {
    const smallFunding = fakeFunding(address, sats, 8);
    try {
      await signBtcBridgeSend({
        context: ctx,
        outputs: [
          { address, satoshis: 5_000 },
          { address, satoshis: 1_000 },
        ],
        feeRate: 2,
        utxos: [{ txId: smallFunding.txid, outputIndex: 0, satoshis: sats, address, rawTx: smallFunding.rawTx }],
      });
    } catch (error) {
      if (/cannot be spent under the inscription-carrier rule/.test(String((error as Error).message))) {
        refused = true;
        break;
      }
    }
  }
  assert.equal(refused, true, 'some small-change case must be refused');

  const sweepFunding = fakeFunding(address, 20_000, 9);
  const sweepUtxos = [{ txId: sweepFunding.txid, outputIndex: 0, satoshis: 20_000, address, rawTx: sweepFunding.rawTx }];
  const maxAmount = await calculateBtcMintMaxAmount({
    context: ctx,
    serviceAddress: address,
    serviceSats: 1_000,
    feeRate: 2,
    utxos: sweepUtxos,
  });
  assert.ok(maxAmount > 0);
  const sweep = await signBtcBridgeSend({
    context: ctx,
    outputs: [
      { address, satoshis: maxAmount },
      { address, satoshis: 1_000 },
    ],
    feeRate: 2,
    utxos: sweepUtxos,
  });
  assert.equal(summarizeRawTx(sweep.txHex).outputs.length, 2);
});

test('mrc20 service output reaches sign options and submitSigned replaces direct broadcasts', async () => {
  const store = {} as any;
  const calls: string[] = [];
  let seenService: any = null;
  const result = await executeMrc20Transfer(store, {
    metabotId: 1,
    asset: { mrc20Id: 'mrc-id', decimal: 4, address: 'addr', symbol: 'METAID' },
    toAddress: 'bridge',
    amount: '1.25',
    feeRate: 2,
  }, {
    deriveWalletContext: async () => ({ wallet: {} as any, address: 'addr' }),
    fetchFundingUtxos: async () => [{ txId: '11'.repeat(32), outputIndex: 0, satoshis: 10000 }],
    fetchMrc20Utxos: async () => [{ txId: '22'.repeat(32), outputIndex: 0, mrc20s: [{ amount: '12500' }] }],
    signTransfer: async ({ input }: any) => {
      seenService = input.service;
      return { commitTxHex: 'aa', revealTxHex: 'bb', totalFeeSats: 300 };
    },
    broadcastCommit: async () => { calls.push('commit'); return 'bad'; },
    broadcastReveal: async () => { calls.push('reveal'); return 'bad'; },
    decodeTx: () => { throw new Error('synthetic hex'); },
  } as any, {
    service: { address: 'fee', satoshis: 1000 },
    submitSigned: async () => ({ commitTxId: '33'.repeat(32), revealTxId: '44'.repeat(32) }),
  });
  assert.deepEqual(seenService, { address: 'fee', satoshis: 1000 });
  assert.deepEqual(calls, []);
  assert.equal(result.commitTxId, '33'.repeat(32));
  assert.equal(result.revealTxId, '44'.repeat(32));

  await assert.rejects(
    executeMrc20Transfer(store, {
      metabotId: 1,
      asset: { mrc20Id: 'mrc-id', decimal: 4, address: 'addr', symbol: 'METAID' },
      toAddress: 'bridge',
      amount: '1.25',
      feeRate: 2,
    }, {
      deriveWalletContext: async () => ({ wallet: {} as any, address: 'addr' }),
      fetchFundingUtxos: async () => [{ txId: '11'.repeat(32), outputIndex: 0, satoshis: 10000 }],
      fetchMrc20Utxos: async () => [{ txId: '22'.repeat(32), outputIndex: 0, mrc20s: [{ amount: '12500' }] }],
      signTransfer: async () => ({ commitTxHex: 'aa', revealTxHex: 'bb', totalFeeSats: 300 }),
      broadcastCommit: async () => { calls.push('commit'); return 'bad'; },
      broadcastReveal: async () => { calls.push('reveal'); return 'bad'; },
    } as any, {
      submitSigned: async () => ({ commitTxId: '', revealTxId: '' }),
    }),
    /submitSigned did not return commitTxId and revealTxId/,
  );
  assert.deepEqual(calls, [], 'missing submitSigned txids must not fall back to direct broadcasts');
});


test('real MRC20 commit/reveal signing places the service output in commit', async () => {
  const wallet = new BtcWallet({ coinType: CoinType.MVC, addressType: AddressType.SameAsMvc, addressIndex: 0, network: 'livenet', mnemonic: MNEMONIC });
  const serviceWallet = new BtcWallet({ coinType: CoinType.MVC, addressType: AddressType.SameAsMvc, addressIndex: 1, network: 'livenet', mnemonic: MNEMONIC });
  const address = wallet.getAddress();
  const serviceAddress = serviceWallet.getAddress();
  const funding = fakeFunding(address, 20_000, 11);
  const token = fakeFunding(address, 2_000, 12);
  const store = { getMetabotWalletByMetabotId: () => ({ mnemonic: MNEMONIC, path: "m/44'/10001'/0'/0/0" }) } as any;
  const result = await executeMrc20Transfer(store, {
    metabotId: 1,
    asset: { mrc20Id: 'ab'.repeat(32), decimal: 2, address, symbol: 'T' },
    toAddress: serviceAddress,
    amount: '1',
    feeRate: 2,
  }, {
    fetchFundingUtxos: async () => [{ txId: funding.txid, outputIndex: 0, satoshis: 20_000, address, rawTx: funding.rawTx }],
    fetchMrc20Utxos: async () => [{ txId: token.txid, outputIndex: 0, satoshis: 2_000, address, rawTx: token.rawTx, mrc20s: [{ amount: '1000' }] }],
  } as any, {
    dryRun: true,
    service: { address: serviceAddress, satoshis: 1_000 },
  });
  const commit = bitcoin.Transaction.fromHex(result.commitTxHex);
  const serviceScript = bitcoin.address.toOutputScript(serviceAddress, NETWORK);
  assert.ok(commit.outs.some((output) => output.value === 1_000 && output.script.equals(serviceScript)));
  assert.ok(result.totalFeeSats > 0);

  const reveal = bitcoin.Transaction.fromHex(result.revealTxHex);
  const commitInputIndexes = reveal.ins
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => Buffer.from(input.hash).reverse().toString('hex') === commit.getId())
    .map(({ index }) => index);
  assert.equal(commitInputIndexes.length, 1, 'fixed backend rule: exactly one reveal input spends the commit tx');
  assert.notEqual(commitInputIndexes[0], 0, 'the SDK places the commit input after token inputs and that remains valid');
});

test('asset bridge fences round-trip and reject non-canonical job ids', () => {
  const jobId = 'ab_123e4567-e89b-42d3-a456-426614174000';
  const card = formatAssetBridgeCardFence({ v: 1, jobId, scenario: 'btc_mint', symbol: 'BTC', targetSymbol: 'WBTC', amountDisplay: '0.001', state: 'quote' });
  const body = card.split('\n')[1];
  assert.equal(parseAssetBridgeCardFence(body)?.jobId, jobId);
  assert.equal(parseAssetBridgeCardFence(JSON.stringify({ v: 1, jobId: 'evil', scenario: 'btc_mint', symbol: 'BTC', targetSymbol: 'WBTC', amountDisplay: '1', state: 'quote' })), null);
  const notice = formatAssetBridgeNoticeFence({ v: 1, jobId, status: 'completed', scenario: 'btc_mint', symbol: 'BTC', targetSymbol: 'WBTC', amountDisplay: '0.001', targetChain: 'mvc', durationSec: 12 });
  assert.equal(parseAssetBridgeNoticeFence(notice.split('\n')[1])?.durationSec, 12);

  const captured = recordCapturedNftCardFences([], extractEmittedNftCardFences('asset_bridge_quote', card));
  assert.equal(captured.length, 1);
  assert.equal(selectMissingNftCardFences(captured, ['quote prepared without the fence']).length, 1);
  assert.equal(selectMissingNftCardFences(captured, [card]).length, 0);
});

test('cowork cross-session accepts the asset-bridge pseudo source namespace', () => {
  const sessions = new Map<string, any>([['target-session', { id: 'target-session', sessionType: 'standard' }]]);
  const store = {
    getSession: (id: string) => sessions.get(id) ?? null,
    getSessionMetadata: (id: string) => sessions.get(id) ?? null,
    addMessage: (id: string, message: any) => ({ id: 'm1', timestamp: 1, ...message }),
  } as any;
  const service = new CoworkCrossSessionService(store);
  const result = service.insertUserMessage({
    sourceSessionId: 'asset-bridge:ab_123e4567-e89b-42d3-a456-426614174000',
    targetSessionId: 'target-session',
    message: 'completed; carry out the owner follow-up',
  });
  assert.equal(result.ok, true);
});
