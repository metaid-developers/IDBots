import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  runMvcSponsorCreatePin,
  TrafficInsufficientError,
} = await import('../dist-electron/main/services/mvcSponsorCreatePin.js');
const {
  getTrafficFallbackPolicy,
  getTrafficPinMode,
  getTrafficSettings,
  setTrafficSettings,
} = await import('../dist-electron/main/services/trafficSettings.js');
const {
  recordSponsorBroadcastFailure,
  resetSponsorCircuitBreakerForTests,
} = await import('../dist-electron/main/services/mvcSponsorCircuitBreaker.js');
const {
  feeAssistReceiptLines,
  chainWriteFailureDetail,
} = await import('../dist-electron/main/libs/chainFeeAssistReceipt.js');
const {
  isIdentityPinSponsored,
  runMvcCreatePinWithInsufficientFundsRescue,
} = await import('../dist-electron/main/services/metaidCore.js');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const COMMIT_TXID = 'bb'.repeat(32);

function deriveTestAddress() {
  const network = mvc.Networks.livenet;
  const mneObj = mvc.Mnemonic.fromString(MNEMONIC);
  const hdpk = mneObj.toHDPrivateKey('', network);
  const childPk = hdpk.deriveChild(WALLET_PATH);
  return childPk.publicKey.toAddress(network).toString();
}

const TEST_ADDRESS = deriveTestAddress();

function buildDraftResult() {
  const network = mvc.Networks.livenet;
  const tx = new mvc.Transaction();
  tx.from({
    txId: '22'.repeat(32),
    outputIndex: 0,
    address: TEST_ADDRESS,
    script: mvc.Script.buildPublicKeyHashOut(new mvc.Address(TEST_ADDRESS, network)),
    satoshis: 10000,
  });
  tx.to(TEST_ADDRESS, 1);
  tx.to(TEST_ADDRESS, 9999);
  return {
    txids: [],
    pinId: '',
    totalCost: 0,
    spentOutpoints: [`${'22'.repeat(32)}:0`],
    draft: {
      unsignedTxHex: tx.toString(),
      estimatedTxSize: 280,
      feeRate: 1,
      userInputs: [{
        txId: '22'.repeat(32),
        outputIndex: 0,
        satoshis: 10000,
        address: TEST_ADDRESS,
        height: 1,
      }],
      changeOutput: { outputIndex: 1, satoshis: 9999 },
    },
  };
}

