import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadTestUtils() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
        BrowserWindow: { getAllWindows: () => [] },
        session: {},
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const compiledRoot = require.resolve('../dist-electron/main/services/cognitiveChatCompletion.js');
    return require(compiledRoot).__cognitiveChatCompletionTestUtils;
  } catch {
    return require('../dist-electron/main/services/cognitiveChatCompletion.js').__cognitiveChatCompletionTestUtils;
  } finally {
    Module._load = originalLoad;
  }
}

const { resolveThinkingForModel, extractAnthropicThinkingText, resolveDeepSeekResponsesReasoning, resolveDefaultMaxOutputTokens, buildDeepSeekResponsesTools, allowThinkingFallbackPromotion, readAnthropicSseCompletion, assembleAnthropicResult, resolveOneShotStreamDeadline, buildOneShotAttemptDeadline } = loadTestUtils();

test('one-shot completion reads the Anthropic thinking field emitted by the proxy', () => {
  assert.equal(
    extractAnthropicThinkingText({ type: 'thinking', thinking: 'provider reasoning' }),
    'provider reasoning',
  );
  assert.equal(
    extractAnthropicThinkingText({ type: 'thinking', text: 'legacy reasoning' }),
    'legacy reasoning',
  );
  assert.equal(extractAnthropicThinkingText({ type: 'text', text: 'final answer' }), '');
});

test('thinking controls are sent only to compatible DeepSeek/GLM models', () => {
  assert.equal(resolveThinkingForModel('deepseek-v4-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('deepseek-reasoner', 'enabled'), 'enabled');
  // GLM thinking-capable models default to thinking ON when the field is
  // absent — the caller's 'disabled' must reach the wire (2026-09-04
  // deep-consolidation timeout root cause).
  assert.equal(resolveThinkingForModel('glm-5.3-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('z-ai/glm-5.3-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('zai-org/GLM-5.3', 'enabled'), 'enabled');
  assert.equal(resolveThinkingForModel('glm-4.7-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('glm-4.5-air', 'disabled'), 'disabled');
  // Pre-4.5 GLM and non-thinking models keep the toggle off the wire.
  assert.equal(resolveThinkingForModel('glm-4', 'disabled'), undefined);
  assert.equal(resolveThinkingForModel('claude-sonnet-4-6', 'disabled'), undefined);
  assert.equal(resolveThinkingForModel('gpt-5.6-sol', 'disabled'), undefined);
});

test('DeepSeek Responses reasoning disable must be explicit effort none', () => {
  // Omitting `reasoning` leaves DeepSeek's server-side default (thinking ON,
  // effort high) in effect — the 2026-08-08 dream-diary outage root cause.
  assert.deepEqual(resolveDeepSeekResponsesReasoning('disabled'), { effort: 'none' });
  assert.deepEqual(resolveDeepSeekResponsesReasoning('enabled'), { effort: 'max' });
  assert.deepEqual(resolveDeepSeekResponsesReasoning(undefined), { effort: 'max' });
});

test('default output budget leaves headroom for thinking-mode reasoning', () => {
  // Reasoning shares the output budget: thinking-enabled calls get 32K,
  // thinking-disabled calls keep the lean 4K default — but ONLY for models
  // that can actually turn thinking off. GLM-5.x always thinks and unknown
  // families may default to thinking (the 2026-09-20 dream-fragment
  // `stop_reason=max_tokens; blocks=none` outage), so those keep 32K even
  // with a disabled toggle.
  assert.equal(resolveDefaultMaxOutputTokens('disabled', 'deepseek-flash'), 4_096);
  assert.equal(resolveDefaultMaxOutputTokens('disabled', 'glm-4.7-flash'), 4_096);
  assert.equal(resolveDefaultMaxOutputTokens('disabled', 'glm-5.3-flash'), 32_768);
  assert.equal(resolveDefaultMaxOutputTokens('disabled', 'zai-org/GLM-5.3'), 32_768);
  assert.equal(resolveDefaultMaxOutputTokens('disabled', 'some-brand-new-model'), 32_768);
  assert.equal(resolveDefaultMaxOutputTokens('disabled'), 32_768, 'no model context → assume thinking');
  assert.equal(resolveDefaultMaxOutputTokens('enabled', 'deepseek-flash'), 32_768);
  assert.equal(resolveDefaultMaxOutputTokens(undefined, 'deepseek-flash'), 32_768);
});

test('Anthropic thinking disabled is downgraded to the low tier for always-thinking models', () => {
  const { remapAnthropicThinkingForModel } = loadTestUtils();
  // GLM-5.x anthropic-compat endpoints reject {type:'disabled'} (zhipu 400
  // code 1210): downgrade to enabled with a small budget, clamped under the
  // output ceiling (Anthropic requires max_tokens > budget_tokens).
  assert.deepEqual(
    remapAnthropicThinkingForModel({ type: 'disabled' }, 'glm-5.3-flash', 16_384),
    { type: 'enabled', budget_tokens: 4_000 },
  );
  assert.deepEqual(
    remapAnthropicThinkingForModel({ type: 'disabled' }, 'glm-5.3-flash', 2_048),
    { type: 'enabled', budget_tokens: 1_792 },
    'budget clamps under a small output ceiling',
  );
  // Disable-capable models keep the explicit disabled toggle.
  assert.deepEqual(
    remapAnthropicThinkingForModel({ type: 'disabled' }, 'deepseek-v4-pro', 32_768),
    { type: 'disabled' },
  );
  assert.deepEqual(
    remapAnthropicThinkingForModel({ type: 'disabled' }, 'glm-4.7', 32_768),
    { type: 'disabled' },
  );
  // Enabled controls pass through untouched.
  assert.deepEqual(
    remapAnthropicThinkingForModel({ type: 'enabled', budget_tokens: 10_000 }, 'glm-5.3-flash', 32_768),
    { type: 'enabled', budget_tokens: 10_000 },
  );
});

test('Responses tools keep the default web_search injection for chat callers', () => {
  // 982fca66 product behavior: flash/pro chat via the Responses API carries
  // the built-in web_search tool first, caller tools after.
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, undefined), [{ type: 'web_search' }]);
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, true), [{ type: 'web_search' }]);
  const callerTool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
  assert.deepEqual(buildDeepSeekResponsesTools([callerTool], undefined), [
    { type: 'web_search' },
    { type: 'function', name: 'lookup', parameters: { type: 'object' } },
  ]);
});

test('webSearch:false strips the built-in search from the Responses tools', () => {
  // Structured JSON tasks (deep-consolidation, culture distillation, dream)
  // opt out: a stray search call derails the JSON contract — the 2026-09-02
  // "unparseable output" root cause.
  const callerTool = { type: 'function', function: { name: 'lookup' } };
  assert.deepEqual(buildDeepSeekResponsesTools([callerTool], false), [
    { type: 'function', name: 'lookup', parameters: {} },
  ]);
  // No caller tools + opt-out means the request body must omit tools entirely.
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, false), []);
});

