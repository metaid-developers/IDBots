import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadFallback() {
  try {
    return require(require.resolve('../dist-electron/main/services/llmFallback.js'));
  } catch {
    return require('../dist-electron/main/services/llmFallback.js');
  }
}

const { runWithLlmFallback } = loadFallback();

test('fallback retries once when the primary fails and the signal is live', async () => {
  const attempts = [];
  const result = await runWithLlmFallback(
    { llmId: 'primary-model', fallbackLlmId: 'fallback-model' },
    async (options) => {
      attempts.push(options.llmId);
      if (options.llmId === 'primary-model') throw new Error('primary down');
      return 'ok';
    },
    () => {},
  );
  assert.equal(result, 'ok');
  assert.deepEqual(attempts, ['primary-model', 'fallback-model']);
});

test('fallback is skipped when the shared abort signal already fired', async () => {
  // The caller passes ONE AbortSignal.timeout through options; once the
  // primary attempt consumed it (timeout), a fallback attempt would fail
  // instantly with the same abort — the retry must be skipped and the
  // primary error surfaced (2026-09-04 deep-consolidation timeout).
  const controller = new AbortController();
  const attempts = [];
  const primaryError = new Error('The operation was aborted due to timeout');
  await assert.rejects(
    runWithLlmFallback(
      {
        llmId: 'primary-model',
        fallbackLlmId: 'fallback-model',
        signal: controller.signal,
      },
      async (options) => {
        attempts.push(options.llmId);
        controller.abort();
        throw primaryError;
      },
      () => {},
    ),
    (error) => error === primaryError,
  );
  assert.deepEqual(attempts, ['primary-model']);
});

test('attemptTimeoutMs gives the fallback attempt a fresh live signal after a primary timeout', async () => {
  // 2026-09-03 dream failures: the GLM primary burned the whole shared
  // timeout and the fallback retry inherited the dead signal, so it never
  // actually ran. With attemptTimeoutMs each attempt derives its own
  // AbortSignal.timeout linked to the (still live) caller signal.
  const caller = new AbortController();
  const seenSignals = [];
  const result = await runWithLlmFallback(
    {
      llmId: 'primary-model',
      fallbackLlmId: 'fallback-model',
      signal: caller.signal,
      attemptTimeoutMs: 40,
    },
    async (options) => {
      seenSignals.push(options.signal);
      assert.equal(options.signal.aborted, false, `${options.llmId} attempt must start with a live signal`);
      if (options.llmId === 'primary-model') {
        // Hang until the per-attempt timeout fires, like a slow thinking model.
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('The operation was aborted due to timeout');
      }
      return 'ok';
    },
    () => {},
  );
  assert.equal(result, 'ok');
  assert.equal(seenSignals.length, 2);
  assert.notEqual(seenSignals[0], caller.signal, 'attempts must not ride the raw caller signal');
  assert.notEqual(seenSignals[0], seenSignals[1], 'each attempt must get its own derived signal');
  assert.equal(caller.signal.aborted, false, 'per-attempt timeout must not abort the caller signal');
});

test('caller cancellation still skips the fallback retry when attemptTimeoutMs is set', async () => {
  const caller = new AbortController();
  const attempts = [];
  const primaryError = new Error('cancelled by user');
  await assert.rejects(
    runWithLlmFallback(
      {
        llmId: 'primary-model',
        fallbackLlmId: 'fallback-model',
        signal: caller.signal,
        attemptTimeoutMs: 60_000,
      },
      async (options) => {
        attempts.push(options.llmId);
        caller.abort();
        throw primaryError;
      },
      () => {},
    ),
    (error) => error === primaryError,
  );
  assert.deepEqual(attempts, ['primary-model']);
});

test('a failed fallback attempt throws a combined error naming both brains', async () => {
  await assert.rejects(
    runWithLlmFallback(
      { llmId: 'primary-model', fallbackLlmId: 'fallback-model' },
      async (options) => {
        throw new Error(options.llmId === 'primary-model' ? 'primary 502' : 'fallback 429');
      },
      () => {},
    ),
    (error) => {
      assert.ok(error.message.includes('primary 502'), 'message keeps the primary failure');
      assert.ok(error.message.includes("fallback 'fallback-model' also failed: fallback 429"), 'message names the fallback failure');
      return true;
    },
  );
});


test('streamingTransport skips the per-attempt AbortSignal.timeout (the transport owns the deadline)', async () => {
  // The streaming transport builds its own deadline (total cap + idle
  // watchdog, semantics chosen by attemptTimeoutKind); wrapping the caller
  // signal in AbortSignal.timeout here would re-impose the old total-only
  // semantics and cut steadily-flowing long generations.
  const result = await runWithLlmFallback(
    { llmId: 'primary-model', attemptTimeoutMs: 50, streamingTransport: true },
    async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { signalAborted: options.signal?.aborted ?? false };
    },
    () => {},
  );
  assert.equal(result.signalAborted, false);
});

test('without streamingTransport the per-attempt timeout still fires', async () => {
  const result = await runWithLlmFallback(
    { llmId: 'primary-model', attemptTimeoutMs: 50 },
    async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { signalAborted: options.signal?.aborted ?? false };
    },
    () => {},
  );
  assert.equal(result.signalAborted, true);
});
