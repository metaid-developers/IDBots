import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Payment credit channel — measured credit-path ↔ traffic-account
 * reconciliation (acceptance evidence, not a mock-seam self-check).
 *
 * One fake upstream backend serves BOTH services with ONE mutable state:
 * the traffic account balance and the bundle order ledger. The backend
 * credits the account exactly the way the frozen C4 contract describes
 * crediting ("the Alipay webhook marks the order paid; crediting adds
 * trafficBytes"): the first poll after payment flips the order to CREDITED
 * and adds trafficBytes to the account balance. The client then observes —
 * through the REAL getBundleOrder → markVoucherPaid → invalidate cache →
 * getTrafficBalance path — balance X before and X+N after, and asserts the
 * delta equals the voucher's trafficBytes and the upstream orderId matches.
 * No mock seam stands in for the thing being measured.
 */

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  ensureTrafficAccount,
  getTrafficBalance,
  initTrafficAccountService,
  resetTrafficAccountServiceForTests,
} = await import('../dist-electron/main/services/trafficAccountService.js');
const {
  createBundleOrder,
  getBundleOrder,
  getBundleOrderVoucher,
  initBundleService,
  resetBundleServiceForTests,
} = await import('../dist-electron/main/services/bundleService.js');

const IDENTITY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const IDENTITY_GMID = 'idq1localidentity';

function deriveAddress(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  return child.publicKey.toAddress(network).toString();
}

const IDENTITY_ADDRESS = deriveAddress(IDENTITY_MNEMONIC);
const SERVER_ACCOUNT_ID = 'idq1serverderived-account';

const INITIAL_BALANCE_BYTES = 9_961_472; // 9.5 MB — the pre-payment balance
const PLAN_TRAFFIC_BYTES = 104_857_600; // one 19.90 CNY basic bundle
const PLAN_LLM_QUOTA = 2_000_000;
const PAY_AMOUNT = '19.90';

/** Mutable upstream state: balance + order ledger, credited on the payment observation. */
const backend = {
  balanceBytes: INITIAL_BALANCE_BYTES,
  grantedBytesTotal: INITIAL_BALANCE_BYTES,
  spentBytesTotal: 0,
  orderCreditCount: 0,
};

function envelope(data) {
  return JSON.stringify({ code: 0, message: 'success', data });
}

function accountPayload() {
  return {
    accountId: SERVER_ACCOUNT_ID,
    identityAddress: IDENTITY_ADDRESS,
    balanceBytes: backend.balanceBytes,
    reservedBytes: 0,
    grantedBytesTotal: backend.grantedBytesTotal,
    spentBytesTotal: backend.spentBytesTotal,
    status: 1,
  };
}

function orderPayload(orderId, status, now) {
  const base = {
    orderId,
    planId: 'bundle_basic_cny',
    status,
    payAmount: PAY_AMOUNT,
    payCurrency: 'CNY',
    trafficBytes: PLAN_TRAFFIC_BYTES,
    llmQuota: PLAN_LLM_QUOTA,
  };
  if (status >= 2) {
    base.paidAt = now;
    base.creditedAt = now;
  }
  return base;
}

const ORDER_ID = 'bo_reconcile_0001';
let polls = 0;

/** Route one request by (method, pathname); full URLs from both services. */
function makeBackendFetch() {
  return async function fetchStub(url, init = {}) {
    const parsed = new URL(typeof url === 'string' ? url : String(url));
    const method = String(init.method ?? 'GET');
    const pathName = parsed.pathname;
    const now = Math.floor(Date.now() / 1000);

    if (method === 'POST' && pathName === '/v1/traffic/accounts') {
      return new Response(envelope({ ...accountPayload(), accountId: SERVER_ACCOUNT_ID }), { status: 200 });
    }
    if (method === 'GET' && /^\/v1\/traffic\/accounts\/[^/]+\/balance$/.test(pathName)) {
      return new Response(envelope(accountPayload()), { status: 200 });
    }
    if (method === 'POST' && pathName === '/v1/bundle/orders') {
      return new Response(
        envelope({
          ...orderPayload(ORDER_ID, 1, now),
          gatewayParams: { qrCode: 'https://qr.alipay.com/e2e-reconcile', alipayOutTradeNo: ORDER_ID },
          expiresAt: now + 900,
        }),
        { status: 200 },
      );
    }
    if (method === 'GET' && pathName === `/v1/bundle/orders/${ORDER_ID}`) {
      polls += 1;
      if (polls >= 2 && backend.orderCreditCount === 0) {
        // The payment-success crediting event (upstream webhook semantics,
        // frozen contract 01 §Crediting Rules): add trafficBytes exactly once.
        backend.balanceBytes += PLAN_TRAFFIC_BYTES;
        backend.grantedBytesTotal += PLAN_TRAFFIC_BYTES;
        backend.orderCreditCount += 1;
      }
      return new Response(envelope(orderPayload(ORDER_ID, polls >= 2 ? 3 : 1, now)), { status: 200 });
    }
    throw new Error(`backend fetch stub: no route for ${method} ${pathName}`);
  };
}

