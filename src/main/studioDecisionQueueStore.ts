import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';

export type StudioDecisionKind =
  | 'decision'
  | 'acceptance'
  | 'hiring'
  | 'stamp_publish'
  | 'blocker';

export type StudioDecisionStatus =
  | 'queued'
  | 'presenting'
  | 'resolved'
  | 'cancelled';

export interface StudioDecisionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface StudioDecisionEvidence {
  /** `dir` / `file` are local absolute paths (directory / single file). */
  kind: 'dir' | 'file' | 'metaapp' | 'pin' | 'url' | 'other';
  uri: string;
  note?: string;
}

export interface StudioDecisionQueueItem {
  id: string;
  dedupeKey: string;
  twinMetabotId: number;
  originStudioSessionId: string | null;
  orchestrationTaskId: string | null;
  longtermTaskId: string | null;
  longtermSubtaskId: string | null;
  kind: StudioDecisionKind;
  priority: number;
  title: string;
  backgroundSummary: string;
  progressSummary: string;
  question: string;
  options: StudioDecisionOption[];
  recommendation: string;
  nextStep: string;
  reportHtmlPath: string | null;
  evidence: StudioDecisionEvidence[];
  status: StudioDecisionStatus;
  presentedSessionId: string | null;
  presentedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueStudioDecisionInput {
  dedupeKey?: string | null;
  twinMetabotId: number;
  originStudioSessionId?: string | null;
  orchestrationTaskId?: string | null;
  longtermTaskId?: string | null;
  longtermSubtaskId?: string | null;
  kind: StudioDecisionKind;
  priority?: number;
  title: string;
  backgroundSummary: string;
  progressSummary: string;
  question: string;
  options?: StudioDecisionOption[];
  recommendation: string;
  nextStep: string;
  reportHtmlPath?: string | null;
  evidence?: StudioDecisionEvidence[];
}

export type StudioDecisionQueueListener = (event: {
  twinMetabotId: number;
  reason: string;
  itemId: string;
}) => void;

const VALID_KINDS = new Set<StudioDecisionKind>([
  'decision',
  'acceptance',
  'hiring',
  'stamp_publish',
  'blocker',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNullableString(value: unknown): string | null {
  const trimmed = asString(value);
  return trimmed ? trimmed : null;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export class StudioDecisionQueueStore {
  private readonly listeners = new Set<StudioDecisionQueueListener>();

  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS studio_decision_queue (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL,
        twin_metabot_id INTEGER NOT NULL,
        origin_studio_session_id TEXT,
        orchestration_task_id TEXT,
        longterm_task_id TEXT,
        longterm_subtask_id TEXT,
        kind TEXT NOT NULL DEFAULT 'decision',
        priority INTEGER NOT NULL DEFAULT 100,
        title TEXT NOT NULL,
        background_summary TEXT NOT NULL DEFAULT '',
        progress_summary TEXT NOT NULL DEFAULT '',
        question TEXT NOT NULL DEFAULT '',
        options_json TEXT NOT NULL DEFAULT '[]',
        recommendation TEXT NOT NULL DEFAULT '',
        next_step TEXT NOT NULL DEFAULT '',
        report_html_path TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        presented_session_id TEXT,
        presented_at TEXT,
        resolved_at TEXT,
        resolution_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_studio_decision_queue_twin_status
        ON studio_decision_queue(twin_metabot_id, status, priority, created_at);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_studio_decision_queue_dedupe
        ON studio_decision_queue(twin_metabot_id, dedupe_key, status);
    `);
  }

  onChange(listener: StudioDecisionQueueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(twinMetabotId: number, reason: string, itemId: string): void {
    for (const listener of this.listeners) {
      try {
        listener({ twinMetabotId, reason, itemId });
      } catch {
        // Listener errors must never interrupt queue persistence.
      }
    }
  }

  private queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const result = this.db.exec(sql, params);
    if (!result[0]) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const record: Record<string, unknown> = {};
      columns.forEach((col, index) => {
        record[col] = row[index];
      });
      return record;
    });
  }

  private mapRow(row: Record<string, unknown>): StudioDecisionQueueItem {
    const rawKind = asString(row.kind) as StudioDecisionKind;
    const kind: StudioDecisionKind = VALID_KINDS.has(rawKind) ? rawKind : 'decision';
    return {
      id: String(row.id ?? ''),
      dedupeKey: String(row.dedupe_key ?? ''),
      twinMetabotId: Number(row.twin_metabot_id ?? 0),
      originStudioSessionId: asNullableString(row.origin_studio_session_id),
      orchestrationTaskId: asNullableString(row.orchestration_task_id),
      longtermTaskId: asNullableString(row.longterm_task_id),
      longtermSubtaskId: asNullableString(row.longterm_subtask_id),
      kind,
      priority: Number.isFinite(Number(row.priority)) ? Math.trunc(Number(row.priority)) : 100,
      title: String(row.title ?? ''),
      backgroundSummary: String(row.background_summary ?? ''),
      progressSummary: String(row.progress_summary ?? ''),
      question: String(row.question ?? ''),
      options: parseJsonArray<StudioDecisionOption>(row.options_json),
      recommendation: String(row.recommendation ?? ''),
      nextStep: String(row.next_step ?? ''),
      reportHtmlPath: asNullableString(row.report_html_path),
      evidence: parseJsonArray<StudioDecisionEvidence>(row.evidence_json),
      status: (asString(row.status) || 'queued') as StudioDecisionStatus,
      presentedSessionId: asNullableString(row.presented_session_id),
      presentedAt: asNullableString(row.presented_at),
      resolvedAt: asNullableString(row.resolved_at),
      resolutionNote: asNullableString(row.resolution_note),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  getById(id: string): StudioDecisionQueueItem | null {
    const trimmed = asString(id);
    if (!trimmed) return null;
    const rows = this.queryAll('SELECT * FROM studio_decision_queue WHERE id = ? LIMIT 1', [trimmed]);
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  getPresenting(twinMetabotId: number): StudioDecisionQueueItem | null {
    const rows = this.queryAll(
      `SELECT * FROM studio_decision_queue
        WHERE twin_metabot_id = ? AND status = 'presenting'
        ORDER BY updated_at DESC, created_at ASC
        LIMIT 1`,
      [twinMetabotId],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  listOpen(twinMetabotId?: number | null): StudioDecisionQueueItem[] {
    const hasTwin = typeof twinMetabotId === 'number' && Number.isInteger(twinMetabotId) && twinMetabotId > 0;
    const rows = hasTwin
      ? this.queryAll(
          `SELECT * FROM studio_decision_queue
            WHERE twin_metabot_id = ? AND status IN ('presenting', 'queued')
            ORDER BY CASE WHEN status = 'presenting' THEN 0 ELSE 1 END ASC,
                     priority ASC,
                     created_at ASC`,
          [twinMetabotId],
        )
      : this.queryAll(
          `SELECT * FROM studio_decision_queue
            WHERE status IN ('presenting', 'queued')
            ORDER BY CASE WHEN status = 'presenting' THEN 0 ELSE 1 END ASC,
                     priority ASC,
                     created_at ASC`,
        );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * True when an item for `longtermTaskId` is already open (`queued` / `presenting`)
   * OR was created/updated within `recentWindowMs` — prevents store status
   * listeners from auto-enqueuing redundant fallback duplicates right after the
   * Twin already enqueued or resolved a richer briefing for the same task.
   */
  hasRecentOrOpenForTask(
    twinMetabotId: number,
    longtermTaskId: string,
    recentWindowMs: number = 30 * 60_000,
    nowMs: number = Date.now(),
  ): boolean {
    const taskId = asString(longtermTaskId);
    if (!taskId) return false;
    const cutoffIso = new Date(nowMs - Math.max(0, recentWindowMs)).toISOString();
    const rows = this.queryAll(
      `SELECT id FROM studio_decision_queue
        WHERE twin_metabot_id = ?
          AND longterm_task_id = ?
          AND (status IN ('queued', 'presenting') OR updated_at >= ?)
        LIMIT 1`,
      [twinMetabotId, taskId, cutoffIso],
    );
    return rows.length > 0;
  }

  cancelSiblingQueuedForTask(
    twinMetabotId: number,
    longtermTaskId: string | null,
    exceptId: string,
    reason: string = 'superseded by owner ruling',
    atIso: string = nowIso(),
  ): number {
    const taskId = asString(longtermTaskId);
    if (!taskId) return 0;
    const resolvedItem = this.getById(exceptId);
    // Only auto-cancel redundant status-listener fallback cards (`lt_status:...`)
    // or identical-dedupeKey duplicates — NEVER wipe an independent sibling
    // decision enqueued by back-office supervision on the same task (e.g. a
    // security-review merge ruling queued behind a cover-image pick).
    const siblings = this.queryAll(
      `SELECT id, dedupe_key FROM studio_decision_queue
        WHERE twin_metabot_id = ?
          AND longterm_task_id = ?
          AND id != ?
          AND status = 'queued'`,
      [twinMetabotId, taskId, asString(exceptId)],
    );
    let cancelled = 0;
    for (const row of siblings) {
      const siblingDedupe = asString(row.dedupe_key);
      const isAutoFallback = siblingDedupe.startsWith('lt_status:');
      const isSameDedupe = Boolean(resolvedItem?.dedupeKey && siblingDedupe === resolvedItem.dedupeKey);
      if (!isAutoFallback && !isSameDedupe) continue;
      this.cancel(String(row.id ?? ''), reason, atIso);
      cancelled += 1;
    }
    return cancelled;
  }

  enqueue(input: EnqueueStudioDecisionInput, atIso: string = nowIso()): {
    item: StudioDecisionQueueItem;
    reused: boolean;
  } {
    const title = asString(input.title) || 'Owner decision needed';
    const question = asString(input.question) || title;
    const kind: StudioDecisionKind = VALID_KINDS.has(input.kind) ? input.kind : 'decision';
    const defaultDedupe = [
      input.twinMetabotId,
      kind,
      asString(input.longtermTaskId) || asString(input.orchestrationTaskId) || 'adhoc',
      asString(input.longtermSubtaskId) || 'root',
      question.slice(0, 120),
    ].join(':');
    const dedupeKey = asString(input.dedupeKey) || defaultDedupe;
    const existingRows = this.queryAll(
      `SELECT * FROM studio_decision_queue
        WHERE twin_metabot_id = ? AND dedupe_key = ? AND status IN ('queued', 'presenting')
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.twinMetabotId, dedupeKey],
    );
    const optionsJson = JSON.stringify(Array.isArray(input.options) ? input.options : []);
    const evidenceJson = JSON.stringify(Array.isArray(input.evidence) ? input.evidence : []);
    const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority!) : 100;

    if (existingRows[0]) {
      const existing = this.mapRow(existingRows[0]);
      this.db.run(
        `UPDATE studio_decision_queue
            SET title = ?,
                background_summary = ?,
                progress_summary = ?,
                question = ?,
                options_json = ?,
                recommendation = ?,
                next_step = ?,
                report_html_path = COALESCE(?, report_html_path),
                evidence_json = ?,
                updated_at = ?
          WHERE id = ?`,
        [
          title,
          asString(input.backgroundSummary),
          asString(input.progressSummary),
          question,
          optionsJson,
          asString(input.recommendation),
          asString(input.nextStep),
          asNullableString(input.reportHtmlPath),
          evidenceJson,
          atIso,
          existing.id,
        ],
      );
      this.saveDb();
      const updated = this.getById(existing.id) ?? existing;
      this.emitChange(input.twinMetabotId, 'updated', updated.id);
      return { item: updated, reused: true };
    }

    const id = `sdq_${uuidv4()}`;
    this.db.run(
      `INSERT INTO studio_decision_queue (
        id, dedupe_key, twin_metabot_id, origin_studio_session_id,
        orchestration_task_id, longterm_task_id, longterm_subtask_id,
        kind, priority, title, background_summary, progress_summary,
        question, options_json, recommendation, next_step,
        report_html_path, evidence_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        id,
        dedupeKey,
        input.twinMetabotId,
        asNullableString(input.originStudioSessionId),
        asNullableString(input.orchestrationTaskId),
        asNullableString(input.longtermTaskId),
        asNullableString(input.longtermSubtaskId),
        kind,
        priority,
        title,
        asString(input.backgroundSummary),
        asString(input.progressSummary),
        question,
        optionsJson,
        asString(input.recommendation),
        asString(input.nextStep),
        asNullableString(input.reportHtmlPath),
        evidenceJson,
        atIso,
        atIso,
      ],
    );
    this.saveDb();
    const created = this.getById(id)!;
    this.emitChange(input.twinMetabotId, 'enqueued', created.id);
    return { item: created, reused: false };
  }

  claimNextForPresentation(
    twinMetabotId: number,
    presentedSessionId: string,
    atIso: string = nowIso(),
  ): StudioDecisionQueueItem | null {
    const targetSessionId = asString(presentedSessionId);
    const activePresenting = this.getPresenting(twinMetabotId);
    if (activePresenting) {
      const presentedInSession = asString(activePresenting.presentedSessionId);
      if (!targetSessionId || !presentedInSession || presentedInSession === targetSessionId) {
        return null;
      }
      // Cross-session stale lock: defer the older session's presenting item
      // back to `'queued'` so the current active Studio session can proceed.
      this.deferPresenting(activePresenting.id, atIso);
    }
    const nextRows = targetSessionId
      ? this.queryAll(
          `SELECT * FROM studio_decision_queue
            WHERE twin_metabot_id = ? AND status = 'queued'
            ORDER BY CASE WHEN origin_studio_session_id = ? THEN 0 ELSE 1 END ASC,
                     priority ASC,
                     created_at ASC
            LIMIT 1`,
          [twinMetabotId, targetSessionId],
        )
      : this.queryAll(
          `SELECT * FROM studio_decision_queue
            WHERE twin_metabot_id = ? AND status = 'queued'
            ORDER BY priority ASC, created_at ASC
            LIMIT 1`,
          [twinMetabotId],
        );
    if (!nextRows[0]) return null;
    const next = this.mapRow(nextRows[0]);
    this.db.run(
      `UPDATE studio_decision_queue
          SET status = 'presenting',
              presented_session_id = ?,
              presented_at = ?,
              updated_at = ?
        WHERE id = ? AND status = 'queued'`,
      [asString(presentedSessionId), atIso, atIso, next.id],
    );
    this.saveDb();
    const claimed = this.getById(next.id);
    if (claimed && claimed.status === 'presenting') {
      this.emitChange(twinMetabotId, 'presenting', claimed.id);
      return claimed;
    }
    return null;
  }

  /**
   * Owner preemption: when the owner interrupts an active briefing with a new
   * request/topic, return the presenting item to the front of the queue
   * (priority = 0) so the Twin enters 'shaping' cleanly and re-presents later.
   */
  deferPresenting(
    idOrTwinMetabotId: string | number,
    atIso: string = nowIso(),
  ): StudioDecisionQueueItem | null {
    const target = typeof idOrTwinMetabotId === 'number'
      ? this.getPresenting(idOrTwinMetabotId)
      : this.getById(idOrTwinMetabotId);
    if (!target || target.status !== 'presenting') return null;
    this.db.run(
      `UPDATE studio_decision_queue
          SET status = 'queued',
              priority = MIN(priority, 0),
              updated_at = ?
        WHERE id = ?`,
      [atIso, target.id],
    );
    this.saveDb();
    const deferred = this.getById(target.id);
    if (deferred) {
      this.emitChange(deferred.twinMetabotId, 'deferred', deferred.id);
    }
    return deferred;
  }

  resolve(
    id: string,
    resolutionNote: string,
    atIso: string = nowIso(),
  ): StudioDecisionQueueItem | null {
    const existing = this.getById(id);
    if (!existing) return null;
    if (existing.status === 'resolved' || existing.status === 'cancelled') {
      return existing;
    }
    this.db.run(
      `UPDATE studio_decision_queue
          SET status = 'resolved',
              resolved_at = ?,
              resolution_note = ?,
              updated_at = ?
        WHERE id = ?`,
      [atIso, asString(resolutionNote), atIso, existing.id],
    );
    this.saveDb();
    const resolved = this.getById(existing.id);
    if (resolved) {
      this.emitChange(resolved.twinMetabotId, 'resolved', resolved.id);
    }
    return resolved;
  }

  cancel(
    id: string,
    reason: string = 'cancelled',
    atIso: string = nowIso(),
  ): StudioDecisionQueueItem | null {
    const existing = this.getById(id);
    if (!existing) return null;
    if (existing.status === 'resolved' || existing.status === 'cancelled') {
      return existing;
    }
    this.db.run(
      `UPDATE studio_decision_queue
          SET status = 'cancelled',
              resolved_at = ?,
              resolution_note = ?,
              updated_at = ?
        WHERE id = ?`,
      [atIso, asString(reason), atIso, existing.id],
    );
    this.saveDb();
    const cancelled = this.getById(existing.id);
    if (cancelled) {
      this.emitChange(cancelled.twinMetabotId, 'cancelled', cancelled.id);
    }
    return cancelled;
  }
}
