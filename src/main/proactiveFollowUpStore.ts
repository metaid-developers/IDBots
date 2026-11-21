import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import type { StudioDecisionEvidence, StudioDecisionOption } from './studioDecisionQueueStore';

/**
 * Three-tier classification for first-class Follow-up Events (lighter than Managed Tasks):
 *  - 'inform': awareness/FYI only (already handled, auto-declined per policy, or notable external event).
 *  - 'light_decision': lightweight owner ruling executable in <= 1 turn.
 *  - 'task_proposal': multi-turn or multi-bot effort proposed for promotion to a Managed Task (`long_term_tasks`).
 */
export type FollowUpTier = 'inform' | 'light_decision' | 'task_proposal';

/**
 * Sub-classification for `tier === 'inform'` items:
 *  - 'handled': Twin or local Bot completed the request/action within delegated bounds.
 *  - 'declined': Twin or local Bot declined/refused an out-of-policy or unfavorable request and notifies the owner.
 *  - 'observed': notable external/world event observed without requiring owner approval.
 */
export type FollowUpInformOutcome = 'handled' | 'declined' | 'observed';

export type FollowUpSourceDomain =
  | 'a2a_chat'
  | 'worker_escalation'
  | 'commerce'
  | 'chain_world';

export type FollowUpReportingGranularity =
  | 'immediate'
  | 'hourly_digest'
  | 'daily_digest';

export type FollowUpStatus =
  | 'queued'
  | 'presenting'
  | 'delivered'
  | 'resolved'
  | 'promoted'
  | 'cancelled';

export interface ProactiveFollowUpItem {
  id: string;
  canonicalKey: string;
  twinMetabotId: number;
  tier: FollowUpTier;
  informOutcome: FollowUpInformOutcome | null;
  sourceDomain: FollowUpSourceDomain;
  reportingGranularity: FollowUpReportingGranularity;
  priority: number;
  localMetabotId: number | null;
  localMetabotName: string | null;
  peerGlobalMetaId: string | null;
  peerName: string | null;
  sourceSessionId: string | null;
  workerSessionId: string | null;
  orchestrationTaskId: string | null;
  promotedTaskId: string | null;
  originTwinSessionId: string | null;
  title: string;
  summary: string;
  question: string;
  options: StudioDecisionOption[];
  recommendation: string;
  nextStep: string;
  evidence: StudioDecisionEvidence[];
  sourceMarker: string | null;
  coalescedCount: number;
  status: FollowUpStatus;
  presentedSessionId: string | null;
  presentedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueProactiveFollowUpInput {
  canonicalKey?: string | null;
  twinMetabotId: number;
  tier: FollowUpTier;
  informOutcome?: FollowUpInformOutcome | null;
  sourceDomain?: FollowUpSourceDomain;
  reportingGranularity?: FollowUpReportingGranularity;
  priority?: number;
  localMetabotId?: number | null;
  localMetabotName?: string | null;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  sourceSessionId?: string | null;
  workerSessionId?: string | null;
  orchestrationTaskId?: string | null;
  originTwinSessionId?: string | null;
  title: string;
  summary: string;
  question?: string;
  options?: StudioDecisionOption[];
  recommendation?: string;
  nextStep?: string;
  evidence?: StudioDecisionEvidence[];
  sourceMarker?: string | null;
}

export interface EnqueueProactiveFollowUpResult {
  item: ProactiveFollowUpItem | null;
  reused: boolean;
  skippedReason?: 'settled' | 'duplicate_marker';
}

export type ProactiveFollowUpListener = (event: {
  twinMetabotId: number;
  reason: string;
  itemId: string;
}) => void;

const VALID_TIERS = new Set<FollowUpTier>(['inform', 'light_decision', 'task_proposal']);
const VALID_INFORM_OUTCOMES = new Set<FollowUpInformOutcome>(['handled', 'declined', 'observed']);
const VALID_SOURCE_DOMAINS = new Set<FollowUpSourceDomain>([
  'a2a_chat',
  'worker_escalation',
  'commerce',
  'chain_world',
]);
const VALID_GRANULARITIES = new Set<FollowUpReportingGranularity>([
  'immediate',
  'hourly_digest',
  'daily_digest',
]);

const TIER_RANK: Record<FollowUpTier, number> = {
  inform: 1,
  light_decision: 2,
  task_proposal: 3,
};

const DEFAULT_PRIORITY_BY_TIER: Record<FollowUpTier, number> = {
  light_decision: 50,
  task_proposal: 70,
  inform: 100,
};

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

function asNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
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

const EXTRA_FOLLOW_UP_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'inform_outcome', ddl: 'TEXT' },
  { name: 'reporting_granularity', ddl: "TEXT NOT NULL DEFAULT 'immediate'" },
  { name: 'worker_session_id', ddl: 'TEXT' },
  { name: 'orchestration_task_id', ddl: 'TEXT' },
  { name: 'promoted_task_id', ddl: 'TEXT' },
  { name: 'source_marker', ddl: 'TEXT' },
  { name: 'coalesced_count', ddl: 'INTEGER NOT NULL DEFAULT 1' },
];

