/**
 * Worker-delegation status row helpers.
 *
 * When the Studio session is idle but a delegated worker bot is still
 * running, the panel shows a status row at the reply position — same
 * visual language as AssistantActivityIndicator (avatar + breathing ring,
 * one status line, a muted second line). These pure helpers own the copy
 * and elapsed formatting so they unit-test without a DOM; the row
 * component (PanelDelegationStatusRow.tsx) owns the 30s elapsed tick and
 * the IPC-fed data never lives here.
 */

import { i18nService, type LanguageType } from '../../services/i18n';

/** One open delegation as returned by `cowork:studio:openDelegations`. */
export interface PanelOpenDelegation {
  attemptId: string;
  workerMetabotId: number;
  workerName?: string;
  workerAvatar?: string;
  workerSessionId?: string;
  title: string;
  /** Epoch ms (delegation start, queuedAt fallback). */
  startedAt: number;
}

/**
 * Elapsed label for the status line: zh "N 分钟" / "N 小时 M 分", en "Nm" /
 * "Nh Mm". Sub-minute waits read as one minute — the row only appears for
 * delegations old enough to poll anyway.
 */
export function formatPanelDelegationElapsed(elapsedMs: number, language: LanguageType): string {
  const totalMinutes = Math.max(1, Math.floor(Math.max(0, elapsedMs) / 60_000));
  if (totalMinutes < 60) {
    return i18nService.tIn(language, 'panelDelegationElapsedMinutes')
      .replace('{n}', String(totalMinutes));
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const key = minutes > 0 ? 'panelDelegationElapsedHours' : 'panelDelegationElapsedHoursOnly';
  return i18nService.tIn(language, key)
    .replace('{h}', String(hours))
    .replace('{m}', String(minutes));
}

export interface PanelDelegationStatusCopy {
  /** Line 1 — who is working on what (or how many workers when several). */
  line1: string;
  /** Line 2 — what happens when the work comes back. */
  line2: string;
  /** The delegation the avatar/label represents (earliest started). */
  primary: PanelOpenDelegation;
}

/**
 * Row copy for the open-delegation list. A single worker names its task and
 * elapsed time; several collapse to "{first} 等 n 位" / "{first} and n-1
 * more" — the per-worker detail would not fit the reply position.
 */
export function buildPanelDelegationStatusCopy(
  delegations: readonly PanelOpenDelegation[],
  twinName: string | null | undefined,
  language: LanguageType,
  nowMs: number,
): PanelDelegationStatusCopy | null {
  if (delegations.length === 0) return null;
  const sorted = [...delegations].sort((a, b) => a.startedAt - b.startedAt);
  const primary = sorted[0];
  const twin = (twinName ?? '').trim()
    || (language === 'zh' ? '你的 Twin' : 'your Twin');
  const workerName = (primary.workerName ?? '').trim()
    || (language === 'zh' ? '协作 Bot' : 'a teammate bot');
  const line1 = sorted.length === 1
    ? i18nService.tIn(language, 'panelDelegationWorkingOne')
        .replace('{worker}', workerName)
        .replace('{title}', primary.title)
        .replace('{elapsed}', formatPanelDelegationElapsed(nowMs - primary.startedAt, language))
    : i18nService.tIn(language, 'panelDelegationWorkingMany')
        .replace('{first}', workerName)
        .replace('{n}', String(sorted.length))
        .replace('{more}', String(sorted.length - 1));
  const line2 = i18nService.tIn(language, 'panelDelegationWorkingSecond')
    .replace('{twin}', twin);
  return { line1, line2, primary };
}
