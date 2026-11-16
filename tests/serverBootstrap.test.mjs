import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * REQ-A-8 / REQ-A-29 server bootstrap tests.
 *
 * The state-machine core (src/main/server/bootstrap.ts, compiled to
 * dist-electron/main) is exercised from plain node: fake step executors count
 * side effects, and the persistence layer runs against a REAL temp SQLite via
 * the same code path as production (SqliteStore + ServerBootstrapStore), so a
 * simulated crash after any step (drop the JS references, reopen the DB file)
 * must resume from the first step not done/skipped with completed steps never
 * re-running.
 */

const require = createRequire(import.meta.url);

const bootstrap = require('../dist-electron/main/server/bootstrap.js');
const { resolveBootstrapTwinBrain } = require('../dist-electron/main/server/bootstrapSteps.js');
const readiness = require('../dist-electron/main/gateway/readiness.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');

const {
  SERVER_BOOTSTRAP_STEP_IDS,
  SERVER_BOOTSTRAP_CRITICAL_STEPS,
  BOOTSTRAP_RETRY_BASE_MS,
  BOOTSTRAP_RETRY_MAX_MS,
  computeBootstrapRetryDelayMs,
  ensureServerBootstrapSchema,
  ServerBootstrapStore,
  runServerBootstrap,
} = bootstrap;

const VERSION = { version: '0.0.0-test', commit: 'testcommit', contractVersion: '1.0.0' };

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-server-bootstrap-'));

/** Real SQLite through the production code path. */
async function openBootstrapStore(tempDir) {
  const sqliteStore = await SqliteStore.create(tempDir);
  return {
    sqliteStore,
    bootstrapStore: new ServerBootstrapStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction()),
  };
}

/** Executors that count invocations and optionally throw/skip per step. */
function makeCountingExecutors(behavior = {}) {
  const counts = Object.fromEntries(SERVER_BOOTSTRAP_STEP_IDS.map((step) => [step, 0]));
  const executors = Object.fromEntries(
    SERVER_BOOTSTRAP_STEP_IDS.map((step) => [
      step,
      async () => {
        counts[step] += 1;
        const custom = behavior[step];
        if (custom) return custom(counts[step]);
        return undefined;
      },
    ]),
  );
  return { counts, executors };
}

function collectPhases(onStateChange) {
  const phases = [];
  return {
    phases,
    observer: (snapshot) => {
      if (phases[phases.length - 1] !== snapshot.phase) {
        phases.push(snapshot.phase);
      }
      onStateChange?.(snapshot);
    },
  };
}

test('the first mobile Twin pairs the ID.Bots DeepSeek flash primary with GLM-5.3 Flash fallback', () => {
  const brain = resolveBootstrapTwinBrain({
    providers: {
      idbots: {
        enabled: true,
        models: [{ id: 'deepseek-4.1-flash' }, { id: 'glm-5.3-flash' }],
      },
      zhipu: {
        enabled: true,
        apiKey: 'configured',
        models: [{ id: 'glm-other' }],
      },
    },
    model: { defaultProvider: 'zhipu', defaultModel: 'glm-other' },
  });
  assert.deepEqual(brain, {
    llmId: 'deepseek-4.1-flash',
    llmProvider: 'idbots',
    fallbackLlmId: 'glm-5.3-flash',
    fallbackLlmProvider: 'idbots',
  });
});

// ---------------------------------------------------------------------------
// Retry schedule (REQ-A-8: 30s → 60s → 120s → 300s constant cap)
// ---------------------------------------------------------------------------

test('computeBootstrapRetryDelayMs backs off 30s→60s→120s→300s and caps at 5 minutes', () => {
  assert.equal(BOOTSTRAP_RETRY_BASE_MS, 30_000);
  assert.equal(BOOTSTRAP_RETRY_MAX_MS, 300_000);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 10].map((attempts) => computeBootstrapRetryDelayMs(attempts)),
    [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000],
  );
  assert.ok(computeBootstrapRetryDelayMs(Number.MAX_SAFE_INTEGER) <= BOOTSTRAP_RETRY_MAX_MS);
});

test('steps 1-4 are critical (failure → failed), steps 5-7 optional (failure → degraded)', () => {
  assert.deepEqual([...SERVER_BOOTSTRAP_CRITICAL_STEPS].sort(), [
    'identity',
    'llmProvider',
    'twinMetabot',
    'workspace',
  ]);
});

// ---------------------------------------------------------------------------
// REQ-A-29: simulated crash after each step resumes without re-running
// completed steps (real temp SQLite, same code path as production).
// ---------------------------------------------------------------------------

