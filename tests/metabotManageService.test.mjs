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
  createMetaBotOnChainCore,
  applyMetabotUpdateLocal,
  buildEditSyncFlags,
  updateMetaBotCore,
  deleteMetaBotCore,
  listMetabotsForManagement,
  listConfiguredLlmProviders,
  readMetabotSubsidyState,
  requireMetabotLlmIdForCreate,
  resumeMetabotSetupCore,
  legacyLlmProviderKeyError,
  assertCanCreateMetabot,
  applyChatSkillOp,
} = require('../dist-electron/main/services/metabotManageService.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metabot-manage-'));

const openStore = async () => {
  const tempDir = makeTempDir();
  const sqlite = await SqliteStore.create(tempDir);
  const store = new MetabotStore(sqlite.getDatabase(), sqlite.getSaveFunction());
  store.__sqlite = sqlite;
  store.__tempDir = tempDir;
  return store;
};

const closeStore = (store) => {
  try { store.__sqlite?.close(); } catch { /* best-effort cleanup */ }
  try { fs.rmSync(store.__tempDir, { recursive: true, force: true }); } catch { /* OS sweeps leftovers */ }
};

const fakeWallet = (n) => ({
  mnemonic: `mnemonic-${n}`,
  path: "m/44'/10001'/0'/0/0",
  mvc_address: `mvc-${n}`,
  btc_address: `btc-${n}`,
  doge_address: `doge-${n}`,
  public_key: `pk-${n}`,
  chat_public_key: `cpk-${n}`,
  metaid: `metaid-${n}`,
  globalmetaid: `gmid-${n}`,
});

/** Seed a wallet + metabot directly via the store (bypasses on-chain create). */
const seedMetabot = (store, { name, type = 'worker', llm_id = 'deepseek', n = Math.floor(Math.random() * 1e9) }) => {
  const wallet = store.insertMetabotWallet({ mnemonic: fakeWallet(n).mnemonic, path: fakeWallet(n).path });
  return store.createMetabot({
    wallet_id: wallet.id,
    mvc_address: fakeWallet(n).mvc_address,
    btc_address: fakeWallet(n).btc_address,
    doge_address: fakeWallet(n).doge_address,
    public_key: fakeWallet(n).public_key,
    chat_public_key: fakeWallet(n).chat_public_key,
    chat_public_key_pin_id: null,
    name,
    enabled: true,
    metaid: fakeWallet(n).metaid,
    globalmetaid: fakeWallet(n).globalmetaid,
    metabot_type: type,
    created_by: '0000',
    role: '',
    soul: '',
    llm_id: llm_id,
  });
};

/** Map an edit-sync input's true flags to real step keys (matches main's syncedSteps format). */
const STEP_FLAG_PAIRS = [
  ['name', 'syncName'],
  ['avatar', 'syncAvatar'],
  ['nftAvatar', 'syncNftAvatar'],
  ['bio', 'syncBio'],
  ['persona', 'syncPersona'],
  ['llm', 'syncLlm'],
  ['chatSkills', 'syncChatSkills'],
  ['homepage', 'syncHomepage'],
  ['owner', 'syncOwner'],
];

const stepsFromInput = (input) =>
  STEP_FLAG_PAIRS.filter(([, flag]) => input[flag] === true).map(([step]) => step);

