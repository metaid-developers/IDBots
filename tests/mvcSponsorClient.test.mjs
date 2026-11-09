import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const {
  createMvcSponsorV2Client,
  deriveMvcSponsorAddress,
  estimateDraftMinerFee,
  getEstimatedBaseTxSize,
  getOpReturnScriptSize,
  isNoUserUtxoDraftError,
  isSponsorClientError,
  meBillingOf,
  pickUtxos,
  reconcileSponsorOrderAfterCommitFailure,
  signMvcAddressMessage,
  signMvcPreparedUserInputs,
} = await import('../dist-electron/main/services/mvcSponsorClient.js');

const require = createRequire(import.meta.url);
const { TxComposer, mvc } = require('meta-contract');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const MVC_ADDRESS = '1K9eUW4vED3qfWmr4Fcre64sU7D38QM1tX';
const TEST_TXID = '11'.repeat(32);
const COMMIT_TXID = 'aa'.repeat(32);
const TEST_UTXO = { txId: TEST_TXID, outputIndex: 0, satoshis: 50000, address: MVC_ADDRESS, height: 1 };

function envelope(data) {
  return JSON.stringify({ code: 0, data });
}

function httpError(status, body = { code: status, msg: `HTTP ${status}` }) {
  return { __httpStatus: status, __body: body };
}

function createFetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, init });
    for (const [suffix, responder] of routes) {
      if (text.includes(suffix)) {
        const body = typeof responder === 'function' ? responder(init) : responder;
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
    return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function callsTo(fetchImpl, suffix) {
  return fetchImpl.calls.filter((call) => call.url.includes(suffix));
}

function buildPreparedTxHex() {
  const addressObject = new mvc.Address(MVC_ADDRESS, mvc.Networks.livenet);
  const txComposer = new TxComposer();
  txComposer.appendP2PKHOutput({ address: addressObject, satoshis: 1 });
  txComposer.appendOpReturnOutput(['metaid', 'create', '/file', '0', '1.0', 'text/plain;binary', Buffer.from('test-payload')]);
  txComposer.appendP2PKHInput({ address: addressObject, txId: TEST_TXID, outputIndex: 0, satoshis: TEST_UTXO.satoshis });
  return txComposer.getRawHex();
}

test('createMvcSponsorV2Client defaults to the production assist-open-api base URL', () => {
  assert.equal(createMvcSponsorV2Client().baseUrl, 'https://www.metaso.network/assist-open-api');
  assert.equal(
    createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test/' }).baseUrl,
    'https://sponsor.test',
  );
});

test('getAddressInfo unwraps the envelope, normalizes fields, and sends address + gasChain', async () => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', {
      exists: true,
      balance: 10,
      granted_amount: 20,
      reserved_amount: 5,
      spent_amount: 5,
      availableAmount: 10,
      status: 'active',
    }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  const info = await client.getAddressInfo({ address: MVC_ADDRESS });
  assert.equal(info.exists, true);
  assert.equal(info.grantedAmount, 20);
  assert.equal(info.reservedAmount, 5);
  assert.equal(info.availableAmount, 10);
  assert.equal(info.status, 'active');
  const url = callsTo(fetchImpl, '/v2/assist/gas/address/info')[0].url;
  assert.ok(url.includes(`address=${MVC_ADDRESS}`));
  assert.ok(url.includes('gasChain=mvc'));
});

test('getAddressInfo rejects missing required fields and non-object responses', async () => {
  // status is optional (backend omits it when empty); a missing numeric quota
  // field is still a hard parse failure.
  const missingFields = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/address/info', { exists: true, balance: 10, grantedAmount: 20, reservedAmount: 5, spentAmount: 5, status: 'active' }],
    ]),
  });
  await assert.rejects(missingFields.getAddressInfo({ address: MVC_ADDRESS }), (error) => {
    assert.equal(error.code, 'mvc_fee_assist_address_info_failed');
    assert.equal(error.reason, 'service_unavailable');
    return true;
  });

  const statusOmitted = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/address/info', { exists: false, balance: 10, grantedAmount: 20, reservedAmount: 5, spentAmount: 5, availableAmount: 10 }],
    ]),
  });
  const info = await statusOmitted.getAddressInfo({ address: MVC_ADDRESS });
  assert.equal(info.exists, false);
  assert.equal(info.status, '');
  assert.equal(info.availableAmount, 10);

  const nonObject = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/address/info', 'null']]),
  });
  await assert.rejects(nonObject.getAddressInfo({ address: MVC_ADDRESS }), /non-object response/);
});

