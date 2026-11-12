import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkSessionItem from '../src/renderer/components/cowork/CoworkSessionItem';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

// Render-layer guard for the 浏览器 source badge. RESTORED 2026-11-12 (owner
// order, superseding the 2026-11-11 17:28 retirement): browser-type rows carry
// the badge again on the surfaces that opt in — the BotWorks local list and
// the search modal both render through CoworkSessionList with
// showBrowserBadge=true. The badge is a per-row PROP so the Studio panel
// history (bot-centered, its own 2026-11-11 17:28 ruling) keeps badge-free
// rows by not passing the flag.

const badgeLabel = '浏览器';
const badgeLabelEn = 'Browser';

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

const renderItem = (
  session: CoworkSessionSummary,
  extraProps: Partial<React.ComponentProps<typeof CoworkSessionItem>> = {},
): string =>
  renderToStaticMarkup(
    <CoworkSessionItem
      session={session}
      hasUnread={false}
      isActive={false}
      onSelect={noop}
      onDelete={noop}
      onTogglePin={noop}
      onRename={noop}
      {...extraProps}
    />,
  );

test('a browser row with showBrowserBadge renders the 浏览器 badge', () => {
  const html = renderItem(
    baseSession({ sessionType: 'browser', title: 'Chat about metaapp://x' }),
    { showBrowserBadge: true },
  );
  assert.ok(html.includes(badgeLabel) || html.includes(badgeLabelEn), 'the badge label must render');
});

test('a browser row WITHOUT the flag stays badge-free (Studio panel history default)', () => {
  const html = renderItem(baseSession({ sessionType: 'browser', title: 'Chat about metaapp://x' }));
  assert.ok(!html.includes(badgeLabel), 'no zh badge without the opt-in');
  assert.ok(!html.includes(badgeLabelEn), 'no en badge without the opt-in');
});

test('non-browser rows never get the badge, flag or not', () => {
  for (const sessionType of ['standard', 'a2a', 'group_task'] as const) {
    const flagged = renderItem(baseSession({ sessionType }), { showBrowserBadge: true });
    assert.ok(!flagged.includes(badgeLabel), `${sessionType} row must not render the zh badge`);
    assert.ok(!flagged.includes(badgeLabelEn), `${sessionType} row must not render the en badge`);
  }
});
