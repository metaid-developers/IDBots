import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../../dist/cli/main.js');
const { commandSuccess } = require('../../dist/core/contracts/commandResult.js');

test('runCli dispatches `metabot network services --online` and preserves the list envelope', async () => {
  const stdout = [];
  const calls = [];

  const exitCode = await runCli(['network', 'services', '--online'], {
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
    dependencies: {
      network: {
        listServices: async (input) => {
          calls.push(input);
          return commandSuccess({
            services: [
              { servicePinId: 'service-weather', online: true },
            ],
          });
        },
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ online: true }]);
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    ok: true,
    state: 'success',
    data: {
      services: [
        { servicePinId: 'service-weather', online: true },
      ],
    },
  });
});

test('runCli dispatches `metabot network sources add --base-url --label` with parsed source input', async () => {
  const stdout = [];
  const calls = [];

  const exitCode = await runCli(['network', 'sources', 'add', '--base-url', 'http://127.0.0.1:4827', '--label', 'weather-demo'], {
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
    dependencies: {
      network: {
        addSource: async (input) => {
          calls.push(input);
          return commandSuccess({
            baseUrl: input.baseUrl,
            label: input.label,
          });
        },
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    baseUrl: 'http://127.0.0.1:4827',
    label: 'weather-demo',
  }]);
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    ok: true,
    state: 'success',
    data: {
      baseUrl: 'http://127.0.0.1:4827',
      label: 'weather-demo',
    },
  });
});

test('runCli dispatches `metabot network sources list` and preserves the source list envelope', async () => {
  const stdout = [];
  const calls = [];

  const exitCode = await runCli(['network', 'sources', 'list'], {
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
    dependencies: {
      network: {
        listSources: async () => {
          calls.push({ command: 'list' });
          return commandSuccess({
            sources: [
              { baseUrl: 'http://127.0.0.1:4827', label: 'weather-demo' },
            ],
          });
        },
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ command: 'list' }]);
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    ok: true,
    state: 'success',
    data: {
      sources: [
        { baseUrl: 'http://127.0.0.1:4827', label: 'weather-demo' },
      ],
    },
  });
});

test('runCli dispatches `metabot network sources remove --base-url` with parsed source input', async () => {
  const stdout = [];
  const calls = [];

  const exitCode = await runCli(['network', 'sources', 'remove', '--base-url', 'http://127.0.0.1:4827'], {
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
    dependencies: {
      network: {
        removeSource: async (input) => {
          calls.push(input);
          return commandSuccess({
            removed: true,
            baseUrl: input.baseUrl,
          });
        },
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    baseUrl: 'http://127.0.0.1:4827',
  }]);
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    ok: true,
    state: 'success',
    data: {
      removed: true,
      baseUrl: 'http://127.0.0.1:4827',
    },
  });
});
