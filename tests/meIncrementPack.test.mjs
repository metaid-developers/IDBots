import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

// Signing fixtures for the /v1/me/settings contract test (same wallet as
// mePointsHistory.test.mjs so the BSMA verification behaves identically).
const { mvc } = require('meta-contract');
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const network = mvc.Networks.livenet;
const child = mvc.Mnemonic.fromString(MNEMONIC).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
const ADDRESS = child.publicKey.toAddress(network).toString();

function verifyCall(call, action) {
  const timestamp = Number(call.init.headers['X-Timestamp']);
  assert.equal(call.init.headers['X-Identity-Address'], ADDRESS);
  const message = `me:${action}:${timestamp / 1000}`;
  assert.equal(mvc.Message(message).verify(ADDRESS, call.init.headers['X-Signature']), true);
}

const settingsSource = read('src/renderer/components/Settings.tsx');
const appSource = read('src/renderer/App.tsx');
const packCardSource = read('src/renderer/components/me/MeIncrementPackCard.tsx');
const purchaseFlowSource = read('src/renderer/components/me/MePurchaseFlow.tsx');
const usageSource = read('src/renderer/components/me/MeUsageAndCredits.tsx');
const paymentSource = read('src/renderer/components/me/mePayment.ts');
const serviceSource = read('src/main/services/mePointSettings.ts');
const pointsServiceSource = read('src/main/services/mePointsService.ts');
const i18nSource = read('src/renderer/services/i18n.ts');
const preloadSource = read('src/main/preload.ts');
const typesSource = read('src/renderer/types/electron.d.ts');

const {
  ME_PERSISTENT_AUTO_DEDUCT_KEY,
  normalizeAutoDeductFromPersistent,
  getMePointSettings,
  mirrorMePointSettings,
} = require('../dist-electron/main/services/mePointSettings.js');

function fakeStore(initialEntries = []) {
  const map = new Map(initialEntries);
  return {
    map,
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      map.set(key, value);
    },
  };
}

test('credit pack card lives on the subscription pane above the test-connection button', () => {
  const insertBlock = settingsSource.match(
    /activeProvider === LLM_FREE_PROVIDER_KEY && \(\s*<div className="space-y-3">[\s\S]*?<\/section>|activeProvider === LLM_FREE_PROVIDER_KEY && \(\s*<div className="space-y-3">[\s\S]*?\)\s*\}/,
  );
  assert.ok(insertBlock, 'ID.Bots subscription insert block missing');
  assert.match(insertBlock[0], /<IdbotsPlanCard \/>/);
  assert.match(insertBlock[0], /<FreeQuotaCard/);
  assert.match(insertBlock[0], /<MeIncrementPackCard \/>/);
  // The pack card must sit above the shared 测试连接 button.
  const cardAt = settingsSource.indexOf('<MeIncrementPackCard />');
  const testButtonAt = settingsSource.indexOf('onClick={handleTestConnection}');
  assert.ok(cardAt >= 0 && testButtonAt >= 0 && cardAt < testButtonAt);
});

test('the old ID.Bots top-up pseudo-entry is fully retired', () => {
  assert.equal(settingsSource.includes('IDBOTS_RECHARGE_PROVIDER_KEY'), false);
  assert.equal(settingsSource.includes('idbots-recharge'), false);
  assert.equal(settingsSource.includes('renderRechargeRow'), false);
  assert.equal(i18nSource.includes('idbotsRechargeProvider'), false);
  assert.equal(i18nSource.includes('idbotsRechargePlaceholder'), false);
});

