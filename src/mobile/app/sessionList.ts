/**
 * Session-list grouping + filtering for the chat drawer (UE rework 2026-10-29,
 * A4; search added 2026-11-02).
 *
 * Owner rule: the session list reads like the desktop one — sessions grouped
 * by time (Today / Yesterday / Earlier), each row showing the owning MetaBot.
 * The grouping is derived from `updatedAt` (the desktop list sorts by the
 * same field), stays stable across renders, and never mutates its input.
 *
 * Pure module: no React, no i18n — callers map `SessionGroupKey` to labels.
 */
import type { CoworkSessionSummary } from '@/types/cowork';
import type { MobileMetabot } from '../bridge/types';
import { isRenderableAvatar } from './avatar';

export type SessionGroupKey = 'today' | 'yesterday' | 'earlier';

export interface SessionGroup {
  key: SessionGroupKey;
  sessions: CoworkSessionSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local-midnight anchor of `time`; day boundaries follow the device clock. */
function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function groupKeyFor(updatedAt: number, todayStart: number): SessionGroupKey {
  if (updatedAt >= todayStart) return 'today';
  if (updatedAt >= todayStart - DAY_MS) return 'yesterday';
  return 'earlier';
}

const GROUP_ORDER: ReadonlyArray<SessionGroupKey> = ['today', 'yesterday', 'earlier'];

/**
 * Groups sessions into Today / Yesterday / Earlier buckets by `updatedAt`.
 * Within a group the input order is preserved (the controller already hands
 * the list over desktop-ordered). Malformed timestamps (NaN/negative/absent)
 * land in "earlier" instead of throwing — a dirty row must never break the
 * whole drawer.
 */
export function groupSessionsByDay(
  sessions: ReadonlyArray<CoworkSessionSummary>,
  now: number = Date.now(),
): SessionGroup[] {
  const todayStart = startOfLocalDay(now);
  const buckets = new Map<SessionGroupKey, CoworkSessionSummary[]>();
  for (const session of sessions) {
    const updated = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) && session.updatedAt >= 0
      ? session.updatedAt
      : Number.NEGATIVE_INFINITY;
    const key = updated === Number.NEGATIVE_INFINITY ? 'earlier' : groupKeyFor(updated, todayStart);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session);
    else buckets.set(key, [session]);
  }
  return GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    sessions: buckets.get(key) as CoworkSessionSummary[],
  }));
}

export interface SessionBotView {
  metabotId: number | null;
  name: string | null;
  avatar: string | null;
}

/**
 * Filters sessions by a title substring, case-insensitive (drawer search).
 *
 * The drawer composes this BEFORE `groupSessionsByDay`, so day grouping and
 * ordering apply unchanged to the filtered result. The list is a small
 * client-side summary array (controller snapshot), so a synchronous scan per
 * keystroke is cheap by construction — no debounce needed.
 *
 * Pure, like the grouping: never mutates the input; an empty/whitespace-only
 * query returns the input unchanged; a session with a missing/non-string
 * title only survives an empty query (it matches nothing).
 */
export function filterSessionsByTitle(
  sessions: ReadonlyArray<CoworkSessionSummary>,
  query: string,
): ReadonlyArray<CoworkSessionSummary> {
  const needle = (typeof query === 'string' ? query : '').trim().toLowerCase();
  if (needle === '') return sessions;
  return sessions.filter((session) =>
    typeof session.title === 'string' && session.title.toLowerCase().includes(needle),
  );
}

/**
 * Resolves the MetaBot a session belongs to, for header/row avatars.
 *
 * Precedence: the session summary's own `metabotAvatar` (desktop parity),
 * then the roster row's avatar for `session.metabotId`, then the currently
 * selected `metabotId` (the Bot a brand-new conversation will target). Every
 * candidate passes the renderability gate — a gateway-truncated data URL
 * degrades to `null` and the caller falls back to the initial letter.
 */
export function resolveSessionBot(
  sessions: ReadonlyArray<CoworkSessionSummary>,
  sessionId: string | null,
  metabotId: number | null,
  bots: ReadonlyArray<MobileMetabot>,
): SessionBotView {
  const summary = sessionId ? sessions.find((session) => session.id === sessionId) : undefined;
  const byId = (id: number | null | undefined): MobileMetabot | undefined =>
    typeof id === 'number' ? bots.find((bot) => bot.id === id) : undefined;
  const rosterBot = byId(summary?.metabotId) ?? byId(metabotId);
  const avatar =
    [summary?.metabotAvatar, rosterBot?.avatar].find((candidate) => isRenderableAvatar(candidate)) ?? null;
  return {
    metabotId: summary?.metabotId ?? metabotId ?? null,
    name: rosterBot?.name ?? summary?.metabotName ?? null,
    avatar: typeof avatar === 'string' ? avatar : null,
  };
}
