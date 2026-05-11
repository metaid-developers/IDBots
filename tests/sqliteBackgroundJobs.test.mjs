import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('SqliteBackgroundJobRunner waits other active jobs without deadlocking on the recovery trigger', async () => {
  const { SqliteBackgroundJobRunner } = require('../dist-electron/sqliteBackgroundJobs.js');
  let releaseSlowJob;
  let waitForActiveJobsSettled = false;
  let recoveryRan = false;
  let runner;

  runner = new SqliteBackgroundJobRunner({
    getState: () => 'ready',
    recover: async () => {
      recoveryRan = true;
      const waitForActiveJobs = runner.waitForActiveJobs().then(() => {
        waitForActiveJobsSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(waitForActiveJobsSettled, false);
      releaseSlowJob();
      await waitForActiveJobs;
    },
    isRecoverableError: (error) => /memory access out of bounds/i.test(error?.message ?? String(error)),
    isUnavailableError: () => false,
    logWarn: () => {},
  });

  const slowJob = runner.run(
    'slowJob',
    '[slowJob] failed',
    () => new Promise((resolve) => {
      releaseSlowJob = resolve;
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.getActiveJobCount(), 1);

  const failingJob = runner.run('failingJob', '[failingJob] failed', () => {
    throw new WebAssembly.RuntimeError('memory access out of bounds');
  });

  await failingJob;
  await slowJob;

  assert.equal(recoveryRan, true);
  assert.equal(waitForActiveJobsSettled, true);
  assert.equal(runner.getActiveJobCount(), 0);
});

test('SqliteBackgroundJobRunner logs ordinary failures without recovery', async () => {
  const { SqliteBackgroundJobRunner } = require('../dist-electron/sqliteBackgroundJobs.js');
  const warnings = [];
  let recoverCount = 0;

  const runner = new SqliteBackgroundJobRunner({
    getState: () => 'ready',
    recover: () => {
      recoverCount += 1;
    },
    isRecoverableError: () => false,
    isUnavailableError: () => false,
    logWarn: (message, error) => warnings.push({ message, error }),
  });

  const job = runner.run('ordinaryJob', '[ordinaryJob] failed', () => {
    throw new Error('network failed');
  });

  await assert.rejects(job, /network failed/);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(recoverCount, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, '[ordinaryJob] failed');
});
