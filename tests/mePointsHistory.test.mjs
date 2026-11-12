import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');
const {
  getMeHistory,
  getMeTopupOrders,
  initMePointsService,
} = require('../dist-electron/main/services/mePointsService.js');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const network = mvc.Networks.livenet;
const child = mvc.Mnemonic.fromString(MNEMONIC).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
const ADDRESS = child.publicKey.toAddress(network).toString();

function initService(payload) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const data = typeof payload === 'function' ? payload(calls.length - 1) : payload;
    return { ok: true, status: 200, json: async () => ({ code: 0, message: 'ok', data }) };
  };
  initMePointsService({
    fetchImpl,
    getUserIdentityStore: () => ({
      get: () => ({ id: 1, mnemonic: MNEMONIC, path: WALLET_PATH, mvc_address: ADDRESS, name: 'Owner' }),
    }),
  });
  return calls;
}

function verifyCall(call, action) {
  const timestamp = Number(call.init.headers['X-Timestamp']);
  assert.equal(call.init.headers['X-Identity-Address'], ADDRESS);
  const message = `me:${action}:${timestamp / 1000}`;
  assert.equal(mvc.Message(message).verify(ADDRESS, call.init.headers['X-Signature']), true);
}

test('history keeps numeric ids and normalizes backend snake-case fields', async () => {
  const calls = initService({
    entries: [{
      id: 42,
      entry_type: 'burn',
      amount_milli: -1250,
      balance_after_milli: 998750,
      ref_type: 'llm',
      ref_id: 99,
      remark: 'deepseek-chat',
      createTime: 1793835740777,
    }],
    next_cursor: 42,
  });

  const page = await getMeHistory({ type: 'burn', beforeId: '41', limit: 50 });
  assert.equal(page.entries.length, 1);
  assert.deepEqual(page.entries[0], {
    id: '42',
    type: 'burn',
    amountMilli: -1250,
    balanceAfterMilli: 998750,
    refType: 'llm',
    refId: '99',
    reason: 'deepseek-chat',
    createdAt: 1793835740777,
    raw: {
      id: 42,
      entry_type: 'burn',
      amount_milli: -1250,
      balance_after_milli: 998750,
      ref_type: 'llm',
      ref_id: 99,
      remark: 'deepseek-chat',
      createTime: 1793835740777,
    },
  });
  assert.equal(page.nextCursor, '42');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('type'), 'burn');
  assert.equal(url.searchParams.get('beforeId'), '41');
  assert.equal(url.searchParams.get('limit'), '50');
  verifyCall(calls[0], 'history');
});

test('history accepts list and direct-array envelopes without dropping zero cursors', async () => {
  initService({ list: [{ entryId: 'mint-1', type: 'mint', amountMilli: 2000000 }], nextCursor: 0 });
  const listed = await getMeHistory();
  assert.equal(listed.entries[0].id, 'mint-1');
  assert.equal(listed.entries[0].amountMilli, 2000000);
  assert.equal(listed.nextCursor, '0');

  initService([{ id: 'bonus-1', type: 'bonus', amount_milli: 5000 }]);
  const direct = await getMeHistory();
  assert.equal(direct.entries[0].id, 'bonus-1');
  assert.equal(direct.entries[0].amountMilli, 5000);
});

test('top-up orders accept an object list and preserve gateway/status fields', async () => {
  const calls = initService({
    orders: [{
      id: 7,
      packageId: 'me_topup_a',
      status: 'credited',
      payAmount: 90,
      payCurrency: 'CNY',
      gatewayParams: { qrCode: 'https://qr.alipay.com/me-7' },
    }],
  });
  const orders = await getMeTopupOrders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '7');
  assert.equal(orders[0].status, 'credited');
  assert.equal(orders[0].payAmount, 90);
  assert.deepEqual(orders[0].gatewayParams, { qrCode: 'https://qr.alipay.com/me-7' });
  verifyCall(calls[0], 'topup_orders');
});

test('top-up orders come back newest-first regardless of server order', async () => {
  // The merged payment-records list sorts by createdAt — the service enforces
  // the same desc contract so unsorted wire data cannot scramble the UI.
  initService({
    orders: [
      { orderId: 'old', packageId: 'me_topup_a', status: 'credited', createdAt: 1793835740 }, // seconds
      { orderId: 'new', packageId: 'me_topup_a', status: 'credited', createdAt: 1793935740000 }, // ms
      { orderId: 'mid', packageId: 'me_topup_a', status: 'credited', createdAt: 1793885740000 },
    ],
  });
  const orders = await getMeTopupOrders();
  assert.deepEqual(orders.map((order) => order.orderId), ['new', 'mid', 'old']);
  // Orders with no parseable time sink to the bottom, never interleave.
  initService({
    orders: [
      { orderId: 'untimed', packageId: 'me_topup_a', status: 'submitted' },
      { orderId: 'timed', packageId: 'me_topup_a', status: 'credited', createdAt: 1793935740000 },
    ],
  });
  assert.deepEqual((await getMeTopupOrders()).map((order) => order.orderId), ['timed', 'untimed']);
});

test('top-up orders accept alternate createdAt keys and ISO strings', async () => {
  // ABS releases have shipped createTime/create_time/submitted_at shapes; an
  // unparsed time reads as createdAt=undefined and previously sank the row to
  // the bottom of the payment-records sort with a '—' timestamp.
  initService({
    orders: [
      { orderId: 'a', packageId: 'me_topup_a', status: 'credited', createTime: 1793835740000 },
      { orderId: 'b', packageId: 'me_topup_a', status: 'credited', created_at: '1793835840' },
      { orderId: 'c', packageId: 'me_topup_a', status: 'credited', submitted_at: 1793835940000 },
      { orderId: 'd', packageId: 'me_topup_a', status: 'credited', createdAt: '2026-11-09T04:05:40Z' },
    ],
  });
  const orders = await getMeTopupOrders();
  assert.deepEqual(orders.map((order) => order.orderId), ['d', 'c', 'b', 'a']);
  assert.equal(orders[3].createdAt, 1793835740000);
  assert.equal(orders[2].createdAt, 1793835840);
  assert.equal(orders[1].createdAt, 1793835940000);
  assert.equal(orders[0].createdAt, Date.parse('2026-11-09T04:05:40Z'));
});
