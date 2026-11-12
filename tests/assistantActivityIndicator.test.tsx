import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantActivityIndicator } from '../src/renderer/components/cowork/AssistantActivityIndicator';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const message = (id: string, type: CoworkMessage['type'], metadata: CoworkMessage['metadata'] = {}, content = ''): CoworkMessage => ({
  id,
  type,
  content,
  timestamp: 1,
  metadata,
});

test('owner wait outranks stale projection, streaming, and tool activity', () => {
  const previousLanguage = i18nService.getLanguage();
  i18nService.setLanguage('zh', { persist: false });
  try {
    const messages = [
      message('old-user', 'user', { origin: 'user' }),
      message('old-project', 'tool_use', { toolName: 'bot_browser_preview_local', toolUseId: 'old-project' }),
      message('old-result', 'tool_result', { toolUseId: 'old-project', isError: false }),
      message('current-user', 'user', { origin: 'user' }),
      message('stream', 'assistant', { isStreaming: true }, 'A visible response is still streaming'),
      message('ask', 'tool_use', { toolName: 'AskUserQuestion', toolUseId: 'ask-1', toolInput: { questions: [] } }),
    ];
    const markup = renderToStaticMarkup(
      <AssistantActivityIndicator inline messages={messages} sessionId="session-1" waitingForOwner />,
    );
    assert.match(markup, /等待你的选择，回答后我会继续/);
    assert.match(markup, /data-activity="waiting-owner"/);
    assert.match(markup, /is-waiting/);
    assert.doesNotMatch(markup, /成品已投屏|正在继续完善|正在输出中|正在动手处理/);
    assert.doesNotMatch(markup, /assistant-status-shimmer/);
  } finally {
    i18nService.setLanguage(previousLanguage, { persist: false });
  }
});

test('pending owner_update and projection_begin tool calls never drive the status line', () => {
  const previousLanguage = i18nService.getLanguage();
  i18nService.setLanguage('zh', { persist: false });
  try {
    const bookkeepingOnly = [
      message('user-1', 'user', { origin: 'user' }),
      message('ou', 'tool_use', { toolName: 'owner_update', toolUseId: 'ou-1', toolInput: { message: '进展更新' } }),
      message('pb', 'tool_use', { toolName: 'projection_begin', toolUseId: 'pb-1' }),
    ];
    const markup = renderToStaticMarkup(
      <AssistantActivityIndicator inline messages={bookkeepingOnly} sessionId="session-1" />,
    );
    assert.doesNotMatch(markup, /汇报进展|投屏到大屏/, 'bookkeeping tools produce no tool-status phrase');
    assert.match(markup, /正在继续处理|正在推进/, 'the neutral continue fallback covers the gap');

    // A real pending tool still surfaces behind the skipped bookkeeping rows.
    const withRealTool = [
      ...bookkeepingOnly,
      message('bash', 'tool_use', { toolName: 'bash', toolUseId: 'b-1', toolInput: { command: 'ls -la' } }),
    ];
    const toolMarkup = renderToStaticMarkup(
      <AssistantActivityIndicator inline messages={withRealTool} sessionId="session-1" />,
    );
    assert.match(toolMarkup, /正在执行：ls -la/, 'the newest REAL pending tool wins');
  } finally {
    i18nService.setLanguage(previousLanguage, { persist: false });
  }
});
