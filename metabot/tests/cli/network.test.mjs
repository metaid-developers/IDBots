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
