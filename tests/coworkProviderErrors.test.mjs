import test from 'node:test';
import assert from 'node:assert/strict';

test('DeepSeek reasoning_content classifier uses proxy lastError when SDK only reports process exit', async () => {
  const {
    buildCoworkProviderErrorSignal,
    isDeepSeekMissingReasoningContentError,
  } = await import('../dist-electron/main/libs/coworkProviderErrors.js');

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
  } = await import('../dist-electron/main/libs/coworkProviderErrors.js');

  const signal = buildCoworkProviderErrorSignal('same error', {
    proxyLastError: 'same error',
    stderr: 'same error',
  });

  assert.equal(signal, 'same error');
});

test('isQuotaDshTurnError matches the kernel QUOTA code and upstream credit fingerprints', async () => {
  const { isQuotaDshTurnError } = await import('../dist-electron/main/libs/coworkAssistantReply.js');

  // Kernel-normalized code (the 2026-09-14 commandcode incident shape).
  assert.equal(
    isQuotaDshTurnError({
      kind: 'error',
      error: {
        code: 'QUOTA',
        message: '400: {"message":"You have insufficient credits to make this request.","type":"invalid_request_error","code":"BAD_REQUEST"}',
      },
    }),
    true,
  );
  // Fingerprint-only variants (code lost or relayed as BAD_REQUEST).
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { code: 'BAD_REQUEST', message: 'Insufficient Balance' } }),
    true,
  );
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { message: 'This request exceeds your billing limit.' } }),
    true,
  );
  // Non-quota failures must not classify.
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { code: 'SERVER', message: 'OpenAI API error (500)' } }),
    false,
  );
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } }),
    false,
  );
  assert.equal(isQuotaDshTurnError({ kind: 'completed' }), false);
  assert.equal(isQuotaDshTurnError(null), false);
});

test('isAuthDshTurnError classifies credential-rejection turn failures', async () => {
  const { isAuthDshTurnError } = await import('../dist-electron/main/libs/coworkAssistantReply.js');

  // Kernel-normalized auth codes.
  assert.equal(
    isAuthDshTurnError({ kind: 'error', error: { code: 'AUTH', message: '401' } }),
    true,
  );
  assert.equal(
    isAuthDshTurnError({ kind: 'error', error: { code: 'UNAUTHORIZED', message: '' } }),
    true,
  );
  // The 2026-10-03 Windows report shape: DeepSeek's raw body relayed verbatim
  // (code lost or non-normalized) — the fingerprint must catch it.
  assert.equal(
    isAuthDshTurnError({
      kind: 'error',
      error: { code: 'BAD_REQUEST', message: 'Authentication Fails, Your api key: ****9a6d is invalid (request_id: e79de9f8)' },
    }),
    true,
  );
  assert.equal(
    isAuthDshTurnError({ kind: 'error', error: { message: 'Invalid API key provided.' } }),
    true,
  );
  assert.equal(
    isAuthDshTurnError({ kind: 'error', error: { message: 'Request unauthorized: missing bearer token' } }),
    true,
  );
  // A bare 401 with no auth wording never classifies on its own.
  assert.equal(
    isAuthDshTurnError({ kind: 'error', error: { code: 'SERVER', message: 'HTTP 401 after 3 retries (gateway id 40123)' } }),
    false,
  );
  // Quota and transport failures must not classify as auth.
  assert.equal(
    isAuthDshTurnError({ kind: 'error', error: { code: 'QUOTA', message: 'Insufficient Balance' } }),
    false,
  );
  assert.equal(
    isAuthDshTurnError({ kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } }),
    false,
  );
  assert.equal(isAuthDshTurnError({ kind: 'completed' }), false);
  assert.equal(isAuthDshTurnError(null), false);
});

test('isOverflowDshTurnError classifies context-overflow turn failures', async () => {
  const { isOverflowDshTurnError } = await import('../dist-electron/main/libs/coworkAssistantReply.js');

  // Kernel-normalized overflow codes.
  assert.equal(
    isOverflowDshTurnError({ kind: 'error', error: { code: 'CONTEXT_LENGTH', message: 'this model supports at most 65536 tokens' } }),
    true,
  );
  // The code the 2026-09-28 incident actually shipped with (cowork.log:
  // opencode zen deepseek-flash, bodyless 400 + CONTEXT_WINDOW_EXCEEDED).
  assert.equal(
    isOverflowDshTurnError({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: '400 status code (no body)' } }),
    true,
  );
  // Upstream overflow fingerprints (OpenAI-compat / DeepSeek bodies).
  assert.equal(
    isOverflowDshTurnError({ kind: 'error', error: { code: 'BAD_REQUEST', message: "This model's maximum context length is 32768 tokens. However, you requested 40123 tokens." } }),
    true,
  );
  assert.equal(
    isOverflowDshTurnError({ kind: 'error', error: { message: 'prompt is too long: 190000 tokens > 131072 maximum' } }),
    true,
  );
  assert.equal(
    isOverflowDshTurnError({ kind: 'error', error: { code: 'REQUEST_TOO_LARGE', message: '' } }),
    true,
  );
  // The 2026-09-28 compaction-deadlock incident shape: a bodyless 400 only
  // classifies when the same turn also failed auto-compaction.
  const bodyless400 = { kind: 'error', error: { code: 'ERROR', message: '400 status code (no body)' } };
  assert.equal(isOverflowDshTurnError(bodyless400), false);
  assert.equal(isOverflowDshTurnError(bodyless400, { compactionFailedThisTurn: true }), true);
  // A bodyless 400 WITHOUT a failed compaction must not classify — too many
  // unrelated provider failures share that shape.
  assert.equal(isOverflowDshTurnError({ kind: 'error', error: { message: '400 status code (no body)' } }), false);
  // Non-overflow failures must not classify.
  assert.equal(
    isOverflowDshTurnError({ kind: 'error', error: { code: 'QUOTA', message: 'You have insufficient credits.' } }),
    false,
  );
  assert.equal(isOverflowDshTurnError({ kind: 'completed' }), false);
  assert.equal(isOverflowDshTurnError(null), false);
});
