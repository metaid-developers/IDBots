import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  TrafficApiError,
  bindAllLocalBots,
  claimFreeGrant,
  createRechargeOrder,
  ensureTrafficAccount,
  gatewayForPlanCurrency,
  getConfiguredTrafficApiBase,
  getConfiguredTrafficPinMode,
  getFreeGrantCampaignStatus,
  getLocalTrafficAccount,
  getRechargeOrder,
  getTrafficBalance,
  getTrafficLedger,
  getTrafficPricing,
  getTrafficSettingsSnapshot,
  initTrafficAccountService,
  isPackagedApp,
  listLocalTrafficJournal,
  mockConfirmRechargeOrder,
  recordLocalTrafficSpend,
  redeemTrafficCode,
  resetTrafficAccountServiceForTests,
  resolveRechargeGateway,
  resolveSponsorTrafficAccount,
  setTrafficSettingsSnapshot,
} = await import('../dist-electron/main/services/trafficAccountService.js');
const { createMvcSponsorV2Client } = await import('../dist-electron/main/services/mvcSponsorClient.js');
const { runMvcSponsorCreatePin } = await import('../dist-electron/main/services/mvcSponsorCreatePin.js');
const { assembleMvcPinTransaction } = await import('../dist-electron/main/libs/createPinWorker.js');

const IDENTITY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOT1_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const BOT2_MNEMONIC =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const IDENTITY_GMID = 'idq1localidentity';
const COMMIT_TXID = 'aa'.repeat(32);

function deriveAddress(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  return child.publicKey.toAddress(network).toString();
}

const IDENTITY_ADDRESS = deriveAddress(IDENTITY_MNEMONIC);
const BOT1_ADDRESS = deriveAddress(BOT1_MNEMONIC);
const BOT2_ADDRESS = deriveAddress(BOT2_MNEMONIC);
const SERVER_ACCOUNT_ID = 'idq1serverderived';

function verifyMessage(address, message, signature) {
  try {
    return mvc.Message(message).verify(address, signature);
  } catch {
    return false;
  }
}

function envelope(data) {
  return JSON.stringify({ code: 0, message: 'success', data });
}

function httpError(status, body = { code: 1, message: `HTTP ${status}` }) {
  return { __httpStatus: status, __body: body };
}

function createFetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, init });
    for (const [suffix, responder] of routes) {
      if (text.includes(suffix)) {
        const body = await (typeof responder === 'function' ? responder(init) : responder);
        if (body && typeof body === 'object' && typeof body.__httpStatus === 'number') {
          return { ok: false, status: body.__httpStatus, json: async () => body.__body };
        }
        const raw = typeof body === 'string'
          ? body
          : body && typeof body === 'object' && 'code' in body
            ? JSON.stringify(body)
            : envelope(body);
        return { ok: true, status: 200, json: async () => JSON.parse(raw) };
      }
    }
    return { ok: false, status: 404, json: async () => ({ code: 1, message: 'not found' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function callsTo(fetchImpl, suffix) {
  return fetchImpl.calls.filter((call) => call.url.includes(suffix));
}

function callsToPath(fetchImpl, pathName) {
  return fetchImpl.calls.filter((call) => new URL(call.url).pathname === pathName);
}

function accountPayload(overrides = {}) {
  return {
    accountId: SERVER_ACCOUNT_ID,
    identityAddress: IDENTITY_ADDRESS,
    balanceBytes: 1000,
    reservedBytes: 0,
    grantedBytesTotal: 1000,
    spentBytesTotal: 0,
    status: 1,
    ...overrides,
  };
}

async function makeServiceFixture(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-traffic-test-'));
  const store = await SqliteStore.create(dir);
  if (options.trafficMode) {
    store.set('traffic.mode', options.trafficMode);
  }
  const bots = options.bots ?? [
    { address: BOT1_ADDRESS, mnemonic: BOT1_MNEMONIC, walletId: 11 },
    { address: BOT2_ADDRESS, mnemonic: BOT2_MNEMONIC, walletId: 12 },
  ];
  const fakeMetabotStore = {
    listMetabots: () => bots.map((bot) => ({ mvc_address: bot.address, wallet_id: bot.walletId })),
    getMetabotWalletById: (walletId) => {
      const bot = bots.find((item) => item.walletId === walletId);
      return bot ? { id: bot.walletId, mnemonic: bot.mnemonic, path: WALLET_PATH } : null;
    },
  };
  const fakeIdentityStore = {
    get: () => ({
      id: 1,
      mnemonic: IDENTITY_MNEMONIC,
      path: WALLET_PATH,
      mvc_address: IDENTITY_ADDRESS,
      globalmetaid: IDENTITY_GMID,
      name: 'Owner',
    }),
  };
  resetTrafficAccountServiceForTests();
  initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => fakeMetabotStore,
    getUserIdentityStore: () => fakeIdentityStore,
    fetchImpl: options.fetchImpl,
    baseUrl: 'https://traffic.test',
  });
  return { store, dir };
}

test('ensureTrafficAccount coalesces concurrent first-run creates into one POST', async () => {
  let createCount = 0;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', async () => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return accountPayload();
    }],
  ]);
  await makeServiceFixture({ fetchImpl });

  const [first, second] = await Promise.all([ensureTrafficAccount(), ensureTrafficAccount()]);
  assert.equal(first.accountId, SERVER_ACCOUNT_ID);
  assert.equal(second.accountId, SERVER_ACCOUNT_ID);
  assert.equal(createCount, 1);
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
});

