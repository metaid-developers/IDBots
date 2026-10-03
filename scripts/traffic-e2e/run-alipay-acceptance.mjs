#!/usr/bin/env node
/**
 * Alipay (当面付) acceptance for the traffic recharge flow — drives
 * docs/gasfee-flow/phase5-alipay-backend-requirements.md §11 against the
 * target deployment (sandbox or live).
 *
 * Real client code paths (compiled dist-electron modules; run
 * `pnpm run compile:electron` first): throwaway identity keygen -> traffic
 * account ensure -> createRechargeOrder(planId, 'alipay') -> qrCode payload
 * assertions -> print a scannable terminal QR -> human pays with the Alipay
 * sandbox buyer app (or a live ¥0.01 payment) -> poll order status until
 * credited -> balance and ledger assertions.
 *
 * Env:
 *   ASSIST_BASE_URL       default https://www.metaso.network/assist-open-api
 *   RECHARGE_PLAN_ID      default cny_1_10mb (must be an active CNY plan)
 *   POLL_MINUTES          default 10 — how long to wait for the human payment
 *   ORDER_ID              skip creation; resume polling this existing order
 *   NO_TERMINAL_QR        set to 1 to print the raw qrCode URL only
 *
 * The throwaway identity mnemonic is cached at .cowork-temp/
 * alipay-e2e-last-identity.json (gitignored, mode 0600) so an ORDER_ID resume
 * can re-attach the same account and still run the balance/ledger assertions.
 * The mnemonic is never printed.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = path.resolve(__dirname, '../../dist-electron/main');

const { mvc } = require('meta-contract');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');
const QRCode = require('qrcode');

const { SqliteStore } = require(path.join(DIST_MAIN, 'sqliteStore.js'));
const { convertToGlobalMetaId } = await import(path.join(DIST_MAIN, 'services/globalMetaid.js'));
const trafficAccountService = await import(path.join(DIST_MAIN, 'services/trafficAccountService.js'));

// ---------------------------------------------------------------------------

const API_BASE = (process.env.ASSIST_BASE_URL || 'https://www.metaso.network/assist-open-api').replace(/\/+$/, '');
const RECHARGE_PLAN_ID = (process.env.RECHARGE_PLAN_ID || 'cny_1_10mb').trim();
const POLL_MINUTES = Math.max(1, Number(process.env.POLL_MINUTES || 10));
const RESUME_ORDER_ID = (process.env.ORDER_ID || '').trim();
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const IDENTITY_CACHE = path.resolve(__dirname, '../../.cowork-temp/alipay-e2e-last-identity.json');

function step(title) {
  console.log(`\n=== ${title} ===`);
}

function printJson(label, value) {
  console.log(`${label}:`, JSON.stringify(value, null, 2));
}

function fail(stepName, error) {
  console.error(`\n[ACCEPTANCE FAIL] ${stepName}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  process.exit(1);
}

function assert(condition, stepName, message) {
  if (!condition) fail(stepName, new Error(message));
}

function deriveWallet(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  const address = child.publicKey.toAddress(network).toString();
  return { address, globalMetaId: convertToGlobalMetaId(address) };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`API base: ${API_BASE}`);
  console.log(`Plan: ${RECHARGE_PLAN_ID}`);

  step('1. Preflight: GET /v1/traffic/pricing shows the CNY plan');
  const pricingRes = await fetch(`${API_BASE}/v1/traffic/pricing`);
  const pricing = await pricingRes.json().catch(() => null);
  assert(pricingRes.status === 200 && pricing?.code === 0, 'pricing', `unexpected response: HTTP ${pricingRes.status}`);
  const plan = (pricing.data ?? []).find((row) => row.planId === RECHARGE_PLAN_ID && row.status === 1);
  assert(plan, 'pricing', `plan ${RECHARGE_PLAN_ID} not active in the pricing table`);
  assert(String(plan.payCurrency).toUpperCase() === 'CNY', 'pricing', `plan ${RECHARGE_PLAN_ID} is not a CNY plan (payCurrency=${plan.payCurrency}) — alipay is CNY-only`);
  printJson('plan', plan);

  let order;
  let balanceBefore = null;

  const initThrowawayService = async (mnemonic) => {
    const phrase = mnemonic || bip39.generateMnemonic(wordlist, 128);
    const identityWallet = deriveWallet(phrase);
    console.log('identity address:', identityWallet.address);
    console.log('identity globalMetaId:', identityWallet.globalMetaId);
    console.log(mnemonic
      ? '(identity restored from the local cache file; mnemonic not printed)'
      : '(mnemonic intentionally not printed)');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-alipay-e2e-'));
    const store = await SqliteStore.create(tmpDir);
    store.set('traffic.mode', 'traffic');
    store.set('traffic.rechargeGateway', 'alipay');
    trafficAccountService.initTrafficAccountService({
      getStore: () => store,
      getMetabotStore: () => ({ listMetabots: () => [], getMetabotWalletById: () => null }),
      getUserIdentityStore: () => ({
        get: () => ({
          id: 1,
          mnemonic: phrase,
          path: WALLET_PATH,
          mvc_address: identityWallet.address,
          globalmetaid: identityWallet.globalMetaId,
          name: 'Alipay E2E Identity',
        }),
      }),
      baseUrl: API_BASE,
    });
    return { identityWallet, mnemonic: phrase };
  };

  if (RESUME_ORDER_ID) {
    step('2-4. Resuming an existing order (no new order creation)');
    let cached = null;
    try {
      cached = JSON.parse(await fs.readFile(IDENTITY_CACHE, 'utf8'));
    } catch {
      console.log(`no identity cache at ${IDENTITY_CACHE}`);
    }
    const reuse = Boolean(cached && cached.orderId === RESUME_ORDER_ID && typeof cached.mnemonic === 'string');
    if (!reuse) {
      console.log('original identity unavailable — balance/ledger assertions will be skipped (order-status transition still verified).');
    }
    await initThrowawayService(reuse ? cached.mnemonic : undefined);
    order = { orderId: RESUME_ORDER_ID, trafficBytes: plan.trafficBytes, payAmount: plan.payAmount, payCurrency: plan.payCurrency };
    if (reuse) {
      await trafficAccountService.ensureTrafficAccount().catch((error) => fail('ensureTrafficAccount', error));
      balanceBefore = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
      console.log('balance before credit (resumed identity):', balanceBefore);
    }
  } else {
    step('2. Generate throwaway identity + init the traffic account service');
    const identity = await initThrowawayService();

    step('3. Ensure traffic account + balance before');
    const account = await trafficAccountService.ensureTrafficAccount().catch((error) => fail('ensureTrafficAccount', error));
    printJson('account', account);
    balanceBefore = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    console.log('balance before recharge:', balanceBefore);

    step('4. Create recharge order (gateway=alipay) — §11.1');
    order = await trafficAccountService.createRechargeOrder(RECHARGE_PLAN_ID, 'alipay')
      .catch((error) => fail('createRechargeOrder', error));
    printJson('created order', order);
    assert(order.orderId, 'createRechargeOrder', 'orderId missing');
    assert(Number(order.payAmount) === Number(plan.payAmount), 'createRechargeOrder', `payAmount ${order.payAmount} != plan ${plan.payAmount}`);
    assert(order.payCurrency === plan.payCurrency, 'createRechargeOrder', `payCurrency ${order.payCurrency} != plan ${plan.payCurrency}`);
    assert(Number(order.trafficBytes) === Number(plan.trafficBytes), 'createRechargeOrder', `trafficBytes ${order.trafficBytes} != plan ${plan.trafficBytes}`);
    const gatewayParams = order.gatewayParams && typeof order.gatewayParams === 'object' ? order.gatewayParams : {};
    const qrCode = String(gatewayParams.qrCode || gatewayParams.qr_code || '').trim();
    assert(qrCode, 'createRechargeOrder', 'qrCode missing in gatewayParams');

    await fs.mkdir(path.dirname(IDENTITY_CACHE), { recursive: true });
    await fs.writeFile(IDENTITY_CACHE, JSON.stringify({ orderId: order.orderId, mnemonic: identity.mnemonic }, null, 2));
    await fs.chmod(IDENTITY_CACHE, 0o600);
    console.log(`identity cached at ${IDENTITY_CACHE} (gitignored, mode 0600) — an ORDER_ID resume reuses it for the balance/ledger assertions`);

    console.log('\n>>> HUMAN ACTION NEEDED: pay this order with the Alipay sandbox buyer app (or a real Alipay account on live):');
    if (process.env.NO_TERMINAL_QR === '1') {
      console.log(`>>> qrCode: ${qrCode}`);
    } else {
      try {
        console.log(await QRCode.toString(qrCode, { type: 'terminal', small: true }));
      } catch {
        console.log(`>>> qrCode: ${qrCode}`);
      }
    }
    console.log(`>>> (order ${order.orderId}; polling for up to ${POLL_MINUTES} min — re-run with ORDER_ID=${order.orderId} to resume)`);
  }

  step('5. Poll order status until credited — §11.2');
  const deadline = Date.now() + POLL_MINUTES * 60_000;
  let finalStatus = null;
  while (Date.now() < deadline) {
    const status = await trafficAccountService.getRechargeOrder(order.orderId)
      .catch((error) => { console.log('  poll error (retrying):', error instanceof Error ? error.message : error); return null; });
    if (status) {
      if (!finalStatus || finalStatus.status !== status.status) {
        printJson('order status', status);
        finalStatus = status;
      }
      if (status.status === 3 || status.status === 4) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert(finalStatus, 'poll', 'no status response within the poll window');
  assert(finalStatus.status !== 4, 'poll', 'order was CLOSED before payment (check the janitor / expiry config)');
  assert(finalStatus.status === 3, 'poll', `order not credited within ${POLL_MINUTES} min (last status ${finalStatus.status}); re-run with ORDER_ID=${order.orderId} to keep waiting`);

  step('6. Balance + ledger assertions — §11.2');
  if (balanceBefore === null) {
    console.log('resumed without the original identity: balance/ledger assertions skipped (the order-status transition above is still verified).');
  } else {
    const balanceAfter = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    console.log(`balance after credit: ${balanceAfter} (before ${balanceBefore}, delta ${balanceAfter - balanceBefore})`);
    assert(balanceAfter - balanceBefore === Number(order.trafficBytes), 'balance', `delta ${balanceAfter - balanceBefore} != trafficBytes ${order.trafficBytes}`);
    const ledger = await trafficAccountService.getTrafficLedger({ limit: 20 });
    const grant = ledger.entries.find((entry) => entry.sourceType === 'recharge_order' && entry.sourceId === order.orderId && entry.direction === 1);
    printJson('recharge ledger entry', grant ?? '(not found)');
    assert(grant, 'ledger', `no grant ledger entry with sourceType=recharge_order sourceId=${order.orderId}`);
    assert(Number(grant.amountBytes) === Number(order.trafficBytes), 'ledger', `ledger amount ${grant.amountBytes} != trafficBytes ${order.trafficBytes}`);
  }

  console.log('\n[ACCEPTANCE OK] §11.1-§11.2 verified end-to-end (Alipay 当面付).');
  console.log('Note: §11.3 duplicate-notify idempotency, §11.4 forged-notify rejection, and §11.6 notify-loss reconciliation are verified by the backend team; §11.8 (24h close of abandoned orders + alipay.trade.close) is covered by their janitor.');
}

main().catch((error) => fail('unexpected', error));