function createFetchStub(routes) {
  return async (url) => {
    const text = String(url);
    for (const [suffix, responder] of routes) {
      if (text.includes(suffix)) {
        const body = typeof responder === 'function' ? responder() : responder;
        const wrapped = body && typeof body === 'object' && 'code' in body
          ? body
          : { code: 0, data: body };
        return {
          ok: true,
          status: 200,
          json: async () => wrapped,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) };
  };
}

const HEALTHY_ADDRESS_INFO = [
  '/v2/assist/gas/address/info',
  {
    exists: true,
    balance: 5000,
    grantedAmount: 5000,
    reservedAmount: 0,
    spentAmount: 0,
    availableAmount: 5000,
    status: 'active',
  },
];

const CHALLENGE_ROUTE = [
  '/v2/assist/gas/mvc/challenge',
  { challengeId: 'chal-strict-1', message: 'sign strict challenge' },
];

test('AC7 matrix: all 8 sponsor failure reasons × ON(strict) vs OFF(selfpay)', async () => {
  const draftResult = buildDraftResult();

  const matrix = [
    {
      reason: 'service_unavailable',
      stage: 'address_info',
      routes: [['/v2/assist/gas/address/info', () => ({ code: 1, msg: 'service down' })]],
    },
    {
      reason: 'service_unavailable',
      stage: 'pre',
      routes: [
        HEALTHY_ADDRESS_INFO,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', () => ({ code: 1, msg: 'open sponsor orders for address exceed limit' })],
      ],
    },
    {
      reason: 'no_user_utxo',
      stage: 'address_info',
      draftError: new Error('MetaBot balance is insufficient for this chain write.'),
      routes: [HEALTHY_ADDRESS_INFO],
    },
    {
      reason: 'insufficient_quota',
      stage: 'address_info',
      routes: [
        ['/v2/assist/gas/address/info', {
          exists: true,
          balance: 1,
          grantedAmount: 1,
          reservedAmount: 0,
          spentAmount: 0,
          availableAmount: 1,
          status: 'active',
        }],
        CHALLENGE_ROUTE,
      ],
    },
    {
      reason: 'insufficient_traffic',
      stage: 'pre',
      routes: [
        HEALTHY_ADDRESS_INFO,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', () => ({ code: 'TRAFFIC_INSUFFICIENT', msg: 'TRAFFIC_INSUFFICIENT' })],
      ],
    },
    {
      reason: 'insufficient_me',
      stage: 'pre',
      routes: [
        HEALTHY_ADDRESS_INFO,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', () => ({
          code: 1,
          msg: 'me credits exhausted',
          data: { errorCode: 'ME_INSUFFICIENT', retryable: false },
        })],
      ],
    },
    {
      reason: 'pre_rejected',
      stage: 'pre',
      routes: [
        HEALTHY_ADDRESS_INFO,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', () => ({ code: 1, msg: 'address not match' })],
      ],
    },
    {
      reason: 'commit_failed',
      stage: 'commit',
      routes: [
        HEALTHY_ADDRESS_INFO,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', {
          preparedTxHex: draftResult.draft.unsignedTxHex,
          orderId: 'order-matrix-1',
          minerFee: 100,
          userInputIndexes: [0],
        }],
        ['/v2/assist/gas/mvc/commit', () => ({ code: 1, msg: 'commit failed' })],
        ['/v2/assist/gas/mvc/order/order-matrix-1', {
          orderId: 'order-matrix-1',
          status: 'failed',
          txSize: 280,
          minerFee: 100,
          pending: false,
          final: true,
        }],
      ],
    },
    {
      reason: 'circuit_open',
      stage: 'address_info',
      tripBreaker: true,
      routes: [],
    },
  ];

  for (const row of matrix) {
    // ON (strict): throws TrafficInsufficientError with reason, stage, Chinese prompt; 0 wallet broadcast calls.
    resetSponsorCircuitBreakerForTests();
    if (row.tripBreaker) {
      recordSponsorBroadcastFailure(TEST_ADDRESS);
      recordSponsorBroadcastFailure(TEST_ADDRESS);
      recordSponsorBroadcastFailure(TEST_ADDRESS);
    }
    let strictBroadcastCalls = 0;
    await assert.rejects(
      runMvcSponsorCreatePin(
        {
          metabotId: 35,
          mnemonic: MNEMONIC,
          walletPath: WALLET_PATH,
          mvcAddress: TEST_ADDRESS,
          feeRate: 1,
          fallbackPolicy: 'strict',
          baseUrl: 'https://sponsor.test',
          fetchImpl: createFetchStub(row.routes),
          commitReconcileMaxWaitMs: 0,
        },
        {
          runDraftWorker: async () => {
            if (row.draftError) throw row.draftError;
            return draftResult;
          },
          runBroadcastWorker: async () => {
            strictBroadcastCalls += 1;
            return { txids: [COMMIT_TXID], pinId: `${COMMIT_TXID}i0`, totalCost: 300 };
          },
          recordSpentOutpoints: () => {},
          replacePendingFundingUtxos: () => {},
        },
      ),
      (error) => {
        assert.ok(error instanceof TrafficInsufficientError, `expected TrafficInsufficientError for ${row.reason}@${row.stage}`);
        assert.equal(error.code, 'mvc_traffic_insufficient');
        assert.equal(error.reason, row.reason);
        assert.equal(error.stage, row.stage);
        assert.equal(error.feeAssist.used, false);
        assert.match(error.message, /积分支付失败，请检查积分余额或稍后重试/);
        assert.ok(error.message.includes(row.reason));
        assert.ok(error.message.includes(row.stage));
        assert.match(chainWriteFailureDetail(error), new RegExp(`sponsor=${row.reason}@${row.stage}`));
        return true;
      },
    );
    assert.equal(strictBroadcastCalls, 0, `${row.reason}@${row.stage} must never touch wallet in strict mode`);

    // selfpay policy (explicit fallback test): falls back cleanly to broadcast worker.
    resetSponsorCircuitBreakerForTests();
    if (row.tripBreaker) {
      recordSponsorBroadcastFailure(TEST_ADDRESS);
      recordSponsorBroadcastFailure(TEST_ADDRESS);
      recordSponsorBroadcastFailure(TEST_ADDRESS);
    }
    let selfpayBroadcastCalls = 0;
    const fallbackResult = await runMvcSponsorCreatePin(
      {
        metabotId: 35,
        mnemonic: MNEMONIC,
        walletPath: WALLET_PATH,
        mvcAddress: TEST_ADDRESS,
        feeRate: 1,
        fallbackPolicy: 'selfpay',
        baseUrl: 'https://sponsor.test',
        fetchImpl: createFetchStub(row.routes),
        commitReconcileMaxWaitMs: 0,
      },
      {
        runDraftWorker: async () => {
          if (row.draftError) throw row.draftError;
          return draftResult;
        },
        runBroadcastWorker: async () => {
          selfpayBroadcastCalls += 1;
          return { txids: [COMMIT_TXID], pinId: `${COMMIT_TXID}i0`, totalCost: 300 };
        },
        recordSpentOutpoints: () => {},
        replacePendingFundingUtxos: () => {},
      },
    );
    assert.equal(selfpayBroadcastCalls, 1, `${row.reason}@${row.stage} should fall back under selfpay policy`);
    assert.equal(fallbackResult.feeAssist.used, false);
    assert.equal(fallbackResult.feeAssist.reason, row.reason);
    assert.equal(fallbackResult.feeAssist.stage, row.stage);
  }
  resetSponsorCircuitBreakerForTests();
});

