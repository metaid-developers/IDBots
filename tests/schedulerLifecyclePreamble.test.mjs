import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

function loadSchedulerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const schedulerPath = require.resolve('../dist-electron/main/libs/scheduler.js');
    delete require.cache[schedulerPath];
    return require(schedulerPath);
  } finally {
    Module._load = originalLoad;
  }
}

function recurringTask(overrides = {}) {
  return {
    id: 'task-probe',
    name: 'Endpoint probe',
    schedule: { type: 'cron', expression: '0 */2 * * *' },
    prompt: 'Probe the endpoint.',
    maxFires: null,
    fireCount: 0,
    exitCondition: null,
    originSessionId: null,
    originContext: null,
    ...overrides,
  };
}

test('preamble states fire number, budget, exit clause, and the retire instruction', () => {
  const { buildScheduledTaskLifecyclePreamble } = loadSchedulerModule();
  const preamble = buildScheduledTaskLifecyclePreamble(recurringTask({
    exitCondition: 'Endpoint recovers and the order is delivered.',
    maxFires: 50,
    fireCount: 11, // 11 completed fires → this is fire #12, 38 remaining
    originSessionId: 'sess-origin',
    originContext: 'a2a',
  }));

  assert.ok(preamble.includes('fire #12'), 'fire number counts the current fire');
  assert.ok(preamble.includes('50 total, 38 remaining'));
  assert.ok(preamble.includes('Exit condition (declared at creation): "Endpoint recovers and the order is delivered."'));
  assert.ok(preamble.includes('toggle-task.sh" task-probe false'), 'retire instruction carries the task id');
  assert.ok(preamble.includes('Created from session sess-origin (a2a)'));
  assert.ok(!preamble.includes('FINAL'));
});

test('preamble flags the final fire and adapts when nothing is declared', () => {
  const { buildScheduledTaskLifecyclePreamble } = loadSchedulerModule();

  const finalFire = buildScheduledTaskLifecyclePreamble(recurringTask({
    maxFires: 50,
    fireCount: 49, // fire #50 of 50
  }));
  assert.ok(finalFire.includes('FINAL fire'));
  assert.ok(finalFire.includes('No exit condition was declared'));

  const uncapped = buildScheduledTaskLifecyclePreamble(recurringTask());
  assert.ok(!uncapped.includes('Fire budget'));
  assert.ok(uncapped.includes('No exit condition was declared'));
  assert.ok(!uncapped.includes('Created from session'));
});

test('one-shot "at" tasks get no preamble — the host already retires them', () => {
  const { buildScheduledTaskLifecyclePreamble } = loadSchedulerModule();
  const preamble = buildScheduledTaskLifecyclePreamble(recurringTask({
    schedule: { type: 'at', datetime: '2026-10-25T09:00:00' },
    maxFires: 50,
    exitCondition: 'whatever',
  }));
  assert.equal(preamble, '');
});

test('preamble tolerates tasks without lifecycle fields (legacy rows)', () => {
  const { buildScheduledTaskLifecyclePreamble } = loadSchedulerModule();
  const legacy = {
    id: 'legacy',
    name: 'Legacy',
    schedule: { type: 'interval', intervalMs: 60000 },
    prompt: 'x',
    // no maxFires / fireCount / exitCondition / originSessionId at all
  };
  const preamble = buildScheduledTaskLifecyclePreamble(legacy);
  assert.ok(preamble.includes('fire #1'));
  assert.ok(preamble.includes('No exit condition was declared'));
});

// ---------------------------------------------------------------------------
// End-of-run follow-up contract (every scheduled run, one-shot included)
// ---------------------------------------------------------------------------

test('follow-up contract states both tags, the never-omit rule, and the third-party carve-out', () => {
  const { buildScheduledTaskFollowUpContract } = loadSchedulerModule();
  const contract = buildScheduledTaskFollowUpContract();

  assert.ok(contract.includes('[End-of-run follow-up contract]'));
  assert.ok(contract.includes('[FOLLOW_UP: none]'), 'the none tag is spelled out');
  assert.ok(contract.includes('[FOLLOW_UP: owner —'), 'the owner tag (with payload) is spelled out');
  assert.ok(contract.includes('Never omit the tag'));
  assert.ok(contract.includes('third parties'), 'waiting on another bot/person/group is not the owner follow-up');
});

test('follow-up contract is task-independent and non-empty for one-shot runs', () => {
  const { buildScheduledTaskFollowUpContract } = loadSchedulerModule();
  const once = buildScheduledTaskFollowUpContract();
  const again = buildScheduledTaskFollowUpContract();
  assert.equal(once, again, 'static contract text');
  assert.ok(once.length > 0, 'one-shot "at" tasks get the contract even though they get no lifecycle preamble');
});
