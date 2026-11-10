import test from 'node:test';
import assert from 'node:assert/strict';

const {
  computeQuotaNudgeState,
  createQuotaNudgeController,
  QUOTA_NUDGE_DISMISS_KV_KEY,
  QUOTA_NUDGE_LOW_THRESHOLD,
} = await import('../dist-electron/main/services/quotaNudgeService.js');

const FREE_PROVIDER = {
  enabled: true,
  apiKey: 'relay-key',
  baseUrl: 'https://relay.example.com/v1',
  name: 'ID.Bots',
  models: [{ id: 'deepseek-4.1-flash' }],
};

const DEEPSEEK_PROVIDER = {
  enabled: true,
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [{ id: 'deepseek-flash' }],
};

function freePrimaryBot(id) {
  return { id, name: `bot-${id}`, llm_id: 'deepseek-4.1-flash', llm_provider: 'metaid-free' };
}

function paidPrimaryBot(id) {
  return { id, name: `bot-${id}`, llm_id: 'deepseek-flash', llm_provider: 'deepseek' };
}

function makeDeps(overrides = {}) {
  const kv = new Map();
  return {
    getAppConfig: () => ({ providers: { 'metaid-free': FREE_PROVIDER, deepseek: DEEPSEEK_PROVIDER } }),
    listMetabots: () => [freePrimaryBot(1)],
    fetchQuota: async () => ({ quotaRemaining: 500, quotaTotal: 1000, quotaCycleResetAt: '2026-10-30T00:00:00Z' }),
    getKv: (key) => kv.get(key),
    setKv: (key, value) => kv.set(key, value),
    kv,
    ...overrides,
  };
}

test('healthy quota yields no nudge', async () => {
  const state = await computeQuotaNudgeState(makeDeps());
  assert.equal(state.level, 'none');
  assert.equal(state.reason, 'ok');
  assert.equal(state.freeBrainBotCount, 1);
  assert.deepEqual(state.suggestedProvider, { key: 'deepseek', name: 'deepseek', modelId: 'deepseek-flash' });
});

test('no bot riding the free relay yields no nudge even when quota is exhausted', async () => {
  const state = await computeQuotaNudgeState(makeDeps({
    listMetabots: () => [paidPrimaryBot(1)],
    fetchQuota: async () => ({ quotaRemaining: 0, quotaTotal: 1000 }),
  }));
  assert.equal(state.level, 'none');
  assert.equal(state.reason, 'no-free-brain-bots');
});

test('quota at or below 20% yields the low nudge; zero yields exhausted', async () => {
  assert.equal(QUOTA_NUDGE_LOW_THRESHOLD, 0.2);
  const low = await computeQuotaNudgeState(makeDeps({
    fetchQuota: async () => ({ quotaRemaining: 200, quotaTotal: 1000, quotaCycleResetAt: '2026-10-30T00:00:00Z' }),
  }));
  assert.equal(low.level, 'low');
  assert.equal(low.reason, 'threshold');
  const exhausted = await computeQuotaNudgeState(makeDeps({
    fetchQuota: async () => ({ quotaRemaining: 0, quotaTotal: 1000, quotaCycleResetAt: '2026-10-30T00:00:00Z' }),
  }));
  assert.equal(exhausted.level, 'exhausted');
});

test('quota fetch failure never produces a banner', async () => {
  const state = await computeQuotaNudgeState(makeDeps({
    fetchQuota: async () => { throw new Error('network down'); },
  }));
  assert.equal(state.level, 'none');
  assert.equal(state.reason, 'quota-unavailable');
});

test('a bot without a provider hint whose llm_id is served by the free relay counts as free-riding', async () => {
  const state = await computeQuotaNudgeState(makeDeps({
    listMetabots: () => [{ id: 1, name: 'legacy', llm_id: 'deepseek-4.1-flash', llm_provider: null }],
    fetchQuota: async () => ({ quotaRemaining: 100, quotaTotal: 1000, quotaCycleResetAt: '2026-10-30T00:00:00Z' }),
  }));
  assert.equal(state.level, 'low');
  assert.equal(state.freeBrainBotCount, 1);
});