test('Anthropic thinking-only replies promote to content for every family EXCEPT GLM', () => {
  // GLM reasoning is ALWAYS hidden thinking; a thinking-only reply means the
  // output budget burned inside reasoning before any text was emitted, and
  // promoting it leaks a mid-thought fragment as the answer (2026-10-23
  // ack-bubble on the OpenAI path — closed in openAiCompatContent; 2026-11-07
  // daily report on the Anthropic path — closed here). DeepSeek keeps the
  // fallback: its dialect CAN park the final answer in thinking-only replies.
  assert.equal(allowThinkingFallbackPromotion('z-ai/glm-5.3-flash'), false);
  assert.equal(allowThinkingFallbackPromotion('glm-5.3-flash'), false);
  assert.equal(allowThinkingFallbackPromotion('glm-4.7-flash'), false, 'whole GLM family, not just GLM-5.x');
  assert.equal(allowThinkingFallbackPromotion('zai-org/GLM-5.3'), false);
  assert.equal(allowThinkingFallbackPromotion('deepseek-v4-flash'), true);
  assert.equal(allowThinkingFallbackPromotion('claude-sonnet-4-6'), true);
  assert.equal(allowThinkingFallbackPromotion('gpt-5.6-sol'), true);
  assert.equal(allowThinkingFallbackPromotion('some-brand-new-model'), true, 'unknown families keep the historical fallback');
  assert.equal(allowThinkingFallbackPromotion(null), true);
  assert.equal(allowThinkingFallbackPromotion(undefined), true);
});

