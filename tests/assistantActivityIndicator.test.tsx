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
