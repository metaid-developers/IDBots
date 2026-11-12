import test from 'node:test';
import assert from 'node:assert/strict';

const { switchFreePrimaryBrainsToProvider } = await import('../dist-electron/main/services/brainSwitchService.js');

const FREE_PROVIDER = {
  enabled: true,
  apiKey: 'relay-key',
  baseUrl: 'https://relay.example.com/v1',
  models: [{ id: 'deepseek-4.1-flash' }],
};

const DEEPSEEK_PROVIDER = {
  enabled: true,
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
};

function freePrimaryBot(id, extra = {}) {
  return { id, name: `bot-${id}`, llm_id: 'deepseek-4.1-flash', llm_provider: 'metaid-free', fallback_llm_id: null, ...extra };
}

function makeDeps(overrides = {}) {
  const updates = [];
  const bots = [freePrimaryBot(1)];
  let appConfig = {
    model: { defaultModel: 'deepseek-4.1-flash', defaultProvider: 'metaid-free' },
    providers: { 'metaid-free': FREE_PROVIDER, deepseek: DEEPSEEK_PROVIDER },
  };
  return {
    bots,
    updates,
    getAppConfig: () => appConfig,
    listMetabots: () => bots,
    updateBot: async (id, input) => {
      updates.push({ id, input });
      const bot = bots.find((candidate) => candidate.id === id);
      Object.assign(bot, input);
      return { success: true };
    },
    mutateAppConfig: (mutate) => { appConfig = mutate(appConfig); },
    getConfig: () => appConfig,
    log: () => {},
    ...overrides,
  };
}

test('switch moves free-primary bots onto the target provider and keeps the free relay as fallback', async () => {
  const deps = makeDeps();
  const result = await switchFreePrimaryBrainsToProvider(deps, 'deepseek');
  assert.equal(result.success, true);
  assert.deepEqual(result.switchedBotIds, [1]);
  // defaultModel 'deepseek-4.1-flash' is not served by the deepseek provider,
  // so the seed model is the provider's first model.
  assert.equal(result.modelId, 'deepseek-flash');
  assert.equal(deps.updates.length, 1);
});

test('switch seeds the free relay as fallback only when the bot had none', async () => {
  const deps = makeDeps();
  const result = await switchFreePrimaryBrainsToProvider(deps, 'deepseek');
  assert.equal(deps.updates[0].input.llm_provider, 'deepseek');
  assert.equal(deps.updates[0].input.fallback_llm_id, 'deepseek-4.1-flash');
  assert.equal(deps.updates[0].input.fallback_llm_provider, 'idbots');
  assert.ok(result.success);

  // A bot with an existing fallback keeps it untouched.
  const bots2 = [freePrimaryBot(2, { fallback_llm_id: 'qwen3.5-plus', fallback_llm_provider: 'qwen' })];
  const deps2 = makeDeps({
    listMetabots: () => bots2,
    updateBot: async (id, input) => {
      deps2.updates.push({ id, input });
      Object.assign(bots2.find((b) => b.id === id), input);
      return { success: true };
    },
  });
  const result2 = await switchFreePrimaryBrainsToProvider(deps2, 'deepseek');
  assert.ok(result2.success);
  assert.equal(deps2.updates[0].input.fallback_llm_id, undefined);
});

test('switch prefers the app default model when the target provider serves it', async () => {
  const deps = makeDeps();
  const result = await switchFreePrimaryBrainsToProvider(deps, 'deepseek');
  // defaultModel 'deepseek-4.1-flash' is NOT served by deepseek -> first model.
  assert.equal(result.modelId, 'deepseek-flash');
});

test('switch updates the global default route when it still rides the free relay', async () => {
  const deps = makeDeps();
  const result = await switchFreePrimaryBrainsToProvider(deps, 'deepseek');
  assert.equal(result.defaultRouteUpdated, true);
  assert.equal(deps.getConfig().model.defaultModel, 'deepseek-flash');
  assert.equal(deps.getConfig().model.defaultProvider, 'deepseek');
});

test('switch leaves a paid global default route untouched', async () => {
  const deps = makeDeps();
  deps.mutateAppConfig((current) => ({
    ...current,
    model: { defaultModel: 'deepseek-v4-pro', defaultProvider: 'deepseek' },
  }));
  const result = await switchFreePrimaryBrainsToProvider(deps, 'deepseek');
  assert.equal(result.defaultRouteUpdated, false);
  assert.equal(deps.getConfig().model.defaultModel, 'deepseek-v4-pro');
  // The bot brain still moves to the default-served model.
  assert.equal(result.modelId, 'deepseek-v4-pro');
});

test('switch rejects an unusable or free target provider without writes', async () => {
  const deps = makeDeps();
  const free = await switchFreePrimaryBrainsToProvider(deps, 'idbots');
  assert.equal(free.success, false);
  const disabled = await switchFreePrimaryBrainsToProvider(deps, 'deepseek-disabled');
  assert.equal(disabled.success, false);
  assert.equal(deps.updates.length, 0);
});

test('switch skips paid-primary bots and reports per-bot failures', async () => {
  const bots = [
    freePrimaryBot(1),
    { id: 2, name: 'paid-bot', llm_id: 'deepseek-flash', llm_provider: 'deepseek', fallback_llm_id: null },
    freePrimaryBot(3),
  ];
  const deps = makeDeps({
    listMetabots: () => bots,
    updateBot: async (id, input) => {
      deps.updates.push({ id, input });
      if (id === 3) return { success: false, error: 'chain sync failed' };
      Object.assign(bots.find((b) => b.id === id), input);
      return { success: true };
    },
  });
  const result = await switchFreePrimaryBrainsToProvider(deps, 'deepseek');
  assert.equal(result.success, false);
  assert.deepEqual(result.switchedBotIds, [1]);
  assert.deepEqual(result.failedBots, [{ id: 3, name: 'bot-3', error: 'chain sync failed' }]);
  assert.match(result.error, /chain sync failed/);
});
