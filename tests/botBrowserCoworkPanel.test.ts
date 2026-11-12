import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PanelMessage,
  filterVisiblePanelMessages,
} from '../src/renderer/features/botBrowser/BotBrowserCoworkPanel';
import {
  buildPanelDelegationStatusCopy,
  formatPanelDelegationElapsed,
} from '../src/renderer/features/botBrowser/panelDelegationStatus';
import { describePanelTurnFailure } from '../src/renderer/features/botBrowser/panelTurnFailure';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const msg = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: Math.random().toString(36).slice(2),
  type: 'assistant',
  content: 'text',
  timestamp: 1000,
  ...overrides,
});

test('filterVisiblePanelMessages keeps user and final assistant messages', () => {
  const input = [
    msg({ type: 'user', content: 'hello' }),
    msg({ type: 'assistant', content: 'final answer' }),
  ];
  assert.equal(filterVisiblePanelMessages(input).length, 2);
});

test('filterVisiblePanelMessages hides tools, system, thinking, and delegation-internal noise', () => {
  const input = [
    msg({ type: 'tool_use', metadata: { toolName: 'bot_browser_tabs' } }),
    msg({ type: 'tool_result' }),
    msg({ type: 'system' }),
    msg({ type: 'assistant', metadata: { isThinking: true } }),
    msg({ type: 'assistant', metadata: { isDelegationInternal: true } }),
    msg({ type: 'user', metadata: { isDelegationInternal: true } }),
  ];
  assert.equal(filterVisiblePanelMessages(input).length, 0);
});

test('filterVisiblePanelMessages keeps turn-level failure rows only', () => {
  const input = [
    msg({ type: 'system', content: 'Error: DSH turn failed: boom', metadata: { error: 'DSH turn failed: boom' } }),
    msg({ type: 'system', content: '', metadata: { dshTurnStalled: true } }),
    msg({ type: 'system', content: '', metadata: { dshTurnInterrupted: true } }),
    msg({ type: 'system', content: '', metadata: { emptyTerminalTurn: true } }),
    // Everything below must stay hidden:
    msg({ type: 'system', content: '', metadata: { compaction: true, compactedItems: 3, compactedTokens: 900 } }),
    msg({ type: 'system', content: '', metadata: { compaction: true, isError: true } }),
    msg({ type: 'system', content: 'SDK notice', metadata: { sdkRuntimeStatus: 'requesting' } }),
    msg({ type: 'system', content: 'fallback banner', metadata: { dshRouteFallback: true } }),
    msg({ type: 'system', content: '' }),
  ];
  const kept = filterVisiblePanelMessages(input);
  assert.equal(kept.length, 4, 'error + three flags survive; compaction and other system rows do not');
  assert.ok(kept.every((message) => message.type === 'system'));
});

test('PanelMessage renders the failure card with reason+hint and hides raw text by default', () => {
  const previousLanguage = i18nService.getLanguage();
  i18nService.setLanguage('zh', { persist: false });
  try {
    const failure = msg({
      type: 'system',
      content: 'Error: free_quota_exhausted',
      metadata: { error: 'free_quota_exhausted' },
    });
    const markup = renderToStaticMarkup(
      React.createElement(PanelMessage, {
        message: failure,
        onOpenUri: () => undefined,
        showTurnFailureContinue: true,
        onTurnFailureContinue: () => undefined,
      }),
    );
    assert.match(markup, /这一轮没能完成/, 'localized title');
    assert.match(markup, /模型的免费额度用完了/, 'classified reason, not raw text');
    assert.match(markup, /说「继续」我就接着做。/, 'generic hint appended');
    assert.match(markup, /<details[\s>]/, 'raw error sits behind a collapsed disclosure');
    assert.match(markup, /free_quota_exhausted/, 'the raw error text is present inside details');
    assert.match(markup, />继续</, 'the Continue button renders when allowed');

    const older = renderToStaticMarkup(
      React.createElement(PanelMessage, {
        message: failure,
        onOpenUri: () => undefined,
        showTurnFailureContinue: false,
      }),
    );
    assert.doesNotMatch(older, />继续</, 'Continue is withheld when the card is not the actionable one');

    const stalled = msg({ type: 'system', content: '', metadata: { dshTurnStalled: true } });
    const stalledMarkup = renderToStaticMarkup(
      React.createElement(PanelMessage, { message: stalled, onOpenUri: () => undefined }),
    );
    assert.match(stalledMarkup, /本轮长时间无进展/, 'flag kinds reuse the existing i18n explanation');
    assert.match(stalledMarkup, /说「继续」我就接着做。/, 'flag cards carry the generic hint');
    assert.doesNotMatch(stalledMarkup, /<details>/, 'flag rows have no raw error to disclose');
  } finally {
    i18nService.setLanguage(previousLanguage, { persist: false });
  }
});