test('AC1 & AC3 receipt observability: SPONSOR paid marker emitted only on sponsored success', () => {
  const meSuccessLines = feeAssistReceiptLines({
    attempted: true,
    used: true,
    mode: 'mvc_sponsor_v2',
    stage: 'done',
    orderId: 'ord-me-1',
    billedBy: 'me',
    meAmountMilli: 47,
    sponsoredMinerFee: 1406,
  });
  const meSuccessText = meSuccessLines.join('\n');
  assert.match(meSuccessText, /^- SPONSOR paid: order=ord-me-1 billed_by=me points=0\.047 me_milli=47 fee_sats=1406/m);
  assert.match(meSuccessText, /^- sponsor: applied \(MVC fee sponsor covered this write, order ord-me-1\)/m);

  const fallbackLines = feeAssistReceiptLines({
    attempted: true,
    used: false,
    mode: 'self_paid',
    reason: 'service_unavailable',
    stage: 'pre',
  });
  const fallbackText = fallbackLines.join('\n');
  assert.doesNotMatch(fallbackText, /SPONSOR paid/);
  assert.doesNotMatch(fallbackText, /sponsor: applied/);
  assert.match(fallbackText, /WARN sponsor_fallback: true/);
});

test('default traffic fallbackPolicy is selfpay across bots and user identity when ME credits run out', () => {
  const kv = new Map([
    ['traffic.mode', 'traffic'],
    ['traffic.fallbackPolicy', 'strict'],
  ]);
  const store = {
    get: (k) => kv.get(k),
    set: (k, v) => { kv.set(k, v); },
  };
  assert.equal(getTrafficPinMode(store), 'traffic');
  assert.equal(getTrafficFallbackPolicy(store), 'selfpay');
  assert.equal(getTrafficSettings(store).fallbackPolicy, 'selfpay');
  assert.equal(isIdentityPinSponsored({ network: 'mvc', reader: store }), true);

  setTrafficSettings(store, { mode: 'selfpay' });
  assert.equal(getTrafficPinMode(store), 'selfpay');
  assert.equal(getTrafficFallbackPolicy(store), 'selfpay');
  assert.equal(isIdentityPinSponsored({ network: 'mvc', reader: store }), false);

  setTrafficSettings(store, { mode: 'traffic' });
  assert.equal(kv.get('traffic.fallbackPolicy'), 'selfpay');
  assert.equal(getTrafficFallbackPolicy(store), 'selfpay');
});

