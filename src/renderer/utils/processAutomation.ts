/**
 * Process Hub v6 — 自主进程's two automation sources (owner requirement
 * 2026-11-24 17:23): bot 夜间做梦 (dream) and AI 冲浪 (surf) are first-class
 * DISPLAY items of the 自主 entry.
 *
 * No new channel: both sources already have their own run rows and their own
 * read IPC (`dream:listRuns` / `surf:listRuns`), and surf runs additionally
 * have real cowork sessions (hidden from the session list). This module only
 * PROJECTS those existing rows onto the SAME run semantics the scheduled and
 * long-term rows use — statusKind live/dead, error flag, relative time — so the
 * hub can render them with one visual language.
 *
 * PURE (no React / electron / i18n imports) so it is unit-testable with tsx.
 */

import type { ProcessStatusKind } from './processCenter';

/** The two automation sources that ride inside 自主. */
export type ProcessAutomationSource = 'dream' | 'surf';

/** The sliver of `DreamRun` this projection needs (main-process shape). */
export interface ProcessDreamRunLike {
  id: string;
  metabotId: number;
  dreamDate: string;
  status: 'running' | 'completed' | 'failed' | 'terminal-failed';
  error?: string | null;
  startedAt: number;
  completedAt?: number | null;
}

/** The sliver of `MetawebSurfRunInfo` this projection needs. */
export interface ProcessSurfRunLike {
  id: string;
  metabotId: number;
  trigger?: string | null;
  status: 'running' | 'done' | 'failed';
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

/** One projected automation run, shaped like a process run row. */
export interface ProcessAutomationEntry {
  /** Stable render key: `dream:<id>` / `surf:<id>`. */
  key: string;
  source: ProcessAutomationSource;
  runId: string;
  metabotId: number;
  /** Human date/detail shown on the row (dream date, surf trigger). */
  detail: string | null;
  statusKind: ProcessStatusKind;
  error: boolean;
  startedAt: number;
  finishedAt: number | null;
  errorText: string | null;
}

const toMs = (value: string | number | null | undefined): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const DREAM_DETAIL = (run: ProcessDreamRunLike): string | null => {
  const date = String(run.dreamDate ?? '').trim();
  return date || null;
};

const SURF_DETAIL = (run: ProcessSurfRunLike): string | null => {
  const trigger = String(run.trigger ?? '').trim();
  return trigger || null;
};

/**
 * Dream run → entry. `running` is the only live state; `failed` and
 * `terminal-failed` both read red; everything else is a closed receipt.
 */
export const projectDreamRun = (run: ProcessDreamRunLike): ProcessAutomationEntry => ({
  key: `dream:${run.id}`,
  source: 'dream',
  runId: run.id,
  metabotId: run.metabotId,
  detail: DREAM_DETAIL(run),
  statusKind: run.status === 'running' ? 'live' : 'dead',
  error: run.status === 'failed' || run.status === 'terminal-failed',
  startedAt: toMs(run.startedAt),
  finishedAt: run.completedAt == null ? null : toMs(run.completedAt),
  errorText: (run.error ?? '').trim() || null,
});

/** Surf run → entry (`running` live; `failed` red). */
export const projectSurfRun = (run: ProcessSurfRunLike): ProcessAutomationEntry => ({
  key: `surf:${run.id}`,
  source: 'surf',
  runId: run.id,
  metabotId: run.metabotId,
  detail: SURF_DETAIL(run),
  statusKind: run.status === 'running' ? 'live' : 'dead',
  error: run.status === 'failed',
  startedAt: toMs(run.startedAt),
  finishedAt: run.finishedAt == null ? null : toMs(run.finishedAt),
  errorText: (run.error ?? '').trim() || null,
});

const NEWEST_FIRST = (a: ProcessAutomationEntry, b: ProcessAutomationEntry): number => {
  if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
  return a.key.localeCompare(b.key);
};

/** Both sources merged, live rows first then newest — the chip list's order. */
export const buildAutomationEntries = (
  dreamRuns: readonly ProcessDreamRunLike[] | null | undefined,
  surfRuns: readonly ProcessSurfRunLike[] | null | undefined,
): ProcessAutomationEntry[] => {
  const rows = [
    ...(dreamRuns ?? []).map(projectDreamRun),
    ...(surfRuns ?? []).map(projectSurfRun),
  ];
  return rows.sort((a, b) => {
    if (a.statusKind !== b.statusKind) return a.statusKind === 'live' ? -1 : 1;
    return NEWEST_FIRST(a, b);
  });
};

/** Filtrate one source (a chip); `null` = the 全部 chip. */
export const automationEntriesFor = (
  entries: readonly ProcessAutomationEntry[],
  source: ProcessAutomationSource | null,
): ProcessAutomationEntry[] => (source ? entries.filter((entry) => entry.source === source) : [...entries]);

/** Per-source run counts (the chip subtotals + the tab badge's automation half). */
export const automationRunCounts = (
  entries: readonly ProcessAutomationEntry[],
): Record<ProcessAutomationSource, number> => {
  const counts: Record<ProcessAutomationSource, number> = { dream: 0, surf: 0 };
  for (const entry of entries) counts[entry.source] += 1;
  return counts;
};