/** Mock chain deps; each field is overridable per-test. */
const mockDeps = (store, overrides = {}) => ({
  store,
  createWallet: overrides.createWallet ?? (async () => fakeWallet(1000)),
  requestSubsidy: overrides.requestSubsidy ?? (async () => ({ success: true })),
  signOwnerBinding:
    overrides.signOwnerBinding ?? (async () => ({ payload: 'signed-owner-payload' })),
  syncToChain:
    overrides.syncToChain ??
    (async () => ({ success: true, txids: ['tx-create-1'] })),
  syncEditChanges:
    overrides.syncEditChanges ??
    (async (_store, input) => ({
      success: true,
      txids: ['tx-edit-1'],
      syncedSteps: stepsFromInput(input),
    })),
  ...(overrides.prepareNftAvatar ? { prepareNftAvatar: overrides.prepareNftAvatar } : {}),
  onAfterMutation: overrides.onAfterMutation ?? (() => {}),
  getOwnerGlobalMetaId: overrides.getOwnerGlobalMetaId ?? (() => 'owner_gmid'),
  // Default: provider catalog unavailable -> the legacy provider-key guard is skipped.
  getLlmProviders: overrides.getLlmProviders ?? (() => undefined),
  // Optional spendable-balance reader (resumeMetabotSetupCore self-funded mode).
  ...(overrides.readSpendableBalance ? { readSpendableBalance: overrides.readSpendableBalance } : {}),
  // Assignment seam: absent by default (bare-embedding callers).
  ...(overrides.applyChatSkillAssignments ? { applyChatSkillAssignments: overrides.applyChatSkillAssignments } : {}),
  ...(overrides.listChatSkillAssignments ? { listChatSkillAssignments: overrides.listChatSkillAssignments } : {}),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('requireMetabotLlmIdForCreate throws on empty and trims valid input', () => {
  assert.throws(() => requireMetabotLlmIdForCreate('  '), /LLM Brain is required/);
  assert.throws(() => requireMetabotLlmIdForCreate(undefined), /LLM Brain is required/);
  assert.equal(requireMetabotLlmIdForCreate('  deepseek  '), 'deepseek');
});

// ---------------------------------------------------------------------------
// legacy provider-key write guard (R3)
// ---------------------------------------------------------------------------

const GUARD_PROVIDERS = {
  deepseek: { enabled: true, models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] },
  opencode: { enabled: true, models: [{ id: 'deepseek-v4-flash' }] },
};
const withProviders = () => GUARD_PROVIDERS;

test('legacyLlmProviderKeyError flags provider keys with an actionable message', () => {
  assert.equal(
    legacyLlmProviderKeyError('llm_id', 'opencode', GUARD_PROVIDERS),
    "llm_id 'opencode' is a provider id; pass a MODEL id (e.g. 'deepseek-v4-flash') with llm_provider='opencode'",
  );
  // Provider-key matching is case-insensitive.
  assert.match(legacyLlmProviderKeyError('llm_id', ' OpenCode ', GUARD_PROVIDERS), /provider id/);
  // Fallback field names its own provider column.
  assert.match(
    legacyLlmProviderKeyError('fallback_llm_id', 'deepseek', GUARD_PROVIDERS),
    /fallback_llm_id 'deepseek' is a provider id; pass a MODEL id \(e\.g\. 'deepseek-v4-flash'\) with fallback_llm_provider='deepseek'/,
  );
});

test('legacyLlmProviderKeyError accepts model ids, empty values, and unknown catalogs', () => {
  assert.equal(legacyLlmProviderKeyError('llm_id', 'deepseek-v4-pro', GUARD_PROVIDERS), null);
  assert.equal(legacyLlmProviderKeyError('llm_id', 'some-model', GUARD_PROVIDERS), null);
  assert.equal(legacyLlmProviderKeyError('llm_id', '', GUARD_PROVIDERS), null);
  assert.equal(legacyLlmProviderKeyError('llm_id', null, GUARD_PROVIDERS), null);
  // No provider catalog -> the guard never blocks a write it cannot judge.
  assert.equal(legacyLlmProviderKeyError('llm_id', 'opencode', undefined), null);
  // A genuine model id that happens to equal a provider key stays writable.
  assert.equal(
    legacyLlmProviderKeyError('llm_id', 'ollama', { ollama: { enabled: true, models: [{ id: 'ollama' }] } }),
    null,
  );
});

test('createMetaBotOnChainCore: rejects provider-key-shaped llm_id without creating', async () => {
  const store = await openStore();
  let walletCalls = 0;
  const deps = mockDeps(store, {
    getLlmProviders: withProviders,
    createWallet: async () => { walletCalls += 1; return fakeWallet(2000); },
  });
  const res = await createMetaBotOnChainCore({ name: 'LegacyBrain', llm_id: 'opencode' }, deps);
  assert.equal(res.success, false);
  assert.match(res.error, /llm_id 'opencode' is a provider id; pass a MODEL id/);
  assert.match(res.error, /llm_provider='opencode'/);
  assert.equal(store.listMetabots().length, 0);
  assert.equal(walletCalls, 0, 'rejected before wallet creation');
});

test('createMetaBotOnChainCore: rejects provider-key-shaped fallback_llm_id', async () => {
  const store = await openStore();
  const deps = mockDeps(store, { getLlmProviders: withProviders });
  const res = await createMetaBotOnChainCore(
    { name: 'LegacyFallback', llm_id: 'deepseek-v4-pro', fallback_llm_id: 'deepseek' },
    deps,
  );
  assert.equal(res.success, false);
  assert.match(res.error, /fallback_llm_id 'deepseek' is a provider id/);
  assert.equal(store.listMetabots().length, 0);
});

test('createMetaBotOnChainCore: accepts model ids with the guard active', async () => {
  const store = await openStore();
  const deps = mockDeps(store, { getLlmProviders: withProviders });
  const res = await createMetaBotOnChainCore(
    { name: 'ModernBrain', llm_id: 'deepseek-v4-flash', llm_provider: 'opencode', fallback_llm_id: 'deepseek-v4-pro' },
    deps,
  );
  assert.equal(res.success, true);
  assert.equal(res.metabot.llm_id, 'deepseek-v4-flash');
  assert.equal(res.metabot.fallback_llm_id, 'deepseek-v4-pro');
});

test('applyMetabotUpdateLocal: rejects provider-key-shaped llm_id and keeps the stored value', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Guarded', llm_id: 'deepseek-v4-pro' });
  const res = applyMetabotUpdateLocal(store, m.id, { llm_id: 'opencode' }, {
    getOwnerGlobalMetaId: () => 'owner_gmid',
    getLlmProviders: withProviders,
  });
  assert.equal(res.success, false);
  assert.match(res.error, /llm_id 'opencode' is a provider id; pass a MODEL id \(e\.g\. 'deepseek-v4-flash'\) with llm_provider='opencode'/);
  assert.equal(store.getMetabotById(m.id).llm_id, 'deepseek-v4-pro', 'stored value unchanged');
});

test('applyMetabotUpdateLocal: rejects provider-key-shaped fallback_llm_id', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'GuardedFallback' });
  const res = applyMetabotUpdateLocal(store, m.id, { fallback_llm_id: 'deepseek' }, {
    getOwnerGlobalMetaId: () => 'owner_gmid',
    getLlmProviders: withProviders,
  });
  assert.equal(res.success, false);
  assert.match(res.error, /fallback_llm_id 'deepseek' is a provider id/);
});

test('applyMetabotUpdateLocal: accepts model ids and brain clearing with the guard active', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'GuardedOk', llm_id: 'deepseek-v4-pro' });
  const deps = { getOwnerGlobalMetaId: () => 'owner_gmid', getLlmProviders: withProviders };
  const okModel = applyMetabotUpdateLocal(store, m.id, { llm_id: 'deepseek-v4-flash', llm_provider: 'opencode' }, deps);
  assert.equal(okModel.success, true);
  assert.equal(okModel.metabot.llm_id, 'deepseek-v4-flash');
  // Clearing the fallback brain (null) is not a provider key.
  const okClear = applyMetabotUpdateLocal(store, m.id, { fallback_llm_id: null }, deps);
  assert.equal(okClear.success, true);
});

