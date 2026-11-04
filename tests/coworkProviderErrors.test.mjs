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

// 2026-10-13 session 38c18094: a native DeepSeek turn died with
// MALFORMED_RESPONSE "DeepSeek Messages stream: tool input is invalid JSON"
// (the model streamed tool-call arguments that never parsed). The kernel
// discards the malformed step before any assistant message enters history,
// so the runner auto-continues ONCE with MALFORMED_TOOL_CALL_TURN_CONTINUE_PROMPT.
test('isMalformedToolCallDshTurnError classifies only the invalid-tool-JSON fingerprint', async () => {
  const { isMalformedToolCallDshTurnError } = await import('../dist-electron/main/libs/coworkAssistantReply.js');

  // The exact incident shape (kernel-normalized code + adapter detail).
  assert.equal(
    isMalformedToolCallDshTurnError({
      kind: 'error',
      error: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' },
    }),
    true,
  );
  // Code lower-cased by a relay still classifies on the message fingerprint.
  assert.equal(
    isMalformedToolCallDshTurnError({
      kind: 'error',
      error: { code: 'malformed_response', message: 'DeepSeek Messages stream: tool input is invalid JSON' },
    }),
    true,
  );
  // Other MALFORMED_RESPONSE details (SSE corruption, schema mismatches) can
  // be persistent provider/adapter defects — never auto-continued.
  assert.equal(
    isMalformedToolCallDshTurnError({
      kind: 'error',
      error: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages SSE contains invalid JSON' },
    }),
    false,
  );
  assert.equal(
    isMalformedToolCallDshTurnError({
      kind: 'error',
      error: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages expected a string field' },
    }),
    false,
  );
  // The fingerprint without the kernel code is not enough (a user-visible
  // message quoting the error must not classify).
  assert.equal(
    isMalformedToolCallDshTurnError({ kind: 'error', error: { message: 'tool input is invalid JSON' } }),
    false,
  );
  // Non-error outcomes never classify.
  assert.equal(isMalformedToolCallDshTurnError({ kind: 'completed' }), false);
  assert.equal(isMalformedToolCallDshTurnError(null), false);
});

test('coworkRunner auto-continues a malformed-tool-call turn exactly once, before the transient ladder', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const runnerSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/main/libs/coworkRunner.ts'),
    'utf8',
  );

  assert.ok(
    runnerSource.includes('MALFORMED_TOOL_CALL_TURN_CONTINUE_PROMPT'),
    'coworkRunner must import and use MALFORMED_TOOL_CALL_TURN_CONTINUE_PROMPT',
  );
  const useIdx = runnerSource.indexOf('runGuardedTurn(MALFORMED_TOOL_CALL_TURN_CONTINUE_PROMPT)');
  assert.ok(useIdx > 0, 'the continue prompt must be fed through runGuardedTurn');
  // One-shot (an if, not the resume loop) and gated on the classifier + not aborted.
  const window = runnerSource.slice(Math.max(0, useIdx - 600), useIdx);
  assert.ok(
    window.includes('isMalformedToolCallDshTurnError(outcome)'),
    `the continue must be gated on the classifier: ${window}`,
  );
  assert.ok(
    window.includes("outcome.kind === 'error'"),
    'the continue only fires on error outcomes',
  );
  assert.ok(
    window.includes('!activeSession.abortController.signal.aborted'),
    'the continue must not fire after a user abort',
  );
  // Placement: after the initial turn, before the transient-resume loop.
  const firstTurnIdx = runnerSource.indexOf('let outcome = await runGuardedTurn(effectiveDshPrompt, promptImages)');
  const transientIdx = runnerSource.indexOf('for (let resumeAttempt = 1; resumeAttempt <= DSH_TRANSIENT_TURN_MAX_RESUMES');
  assert.ok(firstTurnIdx > 0 && useIdx > firstTurnIdx, 'the continue runs after the initial turn');
  assert.ok(transientIdx > useIdx, 'the continue runs before the transient-resume ladder');
});

test('isTransientDshTurnError classifies the Zhipu gateway network-error template as transient', async () => {
  const { isTransientDshTurnError } = await import('../dist-electron/main/libs/coworkAssistantReply.js');

  // The 2026-11-01 session b07c64e9 death shape, verbatim: the Zhipu gateway
  // answers a ~40s in-flight request with its fixed Chinese template riding a
  // server-side error id (timestamp-prefixed). pi-ai cannot fingerprint it and
  // lands it on the generic PI_AI_ERROR code — the host classifier must catch
  // it so the transient-resume ladder (and the fallback-brain ladder behind
  // it) engages instead of hard-failing the turn.
  assert.equal(
    isTransientDshTurnError({
      kind: 'error',
      error: {
        code: 'PI_AI_ERROR',
        message: 'server_error: 网络错误，错误id 202611012140098dbde9342b514386 ，请稍后重试。[202611012140098dbde9342b514386]',
      },
    }),
    true,
  );
  // The 2026-11-01 21:12 occurrence, same template, different server id.
  assert.equal(
    isTransientDshTurnError({
      kind: 'error',
      error: {
        code: 'PI_AI_ERROR',
        message: 'server_error: 网络错误，错误id 202611012112323ac23a0a98b24b76 ，请稍后重试。[202611012112323ac23a0a98b24b76]',
      },
    }),
    true,
  );

  // Other generic PI_AI_ERROR deaths (stream ended pending / deferred) must
  // NOT classify — only the exact upstream template is transient.
  assert.equal(
    isTransientDshTurnError({ kind: 'error', error: { code: 'PI_AI_ERROR', message: 'pi-ai stream for model "glm-5.3-flash" ended pending' } }),
    false,
  );
  assert.equal(
    isTransientDshTurnError({ kind: 'error', error: { code: 'PI_AI_ERROR', message: 'pi-ai deferred response for model "glm-5.3-flash" is not supported' } }),
    false,
  );
  assert.equal(
    isTransientDshTurnError({ kind: 'error', error: { code: 'PI_AI_ERROR', message: '' } }),
    false,
  );

  // Kernel-normalized transient codes keep classifying (regression guard).
  assert.equal(isTransientDshTurnError({ kind: 'error', error: { code: 'TRANSPORT', message: 'other side closed' } }), true);
  assert.equal(isTransientDshTurnError({ kind: 'error', error: { code: 'SERVER', message: 'OpenAI API error (500)' } }), true);
  assert.equal(isTransientDshTurnError({ kind: 'error', error: { code: 'TIMEOUT', message: 'request timed out' } }), true);
  assert.equal(isTransientDshTurnError({ kind: 'completed' }), false);
  assert.equal(isTransientDshTurnError(null), false);
});
