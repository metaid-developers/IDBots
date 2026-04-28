import test from 'node:test';
import assert from 'node:assert/strict';

test('DeepSeek reasoning_content classifier uses proxy lastError when SDK only reports process exit', async () => {
  const {
    buildCoworkProviderErrorSignal,
    isDeepSeekMissingReasoningContentError,
  } = await import('../dist-electron/libs/coworkProviderErrors.js');

  const sdkExitError = 'Claude Code process exited with code 1';
  const proxyLastError = 'DeepSeek thinking request is missing reasoning_content for 1 assistant tool-call message(s). Tool call ids: call_00_example.';
  const signal = buildCoworkProviderErrorSignal(sdkExitError, {
    proxyLastError,
    stderr: '',
  });

  assert.equal(isDeepSeekMissingReasoningContentError(sdkExitError), false);
  assert.equal(isDeepSeekMissingReasoningContentError(signal), true);
  assert.match(signal, /Claude Code process exited with code 1/);
  assert.match(signal, /DeepSeek thinking request is missing reasoning_content/);
});

test('provider error signal de-duplicates repeated details', async () => {
  const {
    buildCoworkProviderErrorSignal,
  } = await import('../dist-electron/libs/coworkProviderErrors.js');

  const signal = buildCoworkProviderErrorSignal('same error', {
    proxyLastError: 'same error',
    stderr: 'same error',
  });

  assert.equal(signal, 'same error');
});