test('no_user_utxo strict error triggers gas-subsidy rescue once without self-pay fallback; non-utxo strict errors do not rescue', async () => {
  let fundingCalls = 0;
  let runCalls = 0;
  const rescued = await runMvcCreatePinWithInsufficientFundsRescue({
    metabotId: 35,
    operation: 'create',
    path: '/protocols/simplebuzz',
    requestFreshFunding: async () => {
      fundingCalls += 1;
      return true;
    },
    run: async () => {
      runCalls += 1;
      if (runCalls === 1) {
        throw new TrafficInsufficientError({
          reason: 'no_user_utxo',
          stage: 'address_info',
          feeAssist: { attempted: true, used: false, mode: 'mvc_sponsor_v2', sponsor: 'mvc_sponsor_v2', reason: 'no_user_utxo', stage: 'address_info' },
        });
      }
      return { txids: [COMMIT_TXID], pinId: `${COMMIT_TXID}i0`, totalCost: 500 };
    },
  });
  assert.equal(fundingCalls, 1);
  assert.equal(runCalls, 2);
  assert.equal(rescued.pinId, `${COMMIT_TXID}i0`);

  // service_unavailable / insufficient_me must NOT trigger faucet rescue; fail closed immediately.
  let nonUtxoFundingCalls = 0;
  await assert.rejects(
    runMvcCreatePinWithInsufficientFundsRescue({
      metabotId: 35,
      operation: 'create',
      path: '/protocols/simplebuzz',
      requestFreshFunding: async () => {
        nonUtxoFundingCalls += 1;
        return true;
      },
      run: async () => {
        throw new TrafficInsufficientError({
          reason: 'insufficient_me',
          stage: 'pre',
          feeAssist: { attempted: true, used: false, mode: 'mvc_sponsor_v2', sponsor: 'mvc_sponsor_v2', reason: 'insufficient_me', stage: 'pre' },
        });
      },
    }),
    (err) => err instanceof TrafficInsufficientError && err.reason === 'insufficient_me',
  );
  assert.equal(nonUtxoFundingCalls, 0);
});

test('all MVC write entrypoints route through selfpay fallback policy when credits are insufficient', () => {
  const root = process.cwd();
  const metaidCoreSrc = fs.readFileSync(path.join(root, 'src/main/services/metaidCore.ts'), 'utf8');
  const uploadSvcSrc = fs.readFileSync(path.join(root, 'src/main/services/metaFileUploadService.ts'), 'utf8');
  const trafficSettingsUiSrc = fs.readFileSync(path.join(root, 'src/renderer/components/traffic/TrafficSettings.tsx'), 'utf8');

  assert.equal(
    (metaidCoreSrc.match(/getTrafficFallbackPolicy\(getMetaidCoreKvReader\(\)\)/g) ?? []).length >= 2,
    true,
  );
  assert.match(uploadSvcSrc, /fallbackPolicy:\s*getConfiguredTrafficFallbackPolicy\(\)/);
  assert.match(uploadSvcSrc, /feeAssist \? \{ sponsorMode: 'selfpay' as const \} : \{\}/);
  assert.match(trafficSettingsUiSrc, /fallbackPolicy:\s*'selfpay'/);
});

test('getConfiguredTrafficFallbackPolicy resolves to selfpay regardless of user_identity or traffic.mode', async () => {
  const {
    getConfiguredTrafficFallbackPolicy,
    initTrafficAccountService,
    isLegacyTrafficUserWithoutIdentity,
    resetTrafficAccountServiceForTests,
  } = await import('../dist-electron/main/services/trafficAccountService.js');
  const kv = new Map();
  let identity = null;
  initTrafficAccountService({
    getStore: () => ({
      get: (k) => kv.get(k),
      set: (k, v) => { kv.set(k, v); },
      getDatabase: () => ({ exec: () => [], run: () => {} }),
      getSaveFunction: () => () => {},
    }),
    getUserIdentityStore: () => ({ get: () => identity }),
  });
  try {
    assert.equal(isLegacyTrafficUserWithoutIdentity(), true);
    assert.equal(getConfiguredTrafficFallbackPolicy(), 'selfpay');

    kv.set('traffic.mode', 'traffic');
    assert.equal(isLegacyTrafficUserWithoutIdentity(), false);
    assert.equal(getConfiguredTrafficFallbackPolicy(), 'selfpay');

    kv.delete('traffic.mode');
    identity = { mnemonic: MNEMONIC, mvc_address: TEST_ADDRESS };
    assert.equal(isLegacyTrafficUserWithoutIdentity(), false);
    assert.equal(getConfiguredTrafficFallbackPolicy(), 'selfpay');
  } finally {
    resetTrafficAccountServiceForTests();
  }
});

test('mvcSponsorClient scales pre/commit timeouts for multi-MB payloads while keeping lightweight calls at 8s', async () => {
  const { resolveSponsorRequestTimeoutMs } = await import('../dist-electron/main/services/mvcSponsorClient.js');
  assert.equal(resolveSponsorRequestTimeoutMs('address_info'), 8_000);
  assert.equal(resolveSponsorRequestTimeoutMs('challenge'), 8_000);
  assert.equal(resolveSponsorRequestTimeoutMs('pre', '{"txHex":"ab"}'), 33_000);
  const fiveMibHexJson = 'x'.repeat(10 * 1024 * 1024);
  const bigTimeout = resolveSponsorRequestTimeoutMs('pre', fiveMibHexJson);
  assert.ok(bigTimeout >= 140_000 && bigTimeout <= 180_000, `expected 140s..180s, got ${bigTimeout}`);
  assert.equal(resolveSponsorRequestTimeoutMs('commit', 'x'.repeat(20 * 1024 * 1024)), 180_000);
});