test('assertCanCreateMetabot is a no-op under the limit', () => {
  // A fresh store has 0 bots; should not throw.
  const store = { listMetabots: () => [] };
  assert.doesNotThrow(() => assertCanCreateMetabot(store));
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('createMetaBotOnChainCore: success persists bot, refreshes P2P, returns subsidy', async () => {
  const store = await openStore();
  let afterCalled = 0;
  const deps = mockDeps(store, { onAfterMutation: async () => { afterCalled += 1; } });
  const res = await createMetaBotOnChainCore(
    { name: 'Alice', llm_id: 'deepseek' },
    deps,
  );
  assert.equal(res.success, true);
  assert.equal(res.metabot.name, 'Alice');
  assert.equal(res.metabot.llm_id, 'deepseek');
  assert.equal(afterCalled, 1);
  // Persisted in store.
  const found = store.getMetabotById(res.metabot.id);
  assert.ok(found, 'created bot must be persisted');
  assert.equal(found.metabot_type, 'worker');
});

test('createMetaBotOnChainCore: persists a host-supplied owner binding and signs it at creation', async () => {
  const store = await openStore();
  // Fresh wallet per create: two creations in one store must not reuse a
  // mnemonic (the wallet row is unique on it).
  let walletN = 2000;
  let signedBoss = null;
  let ownerPayloadSeen = null;
  const deps = mockDeps(store, {
    createWallet: async () => fakeWallet(walletN++),
    signOwnerBinding: async (boss, botGmid) => {
      signedBoss = boss;
      return { payload: `sig:${boss}:${botGmid}` };
    },
    syncToChain: async (_store, _id, options) => {
      ownerPayloadSeen = options?.ownerBindingPayload ?? null;
      return { success: true, txids: ['tx-create-owner'] };
    },
  });

  // WITH the host owner (the fixed metabot_create payload): the identity is
  // signed and its binding is queued for the on-chain publish.
  const withOwner = await createMetaBotOnChainCore(
    { name: 'OwnedByHost', llm_id: 'deepseek', boss_global_metaid: 'idq1owner' },
    deps,
  );
  assert.equal(withOwner.success, true);
  assert.equal(signedBoss, 'idq1owner');
  assert.equal(ownerPayloadSeen, 'sig:idq1owner:gmid-2000');
  // And it is persisted on the DB row (what My Bots > Edit used to backfill).
  assert.equal(store.getMetabotById(withOwner.metabot.id).boss_global_metaid, 'idq1owner');

  // CONTRAST — the pre-fix tool payload carried no owner: the row lands NULL,
  // proving the tool-side host injection is what closes the gap.
  const noOwner = await createMetaBotOnChainCore({ name: 'Unbound', llm_id: 'deepseek' }, deps);
  assert.equal(noOwner.success, true);
  assert.equal(store.getMetabotById(noOwner.metabot.id).boss_global_metaid, null);
});

test('createMetaBotOnChainCore: mandatory chain failure keeps the bot locally with a pending plan (create fallback)', async () => {
  const store = await openStore();
  const deps = mockDeps(store, {
    requestSubsidy: async () => ({ success: false, error: 'address-init failed: 503' }),
    syncToChain: async () => ({
      success: false,
      canSkip: false,
      error: 'Not enough balance',
      plannedSteps: ['name', 'chatpubkey', 'llm'],
      syncedSteps: [],
    }),
  });
  const res = await createMetaBotOnChainCore({ name: 'Bob', llm_id: 'deepseek' }, deps);
  // The bot is NOT rolled back: the wallet row is append-only anyway (a
  // rollback would strand any subsidy already paid), and the user must be
  // able to retry the subsidy or self-fund the address later.
  assert.equal(res.success, true);
  assert.equal(res.chainSetupPending, true);
  assert.equal(res.chainError, 'Not enough balance');
  assert.equal(res.metabot.name, 'Bob');
  assert.equal(store.listMetabots().length, 1, 'bot kept locally');
  // The full plan is persisted so the partial badge + resume entry work.
  const { readChainSyncPending } = require('../dist-electron/main/services/metabotManageService.js');
  const pending = readChainSyncPending(store, res.metabot.id);
  assert.deepEqual(pending.remainingSteps.sort(), ['chatpubkey', 'llm', 'name']);
  // The subsidy failure is recorded for the UI banner.
  const subsidy = readMetabotSubsidyState(store, res.metabot.id);
  assert.equal(subsidy.state, 'failed');
  assert.match(subsidy.error, /address-init failed/);
});

test('createMetaBotOnChainCore: mandatory chain failure without a reported plan falls back to the minimal-creation default', async () => {
  const store = await openStore();
  const deps = mockDeps(store, {
    syncToChain: async () => ({ success: false, canSkip: false, error: 'network down' }),
  });
  const res = await createMetaBotOnChainCore({ name: 'NoPlan', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.chainSetupPending, true);
  const { readChainSyncPending } = require('../dist-electron/main/services/metabotManageService.js');
  const pending = readChainSyncPending(store, res.metabot.id);
  assert.deepEqual(pending.remainingSteps.sort(), ['chatpubkey', 'llm', 'name']);
});

test('createMetaBotOnChainCore: successful subsidy is recorded as claimed', async () => {
  const store = await openStore();
  const res = await createMetaBotOnChainCore({ name: 'Funded', llm_id: 'deepseek' }, mockDeps(store));
  assert.equal(res.success, true);
  assert.equal(readMetabotSubsidyState(store, res.metabot.id).state, 'claimed');
});

test('readMetabotSubsidyState: absent record reads as unknown', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Legacy' });
  assert.deepEqual(readMetabotSubsidyState(store, m.id), { state: 'unknown' });
});

test('createMetaBotOnChainCore: partial publish (canSkip) keeps the bot and surfaces chainError', async () => {
  const store = await openStore();
  const deps = mockDeps(store, {
    syncToChain: async () => ({ success: false, canSkip: true, error: 'avatar pin failed' }),
  });
  const res = await createMetaBotOnChainCore({ name: 'Cyndi', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.chainPartial, true);
  assert.equal(res.chainError, 'avatar pin failed');
  assert.equal(store.listMetabots().length, 1);
});

test('createMetaBotOnChainCore: missing llm_id returns an error without creating', async () => {
  const store = await openStore();
  const res = await createMetaBotOnChainCore({ name: 'NoBrain' }, mockDeps(store));
  assert.equal(res.success, false);
  assert.match(res.error, /LLM Brain is required/);
  assert.equal(store.listMetabots().length, 0);
});

// ---------------------------------------------------------------------------
// resume setup (create fallback: retry subsidy / self-funded broadcast)
// ---------------------------------------------------------------------------

test('resumeMetabotSetupCore: subsidized retry with a still-failing subsidy attempts no chain sync', async () => {
  const store = await openStore();
  let syncCalls = 0;
  const deps = mockDeps(store, {
    requestSubsidy: async () => ({ success: false, error: 'address-init failed: 503' }),
    syncToChain: async () => { syncCalls += 1; return { success: true }; },
  });
  const res = await createMetaBotOnChainCore({ name: 'Stuck', llm_id: 'deepseek' }, {
    ...deps,
    syncToChain: async () => ({ success: false, canSkip: false, error: 'Not enough balance', plannedSteps: ['name'], syncedSteps: [] }),
  });
  assert.equal(res.chainSetupPending, true);
  const resume = await resumeMetabotSetupCore({ metabotId: res.metabot.id, mode: 'subsidized' }, deps);
  assert.equal(resume.success, false);
  assert.equal(resume.subsidy.success, false);
  assert.match(resume.error, /address-init failed/);
  assert.equal(syncCalls, 0, 'no chain attempt without funds');
  assert.equal(readMetabotSubsidyState(store, res.metabot.id).state, 'failed');
});

test('resumeMetabotSetupCore: subsidized retry claims the subsidy then syncs', async () => {
  const store = await openStore();
  const created = await createMetaBotOnChainCore({ name: 'Healing', llm_id: 'deepseek' }, mockDeps(store, {
    requestSubsidy: async () => ({ success: false, error: 'flaky' }),
    syncToChain: async () => ({ success: false, canSkip: false, error: 'Not enough balance', plannedSteps: ['name', 'chatpubkey'], syncedSteps: [] }),
  }));
  let subsidyArg = null;
  let syncCalls = 0;
  const deps = mockDeps(store, {
    requestSubsidy: async (p) => { subsidyArg = p; return { success: true }; },
    syncToChain: async () => {
      syncCalls += 1;
      return { success: true, plannedSteps: ['name', 'chatpubkey'], syncedSteps: ['name', 'chatpubkey'] };
    },
  });
  const resume = await resumeMetabotSetupCore({ metabotId: created.metabot.id, mode: 'subsidized' }, deps);
  assert.equal(resume.success, true);
  assert.equal(syncCalls, 1);
  assert.equal(resume.subsidy.success, true);
  // The subsidy is re-requested against the persisted wallet of THIS bot.
  assert.equal(subsidyArg.mvcAddress, created.metabot.mvc_address);
  assert.equal(readMetabotSubsidyState(store, created.metabot.id).state, 'claimed');
  // A fully landed sync clears the pending plan.
  const { readChainSyncPending } = require('../dist-electron/main/services/metabotManageService.js');
  assert.equal(readChainSyncPending(store, created.metabot.id), null);
});

test('resumeMetabotSetupCore: self-funded with a zero balance is blocked before any chain attempt', async () => {
  const store = await openStore();
  const created = await createMetaBotOnChainCore({ name: 'Manual', llm_id: 'deepseek' }, mockDeps(store, {
    syncToChain: async () => ({ success: false, canSkip: false, error: 'Not enough balance', plannedSteps: ['name'], syncedSteps: [] }),
  }));
  let syncCalls = 0;
  let subsidyCalls = 0;
  const deps = mockDeps(store, {
    requestSubsidy: async () => { subsidyCalls += 1; return { success: true }; },
    readSpendableBalance: async () => 0,
    syncToChain: async () => { syncCalls += 1; return { success: true }; },
  });
  const resume = await resumeMetabotSetupCore({ metabotId: created.metabot.id, mode: 'self-funded' }, deps);
  assert.equal(resume.success, false);
  assert.equal(resume.error, 'SELF_FUNDED_NO_BALANCE');
  assert.deepEqual(
    resume.selfFundedBlocked,
    { reason: 'no_balance', mvcAddress: created.metabot.mvc_address, spendableSatoshis: 0 },
  );
  assert.equal(syncCalls, 0, 'no guaranteed-futile broadcast');
  assert.equal(subsidyCalls, 0, 'self-funded mode never touches the subsidy service');
});

test('resumeMetabotSetupCore: self-funded with balance broadcasts without the subsidy', async () => {
  const store = await openStore();
  const created = await createMetaBotOnChainCore({ name: 'SelfPaid', llm_id: 'deepseek' }, mockDeps(store, {
    syncToChain: async () => ({ success: false, canSkip: false, error: 'Not enough balance', plannedSteps: ['name'], syncedSteps: [] }),
  }));
  let subsidyCalls = 0;
  let syncCalls = 0;
  const deps = mockDeps(store, {
    requestSubsidy: async () => { subsidyCalls += 1; return { success: true }; },
    readSpendableBalance: async () => 502600,
    syncToChain: async () => {
      syncCalls += 1;
      return { success: true, plannedSteps: ['name'], syncedSteps: ['name'] };
    },
  });
  const resume = await resumeMetabotSetupCore({ metabotId: created.metabot.id, mode: 'self-funded' }, deps);
  assert.equal(resume.success, true);
  assert.equal(syncCalls, 1);
  assert.equal(subsidyCalls, 0);
  assert.equal(resume.subsidy, undefined, 'no subsidy leg in self-funded mode');
});

test('resumeMetabotSetupCore: an already-synced bot is a no-op', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Done' });
  store.updateMetabot(m.id, { metabot_info_pinid: 'pin-done' });
  let syncCalls = 0;
  const deps = mockDeps(store, {
    syncToChain: async () => { syncCalls += 1; return { success: true }; },
  });
  const resume = await resumeMetabotSetupCore({ metabotId: m.id, mode: 'subsidized' }, deps);
  assert.equal(resume.success, true);
  assert.equal(resume.alreadySynced, true);
  assert.equal(syncCalls, 0);
});

test('resumeMetabotSetupCore: re-signs the owner binding when a boss is set but unpublished', async () => {
  const store = await openStore();
  const created = await createMetaBotOnChainCore(
    { name: 'Owned', llm_id: 'deepseek', boss_global_metaid: 'owner_gmid' },
    mockDeps(store, {
      syncToChain: async () => ({ success: false, canSkip: false, error: 'Not enough balance', plannedSteps: ['name'], syncedSteps: [] }),
    }),
  );
  let ownerPayload = null;
  const deps = mockDeps(store, {
    signOwnerBinding: async (_boss, botGmid) => {
      ownerPayload = `signed:${botGmid}`;
      return { payload: ownerPayload };
    },
    requestSubsidy: async () => ({ success: true }),
    syncToChain: async () => ({ success: true, plannedSteps: ['name', 'owner'], syncedSteps: ['name', 'owner'] }),
  });
  const resume = await resumeMetabotSetupCore({ metabotId: created.metabot.id, mode: 'subsidized' }, deps);
  assert.equal(resume.success, true);
  assert.match(ownerPayload, /signed:gmid-/);
});

test('resumeMetabotSetupCore: invalid id and missing bot report errors', async () => {
  const store = await openStore();
  const deps = mockDeps(store);
  const bad = await resumeMetabotSetupCore({ metabotId: 0, mode: 'subsidized' }, deps);
  assert.equal(bad.success, false);
  assert.match(bad.error, /Invalid metabotId/);
  const missing = await resumeMetabotSetupCore({ metabotId: 999, mode: 'self-funded' }, deps);
  assert.equal(missing.success, false);
  assert.match(missing.error, /not found/);
});

// ---------------------------------------------------------------------------
// update (local + flags + core)
// ---------------------------------------------------------------------------

test('applyMetabotUpdateLocal: writes fields and normalizes fallback llm', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Dev', llm_id: 'deepseek' });
  const res = applyMetabotUpdateLocal(store, m.id, {
    name: 'Dev2',
    fallback_llm_id: '  openai  ',
    bio: 'updated bio',
  }, { getOwnerGlobalMetaId: () => 'owner_gmid' });
  assert.equal(res.success, true);
  assert.equal(res.metabot.name, 'Dev2');
  assert.equal(res.metabot.fallback_llm_id, 'openai');
  assert.equal(res.metabot.bio, 'updated bio');
});

test('applyMetabotUpdateLocal: owner mismatch is rejected', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Ed' });
  const res = applyMetabotUpdateLocal(store, m.id, { boss_global_metaid: 'someone_else' }, {
    getOwnerGlobalMetaId: () => 'owner_gmid',
  });
  assert.equal(res.success, false);
  assert.equal(res.error, 'OWNER_IDENTITY_MISMATCH');
});

