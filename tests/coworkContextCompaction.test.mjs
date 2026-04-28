import test from 'node:test';
import assert from 'node:assert/strict';

test('buildCoworkCompactedPrompt creates summary, recent tail, and current request without thinking blocks', async () => {
  const {
    buildCoworkCompactedPrompt,
  } = await import('../dist-electron/libs/coworkContextCompaction.js');

  const currentPrompt = '请继续修复 compact retry';
  const result = buildCoworkCompactedPrompt({
    messages: [
      {
        id: 'old-user',
        type: 'user',
        content: '早期需求：分析 cowork 上下文问题',
        timestamp: 1,
      },
      {
        id: 'thinking',
        type: 'assistant',
        content: 'private chain of thought that must not be replayed',
        timestamp: 2,
        metadata: { isThinking: true },
      },
      {
        id: 'recent-assistant',
        type: 'assistant',
        content: '最近结论：resume 的 SDK 会话可能超过模型窗口',
        timestamp: 3,
      },
      {
        id: 'current-user',
        type: 'user',
        content: currentPrompt,
        timestamp: 4,
      },
    ],
    currentPrompt,
    modelLimits: { contextWindow: 4_000, maxOutputTokens: 500 },
    maxRecentMessages: 1,
  });

  assert.match(result.prompt, /<session_summary>/);
  assert.match(result.prompt, /早期需求：分析 cowork 上下文问题/);
  assert.match(result.prompt, /<recent_tail>/);
  assert.match(result.prompt, /最近结论：resume 的 SDK 会话可能超过模型窗口/);
  assert.match(result.prompt, /<current_user_request>/);
  assert.match(result.prompt, /请继续修复 compact retry/);
  assert.equal(result.prompt.includes('private chain of thought'), false);
  assert.equal(result.prompt.match(/请继续修复 compact retry/g)?.length, 1);
  assert.equal(result.recentMessages, 1);
  assert.equal(result.summarizedMessages, 1);
});

test('buildCoworkCompactedPrompt respects tight summary and tail budgets', async () => {
  const {
    buildCoworkCompactedPrompt,
  } = await import('../dist-electron/libs/coworkContextCompaction.js');

  const result = buildCoworkCompactedPrompt({
    messages: [
      {
        id: 'old',
        type: 'user',
        content: 'old '.repeat(200),
        timestamp: 1,
      },
      {
        id: 'recent',
        type: 'assistant',
        content: 'recent '.repeat(200),
        timestamp: 2,
      },
    ],
    currentPrompt: 'current task',
    modelLimits: { contextWindow: 800, maxOutputTokens: 100 },
    maxSummaryChars: 120,
    maxRecentTailTokens: 20,
  });

  assert.ok(result.prompt.length < 1_200);
  assert.match(result.prompt, /truncated/);
  assert.equal(result.estimatedTokens <= 300, true);
});
