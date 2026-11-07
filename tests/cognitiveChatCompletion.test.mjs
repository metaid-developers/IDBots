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

const { resolveThinkingForModel, extractAnthropicThinkingText, resolveDeepSeekResponsesReasoning, resolveDefaultMaxOutputTokens, buildDeepSeekResponsesTools, allowThinkingFallbackPromotion } = loadTestUtils();

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