test('applyMetabotUpdateLocal: matching owner is accepted', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Ed' });
  const res = applyMetabotUpdateLocal(store, m.id, { boss_global_metaid: 'owner_gmid' }, {
    getOwnerGlobalMetaId: () => 'owner_gmid',
  });
  assert.equal(res.success, true);
});

test('buildEditSyncFlags: only changed fields are flagged', () => {
  const before = {
    id: 7, name: 'Old', avatar: 'a1', bio: 'b1', role: 'r1', soul: 's1', goal: 'g1',
    llm_id: 'deepseek', fallback_llm_id: '', allow_chat_skills: ['x'], homepage: null,
    boss_global_metaid: 'owner_gmid',
  };
  // Change only the name.
  const flags = buildEditSyncFlags(before, { name: 'New' });
  assert.equal(flags.syncName, true);
  assert.equal(flags.syncAvatar, false);
  assert.equal(flags.syncBio, false);
  assert.equal(flags.syncPersona, false);
  assert.equal(flags.syncLlm, false);
  assert.equal(flags.syncChatSkills, false);
  assert.equal(flags.syncHomepage, false);
  assert.equal(flags.syncOwner, false);
});

test('buildEditSyncFlags: persona + llm + chatSkills changes detected', () => {
  const before = {
    id: 7, name: 'N', avatar: '', bio: '', role: 'r', soul: 's', goal: 'g',
    llm_id: 'deepseek', fallback_llm_id: '', allow_chat_skills: [], homepage: null,
    boss_global_metaid: null,
  };
  const flags = buildEditSyncFlags(before, {
    role: 'r2',
    soul: 's2',
    llm_id: 'openai',
    allow_chat_skills: ['new'],
  });
  assert.equal(flags.syncPersona, true);
  assert.equal(flags.syncLlm, true);
  assert.equal(flags.syncChatSkills, true);
  assert.equal(flags.syncName, false);
});

