import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkHistoryPanel from '../src/renderer/features/botBrowser/CoworkHistoryPanel';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';
import { copyCoworkSessionLinkToClipboard } from '../src/renderer/components/cowork/coworkSessionLink.js';
import {
  activeDayKeysOfMonth,
  calendarCells,
  filterSessionsByDay,
  initialMonthView,
  localDayKey,
  monthOptionLabel,
  sessionDayKey,
  yearOptions,
} from '../src/renderer/features/botBrowser/panelHistoryDateFilter';

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
  metabotId: 7,
  metabotName: 'Friday',
  ...overrides,
});

const historyBots = [
  { id: 7, name: 'Friday', avatar: null, metabot_type: 'twin' },
  { id: 9, name: 'Builder', avatar: null, metabot_type: 'worker' },
];

function render(sessions: CoworkSessionSummary[], currentSessionId: string | null = null, botId: number | null = 7) {
  return renderToStaticMarkup(
    <CoworkHistoryPanel
      sessions={sessions}
      bot={historyBots.find((bot) => bot.id === botId) ?? null}
      bots={historyBots}
      onSelectBot={() => {}}
      currentSessionId={currentSessionId}
      onSelectSession={() => {}}
      onDeleteSession={() => {}}
      onTogglePin={() => {}}
      onRenameSession={() => {}}
      onClose={() => {}}
    />,
  );
}

test('the records panel opens with the baseline section label and a count', () => {
  const markup = render([session({ id: 'a' }), session({ id: 'b', title: 'Second' })]);
  assert.match(markup, /data-slot="cowork-history-panel"/);
  // Section label comes from the same history vocabulary the sidebar uses.
  assert.ok(markup.includes(i18nService.t('botBrowserCoworkHistory')));
  // The count keeps its muted tabular-nums slot (anchored, so the calendar's
  // day numbers can never satisfy it).
  assert.match(markup, /tabular-nums[^>]*>2</, 'the record count is shown as a muted number');
});

test('the bot selector sits beside the history label and above the calendar', () => {
  const markup = render([session({ id: 'a' })]);
  const historyLabelAt = markup.indexOf(i18nService.t('botBrowserCoworkHistory'));
  const botFilterAt = markup.indexOf('data-slot="cowork-history-bot-filter"');
  const dateFilterAt = markup.indexOf('data-slot="cowork-history-date-filter"');
  assert.ok(historyLabelAt >= 0 && historyLabelAt < botFilterAt, 'selector follows the history label');
  assert.ok(botFilterAt < dateFilterAt, 'selector stays above the calendar');
  assert.ok(markup.includes(i18nService.t('botBrowserHistoryBotFilter')));
  assert.match(markup, /h-5 w-5 rounded-md/);
  assert.match(markup, /Friday/);
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
  // Two-line reading: title, then relative time · page context. The former
  // type badge in this line is RETIRED (owner ruling 2026-11-11 17:28) —
  // the row must not render it in either locale.
  assert.match(row, /Open the latest on-chain games/);
  assert.match(row, /MetaApp Example/);
  assert.doesNotMatch(row, /浏览器/);
  assert.doesNotMatch(row, /Browser/);
  // The row action is the shared BotWorks ellipsis menu, revealed by hover/focus.
  assert.match(row, new RegExp(`aria-label="${i18nService.t('coworkSessionActions')}"`));
  assert.doesNotMatch(row, new RegExp(`aria-label="${i18nService.t('delete')}"`));
  assert.match(row, /group-hover:opacity-100/);
  assert.match(row, /group-focus-within:opacity-100/);
});

test("the list is bot-centered: only the presented bot's sessions render", () => {
  const mine = session({ id: 'mine-a', title: 'Mine A' });
  const mineB = session({ id: 'mine-b', title: 'Mine B' });
  const otherBot = session({ id: 'other', title: 'Other bot run', metabotId: 9 });
  const legacy: CoworkSessionSummary = session({ id: 'legacy', title: 'Legacy unattributed' });
  delete (legacy as Partial<CoworkSessionSummary>).metabotId;

  const markup = render([mine, otherBot, legacy, mineB], null, 7);
  assert.match(markup, /Mine A/);
  assert.match(markup, /Mine B/);
  assert.doesNotMatch(markup, /Other bot run/);
  assert.doesNotMatch(markup, /Legacy unattributed/);
});

test('switching the presented bot moves the list with it', () => {
  const mine = session({ id: 'mine', title: 'Mine', metabotId: 7 });
  const other = session({ id: 'other', title: 'Other', metabotId: 9 });

  const forSeven = render([mine, other], null, 7);
  assert.match(forSeven, /Mine/);
  assert.doesNotMatch(forSeven, /Other/);

  const forNine = render([mine, other], null, 9);
  assert.match(forNine, /Other/);
  assert.doesNotMatch(forNine, /Mine/);

  // No presented bot (null): the list stays empty rather than leaking rows.
  const forNone = render([mine, other], null, null);
  assert.doesNotMatch(forNone, /Mine/);
  assert.doesNotMatch(forNone, /Other/);
});