for (const crashStep of SERVER_BOOTSTRAP_STEP_IDS) {
  test(`REQ-A-29 crash after step "${crashStep}" resumes from the next step, never re-runs completed steps`, async () => {
    const tempDir = makeTempDir();
    const storeA = await openBootstrapStore(tempDir);
    const behavior = { redeemCode: () => ({ skipped: true }) };
    const { counts: counts1, executors } = makeCountingExecutors(behavior);

    // Pass 1: run until the crash point, then drop all references (SIGKILL).
    let crashHook;
    const crashed = new Promise((resolve) => {
      crashHook = resolve;
    });
    const run1 = runServerBootstrap({
      bootstrapStore: storeA.bootstrapStore,
      executors,
      version: VERSION,
      onStateChange: (snapshot) => {
        const record = snapshot.steps.find((item) => item.step === crashStep);
        if (record && (record.state === 'done' || record.state === 'skipped')) {
          run1.stop();
          crashHook(snapshot);
        }
      },
    });
    run1.start();
    const crashSnapshot = await crashed;
    assert.equal(
      crashSnapshot.steps.find((item) => item.step === crashStep).state,
      crashStep === 'redeemCode' ? 'skipped' : 'done',
    );
    storeA.sqliteStore.close();

    // "Restart": fresh SqliteStore connection + fresh state machine instance.
    const storeB = await openBootstrapStore(tempDir);
    const { counts: counts2, executors: executors2 } = makeCountingExecutors(behavior);
    const run2 = runServerBootstrap({
      bootstrapStore: storeB.bootstrapStore,
      executors: executors2,
      version: VERSION,
    });
    run2.start();
    const outcome = await run2.finished;
    assert.equal(outcome.phase, 'ready');

    const crashIndex = SERVER_BOOTSTRAP_STEP_IDS.indexOf(crashStep);
    for (const step of SERVER_BOOTSTRAP_STEP_IDS) {
      const index = SERVER_BOOTSTRAP_STEP_IDS.indexOf(step);
      if (index <= crashIndex) {
        assert.equal(counts2[step], 0, `completed step "${step}" must not re-run after a crash`);
      } else {
        assert.equal(counts2[step], 1, `pending step "${step}" must run exactly once on resume`);
      }
    }

    // The DB record is the source of truth: every step settled done/skipped.
    const finalStates = Object.fromEntries(
      storeB.bootstrapStore.listStepStates().map((record) => [record.step, record.state]),
    );
    for (const step of SERVER_BOOTSTRAP_STEP_IDS) {
      assert.ok(
        finalStates[step] === 'done' || finalStates[step] === 'skipped',
        `step "${step}" settled as ${finalStates[step]}`,
      );
    }
    assert.equal(finalStates.redeemCode, 'skipped');
    assert.equal(run2.getReadinessState().phase, 'ready');
    assert.equal(run2.getReadinessState().error, null);
    storeB.sqliteStore.close();
  });
}

test('REQ-A-29 interrupted step re-runs once and settles (no lost side-effect guard)', async () => {
  const tempDir = makeTempDir();
  const storeA = await openBootstrapStore(tempDir);
  const counts1 = Object.fromEntries(SERVER_BOOTSTRAP_STEP_IDS.map((step) => [step, 0]));
  // The twinMetabot side effect never settles: a true mid-step kill (SIGKILL
  // between the side effect and the done record).
  const executors = Object.fromEntries(
    SERVER_BOOTSTRAP_STEP_IDS.map((step) => [
      step,
      async () => {
        counts1[step] += 1;
        if (step === 'twinMetabot') await new Promise(() => {});
        return undefined;
      },
    ]),
  );

  let crashHook;
  const crashed = new Promise((resolve) => {
    crashHook = resolve;
  });
  const run1 = runServerBootstrap({
    bootstrapStore: storeA.bootstrapStore,
    executors,
    version: VERSION,
    onStateChange: (snapshot) => {
      if (snapshot.steps.find((item) => item.step === 'twinMetabot')?.state === 'running') {
        run1.stop();
        crashHook();
      }
    },
  });
  run1.start();
  await crashed;
  assert.equal(counts1.twinMetabot, 1);
  assert.equal(storeA.bootstrapStore.getStepState('twinMetabot').state, 'running');
  storeA.sqliteStore.close();

  const storeB = await openBootstrapStore(tempDir);
  const { counts: counts2, executors: executors2 } = makeCountingExecutors();
  const run2 = runServerBootstrap({ bootstrapStore: storeB.bootstrapStore, executors: executors2, version: VERSION });
  run2.start();
  const outcome = await run2.finished;
  assert.equal(outcome.phase, 'ready');
  assert.equal(counts2.identity, 0);
  assert.equal(counts2.llmProvider, 0);
  assert.equal(counts2.twinMetabot, 1, 'interrupted step re-runs exactly once');
  storeB.sqliteStore.close();
});