test('updateMetaBotCore: local-only change (metabot_type) skips chain sync', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Flo', type: 'worker' });
  let syncCalls = 0;
  const deps = mockDeps(store, {
    syncEditChanges: async () => { syncCalls += 1; return { success: true }; },
  });
  const res = await updateMetaBotCore(m.id, { metabot_type: 'worker' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.sync.skipped, true);
  assert.deepEqual(res.sync.attemptedStepKeys, []);
  assert.equal(syncCalls, 0);
});

test('applyMetabotUpdateLocal: refuses to promote a Worker while a Twin exists', async () => {
  const store = await openStore();
  const twin = seedMetabot(store, { name: 'Twin', type: 'twin', n: 1 });
  const worker = seedMetabot(store, { name: 'Worker', type: 'worker', n: 2 });
  const res = applyMetabotUpdateLocal(store, worker.id, { metabot_type: 'twin' }, {});
  assert.equal(res.success, false);
  assert.equal(res.error, 'TWIN_ALREADY_EXISTS');
  assert.equal(store.getMetabotById(twin.id).metabot_type, 'twin');
  assert.equal(store.getMetabotById(worker.id).metabot_type, 'worker');
});

test('applyMetabotUpdateLocal: promotes a Worker to Twin when none exists', async () => {
  const store = await openStore();
  const worker = seedMetabot(store, { name: 'Worker', type: 'worker', n: 1 });
  const res = applyMetabotUpdateLocal(store, worker.id, { metabot_type: 'twin' }, {});
  assert.equal(res.success, true);
  assert.equal(res.metabot.metabot_type, 'twin');
  assert.equal(store.getMetabotById(worker.id).metabot_type, 'twin');
});

