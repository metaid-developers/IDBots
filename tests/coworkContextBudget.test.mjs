import test from 'node:test';
import assert from 'node:assert/strict';

test('estimateCoworkTextTokens counts CJK more conservatively than ASCII', async () => {
  const {
    estimateCoworkTextTokens,
  } = await import('../dist-electron/libs/coworkContextBudget.js');

  assert.equal(estimateCoworkTextTokens('abcd'), 1);
  assert.equal(estimateCoworkTextTokens('你好世界'), 4);
  assert.equal(estimateCoworkTextTokens('hello 世界'), 4);
});

test('getCoworkContextBudget skips thinking and does not double count current prompt', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/libs/coworkContextBudget.js');

  const currentPrompt = '继续处理这个问题';
  const messages = [
    {
      id: 'thinking-1',
      type: 'assistant',
      content: 'x'.repeat(50_000),
      timestamp: 1,
      metadata: { isThinking: true },
    },
    {
      id: 'user-1',
      type: 'user',
      content: currentPrompt,
      timestamp: 2,
    },
  ];

  const withoutCurrentPrompt = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000, maxOutputTokens: 100 },
    softThresholdRatio: 0.9,
  });
  const withCurrentPrompt = getCoworkContextBudget({
    messages,
    currentPrompt,
    modelLimits: { contextWindow: 1_000, maxOutputTokens: 100 },
    softThresholdRatio: 0.9,
  });

  assert.equal(withCurrentPrompt.estimatedTokens, withoutCurrentPrompt.estimatedTokens);
  assert.equal(withCurrentPrompt.includedMessages, 1);
});

test('getCoworkContextBudget requests compaction after soft threshold', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/libs/coworkContextBudget.js');

  const budget = getCoworkContextBudget({
    messages: [
      {
        id: 'user-1',
        type: 'user',
        content: 'x'.repeat(400),
        timestamp: 1,
      },
    ],
    modelLimits: { contextWindow: 200, maxOutputTokens: 40 },
    softThresholdRatio: 0.5,
  });

  assert.equal(budget.usableInputTokens, 160);
  assert.equal(budget.softThresholdTokens, 80);
  assert.equal(budget.shouldCompact, true);
});

test('isContextWindowExceededError recognizes context overflow without catching DeepSeek thinking history errors', async () => {
  const {
    isContextWindowExceededError,
  } = await import('../dist-electron/libs/coworkContextBudget.js');

  assert.equal(
    isContextWindowExceededError('Error: context length exceeded: maximum context length is 200000 tokens'),
    true
  );
  assert.equal(
    isContextWindowExceededError('HTTP 413 Payload Too Large'),
    true
  );
  assert.equal(
    isContextWindowExceededError('IDBotsAPI Error: 400 {"type":"error","error":{"type":"api_error","message":"The reasoning_content in the thinking mode must be passed back to the API."}}'),
    false
  );
});