test('ensureTrafficAccount signs the canonical message and persists the server-returned accountId', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', (init) => {
      captured = { headers: init.headers, body: JSON.parse(init.body) };
      return accountPayload();
    }],
  ]);
  await makeServiceFixture({ fetchImpl });

  const account = await ensureTrafficAccount();
  assert.equal(account.accountId, SERVER_ACCOUNT_ID);
  assert.equal(getLocalTrafficAccount().accountId, SERVER_ACCOUNT_ID);

  assert.ok(captured);
  assert.deepEqual(captured.body, { accountId: IDENTITY_GMID });
  assert.equal(captured.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const timestamp = Number(captured.headers['X-Timestamp']);
  assert.ok(Number.isInteger(timestamp) && timestamp > 0);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-account:${IDENTITY_GMID}:${timestamp}`,
      captured.headers['X-Signature'],
    ),
    'X-Signature must verify against traffic-account:<accountId>:<ts>',
  );
});

test('bindAllLocalBots binds bots + identity, reports conflicts, and stays idempotent', async () => {
  const bindBodies = new Map();
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      bindBodies.set(body.botAddress, { body, headers: init.headers });
      if (body.botAddress === BOT2_ADDRESS) {
        return { code: 1, message: 'traffic address already bound to another account' };
      }
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  const summary = await bindAllLocalBots();
  assert.equal(summary.accountId, SERVER_ACCOUNT_ID);
  assert.equal(summary.boundCount, 2);
  assert.equal(summary.conflictCount, 1);
  assert.equal(summary.failedCount, 0);
  assert.deepEqual(
    summary.results.find((item) => item.botAddress === BOT2_ADDRESS).status,
    'conflict',
  );

  const bot1Bind = bindBodies.get(BOT1_ADDRESS);
  assert.ok(bot1Bind);
  const parts = bot1Bind.body.bindMessage.split(':');
  assert.equal(parts[0], 'traffic-bind');
  assert.equal(parts[1], BOT1_ADDRESS);
  assert.equal(parts[2], SERVER_ACCOUNT_ID);
  const bindTs = Number(parts[3]);
  assert.equal(Number(bot1Bind.headers['X-Timestamp']), bindTs);
  assert.ok(verifyMessage(BOT1_ADDRESS, bot1Bind.body.bindMessage, bot1Bind.body.botSignature));
  assert.ok(verifyMessage(IDENTITY_ADDRESS, bot1Bind.body.bindMessage, bot1Bind.headers['X-Signature']));

  // Identity address is bound too, signed by the identity key on both sides.
  const identityBind = bindBodies.get(IDENTITY_ADDRESS);
  assert.ok(identityBind);
  assert.ok(verifyMessage(IDENTITY_ADDRESS, identityBind.body.bindMessage, identityBind.body.botSignature));

  // Re-run: same-account rebinds succeed, the conflict stays a conflict; nothing throws.
  const again = await bindAllLocalBots();
  assert.equal(again.boundCount, 2);
  assert.equal(again.conflictCount, 1);
});

test('getTrafficBalance caches for the TTL and local spends adjust the cache', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', { botAddress: BOT1_ADDRESS, accountId: SERVER_ACCOUNT_ID, status: 1 }],
    ['/v1/traffic/accounts', (init) => {
      if (String(init.method) === 'GET') {
        return accountPayload({ balanceBytes: 650, spentBytesTotal: 350 });
      }
      return accountPayload();
    }],
  ]);
  const { store } = await makeServiceFixture({ fetchImpl });

  await ensureTrafficAccount();
  const first = await getTrafficBalance();
  assert.equal(first.balanceBytes, 1000);
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 0);

  recordLocalTrafficSpend({
    txId: COMMIT_TXID,
    botAddress: BOT1_ADDRESS,
    orderId: 'order-1',
    txSize: 300,
    sponsoredMinerFee: 300,
    savedFee: 300,
    billedBy: 'traffic',
  });
  const afterSpend = await getTrafficBalance();
  assert.equal(afterSpend.balanceBytes, 700);
  assert.equal(afterSpend.spentBytesTotal, 300);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 0);

  // Quota-billed spends never touch the traffic balance cache.
  recordLocalTrafficSpend({ txId: 'bb'.repeat(32), botAddress: BOT1_ADDRESS, txSize: 100, billedBy: 'quota' });
  assert.equal((await getTrafficBalance()).balanceBytes, 700);

  const refreshed = await getTrafficBalance({ forceRefresh: true });
  assert.equal(refreshed.balanceBytes, 650);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 1);
  void store;
});

test('local spend journal writes and lists entries', async () => {
  await makeServiceFixture({ fetchImpl: createFetchStub([]) });

  recordLocalTrafficSpend({
    txId: COMMIT_TXID,
    botAddress: BOT1_ADDRESS,
    orderId: 'order-1',
    txSize: 300,
    sponsoredMinerFee: 100,
    savedFee: 100,
    billedBy: 'traffic',
  });
  recordLocalTrafficSpend({
    txId: 'cc'.repeat(32),
    botAddress: BOT2_ADDRESS,
    orderId: 'order-2',
    txSize: 250,
    sponsoredMinerFee: 90,
    savedFee: 90,
    billedBy: 'quota',
  });

  const all = listLocalTrafficJournal();
  assert.equal(all.length, 2);
  assert.equal(all[0].txId, 'cc'.repeat(32));
  assert.equal(all[0].billedBy, 'quota');
  assert.equal(all[1].txId, COMMIT_TXID);
  assert.equal(all[1].orderId, 'order-1');
  assert.equal(all[1].txSize, 300);
  assert.equal(all[1].billedBy, 'traffic');
  assert.ok(all[1].createdAt > 0);

  const filtered = listLocalTrafficJournal({ botAddress: BOT2_ADDRESS });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].botAddress, BOT2_ADDRESS);
});

test('resolveSponsorTrafficAccount stays undefined unless traffic mode is on', async () => {
  const fetchImpl = createFetchStub([['/v1/traffic/accounts', accountPayload()]]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'selfpay' });

  const result = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-1',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.equal(result, undefined);
  assert.equal(fetchImpl.calls.length, 0);
});

test('resolveSponsorTrafficAccount lazily ensures + binds and signs traffic-pre', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const first = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-1',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.ok(first);
  assert.equal(first.accountId, SERVER_ACCOUNT_ID);
  assert.ok(Number.isInteger(first.timestamp) && first.timestamp > 0);
  assert.ok(
    verifyMessage(IDENTITY_ADDRESS, `traffic-pre:${SERVER_ACCOUNT_ID}:challenge-1`, first.authSignature),
    'authSignature must verify against traffic-pre:<accountId>:<challengeId>',
  );
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts/bindings').length, 1);

  // Second call: account + binding are cached locally, no more HTTP.
  const second = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-2',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.ok(second);
  assert.ok(verifyMessage(IDENTITY_ADDRESS, `traffic-pre:${SERVER_ACCOUNT_ID}:challenge-2`, second.authSignature));
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts/bindings').length, 1);
});

test('resolveSponsorTrafficAccount degrades to undefined on backend 404 (feature off)', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', httpError(404, { code: 1, message: 'traffic disabled' })],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const result = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-1',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.equal(result, undefined);

  await assert.rejects(ensureTrafficAccount(), (error) => {
    assert.ok(error instanceof TrafficApiError);
    assert.equal(error.featureUnavailable, true);
    return true;
  });
});

function buildSponsorDraft(botAddress) {
  const utxo = { txId: '11'.repeat(32), outputIndex: 0, satoshis: 50000, address: botAddress, height: 1 };
  const addressObj = new mvc.Address(botAddress, mvc.Networks.livenet);
  const opReturnParts = ['metaid', 'create', '/test/traffic', '0', '1.0', 'text/plain;utf-8', Buffer.from('traffic e2e')];
  const assembled = assembleMvcPinTransaction({
    addressObj,
    opReturnParts,
    usableUtxos: [utxo],
    feeRate: 1,
    estimatedTxSizeWithoutInputs: 200,
    excludedOutpoints: new Set(),
    preferredOutpoints: new Set(),
    deductMinerFeeFromChange: false,
  });
  const outputs = assembled.txComposer.tx.outputs;
  const changeSatoshis = Number(outputs[outputs.length - 1]?.satoshis);
  return {
    txids: [],
    pinId: '',
    totalCost: 0,
    spentOutpoints: [`${utxo.txId}:0`],
    changeUtxo: null,
    draft: {
      unsignedTxHex: assembled.txComposer.getRawHex(),
      estimatedTxSize: 200 + 2 * 148,
      feeRate: 1,
      userInputs: [utxo],
      changeOutput: outputs.length > 1 && changeSatoshis >= 600
        ? { outputIndex: outputs.length - 1, satoshis: changeSatoshis }
        : null,
    },
  };
}

function sponsorRoutes(draftResult, preCapture) {
  return [
    ['/v2/assist/gas/address/info', {
      exists: true,
      balance: 5000,
      grantedAmount: 5000,
      reservedAmount: 0,
      spentAmount: 0,
      availableAmount: 5000,
      status: 'active',
    }],
    ['/v2/assist/gas/mvc/challenge', { challengeId: 'challenge-1', message: 'sign this message' }],
    ['/v2/assist/gas/mvc/pre', (init) => {
      if (preCapture) preCapture(JSON.parse(init.body));
      return {
        preparedTxHex: draftResult.draft.unsignedTxHex,
        orderId: 'order-1',
        minerFee: 100,
        userInputIndexes: [0],
      };
    }],
    ['/v2/assist/gas/mvc/commit', { txId: COMMIT_TXID, txSize: 300, minerFee: 100 }],
  ];
}

function runSponsoredPin(fetchImpl, extraInput = {}) {
  const draftResult = buildSponsorDraft(BOT1_ADDRESS);
  return runMvcSponsorCreatePin(
    {
      metabotId: 9201,
      mnemonic: BOT1_MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: BOT1_ADDRESS,
      feeRate: 1,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
      ...extraInput,
    },
    {
      runDraftWorker: async () => draftResult,
      runBroadcastWorker: async () => {
        throw new Error('broadcast fallback must not run in this test');
      },
      recordSpentOutpoints: () => {},
      replacePendingFundingUtxos: () => {},
      resolveTrafficAccount: ({ challengeId }) => resolveSponsorTrafficAccount({
        botAddress: BOT1_ADDRESS,
        challengeId,
        botMnemonic: BOT1_MNEMONIC,
        botWalletPath: WALLET_PATH,
      }),
    },
  );
}

test('sponsored createPin injects a verifiable trafficAccount into pre when traffic mode is on', async () => {
  let preBody = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
    ...sponsorRoutes(buildSponsorDraft(BOT1_ADDRESS), (body) => { preBody = body; }),
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const result = await runSponsoredPin(fetchImpl);
  assert.equal(result.feeAssist.used, true);
  assert.equal(result.pinId, `${COMMIT_TXID}i0`);

  assert.ok(preBody);
  assert.ok(preBody.trafficAccount);
  assert.equal(preBody.trafficAccount.accountId, SERVER_ACCOUNT_ID);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-pre:${SERVER_ACCOUNT_ID}:challenge-1`,
      preBody.trafficAccount.authSignature,
    ),
  );

  // Journal + balance cache reflect the traffic-billed spend.
  const journal = listLocalTrafficJournal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].billedBy, 'traffic');
  assert.equal(journal[0].txSize, 300);
  assert.equal((await getTrafficBalance()).balanceBytes, 700);
});

