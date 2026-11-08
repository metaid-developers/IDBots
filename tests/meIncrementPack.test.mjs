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
const packCardSource = read('src/renderer/components/me/MeIncrementPackCard.tsx');
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
  // Persistent bucket only (never the weekly grant).
  assert.match(packCardSource, /persistent\?\.topupMilli/);
  assert.match(packCardSource, /persistent\?\.earnedMilli/);
  assert.match(packCardSource, /persistent\?\.bonusMilli/);
  assert.equal(packCardSource.includes('weeklyGrant'), false);
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
