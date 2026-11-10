// dshModelReasoningDeclaration: reasoning capability declarations ride the
// MODEL family, not the provider. A catalog-unknown gateway serving
// deepseek-v4 must get the official chat-completions declaration so the
// effort selector's "off" actually disables thinking upstream (see the
// module header for the reasoning:false failure mode this prevents).

import assert from 'node:assert/strict'
import test from 'node:test'
import { dshLowestReasoningSelection, dshModelReasoningDeclaration, dshRouteReasoningEffort } from '../dist-electron/main/libs/dshModelReasoning.js'

test('deepseek-v4 family declares the official chat-completions dialect, vendor prefix or not', () => {
  for (const id of [
    // The renamed V4.1 id (2026-09-10) and its gateway-prefixed form.
    'deepseek-flash',
    'deepseek/deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash-vision-exp',
    'deepseek/deepseek-v4-flash',
    // The free-quota relay's (metaid-free) wire id for deepseek-v4-flash;
    // absent from pi-ai's installed catalog, so the declaration is what keeps
    // the effort selector alive on the free model.
    'deepseek-chat',
    // The 2026-10-16 relay catalog rename of that same model: the version
    // segment "4.1" precedes "flash", so DEEPSEEK_V4_PATTERN alone misses it —
    // the explicit-id list carries the declaration.
    'deepseek-4.1-flash',
    'deepseek/deepseek-4.1-flash',
  ]) {
    const declaration = dshModelReasoningDeclaration(id, 'openai');
    assert.ok(declaration, id);
    assert.equal(declaration.compat.thinkingFormat, 'deepseek');
    assert.equal(declaration.compat.supportsReasoningEffort, true);
    // `off: null` keeps off absent from the materialized thinkingLevelMap —
    // the deepseek branch then sends the explicit thinking-disable.
    assert.equal(declaration.reasoningEfforts.off, null);
    assert.equal(declaration.reasoningEfforts.low, 'low');
    assert.equal(declaration.reasoningEfforts.high, 'high');
    assert.equal(declaration.reasoningEfforts.max, 'max');
    // Undeclared levels materialize unsupported, mirroring the official profile.
    assert.equal('medium' in declaration.reasoningEfforts, false);
    assert.equal('minimal' in declaration.reasoningEfforts, false);
  }
})