test('sponsored createPin omits trafficAccount when the traffic API is 404 (legacy quota path)', async () => {
  let preBody = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', httpError(404, { code: 1, message: 'traffic disabled' })],
    ...sponsorRoutes(buildSponsorDraft(BOT1_ADDRESS), (body) => { preBody = body; }),
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const result = await runSponsoredPin(fetchImpl);
  assert.equal(result.feeAssist.used, true);
  assert.ok(preBody);
  assert.ok(!('trafficAccount' in preBody));

  const journal = listLocalTrafficJournal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].billedBy, 'quota');
});

test('getTrafficPricing normalizes the public rate table', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/pricing', [
      { planId: 'cny_10_100mb', chain: 'mvc', payCurrency: 'CNY', payAmount: 10, trafficBytes: 100000000, status: 1, remark: 'seed' },
      { plan_id: 'cny_20_250mb', chain: 'mvc', pay_currency: 'CNY', pay_amount: 20, traffic_bytes: 250000000 },
    ]],
  ]);
  await makeServiceFixture({ fetchImpl });

  const plans = await getTrafficPricing();
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0], {
    planId: 'cny_10_100mb',
    chain: 'mvc',
    payCurrency: 'CNY',
    payAmount: 10,
    trafficBytes: 100000000,
    status: 1,
    remark: 'seed',
  });
  assert.equal(plans[1].planId, 'cny_20_250mb');
  assert.equal(plans[1].trafficBytes, 250000000);
});