test('errorCode precedence & diagnostics: ME_DAILY_LIMIT, ME_INSUFFICIENT, and open-order limit surface exact detail and ME numbers', async () => {
  const draftResult = buildDraftResult();

  // Case 1: ME_DAILY_LIMIT with non-English message text that omits the code string.
  await assert.rejects(
    runMvcSponsorCreatePin(
      {
        metabotId: 22,
        mnemonic: MNEMONIC,
        walletPath: WALLET_PATH,
        mvcAddress: TEST_ADDRESS,
        feeRate: 1,
        fallbackPolicy: 'strict',
        baseUrl: 'https://sponsor.test',
        trafficAccount: { accountId: 'acc-1', authSignature: 'sig', timestamp: 1700000000, billing: 'me' },
        fetchImpl: createFetchStub([
          ['/v2/assist/gas/address/info', {
            exists: true,
            balance: 5000,
            grantedAmount: 5000,
            reservedAmount: 0,
            spentAmount: 0,
            availableAmount: 5000,
            status: 'active',
            me: { trafficBilling: true, spendableMilli: 27500 },
          }],
          CHALLENGE_ROUTE,
          ['/v2/assist/gas/mvc/pre', () => ({
            code: 1,
            message: '今日额度已用完',
            data: { errorCode: 'ME_DAILY_LIMIT', limitMilli: 20000000, retryable: false },
          })],
        ]),
      },
      {
        runDraftWorker: async () => draftResult,
        runBroadcastWorker: async () => {
          throw new Error('must not self-pay');
        },
        recordSpentOutpoints: () => {},
        replacePendingFundingUtxos: () => {},
      },
    ),
    (error) => {
      assert.ok(error instanceof TrafficInsufficientError);
      assert.equal(error.reason, 'insufficient_me');
      assert.equal(error.stage, 'pre');
      assert.equal(error.feeAssist.serviceErrorCode, 'ME_DAILY_LIMIT');
      assert.equal(error.feeAssist.billedBy, 'me');
      assert.equal(error.feeAssist.spendableMilli, 27500);
      assert.equal(error.feeAssist.limitMilli, 20000000);
      assert.equal(error.feeAssist.detail, '今日额度已用完');
      assert.match(error.message, /ME_DAILY_LIMIT/);
      assert.match(error.message, /今日额度已用完/);
      assert.match(chainWriteFailureDetail(error), /service_code=ME_DAILY_LIMIT/);
      return true;
    },
  );

  // Case 2: ME_INSUFFICIENT carries neededMilli + availableMilli in diagnostics.
  await assert.rejects(
    runMvcSponsorCreatePin(
      {
        metabotId: 22,
        mnemonic: MNEMONIC,
        walletPath: WALLET_PATH,
        mvcAddress: TEST_ADDRESS,
        feeRate: 1,
        fallbackPolicy: 'strict',
        baseUrl: 'https://sponsor.test',
        trafficAccount: { accountId: 'acc-1', authSignature: 'sig', timestamp: 1700000000, billing: 'me' },
        fetchImpl: createFetchStub([
          ['/v2/assist/gas/address/info', {
            exists: true,
            balance: 5000,
            grantedAmount: 5000,
            reservedAmount: 0,
            spentAmount: 0,
            availableAmount: 5000,
            status: 'active',
            me: { trafficBilling: true, spendableMilli: 5000 },
          }],
          CHALLENGE_ROUTE,
          ['/v2/assist/gas/mvc/pre', () => ({
            code: 1,
            message: 'ME balance insufficient',
            data: { errorCode: 'ME_INSUFFICIENT', neededMilli: 95987, availableMilli: 5000, retryable: false },
          })],
        ]),
      },
      {
        runDraftWorker: async () => draftResult,
        runBroadcastWorker: async () => {
          throw new Error('must not self-pay');
        },
        recordSpentOutpoints: () => {},
        replacePendingFundingUtxos: () => {},
      },
    ),
    (error) => {
      assert.ok(error instanceof TrafficInsufficientError);
      assert.equal(error.reason, 'insufficient_me');
      assert.equal(error.feeAssist.requiredMilli, 95987);
      assert.equal(error.feeAssist.spendableMilli, 5000);
      assert.match(error.message, /required_milli=95987/);
      assert.match(error.message, /spendable_milli=5000/);
      assert.match(chainWriteFailureDetail(error), /required_milli=95987; spendable_milli=5000/);
      return true;
    },
  );
});

