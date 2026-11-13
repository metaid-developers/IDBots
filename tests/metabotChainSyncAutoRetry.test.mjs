/**
 * Unattended chain-sync recovery for a bot's unpublished profile steps
 * (2026-11-13 first-run Twin: bio/persona/llm/chatSkills failed on a
 * just-granted subsidy, then a rename wiped them from the pending plan).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const {
  updateMetaBotCore,
  readChainSyncPending,
  recordFullSyncOutcome,
  resyncPendingChainStepsCore,
  listAutoResyncCandidates,
} = require('../dist-electron/main/services/metabotManageService.js');
const { createMetabotChainSyncAutoRetry } = require('../dist-electron/main/services/metabotChainSyncAutoRetry.js');

const opened = [];
const openStore = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-chain-auto-'));
  const sqlite = await SqliteStore.create(tempDir);
  opened.push({ sqlite, tempDir });
  return new MetabotStore(sqlite.getDatabase(), sqlite.getSaveFunction());
};
test.after(() => {
  for (const { sqlite, tempDir } of opened) {
    try { sqlite.getDatabase().close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* harmless leftover */ }
  }
});

let seq = 0;
const seedMetabot = (store, name) => {
  seq += 1;
  const wallet = store.insertMetabotWallet({ mnemonic: `m-${seq}`, path: "m/44'/10001'/0'/0/0" });
  return store.createMetabot({
    wallet_id: wallet.id,
    mvc_address: `mvc-${seq}`,
    btc_address: `btc-${seq}`,
    doge_address: `doge-${seq}`,
    public_key: `pk-${seq}`,
    chat_public_key: `cpk-${seq}`,
    chat_public_key_pin_id: 'cpk-pin',
    name,
    enabled: true,
    metaid: `metaid-${seq}`,
    globalmetaid: `gmid-${seq}`,
    metabot_info_pinid: null,
    metabot_type: 'twin',
    created_by: '0000',
    role: 'r',
    soul: 's',
    llm_id: 'deepseek',
  });
};

const syncedFromFlags = (input) => Object.entries(input)
  .filter(([key, value]) => key.startsWith('sync') && value === true)
  .map(([key]) => ({ syncChatSkills: 'chatSkills', syncNftAvatar: 'nftAvatar' }[key] ?? key.replace('sync', '').toLowerCase()));

const deps = (store, overrides = {}) => ({
  store,
  createWallet: async () => { throw new Error('unused'); },
  requestSubsidy: async () => ({ success: true }),
  signOwnerBinding: async () => ({ payload: 'p' }),
  syncToChain: async () => ({ success: true }),
  syncEditChanges: overrides.syncEditChanges ?? (async (_store, input) => ({ success: true, txids: ['tx'], syncedSteps: syncedFromFlags(input) })),
  getOwnerGlobalMetaId: () => null,
  getLlmProviders: () => undefined,
});

test('an edit sync keeps the steps an earlier attempt still owes', async () => {
  const store = await openStore();
  const bot = seedMetabot(store, 'Bit');
  recordFullSyncOutcome(store, bot.id, {
    plannedSteps: ['name', 'avatar', 'chatpubkey', 'bio', 'persona', 'llm', 'chatSkills'],
    syncedSteps: ['name', 'avatar', 'chatpubkey'],
    error: 'Not enough balance',
  });
  const result = await updateMetaBotCore(bot.id, { name: 'Jarvis' }, deps(store));
  assert.equal(result.success, true);
  assert.deepEqual(readChainSyncPending(store, bot.id)?.remainingSteps, ['bio', 'persona', 'llm', 'chatSkills'],
    'the rename settles only its own step');
});

test('resyncPendingChainStepsCore republishes exactly the auto-resyncable pending steps', async () => {
  const store = await openStore();
  const bot = seedMetabot(store, 'Resync');
  recordFullSyncOutcome(store, bot.id, { plannedSteps: ['bio', 'persona', 'llm', 'chatSkills', 'owner'], syncedSteps: [] });
  const calls = [];
  const result = await resyncPendingChainStepsCore(bot.id, deps(store, {
    syncEditChanges: async (_store, input) => {
      calls.push(input);
      return { success: true, syncedSteps: syncedFromFlags(input) };
    },
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].syncBio && calls[0].syncPersona && calls[0].syncLlm && calls[0].syncChatSkills, true);
  assert.equal(calls[0].syncName, false, 'confirmed steps are never republished');
  assert.equal(calls[0].syncOwner, false, 'owner needs a fresh signature — left to the manual path');
  assert.deepEqual(result.attemptedSteps, ['bio', 'persona', 'llm', 'chatSkills']);
  assert.equal(result.success, true);
  assert.deepEqual(result.remainingSteps, ['owner']);
  assert.deepEqual(listAutoResyncCandidates(store).includes(bot.id), false, 'only owner left: no longer a candidate');
});

test('listAutoResyncCandidates skips bots whose subsidy was never claimed', async () => {
  const store = await openStore();
  const funded = seedMetabot(store, 'Funded');
  const unfunded = seedMetabot(store, 'Unfunded');
  recordFullSyncOutcome(store, funded.id, { plannedSteps: ['bio'], syncedSteps: [] });
  recordFullSyncOutcome(store, unfunded.id, { plannedSteps: ['bio'], syncedSteps: [] });
  store.setMetabotSetting(unfunded.id, 'subsidyState', JSON.stringify({ state: 'failed' }));
  const candidates = listAutoResyncCandidates(store);
  assert.ok(candidates.includes(funded.id));
  assert.ok(!candidates.includes(unfunded.id));
});

function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = timers.filter((timer) => !timer.cancelled && timer.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        due.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('scheduler retries on backoff, stops on success, and gives up after the last delay', async () => {
  const clock = fakeClock();
  const pending = new Map([[1, ['bio']], [2, ['persona']]]);
  const attempts = [];
  const progress = [];
  const retry = createMetabotChainSyncAutoRetry({
    delaysMs: [10, 20, 40],
    now: clock.now,
    setTimer: clock.setTimer,
    listCandidates: () => [...pending.keys()],
    resync: async (id) => {
      attempts.push({ id, at: clock.now() });
      if (id === 1 && attempts.filter((entry) => entry.id === 1).length === 2) {
        pending.delete(1);
        return { attemptedSteps: ['bio'], success: true, remainingSteps: [] };
      }
      return { attemptedSteps: pending.get(id), success: false, remainingSteps: pending.get(id), error: 'Not enough balance' };
    },
    onProgress: (id) => progress.push(id),
  });
  retry.kick();
  retry.kick();
  await clock.advance(5);
  assert.equal(attempts.length, 0, 'the first attempt waits for the first delay');
  await clock.advance(5);
  assert.deepEqual(attempts.map((entry) => entry.id), [1, 2]);
  await clock.advance(20);
  assert.deepEqual(attempts.map((entry) => entry.id), [1, 2, 1, 2]);
  assert.deepEqual(progress, [1], 'progress fires when a step was published');
  await clock.advance(1000);
  assert.equal(attempts.filter((entry) => entry.id === 1).length, 2, 'a recovered bot is not retried again');
  assert.equal(attempts.filter((entry) => entry.id === 2).length, 3, 'a stuck bot stops after the last delay');
  retry.dispose();
});