test('createRechargeOrder signs traffic-recharge and parses the order (default paypal gateway)', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/recharge/orders', (init) => {
      captured = { headers: init.headers, body: JSON.parse(init.body) };
      return {
        orderId: 'recharge-order-1',
        payAmount: 10,
        payCurrency: 'CNY',
        trafficBytes: 100000000,
        gatewayParams: {
          approvalUrl: 'https://www.paypal.com/checkoutnow?token=PAYPAL-TOKEN-0',
          paypalOrderId: 'PAYPAL-TOKEN-0',
        },
      };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  const order = await createRechargeOrder('cny_10_100mb');
  assert.equal(order.orderId, 'recharge-order-1');
  assert.equal(order.trafficBytes, 100000000);
  assert.deepEqual(order.gatewayParams, {
    approvalUrl: 'https://www.paypal.com/checkoutnow?token=PAYPAL-TOKEN-0',
    paypalOrderId: 'PAYPAL-TOKEN-0',
  });

  assert.ok(captured);
  assert.deepEqual(captured.body, { planId: 'cny_10_100mb', gateway: 'paypal' });
  const timestamp = Number(captured.headers['X-Timestamp']);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-recharge:${SERVER_ACCOUNT_ID}:cny_10_100mb:${timestamp}`,
      captured.headers['X-Signature'],
    ),
  );
});

test('createRechargeOrder sends an explicit paypal gateway and keeps the approval URL', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/recharge/orders', (init) => {
      captured = { body: JSON.parse(init.body) };
      return {
        orderId: 'recharge-order-paypal',
        payAmount: 10,
        payCurrency: 'USD',
        trafficBytes: 1000000000,
        gatewayParams: {
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-TOKEN-1',
          paypalOrderId: 'PAYPAL-TOKEN-1',
        },
      };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  const order = await createRechargeOrder('usd_10_1gb', 'paypal');
  assert.equal(order.orderId, 'recharge-order-paypal');
  assert.equal(order.payCurrency, 'USD');
  assert.equal(order.gatewayParams.approvalUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-TOKEN-1');
  assert.deepEqual(captured.body, { planId: 'usd_10_1gb', gateway: 'paypal' });
});

test('createRechargeOrder rejects an unsupported gateway before any HTTP call', async () => {
  const fetchImpl = createFetchStub([]);
  await makeServiceFixture({ fetchImpl });

  await assert.rejects(
    () => createRechargeOrder('cny_10_100mb', 'stripe'),
    (error) => error instanceof TrafficApiError && /Unsupported recharge gateway/.test(error.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('resolveRechargeGateway defaults to paypal outside packaged Electron', () => {
  assert.equal(resolveRechargeGateway(), 'paypal');
});

test('isPackagedApp reads as unpackaged outside Electron', () => {
  assert.equal(isPackagedApp(), false);
});

test('resolveRechargeGateway honors the kvStore override in non-packaged builds only', async () => {
  const { store } = await makeServiceFixture({ fetchImpl: createFetchStub([]) });
  assert.equal(resolveRechargeGateway(), 'paypal');

  const saved = setTrafficSettingsSnapshot({ rechargeGateway: 'mock' });
  assert.equal(saved.rechargeGateway, 'mock');
  assert.equal(getTrafficSettingsSnapshot().rechargeGateway, 'mock');
  assert.equal(resolveRechargeGateway(), 'mock');

  setTrafficSettingsSnapshot({ rechargeGateway: '' });
  assert.equal(resolveRechargeGateway(), 'paypal');

  // An invalid stored value degrades to the default; an invalid write is rejected.
  store.set('traffic.rechargeGateway', 'bogus');
  assert.equal(resolveRechargeGateway(), 'paypal');
  assert.throws(() => setTrafficSettingsSnapshot({ rechargeGateway: 'stripe' }), /rechargeGateway/);
});

test('gatewayForPlanCurrency maps CNY plans to alipay and everything else to paypal', async () => {
  assert.equal(gatewayForPlanCurrency('CNY'), 'alipay');
  assert.equal(gatewayForPlanCurrency('cny'), 'alipay');
  assert.equal(gatewayForPlanCurrency('USD'), 'paypal');
  assert.equal(gatewayForPlanCurrency('EUR'), 'paypal');
  assert.equal(gatewayForPlanCurrency(''), 'paypal');
});

test('resolveRechargeGateway honors an explicit preferred gateway and rejects unknown ones', async () => {
  await makeServiceFixture({ fetchImpl: createFetchStub([]) });
  assert.equal(resolveRechargeGateway('alipay'), 'alipay');
  assert.equal(resolveRechargeGateway('paypal'), 'paypal');
  assert.throws(() => resolveRechargeGateway('stripe'), /Unsupported recharge gateway/);
});

test('resolveRechargeGateway lets the dev override win over the preferred gateway', async () => {
  await makeServiceFixture({ fetchImpl: createFetchStub([]) });
  setTrafficSettingsSnapshot({ rechargeGateway: 'mock' });
  assert.equal(resolveRechargeGateway('alipay'), 'mock');
  setTrafficSettingsSnapshot({ rechargeGateway: '' });
  assert.equal(resolveRechargeGateway('alipay'), 'alipay');
});

test('createRechargeOrder sends an explicit alipay gateway and keeps the QR payload', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/recharge/orders', (init) => {
      captured = { body: JSON.parse(init.body) };
      return {
        orderId: 'recharge-order-alipay',
        payAmount: 10,
        payCurrency: 'CNY',
        trafficBytes: 100000000,
        gatewayParams: { qrCode: 'https://qr.alipay.com/bax00000demo' },
      };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  const order = await createRechargeOrder('cny_10_100mb', 'alipay');
  assert.equal(order.orderId, 'recharge-order-alipay');
  assert.equal(order.payCurrency, 'CNY');
  assert.equal(order.gatewayParams.qrCode, 'https://qr.alipay.com/bax00000demo');
  assert.deepEqual(captured.body, { planId: 'cny_10_100mb', gateway: 'alipay' });
});

test('mockConfirmRechargeOrder signs traffic-recharge-confirm and invalidates the balance cache', async () => {
  const confirmCalls = [];
  const fetchImpl = createFetchStub([
    ['/v1/traffic/recharge/orders/', (init) => {
      if (String(init.method) === 'POST' && init.body) {
        confirmCalls.push({ headers: init.headers, body: JSON.parse(init.body), url: '' });
        return { orderId: 'recharge-order-1', status: 3, paidAt: 1, creditedAt: 2 };
      }
      return { orderId: 'recharge-order-1', status: 1 };
    }],
    ['/v1/traffic/accounts', (init) => (
      String(init.method) === 'GET' ? accountPayload({ balanceBytes: 101000000 }) : accountPayload()
    )],
  ]);
  await makeServiceFixture({ fetchImpl });

  // Prime the cache via ensure (balance 1000), then credit and confirm the next
  // balance read refetches from the backend.
  await ensureTrafficAccount();
  const status = await mockConfirmRechargeOrder('recharge-order-1');
  assert.equal(status.status, 3);
  assert.equal(status.creditedAt, 2);

  assert.equal(confirmCalls.length, 1);
  const confirmBody = confirmCalls[0].body;
  assert.deepEqual(confirmBody, { gatewayTxnId: 'mock-recharge-order-1' });
  const confirmTs = Number(confirmCalls[0].headers['X-Timestamp']);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-recharge-confirm:recharge-order-1:mock-recharge-order-1:${confirmTs}`,
      confirmCalls[0].headers['X-Signature'],
    ),
  );

  const balance = await getTrafficBalance();
  assert.equal(balance.balanceBytes, 101000000);

  const polled = await getRechargeOrder('recharge-order-1');
  assert.equal(polled.orderId, 'recharge-order-1');
  assert.equal(polled.status, 1);
});