test('applyMetabotUpdateLocal: Twin can demote itself without promoting another bot', async () => {
  const store = await openStore();
  const twin = seedMetabot(store, { name: 'Twin', type: 'twin', n: 1 });
  const worker = seedMetabot(store, { name: 'Worker', type: 'worker', n: 2 });
  const res = applyMetabotUpdateLocal(store, twin.id, { metabot_type: 'worker' }, {});
  assert.equal(res.success, true);
  assert.equal(res.metabot.metabot_type, 'worker');
  assert.equal(store.getMetabotById(twin.id).metabot_type, 'worker');
  assert.equal(store.getMetabotById(worker.id).metabot_type, 'worker');
});

test('applyMetabotUpdateLocal: Welcome Bot cannot become Twin', async () => {
  const store = await openStore();
  const welcome = seedMetabot(store, { name: 'I.D', type: 'welcome', n: 1 });
  const res = applyMetabotUpdateLocal(store, welcome.id, { metabot_type: 'twin' }, {});
  assert.equal(res.success, false);
  assert.equal(res.error, 'WELCOME_CANNOT_BE_TWIN');
  assert.equal(store.getMetabotById(welcome.id).metabot_type, 'welcome');
});

test('deleteMetaBotCore: deleting Twin does not promote the Welcome Bot', async () => {
  const store = await openStore();
  const welcome = seedMetabot(store, { name: 'I.D', type: 'welcome', n: 1 });
  const twin = seedMetabot(store, { name: 'Twin', type: 'twin', n: 2 });
  const res = await deleteMetaBotCore(twin.id, { store, onAfterMutation: async () => {} });
  assert.equal(res.success, true);
  assert.equal(store.getMetabotById(welcome.id).metabot_type, 'welcome');
  assert.equal(store.listMetabots().some((m) => m.metabot_type === 'twin'), false);
});

test('deleteMetaBotCore: deleting Twin promotes the earliest remaining non-welcome bot', async () => {
  const store = await openStore();
  const welcome = seedMetabot(store, { name: 'I.D', type: 'welcome', n: 1 });
  const twin = seedMetabot(store, { name: 'Twin', type: 'twin', n: 2 });
  const worker = seedMetabot(store, { name: 'Worker', type: 'worker', n: 3 });
  const res = await deleteMetaBotCore(twin.id, { store, onAfterMutation: async () => {} });
  assert.equal(res.success, true);
  assert.equal(store.getMetabotById(welcome.id).metabot_type, 'welcome');
  assert.equal(store.getMetabotById(worker.id).metabot_type, 'twin');
});

test('updateMetaBotCore: name change triggers edit sync with syncName', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Gio' });
  let captured = null;
  const deps = mockDeps(store, {
    syncEditChanges: async (_s, input) => { captured = input; return { success: true, txids: ['t1'], syncedSteps: stepsFromInput(input) }; },
  });
  const res = await updateMetaBotCore(m.id, { name: 'GioRenamed' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.sync.skipped, false);
  assert.equal(captured.syncName, true);
  assert.equal(res.metabot.name, 'GioRenamed');
  // New unified-path fields: the plan surfaces what it attempted and nothing remains.
  assert.deepEqual(res.sync.attemptedStepKeys, ['name']);
  const remaining = res.sync.remainingSyncInput;
  assert.equal(remaining.syncName, false);
});

test('updateMetaBotCore: auto-retries only the still-unsynced steps', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Gio', llm_id: 'deepseek' });
  const calls = [];
  const deps = mockDeps(store, {
    // Change name + llm. First attempt publishes name only and fails; the
    // retry must republish ONLY the remaining llm step, then succeed.
    syncEditChanges: async (_s, input) => {
      calls.push({ ...input });
      if (calls.length === 1) {
        return { success: false, syncedSteps: ['name'], error: 'llm pin failed' };
      }
      return { success: true, syncedSteps: stepsFromInput(input), txids: ['t-retry'] };
    },
  });
  const res = await updateMetaBotCore(m.id, { name: 'GioRenamed', llm_id: 'openai' }, deps);
  assert.equal(res.success, true);
  assert.equal(calls.length, 2);
  // First attempt: name + llm both requested.
  assert.equal(calls[0].syncName, true);
  assert.equal(calls[0].syncLlm, true);
  // Retry: name already synced, so only llm remains.
  assert.equal(calls[1].syncName, false);
  assert.equal(calls[1].syncLlm, true);
  assert.deepEqual(res.sync.attemptedStepKeys, ['name', 'llm']);
  assert.equal(res.sync.remainingSyncInput.syncName, false);
  assert.equal(res.sync.remainingSyncInput.syncLlm, false);
});