test('describePanelTurnFailure joins reason and hint per language', () => {
  const failure = msg({
    type: 'system',
    content: 'Error: context compaction failed',
    metadata: { error: 'DSH turn failed: context compaction failed: no adapter registered' },
  });
  const zh = describePanelTurnFailure(failure, 'zh');
  assert.equal(zh.title, '这一轮没能完成');
  assert.equal(zh.body, '对话太长，整理上下文时出了问题。可以新开一个对话，或说「继续」让我再试一次。');
  assert.equal(zh.details, 'DSH turn failed: context compaction failed: no adapter registered');
  const en = describePanelTurnFailure(failure, 'en');
  assert.equal(en.title, "This run didn't finish");
  assert.equal(
    en.body,
    'The conversation grew too long and context compaction failed. Start a new conversation, or say “continue” and I\'ll try again.',
  );
});

test('formatPanelDelegationElapsed covers minute/hour tiers in both languages', () => {
  assert.equal(formatPanelDelegationElapsed(30_000, 'zh'), '1 分钟');
  assert.equal(formatPanelDelegationElapsed(5 * 60_000, 'zh'), '5 分钟');
  assert.equal(formatPanelDelegationElapsed(65 * 60_000, 'zh'), '1 小时 5 分');
  assert.equal(formatPanelDelegationElapsed(120 * 60_000, 'zh'), '2 小时');
  assert.equal(formatPanelDelegationElapsed(5 * 60_000, 'en'), '5m');
  assert.equal(formatPanelDelegationElapsed(65 * 60_000, 'en'), '1h 5m');
  assert.equal(formatPanelDelegationElapsed(120 * 60_000, 'en'), '2h');
});

test('buildPanelDelegationStatusCopy names one worker or collapses several', () => {
  const now = 10_000_000;
  const one = [{
    attemptId: 'a1',
    workerMetabotId: 7,
    workerName: 'Builder阿码',
    workerAvatar: 'data:image/png;base64,x',
    workerSessionId: 'ws-1',
    title: '核对交付物',
    startedAt: now - 5 * 60_000,
  }];
  const single = buildPanelDelegationStatusCopy(one, 'Jarvis', 'zh', now);
  assert.ok(single);
  assert.equal(single.line1, 'Builder阿码 正在处理「核对交付物」 · 已 5 分钟');
  assert.equal(single.line2, '交回来后 Jarvis 会核对，再向你汇报');
  assert.equal(single.primary.attemptId, 'a1');

  const many = buildPanelDelegationStatusCopy([
    ...one,
    { attemptId: 'a2', workerMetabotId: 8, workerName: 'Writer小雨', title: '起草文案', startedAt: now - 60_000 },
  ], 'Jarvis', 'zh', now);
  assert.ok(many);
  assert.equal(many.line1, 'Builder阿码 等 2 位 Bot 正在处理…', 'several workers collapse to first + count');
  assert.equal(many.line2, '交回来后 Jarvis 会核对，再向你汇报');

  const en = buildPanelDelegationStatusCopy(one, 'Jarvis', 'en', now);
  assert.ok(en);
  assert.equal(en.line1, 'Builder阿码 is working on “核对交付物” · 5m');
  assert.equal(en.line2, "When it's back, Jarvis will check it and report to you.");

  assert.equal(buildPanelDelegationStatusCopy([], 'Jarvis', 'zh', now), null);
});