test('compiled uploadLargeFileWorker.js exists and chunked MVC upload routes through sponsor with strict fallback gate', async () => {
  const workerPath = path.join(process.cwd(), 'dist-electron', 'main', 'libs', 'uploadLargeFileWorker.js');
  assert.equal(fs.existsSync(workerPath), true, 'uploadLargeFileWorker.js must be compiled into dist-electron/main/libs');
  const uploadSvcSrc = fs.readFileSync(path.join(process.cwd(), 'src/main/services/metaFileUploadService.ts'), 'utf8');
  assert.match(uploadSvcSrc, /uploadMvcSponsorChunkedFile\(/);
  assert.match(uploadSvcSrc, /fallbackPolicy:\s*getConfiguredTrafficFallbackPolicy\(\)/);
  const { uploadMvcSponsorChunkedFile } = await import('../dist-electron/main/services/mvcSponsorChunkedUpload.js');
  resetSponsorCircuitBreakerForTests();
  let selfPaidCalls = 0;
  await assert.rejects(
    uploadMvcSponsorChunkedFile({
      data: Buffer.alloc(5 * 1024 * 1024, 1),
      fileName: 'big.bin',
      uploadPath: '/file/big.bin',
      contentType: 'application/octet-stream;binary',
      bytes: 5 * 1024 * 1024,
      feeRate: 1,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: TEST_ADDRESS,
      metaId: 'metaid-test',
      fallbackPolicy: 'strict',
      baseUrl: 'https://sponsor.test',
      fetchImpl: createFetchStub([
        ['/v2/assist/gas/address/info', () => ({
          exists: true,
          balance: 0,
          grantedAmount: 0,
          reservedAmount: 0,
          spentAmount: 0,
          availableAmount: 0,
          status: 'active',
          me: { trafficBilling: true, spendableMilli: 0 },
        })],
      ]),
      selfPaidChunkedUpload: async () => {
        selfPaidCalls += 1;
        return { pinId: 'should-not-run' };
      },
    }),
    (error) => error instanceof TrafficInsufficientError && error.reason === 'insufficient_me',
  );
  assert.equal(selfPaidCalls, 0, 'strict policy must not fall back to self-paid');
  resetSponsorCircuitBreakerForTests();
});

// 2026-11-13 dev:fresh: a payload the pin-reference guard blocks is wrong on
// every channel. The sponsored draft used to swallow the block as a sponsor
// outage, fall back to self-paid, and re-run the same block — reported as
// "sponsor service_unavailable at address_info".
test('a pin-reference guard block never falls back to self-paid', async () => {
  const { assertChainWritePinRefs, isPinRefGuardError } = await import('../dist-electron/main/libs/chainPinRefGuard.js');
  let guardError = null;
  try {
    assertChainWritePinRefs({ path: '/info/bio', payload: `pin://${'ab'.repeat(30)}` });
  } catch (error) {
    guardError = error;
  }
  assert.ok(isPinRefGuardError(guardError), 'the guard tags its block');
  resetSponsorCircuitBreakerForTests();
  let broadcastCalls = 0;
  await assert.rejects(
    runMvcSponsorCreatePin(
      {
        metabotId: 36,
        mnemonic: MNEMONIC,
        walletPath: WALLET_PATH,
        mvcAddress: TEST_ADDRESS,
        feeRate: 1,
        fallbackPolicy: 'selfpay',
        baseUrl: 'https://sponsor.test',
        fetchImpl: createFetchStub([HEALTHY_ADDRESS_INFO]),
        commitReconcileMaxWaitMs: 0,
      },
      {
        runDraftWorker: async () => { throw guardError; },
        runBroadcastWorker: async () => {
          broadcastCalls += 1;
          return { txids: [COMMIT_TXID], pinId: `${COMMIT_TXID}i0`, totalCost: 300 };
        },
        recordSpentOutpoints: () => {},
        replacePendingFundingUtxos: () => {},
      },
    ),
    (error) => isPinRefGuardError(error) && !/fell back to self-paid/.test(error.message),
  );
  assert.equal(broadcastCalls, 0, 'no self-paid attempt');
  resetSponsorCircuitBreakerForTests();
});