test('getAddressInfo classifies quota failures and retries transport errors', async () => {
  const quota = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/address/info', { code: 1, msg: 'available amount not enough' }]]),
  });
  await assert.rejects(quota.getAddressInfo({ address: MVC_ADDRESS }), (error) => {
    assert.equal(error.reason, 'insufficient_quota');
    assert.equal(error.stage, 'address_info');
    return true;
  });

  let attempts = 0;
  const flaky = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/address/info', () => {
        attempts += 1;
        if (attempts === 1) throw new Error('socket hangup');
        return { exists: false, balance: 0, grantedAmount: 0, reservedAmount: 0, spentAmount: 0, availableAmount: 0, status: 'new' };
      }],
    ]),
  });
  const info = await flaky.getAddressInfo({ address: MVC_ADDRESS });
  assert.equal(info.status, 'new');
  assert.equal(attempts, 2);
});

test('getAddressInfo exhausts retries on persistent HTTP 500', async () => {
  const fetchImpl = createFetchStub([['/v2/assist/gas/address/info', httpError(500)]]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  await assert.rejects(client.getAddressInfo({ address: MVC_ADDRESS }), (error) => {
    assert.equal(error.code, 'mvc_fee_assist_address_info_failed');
    assert.equal(error.status, 500);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(callsTo(fetchImpl, '/v2/assist/gas/address/info').length, 3);
});

test('getChallenge normalizes the response and rejects missing fields', async () => {
  const client = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/mvc/challenge', { challenge_id: 'challenge-1', message: 'sign this', expires_at: '2030-01-01' }],
    ]),
  });
  const challenge = await client.getChallenge();
  assert.equal(challenge.challengeId, 'challenge-1');
  assert.equal(challenge.message, 'sign this');
  assert.equal(challenge.expiresAt, '2030-01-01');

  const broken = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/mvc/challenge', { message: 'sign this' }]]),
  });
  await assert.rejects(broken.getChallenge(), (error) => {
    assert.equal(error.code, 'mvc_fee_assist_challenge_failed');
    assert.equal(error.stage, 'challenge');
    return true;
  });
});

test('preSponsor posts the unsigned draft and normalizes the prepared tx', async () => {
  const preparedTxHex = buildPreparedTxHex();
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/pre', {
      prepared_tx_hex: preparedTxHex,
      order_id: 'order-1',
      miner_fee: 100,
      user_input_indexes: [0],
      expires_at: '2030-01-01',
    }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  const pre = await client.preSponsor({
    address: MVC_ADDRESS,
    txHex: preparedTxHex,
    challengeId: 'challenge-1',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
  });
  assert.equal(pre.preparedTxHex, preparedTxHex);
  assert.equal(pre.orderId, 'order-1');
  assert.equal(pre.minerFee, 100);
  assert.deepEqual(pre.userInputIndexes, [0]);
  assert.equal(pre.expiresAt, '2030-01-01');

  const body = JSON.parse(callsTo(fetchImpl, '/v2/assist/gas/mvc/pre')[0].init.body);
  assert.equal(body.address, MVC_ADDRESS);
  assert.equal(body.txHex, preparedTxHex);
  assert.equal(body.challengeId, 'challenge-1');
  assert.equal(body.publicKey, '02'.padEnd(66, '11'));
  assert.equal(body.signature, 'c2ln');
  assert.ok(!('trafficAccount' in body));
});

test('preSponsor passes trafficAccount through untouched when provided', async () => {
  const preparedTxHex = buildPreparedTxHex();
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/pre', {
      preparedTxHex,
      orderId: 'order-1',
      minerFee: 100,
      userInputIndexes: [0],
    }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  const trafficAccount = { accountId: 'gmid-account', authSignature: 'YXV0aA==', timestamp: 1730000000 };
  await client.preSponsor({
    address: MVC_ADDRESS,
    txHex: preparedTxHex,
    challengeId: 'challenge-1',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
    trafficAccount,
  });
  const body = JSON.parse(callsTo(fetchImpl, '/v2/assist/gas/mvc/pre')[0].init.body);
  assert.deepEqual(body.trafficAccount, trafficAccount);
});