test('updateMetaBotCore: remaining steps survive a failed auto-retry for the manual Retry', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Gio', llm_id: 'deepseek' });
  const deps = mockDeps(store, {
    // Both attempts fail to publish llm; name confirms on the first.
    syncEditChanges: async (_s, input) => ({
      success: false,
      syncedSteps: input.syncName && input.syncLlm ? ['name'] : [],
      error: 'llm pin failed',
    }),
  });
  const res = await updateMetaBotCore(m.id, { name: 'GioRenamed', llm_id: 'openai' }, deps);
  assert.equal(res.success, false);
  assert.equal(res.metabot.name, 'GioRenamed'); // local write persisted
  // The remaining plan should still flag llm (so the UI's manual Retry re-publishes only llm).
  const remaining = res.sync.remainingSyncInput;
  assert.equal(remaining.syncName, false);
  assert.equal(remaining.syncLlm, true);
  assert.deepEqual(res.sync.attemptedStepKeys, ['name', 'llm']);
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test('deleteMetaBotCore: refuses to delete the last remaining bot', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Solo' });
  const res = await deleteMetaBotCore(m.id, { store, onAfterMutation: async () => {} });
  assert.equal(res.success, false);
  assert.match(res.error, /last remaining MetaBot/i);
  assert.equal(store.listMetabots().length, 1);
});

test('deleteMetaBotCore: deletes when more than one bot remains', async () => {
  const store = await openStore();
  const m1 = seedMetabot(store, { name: 'One', n: 1 });
  seedMetabot(store, { name: 'Two', n: 2 });
  let afterCalled = 0;
  const res = await deleteMetaBotCore(m1.id, { store, onAfterMutation: async () => { afterCalled += 1; } });
  assert.equal(res.success, true);
  assert.equal(afterCalled, 1);
  assert.equal(store.listMetabots().length, 1);
});

test('deleteMetaBotCore: missing bot reports not found', async () => {
  const store = await openStore();
  const res = await deleteMetaBotCore(999, { store, onAfterMutation: async () => {} });
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

test('deleteMetaBotCore: invokes onAfterDelete with the deleted bot', async () => {
  const store = await openStore();
  const welcome = seedMetabot(store, { name: 'I.D', type: 'welcome', n: 1 });
  seedMetabot(store, { name: 'Twin', type: 'twin', n: 2 });
  let deletedType = null;
  let deletedId = null;
  const res = await deleteMetaBotCore(welcome.id, {
    store,
    onAfterMutation: async () => {},
    onAfterDelete: async (deletedMetabot) => {
      deletedType = deletedMetabot.metabot_type;
      deletedId = deletedMetabot.id;
    },
  });
  assert.equal(res.success, true);
  assert.equal(deletedType, 'welcome');
  assert.equal(deletedId, welcome.id);
});

// ---------------------------------------------------------------------------
// list + providers
// ---------------------------------------------------------------------------

test('listMetabotsForManagement: returns sanitized editable fields', async () => {
  const store = await openStore();
  seedMetabot(store, { name: 'Hygenist', type: 'twin', llm_id: 'openai' });
  const list = listMetabotsForManagement(store);
  assert.equal(list.length, 1);
  const m = list[0];
  assert.equal(m.name, 'Hygenist');
  assert.equal(m.type, 'twin');
  assert.equal(m.llm_id, 'openai');
  assert.ok(Array.isArray(m.allow_chat_skills));
  assert.equal(m.bio, null);
});

test('listConfiguredLlmProviders: filters by enabled + apiKey (non-ollama)', () => {
  const providers = {
    openai: { enabled: true, apiKey: 'sk-xxx' },
    deepseek: { enabled: true, apiKey: 'ds-yyy' },
    disabled1: { enabled: false, apiKey: 'k' },
    nokey: { enabled: true, apiKey: '' },
    ollama: { enabled: true }, // ollama never requires apiKey
  };
  const list = listConfiguredLlmProviders(providers);
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('ollama'));
  assert.ok(!ids.includes('disabled1'));
  assert.ok(!ids.includes('nokey'));
  // Labels are capitalized keys.
  assert.ok(list.find((p) => p.id === 'openai').label === 'Openai');
});

test('listConfiguredLlmProviders: undefined providers yields empty list', () => {
  assert.deepEqual(listConfiguredLlmProviders(undefined), []);
});

test('applyChatSkillOp: add appends without duplicating or touching other items', () => {
  assert.deepEqual(applyChatSkillOp(['alpha', 'beta'], { action: 'add', skill: 'gamma' }), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(applyChatSkillOp(['alpha', 'beta'], { action: 'add', skill: 'alpha' }), ['alpha', 'beta']);
  assert.deepEqual(applyChatSkillOp([' alpha ', ''], { action: 'add', skill: ' beta ' }), ['alpha', 'beta']);
});

test('applyChatSkillOp: remove drops only the named skill', () => {
  assert.deepEqual(applyChatSkillOp(['alpha', 'beta', 'gamma'], { action: 'remove', skill: 'beta' }), ['alpha', 'gamma']);
  assert.deepEqual(applyChatSkillOp(['alpha'], { action: 'remove', skill: 'missing' }), ['alpha']);
  assert.deepEqual(applyChatSkillOp([], { action: 'remove', skill: 'x' }), []);
});


// ---------------------------------------------------------------------------
// skill assignment absorption (per-bot assignment model)
// ---------------------------------------------------------------------------

test('createMetaBotOnChainCore: allow_chat_skills input seeds assignment rows', async () => {
  const store = await openStore();
  const calls = [];
  const deps = mockDeps(store, {
    applyChatSkillAssignments: (metabotId, entries) => {
      calls.push({ metabotId, entries });
      return ['skill-a', 'skill-b'];
    },
  });
  const res = await createMetaBotOnChainCore(
    { name: 'Seeded', llm_id: 'deepseek-v4-flash', allow_chat_skills: ['skill-a', 'skill-b'] },
    deps,
  );
  assert.equal(res.success, true);
  assert.deepEqual(calls, [{ metabotId: res.metabot.id, entries: ['skill-a', 'skill-b'] }]);
});

test('createMetaBotOnChainCore: assignment seeding failure rolls the bot back', async () => {
  const store = await openStore();
  const deps = mockDeps(store, {
    applyChatSkillAssignments: () => {
      throw new Error('kv locked');
    },
  });
  const res = await createMetaBotOnChainCore(
    { name: 'Forked', llm_id: 'deepseek-v4-flash', allow_chat_skills: ['skill-a'] },
    deps,
  );
  assert.equal(res.success, false);
  assert.match(res.error, /assignment seeding failed/i);
  assert.equal(store.listMetabots().length, 0, 'bot row rolled back');
});

test('updateMetaBotCore: assignment write failure fails the whole update (fail-closed)', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Stale', llm_id: 'deepseek-v4-pro' });
  const deps = mockDeps(store, {
    applyChatSkillAssignments: () => {
      throw new Error('sqlite busy');
    },
  });
  const res = await updateMetaBotCore(m.id, { allow_chat_skills: ['skill-x'] }, deps);
  assert.equal(res.success, false);
  assert.match(res.error, /assignment write failed/i);
  // Column keeps the previous value — no fork between projection and rows.
  assert.deepEqual(store.getMetabotById(m.id).allow_chat_skills, []);
});

test('updateMetaBotCore: assignment dep result replaces the raw whitelist (names resolved, builtins dropped)', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Mirrored', llm_id: 'deepseek-v4-pro' });
  const deps = mockDeps(store, {
    applyChatSkillAssignments: (_metabotId, entries) => {
      assert.deepEqual(entries, ['friendly', 'official-thing']);
      return ['friendly-skill'];
    },
  });
  const res = await updateMetaBotCore(m.id, { allow_chat_skills: ['friendly', 'official-thing'] }, deps);
  assert.equal(res.success, true);
  assert.deepEqual(res.metabot.allow_chat_skills, ['friendly-skill'], 'column mirrors resolved rows');
});