// ---------------------------------------------------------------------------
// Idempotency: double start() is a no-op; a fresh run on a settled volume
// fast-paths to ready without executing any step.
// ---------------------------------------------------------------------------

test('idempotent double-run: start() twice executes every step exactly once', async () => {
  const tempDir = makeTempDir();
  const { bootstrapStore, sqliteStore } = await openBootstrapStore(tempDir);
  const { counts, executors } = makeCountingExecutors();
  const run = runServerBootstrap({ bootstrapStore, executors, version: VERSION });
  run.start();
  run.start();
  const outcome = await run.finished;
  assert.equal(outcome.phase, 'ready');
  for (const step of SERVER_BOOTSTRAP_STEP_IDS) {
    assert.equal(counts[step], 1, `step "${step}" ran once`);
  }
  sqliteStore.close();
});

test('existing volume fast-path: all steps done/skipped → ready with zero side effects', async () => {
  const tempDir = makeTempDir();
  const storeA = await openBootstrapStore(tempDir);
  const run1 = runServerBootstrap({
    bootstrapStore: storeA.bootstrapStore,
    executors: makeCountingExecutors({ redeemCode: () => ({ skipped: true }) }).executors,
    version: VERSION,
  });
  run1.start();
  await run1.finished;
  storeA.sqliteStore.close();

  const storeB = await openBootstrapStore(tempDir);
  const { counts, executors } = makeCountingExecutors();
  const { phases, observer } = collectPhases();
  // Re-run with an observer to watch the phase walk.
  const run3 = runServerBootstrap({ bootstrapStore: storeB.bootstrapStore, executors, version: VERSION, onStateChange: observer });
  run3.start();
  const outcome = await run3.finished;
  assert.equal(outcome.phase, 'ready');
  for (const step of SERVER_BOOTSTRAP_STEP_IDS) {
    assert.equal(counts[step], 0, `settled step "${step}" must no-op`);
  }
  assert.deepEqual(phases, ['migrating', 'bootstrapping', 'ready']);
  storeB.sqliteStore.close();
});

// ---------------------------------------------------------------------------
// Failure semantics (REQ-A-8): critical → failed + bounded retry; optional →
// degraded (ready for chat) with error {step, message}.
// ---------------------------------------------------------------------------

test('step-5 failure (trafficAccount) → degraded: ready for chat, error set, later steps still run', async () => {
  const tempDir = makeTempDir();
  const { bootstrapStore, sqliteStore } = await openBootstrapStore(tempDir);
  const { counts, executors } = makeCountingExecutors({
    trafficAccount: () => {
      throw new Error('traffic backend unreachable');
    },
  });
  const run = runServerBootstrap({ bootstrapStore, executors, version: VERSION });
  run.start();
  const outcome = await run.finished;
  assert.equal(outcome.phase, 'degraded');
  assert.deepEqual(outcome.error, { step: 'trafficAccount', message: 'traffic backend unreachable' });

  const state = run.getReadinessState();
  assert.equal(state.phase, 'degraded');
  assert.deepEqual(state.error, { step: 'trafficAccount', message: 'traffic backend unreachable' });
  assert.equal(state.onboarding.trafficAccount, 'failed');
  assert.equal(state.onboarding.identity, 'done');
  const listenerRecord = run.getSnapshot().steps.find((item) => item.step === 'listener');
  assert.equal(listenerRecord.state, 'done', 'listener still runs after an optional failure');

  // Degraded still means ready-for-chat (C1): /readyz answers 200.
  assert.equal(readiness.buildReadinessResponse(state).status, 200);
  assert.equal(counts.listener, 1);
  sqliteStore.close();
});

test('step-7 failure (listener) → degraded with the listener error recorded', async () => {
  const tempDir = makeTempDir();
  const { bootstrapStore, sqliteStore } = await openBootstrapStore(tempDir);
  const { executors } = makeCountingExecutors({
    listener: () => {
      throw new Error('listener socket never connected');
    },
  });
  const run = runServerBootstrap({ bootstrapStore, executors, version: VERSION });
  run.start();
  const outcome = await run.finished;
  assert.equal(outcome.phase, 'degraded');
  assert.deepEqual(outcome.error, { step: 'listener', message: 'listener socket never connected' });
  assert.equal(readiness.buildReadinessResponse(run.getReadinessState()).status, 200);
  sqliteStore.close();
});