test('preSponsor forwards billing:"me" and normalizes the paySource / meAmountMilli echo', async () => {
  const preparedTxHex = buildPreparedTxHex();
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/pre', {
      preparedTxHex,
      orderId: 'order-me',
      minerFee: 100,
      userInputIndexes: [0],
      paySource: 'me',
      meAmountMilli: '12',
    }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  const base = {
    address: MVC_ADDRESS,
    txHex: preparedTxHex,
    challengeId: 'challenge-1',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
  };
  const pre = await client.preSponsor({
    ...base,
    trafficAccount: { accountId: 'gmid-account', authSignature: 'bWU=', timestamp: 1730000000, billing: 'me' },
  });
  assert.equal(pre.paySource, 'me');
  assert.equal(pre.meAmountMilli, 12);
  const meBody = JSON.parse(callsTo(fetchImpl, '/v2/assist/gas/mvc/pre')[0].init.body);
  assert.equal(meBody.trafficAccount.billing, 'me');

  // Anything but an explicit 'me' keeps the legacy request shape old backends accept.
  await client.preSponsor({
    ...base,
    trafficAccount: { accountId: 'gmid-account', authSignature: 'YXV0aA==', timestamp: 1730000000, billing: 'bytes' },
  });
  const bytesBody = JSON.parse(callsTo(fetchImpl, '/v2/assist/gas/mvc/pre')[1].init.body);
  assert.equal('billing' in bytesBody.trafficAccount, false);
});

test('meBillingOf reads the address/info me block and tolerates its absence', () => {
  const info = (raw) => ({ exists: true, balance: 0, grantedAmount: 0, reservedAmount: 0, spentAmount: 0, availableAmount: 0, status: '', raw });
  assert.deepEqual(meBillingOf(info({ me: { trafficBilling: true, spendableMilli: 1834000 } })), {
    trafficBilling: true,
    spendableMilli: 1834000,
  });
  assert.deepEqual(meBillingOf(info({ me: { traffic_billing: 'false', spendable_milli: -1 } })), {
    trafficBilling: false,
    spendableMilli: undefined,
  });
  assert.equal(meBillingOf(info({})), undefined);
  assert.equal(meBillingOf(info({ me: [] })), undefined);
});

test('preSponsor rejects an incomplete trafficAccount locally without any HTTP call', async () => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/pre', { preparedTxHex: 'ab', orderId: 'order-1', minerFee: 1, userInputIndexes: [0] }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  const basePayload = {
    address: MVC_ADDRESS,
    txHex: 'ab',
    challengeId: 'challenge-1',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
  };
  await assert.rejects(
    client.preSponsor({ ...basePayload, trafficAccount: { accountId: '', authSignature: 'YXV0aA==', timestamp: 1730000000 } }),
    (error) => {
      assert.equal(error.code, 'mvc_fee_assist_pre_failed');
      return true;
    },
  );
  await assert.rejects(
    client.preSponsor({ ...basePayload, trafficAccount: { accountId: 'gmid', authSignature: 'YXV0aA==', timestamp: 0 } }),
    (error) => {
      assert.equal(error.code, 'mvc_fee_assist_pre_failed');
      assert.equal(error.reason, 'invalid_request');
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('preSponsor classifies insufficient_quota and pre_rejected failures', async () => {
  const payload = {
    address: MVC_ADDRESS,
    txHex: 'ab',
    challengeId: 'challenge-1',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
  };
  const quota = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/mvc/pre', { code: 1, msg: 'available amount not enough' }]]),
  });
  await assert.rejects(quota.preSponsor(payload), (error) => {
    assert.equal(error.reason, 'insufficient_quota');
    assert.equal(error.stage, 'pre');
    return true;
  });

  const rejected = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/mvc/pre', { code: 1, msg: 'address not match' }]]),
  });
  await assert.rejects(rejected.preSponsor(payload), (error) => {
    assert.equal(error.reason, 'pre_rejected');
    return true;
  });

  const missingFields = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/mvc/pre', { orderId: 'order-1', minerFee: 100, userInputIndexes: [0] }]]),
  });
  await assert.rejects(missingFields.preSponsor(payload), (error) => {
    assert.equal(error.reason, 'pre_rejected');
    return true;
  });
});

