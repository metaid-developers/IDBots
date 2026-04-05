import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../../dist/cli/main.js');
const {
  commandSuccess,
} = require('../../dist/core/contracts/commandResult.js');

function createHarness() {
  const stdout = [];
  const stderr = [];
  const calls = {
    daemon: [],
    doctor: [],
    identity: [],
    trace: [],
    ui: [],
  };

  return {
    calls,
    stdout,
    stderr,
    context: {
      stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
      dependencies: {
        daemon: {
          start: async () => {
            calls.daemon.push({ command: 'start' });
            return commandSuccess({
              host: '127.0.0.1',
              port: 4827,
              baseUrl: 'http://127.0.0.1:4827',
            });
          },
        },
        doctor: {
          run: async () => {
            calls.doctor.push({ command: 'doctor' });
            return commandSuccess({
              checks: [
                { code: 'daemon_reachable', ok: true },
                { code: 'identity_loaded', ok: false },
              ],
            });
          },
        },
        identity: {
          create: async (input) => {
            calls.identity.push(input);
            return commandSuccess({
              name: input.name,
              globalMetaId: 'gm-alice',
            });
          },
        },
        trace: {
          get: async (input) => {
            calls.trace.push(input);
            return commandSuccess({
              traceId: input.traceId,
              status: 'completed',
            });
          },
        },
        ui: {
          open: async (input) => {
            calls.ui.push(input);
            return commandSuccess({
              page: input.page,
              localUiUrl: `/ui/${input.page}`,
            });
          },
        },
      },
    },
  };
}

function parseLastJson(chunks) {
  return JSON.parse(chunks.join('').trim());
}

test('runCli dispatches `metabot daemon start` and prints machine-first JSON', async () => {
  const harness = createHarness();
  const exitCode = await runCli(['daemon', 'start'], harness.context);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.daemon, [{ command: 'start' }]);
  assert.deepEqual(parseLastJson(harness.stdout), {
    ok: true,
    state: 'success',
    data: {
      host: '127.0.0.1',
      port: 4827,
      baseUrl: 'http://127.0.0.1:4827',
    },
  });
});

test('runCli dispatches `metabot doctor` and preserves the doctor envelope', async () => {
  const harness = createHarness();
  const exitCode = await runCli(['doctor'], harness.context);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.doctor, [{ command: 'doctor' }]);
  assert.deepEqual(parseLastJson(harness.stdout), {
    ok: true,
    state: 'success',
    data: {
      checks: [
        { code: 'daemon_reachable', ok: true },
        { code: 'identity_loaded', ok: false },
      ],
    },
  });
});

test('runCli dispatches `metabot identity create --name` with the provided MetaBot name', async () => {
  const harness = createHarness();
  const exitCode = await runCli(['identity', 'create', '--name', 'Alice'], harness.context);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.identity, [{ name: 'Alice' }]);
  assert.deepEqual(parseLastJson(harness.stdout), {
    ok: true,
    state: 'success',
    data: {
      name: 'Alice',
      globalMetaId: 'gm-alice',
    },
  });
});

test('runCli dispatches `metabot trace get --trace-id` and returns the trace envelope', async () => {
  const harness = createHarness();
  const exitCode = await runCli(['trace', 'get', '--trace-id', 'trace-123'], harness.context);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.trace, [{ traceId: 'trace-123' }]);
  assert.deepEqual(parseLastJson(harness.stdout), {
    ok: true,
    state: 'success',
    data: {
      traceId: 'trace-123',
      status: 'completed',
    },
  });
});

test('runCli dispatches `metabot ui open --page` and returns the local UI URL', async () => {
  const harness = createHarness();
  const exitCode = await runCli(['ui', 'open', '--page', 'hub'], harness.context);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.ui, [{ page: 'hub' }]);
  assert.deepEqual(parseLastJson(harness.stdout), {
    ok: true,
    state: 'success',
    data: {
      page: 'hub',
      localUiUrl: '/ui/hub',
    },
  });
});