test('getFreeGrantCampaignStatus signs the canonical message and parses the campaign state', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/campaign/free-grant/status', (init) => {
      captured = { headers: init.headers };
      return { enabled: true, grantBytes: 10000000, claimed: false, claimable: true };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  const status = await getFreeGrantCampaignStatus();
  assert.deepEqual(status, { enabled: true, grantBytes: 10000000, claimed: false, claimable: true });

  assert.ok(captured);
  assert.equal(captured.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const timestamp = Number(captured.headers['X-Timestamp']);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-free-grant-status:${SERVER_ACCOUNT_ID}:${timestamp}`,
      captured.headers['X-Signature'],
    ),
    'X-Signature must verify against traffic-free-grant-status:<accountId>:<ts>',
  );
});

test('claimFreeGrant signs traffic-free-grant-claim, sends idbots client, and invalidates the balance cache', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/campaign/free-grant/claim', (init) => {
      captured = { headers: init.headers, body: JSON.parse(init.body) };
      return { grantId: 1, grantBytes: 10000000, balanceAfter: 10001000 };
    }],
    ['/v1/traffic/accounts', (init) => (
      String(init.method) === 'GET' ? accountPayload({ balanceBytes: 10001000 }) : accountPayload()
    )],
  ]);
  await makeServiceFixture({ fetchImpl });

  // Prime the cache via ensure (balance 1000), then claim and confirm the next
  // balance read refetches from the backend.
  await ensureTrafficAccount();
  const claim = await claimFreeGrant();
  assert.deepEqual(claim, { grantId: 1, grantBytes: 10000000, balanceAfter: 10001000 });

  assert.ok(captured);
  assert.equal(captured.body.clientApp, 'idbots');
  assert.equal(captured.body.clientVersion, 'dev'); // electron unavailable in plain node
  const timestamp = Number(captured.headers['X-Timestamp']);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-free-grant-claim:${SERVER_ACCOUNT_ID}:${timestamp}`,
      captured.headers['X-Signature'],
    ),
    'X-Signature must verify against traffic-free-grant-claim:<accountId>:<ts>',
  );

  const balance = await getTrafficBalance();
  assert.equal(balance.balanceBytes, 10001000);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 1);
});