test('preSponsor maps TRAFFIC_INSUFFICIENT to insufficient_traffic', async () => {
  const payload = {
    address: MVC_ADDRESS,
    txHex: 'ab',
    challengeId: 'challenge-1',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
  };
  const byCode = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/mvc/pre', { code: 'TRAFFIC_INSUFFICIENT', msg: 'traffic balance not enough' }],
    ]),
  });
  await assert.rejects(byCode.preSponsor(payload), (error) => {
    assert.equal(error.code, 'mvc_fee_assist_pre_failed');
    assert.equal(error.reason, 'insufficient_traffic');
    assert.equal(error.stage, 'pre');
    return true;
  });

  const byMessage = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/mvc/pre', { code: 1, msg: 'TRAFFIC_INSUFFICIENT: balance too low' }]]),
  });
  await assert.rejects(byMessage.preSponsor(payload), (error) => {
    assert.equal(error.reason, 'insufficient_traffic');
    return true;
  });

  const byHttpStatus = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/mvc/pre', httpError(400, { code: 'TRAFFIC_INSUFFICIENT', msg: 'traffic balance not enough' })],
    ]),
  });
  await assert.rejects(byHttpStatus.preSponsor(payload), (error) => {
    assert.equal(error.reason, 'insufficient_traffic');
    assert.equal(error.status, 400);
    return true;
  });

  // Backend production shape (docs/traffic-deployment.md §5.8): numeric envelope
  // code + data.errorCode carries TRAFFIC_INSUFFICIENT.
  const byDataErrorCode = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/mvc/pre', {
        code: 1,
        msg: 'traffic insufficient: account idq1abc needs 500 bytes',
        data: { errorCode: 'TRAFFIC_INSUFFICIENT', accountId: 'idq1abc', estimatedBytes: 500, retryable: false },
      }],
    ]),
  });
  await assert.rejects(byDataErrorCode.preSponsor(payload), (error) => {
    assert.equal(error.reason, 'insufficient_traffic');
    assert.equal(error.stage, 'pre');
    return true;
  });
});

test('preSponsor does not retry HTTP 500 (pre must stay single-shot)', async () => {
  const fetchImpl = createFetchStub([['/v2/assist/gas/mvc/pre', httpError(500)]]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  await assert.rejects(
    client.preSponsor({
      address: MVC_ADDRESS,
      txHex: 'ab',
      challengeId: 'challenge-1',
      publicKey: '02'.padEnd(66, '11'),
      signature: 'c2ln',
    }),
    (error) => {
      assert.equal(error.code, 'mvc_fee_assist_pre_failed');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(callsTo(fetchImpl, '/v2/assist/gas/mvc/pre').length, 1);
});

test('commitSponsor normalizes the broadcast result', async () => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/commit', { txid: COMMIT_TXID, tx_size: 300, miner_fee: 100 }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  const commit = await client.commitSponsor({
    orderId: 'order-1',
    signedTxHex: 'ab',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
  });
  assert.equal(commit.txId, COMMIT_TXID);
  assert.equal(commit.txSize, 300);
  assert.equal(commit.minerFee, 100);
  const body = JSON.parse(callsTo(fetchImpl, '/v2/assist/gas/mvc/commit')[0].init.body);
  assert.equal(body.orderId, 'order-1');
  assert.equal(body.signedTxHex, 'ab');
});

