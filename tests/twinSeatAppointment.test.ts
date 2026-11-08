import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appointTwinSeat,
  type TwinSeatAppointmentOutcome,
  type TwinSeatBot,
  type TwinSeatUpdatePatch,
} from '../src/renderer/features/botBrowser/twinSeatAppointment';

// Behavior-level coverage for the Twin-seat swap (owner ruling 2026-11-08).
// The whole IPC surface is a mock: the dev fixture bots are identity-protected
// (testbot/test-2 must never change metabot_type), so these tests exercise the
// sequence, the rollback and the toast text instead of clicking a real roster.

const twinA: TwinSeatBot = { id: 1, name: 'Alice', metabot_type: 'twin' };
const workerB: TwinSeatBot = { id: 2, name: 'Bob', metabot_type: 'worker' };
const workerC: TwinSeatBot = { id: 3, name: 'Carol', metabot_type: 'worker' };

type UpdateCall = { id: number; patch: TwinSeatUpdatePatch };
type ScriptStep = { success: boolean; error?: string } | Error;

interface Harness {
  calls: UpdateCall[];
  toasts: string[];
  reloads: number;
  update: (id: number, patch: TwinSeatUpdatePatch) => Promise<{ success: boolean; error?: string }>;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  translate: (key: string) => string;
}

function createHarness(script: ScriptStep[]): Harness {
  const calls: UpdateCall[] = [];
  const toasts: string[] = [];
  let reloads = 0;
  return {
    calls,
    toasts,
    get reloads() {
      return reloads;
    },
    async update(id, patch) {
      calls.push({ id, patch });
      const step = script[calls.length - 1] ?? { success: true };
      if (step instanceof Error) throw step;
      return step;
    },
    async reload() {
      reloads += 1;
    },
    notify(message) {
      toasts.push(message);
    },
    translate(key) {
      if (key === 'botInternetTwinSeatAppointed') return '{name} 已就任 Twin。';
      if (key === 'botInternetTwinSeatRollbackFailed') return '原当值 Twin 未能复原。';
      return key;
    },
  };
}

async function run(
  target: TwinSeatBot,
  roster: TwinSeatBot[],
  script: ScriptStep[],
): Promise<{ outcome: TwinSeatAppointmentOutcome; harness: Harness }> {
  const harness = createHarness(script);
  const outcome = await appointTwinSeat(target, roster, harness);
  return { outcome, harness };
}

test('appointment demotes the acting Twin to worker before promoting the target', async () => {
  const { outcome, harness } = await run(workerB, [twinA, workerB, workerC], [
    { success: true },
    { success: true },
  ]);

  assert.deepEqual(harness.calls, [
    { id: 1, patch: { metabot_type: 'worker' } },
    { id: 2, patch: { metabot_type: 'twin' } },
  ]);
  assert.equal(harness.reloads, 1, 'the roster must be re-read after a successful swap');
  assert.deepEqual(harness.toasts, ['Bob 已就任 Twin。']);
  assert.deepEqual(outcome, {
    status: 'appointed',
    targetId: 2,
    previousTwinId: 1,
    rollbackAttempted: false,
  });
});

test('a failed promote restores the previous Twin and skips the roster reload', async () => {
  const { outcome, harness } = await run(workerB, [twinA, workerB], [
    { success: true },
    { success: false, error: 'chain sync failed' },
    { success: true },
  ]);

  assert.deepEqual(harness.calls, [
    { id: 1, patch: { metabot_type: 'worker' } },
    { id: 2, patch: { metabot_type: 'twin' } },
    { id: 1, patch: { metabot_type: 'twin' } },
  ]);
  assert.equal(harness.reloads, 0, 'a failed swap must not pretend the roster changed');
  assert.deepEqual(harness.toasts, ['chain sync failed']);
  assert.deepEqual(outcome, {
    status: 'failed',
    stage: 'promote',
    error: 'chain sync failed',
    rollbackAttempted: true,
    rollbackSucceeded: true,
  });
});

test('a failed rollback tells the owner the previous Twin needs manual recovery', async () => {
  const { outcome, harness } = await run(workerB, [twinA, workerB], [
    { success: true },
    { success: false, error: 'promote rejected' },
    { success: false, error: 'rollback rejected' },
  ]);

  assert.equal(harness.toasts.length, 1);
  assert.ok(harness.toasts[0].includes('promote rejected'));
  assert.ok(harness.toasts[0].includes('原当值 Twin 未能复原。'));
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.rollbackAttempted, true);
    assert.equal(outcome.rollbackSucceeded, false);
  }
});

test('a thrown rollback update is treated as a failed rollback', async () => {
  const { outcome } = await run(workerB, [twinA, workerB], [
    { success: true },
    { success: false, error: 'promote rejected' },
    new Error('ipc crashed'),
  ]);

  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.rollbackAttempted, true);
    assert.equal(outcome.rollbackSucceeded, false);
  }
});

test('a failed demote aborts before any promote and leaves the old seat untouched', async () => {
  const { outcome, harness } = await run(workerB, [twinA, workerB], [
    { success: false, error: 'demote rejected' },
  ]);

  assert.deepEqual(harness.calls, [{ id: 1, patch: { metabot_type: 'worker' } }]);
  assert.equal(harness.reloads, 0);
  assert.deepEqual(harness.toasts, ['demote rejected']);
  assert.deepEqual(outcome, {
    status: 'failed',
    stage: 'demote',
    error: 'demote rejected',
    rollbackAttempted: false,
    rollbackSucceeded: false,
  });
});

test('appointing the current Twin is a no-op', async () => {
  const { outcome, harness } = await run(twinA, [twinA, workerB], []);

  assert.deepEqual(harness.calls, []);
  assert.equal(harness.reloads, 0);
  assert.deepEqual(harness.toasts, []);
  assert.deepEqual(outcome, { status: 'unchanged', targetId: 1 });
});

test('a machine without a Twin only promotes the target', async () => {
  const { outcome, harness } = await run(workerB, [workerB, workerC], [{ success: true }]);

  assert.deepEqual(harness.calls, [{ id: 2, patch: { metabot_type: 'twin' } }]);
  assert.equal(harness.reloads, 1);
  assert.deepEqual(harness.toasts, ['Bob 已就任 Twin。']);
  assert.deepEqual(outcome, {
    status: 'appointed',
    targetId: 2,
    previousTwinId: null,
    rollbackAttempted: false,
  });
});
