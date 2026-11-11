/**
 * Pure date-filter model for the Studio session-history panel (owner spec
 * 2026-11-11 17:28, item ③): an INLINE "browse by date" block — year/month
 * dropdowns plus a Monday-first calendar grid (the reference "选择发送日期"
 * popup's form, embedded instead of popping) — where picking a day narrows
 * the list to that day's sessions and days that hold sessions carry a light
 * dot. All math lives here so the behavior is testable without a DOM.
 *
 * Day attribution follows the session row's own displayed timestamp: the
 * `updatedAt` activity anchor (the same field the timeline grouping and the
 * row's relative time use), in the machine's LOCAL time.
 */

export interface PanelHistoryCalendarCell {
  /** Real calendar day number for this grid slot (1-based). */
  day: number;
  /** The slot's full local date ( midnight of that day, local ). */
  date: Date;
  /** Whether the slot belongs to the viewed month (out-of-month slots render muted). */
  inMonth: boolean;
  /** Local day key of the slot — the grid's stable identity. */
  key: string;
}

export interface PanelHistoryMonthView {
  year: number;
  /** 0-based month (Date.getMonth convention). */
  month: number;
}

/** Local `YYYY-MM-DD` key of a millisecond timestamp. */
export const localDayKey = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** The day key a session's row belongs to (its displayed activity anchor). */
export const sessionDayKey = (session: { updatedAt: number }): string =>
  localDayKey(session.updatedAt);

/**
 * The Monday-first calendar grid for a viewed month (owner reference form:
 * 一~周日历网格). Six fixed weeks (42 slots) so the grid never reflows and
 * out-of-month days stay muted instead of shifting rows.
 */
export const calendarCells = (year: number, month: number): PanelHistoryCalendarCell[] => {
  const firstOfMonth = new Date(year, month, 1);
  // Monday = 0 … Sunday = 6 (getDay(): Sunday = 0).
  const lead = (firstOfMonth.getDay() + 6) % 7;
  const cells: PanelHistoryCalendarCell[] = [];
  for (let slot = 0; slot < 42; slot += 1) {
    const date = new Date(year, month, 1 - lead + slot);
    cells.push({
      day: date.getDate(),
      date,
      inMonth: date.getMonth() === month,
      key: localDayKey(date.getTime()),
    });
  }
  return cells;
};

/** Weekday header labels, Monday-first: existing scheduled-task vocabulary. */
export const weekdayHeaderKeys = [
  'scheduledTasksFormWeekMon',
  'scheduledTasksFormWeekTue',
  'scheduledTasksFormWeekWed',
  'scheduledTasksFormWeekThu',
  'scheduledTasksFormWeekFri',
  'scheduledTasksFormWeekSat',
  'scheduledTasksFormWeekSun',
] as const;

/** Month option label: `11月` (zh) / `November` (en), matching the reference form. */
export const monthOptionLabel = (month: number, language: string): string => {
  if (language === 'zh') return `${month + 1}月`;
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, month, 15)));
};

/** The month view the panel opens on: the newest scoped session's month; today when empty. */
export const initialMonthView = (
  sessions: ReadonlyArray<{ updatedAt: number }>,
  nowMs: number = Date.now(),
): PanelHistoryMonthView => {
  let newest = nowMs;
  for (const session of sessions) {
    if (session.updatedAt > newest) newest = session.updatedAt;
  }
  const date = new Date(newest);
  return { year: date.getFullYear(), month: date.getMonth() };
};

/**
 * Year dropdown options: every year the scoped sessions touch, plus the
 * viewed year and today's year (so the view is never a dead end), newest
 * first — the same newest-first reading the list itself uses.
 */
export const yearOptions = (
  sessions: ReadonlyArray<{ updatedAt: number }>,
  view: PanelHistoryMonthView,
  nowMs: number = Date.now(),
): number[] => {
  const years = new Set<number>([view.year, new Date(nowMs).getFullYear()]);
  for (const session of sessions) {
    years.add(new Date(session.updatedAt).getFullYear());
  }
  return [...years].sort((a, b) => b - a);
};

/**
 * Days of the viewed month that hold at least one scoped session — the dots
 * the grid marks. Keys are local day keys, so the grid matches them by cell.
 */
export const activeDayKeysOfMonth = (
  sessions: ReadonlyArray<{ updatedAt: number }>,
  year: number,
  month: number,
): Set<string> => {
  const keys = new Set<string>();
  for (const session of sessions) {
    const key = sessionDayKey(session);
    const [keyYear, keyMonth] = key.split('-').map(Number);
    if (keyYear === year && keyMonth - 1 === month) keys.add(key);
  }
  return keys;
};

/** The narrowed list for a picked day; no pick (null) returns the input unchanged. */
export const filterSessionsByDay = <T extends { updatedAt: number }>(
  sessions: readonly T[],
  selectedDayKey: string | null,
): T[] => {
  if (!selectedDayKey) return [...sessions];
  return sessions.filter((session) => sessionDayKey(session) === selectedDayKey);
};
