/**
 * Panel bubble timestamp formatting (office-chat purity pass #1, item ①;
 * hover-revealed grouping added in pass #3, item ①).
 *
 * One message bubble, one small meta line: same-day stamps read as local
 * `HH:mm`, stamps from any earlier day read as `MM-DD HH:mm`. The panel is a
 * conversational surface, so the line must stay visible but quiet — formatting
 * only, no date separators, no per-message day headers.
 *
 * Kept as a pure function of (timestamp, now) so tests pin the day boundary
 * without freezing a clock.
 */

import type { CoworkMessage } from '../../types/cowork';

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

/**
 * Group-end predicate (purity pass #3, item ①): consecutive VISIBLE messages
 * from the same sender render as one group, and only the group's last bubble
 * carries the hover-revealed stamp — the other rows stay meta-free, so the
 * chat reads as per-sender bursts instead of one stamped line per bubble.
 *
 * The grouping follows the transcript's own turn semantics
 * (buildConversationTurns in coworkConversationProjection): sender adjacency
 * with no time-gap threshold — a group breaks when the message type flips
 * (user ↔ assistant), not when N minutes elapsed. Pure over the already
 * filtered (rendered) sequence, so hidden noise never splits a group.
 */
export const isPanelMessageGroupEnd = (
  messages: readonly CoworkMessage[],
  index: number,
): boolean => {
  const current = messages[index];
  if (!current) return false;
  const next = messages[index + 1];
  return !next || next.type !== current.type;
};
