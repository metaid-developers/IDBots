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
 * Sort cards within a column: inside `waiting_owner`, `[长期]` milestone
 * decisions surface first so strategic multi-day rulings are visually distinct
 * from 10-second standard confirmations; ties sort newest-first.
 */
export function sortColumnCards(
  column: LongTermColumn,
  cards: readonly LongTermTaskSummary[],
): LongTermTaskSummary[] {
  return [...cards].sort((a, b) => {
    if (column === 'waiting_owner') {
      const aLt = a.isLongTerm ? 1 : 0;
      const bLt = b.isLongTerm ? 1 : 0;
      if (aLt !== bLt) return bLt - aLt;
    }
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
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