test('one-shot attempts pin their upstream under a throwaway key and clear it after', async () => {
  // Regression cover for the 2026-09-03 cross-provider clobber: every attempt
  // (primary AND fallback retry) must resolve with its own oneshot-* pin key
  // so the proxy request rides the per-session registry, and the pin must be
  // released when the attempt settles.
  const originalLoad = Module._load;
  const resolvedKeys = [];
  const clearedKeys = [];
  Module._load = function patchedLoad(request, ...rest) {
    if (request === '../libs/claudeSettings') {
      return {
        resolveApiConfigForModel: (_modelId, _target, sessionKey) => {
          resolvedKeys.push(sessionKey ?? null);
          return { config: null, error: 'test: config unavailable' };
        },
      };
    }
    if (request === '../libs/coworkOpenAICompatProxy') {
      return {
        clearCoworkSessionUpstream: (key) => clearedKeys.push(key),
      };
    }
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
        BrowserWindow: { getAllWindows: () => [] },
        session: {},
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  let mod;
  try {
    let resolved;
    try {
      resolved = require.resolve('../dist-electron/main/services/cognitiveChatCompletion.js');
    } catch {
      resolved = require.resolve('../dist-electron/main/services/cognitiveChatCompletion.js');
    }
    delete require.cache[resolved];
    mod = require(resolved);
  } finally {
    Module._load = originalLoad;
  }

  await assert.rejects(
    mod.chatCompletionWithTools(
      [{ role: 'user', content: 'hi' }],
      { llmId: 'glm-5.3-flash', fallbackLlmId: 'deepseek-v4-flash' }
    ),
    /test: config unavailable/
  );
  assert.equal(resolvedKeys.length, 2, 'primary + fallback attempts each resolve with their own pin');
  assert.ok(resolvedKeys.every((key) => typeof key === 'string' && key.startsWith('oneshot-')));
  assert.notEqual(resolvedKeys[0], resolvedKeys[1], 'each attempt pins a distinct upstream entry');
  assert.deepEqual([...clearedKeys].sort(), [...resolvedKeys].sort(), 'every pin is cleared after the attempt');
});


// ── Streaming transport (2026-11-20 ABS relay handoff) ─────────────────────

function makeSseResponse(frames, { contentType = 'text/event-stream' } = {}) {
  return new Response(frames.join('\n\n') + '\n\n', { headers: { 'content-type': contentType } });
}

/** A stream that emits `frames` then stalls forever unless `abortSignal`
 *  fires — mimics the fetch transport contract where an aborted request
 *  signal errors the body stream with the abort reason. */
function makeStallingSseStream(frames, abortSignal) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame + '\n\n'));
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => controller.error(abortSignal.reason), { once: true });
      }
      // Otherwise: never enqueue again, never close — the stalled upstream.
    },
  });
}

test('anthropic SSE stream folds text, tool calls, usage and stop reason into the JSON shape', async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42}}}',
    ': ping',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tc_1","name":"lookup"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":17}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ];
  const deadline = buildOneShotAttemptDeadline({ idleMs: 5000, totalMs: 60000 }, undefined);
  try {
    const shaped = await readAnthropicSseCompletion(makeSseResponse(frames), { deadline });
    assert.equal(shaped.stop_reason, 'tool_use');
    assert.equal(shaped.usage.input_tokens, 42);
    assert.equal(shaped.usage.output_tokens, 17);
    const result = assembleAnthropicResult(shaped, 'glm-5.3-flash');
    assert.equal(result.content, 'Hello');
    assert.equal(result.tool_calls?.length, 1);
    assert.equal(result.tool_calls[0].id, 'tc_1');
    assert.equal(result.tool_calls[0].name, 'lookup');
    assert.equal(result.tool_calls[0].arguments, '{"q":"x"}');
    assert.deepEqual(result.responseMetadata.contentBlockTypes, ['text', 'tool_use']);
  } finally {
    deadline.cleanup();
  }
});