test('deepseek stays chat-completions-only; anthropic declares GLM only', () => {
  assert.equal(dshModelReasoningDeclaration('deepseek-v4-flash', 'responses'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-v4-flash', 'anthropic'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-chat', 'responses'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-chat', 'anthropic'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-4.1-flash', 'responses'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-4.1-flash', 'anthropic'), null);
  assert.ok(dshModelReasoningDeclaration('glm-5.3-flash', 'anthropic'));
})

test('other families stay undeclared — no capability guessing', () => {
  assert.equal(dshModelReasoningDeclaration('gpt-5.6-sol', 'openai'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-v3.2', 'openai'), null);
  assert.equal(dshModelReasoningDeclaration('moonshotai/Kimi-K3', 'openai'), null);
  assert.equal(dshModelReasoningDeclaration('', 'openai'), null);
  // Other vendors' flash models never ride the explicit deepseek id list.
  assert.equal(dshModelReasoningDeclaration('gemini-3-flash', 'openai'), null);
  // The other 2026-10-16 free-relay ids are unknown families — no guessing.
  assert.equal(dshModelReasoningDeclaration('longcat-2.5-preview-free', 'openai'), null);
  assert.equal(dshModelReasoningDeclaration('laguna-s-2.1-free', 'openai'), null);
})

test('GLM models use the Z.AI thinking wire without reasoning_effort', () => {
  const declaration = dshModelReasoningDeclaration('z-ai/glm-5.3-flash', 'openai');
  assert.ok(declaration);
  assert.equal(declaration.compat.thinkingFormat, 'zai');
  assert.equal(declaration.compat.supportsReasoningEffort, false);
  assert.deepEqual(declaration.reasoningEfforts, {
    off: null,
    low: 'enabled',
    high: 'enabled',
    max: 'enabled',
  });
});

test('GLM on the Responses wire opts into reasoning explicitly (2026-09-03 z.ai default flip)', () => {
  for (const id of ['glm-5.3-flash', 'z-ai/glm-5.3-flash']) {
    const declaration = dshModelReasoningDeclaration(id, 'responses');
    assert.ok(declaration, id);
    // GLM-5.x always thinks and cannot disable: zhipu's chat wire 400s effort
    // 'none' and Volcengine Ark ignores it while running unbounded default
    // thinking that burned the whole output budget (2026-11-05 session
    // 1ed5daec). off therefore rides the bounded lowest rung — the same rule
    // the OpenAI-compat proxy applies via responsesEffortForThinkingOff.
    assert.equal(declaration.reasoningEfforts.off, 'low');
    assert.equal(declaration.reasoningEfforts.low, 'low');
    assert.equal(declaration.reasoningEfforts.high, 'high');
    assert.equal(declaration.reasoningEfforts.max, 'high');
    assert.equal('minimal' in declaration.reasoningEfforts, false);
    // Only RESPONSES_COMPAT_GATE fields — supportsStore and the chat-completions
    // dialect knobs are completions-only and fail dsh-llm-pi-ai plugin load on
    // this wire (the 2026-09-07 boot regression).
    assert.deepEqual(declaration.compat, { supportsDeveloperRole: false });
    assert.equal('supportsStore' in declaration.compat, false);
    assert.equal('thinkingFormat' in declaration.compat, false);
  }
  // GLM-4.x honors 'none': off keeps the send-nothing spelling.
  const glm4 = dshModelReasoningDeclaration('glm-4.6-air', 'responses');
  assert.ok(glm4);
  assert.equal(glm4.reasoningEfforts.off, null);
});

test('GLM on the Anthropic wire speaks adaptive thinking with output_config effort (Ark GLM routes)', () => {
  // GLM-5.x: off is OMITTED — pi-ai pins thinkingLevelMap.off to null, so once
  // the runner drops the off effort (dshRouteReasoningEffort) the writer emits
  // no thinking control and the provider default applies. Declaring any off
  // value here (null included) would make the writer emit the explicit
  // thinking:{type:'disabled'} that Ark 400s (2026-11-05 session 1ed5daec).
  for (const id of ['glm-5.3-flash', 'z-ai/glm-5.3-flash']) {
    const declaration = dshModelReasoningDeclaration(id, 'anthropic');
    assert.ok(declaration, id);
    assert.equal('off' in declaration.reasoningEfforts, false);
    // Enabled rungs ride output_config.effort; Ark's accepted vocabulary is
    // low/medium/high/max (it 400s xhigh), and max stays max here.
    assert.equal(declaration.reasoningEfforts.low, 'low');
    assert.equal(declaration.reasoningEfforts.high, 'high');
    assert.equal(declaration.reasoningEfforts.max, 'max');
    assert.equal('medium' in declaration.reasoningEfforts, false);
    assert.equal('xhigh' in declaration.reasoningEfforts, false);
    // Only ANTHROPIC_COMPAT_GATE-offered fields — budget-based thinking
    // (no forceAdaptiveThinking) would send budget_tokens, which Ark's
    // GLM-serving endpoint does not document.
    assert.deepEqual(declaration.compat, { forceAdaptiveThinking: true });
  }
  // GLM-4.x keeps the disable spelling (honored by disable-capable gateways).
  const glm4 = dshModelReasoningDeclaration('glm-4.6-air', 'anthropic');
  assert.ok(glm4);
  assert.equal(glm4.reasoningEfforts.off, null);
});

test('dshRouteReasoningEffort re-spells off per wire for always-thinking GLM-5.x only', () => {
  // Zai chat dialect: no silent off exists — any rung produces the identical
  // thinking:{type:'enabled'} object, so off must carry the lowest rung to
  // avoid the hardcoded thinking:disabled kill switch.
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'openai', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'off'), 'low');
  assert.equal(dshRouteReasoningEffort('z-ai/glm-5.3-flash', 'openai', 'https://api.commandcode.ai/provider/v1', 'off'), 'low');
  assert.equal(dshRouteReasoningEffort('GLM-5.3-Flash', 'openai', 'https://api.scnet.cn/api/llm/v1', 'off'), 'low');
  // The reasoning_effort dialect (OpenCode Go) already sends nothing for off.
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'openai', 'https://opencode.ai/zen/go/v1', 'off'), 'off');
  // Responses/anthropic: the effort is dropped and the declaration decides
  // (responses off→'low' minimal shape; anthropic off omitted → no control).
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'responses', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'off'), undefined);
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'anthropic', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'off'), undefined);
  // Disable-capable GLM-4.x, DeepSeek and unknown families ride off untouched.
  assert.equal(dshRouteReasoningEffort('glm-4.6-air', 'openai', null, 'off'), 'off');
  assert.equal(dshRouteReasoningEffort('glm-4.6-air', 'anthropic', null, 'off'), 'off');
  assert.equal(dshRouteReasoningEffort('deepseek-flash', 'openai', null, 'off'), 'off');
  assert.equal(dshRouteReasoningEffort('doubao-seed-1.6', 'anthropic', null, 'off'), 'off');
  // Non-off efforts and absent efforts pass through everywhere.
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'openai', null, 'low'), 'low');
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'anthropic', null, 'high'), 'high');
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'responses', null, 'max'), 'max');
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'openai', null, undefined), undefined);
  assert.equal(dshRouteReasoningEffort('glm-5.3-flash', 'openai', null, null), undefined);
});

