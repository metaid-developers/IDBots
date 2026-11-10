/**
 * Panel bubble timestamp formatting (office-chat purity pass #1, item ①).
 *
 * One message bubble, one small meta line: same-day stamps read as local
 * `HH:mm`, stamps from any earlier day read as `MM-DD HH:mm`. The panel is a
 * conversational surface, so the line must stay visible but quiet — formatting
 * only, no date separators, no per-message day headers.
 *
 * Kept as a pure function of (timestamp, now) so tests pin the day boundary
 * without freezing a clock.
 */

const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));

/**
 * `HH:mm` in local time (24h, zero-padded).
 */
export const formatPanelClock = (date: Date): string => (
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
);

/**
 * `MM-DD` in local time (zero-padded, no year — the panel shows recent
 * conversation history, where a year-qualified stamp would be noise).
 */
export const formatPanelDate = (date: Date): string => (
  `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
);

/**
 * Bubble meta-line stamp: same local calendar day → `HH:mm`; any earlier
 * day → `MM-DD HH:mm`. A non-finite or pre-epoch timestamp renders as an
 * empty string (the meta line then simply omits the stamp) instead of
 * surfacing "NaN:NaN" or "Invalid Date" in the chat.
 */
export const formatPanelMessageTimestamp = (timestampMs: number, nowMs: number): string => {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return '';
  const stamp = new Date(timestampMs);
  const now = new Date(nowMs);
  const sameDay = stamp.getFullYear() === now.getFullYear()
    && stamp.getMonth() === now.getMonth()
    && stamp.getDate() === now.getDate();
  const clock = formatPanelClock(stamp);
  return sameDay ? clock : `${formatPanelDate(stamp)} ${clock}`;
};