test('SSE thinking-only stream promotes reasoning on DeepSeek but never on GLM', async () => {
  const frames = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden chain"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"stop"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ];
  const deadline = buildOneShotAttemptDeadline({ idleMs: 5000, totalMs: 60000 }, undefined);
  try {
    const shaped = await readAnthropicSseCompletion(makeSseResponse(frames), { deadline });
    const deepseek = assembleAnthropicResult(shaped, 'deepseek-v4-flash');
    assert.equal(deepseek.content, 'hidden chain');
    assert.ok(deepseek.responseMetadata.contentBlockTypes?.includes('reasoning-fallback'));
    // GLM reasoning is always hidden thinking — promoting it would leak a
    // mid-thought fragment as the answer (2026-10-23 ack-bubble leak class).
    const glm = assembleAnthropicResult(shaped, 'glm-5.3-flash');
    assert.equal(glm.content, undefined);
    assert.ok(!glm.responseMetadata.contentBlockTypes?.includes('reasoning-fallback'));
    assert.ok(glm.responseMetadata.contentBlockTypes?.includes('thinking'));
  } finally {
    deadline.cleanup();
  }
});

test('SSE error event rejects the attempt', async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{}}',
    'event: error\ndata: {"type":"error","error":{"type":"upstream_error","message":"boom"}}',
  ];
  const deadline = buildOneShotAttemptDeadline({ idleMs: 5000, totalMs: 60000 }, undefined);
  try {
    await assert.rejects(
      readAnthropicSseCompletion(makeSseResponse(frames), { deadline }),
      /LLM stream error: boom/,
    );
  } finally {
    deadline.cleanup();
  }
});

test('SSE stream without message_stop rejects (truncated upstream)', async () => {
  const frames = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
  ];
  const deadline = buildOneShotAttemptDeadline({ idleMs: 5000, totalMs: 60000 }, undefined);
  try {
    await assert.rejects(
      readAnthropicSseCompletion(makeSseResponse(frames), { deadline }),
      /message_stop/,
    );
  } finally {
    deadline.cleanup();
  }
});

test('idle watchdog aborts a stalled SSE stream with a TimeoutError', async () => {
  const deadline = buildOneShotAttemptDeadline({ idleMs: 60, totalMs: null }, undefined);
  const response = new Response(
    makeStallingSseStream([': ping\n\n'], deadline.signal),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    await assert.rejects(
      readAnthropicSseCompletion(response, { deadline }),
      (err) => err instanceof Error && err.name === 'TimeoutError' && /idle timeout/.test(err.message),
    );
  } finally {
    deadline.cleanup();
  }
});

test('total deadline still bounds the attempt wall clock', async () => {
  const deadline = buildOneShotAttemptDeadline({ idleMs: 60000, totalMs: 60 }, undefined);
  const response = new Response(
    makeStallingSseStream([': ping\n\n'], deadline.signal),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    await assert.rejects(
      readAnthropicSseCompletion(response, { deadline }),
      (err) => err instanceof Error && err.name === 'TimeoutError' && /deadline exceeded/.test(err.message),
    );
  } finally {
    deadline.cleanup();
  }
});

test('stream deadline: total kind keeps the wall clamp, idle kind grows the total', () => {
  // 'total' (default) — attemptTimeoutMs stays the whole-attempt wall budget
  // (dream's run-budget clamp contract).
  assert.deepEqual(
    resolveOneShotStreamDeadline({ attemptTimeoutMs: 60_000 }),
    { idleMs: 60_000, totalMs: 60_000 },
  );
  // unset attemptTimeoutMs keeps the historical unbounded wait (caller signal governs)
  assert.deepEqual(resolveOneShotStreamDeadline({}), { idleMs: 120_000, totalMs: null });
  // 'idle' — no-progress budget with a grown total (min(idle×8, 600s))
  assert.deepEqual(
    resolveOneShotStreamDeadline({ attemptTimeoutMs: 60_000, attemptTimeoutKind: 'idle' }),
    { idleMs: 60_000, totalMs: 480_000 },
  );
  assert.deepEqual(
    resolveOneShotStreamDeadline({ attemptTimeoutKind: 'idle' }),
    { idleMs: 120_000, totalMs: 600_000 },
  );
  // a caller window at or above the ceiling never shrinks (dream ladder tail)
  assert.deepEqual(
    resolveOneShotStreamDeadline({ attemptTimeoutMs: 2_280_000, attemptTimeoutKind: 'idle' }),
    { idleMs: 2_280_000, totalMs: 2_280_000 },
  );
});