test('undeclared-reasoning route warning fires once per route identity', async () => {
  const { undeclaredReasoningRouteWarning } = await import('../dist-electron/main/libs/dshModelReasoning.js')
  const input = {
    provider: 'warn-probe-gw',
    model: 'some-k5-ultra',
    apiFormat: 'responses',
    effort: 'max',
  }
  const first = undeclaredReasoningRouteWarning(input)
  assert.ok(first, 'first sighting reports the warning')
  assert.match(first, /Reasoning effort "max" is configured but cannot ride model "some-k5-ultra"/)
  assert.match(first, /no thinking declaration/)
  assert.match(first, /provider server default decides/)
  assert.equal(undeclaredReasoningRouteWarning(input), null, 'same identity is silent afterwards')
  const changedEffort = undeclaredReasoningRouteWarning({ ...input, effort: 'off' })
  assert.ok(changedEffort, 'a different effort is a new identity')
  assert.match(changedEffort, /"off"/)
})

test('dshLowestReasoningSelection: off when the ladder expresses it, else the lowest rung (projection fast path)', () => {
  // DeepSeek V4 chat-completions: off is expressible (reasoning:false wire).
  assert.equal(dshLowestReasoningSelection('deepseek-v4-flash', 'openai', null), 'off');
  // GLM-5.x on the zhipu chat wire: off IS declared — the declaration folds it
  // to the family's minimal wire shape (reasoning:{effort:'low'}), so the
  // selection id stays off and the kernel does the folding.
  assert.equal(dshLowestReasoningSelection('glm-5.3-flash', 'openai', 'https://open.bigmodel.cn/api/paas/v4'), 'off');
  // GLM-5.x on the responses wire: off declared (off:'low' fold).
  assert.equal(dshLowestReasoningSelection('glm-5.3-flash', 'responses', 'https://open.bigmodel.cn/api/coding/v3'), 'off');
  // GLM-5.x on the Anthropic wire (Volcengine Ark): off is OMITTED entirely —
  // Ark 400s thinking:{type:'disabled'} — so low is the expressible floor.
  assert.equal(dshLowestReasoningSelection('glm-5.3-flash', 'anthropic', 'https://ark.cn-beijing.volces.com/api/coding/v3'), 'low');
  // GLM-4.x (disable-capable): off expressible everywhere.
  assert.equal(dshLowestReasoningSelection('glm-4.6-air', 'anthropic', null), 'off');
  // Unknown family: no declaration, default pi-ai ladder includes off.
  assert.equal(dshLowestReasoningSelection('some-unknown-model', 'openai', null), 'off');
});