test('claimFreeGrant surfaces the backend data.errorCode (ALREADY_CLAIMED)', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/campaign/free-grant/claim', { code: 1, message: 'already claimed', data: { errorCode: 'ALREADY_CLAIMED' } }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  await assert.rejects(claimFreeGrant(), (error) => {
    assert.ok(error instanceof TrafficApiError);
    assert.equal(error.errorCode, 'ALREADY_CLAIMED');
    assert.equal(error.stage, 'campaign');
    return true;
  });
});

test('redeemTrafficCode normalizes the code, signs traffic-redeem-code, and invalidates the balance cache', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/redeem-code', (init) => {
      captured = { headers: init.headers, body: JSON.parse(init.body) };
      return { codeId: 7, trafficBytes: 100000000, balanceAfter: 101000000 };
    }],
    ['/v1/traffic/accounts', (init) => (
      String(init.method) === 'GET' ? accountPayload({ balanceBytes: 101000000 }) : accountPayload()
    )],
  ]);
  await makeServiceFixture({ fetchImpl });

  await ensureTrafficAccount();
  const result = await redeemTrafficCode('idb-abcd-efgh-jklm');
  assert.deepEqual(result, { codeId: 7, trafficBytes: 100000000, balanceAfter: 101000000 });

  assert.ok(captured);
  assert.deepEqual(captured.body, { code: 'IDB-ABCD-EFGH-JKLM' });
  const timestamp = Number(captured.headers['X-Timestamp']);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-redeem-code:${SERVER_ACCOUNT_ID}:${timestamp}`,
      captured.headers['X-Signature'],
    ),
    'X-Signature must verify against traffic-redeem-code:<accountId>:<ts>',
  );

  const balance = await getTrafficBalance();
  assert.equal(balance.balanceBytes, 101000000);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 1);
});

test('redeemTrafficCode surfaces the backend data.errorCode (CODE_USED) and rejects empty codes', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/redeem-code', { code: 1, message: 'code already used', data: { errorCode: 'CODE_USED' } }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  await assert.rejects(redeemTrafficCode('IDB-USED-CODE-0000'), (error) => {
    assert.ok(error instanceof TrafficApiError);
    assert.equal(error.errorCode, 'CODE_USED');
    assert.equal(error.stage, 'redeem');
    return true;
  });

  await assert.rejects(redeemTrafficCode('   '), (error) => {
    assert.ok(error instanceof TrafficApiError);
    assert.equal(error.stage, 'redeem');
    return true;
  });
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/redeem-code').length, 1);
});

test('traffic settings snapshot round-trips through the kv store', async () => {
  const { store } = await makeServiceFixture({ fetchImpl: createFetchStub([]) });

  assert.deepEqual(getTrafficSettingsSnapshot(), { mode: 'traffic', fallbackPolicy: 'selfpay', apiBase: '', rechargeGateway: '' });
  setTrafficSettingsSnapshot({ mode: 'selfpay' });
  assert.deepEqual(getTrafficSettingsSnapshot(), { mode: 'selfpay', fallbackPolicy: 'selfpay', apiBase: '', rechargeGateway: '' });
  setTrafficSettingsSnapshot({ mode: 'traffic' });
  assert.deepEqual(getTrafficSettingsSnapshot(), { mode: 'traffic', fallbackPolicy: 'selfpay', apiBase: '', rechargeGateway: '' });
  assert.equal(store.get('traffic.mode'), 'traffic');
  // Strict is no longer a user-facing option; writes always fall back to self-pay.
  setTrafficSettingsSnapshot({ fallbackPolicy: 'strict' });
  assert.deepEqual(getTrafficSettingsSnapshot(), { mode: 'traffic', fallbackPolicy: 'selfpay', apiBase: '', rechargeGateway: '' });
  // Garbage input normalizes back to the account-quota default.
  setTrafficSettingsSnapshot({ mode: 'garbage' });
  assert.deepEqual(getTrafficSettingsSnapshot(), { mode: 'traffic', fallbackPolicy: 'selfpay', apiBase: '', rechargeGateway: '' });
});

test('traffic apiBase setting: set/get/validate/clear, and sponsor client wiring', async () => {
  const { store } = await makeServiceFixture({ fetchImpl: createFetchStub([]) });

  // Unset -> undefined (clients fall back to their own production default).
  assert.equal(getConfiguredTrafficApiBase(), undefined);
  assert.equal(getTrafficSettingsSnapshot().apiBase, '');

  // Valid URL is normalized (trailing slashes stripped) and persisted.
  setTrafficSettingsSnapshot({ apiBase: 'http://47.76.58.120:7882/' });
  assert.equal(getTrafficSettingsSnapshot().apiBase, 'http://47.76.58.120:7882');
  assert.equal(getConfiguredTrafficApiBase(), 'http://47.76.58.120:7882');
  assert.equal(store.get('traffic.apiBase'), 'http://47.76.58.120:7882');

  // The metaidCore/metaFileUploadService wiring contract: explicit arg wins,
  // otherwise the kv override reaches the sponsor client.
  const wired = createMvcSponsorV2Client({ baseUrl: getConfiguredTrafficApiBase() });
  assert.equal(wired.baseUrl, 'http://47.76.58.120:7882');
  const explicit = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test' });
  assert.equal(explicit.baseUrl, 'https://sponsor.test');

  // Invalid values throw and are never persisted.
  assert.throws(() => setTrafficSettingsSnapshot({ apiBase: 'not-a-url' }), /valid URL/);
  assert.throws(() => setTrafficSettingsSnapshot({ apiBase: 'ftp://example.com' }), /http or https/);
  assert.equal(getTrafficSettingsSnapshot().apiBase, 'http://47.76.58.120:7882');

  // Empty string clears the override; the client default kicks back in.
  setTrafficSettingsSnapshot({ apiBase: '' });
  assert.equal(getTrafficSettingsSnapshot().apiBase, '');
  assert.equal(getConfiguredTrafficApiBase(), undefined);
  const fallback = createMvcSponsorV2Client({ baseUrl: getConfiguredTrafficApiBase() });
  assert.equal(fallback.baseUrl, 'https://www.metaso.network/assist-open-api');
});

test('traffic service HTTP honors the kv apiBase when no explicit baseUrl is injected', async () => {
  const kvHost = 'https://kv-configured.test';
  const fetchImpl = createFetchStub([
    ['/v1/traffic/pricing', [{ planId: 'p1', chain: 'mvc', payCurrency: 'CNY', payAmount: 1, trafficBytes: 1048576 }]],
  ]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-traffic-apibase-'));
  const store = await SqliteStore.create(dir);
  store.set('traffic.apiBase', kvHost);
  resetTrafficAccountServiceForTests();
  initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => ({ listMetabots: () => [], getMetabotWalletById: () => null }),
    getUserIdentityStore: () => ({ get: () => null }),
    fetchImpl,
    // note: no baseUrl dep — the kv override must drive the request host
  });

  const plans = await getTrafficPricing();
  assert.equal(plans.length, 1);
  assert.ok(fetchImpl.calls[0].url.startsWith(kvHost));

  // Clear the override -> requests fall back to the production default host.
  store.set('traffic.apiBase', '');
  resetTrafficAccountServiceForTests();
  initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => ({ listMetabots: () => [], getMetabotWalletById: () => null }),
    getUserIdentityStore: () => ({ get: () => null }),
    fetchImpl,
  });
  await getTrafficPricing();
  assert.ok(fetchImpl.calls[1].url.startsWith('https://www.metaso.network/assist-open-api'));
});

test('journal kind column migrates old tables idempotently and round-trips', async () => {
  const { store } = await makeServiceFixture({ fetchImpl: createFetchStub([]) });

  // Simulate a pre-kind database: the old schema without the kind column,
  // plus one legacy row written before the upgrade.
  store.getDatabase().run(`
    CREATE TABLE traffic_spend_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id TEXT NOT NULL,
      bot_address TEXT NOT NULL,
      order_id TEXT NOT NULL DEFAULT '',
      tx_size INTEGER NOT NULL DEFAULT 0,
      sponsored_miner_fee INTEGER NOT NULL DEFAULT 0,
      saved_fee INTEGER NOT NULL DEFAULT 0,
      billed_by TEXT NOT NULL DEFAULT 'quota',
      created_at INTEGER NOT NULL
    );
  `);
  store.getDatabase().run(
    `INSERT INTO traffic_spend_journal
      (tx_id, bot_address, order_id, tx_size, sponsored_miner_fee, saved_fee, billed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['ee'.repeat(32), BOT1_ADDRESS, 'order-legacy', 200, 80, 80, 'traffic', 1700000000000],
  );

  // First write after the upgrade ALTERs the old table; the second write
  // proves the migration guard is idempotent.
  recordLocalTrafficSpend({
    txId: COMMIT_TXID,
    botAddress: BOT1_ADDRESS,
    orderId: 'order-new',
    txSize: 300,
    billedBy: 'traffic',
    kind: '/protocols/simplemsg',
  });
  recordLocalTrafficSpend({
    txId: 'ff'.repeat(32),
    botAddress: BOT2_ADDRESS,
    orderId: 'order-new-2',
    txSize: 100,
    billedBy: 'quota',
  });

  const all = listLocalTrafficJournal();
  assert.equal(all.length, 3);
  const byOrder = new Map(all.map((entry) => [entry.orderId, entry]));
  assert.equal(byOrder.get('order-new').kind, '/protocols/simplemsg');
  assert.equal(byOrder.get('order-new').billedBy, 'traffic');
  // Writes without a kind and legacy pre-migration rows both read back as ''.
  assert.equal(byOrder.get('order-new-2').kind, '');
  assert.equal(byOrder.get('order-legacy').kind, '');
  assert.equal(byOrder.get('order-legacy').txSize, 200);
  assert.equal(byOrder.get('order-legacy').createdAt, 1700000000000);
});