test('step-2 failure (llmProvider) → failed, retried with 30s→60s→120s→300s backoff, converges when healed', async () => {
  const tempDir = makeTempDir();
  const { bootstrapStore, sqliteStore } = await openBootstrapStore(tempDir);

  const delays = [];
  const scheduled = [];
  let attempts = 0;
  let healAfter = Number.MAX_SAFE_INTEGER;
  const counts = Object.fromEntries(SERVER_BOOTSTRAP_STEP_IDS.map((step) => [step, 0]));
  // Timer injection: record the intended delay, fire passes manually so the
  // assertion points are deterministic.
  const setTimeoutFn = (fn, ms) => {
    delays.push(ms);
    const timer = setTimeout(() => {}, 0);
    scheduled.push({ fn });
    return timer;
  };
  const waitFor = (cond) => new Promise((resolve, reject) => {
    const check = () => {
      if (cond()) return resolve();
      setTimeout(check, 5);
    };
    check();
  });
  const executors = Object.fromEntries(
    SERVER_BOOTSTRAP_STEP_IDS.map((step) => [
      step,
      async () => {
        counts[step] += 1;
        if (step === 'llmProvider' && counts[step] <= healAfter) {
          attempts += 1;
          throw new Error(`relay down (attempt ${attempts})`);
        }
        return undefined;
      },
    ]),
  );
  const run = runServerBootstrap({
    bootstrapStore,
    executors,
    version: VERSION,
    setTimeoutFn,
  });
  run.start();

  // The injected timer never fires by itself: fire each scheduled retry pass
  // manually so every assertion point is deterministic.
  await waitFor(() => scheduled.length >= 1); // initial pass failed inline
  scheduled[0].fn(); // retry 1 (30s)
  await waitFor(() => scheduled.length >= 2);
  scheduled[1].fn(); // retry 2 (60s)
  await waitFor(() => scheduled.length >= 3);
  scheduled[2].fn(); // retry 3 (120s)
  await waitFor(() => scheduled.length >= 4);
  scheduled[3].fn(); // retry 4 (240s)
  await waitFor(() => scheduled.length >= 5);

  assert.deepEqual(delays.slice(0, 5), [30_000, 60_000, 120_000, 240_000, 300_000]);
  assert.equal(BOOTSTRAP_RETRY_MAX_MS, 300_000);
  assert.equal(run.getSnapshot().phase, 'failed');
  assert.equal(attempts, 5, 'initial pass + 4 retry passes all failed');
  assert.deepEqual(run.getSnapshot().error, {
    step: 'llmProvider',
    message: 'relay down (attempt 5)',
  });
  // 503 while failed (C1).
  assert.equal(readiness.buildReadinessResponse(run.getReadinessState()).status, 503);
  // Steps after the critical one never ran.
  assert.equal(counts.twinMetabot, 0);
  assert.equal(counts.listener, 0);

  // Heal the relay: the next scheduled retry pass converges to ready.
  healAfter = attempts;
  scheduled[4].fn();
  const outcome = await run.finished;
  assert.equal(outcome.phase, 'ready');
  assert.equal(run.getReadinessState().error, null);
  assert.equal(run.getReadinessState().onboarding.llmProvider, 'done');
  for (const timer of scheduled.map((entry) => entry.timer)) clearTimeout(timer);
  sqliteStore.close();
});

test('redeem code unset → step skipped cleanly and the tenant is ready (not degraded)', async () => {
  const tempDir = makeTempDir();
  const { bootstrapStore, sqliteStore } = await openBootstrapStore(tempDir);
  const { executors } = makeCountingExecutors({ redeemCode: () => ({ skipped: true }) });
  const run = runServerBootstrap({ bootstrapStore, executors, version: VERSION });
  run.start();
  const outcome = await run.finished;
  assert.equal(outcome.phase, 'ready');
  assert.equal(run.getReadinessState().onboarding.redeemCode, 'skipped');
  assert.equal(run.getReadinessState().error, null);
  sqliteStore.close();
});

// ---------------------------------------------------------------------------
// Readiness mapping + phases (C1 /readyz)
// ---------------------------------------------------------------------------

