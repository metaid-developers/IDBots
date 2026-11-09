/**
 * Data model of the "Twin's work" strip: which conversations belong to a Twin,
 * how they group, and what a search query leaves visible.
 *
 * The owner's ruling (2026-11-09) makes the Twin seat dynamic — the roster can
 * hold several Twins and the seat can move between bots — so the strip NEVER
 * hard-codes "the Twin". It takes the live metabot list, keeps the rows whose
 * `metabot_type === 'twin'` RIGHT NOW, and partitions `coworkSlice.sessions` by
 * that id set. A bot demoted from Twin stops being a group on the next render;
 * a session whose owner is no longer a Twin disappears with it (the strip is
 * the current Twin's work, not "every session that once ran on a Twin seat").
 *
 * Pure functions only (no React, no i18n, no electron) so the filtering and
 * grouping rules are covered by tsx tests instead of pixel assertions.
 */

import type { CoworkSessionSummary } from '../../types/cowork';
import { sortSessionsByMode } from '../../utils/sessionViewGrouping';

/** One live bot entry; the strip only needs identity + the Twin flag. */
export interface TwinWorkMetabot {
  id: number;
  name: string | null;
  avatar: string | null;
  /** Required on purpose: the Twin set is a live roster read, not a guess. */
  metabot_type: string;
  role?: string | null;
}

export interface TwinWorkGroup {
  twin: TwinWorkMetabot;
  /** Matched sessions of this Twin, newest activity first. */
  sessions: CoworkSessionSummary[];
  /** Newest `updatedAt` among the group's sessions (0 when empty). */
  latestActivityAt: number;
}

export interface TwinWorkModel {
  /** The live Twin set, in roster order (the order the host passed). */
  twins: TwinWorkMetabot[];
  /** Groups for Twins that actually have a matched session, roster order. */
  groups: TwinWorkGroup[];
  /** Twin sessions before the query is applied (drives the strip's empty state). */
  totalTwinSessions: number;
  /** Twin sessions the current query leaves visible. */
  matchedSessions: number;
  /** Normalized (trimmed, lower-cased) query the model was built with. */
  query: string;
}

export interface TwinWorkModelInput {
  /** The full `coworkSlice.sessions` list — filtering happens here. */
  sessions: readonly CoworkSessionSummary[];
  /** The live metabot roster (any types; only `twin` entries are kept). */
  metabots: readonly TwinWorkMetabot[];
  query?: string;
}

export const TWIN_METABOT_TYPE = 'twin';

/** The Twin set of a roster read: `metabot_type === 'twin'`, nothing else. */
export const selectTwinMetabots = (
  metabots: readonly TwinWorkMetabot[],
): TwinWorkMetabot[] => metabots.filter((metabot) => metabot.metabot_type === TWIN_METABOT_TYPE);

export const normalizeTwinWorkQuery = (query?: string | null): string =>
  (query ?? '').trim().toLocaleLowerCase();

/** Case-insensitive title match; an empty query matches everything. */
export const sessionMatchesTwinWorkQuery = (
  session: CoworkSessionSummary,
  normalizedQuery: string,
): boolean => {
  if (!normalizedQuery) return true;
  return (session.title ?? '').toLocaleLowerCase().includes(normalizedQuery);
};

/**
 * Builds the strip's whole read-model in one pass:
 *   1. live Twin set from the roster (multiple Twins and seat changes included);
 *   2. `coworkSlice.sessions` partitioned by that id set — sessions with a null
 *      `metabotId` (legacy/unattributed) or a non-Twin owner are excluded;
 *   3. title search applied before grouping;
 *   4. one group per Twin that still has a match, in ROSTER order (stable: a
 *      new message never reshuffles the strip under the user's cursor), with
 *      each group's sessions newest-activity first via the shared sort.
 */
export const buildTwinWorkModel = ({
  sessions,
  metabots,
  query,
}: TwinWorkModelInput): TwinWorkModel => {
  const twins = selectTwinMetabots(metabots);
  const twinIds = new Set(twins.map((twin) => twin.id));

  const twinSessions = sessions.filter(
    (session) => session.metabotId != null && twinIds.has(session.metabotId),
  );

  const normalizedQuery = normalizeTwinWorkQuery(query);
  const matched = twinSessions.filter((session) =>
    sessionMatchesTwinWorkQuery(session, normalizedQuery),
  );

  const byTwinId = new Map<number, CoworkSessionSummary[]>();
  for (const session of matched) {
    const id = session.metabotId as number;
    const bucket = byTwinId.get(id);
    if (bucket) bucket.push(session);
    else byTwinId.set(id, [session]);
  }

  const groups: TwinWorkGroup[] = [];
  for (const twin of twins) {
    const bucket = byTwinId.get(twin.id);
    if (!bucket || bucket.length === 0) continue;
    const ordered = sortSessionsByMode([...bucket], 'updatedAt');
    groups.push({
      twin,
      sessions: ordered,
      latestActivityAt: ordered[0]?.updatedAt ?? 0,
    });
  }

  return {
    twins,
    groups,
    totalTwinSessions: twinSessions.length,
    matchedSessions: matched.length,
    query: normalizedQuery,
  };
};