test('getTrafficLedger enriches sponsor entries from the local spend journal', async () => {
  const LEDGER_TS = 1780000000000;
  const fetchImpl = createFetchStub([
    // Route matching is substring-based, so the ledger route must precede the
    // accounts route that prefixes it.
    ['/ledger', {
      entries: [
        { id: 4, direction: 2, amountBytes: 300, balanceAfter: 200, sourceType: 'sponsor_order', sourceId: 'order-1', remark: 'sponsor commit', timestamp: LEDGER_TS },
        { id: 3, direction: 3, amountBytes: 500, balanceAfter: 500, sourceType: 'sponsor_order', sourceId: 'order-1', remark: 'sponsor reserve', timestamp: LEDGER_TS - 1000 },
        { id: 2, direction: 4, amountBytes: 500, balanceAfter: 1000, sourceType: 'sponsor_order', sourceId: 'order-expired', remark: 'reservation expired', timestamp: LEDGER_TS - 2000 },
        { id: 1, direction: 1, amountBytes: 1000, balanceAfter: 1000, sourceType: 'recharge_order', sourceId: 'recharge-1', remark: 'recharge credited', timestamp: LEDGER_TS - 3000 },
      ],
      nextCursor: 0,
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });
  await ensureTrafficAccount();

  recordLocalTrafficSpend({
    txId: COMMIT_TXID,
    botAddress: BOT1_ADDRESS,
    orderId: 'order-1',
    txSize: 300,
    billedBy: 'traffic',
    kind: '/protocols/simplemsg',
  });

  const { entries, nextCursor } = await getTrafficLedger({});
  assert.equal(entries.length, 4);
  assert.equal(nextCursor, 0);

  const spend = entries.find((entry) => entry.direction === 2);
  assert.equal(spend.txId, COMMIT_TXID);
  assert.equal(spend.botAddress, BOT1_ADDRESS);
  assert.equal(spend.kind, '/protocols/simplemsg');

  // Same orderId: the matching reserve row is enriched too (it became this tx).
  const reserve = entries.find((entry) => entry.direction === 3);
  assert.equal(reserve.txId, COMMIT_TXID);
  assert.equal(reserve.kind, '/protocols/simplemsg');

  // Expired reservation (never committed locally) and the recharge credit
  // have no local journal match: enrichment fields stay absent.
  const release = entries.find((entry) => entry.direction === 4);
  assert.equal(release.txId, undefined);
  assert.equal(release.botAddress, undefined);
  assert.equal(release.kind, undefined);
  const credit = entries.find((entry) => entry.direction === 1);
  assert.equal(credit.txId, undefined);
  assert.equal(credit.botAddress, undefined);
  assert.equal(credit.kind, undefined);
});

test('sponsored createPin journals the pin path as kind', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
    ...sponsorRoutes(buildSponsorDraft(BOT1_ADDRESS)),
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const result = await runSponsoredPin(fetchImpl, { journalKind: '/protocols/simplemsg' });
  assert.equal(result.feeAssist.used, true);

  const journal = listLocalTrafficJournal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, '/protocols/simplemsg');
  assert.equal(journal[0].txId, COMMIT_TXID);
  assert.equal(journal[0].billedBy, 'traffic');
});

