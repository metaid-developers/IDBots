import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../../dist/cli/main.js');
const { commandSuccess } = require('../../dist/core/contracts/commandResult.js');

test('runCli dispatches `metabot services publish --payload-file` with parsed JSON payload', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-publish-'));
  const payloadFile = path.join(tempDir, 'payload.json');
  await writeFile(payloadFile, JSON.stringify({
    serviceName: 'Tarot Reading',
    displayName: 'Tarot Reading',
    description: 'Performs tarot readings.',
  }), 'utf8');

  const stdout = [];
  const calls = [];

  const exitCode = await runCli(['services', 'publish', '--payload-file', payloadFile], {
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
    dependencies: {
      services: {
        publish: async (input) => {
          calls.push(input);
          return commandSuccess({
            servicePinId: 'service-tarot',
            displayName: input.displayName,
          });
        },
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    serviceName: 'Tarot Reading',
    displayName: 'Tarot Reading',
    description: 'Performs tarot readings.',
  }]);
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    ok: true,
    state: 'success',
    data: {
      servicePinId: 'service-tarot',
      displayName: 'Tarot Reading',
    },
  });
});

test('runCli dispatches `metabot services call --request-file` with parsed JSON request', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-call-'));
  const requestFile = path.join(tempDir, 'request.json');
  await writeFile(requestFile, JSON.stringify({
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'gm-weather-seller',
      userTask: 'tell me tomorrow weather',
      taskContext: 'Shanghai tomorrow',
    },
  }), 'utf8');

  const stdout = [];
  const calls = [];

  const exitCode = await runCli(['services', 'call', '--request-file', requestFile], {
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
    dependencies: {
      services: {
        call: async (input) => {
          calls.push(input);
          return commandSuccess({
            traceId: 'trace-weather-123',
            state: 'ready',
          });
        },
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'gm-weather-seller',
      userTask: 'tell me tomorrow weather',
      taskContext: 'Shanghai tomorrow',
    },
  }]);
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    ok: true,
    state: 'success',
    data: {
      traceId: 'trace-weather-123',
      state: 'ready',
    },
  });
});
