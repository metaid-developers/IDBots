import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// staleModelBindingReconcile -> appLanguage imports electron; mock it.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
        getPreferredSystemLanguages: () => ['en-US'],
        getSystemLocale: () => 'en-US',
        getLocale: () => 'en-US',
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { reconcileStaleModelBindings } = require('../dist-electron/main/services/staleModelBindingReconcile.js');
const { setAppLanguageStoreGetter } = require('../dist-electron/main/libs/appLanguage.js');

Module._load = originalLoad;

// Pin the notice language to English so assertions are locale-stable.
setAppLanguageStoreGetter(() => ({
  get: () => ({ language: 'en', language_initialized: true }),
}));

const makeDeps = ({ providers, sessions = [], bots = [] }) => {
  const sessionUpdates = [];
  const botUpdates = [];
  const notices = [];
  const pins = [];
  const lastMessages = new Map();
  const logs = [];
  const warns = [];
  const deps = {
    metabotStore: {
      listMetabots: () => bots,
      updateMetabot: (id, input) => {
        botUpdates.push({ id, input });
        const bot = bots.find((candidate) => candidate.id === id);
        if (bot) Object.assign(bot, input);
        return bot ?? null;
      },
    },
    coworkStore: {
      listSessions: () => sessions,
      setSessionModel: (id, model, effort, modelProvider) => {
        sessionUpdates.push({ id, model, effort, modelProvider });
        const session = sessions.find((candidate) => candidate.id === id);
        if (session) session.modelProvider = modelProvider ?? null;
      },
    },
    getAppConfig: () => ({ providers }),
    insertSessionSystemMessage: (sessionId, content) => {
      notices.push({ sessionId, content });
      lastMessages.set(sessionId, { type: 'system', content });
    },
    getLastSessionMessage: (sessionId) => lastMessages.get(sessionId) ?? null,
    pinSessionUpdatedAt: (sessionId, updatedAtMs) => {
      pins.push({ sessionId, updatedAtMs });
    },
    log: (message) => logs.push(message),
    warn: (message) => warns.push(message),
  };
  return { deps, sessionUpdates, botUpdates, notices, pins, lastMessages, logs, warns };
};

const CATALOG = {
  opencode: { enabled: true, models: [{ id: 'glm-5.3' }, { id: 'deepseek-v4.1-flash' }] },
  'custom-zai': { enabled: true, models: [{ id: 'glm-5.3' }] },
  deepseek: { enabled: true, models: [{ id: 'deepseek-v4.1-flash' }] },
  'metaid-free': { enabled: true, models: [{ id: 'free-flash' }] },
  'disabled-p': { enabled: false, models: [{ id: 'gone-model' }] },
};

test('reconcile: a session binding whose model maps to exactly ONE enabled provider is auto-rebound', () => {
  const sessions = [
    { id: 'sess-1', title: 'Chat', model: 'deepseek-v4.1-flash', modelProvider: 'zhipu', updatedAt: 111 },
  ];
  // Only ONE enabled provider offers the model (zhipu is disabled), so the
  // stale hint can be repointed without guessing.
  const { deps, sessionUpdates, notices } = makeDeps({
    providers: {
      opencode: { enabled: true, models: [{ id: 'deepseek-v4.1-flash' }] },
      zhipu: { enabled: false, models: [{ id: 'deepseek-v4.1-flash' }] },
    },
    sessions,
    bots: [],
  });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.reboundSessions, 1);
  assert.deepEqual(sessionUpdates, [{ id: 'sess-1', model: 'deepseek-v4.1-flash', effort: undefined, modelProvider: 'opencode' }]);
  assert.equal(result.flagged.length, 0);
  assert.equal(notices.length, 0, 'healed bindings need no notice');
});

test('reconcile: an ambiguous session binding (the zhipu incident shape) is flagged, not guessed, with one readable notice', () => {
  const sessions = [
    { id: 'sess-2', title: 'Video work', model: 'glm-5.3', modelProvider: 'zhipu', updatedAt: 222 },
  ];
  const { deps, sessionUpdates, notices, pins } = makeDeps({ providers: CATALOG, sessions, bots: [] });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.reboundSessions, 0, 'ambiguous bindings are never auto-guessed');
  assert.equal(sessionUpdates.length, 0);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].scope, 'session');
  assert.match(result.flagged[0].reason, /ambiguous/);
  assert.equal(notices.length, 1, 'the flagged session gets a visible notice');
  assert.match(notices[0].content, /\[model-binding\]/);
  assert.match(notices[0].content, /glm-5\.3/);
  assert.match(notices[0].content, /zhipu/);
  assert.deepEqual(pins, [{ sessionId: 'sess-2', updatedAtMs: 222 }], 'updated_at is pinned back (liveness guard)');

  // A second startup run does NOT spam another notice while the last message
  // is already the health-check marker.
  const second = reconcileStaleModelBindings(deps);
  assert.equal(second.flagged.length, 1, 'the binding is still flagged (nothing healed it)');
  assert.equal(notices.length, 1, 'no duplicate notice across restarts');
});

test('reconcile: a session bound to a model no enabled provider offers is flagged with the no-provider reason', () => {
  const sessions = [{ id: 'sess-3', title: 'Old', model: 'gone-model', modelProvider: 'disabled-p' }];
  const { deps, notices } = makeDeps({ providers: CATALOG, sessions, bots: [] });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.flagged.length, 1);
  assert.match(result.flagged[0].reason, /no enabled provider offers this model/);
  assert.equal(notices.length, 1);
});

