import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runBootstrapFlow } = require('../../dist/core/bootstrap/bootstrapFlow.js');

test('runBootstrapFlow creates identity, requests subsidy, retries sync once, and then succeeds', async () => {
  const calls = [];
  const phases = [];

  const result = await runBootstrapFlow({
    request: { name: 'Alice' },
    syncRetryDelayMs: 25,
    wait: async (ms) => {
      calls.push(`wait:${ms}`);
    },
    onProgress: (progress) => {
      phases.push(progress.phase);
    },
    createMetabot: async (request) => {
      calls.push(`create:${request.name}`);
      return {
        metabot: { id: 7, name: request.name },
        subsidyInput: {
          mvcAddress: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB',
          mnemonic: 'secret phrase',
          path: "m/44'/10001'/0'/0/0"
        }
      };
    },
    requestSubsidy: async ({ metabot, subsidyInput }) => {
      calls.push(`subsidy:${metabot.id}:${subsidyInput.mvcAddress}`);
      return { success: true };
    },
    syncIdentityToChain: async ({ metabot }) => {
      calls.push(`sync:${metabot.id}`);
      const attempts = calls.filter((entry) => entry === `sync:${metabot.id}`).length;
      if (attempts === 1) {
        return { success: false, error: 'indexer still catching up' };
      }
      return { success: true };
    }
  });

  assert.deepEqual(calls, [
    'create:Alice',
    'subsidy:7:15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB',
    'sync:7',
    'wait:25',
    'sync:7'
  ]);
  assert.deepEqual(phases, ['identity_created', 'subsidy_requested', 'syncing', 'ready']);
  assert.equal(result.success, true);
  assert.equal(result.phase, 'ready');
  assert.equal(result.retryable, false);
  assert.equal(result.manualActionRequired, false);
  assert.deepEqual(result.metabot, { id: 7, name: 'Alice' });
  assert.deepEqual(result.subsidy, { success: true });
});

test('runBootstrapFlow surfaces manual follow-up when sync stays skippable after retry', async () => {
  const phases = [];

  const result = await runBootstrapFlow({
    request: { name: 'Alice' },
    syncRetryDelayMs: 1,
    wait: async () => {},
    onProgress: (progress) => {
      phases.push(progress.phase);
    },
    createMetabot: async () => ({
      metabot: { id: 8, name: 'Alice' },
      subsidyInput: {
        mvcAddress: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB'
      }
    }),
    requestSubsidy: async () => ({ success: true }),
    syncIdentityToChain: async () => ({
      success: false,
      error: 'avatar pin failed',
      canSkip: true
    })
  });

  assert.deepEqual(phases, ['identity_created', 'subsidy_requested', 'syncing', 'failed']);
  assert.equal(result.success, false);
  assert.equal(result.phase, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(result.manualActionRequired, true);
  assert.equal(result.canSkip, true);
  assert.equal(result.error, 'avatar pin failed');
  assert.deepEqual(result.metabot, { id: 8, name: 'Alice' });
});
