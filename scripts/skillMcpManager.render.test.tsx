import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Provider } from 'react-redux';
import { renderToStaticMarkup } from 'react-dom/server';
import { store } from '../src/renderer/store';
import { i18nService } from '../src/renderer/services/i18n';
import SkillMcpManager from '../src/renderer/components/skills/SkillMcpManager';

test('SkillMcpManager defaults to skills mode and does not show MCP controls', () => {
  i18nService.setLanguage('zh', { persist: false });

  const markup = renderToStaticMarkup(
    <Provider store={store}>
      <SkillMcpManager />
    </Provider>
  );

  assert.match(markup, />技能</);
  assert.match(markup, />MCP</);
  assert.match(markup, /本地技能/);
  assert.match(markup, /精选第三方技能/);
  assert.match(markup, /搜索技能/);
  assert.doesNotMatch(markup, /本地 MCP/);
  assert.doesNotMatch(markup, /精选 MCP/);
  assert.doesNotMatch(markup, /自定义 MCP/);
  assert.doesNotMatch(markup, /搜索 MCP 服务/);
});
