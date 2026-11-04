import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
  }
  return originalLoad.apply(this, arguments);
};
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
const { CoworkCrossSessionService } = require('../dist-electron/main/services/coworkCrossSession.js');
const { CrossSessionDeliveryStore } = require('../dist-electron/main/crossSessionDeliveryStore.js');
Module._load = originalLoad;

async function openWorld(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-cross-session-delivery-'));
  const sqliteStore = await SqliteStore.create(dir);
  const coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const deliveryStore = new CrossSessionDeliveryStore(
    sqliteStore.getDatabase(),
    sqliteStore.getSaveFunction(),
    { backoffMs: options.backoffMs ?? [20, 20] },
  );
  const source = coworkStore.createSession('source', dir, '', 'local', [], 1);
  const target = coworkStore.createSession('target', dir, '', 'local', [], 1);
  const runner = new CoworkRunner(coworkStore, { crossSessionDeliveryStore: deliveryStore });
  const calls = [];
  runner.continueSession = async (sessionId, prompt) => {
    calls.push({ sessionId, prompt });
    if (options.onContinue) await options.onContinue(calls.length);
  };
  return { dir, sqliteStore, coworkStore, deliveryStore, runner, calls, source, target };
}

function dispose(world) {
  try { world.sqliteStore.close(); } catch { /* already closed */ }
  try { fs.rmSync(world.dir, { recursive: true, force: true }); } catch { /* Windows best effort */ }
}

async function waitFor(assertion, timeoutMs = 800) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  if (lastError) throw lastError;
  assertion();
}

function deliveryInput(world, deliveryId, message = 'wake the twin') {
  return {
    sourceSessionId: world.source.id,
    targetSessionId: world.target.id,
    message,
    deliveryId,
  };
}

test('durable delivery completes once and a repeated delivery ID neither reinserts nor reruns', async () => {
  const world = await openWorld();
  try {
    const first = world.runner.insertCrossSessionMessageAndQueue(deliveryInput(world, 'delivery-success'));
    assert.equal(first.insert.ok, true);
    assert.equal(first.runQueued, true);
    await waitFor(() => assert.equal(world.calls.length, 1));

    const row = world.deliveryStore.getById('delivery-success');
    assert.equal(row.state, 'completed');
    assert.equal(row.attempts, 1);
    assert.equal(row.messageId, 'delivery-success');
    assert.ok(row.startedAt !== null);
    assert.ok(row.completedAt !== null);
    assert.equal(world.coworkStore.getSessionMessages(world.target.id).length, 1);
    assert.equal(
      world.coworkStore.getSessionMessages(world.target.id)[0].metadata.crossSessionDeliveryId,
      'delivery-success',
    );

    const second = world.runner.insertCrossSessionMessageAndQueue(deliveryInput(world, 'delivery-success'));
    assert.equal(second.insert.ok, true);
    assert.equal(second.insert.reused, true);
    assert.equal(second.runQueued, false);
    assert.equal(second.reason, 'DELIVERY_COMPLETED');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(world.calls.length, 1);
    assert.equal(world.coworkStore.getSessionMessages(world.target.id).length, 1);

    const snapshot = world.runner.getCrossSessionDeliveryReliabilitySnapshot();
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.completed, 1);
    assert.equal(snapshot.pending, 0);
    assert.equal(snapshot.attempts, 1);
    assert.ok(snapshot.averageCompletionLatencyMs >= 0);
  } finally {
    dispose(world);
  }
});

test('a deep backlog drains in paced batches instead of one back-to-back burst', async () => {
  const originalCap = CoworkRunner.DURABLE_CROSS_SESSION_MAX_CONTINUATIONS_PER_DRAIN;
  const originalPace = CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_PACE_MS;
  CoworkRunner.DURABLE_CROSS_SESSION_MAX_CONTINUATIONS_PER_DRAIN = 2;
  CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_PACE_MS = 20;
  try {
    const world = await openWorld();
    try {
      for (let i = 0; i < 5; i += 1) {
        const queued = world.runner.insertCrossSessionMessageAndQueue(
          deliveryInput(world, `delivery-pace-${i}`, `pace ${i}`),
        );
        assert.equal(queued.insert.ok, true, JSON.stringify(queued));
      }
      // Pass 1 stops at the cap; paced passes finish the rest in FIFO order.
      await waitFor(() => assert.equal(world.calls.length, 5), 2000);
      assert.deepEqual(
        world.calls.map((call) => (call.prompt.match(/<cross_session_message[^>]*>([^<]*)</) ?? [])[1]),
        ['pace 0', 'pace 1', 'pace 2', 'pace 3', 'pace 4'],
      );
      const snapshot = world.runner.getCrossSessionDeliveryReliabilitySnapshot();
      assert.equal(snapshot.completed, 5);
      assert.equal(snapshot.pending, 0);
    } finally {
      dispose(world);
    }
  } finally {
    CoworkRunner.DURABLE_CROSS_SESSION_MAX_CONTINUATIONS_PER_DRAIN = originalCap;
    CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_PACE_MS = originalPace;
  }
});

