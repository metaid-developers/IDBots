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

test('HTTP 413 body-limit deaths classify as body-limit, never as context overflow', async () => {
  const { isBodyLimitDshTurnError, isOverflowDshTurnError } = await import('../dist-electron/main/libs/coworkAssistantReply.js');

  // The 2026-10-04 metaid-free incident shapes: the relay's transport byte
  // cap answered `413: request_too_large` for long sessions and for the
  // compaction request alike; the kernel normalizes the status to
  // REQUEST_TOO_LARGE. These are body-size (transport) failures, NOT context
  // overflow — they must never switch the session onto the fallback brain.
  const bodyLimitOutcomes = [
    { kind: 'error', error: { code: 'REQUEST_TOO_LARGE', message: '413: request_too_large: body 262168 bytes > llm.max_request_bytes 2097152' } },
    { kind: 'error', error: { code: 'PAYLOAD_TOO_LARGE', message: '' } },
    { kind: 'error', error: { code: 'BAD_REQUEST', message: '413: request_too_large' } },
    { kind: 'error', error: { message: '413 Request Entity Too Large' } },
    { kind: 'error', error: { message: 'request entity too large' } },
    { kind: 'error', error: { message: '413: request_too_large' } },
  ];
  for (const outcome of bodyLimitOutcomes) {
    assert.equal(isBodyLimitDshTurnError(outcome), true, JSON.stringify(outcome));
    assert.equal(isOverflowDshTurnError(outcome), false, JSON.stringify(outcome));
    // Even a failed same-turn compaction must not reclassify a 413 as
    // overflow — the compaction request died of the same body cap.
    assert.equal(isOverflowDshTurnError(outcome, { compactionFailedThisTurn: true }), false, JSON.stringify(outcome));
  }
  // \b413\b must not match inside longer numbers.
  assert.equal(isBodyLimitDshTurnError({ kind: 'error', error: { message: 'you requested 64413 tokens but the maximum context length is 64000' } }), false);
  // Non-413 failures must not classify as body-limit.
  assert.equal(isBodyLimitDshTurnError({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: '400 status code (no body)' } }), false);
  assert.equal(isBodyLimitDshTurnError({ kind: 'error', error: { message: 'prompt is too long: 190000 tokens > 131072 maximum' } }), false);
  assert.equal(isBodyLimitDshTurnError({ kind: 'completed' }), false);
  assert.equal(isBodyLimitDshTurnError(null), false);
});