test('getConfiguredTrafficPinMode reflects the stored mode and defaults to traffic', async () => {
  resetTrafficAccountServiceForTests();
  // Uninitialized service: safe default, never throws.
  assert.equal(getConfiguredTrafficPinMode(), 'traffic');

  const { store } = await makeServiceFixture({});
  assert.equal(getConfiguredTrafficPinMode(), 'traffic');
  store.set('traffic.mode', 'selfpay');
  assert.equal(getConfiguredTrafficPinMode(), 'selfpay');
  store.set('traffic.mode', 'garbage');
  assert.equal(getConfiguredTrafficPinMode(), 'traffic');
});

test('resolveSponsorTrafficAccount retries a transient ensure-account failure once', async () => {
  let accountPosts = 0;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', () => {
      accountPosts += 1;
      if (accountPosts === 1) {
        return httpError(500, { code: 1, message: 'temporary backend boom' });
      }
      return accountPayload();
    }],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await resolveSponsorTrafficAccount({
      botAddress: BOT1_ADDRESS,
      challengeId: 'challenge-ensure-retry',
      botMnemonic: BOT1_MNEMONIC,
      botWalletPath: WALLET_PATH,
    });
    assert.ok(result);
    assert.equal(result.accountId, SERVER_ACCOUNT_ID);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 2);
});

test('resolveSponsorTrafficAccount retries a transient bind failure once', async () => {
  let bindPosts = 0;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      bindPosts += 1;
      if (bindPosts === 1) {
        return httpError(500, { code: 1, message: 'temporary bind boom' });
      }
      const body = JSON.parse(init.body);
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await resolveSponsorTrafficAccount({
      botAddress: BOT1_ADDRESS,
      challengeId: 'challenge-bind-retry',
      botMnemonic: BOT1_MNEMONIC,
      botWalletPath: WALLET_PATH,
    });
    assert.ok(result);
    assert.equal(result.accountId, SERVER_ACCOUNT_ID);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts/bindings').length, 2);
});

test('resolveSponsorTrafficAccount does not retry a 404 (feature off) and WARN-logs the degradation', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', httpError(404, { code: 1, message: 'traffic disabled' })],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((item) => String(item)).join(' '));
  };
  try {
    const result = await resolveSponsorTrafficAccount({
      botAddress: BOT1_ADDRESS,
      challengeId: 'challenge-404',
      botMnemonic: BOT1_MNEMONIC,
      botWalletPath: WALLET_PATH,
    });
    assert.equal(result, undefined);
  } finally {
    console.warn = originalWarn;
  }
  // 404 is deterministic: exactly one account POST, no retry.
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
  // The drop to legacy quota billing must be visible in the logs.
  assert.ok(
    warnings.some((line) => line.includes('[TrafficAccount]') && line.includes('legacy sponsor quota')),
    `expected a degradation WARN log, got: ${JSON.stringify(warnings)}`,
  );
});

test('resolveSponsorTrafficAccount WARN-logs when a bot stays unbindable', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', httpError(500, { code: 1, message: 'bind always broken' })],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((item) => String(item)).join(' '));
  };
  try {
    const result = await resolveSponsorTrafficAccount({
      botAddress: BOT1_ADDRESS,
      challengeId: 'challenge-bind-dead',
      botMnemonic: BOT1_MNEMONIC,
      botWalletPath: WALLET_PATH,
    });
    assert.equal(result, undefined);
  } finally {
    console.warn = originalWarn;
  }
  // One initial attempt + one retry, then degradation.
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts/bindings').length, 2);
  assert.ok(
    warnings.some((line) => line.includes('[TrafficAccount]') && line.includes('could not be bound')),
    `expected a bind-failure WARN log, got: ${JSON.stringify(warnings)}`,
  );
});
