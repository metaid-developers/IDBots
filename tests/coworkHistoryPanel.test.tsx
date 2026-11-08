import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkHistoryPanel from '../src/renderer/features/botBrowser/CoworkHistoryPanel';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const session = (overrides: Partial<CoworkSessionSummary>): CoworkSessionSummary => ({
  id: 'session-1',
  title: 'Open the latest on-chain games',
  status: 'idle',
  pinned: false,
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now() - 120_000,
  sessionType: 'browser',
  browserTitle: 'MetaApp Example',
  browserUri: 'metaapp://example',
  metabotName: 'Friday',
  ...overrides,
});

function render(sessions: CoworkSessionSummary[], currentSessionId: string | null = null) {
  return renderToStaticMarkup(
    <CoworkHistoryPanel
      sessions={sessions}
      currentSessionId={currentSessionId}
      onSelectSession={() => {}}
      onDeleteSession={() => {}}
      onClose={() => {}}
    />,
  );
}

test('the records panel opens with the baseline section label and a count', () => {
  const markup = render([session({ id: 'a' }), session({ id: 'b', title: 'Second' })]);
  assert.match(markup, /data-slot="cowork-history-panel"/);
  // Section label comes from the same history vocabulary the sidebar uses.
  assert.ok(markup.includes(i18nService.t('botBrowserCoworkHistory')));
  assert.match(markup, />2</, 'the record count is shown as a muted number');
});

test('record rows keep the original IDBots row grammar', () => {
  const markup = render([session({ id: 'row-a' })], 'row-a');
  assert.match(markup, /data-slot="cowork-history-row"/);
  const rowStart = markup.indexOf('data-slot="cowork-history-row"');
  const row = markup.slice(rowStart, markup.indexOf('</div>', markup.indexOf('data-slot="cowork-history-row"') + 4000));
  // Baseline row density + active state.
  assert.match(row, /\bpx-2\.5\b/);
  assert.match(row, /\bpy-1\.5\b/);
  assert.match(row, /\brounded-lg\b/);
  assert.match(row, /bg-black\/\[0\.06\]/);
  // Two-line reading: title, then relative time · type badge · page context.
  assert.match(row, /Open the latest on-chain games/);
  assert.match(row, /MetaApp Example/);
  assert.match(row, new RegExp(i18nService.t('coworkSessionTypeBrowser')));
  // The row action is the shared delete affordance, revealed by hover/focus.
  assert.match(row, new RegExp(`aria-label="${i18nService.t('delete')}"`));
  assert.match(row, /group-hover:opacity-100/);
  assert.match(row, /group-focus-within:opacity-100/);
});

test('the empty state is the baseline centred sentence, not a bare line', () => {
  const markup = render([]);
  assert.match(markup, /py-8 text-center/);
  assert.ok(markup.includes(i18nService.t('coworkNoSessions')));
  assert.doesNotMatch(markup, /data-slot="cowork-history-row"/);
});

test('assistant-mode titles go through the shared presentation rule', () => {
  const markup = render([
    session({ id: 'a', title: '[编排任务] Long run', assistantMode: true }),
  ]);
  assert.match(markup, />Long run</);
  assert.doesNotMatch(markup, /\[编排任务\]/);
});
