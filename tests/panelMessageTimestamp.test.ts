import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPanelClock,
  formatPanelDate,
  formatPanelMessageTimestamp,
  isPanelMessageGroupEnd,
} from '../src/renderer/features/botBrowser/panelMessageTimestamp';
import type { CoworkMessage } from '../src/renderer/types/cowork';

// Bubble meta-line stamps (purity pass #1, item ①): same-day `HH:mm`, older
// days `MM-DD HH:mm`. All expectations are computed against a FIXED `now`
// (2026-11-10 21:52 local, matching the delegation) so the day boundary is
// pinned instead of racing the real clock. NOTE: assertions use local-time
// constructors, so they hold in every timezone the suite runs in.

const NOW = new Date(2026, 10, 10, 21, 52, 0).getTime(); // 2026-11-10 21:52 local

test('same-day stamps render as zero-padded 24h HH:mm', () => {
  assert.equal(formatPanelMessageTimestamp(new Date(2026, 10, 10, 9, 5).getTime(), NOW), '09:05');
  assert.equal(formatPanelMessageTimestamp(new Date(2026, 10, 10, 21, 52).getTime(), NOW), '21:52');
  assert.equal(formatPanelMessageTimestamp(new Date(2026, 10, 10, 23, 59).getTime(), NOW), '23:59');
  assert.equal(formatPanelMessageTimestamp(new Date(2026, 10, 10, 0, 0).getTime(), NOW), '00:00');
});

test('stamps from any earlier day render as MM-DD HH:mm', () => {
  assert.equal(formatPanelMessageTimestamp(new Date(2026, 10, 9, 18, 31).getTime(), NOW), '11-09 18:31');
  // Year boundary and far history both keep the MM-DD form (no year on the
  // meta line — the panel is a recent-conversation surface).
  assert.equal(formatPanelMessageTimestamp(new Date(2025, 0, 2, 7, 3).getTime(), NOW), '01-02 07:03');
  // A FUTURE day (clock skew) is not "same day", so it also carries the date.
  assert.equal(formatPanelMessageTimestamp(new Date(2026, 10, 11, 8, 0).getTime(), NOW), '11-11 08:00');
});

test('the day boundary is the local calendar date, not 24h arithmetic', () => {
  // 23:59:59.999 yesterday vs 00:00 today straddle the boundary at midnight.
  const almostYesterday = new Date(2026, 10, 10, 0, 0).getTime() - 1;
  assert.equal(formatPanelMessageTimestamp(almostYesterday, NOW), '11-09 23:59');
  assert.equal(formatPanelMessageTimestamp(new Date(2026, 10, 10, 0, 0).getTime(), NOW), '00:00');
});

test('non-finite and pre-epoch timestamps render empty (meta line omits the stamp)', () => {
  assert.equal(formatPanelMessageTimestamp(Number.NaN, NOW), '');
  assert.equal(formatPanelMessageTimestamp(-5, NOW), '');
  assert.equal(formatPanelMessageTimestamp(Number.POSITIVE_INFINITY, NOW), '');
});

test('clock and date helpers agree with the composed stamp', () => {
  const stamp = new Date(2026, 10, 9, 18, 31);
  assert.equal(formatPanelClock(stamp), '18:31');
  assert.equal(formatPanelDate(stamp), '11-09');
  assert.equal(`${formatPanelDate(stamp)} ${formatPanelClock(stamp)}`, '11-09 18:31');
});

// --- Group-end predicate (purity pass #3, item ①) ---------------------------
// Only the LAST bubble of a same-sender burst carries the stamp. The grouping
// mirrors the transcript's turn semantics: sender adjacency, no time-gap
// threshold (a group breaks when the message type flips, never on a clock).

const panelMessage = (id: string, type: CoworkMessage['type']): CoworkMessage => ({
  id,
  type,
  content: `${type} body`,
  timestamp: NOW,
});

test('only the last message of a same-sender burst is a group end', () => {
  const messages = [
    panelMessage('u1', 'user'),
    panelMessage('u2', 'user'),
    panelMessage('a1', 'assistant'),
    panelMessage('a2', 'assistant'),
    panelMessage('a3', 'assistant'),
    panelMessage('u3', 'user'),
  ];
  // u2 (user burst ends before a1), a3 (assistant burst ends before u3), and
  // the transcript-final u3 carry the stamp; every earlier burst member is
  // stamp-free.
  assert.deepEqual(
    messages.map((_, index) => isPanelMessageGroupEnd(messages, index)),
    [false, true, false, false, true, true],
  );
});

test('a group also ends at the very end of the transcript', () => {
  const messages = [panelMessage('a1', 'assistant'), panelMessage('a2', 'assistant')];
  assert.equal(isPanelMessageGroupEnd(messages, 1), true, 'final bubble is always a group end');
  assert.equal(isPanelMessageGroupEnd(messages, 0), false);
});

test('out-of-range and empty sequences carry no stamp', () => {
  assert.equal(isPanelMessageGroupEnd([], 0), false);
  assert.equal(isPanelMessageGroupEnd([panelMessage('u1', 'user')], 1), false);
  assert.equal(isPanelMessageGroupEnd([panelMessage('u1', 'user')], -1), false);
});