/**
 * Idempotent first-run & upgrade schema initializer for `proactive_follow_ups`
 * and `proactive_followup_settle_points`. Safe across existing SQLite user DBs.
 */
export function ensureProactiveFollowUpSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS proactive_follow_ups (
      id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL,
      twin_metabot_id INTEGER NOT NULL,
      tier TEXT NOT NULL DEFAULT 'inform',
      inform_outcome TEXT,
      source_domain TEXT NOT NULL DEFAULT 'a2a_chat',
      reporting_granularity TEXT NOT NULL DEFAULT 'immediate',
      priority INTEGER NOT NULL DEFAULT 100,
      local_metabot_id INTEGER,
      local_metabot_name TEXT,
      peer_global_metaid TEXT,
      peer_name TEXT,
      source_session_id TEXT,
      worker_session_id TEXT,
      orchestration_task_id TEXT,
      promoted_task_id TEXT,
      origin_twin_session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '[]',
      recommendation TEXT NOT NULL DEFAULT '',
      next_step TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      source_marker TEXT,
      coalesced_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      presented_session_id TEXT,
      presented_at TEXT,
      resolved_at TEXT,
      resolution_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    const info = db.exec('PRAGMA table_info(proactive_follow_ups)');
    const existingCols = new Set<string>(
      (info[0]?.values ?? []).map((row) => String(row[1] ?? '')),
    );
    for (const col of EXTRA_FOLLOW_UP_COLUMNS) {
      if (!existingCols.has(col.name)) {
        db.run(`ALTER TABLE proactive_follow_ups ADD COLUMN ${col.name} ${col.ddl}`);
      }
    }
  } catch {
    // Column inspection best-effort on minimal mocks.
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_proactive_follow_ups_twin_status
      ON proactive_follow_ups(twin_metabot_id, status, priority, created_at);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_proactive_follow_ups_canonical
      ON proactive_follow_ups(twin_metabot_id, canonical_key, status);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_proactive_follow_ups_source_session
      ON proactive_follow_ups(source_session_id, status);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS proactive_followup_settle_points (
      twin_metabot_id INTEGER NOT NULL,
      canonical_key TEXT NOT NULL,
      settled_marker TEXT NOT NULL DEFAULT '',
      settled_until_ms INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (twin_metabot_id, canonical_key)
    );
  `);
}

export class ProactiveFollowUpStore {
  private readonly listeners = new Set<ProactiveFollowUpListener>();

  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    ensureProactiveFollowUpSchema(this.db);
  }

  onChange(listener: ProactiveFollowUpListener): () => void {
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

  private mapRow(row: Record<string, unknown>): ProactiveFollowUpItem {
    const rawTier = asString(row.tier) as FollowUpTier;
    const tier: FollowUpTier = VALID_TIERS.has(rawTier) ? rawTier : 'inform';
    const rawOutcome = asString(row.inform_outcome) as FollowUpInformOutcome;
    const informOutcome: FollowUpInformOutcome | null =
      tier === 'inform'
        ? (VALID_INFORM_OUTCOMES.has(rawOutcome) ? rawOutcome : 'handled')
        : (VALID_INFORM_OUTCOMES.has(rawOutcome) ? rawOutcome : null);
    const rawDomain = asString(row.source_domain) as FollowUpSourceDomain;
    const sourceDomain: FollowUpSourceDomain = VALID_SOURCE_DOMAINS.has(rawDomain)
      ? rawDomain
      : 'a2a_chat';
    const rawGranularity = asString(row.reporting_granularity) as FollowUpReportingGranularity;
    const reportingGranularity: FollowUpReportingGranularity = VALID_GRANULARITIES.has(rawGranularity)
      ? rawGranularity
      : 'immediate';

    return {
      id: String(row.id ?? ''),
      canonicalKey: String(row.canonical_key ?? ''),
      twinMetabotId: Number(row.twin_metabot_id ?? 0),
      tier,
      informOutcome,
      sourceDomain,
      reportingGranularity,
      priority: Number.isFinite(Number(row.priority))
        ? Math.trunc(Number(row.priority))
        : DEFAULT_PRIORITY_BY_TIER[tier],
      localMetabotId: asNullableInt(row.local_metabot_id),
      localMetabotName: asNullableString(row.local_metabot_name),
      peerGlobalMetaId: asNullableString(row.peer_global_metaid),
      peerName: asNullableString(row.peer_name),
      sourceSessionId: asNullableString(row.source_session_id),
      workerSessionId: asNullableString(row.worker_session_id),
      orchestrationTaskId: asNullableString(row.orchestration_task_id),
      promotedTaskId: asNullableString(row.promoted_task_id),
      originTwinSessionId: asNullableString(row.origin_twin_session_id),
      title: String(row.title ?? ''),
      summary: String(row.summary ?? ''),
      question: String(row.question ?? ''),
      options: parseJsonArray<StudioDecisionOption>(row.options_json),
      recommendation: String(row.recommendation ?? ''),
      nextStep: String(row.next_step ?? ''),
      evidence: parseJsonArray<StudioDecisionEvidence>(row.evidence_json),
      sourceMarker: asNullableString(row.source_marker),
      coalescedCount: Math.max(1, Number(row.coalesced_count ?? 1) || 1),
      status: (asString(row.status) || 'queued') as FollowUpStatus,
      presentedSessionId: asNullableString(row.presented_session_id),
      presentedAt: asNullableString(row.presented_at),
      resolvedAt: asNullableString(row.resolved_at),
      resolutionNote: asNullableString(row.resolution_note),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  getById(id: string): ProactiveFollowUpItem | null {
    const trimmed = asString(id);
    if (!trimmed) return null;
    const rows = this.queryAll('SELECT * FROM proactive_follow_ups WHERE id = ? LIMIT 1', [trimmed]);
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  getPresenting(twinMetabotId: number): ProactiveFollowUpItem | null {
    const rows = this.queryAll(
      `SELECT * FROM proactive_follow_ups
        WHERE twin_metabot_id = ? AND status = 'presenting'
        ORDER BY updated_at DESC, created_at ASC
        LIMIT 1`,
      [twinMetabotId],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  listOpen(twinMetabotId?: number | null): ProactiveFollowUpItem[] {
    const hasTwin = typeof twinMetabotId === 'number' && Number.isInteger(twinMetabotId) && twinMetabotId > 0;
    const rows = hasTwin
      ? this.queryAll(
          `SELECT * FROM proactive_follow_ups
            WHERE twin_metabot_id = ? AND status IN ('presenting', 'queued')
            ORDER BY CASE WHEN status = 'presenting' THEN 0 ELSE 1 END ASC,
                     priority ASC,
                     created_at ASC`,
          [twinMetabotId],
        )
      : this.queryAll(
          `SELECT * FROM proactive_follow_ups
            WHERE status IN ('presenting', 'queued')
            ORDER BY CASE WHEN status = 'presenting' THEN 0 ELSE 1 END ASC,
                     priority ASC,
                     created_at ASC`,
        );
    return rows.map((row) => this.mapRow(row));
  }

  listQueuedImmediate(twinMetabotId: number): ProactiveFollowUpItem[] {
    const rows = this.queryAll(
      `SELECT * FROM proactive_follow_ups
        WHERE twin_metabot_id = ?
          AND status = 'queued'
          AND reporting_granularity = 'immediate'
        ORDER BY priority ASC, created_at ASC`,
      [twinMetabotId],
    );
    return rows.map((row) => this.mapRow(row));
  }

  listRecentlyDeliveredOrResolved(
    twinMetabotId: number,
    withinMs: number = 30 * 60_000,
    nowMs: number = Date.now(),
    limit: number = 6,
  ): ProactiveFollowUpItem[] {
    const cutoffIso = new Date(nowMs - Math.max(0, withinMs)).toISOString();
    const rows = this.queryAll(
      `SELECT * FROM proactive_follow_ups
        WHERE twin_metabot_id = ?
          AND status IN ('delivered', 'resolved', 'promoted')
          AND updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT ?`,
      [twinMetabotId, cutoffIso, Math.max(1, Math.trunc(limit))],
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Anti-self-excitation invariant ("Settle Point"):
   * Records that the Twin itself just steered, answered, or closed `canonicalKey`
   * so outgoing turns / echoes caused by that ruling do not immediately wake a
   * duplicate FollowUpEvent unless a brand-new external marker arrives after
   * the settle window or with a distinct inbound marker.
   */
  recordSettlePoint(input: {
    twinMetabotId: number;
    canonicalKey: string;
    settledMarker?: string | null;
    settleWindowMs?: number;
    reason?: string;
    nowMs?: number;
  }): void {
    const key = asString(input.canonicalKey);
    if (!key) return;
    const nowMs = input.nowMs ?? Date.now();
    const untilMs = nowMs + Math.max(0, input.settleWindowMs ?? 0);
    const updatedAt = new Date(nowMs).toISOString();
    this.db.run(
      `INSERT INTO proactive_followup_settle_points (
        twin_metabot_id, canonical_key, settled_marker, settled_until_ms, reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(twin_metabot_id, canonical_key) DO UPDATE SET
        settled_marker = excluded.settled_marker,
        settled_until_ms = excluded.settled_until_ms,
        reason = excluded.reason,
        updated_at = excluded.updated_at`,
      [
        input.twinMetabotId,
        key,
        asString(input.settledMarker),
        untilMs,
        asString(input.reason),
        updatedAt,
      ],
    );
    this.saveDb();
  }

  isBlockedBySettlePoint(input: {
    twinMetabotId: number;
    canonicalKey: string;
    sourceMarker?: string | null;
    nowMs?: number;
  }): boolean {
    const key = asString(input.canonicalKey);
    if (!key) return false;
    const rows = this.queryAll(
      `SELECT settled_marker, settled_until_ms
         FROM proactive_followup_settle_points
        WHERE twin_metabot_id = ? AND canonical_key = ?
        LIMIT 1`,
      [input.twinMetabotId, key],
    );
    if (!rows[0]) return false;
    const settledMarker = asString(rows[0].settled_marker);
    const incomingMarker = asString(input.sourceMarker);
    if (settledMarker && incomingMarker && settledMarker === incomingMarker) {
      return true;
    }
    const untilMs = Number(rows[0].settled_until_ms ?? 0);
    const nowMs = input.nowMs ?? Date.now();
    if (untilMs > nowMs && (!settledMarker || !incomingMarker || incomingMarker === settledMarker)) {
      return true;
    }
    return false;
  }

  enqueue(
    input: EnqueueProactiveFollowUpInput,
    options?: { nowMs?: number; bypassSettlePoint?: boolean },
  ): EnqueueProactiveFollowUpResult {
    const nowMs = options?.nowMs ?? Date.now();
    const atIso = new Date(nowMs).toISOString();
    const tier: FollowUpTier = VALID_TIERS.has(input.tier) ? input.tier : 'inform';
    const informOutcome: FollowUpInformOutcome | null =
      tier === 'inform'
        ? (input.informOutcome && VALID_INFORM_OUTCOMES.has(input.informOutcome)
            ? input.informOutcome
            : 'handled')
        : (input.informOutcome && VALID_INFORM_OUTCOMES.has(input.informOutcome)
            ? input.informOutcome
            : null);
    const sourceDomain: FollowUpSourceDomain =
      input.sourceDomain && VALID_SOURCE_DOMAINS.has(input.sourceDomain)
        ? input.sourceDomain
        : 'a2a_chat';
    const reportingGranularity: FollowUpReportingGranularity =
      input.reportingGranularity && VALID_GRANULARITIES.has(input.reportingGranularity)
        ? input.reportingGranularity
        : 'immediate';
    const title = asString(input.title) || 'World follow-up event';
    const summary = asString(input.summary) || title;
    const question = asString(input.question);
    const defaultCanonicalKey = [
      sourceDomain,
      asString(input.orchestrationTaskId)
        || asString(input.sourceSessionId)
        || asString(input.peerGlobalMetaId)
        || 'adhoc',
    ].join(':');
    const canonicalKey = asString(input.canonicalKey) || defaultCanonicalKey;
    const sourceMarker = asNullableString(input.sourceMarker);

    if (
      !options?.bypassSettlePoint
      && this.isBlockedBySettlePoint({
        twinMetabotId: input.twinMetabotId,
        canonicalKey,
        sourceMarker,
        nowMs,
      })
    ) {
      return { item: null, reused: false, skippedReason: 'settled' };
    }

    if (sourceMarker) {
      const closedDup = this.queryAll(
        `SELECT id FROM proactive_follow_ups
          WHERE twin_metabot_id = ?
            AND canonical_key = ?
            AND source_marker = ?
            AND status IN ('delivered', 'resolved', 'promoted')
          LIMIT 1`,
        [input.twinMetabotId, canonicalKey, sourceMarker],
      );
      if (closedDup[0]) {
        return { item: null, reused: false, skippedReason: 'duplicate_marker' };
      }
    }

    const incomingPriority = Number.isFinite(input.priority)
      ? Math.trunc(input.priority!)
      : DEFAULT_PRIORITY_BY_TIER[tier];
    const optionsJson = JSON.stringify(Array.isArray(input.options) ? input.options : []);
    const evidenceJson = JSON.stringify(Array.isArray(input.evidence) ? input.evidence : []);

    const existingRows = this.queryAll(
      `SELECT * FROM proactive_follow_ups
        WHERE twin_metabot_id = ?
          AND canonical_key = ?
          AND status IN ('queued', 'presenting')
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.twinMetabotId, canonicalKey],
    );

    if (existingRows[0]) {
      const existing = this.mapRow(existingRows[0]);
      const mergedTier: FollowUpTier =
        TIER_RANK[tier] >= TIER_RANK[existing.tier] ? tier : existing.tier;
      const mergedInformOutcome =
        mergedTier === 'inform'
          ? (informOutcome ?? existing.informOutcome ?? 'handled')
          : null;
      const mergedPriority = Math.min(existing.priority, incomingPriority);
      const nextCount = existing.coalescedCount + 1;

      this.db.run(
        `UPDATE proactive_follow_ups
            SET tier = ?,
                inform_outcome = ?,
                source_domain = ?,
                reporting_granularity = ?,
                priority = ?,
                local_metabot_id = COALESCE(?, local_metabot_id),
                local_metabot_name = COALESCE(?, local_metabot_name),
                peer_global_metaid = COALESCE(?, peer_global_metaid),
                peer_name = COALESCE(?, peer_name),
                source_session_id = COALESCE(?, source_session_id),
                worker_session_id = COALESCE(?, worker_session_id),
                orchestration_task_id = COALESCE(?, orchestration_task_id),
                origin_twin_session_id = COALESCE(?, origin_twin_session_id),
                title = ?,
                summary = ?,
                question = CASE WHEN ? != '' THEN ? ELSE question END,
                options_json = CASE WHEN ? != '[]' THEN ? ELSE options_json END,
                recommendation = CASE WHEN ? != '' THEN ? ELSE recommendation END,
                next_step = CASE WHEN ? != '' THEN ? ELSE next_step END,
                evidence_json = CASE WHEN ? != '[]' THEN ? ELSE evidence_json END,
                source_marker = COALESCE(?, source_marker),
                coalesced_count = ?,
                updated_at = ?
          WHERE id = ?`,
        [
          mergedTier,
          mergedInformOutcome,
          sourceDomain,
          reportingGranularity,
          mergedPriority,
          input.localMetabotId ?? null,
          asNullableString(input.localMetabotName),
          asNullableString(input.peerGlobalMetaId),
          asNullableString(input.peerName),
          asNullableString(input.sourceSessionId),
          asNullableString(input.workerSessionId),
          asNullableString(input.orchestrationTaskId),
          asNullableString(input.originTwinSessionId),
          title,
          summary,
          question,
          question,
          optionsJson,
          optionsJson,
          asString(input.recommendation),
          asString(input.recommendation),
          asString(input.nextStep),
          asString(input.nextStep),
          evidenceJson,
          evidenceJson,
          sourceMarker,
          nextCount,
          atIso,
          existing.id,
        ],
      );
      this.saveDb();
      const updated = this.getById(existing.id) ?? existing;
      this.emitChange(input.twinMetabotId, 'coalesced', updated.id);
      return { item: updated, reused: true };
    }

    const id = `pfu_${uuidv4()}`;
    this.db.run(
      `INSERT INTO proactive_follow_ups (
        id, canonical_key, twin_metabot_id, tier, inform_outcome,
        source_domain, reporting_granularity, priority,
        local_metabot_id, local_metabot_name, peer_global_metaid, peer_name,
        source_session_id, worker_session_id, orchestration_task_id, origin_twin_session_id,
        title, summary, question, options_json, recommendation, next_step,
        evidence_json, source_marker, coalesced_count, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?)`,
      [
        id,
        canonicalKey,
        input.twinMetabotId,
        tier,
        informOutcome,
        sourceDomain,
        reportingGranularity,
        incomingPriority,
        input.localMetabotId ?? null,
        asNullableString(input.localMetabotName),
        asNullableString(input.peerGlobalMetaId),
        asNullableString(input.peerName),
        asNullableString(input.sourceSessionId),
        asNullableString(input.workerSessionId),
        asNullableString(input.orchestrationTaskId),
        asNullableString(input.originTwinSessionId),
        title,
        summary,
        question,
        optionsJson,
        asString(input.recommendation),
        asString(input.nextStep),
        evidenceJson,
        sourceMarker,
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
  ): ProactiveFollowUpItem | null {
    const activePresenting = this.getPresenting(twinMetabotId);
    if (activePresenting) return null;
    const nextRows = this.queryAll(
      `SELECT * FROM proactive_follow_ups
        WHERE twin_metabot_id = ?
          AND status = 'queued'
          AND reporting_granularity = 'immediate'
        ORDER BY priority ASC, created_at ASC
        LIMIT 1`,
      [twinMetabotId],
    );
    if (!nextRows[0]) return null;
    const next = this.mapRow(nextRows[0]);
    this.db.run(
      `UPDATE proactive_follow_ups
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

  deferPresenting(
    idOrTwinMetabotId: string | number,
    atIso: string = nowIso(),
  ): ProactiveFollowUpItem | null {
    const target = typeof idOrTwinMetabotId === 'number'
      ? this.getPresenting(idOrTwinMetabotId)
      : this.getById(idOrTwinMetabotId);
    if (!target || target.status !== 'presenting') return null;
    const frontPriority = Math.min(0, target.priority - 1);
    this.db.run(
      `UPDATE proactive_follow_ups
          SET status = 'queued',
              priority = ?,
              updated_at = ?
        WHERE id = ? AND status = 'presenting'`,
      [frontPriority, atIso, target.id],
    );
    this.saveDb();
    const updated = this.getById(target.id);
    if (updated) {
      this.emitChange(updated.twinMetabotId, 'deferred', updated.id);
    }
    return updated;
  }

  markDelivered(
    id: string,
    note: string = 'delivered in Twin conversation',
    atIso: string = nowIso(),
  ): ProactiveFollowUpItem | null {
    const existing = this.getById(id);
    if (!existing) return null;
    if (existing.status === 'delivered') return existing;
    this.db.run(
      `UPDATE proactive_follow_ups
          SET status = 'delivered',
              resolved_at = ?,
              resolution_note = ?,
              updated_at = ?
        WHERE id = ?`,
      [atIso, asString(note) || 'delivered', atIso, existing.id],
    );
    this.saveDb();
    if (existing.sourceMarker) {
      this.recordSettlePoint({
        twinMetabotId: existing.twinMetabotId,
        canonicalKey: existing.canonicalKey,
        settledMarker: existing.sourceMarker,
        settleWindowMs: 15_000,
        reason: 'inform_delivered',
        nowMs: Date.parse(atIso) || Date.now(),
      });
    }
    const updated = this.getById(existing.id);
    if (updated) {
      this.emitChange(updated.twinMetabotId, 'delivered', updated.id);
    }
    return updated;
  }

  resolve(
    id: string,
    resolutionNote: string,
    options?: {
      settledMarker?: string | null;
      settleWindowMs?: number;
      atIso?: string;
    },
  ): ProactiveFollowUpItem | null {
    const existing = this.getById(id);
    if (!existing) return null;
    if (existing.status === 'resolved' || existing.status === 'promoted') return existing;
    const atIso = options?.atIso ?? nowIso();
    this.db.run(
      `UPDATE proactive_follow_ups
          SET status = 'resolved',
              resolved_at = ?,
              resolution_note = ?,
              updated_at = ?
        WHERE id = ?`,
      [atIso, asString(resolutionNote) || 'resolved by owner', atIso, existing.id],
    );
    this.saveDb();
    this.recordSettlePoint({
      twinMetabotId: existing.twinMetabotId,
      canonicalKey: existing.canonicalKey,
      settledMarker: options?.settledMarker ?? existing.sourceMarker,
      settleWindowMs: options?.settleWindowMs ?? 60_000,
      reason: 'owner_resolved',
      nowMs: Date.parse(atIso) || Date.now(),
    });
    const updated = this.getById(existing.id);
    if (updated) {
      this.emitChange(updated.twinMetabotId, 'resolved', updated.id);
    }
    return updated;
  }

  markPromotedToTask(
    id: string,
    promotedTaskId: string,
    resolutionNote: string = 'promoted to Managed Task',
    atIso: string = nowIso(),
  ): ProactiveFollowUpItem | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const taskId = asString(promotedTaskId);
    if (!taskId) return null;
    this.db.run(
      `UPDATE proactive_follow_ups
          SET status = 'promoted',
              promoted_task_id = ?,
              resolved_at = ?,
              resolution_note = ?,
              updated_at = ?
        WHERE id = ?`,
      [taskId, atIso, asString(resolutionNote) || `promoted to ${taskId}`, atIso, existing.id],
    );
    this.saveDb();
    this.recordSettlePoint({
      twinMetabotId: existing.twinMetabotId,
      canonicalKey: existing.canonicalKey,
      settledMarker: existing.sourceMarker,
      settleWindowMs: 60_000,
      reason: `promoted_to_task:${taskId}`,
      nowMs: Date.parse(atIso) || Date.now(),
    });
    const updated = this.getById(existing.id);
    if (updated) {
      this.emitChange(updated.twinMetabotId, 'promoted', updated.id);
    }
    return updated;
  }

  cancel(
    id: string,
    reason: string = 'cancelled',
    atIso: string = nowIso(),
  ): ProactiveFollowUpItem | null {
    const existing = this.getById(id);
    if (!existing) return null;
    if (existing.status === 'cancelled' || existing.status === 'resolved' || existing.status === 'promoted') {
      return existing;
    }
    this.db.run(
      `UPDATE proactive_follow_ups
          SET status = 'cancelled',
              resolved_at = ?,
              resolution_note = ?,
              updated_at = ?
        WHERE id = ?`,
      [atIso, asString(reason), atIso, existing.id],
    );
    this.saveDb();
    const updated = this.getById(existing.id);
    if (updated) {
      this.emitChange(updated.twinMetabotId, 'cancelled', updated.id);
    }
    return updated;
  }
}