test('credit path reconciles with the traffic account: balance X → X+N and the voucher matches', async () => {
  const fetchStub = makeBackendFetch();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-credit-balance-'));
  const store = await SqliteStore.create(dir);
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
    getMetabotStore: () => ({ listMetabots: () => [], getMetabotWalletById: () => null }),
    getUserIdentityStore: () => fakeIdentityStore,
    fetchImpl: fetchStub,
    baseUrl: 'https://upstream.test',
  });

  resetBundleServiceForTests();
  initBundleService({
    getStore: () => store,
    getUserIdentityStore: () => fakeIdentityStore,
    fetchImpl: fetchStub,
    baseUrl: 'https://upstream.test',
  });

  await ensureTrafficAccount();

  // (1) 授信前：traffic 账户真实余额 X（9.5 MB 初始额度）。
  const before = await getTrafficBalance();
  assert.equal(before.accountId, SERVER_ACCOUNT_ID);
  assert.equal(before.balanceBytes, INITIAL_BALANCE_BYTES);

  // (2) 下单：客户端保存本地订单凭证（orderId + planId + 金额 + 时间）。
  const order = await createBundleOrder({ planId: 'bundle_basic_cny' });
  assert.equal(order.orderId, ORDER_ID);
  const voucherAtCreate = getBundleOrderVoucher(ORDER_ID);
  assert.ok(voucherAtCreate, 'a voucher must be persisted at create time');
  assert.equal(voucherAtCreate.payAmount, PAY_AMOUNT);
  assert.equal(voucherAtCreate.trafficBytes, PLAN_TRAFFIC_BYTES);
  assert.ok(Number.isInteger(voucherAtCreate.createdAt) && voucherAtCreate.createdAt > 0);
  assert.strictEqual(voucherAtCreate.paidAt, undefined);

  // (3) 第一次轮询：订单已创建未支付。余额读取仍命中缓存 = X
  //     （缓存此时并没有被错误地提前清掉）。
  const status1 = await getBundleOrder({ orderId: ORDER_ID });
  assert.equal(status1.status, 1);
  assert.equal(await getTrafficBalance().then((t) => t.balanceBytes), INITIAL_BALANCE_BYTES);

  // (4) 第二次轮询：观察到支付成功（上游在这次读数里完成授信记账）。
  //     客户端路径触发：voucher 落 paid/credited + 清余额缓存。
  const status2 = await getBundleOrder({ orderId: ORDER_ID });
  assert.equal(status2.status, 3);
  assert.ok(status2.paidAt > 0 && status2.creditedAt > 0);

  // (5) 授信后：不刷新强制读，直接取 → 必须看到 X+N。
  //     （若缓存未被支付成功路径清掉，这里会读到陈旧的 X，测试失败。）
  const after = await getTrafficBalance();
  const delta = after.balanceBytes - before.balanceBytes;
  assert.equal(delta, PLAN_TRAFFIC_BYTES, `balance must move X → X+N (observed +${delta}, expected +${PLAN_TRAFFIC_BYTES})`);
  assert.equal(after.grantedBytesTotal - before.grantedBytesTotal, PLAN_TRAFFIC_BYTES);

  // (6) 凭证与上游 orderId、金额可对照：本地记录 = 一手账本。
  const voucher = getBundleOrderVoucher(ORDER_ID);
  assert.ok(voucher.paidAt > 0 && voucher.creditedAt > 0);
  assert.equal(voucher.orderId, ORDER_ID);
  assert.equal(voucher.trafficBytes, PLAN_TRAFFIC_BYTES);
  assert.equal(voucher.payAmount, PAY_AMOUNT);

  // (7) 幂等：再轮询一次，凭证不被二次盖戳，余额不变（X+N 仍读得回）。
  const paidAt = voucher.paidAt;
  await getBundleOrder({ orderId: ORDER_ID });
  const voucherAgain = getBundleOrderVoucher(ORDER_ID);
  assert.equal(voucherAgain.paidAt, paidAt, 'repeated polls must not re-stamp the voucher');
  assert.equal((await getTrafficBalance()).balanceBytes, INITIAL_BALANCE_BYTES + PLAN_TRAFFIC_BYTES);
  assert.equal(backend.orderCreditCount, 1, 'upstream credited exactly once');

  resetTrafficAccountServiceForTests();
  resetBundleServiceForTests();
  await store.close?.();
  await fs.rm(dir, { recursive: true, force: true });
});
