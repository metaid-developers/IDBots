import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkSessionItem from '../src/renderer/components/cowork/CoworkSessionItem';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

// Render-layer guard for the Bot Home history rows. SUPERSEDED 2026-11-11
// 17:28 (owner ruling): the browser sessions' source badge is RETIRED — the
// row must never render its label in either locale, whatever the session
// type. The visited-page context line (showBrowserContext) stays the row's
// identity cue for these sessions; the data-side sessionType is untouched.
// The retired probe is the label copy itself (the old i18n key
// coworkSessionTypeBrowser is gone from both locales — pinned by the static
// guard in browserSessionHomeEntryStatic.test.mjs).

const retiredBadgeLabels = ['浏览器', 'Browser'];

const baseSession = (overrides: Partial<CoworkSessionSummary> = {}): CoworkSessionSummary => ({
  id: 'session-1',
  title: 'Session',
  status: 'idle',
  pinned: false,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const noop = () => {};

const renderItem = (session: CoworkSessionSummary): string =>
  renderToStaticMarkup(
    <CoworkSessionItem
      session={session}
      hasUnread={false}
      isActive={false}
      onSelect={noop}
      onDelete={noop}
      onTogglePin={noop}
      onRename={noop}
    />,
  );

const assertNoRetiredBadge = (html: string, context: string) => {
  for (const label of retiredBadgeLabels) {
    assert.ok(!html.includes(label), `${context} must not render the retired "${label}" badge`);
  }
};

test('browser session rows no longer carry the retired browser badge', () => {
  const html = renderItem(baseSession({ sessionType: 'browser', title: 'Chat about metaapp://x' }));
  assertNoRetiredBadge(html, 'browser row');
});

test('standard sessions do not carry the browser badge', () => {
  const html = renderItem(baseSession({ sessionType: 'standard' }));
  assertNoRetiredBadge(html, 'standard row');
});

test('a2a sessions keep their own presentation and get no browser badge', () => {
  const html = renderItem(baseSession({ sessionType: 'a2a', peerName: 'Remote Bot' }));
  assertNoRetiredBadge(html, 'a2a row');
});

test('group_task sessions get no browser badge', () => {
  const html = renderItem(baseSession({ sessionType: 'group_task' }));
  assertNoRetiredBadge(html, 'group_task row');
});