test('updateMetaBotCore: whitelist replace reports which assigned skills were dropped', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Diffed', llm_id: 'deepseek-v4-pro' });
  const deps = mockDeps(store, {
    listChatSkillAssignments: () => ['skill-a', 'skill-b'],
    applyChatSkillAssignments: () => ['skill-a'],
  });
  const res = await updateMetaBotCore(m.id, { allow_chat_skills: ['skill-a'] }, deps);
  assert.equal(res.success, true);
  assert.deepEqual(res.removedChatSkills, ['skill-b']);
});

test('updateMetaBotCore: no removals -> removedChatSkills absent', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Kept', llm_id: 'deepseek-v4-pro' });
  const deps = mockDeps(store, {
    listChatSkillAssignments: () => ['skill-a'],
    applyChatSkillAssignments: () => ['skill-a', 'skill-b'],
  });
  const res = await updateMetaBotCore(m.id, { allow_chat_skills: ['skill-a', 'skill-b'] }, deps);
  assert.equal(res.success, true);
  assert.equal(res.removedChatSkills, undefined);
});


test('updateMetaBotCore: a failed NFT ownership check rejects before local write or chain sync', async () => {
  const store = await openStore();
  try {
    const m = seedMetabot(store, { name: 'Owner gated' });
    const before = store.getMetabotById(m.id).avatar;
    let syncCalls = 0;
    const reference = `nft://mrc721/${'aa'.repeat(32)}i0`;
    const result = await updateMetaBotCore(
      m.id,
      { avatar: reference },
      mockDeps(store, {
        prepareNftAvatar: async () => { throw new Error('NFT_AVATAR_NOT_OWNED'); },
        syncEditChanges: async () => { syncCalls += 1; return { success: true, syncedSteps: [] }; },
      }),
    );
    assert.equal(result.success, false);
    assert.equal(result.error, 'NFT_AVATAR_NOT_OWNED');
    assert.equal(syncCalls, 0);
    assert.equal(store.getMetabotById(m.id).avatar, before);
  } finally {
    closeStore(store);
  }
});

test('updateMetaBotCore: a verified NFT stores its bound reference and cover before dual-pin sync', async () => {
  const store = await openStore();
  try {
    const m = seedMetabot(store, { name: 'NFT update' });
    const reference = `nft://mrc721/${'aa'.repeat(32)}i0?owner=${encodeURIComponent(m.mvc_address)}&metaid=${m.globalmetaid}`;
    let captured = null;
    const result = await updateMetaBotCore(
      m.id,
      { avatar: `nft://mrc721/${'aa'.repeat(32)}i0` },
      mockDeps(store, {
        prepareNftAvatar: async () => ({
          reference,
          avatarUrl: 'data:image/png;base64,AAAA',
          declarationPayload: '{}',
          nft: { itemPinId: `${'aa'.repeat(32)}i0`, ownershipVerified: true },
        }),
        syncEditChanges: async (_store, input) => {
          captured = input;
          return { success: true, syncedSteps: stepsFromInput(input) };
        },
      }),
    );
    assert.equal(result.success, true);
    assert.equal(captured.syncAvatar, true);
    assert.equal(captured.syncNftAvatar, true);
    assert.equal(result.metabot.avatar, reference);
    assert.equal(result.metabot.avatar_fallback, 'data:image/png;base64,AAAA');
  } finally {
    closeStore(store);
  }
});