test('replayed backlog past the daily budget defers to the next day; live deliveries keep flowing', async () => {
  const originalBudget = CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_DAILY_BUDGET;
  const originalAppStart = CoworkRunner.DURABLE_CROSS_SESSION_APP_START_MS;
  const originalCap = CoworkRunner.DURABLE_CROSS_SESSION_MAX_CONTINUATIONS_PER_DRAIN;
  const originalPace = CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_PACE_MS;
  // Everything enqueued "now" counts as a replay (created before the patched
  // app-start marker), so the budget gate is exercisable in-process.
  CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_DAILY_BUDGET = 2;
  CoworkRunner.DURABLE_CROSS_SESSION_APP_START_MS = Date.now() + 3_600_000;
  CoworkRunner.DURABLE_CROSS_SESSION_MAX_CONTINUATIONS_PER_DRAIN = 3;
  CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_PACE_MS = 5;
  try {
    const world = await openWorld();
    try {
      for (let i = 0; i < 4; i += 1) {
        const queued = world.runner.insertCrossSessionMessageAndQueue(
          deliveryInput(world, `delivery-budget-${i}`, `budget ${i}`),
        );
        assert.equal(queued.insert.ok, true, JSON.stringify(queued));
      }
      await waitFor(() => assert.equal(world.calls.length, 2), 2000);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(world.calls.length, 2, 'the budget stops further replay turns today');

      const snapshot = world.runner.getCrossSessionDeliveryReliabilitySnapshot();
      assert.equal(snapshot.completed, 2);
      assert.equal(snapshot.pending, 2, 'deferred rows stay pending, never dropped');

      for (const id of ['delivery-budget-2', 'delivery-budget-3']) {
        const row = world.deliveryStore.getById(id);
        assert.equal(row.state, 'pending');
        assert.equal(row.lastError, 'REPLAY_DAILY_BUDGET_DEFERRED');
        const expectedMidnight = new Date(
          new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1, 0, 0, 0, 0,
        ).getTime();
        assert.equal(row.nextAttemptAt, expectedMidnight);
      }

      // A delivery enqueued by the CURRENT session never counts against the
      // replay budget: rewind the replay window so new rows classify as live.
      CoworkRunner.DURABLE_CROSS_SESSION_APP_START_MS = Date.now() - 1;
      const live = world.runner.insertCrossSessionMessageAndQueue({
        sourceSessionId: world.source.id,
        targetSessionId: world.target.id,
        message: 'live today',
        deliveryId: 'delivery-live-today',
      });
      assert.equal(live.insert.ok, true, JSON.stringify(live));
      await waitFor(() => assert.equal(world.calls.length, 3), 2000);
      assert.equal(
        world.calls[2].prompt.includes('live today'),
        true,
        'live delivery drains despite the exhausted replay budget',
      );
      assert.equal(world.deliveryStore.getById('delivery-budget-2').state, 'pending', 'deferred replay stays parked');
    } finally {
      dispose(world);
    }
  } finally {
    CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_DAILY_BUDGET = originalBudget;
    CoworkRunner.DURABLE_CROSS_SESSION_APP_START_MS = originalAppStart;
    CoworkRunner.DURABLE_CROSS_SESSION_MAX_CONTINUATIONS_PER_DRAIN = originalCap;
    CoworkRunner.DURABLE_CROSS_SESSION_REPLAY_PACE_MS = originalPace;
  }
});

test('restart after message insert but before outbox attachment adopts the message without duplication', async () => {
  const world = await openWorld();
  try {
    const input = deliveryInput(world, 'crash-before-attach', 'persisted before crash');
    world.deliveryStore.enqueue(input);
    const inserted = new CoworkCrossSessionService(world.coworkStore).insertUserMessage(input);
    assert.equal(inserted.ok, true);
    assert.equal(world.deliveryStore.getById(input.deliveryId).messageId, null);

    await waitFor(() => assert.equal(world.deliveryStore.getById(input.deliveryId).state, 'completed'));
    assert.equal(world.calls.length, 1);
    assert.equal(world.coworkStore.getSessionMessages(world.target.id).length, 1);
    assert.equal(world.deliveryStore.getById(input.deliveryId).messageId, input.deliveryId);
  } finally {
    dispose(world);
  }
});

test('restart while running requeues the delivery and keeps the original message', async () => {
  const world = await openWorld();
  try {
    const input = deliveryInput(world, 'crash-while-running', 'interrupted continuation');
    world.deliveryStore.enqueue(input);
    const inserted = new CoworkCrossSessionService(world.coworkStore).insertUserMessage(input);
    world.deliveryStore.attachMessage(input.deliveryId, inserted.message.id, inserted.message.content);
    world.deliveryStore.markRunning(input.deliveryId);
    assert.equal(world.deliveryStore.getById(input.deliveryId).state, 'running');

    await waitFor(() => assert.equal(world.deliveryStore.getById(input.deliveryId).state, 'completed'));
    const row = world.deliveryStore.getById(input.deliveryId);
    assert.equal(row.attempts, 2, 'the recovered continuation is a new attempt');
    assert.equal(world.calls.length, 1);
    assert.equal(world.coworkStore.getSessionMessages(world.target.id).length, 1);
  } finally {
    dispose(world);
  }
});

