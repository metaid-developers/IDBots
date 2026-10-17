/**
 * Autonomous-task session folding for the bot-home sidebar's local-chats list.
 *
 * The app creates sessions on its own — [长期] long-term task runs,
 * [编排任务] / [Orchestration Task] delegation runs, [定时] scheduled-task runs.
 * Main stamps `auto_origin` on those rows (CoworkStore.setSessionAutoOrigin) and
 * the summary carries it as `autoOrigin`. The sidebar folds them all into a
 * collapsed "Autonomous Tasks" (自主任务) section per the policy below;
 * scheduled-task runs fold with the rest — every fire is a machine-started run,
 * and one row per fire would otherwise crowd the main list, which is meant to
 * stay the user's own conversations. (This reverses the earlier carve-out that
 * kept scheduled runs visible.)
 *
 * The folder is named for HOW those rows run — the Twin Bot drives them
 * autonomously, without the owner in the loop — while the `autoOrigin` field
 * keeps naming the creation fact (who created the session).
 *
 * Pure module (no React / i18n / electron imports) so it can be unit-tested with
 * tsx directly, mirroring sessionViewGrouping.ts.
 */

import type { CoworkSessionSummary } from '../types/cowork';

/** The two halves of a local-chats list after folding. */
export interface SessionsByAutonomousFold {
  /** Human-initiated sessions — the visible main list. */
  humanSessions: CoworkSessionSummary[];
  /** Folded autonomous sessions — the collapsed "Autonomous Tasks" fold. */
  autoSessions: CoworkSessionSummary[];
}

/**
 * Whether the app created this session on its own. Only a real marker counts:
 * `null` (and legacy rows, whose field is `undefined`) is human-initiated.
 * This is the creation FACT; whether the session actually folds is the policy
 * in shouldFoldIntoAutonomousTasks (plus any manual override on the row).
 */
export const isAutoCreatedSession = (
  session: Pick<CoworkSessionSummary, 'autoOrigin'>,
): boolean => session.autoOrigin != null;

/** Origins that collapse into the Autonomous Tasks fold — every machine-started
 * run kind. Human rows (no marker) are everything else and stay in the main
 * list. */
const FOLDED_AUTO_ORIGINS: ReadonlySet<NonNullable<CoworkSessionSummary['autoOrigin']>> = new Set([
  'longterm',
  'orchestration',
  'schedule',
]);

/** Fold policy: every machine-started run (long-term, orchestration, scheduled) folds. */
export const shouldFoldIntoAutonomousTasks = (
  session: Pick<CoworkSessionSummary, 'autoOrigin'>,
): boolean => session.autoOrigin != null && FOLDED_AUTO_ORIGINS.has(session.autoOrigin);

/**
 * Per-row fold membership. `decisionPending` is the caller-resolved answer of
 * "is this session currently owed an owner verdict" (the list looks the row up
 * in its decision set once and hands the row a plain boolean, so memoized rows
 * compare cheap). Same precedence as isInAutonomousFold.
 */
export const isInAutonomousFoldWithDecision = (
  session: Pick<CoworkSessionSummary, 'autoOrigin' | 'foldOverride'>,
  decisionPending: boolean,
): boolean => {
  if (session.foldOverride === 'in') return true;
  if (session.foldOverride === 'out') return false;
  if (decisionPending) return false;
  return shouldFoldIntoAutonomousTasks(session);
};

/**
 * Fold MEMBERSHIP: a manual placement wins over the policy — 'in' parks the row
 * in the fold whatever its origin, 'out' keeps an auto-created run in the main
 * list. With no manual placement (null/undefined, the state of every row that
 * the user never moved) the auto-origin policy decides.
 *
 * `decisionSessionIds` (optional) holds the sessions currently owed an owner
 * verdict — long-term sub-projects parked in waiting_owner. Those sessions are
 * the DECISION SURFACE: with no manual placement they leave the fold and show
 * on the main timeline (a verdict buried in the collapsed folder is how a
 * finished task nags for days). Derived live from the board, so the row folds
 * back the moment the verdict lands; a manual placement still wins over it.
 */
export const isInAutonomousFold = (
  session: Pick<CoworkSessionSummary, 'id' | 'autoOrigin' | 'foldOverride'>,
  decisionSessionIds?: ReadonlySet<string>,
): boolean => isInAutonomousFoldWithDecision(session, decisionSessionIds?.has(session.id) ?? false);

/**
 * Split sessions into the main list and the autonomous fold, preserving input
 * order in both halves (the caller owns ordering; this helper never re-sorts).
 */
export const splitSessionsByAutonomousFold = (
  sessions: readonly CoworkSessionSummary[],
  decisionSessionIds?: ReadonlySet<string>,
): SessionsByAutonomousFold => {
  const humanSessions: CoworkSessionSummary[] = [];
  const autoSessions: CoworkSessionSummary[] = [];
  for (const session of sessions) {
    (isInAutonomousFold(session, decisionSessionIds) ? autoSessions : humanSessions).push(session);
  }
  return { humanSessions, autoSessions };
};

/**
 * localStorage key remembering whether the fold is open. The fold is collapsed
 * by default (it is a folder of machine-started runs, not the user's
 * conversations), so only an explicit '1' opens it.
 *
 * The KEY NAME and its stored value are frozen at the pre-rename spelling
 * ('coworkAutoTasksExpanded'): it is deployed user state, and renaming it would
 * silently reset every install's fold preference back to collapsed.
 */
export const AUTO_TASKS_EXPANDED_STORAGE_KEY = 'coworkAutoTasksExpanded';

/** Parse the persisted fold preference; anything but '1' means collapsed. */
export const parseAutoTasksExpandedPreference = (stored: string | null): boolean => stored === '1';

/** Value to persist for the fold preference. */
export const serializeAutoTasksExpandedPreference = (expanded: boolean): string =>
  expanded ? '1' : '0';