test('credit pack card shows the persistent bucket with buy/details entry points', () => {
  // Persistent bucket only (never the weekly grant) — the pack total must
  // never mix the weekly grant in; the grant is read solely by the
  // exhausted-grant hint (2026-11-11).
  assert.match(packCardSource, /persistent\?\.topupMilli/);
  assert.match(packCardSource, /persistent\?\.earnedMilli/);
  assert.match(packCardSource, /persistent\?\.bonusMilli/);
  assert.doesNotMatch(packCardSource, /packTotalMe = [^;]*weeklyGrant/);
  // Sources breakdown reuses the shared panel labels.
  assert.match(packCardSource, /mePanelTopup/);
  assert.match(packCardSource, /mePanelBonus/);
  assert.match(packCardSource, /mePanelEarned/);
  // 「购买额度」 opens the shared purchase modal on its topup section;
  // 「查看获得详情」 jumps to the 用量&积分 page.
  assert.match(packCardSource, /requestOpenMePurchase\('topup'\)/);
  assert.match(packCardSource, /requestOpenUsagePage\(\)/);
  // Copy says the pack never resets / is never weekly-cleared.
  assert.match(packCardSource, /meIncrementPackNote/);
  // Exhausted-grant hint: grant out + pack holds credit + auto-deduct OFF —
  // say why spending fails, next to the switch that fixes it.
  assert.match(packCardSource, /grantExhaustedPackUsable/);
  assert.match(packCardSource, /meIncrementPackExhaustedHint/);
  assert.match(packCardSource, /data-testid="me-increment-pack-exhausted-hint"/);
  const zh = i18nSource.indexOf("meIncrementPackExhaustedHint: '");
  assert.ok(zh > 0, 'zh hint key missing');
  assert.ok(i18nSource.indexOf("meIncrementPackExhaustedHint: '", zh + 1) > 0, 'en hint key missing');
});

test('usage-page re-requests re-fire the tab effect while Settings stays mounted', () => {
  // Regression pin: 查看获得详情 died after its first jump — the Settings tab
  // effect watched [initialTab] only, so a second me:openUsage request set the
  // same prop value and never re-fired while Settings sat on the 模型 tab.
  // The host now bumps a requestNonce on EVERY open request and the effect
  // depends on [initialTab, requestNonce]; both Settings render sites pass it.
  assert.match(appSource, /requestNonce: \(prev\?\.requestNonce \?\? 0\) \+ 1/);
  assert.ok(
    appSource.split('requestNonce={settingsOptions.requestNonce}').length - 1 >= 2,
    'every <Settings> mount must receive requestNonce',
  );
  assert.match(settingsSource, /\}, \[initialTab, requestNonce\]\);/);
});