test('a failed continuation retries with the stored message and completes without another insert', async () => {
  let releaseSecondAttempt;
  const secondAttemptGate = new Promise((resolve) => { releaseSecondAttempt = resolve; });
  const world = await openWorld({
    onContinue: async (attempt) => {
      if (attempt === 1) throw new Error('temporary model outage');
      await secondAttemptGate;
    },
  });
  try {
    world.runner.insertCrossSessionMessageAndQueue(deliveryInput(world, 'retry-success'));
    await waitFor(() => assert.match(world.deliveryStore.getById('retry-success').lastError ?? '', /temporary model outage/));
    assert.equal(world.deliveryStore.getById('retry-success').state, 'pending');
    assert.equal(world.deliveryStore.getById('retry-success').attempts, 1);

    releaseSecondAttempt();
    await waitFor(() => assert.equal(world.deliveryStore.getById('retry-success').state, 'completed'));
    assert.equal(world.calls.length, 2);
    assert.equal(world.deliveryStore.getById('retry-success').attempts, 2);
    assert.equal(world.coworkStore.getSessionMessages(world.target.id).length, 1);
    assert.equal(world.runner.getCrossSessionDeliveryReliabilitySnapshot().retrying, 0);
  } finally {
    releaseSecondAttempt();
    dispose(world);
  }
});

test('persistent failures become terminal failed with bounded attempts and visible metrics', async () => {
  const world = await openWorld({
    backoffMs: [5, 5],
    onContinue: () => { throw new Error('persistent outage'); },
  });
  try {
    world.runner.insertCrossSessionMessageAndQueue(deliveryInput(world, 'retry-exhausted'));
    await waitFor(() => assert.equal(world.deliveryStore.getById('retry-exhausted').state, 'failed'));
    assert.equal(world.calls.length, 3);
    assert.equal(world.deliveryStore.getById('retry-exhausted').attempts, 3);
    assert.equal(world.coworkStore.getSessionMessages(world.target.id).length, 1);

    const snapshot = world.runner.getCrossSessionDeliveryReliabilitySnapshot();
    assert.equal(snapshot.failed, 1);
    assert.equal(snapshot.pending, 0);
    assert.equal(snapshot.attempts, 3);
  } finally {
    dispose(world);
  }
});

test('a busy target preserves durable FIFO order until the current turn settles', async () => {
  const world = await openWorld();
  try {
    world.runner.markCrossSessionTurnRunning(world.target.id);
    world.runner.insertCrossSessionMessageAndQueue(deliveryInput(world, 'busy-first', 'first'));
    world.runner.insertCrossSessionMessageAndQueue(deliveryInput(world, 'busy-second', 'second'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(world.calls.length, 0);
    assert.equal(world.deliveryStore.countPending(world.target.id), 2);

    world.runner.markCrossSessionTurnSettled(world.target.id);
    await waitFor(() => assert.equal(world.calls.length, 2));
    assert.match(world.calls[0].prompt, /first/);
    assert.match(world.calls[1].prompt, /second/);
    assert.equal(world.deliveryStore.getById('busy-first').state, 'completed');
    assert.equal(world.deliveryStore.getById('busy-second').state, 'completed');
  } finally {
    dispose(world);
  }
});

test('a stopped target keeps the message but cancels the durable wake obligation', async () => {
  const world = await openWorld();
  try {
    world.runner.stopSession(world.target.id);
    const result = world.runner.insertCrossSessionMessageAndQueue(deliveryInput(world, 'stopped-target'));
    assert.equal(result.insert.ok, true);
    assert.equal(result.runQueued, false);
    assert.equal(result.reason, 'TARGET_SESSION_STOPPED');
    assert.equal(world.deliveryStore.getById('stopped-target').state, 'cancelled');
    assert.equal(world.coworkStore.getSessionMessages(world.target.id).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(world.calls.length, 0);
  } finally {
    dispose(world);
  }
});

test('an invalid target leaves a cancelled audit record and performs no continuation', async () => {
  const world = await openWorld();
  try {
    const a2a = world.coworkStore.createSession('a2a-target', world.dir, '', 'local', [], 1, 'a2a');
    const result = world.runner.insertCrossSessionMessageAndQueue({
      sourceSessionId: world.source.id,
      targetSessionId: a2a.id,
      message: 'not allowed',
      deliveryId: 'invalid-target',
    });
    assert.equal(result.insert.ok, false);
    assert.equal(result.insert.code, 'WRITE_NOT_ALLOWED_FOR_A2A');
    assert.equal(world.deliveryStore.getById('invalid-target').state, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(world.calls.length, 0);
  } finally {
    dispose(world);
  }
});

test('reusing a delivery ID for different work is refused as a conflict', async () => {
  const world = await openWorld();
  try {
    world.deliveryStore.enqueue(deliveryInput(world, 'stable-id', 'original'));
    assert.throws(
      () => world.deliveryStore.enqueue(deliveryInput(world, 'stable-id', 'different')),
      /CROSS_SESSION_DELIVERY_CONFLICT/,
    );
  } finally {
    dispose(world);
  }
});