test('buildReadinessResponse maps 200 iff ready/degraded, 503 otherwise (C1)', () => {
  const base = {
    version: VERSION.version,
    commit: VERSION.commit,
    contractVersion: VERSION.contractVersion,
    onboarding: {
      identity: 'done',
      llmProvider: 'done',
      twinMetabot: 'done',
      workspace: 'done',
      trafficAccount: 'done',
      redeemCode: 'skipped',
      globalMetaId: null,
      twinMetabotId: null,
    },
    error: null,
  };
  for (const phase of ['ready', 'degraded']) {
    const response = readiness.buildReadinessResponse({ ...base, phase });
    assert.equal(response.status, 200, `${phase} answers 200`);
    assert.equal(response.body.ready, true);
    assert.equal(response.body.phase, phase);
  }
  for (const phase of ['starting', 'migrating', 'bootstrapping', 'stopping', 'failed']) {
    const response = readiness.buildReadinessResponse({ ...base, phase });
    assert.equal(response.status, 503, `${phase} answers 503`);
    assert.equal(response.body.ready, false);
  }
});

test('phase walk starting → migrating → bootstrapping → ready, with live facts', async () => {
  const tempDir = makeTempDir();
  const { bootstrapStore, sqliteStore } = await openBootstrapStore(tempDir);
  const { phases, observer } = collectPhases();
  const run = runServerBootstrap({
    bootstrapStore,
    executors: makeCountingExecutors().executors,
    version: VERSION,
    onStateChange: observer,
    getFacts: () => ({ globalMetaId: 'idq1testglobalmetaid0000000', twinMetabotId: 7 }),
  });
  assert.equal(run.getReadinessState().phase, 'starting');
  run.start();
  await run.finished;
  assert.deepEqual(phases, ['migrating', 'bootstrapping', 'ready']);

  const state = run.getReadinessState();
  assert.equal(state.version, '0.0.0-test');
  assert.equal(state.contractVersion, '1.0.0');
  assert.equal(state.onboarding.globalMetaId, 'idq1testglobalmetaid0000000');
  assert.equal(state.onboarding.twinMetabotId, 7);
  assert.equal(state.onboarding.listener, undefined, 'listener is not a C1 onboarding key');
  sqliteStore.close();
});

test('markStopping flips the phase to stopping and cancels a pending critical retry', async () => {
  const tempDir = makeTempDir();
  const { bootstrapStore, sqliteStore } = await openBootstrapStore(tempDir);
  let retryCalls = 0;
  const setTimeoutFn = () => {
    retryCalls += 1;
    const timer = setTimeout(() => {}, 60_000);
    return timer;
  };
  const { counts, executors } = makeCountingExecutors({
    workspace: () => {
      throw new Error('disk pressure');
    },
  });
  const run = runServerBootstrap({ bootstrapStore, executors, version: VERSION, setTimeoutFn });
  run.start();
  await new Promise((resolve) => {
    const check = () => {
      if (run.getSnapshot().phase === 'failed') return resolve();
      setTimeout(check, 5);
    };
    check();
  });
  assert.equal(retryCalls, 1);
  run.markStopping();
  assert.equal(run.getReadinessState().phase, 'stopping');
  assert.equal(readiness.buildReadinessResponse(run.getReadinessState()).status, 503);
  const outcome = await run.finished;
  assert.equal(outcome.phase, 'stopping');
  assert.equal(counts.trafficAccount, 0, 'retry pass never runs after stopping');
  sqliteStore.close();
});

// ---------------------------------------------------------------------------
// REQ-A-28: schema migration is additive + idempotent, user data untouched.
// ---------------------------------------------------------------------------

test('REQ-A-28 ensureServerBootstrapSchema is idempotent and preserves existing user tables', async () => {
  const tempDir = makeTempDir();
  const { sqliteStore, bootstrapStore } = await openBootstrapStore(tempDir);
  // Pre-existing user data in the kv row the bootstrap also reads.
  sqliteStore.set('app_config', { language: 'en', language_initialized: true, custom: 'keep-me' });

  const db = sqliteStore.getDatabase();
  ensureServerBootstrapSchema(db);
  ensureServerBootstrapSchema(db);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'server_bootstrap_steps'");
  assert.equal(tables[0]?.values?.length, 1);

  bootstrapStore.setStepState('identity', 'done', null);
  const reopened = await openBootstrapStore(tempDir);
  assert.equal(reopened.bootstrapStore.getStepState('identity').state, 'done');
  assert.deepEqual(reopened.sqliteStore.get('app_config'), { language: 'en', language_initialized: true, custom: 'keep-me' });
  reopened.sqliteStore.close();
  sqliteStore.close();
});
