import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

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
  setMePointSettings,
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

test('auto-deduct toggle persists through the mePoints IPC pair (default ON)', () => {
  // Renderer: optimistic toggle + kv-backed persistence via the mePoints surface.
  assert.match(packCardSource, /getPointsSettings/);
  assert.match(packCardSource, /setPointsSettings\(\{ autoDeductFromPersistent/);
  // Preload + typed surface + main handler channels.
  assert.match(preloadSource, /invoke\('me:getPointsSettings'\)/);
  assert.match(preloadSource, /invoke\('me:setPointsSettings', input \?\? \{\}\)/);
  assert.match(typesSource, /autoDeductFromPersistent: boolean/);
  assert.match(pointsServiceSource, /wrap\('me:getPointsSettings'/);
  assert.match(pointsServiceSource, /wrap\('me:setPointsSettings'/);
  assert.match(pointsServiceSource, /getSettingsStore\?: \(\) => MePointSettingsStore \| null/);
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

test('mePointSettings get/set round-trips through the kvStore shape', () => {
  // Unset / unreadable store → default ON, never throws.
  assert.deepEqual(getMePointSettings(null), { autoDeductFromPersistent: true });
  assert.deepEqual(getMePointSettings({ get() { throw new Error('not ready'); } }), { autoDeductFromPersistent: true });

  const store = fakeStore();
  assert.deepEqual(getMePointSettings(store), { autoDeductFromPersistent: true });

  assert.deepEqual(setMePointSettings(store, { autoDeductFromPersistent: false }), { autoDeductFromPersistent: false });
  assert.equal(store.map.get('me.persistentAutoDeduct'), false);
  assert.deepEqual(getMePointSettings(store), { autoDeductFromPersistent: false });

  // Partial update keeps the stored value; garbage values normalize to ON.
  assert.deepEqual(setMePointSettings(store, {}), { autoDeductFromPersistent: false });
  assert.deepEqual(setMePointSettings(store, { autoDeductFromPersistent: 'yes' }), { autoDeductFromPersistent: true });

  // Persistence loss is non-fatal: the returned snapshot still reflects intent.
  const brokenStore = { get: () => undefined, set: () => { throw new Error('locked'); } };
  assert.deepEqual(setMePointSettings(brokenStore, { autoDeductFromPersistent: false }), { autoDeductFromPersistent: false });
});
