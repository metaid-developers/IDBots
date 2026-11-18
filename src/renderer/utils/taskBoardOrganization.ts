import type { LongTermColumn, LongTermTaskSummary } from '../types/longTermTask';

/**
 * Completed tasks newer than 48 hours stay directly visible in the Done column;
 * older completed tasks collapse into the expandable archive fold unless an
 * active search query matches them (owner ruling 2026-11-17: 48h window).
 */
export const DONE_RECENT_ARCHIVE_WINDOW_MS = 48 * 3_600_000;

export type TaskBoardTierFilter = 'all' | 'long_term' | 'standard';

export function filterTaskBoardCards(
  cards: readonly LongTermTaskSummary[],
  options?: {
    tier?: TaskBoardTierFilter;
    query?: string;
  },
): LongTermTaskSummary[] {
  const tier = options?.tier ?? 'all';
  const rawQuery = String(options?.query ?? '').trim().toLowerCase();
  const tokens = rawQuery ? rawQuery.split(/\s+/).filter(Boolean) : [];

  return cards.filter((card) => {
    if (tier === 'long_term' && !card.isLongTerm) return false;
    if (tier === 'standard' && card.isLongTerm) return false;
    if (tokens.length === 0) return true;
    const hay = [
      card.title,
      card.goal,
      card.parentTaskTitle ?? '',
      card.currentSubtaskTitle ?? '',
      card.currentProgressNote ?? '',
      card.currentWaitNote ?? '',
      ...card.participants.map((p) => p.name),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

/**
 * Sort cards within a column AND group child tasks (`parentTaskId`) directly
 * beneath their parent card when both sit in the same column.
 */
export function sortColumnCards(
  column: LongTermColumn,
  cards: readonly LongTermTaskSummary[],
): LongTermTaskSummary[] {
  const baseSorted = [...cards].sort((a, b) => {
    if (column === 'waiting_owner') {
      const aLt = a.isLongTerm ? 1 : 0;
      const bLt = b.isLongTerm ? 1 : 0;
      if (aLt !== bLt) return bLt - aLt;
    }
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });

  const inColIds = new Set(baseSorted.map((c) => c.id));
  const childrenByParent = new Map<string, LongTermTaskSummary[]>();
  const roots: LongTermTaskSummary[] = [];
  for (const card of baseSorted) {
    if (card.parentTaskId && inColIds.has(card.parentTaskId)) {
      const list = childrenByParent.get(card.parentTaskId) ?? [];
      list.push(card);
      childrenByParent.set(card.parentTaskId, list);
    } else {
      roots.push(card);
    }
  }

  const ordered: LongTermTaskSummary[] = [];
  for (const root of roots) {
    ordered.push(root);
    const kids = childrenByParent.get(root.id);
    if (kids) {
      ordered.push(...kids);
    }
  }
  return ordered;
}

/**
 * Split `done` column cards into recent (<= 48h) vs older (> 48h archived).
 */
export function partitionDoneArchiveCards(
  doneCards: readonly LongTermTaskSummary[],
  nowMs: number = Date.now(),
  recentWindowMs: number = DONE_RECENT_ARCHIVE_WINDOW_MS,
): {
  recentDone: LongTermTaskSummary[];
  archivedDone: LongTermTaskSummary[];
} {
  const recentDone: LongTermTaskSummary[] = [];
  const archivedDone: LongTermTaskSummary[] = [];
  for (const card of doneCards) {
    const anchorIso = card.doneAt || card.updatedAt || card.createdAt;
    const ts = Date.parse(anchorIso);
    if (!Number.isFinite(ts) || nowMs - ts <= recentWindowMs) {
      recentDone.push(card);
    } else {
      archivedDone.push(card);
    }
  }
  return { recentDone, archivedDone };
}