test('commitSponsor hard-fails on non-retryable errors without order recovery', async () => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/commit', { code: 1, msg: 'commit rejected' }],
    ['/v2/assist/gas/mvc/order/', { orderId: 'order-1', status: 'broadcasted', txId: COMMIT_TXID, txSize: 300, minerFee: 100, pending: false, final: true }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  await assert.rejects(
    client.commitSponsor({ orderId: 'order-1', signedTxHex: 'ab', publicKey: '02'.padEnd(66, '11'), signature: 'c2ln' }),
    (error) => {
      assert.equal(error.code, 'mvc_fee_assist_commit_failed');
      assert.equal(error.reason, 'commit_failed');
      return true;
    },
  );
  assert.equal(callsTo(fetchImpl, '/v2/assist/gas/mvc/order/').length, 0);
});

test('commitSponsor recovers a retryable failure via the order status endpoint', async () => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/commit', httpError(500)],
    ['/v2/assist/gas/mvc/order/', { orderId: 'order-1', status: 'broadcasted', txId: COMMIT_TXID, txSize: 300, minerFee: 100, pending: false, final: true }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  const commit = await client.commitSponsor({
    orderId: 'order-1',
    signedTxHex: 'ab',
    publicKey: '02'.padEnd(66, '11'),
    signature: 'c2ln',
  });
  assert.equal(commit.txId, COMMIT_TXID);
  assert.equal(commit.txSize, 300);
  assert.equal(commit.minerFee, 100);
  assert.equal(callsTo(fetchImpl, '/v2/assist/gas/mvc/commit').length, 3);
  assert.equal(callsTo(fetchImpl, '/v2/assist/gas/mvc/order/').length, 1);
});

test('commitSponsor rethrows the original failure when the order is not final', async () => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/mvc/commit', httpError(500)],
    ['/v2/assist/gas/mvc/order/', { orderId: 'order-1', status: 'pending', txSize: 300, minerFee: 100, pending: true, final: false }],
  ]);
  const client = createMvcSponsorV2Client({ baseUrl: 'https://sponsor.test', fetchImpl });
  await assert.rejects(
    client.commitSponsor({ orderId: 'order-1', signedTxHex: 'ab', publicKey: '02'.padEnd(66, '11'), signature: 'c2ln' }),
    (error) => {
      assert.equal(error.code, 'mvc_fee_assist_commit_failed');
      assert.equal(error.reason, 'commit_failed');
      assert.ok(error.data?.order);
      return true;
    },
  );
});

test('getSponsorOrder normalizes fields and rejects incomplete responses', async () => {
  const client = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/mvc/order/', {
        order_id: 'order-1',
        status: 'failed',
        tx_size: 300,
        miner_fee: 100,
        pending: false,
        final: true,
        failure_reason: 'double spend',
      }],
    ]),
  });
  const order = await client.getSponsorOrder('order-1');
  assert.equal(order.orderId, 'order-1');
  assert.equal(order.status, 'failed');
  assert.equal(order.txSize, 300);
  assert.equal(order.minerFee, 100);
  assert.equal(order.pending, false);
  assert.equal(order.final, true);
  assert.equal(order.failureReason, 'double spend');
  assert.equal(order.txId, undefined);

  const broken = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/mvc/order/', { orderId: 'order-1', status: 'pending', txSize: 300, minerFee: 100 }],
    ]),
  });
  await assert.rejects(broken.getSponsorOrder('order-1'), (error) => {
    assert.equal(error.code, 'mvc_fee_assist_commit_failed');
    assert.equal(error.reason, 'commit_failed');
    return true;
  });
});

test('signMvcAddressMessage returns a base64 signature and compressed public key', async () => {
  const { signature, publicKey } = await signMvcAddressMessage({
    mnemonic: MNEMONIC,
    path: WALLET_PATH,
    message: 'sign this message',
  });
  assert.ok(Buffer.from(signature, 'base64').length > 0);
  assert.match(publicKey, /^[0-9a-f]{66}$/);
});

test('deriveMvcSponsorAddress yields the address signMvcAddressMessage signs for', async () => {
  const hd = mvc.Mnemonic.fromString(MNEMONIC).toHDPrivateKey('', mvc.Networks.livenet);
  const address = deriveMvcSponsorAddress({ mnemonic: MNEMONIC, path: WALLET_PATH });
  assert.equal(address, hd.deriveChild(WALLET_PATH).publicKey.toAddress(mvc.Networks.livenet).toString());
  const { signature } = await signMvcAddressMessage({ mnemonic: MNEMONIC, path: WALLET_PATH, message: 'challenge' });
  assert.ok(mvc.Message('challenge').verify(address, signature));
});