test('reconcile: a2a sessions are flagged but never messaged (system bubbles are hidden there)', () => {
  const sessions = [{ id: 'sess-4', title: 'A2A', sessionType: 'a2a', model: 'glm-5.3', modelProvider: 'zhipu' }];
  const { deps, notices } = makeDeps({ providers: CATALOG, sessions, bots: [] });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.flagged.length, 1);
  assert.equal(notices.length, 0);
});

test('reconcile: valid session bindings are untouched', () => {
  const sessions = [
    { id: 'sess-5', title: 'Fine', model: 'glm-5.3', modelProvider: 'opencode' },
    { id: 'sess-6', title: 'Default route', model: null, modelProvider: null },
  ];
  const { deps, sessionUpdates, notices } = makeDeps({ providers: CATALOG, sessions, bots: [] });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.reboundSessions, 0);
  assert.equal(result.flagged.length, 0);
  assert.equal(sessionUpdates.length, 0);
  assert.equal(notices.length, 0);
});

test('reconcile: a bot brain with a stale provider hint is re-pointed to the single offering provider', () => {
  const bots = [
    { id: 22, name: 'eleven', llm_id: 'deepseek-v4.1-flash', llm_provider: 'zhipu', fallback_llm_id: null, fallback_llm_provider: null },
  ];
  const { deps, botUpdates } = makeDeps({
    providers: { opencode: { enabled: true, models: [{ id: 'deepseek-v4.1-flash' }] } },
    sessions: [],
    bots,
  });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.reboundBots, 1);
  assert.deepEqual(botUpdates, [{ id: 22, input: { llm_provider: 'opencode' } }]);
  assert.equal(result.flagged.length, 0);
});

test('reconcile: an ambiguous bot brain is flagged; a legacy provider-key llm_id is left to the llm-brain migration', () => {
  const bots = [
    { id: 15, name: 'Builder', llm_id: 'glm-5.3', llm_provider: 'zhipu', fallback_llm_id: null, fallback_llm_provider: null },
    { id: 7, name: 'Legacy', llm_id: 'opencode', llm_provider: null, fallback_llm_id: null, fallback_llm_provider: null },
  ];
  const { deps, botUpdates } = makeDeps({ providers: CATALOG, sessions: [], bots });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.reboundBots, 0);
  assert.equal(botUpdates.length, 0, 'no guessing, no touching legacy values');
  assert.equal(result.flagged.length, 1, 'only the ambiguous model-shaped binding is flagged');
  assert.equal(result.flagged[0].scope, 'bot');
  assert.equal(result.flagged[0].id, 15);
  assert.match(result.flagged[0].reason, /ambiguous/);
});

test('reconcile: the fallback brain pair is reconciled too, and a disabled-provider-only model flags', () => {
  const bots = [
    {
      id: 5, name: 'Backup', llm_id: 'deepseek-v4.1-flash', llm_provider: 'deepseek',
      fallback_llm_id: 'gone-model', fallback_llm_provider: 'disabled-p',
    },
  ];
  const { deps } = makeDeps({ providers: CATALOG, sessions: [], bots });
  const result = reconcileStaleModelBindings(deps);
  assert.equal(result.flagged.length, 1, 'the primary brain is valid; only the fallback flags');
  assert.equal(result.flagged[0].field, 'fallback_llm_provider');
  assert.match(result.flagged[0].reason, /no enabled provider offers this model/);
});

test('reconcile: no provider config skips cleanly', () => {
  const { deps } = makeDeps({ providers: {}, sessions: [], bots: [] });
  const result = reconcileStaleModelBindings(deps);
  assert.deepEqual(result, { reboundSessions: 0, reboundBots: 0, flagged: [] });
});

test('reconcile: canonicalizes metaid-free <-> idbots across legacy sessions and pre-renderer-migration app_config', () => {
  const postUpgradeProviders = {
    idbots: { enabled: true, models: [{ id: 'deepseek-4.1-flash' }, { id: 'deepseek-v4.1-flash' }] },
    deepseek: { enabled: true, models: [{ id: 'deepseek-v4.1-flash' }] },
  };
  const legacySessions = [
    { id: 'sess-legacy-free', title: 'Old Free Chat', model: 'deepseek-v4.1-flash', modelProvider: 'metaid-free', updatedAt: 333 },
  ];
  const { deps: postDeps, sessionUpdates, notices } = makeDeps({
    providers: postUpgradeProviders,
    sessions: legacySessions,
    bots: [],
  });
  const postResult = reconcileStaleModelBindings(postDeps);
  assert.equal(postResult.flagged.length, 0, 'legacy metaid-free session hint matches canonical idbots without false ambiguity');
  assert.equal(notices.length, 0, 'no system warning injected into upgraded user transcripts');
  assert.equal(sessionUpdates.length, 0);

  const preRendererProviders = {
    'metaid-free': { enabled: true, models: [{ id: 'deepseek-v4.1-flash' }] },
    deepseek: { enabled: true, models: [{ id: 'deepseek-v4.1-flash' }] },
  };
  const migratedBots = [
    { id: 1, name: 'Twin', llm_id: 'deepseek-v4.1-flash', llm_provider: 'idbots', fallback_llm_id: null, fallback_llm_provider: null },
  ];
  const { deps: preDeps, botUpdates } = makeDeps({
    providers: preRendererProviders,
    sessions: [],
    bots: migratedBots,
  });
  const preResult = reconcileStaleModelBindings(preDeps);
  assert.equal(preResult.flagged.length, 0, 'SQL-migrated idbots bot hint matches pre-renderer metaid-free catalog entry');
  assert.equal(botUpdates.length, 0, 'never reverts idbots back to metaid-free');
});