test('auto-deduct toggle is server-authoritative with a kvStore mirror fallback', () => {
  // Renderer: optimistic toggle via the mePoints surface; failure reverts + flags.
  assert.match(packCardSource, /getPointsSettings/);
  assert.match(packCardSource, /setPointsSettings\(\{ autoDeductFromPersistent/);
  assert.match(packCardSource, /meIncrementPackToggleFailed/);
  // Preload + typed surface + main handler channels.
  assert.match(preloadSource, /invoke\('me:getPointsSettings'\)/);
  assert.match(preloadSource, /invoke\('me:setPointsSettings', input \?\? \{\}\)/);
  assert.match(typesSource, /autoDeductFromPersistent: boolean/);
  assert.match(typesSource, /type MePointsSettingsSource = 'server' \| 'local'/);
  assert.match(pointsServiceSource, /wrap\('me:getPointsSettings'/);
  assert.match(pointsServiceSource, /wrap\('me:setPointsSettings'/);
  assert.match(pointsServiceSource, /getSettingsStore\?: \(\) => MePointSettingsStore \| null/);
  // The settings endpoints are pinned constants (path + both signed actions).
  assert.match(pointsServiceSource, /ME_SETTINGS_PATH = '\/v1\/me\/settings'/);
  assert.match(pointsServiceSource, /ME_GET_SETTINGS_ACTION = 'get_me_settings'/);
  assert.match(pointsServiceSource, /ME_SET_SETTINGS_ACTION = 'set_me_settings'/);
  // GET falls back to the kvStore mirror only on failure; writes NEVER fall
  // back (a set must reach the server or surface as an error) and only
  // mirror AFTER a server confirmation.
  assert.match(pointsServiceSource, /const remote = await getMeSettings\(\);[\s\S]*?mirrorMePointSettings\([\s\S]*?source: 'server'[\s\S]*?\} catch \{[\s\S]*?getMePointSettings\([\s\S]*?source: 'local'/);
  assert.match(pointsServiceSource, /const remote = await setMeSettings\(requested\);[\s\S]*?mirrorMePointSettings/);
});

test('mePointSettings defaults ON and only an explicit false turns it off', () => {
  assert.equal(ME_PERSISTENT_AUTO_DEDUCT_KEY, 'me.persistentAutoDeduct');
  assert.equal(normalizeAutoDeductFromPersistent(undefined), true);
  assert.equal(normalizeAutoDeductFromPersistent(null), true);
  assert.equal(normalizeAutoDeductFromPersistent(true), true);
  assert.equal(normalizeAutoDeductFromPersistent(false), false);
  assert.equal(normalizeAutoDeductFromPersistent('false'), true);
  assert.equal(normalizeAutoDeductFromPersistent(0), true);
});

test('mePointSettings mirror + degraded read round-trip through the kvStore shape', () => {
  // Unset / unreadable store → default ON, never throws.
  assert.deepEqual(getMePointSettings(null), { autoDeductFromPersistent: true });
  assert.deepEqual(getMePointSettings({ get() { throw new Error('not ready'); } }), { autoDeductFromPersistent: true });

  const store = fakeStore();
  assert.deepEqual(getMePointSettings(store), { autoDeductFromPersistent: true });

  // The mirror records only server-confirmed values (strict booleans).
  mirrorMePointSettings(store, false);
  assert.equal(store.map.get('me.persistentAutoDeduct'), false);
  assert.deepEqual(getMePointSettings(store), { autoDeductFromPersistent: false });
  mirrorMePointSettings(store, true);
  assert.equal(store.map.get('me.persistentAutoDeduct'), true);
  assert.deepEqual(getMePointSettings(store), { autoDeductFromPersistent: true });

  // Mirror loss is non-fatal: the next successful server read re-seeds it.
  const brokenStore = { get: () => undefined, set: () => { throw new Error('locked'); } };
  assert.doesNotThrow(() => mirrorMePointSettings(brokenStore, false));
});

test('getMeSettings/setMeSettings sign the pinned actions and normalize strictly', async () => {
  const { getMeSettings, setMeSettings, initMePointsService, ME_SETTINGS_PATH, ME_GET_SETTINGS_ACTION, ME_SET_SETTINGS_ACTION } =
    await import('../dist-electron/main/services/mePointsService.js');
  assert.equal(ME_SETTINGS_PATH, '/v1/me/settings');
  assert.equal(ME_GET_SETTINGS_ACTION, 'get_me_settings');
  assert.equal(ME_SET_SETTINGS_ACTION, 'set_me_settings');

  const calls = [];
  let respond = () => ({ code: 0, message: 'ok', data: { identityAddress: ADDRESS, autoDeductFromPersistent: false } });
  initMePointsService({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => respond() };
    },
    getUserIdentityStore: () => ({
      get: () => ({ id: 1, mnemonic: MNEMONIC, path: WALLET_PATH, mvc_address: ADDRESS, name: 'Owner' }),
    }),
  });

  // GET: path + signed get_me_settings + strict-normalized view.
  const got = await getMeSettings();
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname.endsWith(ME_SETTINGS_PATH), true);
  assert.equal(calls[0].init.method, 'GET');
  verifyCall(calls[0], ME_GET_SETTINGS_ACTION);
  assert.deepEqual(got, { identityAddress: ADDRESS, autoDeductFromPersistent: false });

  // POST: strict boolean body rides the request; set_me_settings signs it.
  respond = () => ({ code: 0, message: 'ok', data: { identityAddress: ADDRESS, autoDeductFromPersistent: true } });
  const set = await setMeSettings(true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { autoDeductFromPersistent: true });
  verifyCall(calls[1], ME_SET_SETTINGS_ACTION);
  assert.equal(set.autoDeductFromPersistent, true);

  // A READ missing the field (older server) reads as ON, never OFF.
  respond = () => ({ code: 0, message: 'ok', data: {} });
  const defaulted = await getMeSettings();
  assert.equal(defaulted.autoDeductFromPersistent, true);

  // Non-boolean never leaves the client.
  await assert.rejects(() => setMeSettings('yes'), /must be a boolean/);
});

test('getMeBalance keeps the auto-deduct echo and spendableMilli, absent when not reported', async () => {
  const { getMeBalance, initMePointsService } = await import('../dist-electron/main/services/mePointsService.js');
  let respond = () => ({
    code: 0,
    message: 'ok',
    data: {
      identityAddress: ADDRESS,
      weeklyGrant: { amountMilli: 2_000_000, remainingMilli: 1_500_000, nextResetAt: 1 },
      persistent: { topupMilli: 30_000_000, earnedMilli: 0, bonusMilli: 0 },
      frozenMilli: 0,
      totalAvailable: 31_500_000,
      autoDeductFromPersistent: false,
      spendableMilli: 1_500_000,
    },
  });
  initMePointsService({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => respond() }),
    getUserIdentityStore: () => ({
      get: () => ({ id: 1, mnemonic: MNEMONIC, path: WALLET_PATH, mvc_address: ADDRESS, name: 'Owner' }),
    }),
  });

  const echoed = await getMeBalance({ forceRefresh: true });
  assert.equal(echoed.autoDeductFromPersistent, false);
  // Grant-only: the persistent 30,000 ME are not spendable.
  assert.equal(echoed.spendableMilli, 1_500_000);

  // Older servers omit both fields: they stay absent (never false / 0).
  respond = () => ({ code: 0, message: 'ok', data: { weeklyGrant: {}, persistent: {} } });
  const legacy = await getMeBalance({ forceRefresh: true });
  assert.equal('autoDeductFromPersistent' in legacy, false);
  assert.equal('spendableMilli' in legacy, false);

  // An unparseable spendable figure must not read as "0 ME left".
  respond = () => ({ code: 0, message: 'ok', data: { spendableMilli: 'n/a' } });
  assert.equal('spendableMilli' in (await getMeBalance({ forceRefresh: true })), false);
});

test('payment UX honesty: topup intro, code expiry, stale-unpaid orders, gateway fallback', () => {
  // Topup section carries the corrected credit-pack intro (pack ME never
  // expires, giftable, auto-continues paying after the weekly quota dies).
  assert.match(purchaseFlowSource, /mePurchaseTopupIntro/);
  assert.match(i18nSource, /mePurchaseTopupIntro: '充值所得 ME 直接进入「积分增量包」/);
  // The payment-code deadline renders ONLY from a server-provided expiresAt —
  // never a hardcoded validity claim.
  assert.match(purchaseFlowSource, /checkout\.expiresAt\s*\n\s*\? i18nService\.t\('mePurchaseQrExpiryAt'\)/);
  assert.match(paymentSource, /expiresAt\?: number/);
  assert.match(paymentSource, /export function extractMeExpiresAt/);
  // Gateway not enabled / temporarily down server-side → friendly
  // per-gateway copy keyed on data.errorCode, never the raw envelope
  // message ("error").
  assert.match(purchaseFlowSource, /meCheckoutErrorKey\(errorCode, orderError\)/);
  assert.match(paymentSource, /GATEWAY_NOT_CONFIGURED/);
  assert.match(paymentSource, /GATEWAY_UNAVAILABLE/);
  assert.match(i18nSource, /mePurchaseGatewayUnavailable/);
  // Usage page: subscription orders unpaid past 2h render 超时未支付 (gray,
  // not the live amber 提交中) and stop driving the 20s status poll.
  assert.match(usageSource, /ME_UNPAID_ORDER_STALE_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(usageSource, /isStaleUnpaidSubscriptionOrder/);
  assert.match(usageSource, /row\.staleUnpaid \? i18nService\.t\('meUsageOrderStale'\) : orderStatusLabel\(row\.status\)/);
  assert.match(usageSource, /!isStaleUnpaidSubscriptionOrder\(order, now\) && pendingLive\(order\.status\)/);
  assert.match(i18nSource, /meUsageOrderStale: '超时未支付'/);
});

test('d16681f server contract lands without further client changes; closed ≠ rejected', () => {
  // assist-base-service d16681f: topup gateway checkout returns the order view
  // at data top-level with gatewayParams(qrCode + expiresAt copy) — the
  // desktop normalizer reads those exact fields; no client change needed.
  assert.match(pointsServiceSource, /order: normalizeMeTopupOrder\(data\)/);
  assert.match(pointsServiceSource, /gatewayParams: record\.gatewayParams \?\? record\.gateway_params/);
  // Janitor-expired orders close with statusText "closed" — shown as 已关闭,
  // never as the admin-rejection wording 已拒绝.
  assert.match(usageSource, /\/reject\|fail\/i\.test\(normalized\)\s*\n\s*\? i18nService\.t\('meOrderStatusRejected'\)/);
  assert.match(i18nSource, /meOrderStatusClosed: '已关闭'/);
  assert.match(i18nSource, /meOrderStatusClosed: 'Closed'/);
});

test('credits & traffic tab hosts two sub-pages (credits default, traffic restored verbatim)', () => {
  // The on-chain traffic page is imported back and rendered verbatim as the
  // second sub-tab; ME credits stay the default landing page.
  assert.match(settingsSource, /import TrafficSettings from '\.\/traffic\/TrafficSettings';/);
  assert.match(settingsSource, /const \[creditsSubTab, setCreditsSubTab\] = useState<'credits' \| 'traffic'>\('credits'\)/);
  assert.match(settingsSource, /creditsSubTab === 'credits' \? <MeUsageAndCredits \/> : <TrafficSettings \/>/);
  assert.match(settingsSource, /usageCreditsSubTabCredits/);
  assert.match(settingsSource, /usageCreditsSubTabTraffic/);
  // Sidebar label renamed, zh + en.
  assert.match(i18nSource, /usageCreditsTab: '积分 & 流量'/);
  assert.match(i18nSource, /usageCreditsTab: 'Credits & Traffic'/);
  assert.match(i18nSource, /usageCreditsSubTabCredits: '积分'/);
  assert.match(i18nSource, /usageCreditsSubTabTraffic: '流量'/);
});

test('credits overview card uses 增量包（不过期） layout and usage header adds 购买积分 left of refresh', () => {
  const overviewSource = read('src/renderer/components/me/MeBalanceOverviewCard.tsx');
  assert.match(i18nSource, /meIncrementPackBuy: '购买积分'/);
  assert.match(i18nSource, /meUsagePersistent: '增量包（不过期）'/);
  assert.match(overviewSource, /packTotalMe = topupMe \+ bonusMe \+ earnedMe/);
  assert.match(overviewSource, /formatMe\(packTotalMe\)/);
  assert.match(overviewSource, /mePanelTopup/);
  assert.match(overviewSource, /mePanelBonus/);
  assert.match(overviewSource, /mePanelEarned/);

  const buyIdx = usageSource.indexOf("data-slot=\"me-usage-buy-credits\"");
  const refreshIdx = usageSource.indexOf("i18nService.t('freeQuotaRefresh')");
  assert.ok(buyIdx >= 0 && refreshIdx > buyIdx, '购买积分 button must sit left of refresh');
  assert.match(usageSource, /requestOpenMePurchase\('topup'\)/);
  assert.match(usageSource, /i18nService\.t\('meIncrementPackBuy'\)/);
});