test('sponsor signing honours an explicit 236 coin-type path (legacy-imported wallets)', async () => {
  const legacyPath = "m/44'/236'/0'/0/0";
  const hd = mvc.Mnemonic.fromString(MNEMONIC).toHDPrivateKey('', mvc.Networks.livenet);
  const legacyKey = hd.deriveChild(legacyPath);
  const legacyAddress = legacyKey.publicKey.toAddress(mvc.Networks.livenet).toString();
  assert.equal(deriveMvcSponsorAddress({ mnemonic: MNEMONIC, path: legacyPath }), legacyAddress);

  // The sponsor checks publicKey -> address; the 10001 key never matched a 236 address.
  const { signature, publicKey } = await signMvcAddressMessage({ mnemonic: MNEMONIC, path: legacyPath, message: 'challenge' });
  assert.ok(mvc.Message('challenge').verify(legacyAddress, signature));
  assert.equal(publicKey, legacyKey.publicKey.toString());

  // User inputs owned by the 236 address must be unlocked with the 236 key.
  const legacyUtxo = { ...TEST_UTXO, address: legacyAddress };
  const tx = new mvc.Transaction();
  tx.addInput(new mvc.Transaction.Input.PublicKeyHash({
    output: new mvc.Transaction.Output({ script: mvc.Script.buildPublicKeyHashOut(legacyAddress), satoshis: legacyUtxo.satoshis }),
    prevTxId: legacyUtxo.txId,
    outputIndex: legacyUtxo.outputIndex,
    script: mvc.Script.empty(),
  }));
  tx.addOutput(new mvc.Transaction.Output({ script: mvc.Script.buildPublicKeyHashOut(legacyAddress), satoshis: 40000 }));
  const { txHex } = await signMvcPreparedUserInputs({
    mnemonic: MNEMONIC,
    walletPath: legacyPath,
    mvcAddress: legacyAddress,
    preparedTxHex: tx.toString(),
    userInputs: [legacyUtxo],
    userInputIndexes: [0],
  });
  const signed = new mvc.Transaction(txHex);
  const unlockingPubKey = signed.inputs[0].script.chunks[1].buf.toString('hex');
  assert.equal(unlockingPubKey, legacyKey.publicKey.toString());
});

test('signMvcPreparedUserInputs unlocks only the user-owned inputs', async () => {
  const preparedTxHex = buildPreparedTxHex();
  const unsignedInputScript = new mvc.Transaction(preparedTxHex).inputs[0].script.toHex();
  assert.equal(unsignedInputScript, '');

  const signed = await signMvcPreparedUserInputs({
    mnemonic: MNEMONIC,
    walletPath: WALLET_PATH,
    mvcAddress: MVC_ADDRESS,
    preparedTxHex,
    userInputs: [TEST_UTXO],
    userInputIndexes: [0],
  });
  const signedTx = new mvc.Transaction(signed.txHex);
  assert.equal(signedTx.inputs.length, 1);
  assert.ok(signedTx.inputs[0].script.toHex().length > 0);

  await assert.rejects(
    signMvcPreparedUserInputs({
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: MVC_ADDRESS,
      preparedTxHex,
      userInputs: [],
      userInputIndexes: [0],
    }),
    /Missing user-owned MVC UTXO descriptor/,
  );
});

test('estimation helpers size op-return scripts and base transactions', () => {
  assert.equal(getOpReturnScriptSize(['metaid', 'create']), 1 + 7 + 7);
  assert.equal(getOpReturnScriptSize([Buffer.alloc(100)]), 1 + 2 + 100);
  assert.equal(getEstimatedBaseTxSize(15), 4 + 1 + 1 + 43 + (9 + 15) + 4);

  const preparedTxHex = buildPreparedTxHex();
  assert.equal(
    estimateDraftMinerFee({ unsignedTxHex: preparedTxHex, userInputTotal: TEST_UTXO.satoshis }),
    TEST_UTXO.satoshis - 1,
  );
  assert.equal(estimateDraftMinerFee({ unsignedTxHex: preparedTxHex, userInputTotal: 0 }), 0);
});