test('the inline date-filter block renders the dropdowns and the Monday-first grid', () => {
  const markup = render([session({ id: 'a' })]);
  assert.match(markup, /data-slot="cowork-history-date-filter"/);
  assert.ok(markup.includes(i18nService.t('botBrowserHistoryDateFilter')));
  // Two dropdowns (year + month).
  assert.equal((markup.match(/<select/g) ?? []).length, 2);
  // Weekday header reads Monday-first (the reference form: 一~周日历网格).
  const monday = markup.indexOf(i18nService.t('scheduledTasksFormWeekMon'));
  const sunday = markup.indexOf(i18nService.t('scheduledTasksFormWeekSun'));
  assert.ok(monday >= 0 && sunday > monday, 'weekday header is Monday-first');
  // The grid is the fixed six-week form: 42 slots total — the viewed month's
  // days are interactive day cells, the rest are muted out-of-month slots.
  const nowKey = localDayKey(Date.now());
  const [viewYear, viewMonth] = nowKey.split('-').map(Number);
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
  assert.equal((markup.match(/data-slot="cowork-history-day-cell"/g) ?? []).length, daysInMonth);
  assert.equal(
    (markup.match(/data-slot="cowork-history-day-cell"/g) ?? []).length
      + (markup.match(/opacity-30/g) ?? []).length,
    42,
    'six fixed weeks: in-month cells + muted out-of-month slots',
  );
  // The scoped session's day carries the light dot; unpicked cells are not pressed.
  const todayCell = markup.indexOf(`data-day-key="${localDayKey(Date.now())}"`);
  assert.ok(todayCell >= 0, 'today is a grid cell');
  const cellSlice = markup.slice(todayCell, todayCell + 600);
  assert.match(cellSlice, /bg-claude-accent/, 'a day holding sessions is dotted');
  assert.match(cellSlice, /aria-pressed="false"/);
  // No selection yet: no clear affordance.
  assert.doesNotMatch(markup, new RegExp(`>${i18nService.t('clear')}<`));
});

test('pinned records move ahead of unpinned records without changing their relative order', () => {
  const markup = render([
    session({ id: 'first', title: 'First unpinned' }),
    session({ id: 'pinned-a', title: 'First pinned', pinned: true }),
    session({ id: 'second', title: 'Second unpinned' }),
    session({ id: 'pinned-b', title: 'Second pinned', pinned: true }),
  ]);
  const positions = ['First pinned', 'Second pinned', 'First unpinned', 'Second unpinned']
    .map((title) => markup.indexOf(title));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
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


test('copy session id uses the same payload as the BotWorks row action', () => {
  let copied = '';
  const copiedSuccessfully = copyCoworkSessionLinkToClipboard('session-1', {
    writeText(value: string) {
      copied = value;
      return Promise.resolve();
    },
  });
  assert.equal(copiedSuccessfully, true);
  assert.equal(copied, 'IDBots://session-1');
});

// ── panelHistoryDateFilter (the inline date filter's pure model) ──────────

// Fixed reference instants, built through the LOCAL Date constructor so the
// expectations hold whatever timezone this machine runs in.
const NOV_2026 = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();

test('localDayKey stamps a local YYYY-MM-DD key', () => {
  assert.equal(localDayKey(NOV_2026(11, 23)), '2026-11-11');
  assert.equal(localDayKey(new Date(2026, 0, 2).getTime()), '2026-01-02');
});

test('the calendar grid is Monday-first with six fixed weeks', () => {
  // 2026-11-01 is a Sunday: six lead slots (Oct 26 Mon … Oct 31 Sat) come
  // first, the month starts at slot 6, and the grid always holds 42 cells.
  const cells = calendarCells(2026, 10);
  assert.equal(cells.length, 42);
  assert.equal(cells[6].key, '2026-11-01');
  assert.ok(cells[0].inMonth === false && cells[5].inMonth === false);
  assert.equal(cells[0].day, 26);
  const inMonth = cells.filter((cell) => cell.inMonth);
  assert.equal(inMonth.length, 30);
  assert.equal(inMonth[0].day, 1);
  assert.equal(inMonth.at(-1)!.day, 30);
});

test('picking a day narrows the list to that day; no pick returns everything', () => {
  const sessions = [
    { id: 'mon', updatedAt: NOV_2026(9) },
    { id: 'mon-late', updatedAt: NOV_2026(9, 22) },
    { id: 'tue', updatedAt: NOV_2026(10) },
  ];
  const mondayKey = sessionDayKey(sessions[0]);
  const monday = filterSessionsByDay(sessions, mondayKey);
  assert.deepEqual(monday.map((entry) => entry.id), ['mon', 'mon-late']);
  assert.equal(filterSessionsByDay(sessions, null).length, 3);
  assert.equal(filterSessionsByDay(sessions, '2025-01-01').length, 0);
});

test('day dots only light inside the viewed month', () => {
  const sessions = [
    { id: 'in', updatedAt: NOV_2026(11) },
    { id: 'out', updatedAt: new Date(2026, 9, 31).getTime() },
  ];
  const keys = activeDayKeysOfMonth(sessions, 2026, 10);
  assert.ok(keys.has('2026-11-11'));
  assert.equal(keys.size, 1);
});

test('the view opens on the newest scoped month and the year list stays reachable', () => {
  const sessions = [
    { id: 'old', updatedAt: new Date(2024, 5, 1).getTime() },
    { id: 'new', updatedAt: NOV_2026(2) },
  ];
  assert.deepEqual(initialMonthView(sessions, NOV_2026(11)), { year: 2026, month: 10 });
  assert.deepEqual(initialMonthView([], NOV_2026(11)), { year: 2026, month: 10 });
  const years = yearOptions(sessions, { year: 2026, month: 10 }, NOV_2026(11));
  assert.deepEqual(years, [2026, 2024]);
});

test('month option labels follow the active language', () => {
  assert.equal(monthOptionLabel(10, 'zh'), '11月');
  assert.equal(monthOptionLabel(0, 'en'), 'January');
});
