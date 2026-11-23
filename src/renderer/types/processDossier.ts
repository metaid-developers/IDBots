/**
 * 进程详情 · 档案层 IPC payload types (design: process-detail-body-datasource,
 * Friday 2026-11-22, gaps N1–N4).
 *
 * These mirror the main-process handlers verbatim:
 *   - `processDossier:get`   → ProcessDossierSnapshot (N2: one read, one error surface)
 *   - `longtermTask:events`  → LongTermEvent[] (N3: the 200-row cap lifted to 500)
 *   - `metaweb:pinInfo`      → MetawebPinInfo   (N1: pin naming, wraps readMetawebPin)
 *
 * Read-only: nothing here writes, and nothing needs a migration.
 */

import type { LongTermEvent, LongTermTaskDetail } from './longTermTask';

/** One orchestration attempt, resolved for display (N2). */
export interface ProcessDossierAttempt {
  id: string;
  stepId: string;
  /** Orchestration step / task titles when the projection can resolve them. */
  stepTitle: string | null;
  taskTitle: string | null;
  workerMetabotId: number;
  workerName: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** One scheduled run, resolved for display (N2). */
export interface ProcessDossierRun {
  id: string;
  taskId: string;
  taskName: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: string;
  error: string | null;
}

/**
 * The archive snapshot for one process session. `task` is null for T2/T3/T4
 * (orchestration dispatch / scheduled run / no source) — the view then says so
 * instead of drawing an empty checklist.
 */
export interface ProcessDossierSnapshot {
  sessionId: string;
  task: LongTermTaskDetail | null;
  subtaskId: string | null;
  /** Newest first, capped at `eventLimit`. */
  events: LongTermEvent[];
  eventLimit: number;
  attempts: ProcessDossierAttempt[];
  runs: ProcessDossierRun[];
}

export interface ProcessDossierResult {
  success: boolean;
  dossier?: ProcessDossierSnapshot;
  error?: string;
}

/** N1: the pin fields the dossier names a chain anchor with. */
export interface MetawebPinInfo {
  pinId: string;
  currentPinId: string;
  protocol: string;
  path: string;
  chainName: string;
  title: string;
  summary: string;
  creatorName: string;
  /** Unix seconds. */
  createdAt: number;
}

export interface MetawebPinInfoResult {
  success: boolean;
  info?: MetawebPinInfo;
  /** Machine-readable cause: 'not_found' | 'unavailable' | 'bad_pin_id'. */
  code?: 'not_found' | 'unavailable' | 'bad_pin_id';
  error?: string;
}