test('pickUtxos covers the required amount and flags insufficient balances', () => {
  const picked = pickUtxos([TEST_UTXO], 1, 1, 100);
  assert.deepEqual(picked, [TEST_UTXO]);

  const confirmed = { txId: '22'.repeat(32), outputIndex: 0, satoshis: 300, address: MVC_ADDRESS, height: 5 };
  const unconfirmed = { txId: '33'.repeat(32), outputIndex: 0, satoshis: 50000, address: MVC_ADDRESS, height: 0 };
  assert.deepEqual(pickUtxos([unconfirmed, confirmed], 1, 1, 100), [confirmed]);

  assert.throws(
    () => pickUtxos([{ ...TEST_UTXO, satoshis: 100 }], 1, 1, 100),
    (error) => {
      assert.ok(isNoUserUtxoDraftError(error));
      return true;
    },
  );
  assert.equal(isNoUserUtxoDraftError(new Error('some other failure')), false);
});

test('isSponsorClientError recognizes only mvc_fee_assist errors', async () => {
  const client = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([['/v2/assist/gas/mvc/challenge', { code: 1, msg: 'boom' }]]),
  });
  const error = await client.getChallenge().catch((caught) => caught);
  assert.ok(isSponsorClientError(error));
  assert.equal(isSponsorClientError(new Error('boom')), false);
  assert.equal(isSponsorClientError({ code: 'other_error' }), false);
});

function orderSnapshot(overrides = {}) {
  return {
    orderId: 'order-1',
    status: 'reconciling',
    txSize: 300,
    minerFee: 100,
    pending: true,
    final: false,
    raw: {},
    ...overrides,
  };
}

test('reconcileSponsorOrderAfterCommitFailure resolves a terminal broadcasted order', async () => {
  const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
    orderId: 'order-1',
    client: { getSponsorOrder: async () => orderSnapshot({ status: 'broadcasted', txId: COMMIT_TXID, pending: false, final: true }) },
  });
  assert.equal(reconciliation.outcome, 'broadcasted');
  assert.equal(reconciliation.txId, COMMIT_TXID);
  assert.equal(reconciliation.txSize, 300);
  assert.equal(reconciliation.minerFee, 100);
});

test('reconcileSponsorOrderAfterCommitFailure resolves a terminal failure without waiting', async () => {
  const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
    orderId: 'order-1',
    client: { getSponsorOrder: async () => orderSnapshot({ status: 'failed', pending: false, final: true, failureReason: 'missing inputs' }) },
  });
  assert.equal(reconciliation.outcome, 'failed');
  assert.equal(reconciliation.status, 'failed');
  assert.equal(reconciliation.failureReason, 'missing inputs');
});

test('reconcileSponsorOrderAfterCommitFailure reports pending at the wait deadline', async () => {
  const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
    orderId: 'order-1',
    maxWaitMs: 0,
    client: { getSponsorOrder: async () => orderSnapshot({ status: 'reconciling' }) },
  });
  assert.equal(reconciliation.outcome, 'pending');
  assert.equal(reconciliation.status, 'reconciling');
});

test('reconcileSponsorOrderAfterCommitFailure polls a pending order until it resolves', async () => {
  let polls = 0;
  const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
    orderId: 'order-1',
    pollIntervalMs: 1,
    maxWaitMs: 1_000,
    sleepImpl: async () => {},
    client: {
      getSponsorOrder: async () => {
        polls += 1;
        return polls < 3
          ? orderSnapshot({ status: 'reconciling' })
          : orderSnapshot({ status: 'failed', pending: false, final: true });
      },
    },
  });
  assert.equal(reconciliation.outcome, 'failed');
  assert.equal(polls, 3);
});

test('reconcileSponsorOrderAfterCommitFailure reports unknown when the status endpoint never answers', async () => {
  const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
    orderId: 'order-1',
    maxWaitMs: 0,
    client: { getSponsorOrder: async () => { throw new Error('unreachable'); } },
  });
  assert.equal(reconciliation.outcome, 'unknown');
  assert.equal(reconciliation.status, undefined);
});