test('dismissal suppresses the same level for the current cycle only', async () => {
  let cycleResetAt = '2026-10-30T00:00:00Z';
  const deps = makeDeps({
    fetchQuota: async () => ({ quotaRemaining: 100, quotaTotal: 1000, quotaCycleResetAt: cycleResetAt }),
  });
  const controller = createQuotaNudgeController({ ...deps, emit: () => {}, pollIntervalMs: 0 });
  const low = await controller.refresh();
  assert.equal(low.level, 'low');
  const dismissed = await controller.dismiss('low');
  assert.equal(dismissed.level, 'none');
  assert.equal(dismissed.reason, 'dismissed');
  // A different cycle re-arms the nudge.
  cycleResetAt = '2026-11-06T00:00:00Z';
  const nextCycle = await controller.refresh();
  assert.equal(nextCycle.level, 'low');
  controller.stop();
});

test('dismissing the low nudge does NOT suppress the exhausted alarm in the same cycle', async () => {
  let remaining = 100;
  const deps = makeDeps({
    fetchQuota: async () => ({ quotaRemaining: remaining, quotaTotal: 1000, quotaCycleResetAt: '2026-10-30T00:00:00Z' }),
  });
  const controller = createQuotaNudgeController({ ...deps, emit: () => {}, pollIntervalMs: 0 });
  await controller.refresh();
  await controller.dismiss('low');
  remaining = 0;
  const escalated = await controller.refresh();
  assert.equal(escalated.level, 'exhausted');
  controller.stop();
});

test('controller emits only on state change and stop() ends polling', async () => {
  const emitted = [];
  let bots = [freePrimaryBot(1)];
  const deps = makeDeps({
    listMetabots: () => bots,
    fetchQuota: async () => ({ quotaRemaining: 100, quotaTotal: 1000, quotaCycleResetAt: '2026-10-30T00:00:00Z' }),
  });
  const controller = createQuotaNudgeController({ ...deps, emit: (state) => emitted.push(state), pollIntervalMs: 0 });
  await controller.refresh();
  await controller.refresh();
  assert.equal(emitted.length, 1);
  // A brain edit taking every bot off the free relay flips the state — this
  // is what makes the banner disappear after the user fixes their setup.
  bots = [paidPrimaryBot(1)];
  await controller.refresh();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].level, 'none');
  assert.equal(emitted[1].reason, 'no-free-brain-bots');
  controller.stop();
});

test('numeric (ms-epoch) cycleResetAt from the relay normalizes for per-cycle dismissal', async () => {
  const resetMs = Date.parse('2026-10-30T00:00:00Z');
  const deps = makeDeps({
    fetchQuota: async () => ({ quotaRemaining: 100, quotaTotal: 1000, quotaCycleResetAt: resetMs }),
  });
  const controller = createQuotaNudgeController({ ...deps, emit: () => {}, pollIntervalMs: 0 });
  const low = await controller.refresh();
  assert.equal(low.level, 'low');
  assert.equal(low.cycleResetAt, '2026-10-30T00:00:00.000Z');
  const dismissed = await controller.dismiss('low');
  assert.equal(dismissed.level, 'none');
  assert.equal(dismissed.reason, 'dismissed');
  controller.stop();
});

test('notifyExhaustedSeen forces a quota re-read and is throttled', async () => {
  let fetches = 0;
  let forced = 0;
  const deps = makeDeps({
    fetchQuota: async (input) => {
      fetches += 1;
      if (input.forceRefresh) forced += 1;
      return { quotaRemaining: 0, quotaTotal: 1000, quotaCycleResetAt: '2026-10-30T00:00:00Z' };
    },
  });
  let nowValue = 1_000_000;
  const controller = createQuotaNudgeController({ ...deps, emit: () => {}, pollIntervalMs: 0, now: () => nowValue });
  controller.notifyExhaustedSeen();
  controller.notifyExhaustedSeen();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(forced, 1);
  nowValue += 61_000;
  controller.notifyExhaustedSeen();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(forced, 2);
  controller.stop();
});
