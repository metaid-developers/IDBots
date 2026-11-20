// §9 session-level visibility — RENDER-level proof (2026-11-20).
//
// tests/fallbackBrainStatus.test.mjs proves the marker's write/clear behavior
// and the pure label resolution; this file proves the actual sidebar ROW puts
// 「备用脑运行中」 on screen instead of a bare 运行中 while a fallback brain
// serves the turn. Same SSR harness as tests/assistantActivityIndicator.test.tsx
// (renderToStaticMarkup — no jsdom), so it asserts the real component output
// rather than a copy of its logic.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkSessionItem from '../src/renderer/components/cowork/CoworkSessionItem';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkActiveFallbackBrain, CoworkSessionSummary } from '../src/renderer/types/cowork';

const baseSession = (overrides: Partial<CoworkSessionSummary> = {}): CoworkSessionSummary => ({
  id: 'cw-fallback-row',
  title: 'Worker session',
  status: 'running',
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const mark = (overrides: Partial<CoworkActiveFallbackBrain> = {}): CoworkActiveFallbackBrain => ({
  provider: 'gw-b',
  model: 'mock-b1',
  fromProvider: 'gw-a',
  fromModel: 'mock-a1',
  rung: 'bot-fallback',
  since: 1_700_000_000_000,
  ...overrides,
});

const noop = () => undefined;

const renderRow = (session: CoworkSessionSummary, extra: { showBrowserContext?: boolean } = {}): string =>
  renderToStaticMarkup(
    <CoworkSessionItem
      session={session}
      hasUnread={false}
      isActive={false}
      onSelect={noop}
      onDelete={noop}
      onTogglePin={noop}
      onRename={noop}
      showBrowserContext={extra.showBrowserContext}
    />,
  );

function withLanguage<T>(language: 'zh' | 'en', run: () => T): T {
  const previous = i18nService.getLanguage();
  i18nService.setLanguage(language, { persist: false });
  try {
    return run();
  } finally {
    i18nService.setLanguage(previous, { persist: false });
  }
}

test('a running row on the bot fallback brain renders 备用脑运行中 (not a bare 运行中)', () => {
  withLanguage('zh', () => {
    const markup = renderRow(baseSession({ activeFallbackBrain: mark() }));
    assert.match(markup, /备用脑运行中/, 'the visible status word names the fallback brain')
    assert.doesNotMatch(markup, />运行中</, 'the plain running word is replaced, not duplicated')
    assert.match(markup, /data-fallback-brain="bot-fallback"/, 'the status dot carries the rung')
    assert.match(markup, /主模型 mock-a1 不可用，本轮由 mock-b1 \(gw-b\) 继续执行。/, 'the tooltip names both routes')
    assert.match(markup, /text-amber-600/, 'the degradation is visually distinct from a healthy run')
  })
})

test('the same row without a marker keeps the plain 运行中 status', () => {
  withLanguage('zh', () => {
    const markup = renderRow(baseSession())
    assert.match(markup, /运行中/, 'the ordinary running status is unchanged')
    assert.doesNotMatch(markup, /备用脑运行中|降级模型运行中/, 'no degradation label without a marker')
    assert.doesNotMatch(markup, /data-fallback-brain=/, 'no test hook without a marker')
  })
})

test('current-default / system-rescue rungs render 降级模型运行中, not 备用脑运行中', () => {
  withLanguage('zh', () => {
    for (const rung of ['current-default', 'system-rescue'] as const) {
      const markup = renderRow(baseSession({ activeFallbackBrain: mark({ rung }) }))
      assert.match(markup, /降级模型运行中/, `${rung} gets the general degradation label`)
      assert.doesNotMatch(markup, /备用脑运行中/)
      assert.match(markup, new RegExp(`data-fallback-brain="${rung}"`))
    }
  })
})

test('a settled row never claims the fallback brain is running (stale marker guard)', () => {
  withLanguage('zh', () => {
    for (const status of ['completed', 'error', 'idle', 'stopped'] as const) {
      const markup = renderRow(baseSession({ status, activeFallbackBrain: mark() }))
      assert.doesNotMatch(markup, /备用脑运行中/, `${status} must not show a live fallback label`)
    }
  })
})

test('Studio history rows keep the degradation visible even though idle/running words are hidden there', () => {
  withLanguage('zh', () => {
    const markup = renderRow(baseSession({ activeFallbackBrain: mark() }), { showBrowserContext: true })
    assert.match(markup, /备用脑运行中/, 'the Studio surface is exactly where a post-mortem reads the row')
  })
})

test('the English surface says Fallback brain running', () => {
  withLanguage('en', () => {
    const markup = renderRow(baseSession({ activeFallbackBrain: mark() }))
    assert.match(markup, /Fallback brain running/)
    assert.match(markup, /Primary model mock-a1 is unavailable; this turn is continuing on mock-b1 \(gw-b\)\./)
  })
})
