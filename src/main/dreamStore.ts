import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import { formatBotWorkspaceDate } from './libs/botWorkspace';
import type {
  PredictionActionType,
  PredictionCalibrationDigest,
  PredictionSource,
  PredictionStatus,
} from './libs/predictionLedger';
import {
  PREDICTION_ACTION_TYPES,
  PREDICTION_DIGEST_MAX_RECENT_MISSES,
  PREDICTION_SOURCE_CLASS,
  PREDICTION_SOURCES,
  PREDICTION_STATUSES,
} from './libs/predictionLedger';
import { ROLLBACK_MAX_SNAPSHOTS_PER_BOT } from './libs/promptLayerRollback';
import { queryHotLayerUsageStats, type HotLayerUsageStats } from './libs/hotLayerUsageQueries';

/**
 * Dream consolidation storage layer.
 *
 * Dream tables (created idempotently both here and in sqliteStore.initializeTables):
 * - metabot_daily_summaries: one row per bot per date with the dream-produced
 *   narrative of that day (overall + per-category sections).
 * - metabot_dream_runs: one row per bot per date tracking consolidation runs;
 *   the UNIQUE(metabot_id, dream_date) constraint is the idempotency anchor.
 * - metabot_predictions: the RSI P0 prediction ledger — explicit pre-action
 *   predictions the nightly dream reconciles against observed outcomes.
 * - metabot_prompt_layer_snapshots: the RSI P0 retention gate — one snapshot
 *   of the dream-origin prompt layer per (bot, dream date), captured before
 *   that night's writes so a negative-feedback spike can roll them back.
 *
 * Also owns the "what did this bot do on date D" activity query used to build
 * the dream prompt. Raw messages are returned untruncated; budgeting for the
 * prompt is the caller's concern (libs/dreamPrompt).
 */

/** terminal-failed = deterministic failure or exhausted retry budget: the
 * scheduler stops queueing the date; only a manual dream run revives it. */
export type DreamRunStatus = 'running' | 'completed' | 'failed' | 'terminal-failed';
export type DreamFragmentStatus = 'running' | 'completed' | 'failed';

export interface DreamRun {
  id: string;
  metabotId: number;
  dreamDate: string;
  status: DreamRunStatus;
  attemptCount: number;
  llmId: string | null;
  /** Algorithm version the run was made with; 0 = legacy, pre-versioning. */
  dreamVersion: number;
  error: string | null;
  /** P2 telemetry: estimated tokens, fragment/validation/replay counts, duration. */
  telemetry: Record<string, unknown> | null;
  startedAt: number;
  completedAt: number | null;
}

/**
 * Long-term telemetry rollup (audit P1): one flat row per bot per dream date
 * in metabot_dream_telemetry_daily. Trend-bearing metrics are queryable
 * columns; extraJson keeps the full-fidelity telemetry blob. Written at
 * updateRunTelemetry time so the 90-day raw-run purge never takes the
 * quarterly trend down with it — this table is never purged.
 */
export interface DreamTelemetryDaily {
  metabotId: number;
  dreamDate: string;
  emptyDay: boolean;
  fragmentCount: number | null;
  estimatedActivityTokens: number | null;
  outputChars: number | null;
  durationMs: number | null;
  implicitSignals: number | null;
  diaryTotalRefs: number | null;
  diaryUnmatchedRefs: number | null;
  validationChecked: number | null;
  validationValidated: number | null;
  validationRejected: number | null;
  replayPoints: number | null;
  replayLessons: number | null;
  capabilityValidatedDrafts: number | null;
  capabilityTotalInjections: number | null;
  capabilityActiveDraftsLast24h: number | null;
  promotedCount: number | null;
  reReviewed: number | null;
  demoted: number | null;
  dedupMerged: number | null;
  /** Any explicit human feedback that day (thumbs up/down, task acceptance rating). */
  hasExplicitFeedback: boolean;
  /** Full-fidelity telemetry blob (the same object telemetry_json stores). */
  extraJson: Record<string, unknown>;
  updatedAt: number;
}

/** One weekly "long dream" row — the cross-day thematic consolidation (P2b). */
export interface WeeklySummary {
  id: string;
  metabotId: number;
  /** Monday of the reviewed week, YYYY-MM-DD. */
  weekStart: string;
  /** Sunday of the reviewed week, YYYY-MM-DD. */
  weekEnd: string;
  summaryText: string;
  patterns: string[];
  llmId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DreamFragment {
  id: string;
  metabotId: number;
  dreamDate: string;
  fragmentKey: string;
  sessionId: string;
  chunkIndex: number;
  contentHash: string;
  sourceMessageCount: number;
  sourceCharCount: number;
  estimatedInputTokens: number;
  status: DreamFragmentStatus;
  summaryJson: string | null;
  llmId: string | null;
  dreamVersion: number;
  error: string | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface DailySummarySessionRef {
  sessionId: string;
  title: string;
  sessionType: string;
  isOrder: boolean;
}

/**
 * RSI P0 prediction ledger: one explicit, machine-checkable prediction made
 * BEFORE a consequential on-chain action. The nightly dream reconciles
 * 'pending' rows against observed outcomes (dreamService) and marks them
 * hit/miss/partial/expired; 'void' is reserved for manual invalidation.
 */
export interface MetabotPrediction {
  id: string;
  metabotId: number;
  createdAt: number;
  sessionId: string | null;
  source: PredictionSource;
  actionType: PredictionActionType;
  /** pinId / "rootPinId:node" / order id; null when resolvable only after the action. */
  subjectRef: string | null;
  predictionText: string;
  expectation: Record<string, unknown>;
  /** YYYY-MM-DD local date by which the outcome must be observable. */
  resolveDeadline: string;
  status: PredictionStatus;
  resolvedAt: number | null;
  resolvedBy: string | null;
  outcomeText: string | null;
  outcomeJson: Record<string, unknown> | null;
}

/** One snapshotted dream-origin memory row (prompt-layer state before a dream write). */
export interface PromptLayerSnapshotMemory {
  id: string;
  text: string;
  fingerprint: string;
  status: string;
  archivedAt: number | null;
  usageClass: string | null;
}

/**
 * What the prompt layer looked like immediately BEFORE one dream night's
 * writes: every non-deleted dream-origin user_memories row EXCEPT
 * self_identity (owner-frozen by design, never rolled back), plus the ids of
 * the then-active procedures previously promoted from capability drafts (the
 * rollback diff baseline).
 */
export interface PromptLayerSnapshotPayload {
  version: 1;
  memories: PromptLayerSnapshotMemory[];
  promotedProcedureIds: string[];
}

/** One row of metabot_prompt_layer_snapshots — one per (bot, dream date). */
export interface PromptLayerSnapshot {
  id: string;
  metabotId: number;
  dreamDate: string;
  createdAt: number;
  payload: PromptLayerSnapshotPayload;
  status: 'active' | 'rolled_back' | 'superseded';
  rollbackReason: string | null;
  rolledBackAt: number | null;
}

export interface DailySummary {
  id: string;
  metabotId: number;
  summaryDate: string;
  summaryText: string;
  sections: Record<string, string>;
  stats: Record<string, number>;
  /** Sessions that fed this summary — the index from a recalled day back to
   * the full conversations (read them via idbots_session_read_all). */
  sessionRefs: DailySummarySessionRef[];
  llmId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DreamActivityMessage {
  type: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** Human's per-message rating (thumbs up/down), when the message was rated. */
  feedbackRating?: 'up' | 'down';
  /** Human's free-text comment attached to the rating, when present. */
  feedbackComment?: string | null;
}

export interface DreamSessionActivity {
  sessionId: string;
  title: string;
  sessionType: string;
  peerName: string | null;
  isOrder: boolean;
  messages: DreamActivityMessage[];
}

export interface DreamTaskRunActivity {
  taskName: string;
  status: string;
  startedAt: number;
  sessionId: string | null;
}

/** accepted = closed/rated that day; active = still open with same-day activity. */
export type DreamGroupTaskPhase = 'accepted' | 'active';

/**
 * One group task the bot participated in that belongs on this day's review —
 * either owner acceptance (rating/review) or still-open work with same-day
 * activity (on-chain chat or a skill-turn session).
 */
export interface DreamGroupTaskEvaluation {
  taskId: number;
  title: string;
  goal: string;
  /** This bot's role in the task ('chair' | 'worker'). */
  memberRole: string;
  /** 1-5 stars; null when the task was closed without a rating (automation). */
  rating: number | null;
  ratingComment: string | null;
  /** Task status at query time. Optional on older fixtures. */
  status?: string;
  /** Defaults to 'accepted' when omitted so older fixtures keep working. */
  phase?: DreamGroupTaskPhase;
  /** Same-day on-chain group-chat message count, when known. */
  dayMessageCount?: number;
}

export interface DreamGroupChatMessage {
  senderName: string;
  senderGlobalMetaID: string | null;
  content: string;
  occurredAt: number;
}

/** One group-task's on-chain group chat for the local day. */
export interface DreamGroupChatActivity {
  taskId: number;
  title: string;
  groupId: string;
  taskStatus: string;
  memberRole: string;
  messages: DreamGroupChatMessage[];
}

/** A pin the bot itself broadcast to the chain that day (writes ledger). */
export interface DreamChainWriteActivity {
  pinId: string;
  path: string | null;
  operation: string | null;
  /** Async LLM gist when available; the prompt falls back to stored text. */
  summary: string | null;
  contentText: string | null;
  occurredAtMs: number;
}

/** A chain pin the bot fully read that day (reads ledger). */
export interface DreamChainReadActivity {
  pinId: string;
  path: string | null;
  protocol: string | null;
  title: string | null;
  authorGlobalMetaId: string | null;
  summary: string | null;
  contentExcerpt: string | null;
  savedToKb: boolean;
  lastReadAtMs: number;
}

/**
 * One buyer rating a chain-synced skill service owned by this bot received on
 * the dream date (remote_skill_service_rating_seen joined against
 * remote_skill_service provider identity). Ratings for other providers'
 * services never appear here.
 */
export interface DreamServiceRatingActivity {
  /** remote_skill_service row id (the service being rated). */
  serviceId: string;
  serviceName: string | null;
  /** The rating pin id — a stable on-chain anchor for the event. */
  ratingPinId: string;
  /** 1-5 stars. */
  rating: number | null;
  comment: string | null;
  /** Order payment tx when the rating pin carried one. */
  orderTxid: string | null;
  raterGlobalMetaId: string | null;
  raterMetaId: string | null;
  ratedAtMs: number;
}

/** Structural implicit-signal kinds (mechanical facts, no sentiment). */
export type DreamImplicitSignalKind = 'reask' | 'unanswered_burst' | 'repeat_order';

/**
 * One structural fact collected by the mechanical implicit-signal layer
 * (libs/implicitSignals.ts). Carries numbers, never a sentiment label — what
 * the fact means is the dreaming bot's call.
 */
export interface DreamImplicitSignal {
  kind: DreamImplicitSignalKind;
  sessionId: string | null;
  /** For reask: index of the SECOND user message (the restated one). */
  messageIndex?: number;
  /** Rendered fact with numbers — no sentiment label attached. */
  text: string;
}

export interface DreamDayActivity {
  sessions: DreamSessionActivity[];
  taskRuns: DreamTaskRunActivity[];
  /** service_orders rows created that day (raw order count, not sessions). */
  orderCount: number;
  /** Group tasks accepted or still active that day where this bot was a member. */
  groupTasks: DreamGroupTaskEvaluation[];
  /** On-chain group-chat transcripts for member tasks that had messages that day. */
  groupChats?: DreamGroupChatActivity[];
  /** Pins this bot published to the chain that day (chain content history). */
  chainWrites?: DreamChainWriteActivity[];
  /** Chain pins this bot fully read that day (chain content history). */
  chainReads?: DreamChainReadActivity[];
  /** Buyer ratings received that day on skill services this bot provides. */
  serviceRatings?: DreamServiceRatingActivity[];
  /** Structural implicit signals, attached by the dream service post-query. */
  implicitSignals?: DreamImplicitSignal[];
}

interface DreamRunRow {
  id: string;
  metabot_id: number | string;
  dream_date: string;
  status: string;
  attempt_count: number | string;
  llm_id: string | null;
  dream_version?: number | string | null;
  error: string | null;
  telemetry_json?: string | null;
  started_at: number | string;
  completed_at: number | string | null;
}

interface WeeklySummaryRow {
  id: string;
  metabot_id: number | string;
  week_start: string;
  week_end: string;
  summary_text: string;
  patterns_json: string | null;
  llm_id: string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface DreamFragmentRow {
  id: string;
  metabot_id: number | string;
  dream_date: string;
  fragment_key: string;
  session_id: string;
  chunk_index: number | string;
  content_hash: string;
  source_message_count: number | string;
  source_char_count: number | string;
  estimated_input_tokens: number | string;
  status: string;
  summary_json: string | null;
  llm_id: string | null;
  dream_version: number | string | null;
  error: string | null;
  attempt_count: number | string;
  created_at: number | string;
  updated_at: number | string;
}

interface DailySummaryRow {
  id: string;
  metabot_id: number | string;
  summary_date: string;
  summary_text: string;
  sections_json: string | null;
  stats_json: string | null;
  session_refs_json?: string | null;
  llm_id: string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface PredictionRow {
  id: string;
  metabot_id: number | string;
  created_at: number | string;
  session_id: string | null;
  source: string;
  action_type: string;
  subject_ref: string | null;
  prediction_text: string;
  expectation_json: string | null;
  resolve_deadline: string;
  status: string;
  resolved_at: number | string | null;
  resolved_by: string | null;
  outcome_text: string | null;
  outcome_json: string | null;
}

interface PromptLayerSnapshotRow {
  id: string;
  metabot_id: number | string;
  dream_date: string;
  created_at: number | string;
  payload_json: string | null;
  status: string;
  rollback_reason: string | null;
  rolled_back_at: number | string | null;
}

/** Bound one task's on-chain transcript so a busy group cannot flood the dream. */
const MAX_GROUP_CHAT_MESSAGES_PER_TASK = 400;
/** Bound each chain-content-history kind per day so a heavy bot cannot flood the dream. */
const MAX_CHAIN_CONTENT_ENTRIES_PER_KIND = 50;
/** Bound the buyer-rating section per day so a popular service cannot flood the dream. */
const MAX_SERVICE_RATINGS_PER_DAY = 10;

/**
 * Silent-drop counters for dream input assembly and output parsing (dream
 * review P0 2026-10-23). Every place that silently truncates or drops dream
 * input/output increments the matching counter; the dream run threads one
 * mutable instance through the activity query, prompt building and parsing,
 * surfaces it in the run telemetry (metabot_dream_telemetry_daily.extra_json
 * carries the whole telemetry blob) and console.warns when any counter is
 * non-zero. All fields are plain overflow counts — a zero means nothing was
 * lost on that axis.
 */
export interface DreamInputDropCounters {
  /** On-chain group-chat messages dropped over the per-task cap. */
  groupChatMessages: number;
  /** Chain-write ledger rows dropped over the per-day cap. */
  chainWrites: number;
  /** Chain-read ledger rows dropped over the per-day cap. */
  chainReads: number;
  /** Implicit signals dropped over the per-day cap. */
  implicitSignals: number;
  /** Sessions reduced to a title-only stub by fair-share budgeting. */
  sessionsTitleOnly: number;
  /** Surf-report characters cut off by the prompt's surf cap. */
  surfReportChars: number;
  /** Dream-output array entries dropped by the per-field parse caps. */
  parseArrayEntries: number;
  /** Human feedback-comment characters cut by the prompt's inline cap (review M3). */
  feedbackCommentChars: number;
  /** Buyer service ratings dropped over the per-day cap (review M4). */
  serviceRatings: number;
  /** Counterfactual/positive replay points beyond the ≤3/day cap (nit). */
  replayPointsDropped: number;
  /** Required dream-output fields missing at parse time (daily_summary etc., nit). */
  parseFieldDrops: number;
}

export function createDreamInputDropCounters(): DreamInputDropCounters {
  return {
    groupChatMessages: 0,
    chainWrites: 0,
    chainReads: 0,
    implicitSignals: 0,
    sessionsTitleOnly: 0,
    surfReportChars: 0,
    parseArrayEntries: 0,
    feedbackCommentChars: 0,
    replayPointsDropped: 0,
    parseFieldDrops: 0,
    serviceRatings: 0,
  };
}

export function countDreamInputDrops(counters: DreamInputDropCounters): number {
  return counters.groupChatMessages
    + counters.chainWrites
    + counters.chainReads
    + counters.implicitSignals
    + counters.sessionsTitleOnly
    + counters.surfReportChars
    + counters.parseArrayEntries
    + counters.feedbackCommentChars
    + counters.replayPointsDropped
    + counters.parseFieldDrops
    + counters.serviceRatings;
}

const parseIdNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
};

const parseJsonObject = <T = string>(raw: string | null): Record<string, T> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const parseSessionRefs = (raw: string | null | undefined): DailySummarySessionRef[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object' && typeof item.sessionId === 'string')
      .map((item) => ({
        sessionId: item.sessionId as string,
        title: typeof item.title === 'string' ? item.title : '',
        sessionType: typeof item.sessionType === 'string' ? item.sessionType : 'standard',
        isOrder: Boolean(item.isOrder),
      }));
  } catch {
    return [];
  }
};

/** One hot_layer_usage row for a (bot, date): how the item reached the model
 * and whether the P3 usage audit judged it applied (null = unaudited). */
export interface HotLayerExposureRow {
  kind: 'technique' | 'procedure' | 'knowledge' | 'memory';
  itemId: string;
  exposure: 'hot' | 'recall';
  exposureCount: number;
  applied: boolean | null;
  auditedAt: number | null;
}

export class DreamStore {
  constructor(
    private db: Database,
    private saveDb: () => void
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_daily_summaries (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        summary_date TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        sections_json TEXT NOT NULL DEFAULT '{}',
        stats_json TEXT NOT NULL DEFAULT '{}',
        session_refs_json TEXT NOT NULL DEFAULT '[]',
        llm_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, summary_date)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_dream_runs (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        llm_id TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, dream_date)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_dream_fragments (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        fragment_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        source_char_count INTEGER NOT NULL DEFAULT 0,
        estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        summary_json TEXT,
        llm_id TEXT,
        dream_version INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, dream_date, fragment_key)
      );
    `);
    // P2b: weekly "long dream" — cross-day thematic consolidation over the
    // previous ISO week's daily summaries.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_weekly_summaries (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        week_start TEXT NOT NULL,
        week_end TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        patterns_json TEXT NOT NULL DEFAULT '[]',
        llm_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, week_start)
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_dream_fragments_date
      ON metabot_dream_fragments(metabot_id, dream_date)
    `);
    try {
      const cols = this.db.exec('PRAGMA table_info(metabot_daily_summaries);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      if (!columns.includes('session_refs_json')) {
        this.db.run("ALTER TABLE metabot_daily_summaries ADD COLUMN session_refs_json TEXT NOT NULL DEFAULT '[]';");
      }
    } catch (error) {
      console.warn('[DreamStore] Failed to verify metabot_daily_summaries columns:', error);
    }
    try {
      const cols = this.db.exec('PRAGMA table_info(metabot_dream_runs);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      if (!columns.includes('dream_version')) {
        this.db.run('ALTER TABLE metabot_dream_runs ADD COLUMN dream_version INTEGER NOT NULL DEFAULT 0;');
      }
      // P2a telemetry: per-run estimated tokens + validation/replay counters.
      if (!columns.includes('telemetry_json')) {
        this.db.run('ALTER TABLE metabot_dream_runs ADD COLUMN telemetry_json TEXT;');
      }
    } catch (error) {
      console.warn('[DreamStore] Failed to verify metabot_dream_runs columns:', error);
    }
    // dream_date tags on dream-origin memory sources: the idempotency anchor
    // that lets a re-dream replace exactly one day's memory batch.
    try {
      const cols = this.db.exec('PRAGMA table_info(user_memory_sources);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      if (!columns.includes('dream_date')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN dream_date TEXT NULL;');
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_dream_date
        ON user_memory_sources(metabot_id, dream_date)
      `);
    } catch (error) {
      console.warn('[DreamStore] Failed to verify user_memory_sources dream columns:', error);
    }
    // Long-term telemetry rollup (memory/persona audit P1): one FLAT row per
    // bot per dream date with the trend-bearing metrics as queryable columns
    // plus the full-fidelity telemetry blob. Written at updateRunTelemetry
    // time (not at purge time), so the 90-day raw-run purge
    // (purgeOldRunsAndFragments) only removes history the rollup already
    // keeps — the quarterly RSI trend survives. This table is NEVER purged.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_dream_telemetry_daily (
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        empty_day INTEGER NOT NULL DEFAULT 0,
        fragment_count INTEGER,
        estimated_activity_tokens INTEGER,
        output_chars INTEGER,
        duration_ms INTEGER,
        implicit_signals INTEGER,
        diary_total_refs INTEGER,
        diary_unmatched_refs INTEGER,
        validation_checked INTEGER,
        validation_validated INTEGER,
        validation_rejected INTEGER,
        replay_points INTEGER,
        replay_lessons INTEGER,
        capability_validated_drafts INTEGER,
        capability_total_injections INTEGER,
        capability_active_drafts_last24h INTEGER,
        promoted_count INTEGER,
        re_reviewed INTEGER,
        demoted INTEGER,
        dedup_merged INTEGER,
        has_explicit_feedback INTEGER NOT NULL DEFAULT 0,
        extra_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, dream_date)
      );
    `);
    // RSI P0 prediction ledger: explicit pre-action predictions, reconciled
    // deterministically by the nightly dream (hit/miss/partial/expired).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_predictions (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        session_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('cowork', 'surf', 'metatask', 'service')),
        action_type TEXT NOT NULL CHECK (action_type IN ('buzz_post', 'metaweb_comment', 'metatask_submission', 'service_delivery')),
        subject_ref TEXT,
        prediction_text TEXT NOT NULL,
        expectation_json TEXT NOT NULL DEFAULT '{}',
        resolve_deadline TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'hit', 'miss', 'partial', 'expired', 'void')),
        resolved_at INTEGER,
        resolved_by TEXT,
        outcome_text TEXT,
        outcome_json TEXT
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_predictions_status_deadline
      ON metabot_predictions(metabot_id, status, resolve_deadline)
    `);
    // RSI P0 retention gate: one snapshot of the dream-origin prompt layer per
    // (bot, dream date), captured immediately before that night's writes so a
    // negative-feedback spike can deterministically roll the layer back.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_prompt_layer_snapshots (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rolled_back', 'superseded')),
        rollback_reason TEXT,
        rolled_back_at INTEGER,
        UNIQUE(metabot_id, dream_date)
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_prompt_layer_snapshots_status
      ON metabot_prompt_layer_snapshots(metabot_id, status, dream_date DESC)
    `);
    // Dream review P2-1: frozen per-bot exams (design 2026-10-10 §P2.5). The
    // paper is hash-frozen at build time — same content hash never rebuilds;
    // runs carry the brain model's rubric scores for the growth-curve trend.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_exams (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_exams_metabot_created
        ON metabot_exams(metabot_id, created_at DESC);
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_exam_runs (
        id TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        metabot_id INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        total_score REAL,
        question_scores_json TEXT,
        error TEXT
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_exam_runs_metabot_started
        ON metabot_exam_runs(metabot_id, started_at DESC);
    `);
    // Review M6b: how many of the paper's questions the scorer actually
    // returned — a partial verdict is not a low score. PRAGMA-guarded and
    // additive; pre-existing rows read NULL (= fully scored, the old shape).
    try {
      const examRunCols = (this.db.exec('PRAGMA table_info(metabot_exam_runs)')[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!examRunCols.includes('scored_count')) {
        this.db.run('ALTER TABLE metabot_exam_runs ADD COLUMN scored_count INTEGER;');
      }
    } catch (error) {
      console.warn('migrate metabot_exam_runs scored_count:', error);
    }
    this.backfillLegacyDreamMemoryDates();
  }

  /**
   * Review M6a: exam-sediment memories under a STABLE ordering (created_at
   * ASC, id ASC). The generic listUserMemories orders by
   * COALESCE(last_used_at, updated_at) — last_used_at moves on every
   * injection, which would reorder the pool between runs and flip the frozen
   * paper's hash without any sediment change, destroying comparability.
   */
  listExamSedimentMemories(metabotId: number, usageClass: 'value_boundary' | 'work_review', limit = 20): Array<{ id: string; text: string; updatedAt: number }> {
    return this.getAll<{ id: string; text: string; created_at: number | string }>(`
      SELECT id, text, created_at
      FROM user_memories
      WHERE metabot_id = ? AND usage_class = ? AND status = 'created' AND archived_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `, [metabotId, usageClass, Math.max(1, Math.floor(limit))])
      .map((row) => ({ id: row.id, text: row.text, updatedAt: Number(row.created_at) }));
  }

  // ── Dream review P2-1: frozen exams ────────────────────────────────────────

  /** The bot's current (non-archived) exam paper, or null. */
  getActiveExam(metabotId: number): { id: string; contentHash: string; questions: unknown[]; createdAt: number } | null {
    const row = this.getOne<{
      id: string;
      content_hash: string;
      questions_json: string;
      created_at: number | string;
    }>(`
      SELECT id, content_hash, questions_json, created_at
      FROM metabot_exams
      WHERE metabot_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `, [metabotId]);
    if (!row) return null;
    try {
      return {
        id: row.id,
        contentHash: row.content_hash,
        questions: JSON.parse(row.questions_json) as unknown[],
        createdAt: Number(row.created_at),
      };
    } catch {
      return null;
    }
  }

  /**
   * Freeze a paper: when the bot's active exam already has this content hash
   * the existing row is returned untouched (same hash never rebuilds); a
   * different hash archives the old paper first. Returns the active exam row.
   */
  freezeExam(metabotId: number, contentHash: string, questions: unknown[], nowMs: number): { id: string; contentHash: string } | null {
    const hash = String(contentHash ?? '').trim();
    if (!hash || !Array.isArray(questions) || questions.length === 0) return null;
    const existing = this.getActiveExam(metabotId);
    if (existing && existing.contentHash === hash) {
      return { id: existing.id, contentHash: existing.contentHash };
    }
    // Review Minor 10: an explicit epoch-0 timestamp must not fall through
    // to the wall clock (|| Date.now() made deterministic tests time-travel).
    const parsedNow = Number(nowMs);
    const stamp = Number.isFinite(parsedNow) ? Math.floor(parsedNow) : Date.now();
    if (existing) {
      this.db.run('UPDATE metabot_exams SET archived_at = ? WHERE id = ?', [stamp, existing.id]);
    }
    const id = uuidv4();
    this.db.run(
      'INSERT INTO metabot_exams (id, metabot_id, content_hash, questions_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, metabotId, hash, JSON.stringify(questions), stamp],
    );
    this.saveDb();
    return { id, contentHash: hash };
  }

  /** The most recent exam run of one bot (any status), for the weekly gate. */
  getLatestExamRun(metabotId: number): { id: string; examId: string; startedAt: number; status: string; totalScore: number | null } | null {
    const row = this.getOne<{
      id: string; exam_id: string; started_at: number | string; status: string; total_score: number | string | null;
    }>(`
      SELECT id, exam_id, started_at, status, total_score
      FROM metabot_exam_runs
      WHERE metabot_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `, [metabotId]);
    if (!row) return null;
    return {
      id: row.id,
      examId: row.exam_id,
      startedAt: Number(row.started_at),
      status: row.status,
      totalScore: row.total_score == null ? null : Number(row.total_score),
    };
  }

  createExamRun(metabotId: number, examId: string, startedAt: number): string {
    const id = uuidv4();
    this.db.run(
      'INSERT INTO metabot_exam_runs (id, exam_id, metabot_id, started_at, status) VALUES (?, ?, ?, ?, ?)',
      [id, examId, metabotId, Math.floor(Number(startedAt)) || Date.now(), 'running'],
    );
    this.saveDb();
    return id;
  }

  finishExamRun(input: {
    id: string;
    status: 'done' | 'failed';
    finishedAt: number;
    totalScore?: number | null;
    scoredCount?: number | null;
    questionScores?: unknown[] | null;
    error?: string | null;
  }): void {
    this.db.run(`
      UPDATE metabot_exam_runs
      SET status = ?, finished_at = ?, total_score = ?, scored_count = ?, question_scores_json = ?, error = ?
      WHERE id = ?
    `, [
      input.status,
      Math.floor(Number(input.finishedAt)) || Date.now(),
      input.totalScore == null ? null : Math.max(0, Math.min(1, Number(input.totalScore))),
      input.scoredCount == null ? null : Math.max(0, Math.floor(Number(input.scoredCount))),
      input.questionScores == null ? null : JSON.stringify(input.questionScores),
      input.error ?? null,
      input.id,
    ]);
    this.saveDb();
  }

  /**
   * Thumbed messages that carried a human comment (either direction) — exam
   * sediment for the feedback pool. Ordered oldest first.
   */
  listFeedbackEventsWithComments(metabotId: number, limit = 20): Array<{
    messageId: string;
    sessionTitle: string;
    rating: 'up' | 'down';
    comment: string;
    occurredAt: number;
  }> {
    return this.getAll<{
      message_id: string;
      session_title: string;
      rating: string;
      comment: string;
      occurred_at: number | string;
    }>(`
      SELECT mf.message_id, s.title AS session_title, mf.rating, mf.comment, m.created_at AS occurred_at
      FROM message_feedback mf
      JOIN cowork_messages m ON m.id = mf.message_id
      JOIN cowork_sessions s ON s.id = mf.session_id
      WHERE s.metabot_id = ? AND mf.comment IS NOT NULL AND TRIM(mf.comment) != ''
      ORDER BY m.created_at ASC
      LIMIT ?
    `, [metabotId, Math.max(1, Math.floor(limit))])
      .map((row) => ({
        messageId: row.message_id,
        sessionTitle: row.session_title,
        rating: row.rating === 'up' ? 'up' as const : 'down' as const,
        comment: row.comment,
        occurredAt: Number(row.occurred_at),
      }));
  }

  /** Human review comments on the bot's group tasks, oldest first. */
  listGroupTaskReviewComments(metabotId: number, limit = 20): Array<{
    taskId: number;
    title: string;
    rating: number | null;
    comment: string;
    occurredAt: number;
  }> {
    return this.getAll<{
      task_id: number | string;
      title: string;
      rating: number | string | null;
      rating_comment: string | null;
      occurred_at: number | string;
    }>(`
      SELECT t.id AS task_id, t.title, t.rating, t.rating_comment,
        CAST(strftime('%s', COALESCE(t.rated_at, t.closed_at)) AS INTEGER) AS occurred_at
      FROM group_tasks t
      JOIN group_task_members m ON m.task_id = t.id
      WHERE m.metabot_id = ? AND m.removed_at IS NULL
        AND t.rating_comment IS NOT NULL AND TRIM(t.rating_comment) != ''
      ORDER BY occurred_at ASC
      LIMIT ?
    `, [metabotId, Math.max(1, Math.floor(limit))])
      .map((row) => ({
        taskId: Number(row.task_id),
        title: row.title,
        rating: row.rating == null ? null : Number(row.rating),
        comment: row.rating_comment ?? '',
        occurredAt: Number(row.occurred_at) * 1000,
      }));
  }

  /**
   * One-time attribution of pre-versioning dream memories to their dream date.
   * Legacy source rows (source_type='dream', dream_date NULL) are matched to
   * the same-bot run whose completion is closest to — and not more than 5
   * minutes after — the memory write. Runs only keep their latest attempt's
   * window, so batches from superseded attempts may land on an adjacent date;
   * acceptable, since every attributed date is re-dreamed once by version
   * repair and each batch is then replaced wholesale. Rows with no matching
   * run stay untagged and are never auto-removed. Only NULL rows are touched,
   * so this is idempotent.
   */
  private backfillLegacyDreamMemoryDates(): void {
    try {
      this.db.run(`
        UPDATE user_memory_sources
        SET dream_date = (
          SELECT r.dream_date
          FROM metabot_dream_runs r
          WHERE r.metabot_id = user_memory_sources.metabot_id
            AND r.completed_at IS NOT NULL
            AND r.completed_at <= user_memory_sources.created_at + 300000
          ORDER BY r.completed_at DESC
          LIMIT 1
        )
        WHERE dream_date IS NULL AND source_type = 'dream'
      `);
      if ((this.db.getRowsModified?.() || 0) > 0) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('[DreamStore] Failed to backfill legacy dream memory dates:', error);
    }
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | null {
    return this.getAll<T>(sql, params)[0] ?? null;
  }

  private mapRunRow(row: DreamRunRow): DreamRun {
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      dreamDate: row.dream_date,
      status: (row.status === 'completed' || row.status === 'failed' || row.status === 'terminal-failed' ? row.status : 'running') as DreamRunStatus,
      attemptCount: parseIdNumber(row.attempt_count) ?? 1,
      llmId: row.llm_id ?? null,
      dreamVersion: parseIdNumber(row.dream_version) ?? 0,
      error: row.error ?? null,
      telemetry: (() => {
        if (!row.telemetry_json) return null;
        try {
          const parsed = JSON.parse(row.telemetry_json);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      })(),
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  }

  private mapFragmentRow(row: DreamFragmentRow): DreamFragment {
    const status = row.status === 'completed' || row.status === 'failed' ? row.status : 'running';
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      dreamDate: row.dream_date,
      fragmentKey: row.fragment_key,
      sessionId: row.session_id,
      chunkIndex: parseIdNumber(row.chunk_index) ?? 0,
      contentHash: row.content_hash,
      sourceMessageCount: parseIdNumber(row.source_message_count) ?? 0,
      sourceCharCount: parseIdNumber(row.source_char_count) ?? 0,
      estimatedInputTokens: parseIdNumber(row.estimated_input_tokens) ?? 0,
      status: status as DreamFragmentStatus,
      summaryJson: row.summary_json ?? null,
      llmId: row.llm_id ?? null,
      dreamVersion: parseIdNumber(row.dream_version) ?? 0,
      error: row.error ?? null,
      attemptCount: parseIdNumber(row.attempt_count) ?? 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapSummaryRow(row: DailySummaryRow): DailySummary {
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      summaryDate: row.summary_date,
      summaryText: row.summary_text,
      sections: parseJsonObject<string>(row.sections_json),
      stats: parseJsonObject<number>(row.stats_json),
      sessionRefs: parseSessionRefs(row.session_refs_json),
      llmId: row.llm_id ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Start (or restart) a run for (metabot, date). Re-running a completed/failed
   * date resets the row to running and bumps attempt_count.
   */
  beginRun(metabotId: number, dreamDate: string, llmId: string | null, dreamVersion: number): DreamRun {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_dream_runs (
        id, metabot_id, dream_date, status, attempt_count, llm_id, dream_version, error,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', 1, ?, ?, NULL, ?, NULL, ?, ?)
      ON CONFLICT(metabot_id, dream_date) DO UPDATE SET
        status = 'running',
        attempt_count = attempt_count + 1,
        llm_id = excluded.llm_id,
        dream_version = excluded.dream_version,
        error = NULL,
        started_at = excluded.started_at,
        completed_at = NULL,
        updated_at = excluded.updated_at
    `, [uuidv4(), metabotId, dreamDate, llmId, dreamVersion, now, now, now]);
    this.saveDb();
    const run = this.getRun(metabotId, dreamDate);
    if (!run) {
      throw new Error('Failed to load dream run after beginRun');
    }
    return run;
  }

  /** terminal-failed marks a run that must not be auto-retried (deterministic
   * error or exhausted retry budget); the error text says which. */
  finishRun(metabotId: number, dreamDate: string, status: 'completed' | 'failed' | 'terminal-failed', error?: string | null): void {
    const now = Date.now();
    // Upsert (review M1): a dream that dies BEFORE beginRun completes (sick
    // store mid-recovery) has no row to UPDATE — the failure must still land
    // as a failed run or the night looks like it never happened.
    this.db.run(`
      INSERT INTO metabot_dream_runs (
        id, metabot_id, dream_date, status, attempt_count, llm_id, error,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id, dream_date) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `, [uuidv4(), metabotId, dreamDate, status, error ?? null, now, now, now, now]);
    this.saveDb();
  }

  getRun(metabotId: number, dreamDate: string): DreamRun | null {
    const row = this.getOne<DreamRunRow>(
      'SELECT * FROM metabot_dream_runs WHERE metabot_id = ? AND dream_date = ? LIMIT 1',
      [metabotId, dreamDate]
    );
    return row ? this.mapRunRow(row) : null;
  }

  /**
   * P2a telemetry: attach the run's measured shape (estimated tokens, fragment
   * count, validation/replay counters, duration) after completion. The dream
   * policy can only be tuned once it is measurable — this is the evidence base
   * for future DREAM_VERSION decisions.
   */
  updateRunTelemetry(metabotId: number, dreamDate: string, telemetry: Record<string, unknown>): void {
    try {
      this.db.run(`
        UPDATE metabot_dream_runs
        SET telemetry_json = ?, updated_at = ?
        WHERE metabot_id = ? AND dream_date = ?
      `, [JSON.stringify(telemetry), Date.now(), metabotId, dreamDate]);
      // Same-moment rollup (audit P1): the long-term daily row accumulates
      // continuously, so the 90-day raw-run purge only deletes history the
      // rollup already keeps.
      this.upsertTelemetryDaily(metabotId, dreamDate, telemetry);
      this.saveDb();
    } catch (error) {
      console.warn('[DreamStore] Failed to write run telemetry:', error);
    }
  }

  /**
   * Long-term telemetry rollup (audit P1): one flat row per (bot, dream date).
   * Re-dreaming / repairing a date OVERWRITES the row (UNIQUE anchor) so the
   * trend always reflects the latest verdict of that day. Null-safe: every
   * missing metric stays NULL (a genuinely unmeasurable day, e.g. pre-
   * denominator runs), never a fabricated zero. Never purged.
   */
  private upsertTelemetryDaily(metabotId: number, dreamDate: string, telemetry: Record<string, unknown>): void {
    const num = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
    const nested = (value: unknown): Record<string, unknown> | null =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const validation = nested(telemetry.validation);
    const replay = nested(telemetry.replay);
    const utilization = nested(telemetry.capabilityUtilization);
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_dream_telemetry_daily (
        metabot_id, dream_date, empty_day, fragment_count, estimated_activity_tokens,
        output_chars, duration_ms, implicit_signals, diary_total_refs, diary_unmatched_refs,
        validation_checked, validation_validated, validation_rejected, replay_points, replay_lessons,
        capability_validated_drafts, capability_total_injections, capability_active_drafts_last24h,
        promoted_count, re_reviewed, demoted, dedup_merged, has_explicit_feedback,
        extra_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id, dream_date) DO UPDATE SET
        empty_day = excluded.empty_day,
        fragment_count = excluded.fragment_count,
        estimated_activity_tokens = excluded.estimated_activity_tokens,
        output_chars = excluded.output_chars,
        duration_ms = excluded.duration_ms,
        implicit_signals = excluded.implicit_signals,
        diary_total_refs = excluded.diary_total_refs,
        diary_unmatched_refs = excluded.diary_unmatched_refs,
        validation_checked = excluded.validation_checked,
        validation_validated = excluded.validation_validated,
        validation_rejected = excluded.validation_rejected,
        replay_points = excluded.replay_points,
        replay_lessons = excluded.replay_lessons,
        capability_validated_drafts = excluded.capability_validated_drafts,
        capability_total_injections = excluded.capability_total_injections,
        capability_active_drafts_last24h = excluded.capability_active_drafts_last24h,
        promoted_count = excluded.promoted_count,
        re_reviewed = excluded.re_reviewed,
        demoted = excluded.demoted,
        dedup_merged = excluded.dedup_merged,
        has_explicit_feedback = excluded.has_explicit_feedback,
        extra_json = excluded.extra_json,
        updated_at = excluded.updated_at
    `, [
      metabotId,
      dreamDate,
      telemetry.emptyDay === true ? 1 : 0,
      num(telemetry.fragmentCount),
      num(telemetry.estimatedActivityTokens),
      num(telemetry.outputChars),
      num(telemetry.durationMs),
      num(telemetry.implicitSignals),
      num(telemetry.diaryTotalRefs),
      num(telemetry.diaryUnmatchedRefs),
      num(validation?.checked),
      num(validation?.validated),
      num(validation?.rejected),
      num(replay?.points),
      num(replay?.lessons),
      num(utilization?.validatedDrafts),
      num(utilization?.totalInjections),
      num(utilization?.activeDraftsLast24h),
      num(telemetry.promotedCount),
      num(telemetry.reReviewed),
      num(telemetry.demoted),
      num(telemetry.dedupMerged),
      telemetry.hasExplicitFeedback === true ? 1 : 0,
      JSON.stringify(telemetry),
      now,
      now,
    ]);
  }

  /**
   * Read the long-term telemetry rollup (audit P1), ascending by dream date.
   * `sinceDays` (when > 0) keeps only dates within that lookback window —
   * the rollup itself is never purged, so the window is a read-side choice.
   * The IPC dream:listTelemetryDaily passes this shape straight through.
   */
  listDreamTelemetryDaily(metabotId: number, sinceDays?: number): DreamTelemetryDaily[] {
    const params: Array<number | string> = [metabotId];
    let where = 'metabot_id = ?';
    if (Number.isInteger(sinceDays) && (sinceDays ?? 0) > 0) {
      where += ' AND dream_date >= ?';
      params.push(formatBotWorkspaceDate(new Date(Date.now() - Math.floor(sinceDays!) * 86_400_000)));
    }
    const rows = this.getAll<Record<string, unknown>>(`
      SELECT * FROM metabot_dream_telemetry_daily
      WHERE ${where}
      ORDER BY dream_date ASC
    `, params);
    return rows.map((row) => this.mapTelemetryDailyRow(row));
  }

  /**
   * Inclusive [fromDate, toDate] read of the rollup, ascending (RRSI P4): the
   * exploration stall detector needs the exact 21 nights before a dreamed
   * date without depending on wall-clock lookbacks.
   */
  listDreamTelemetryDailyRange(metabotId: number, fromDate: string, toDate: string): DreamTelemetryDaily[] {
    const rows = this.getAll<Record<string, unknown>>(`
      SELECT * FROM metabot_dream_telemetry_daily
      WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?
      ORDER BY dream_date ASC
    `, [metabotId, fromDate, toDate]);
    return rows.map((row) => this.mapTelemetryDailyRow(row));
  }

  private mapTelemetryDailyRow(row: Record<string, unknown>): DreamTelemetryDaily {
    let extraJson: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row.extra_json ?? '{}'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        extraJson = parsed as Record<string, unknown>;
      }
    } catch {
      extraJson = {};
    }
    const numOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
    return {
      metabotId: Number(row.metabot_id),
      dreamDate: String(row.dream_date),
      emptyDay: Number(row.empty_day) !== 0,
      fragmentCount: numOrNull(row.fragment_count),
      estimatedActivityTokens: numOrNull(row.estimated_activity_tokens),
      outputChars: numOrNull(row.output_chars),
      durationMs: numOrNull(row.duration_ms),
      implicitSignals: numOrNull(row.implicit_signals),
      diaryTotalRefs: numOrNull(row.diary_total_refs),
      diaryUnmatchedRefs: numOrNull(row.diary_unmatched_refs),
      validationChecked: numOrNull(row.validation_checked),
      validationValidated: numOrNull(row.validation_validated),
      validationRejected: numOrNull(row.validation_rejected),
      replayPoints: numOrNull(row.replay_points),
      replayLessons: numOrNull(row.replay_lessons),
      capabilityValidatedDrafts: numOrNull(row.capability_validated_drafts),
      capabilityTotalInjections: numOrNull(row.capability_total_injections),
      capabilityActiveDraftsLast24h: numOrNull(row.capability_active_drafts_last24h),
      promotedCount: numOrNull(row.promoted_count),
      reReviewed: numOrNull(row.re_reviewed),
      demoted: numOrNull(row.demoted),
      dedupMerged: numOrNull(row.dedup_merged),
      hasExplicitFeedback: Number(row.has_explicit_feedback) !== 0,
      extraJson,
      updatedAt: Number(row.updated_at),
    };
  }

  /** Newest-first weekly summaries within [dateFrom, dateTo] (YYYY-MM-DD, inclusive). */
  listRunsInRange(metabotId: number, dateFrom: string, dateTo: string): DreamRun[] {
    return this.getAll<DreamRunRow>(
      `SELECT * FROM metabot_dream_runs
       WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?
       ORDER BY dream_date DESC`,
      [metabotId, dateFrom, dateTo],
    ).map((row) => this.mapRunRow(row));
  }

  private mapWeeklySummaryRow(row: WeeklySummaryRow): WeeklySummary {
    let patterns: string[] = [];
    try {
      const parsed = JSON.parse(row.patterns_json ?? '[]');
      if (Array.isArray(parsed)) patterns = parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      patterns = [];
    }
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      weekStart: row.week_start,
      weekEnd: row.week_end,
      summaryText: row.summary_text,
      patterns,
      llmId: row.llm_id ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /** Idempotent weekly write: one row per bot per ISO week, replaced wholesale. */
  upsertWeeklySummary(input: {
    metabotId: number;
    weekStart: string;
    weekEnd: string;
    summaryText: string;
    patterns: string[];
    llmId: string | null;
  }): void {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_weekly_summaries (
        id, metabot_id, week_start, week_end, summary_text, patterns_json, llm_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id, week_start) DO UPDATE SET
        week_end = excluded.week_end,
        summary_text = excluded.summary_text,
        patterns_json = excluded.patterns_json,
        llm_id = excluded.llm_id,
        updated_at = excluded.updated_at
    `, [
      uuidv4(),
      input.metabotId,
      input.weekStart,
      input.weekEnd,
      input.summaryText,
      JSON.stringify(input.patterns),
      input.llmId,
      now,
      now,
    ]);
    this.saveDb();
  }

  getWeeklySummary(metabotId: number, weekStart: string): WeeklySummary | null {
    const row = this.getOne<WeeklySummaryRow>(
      'SELECT * FROM metabot_weekly_summaries WHERE metabot_id = ? AND week_start = ? LIMIT 1',
      [metabotId, weekStart],
    );
    return row ? this.mapWeeklySummaryRow(row) : null;
  }

  getLatestWeeklySummary(metabotId: number): WeeklySummary | null {
    const row = this.getOne<WeeklySummaryRow>(
      'SELECT * FROM metabot_weekly_summaries WHERE metabot_id = ? ORDER BY week_start DESC LIMIT 1',
      [metabotId],
    );
    return row ? this.mapWeeklySummaryRow(row) : null;
  }

  /**
   * Recent run rows for display (dream diary failure fallback), newest date
   * first. Read-only: scheduling decisions use getRunStates/computeDueDreamDates
   * on this same table, so surfacing these rows can never mark a date as done.
   */
  listRecentRuns(metabotId: number, limit: number = 30): DreamRun[] {
    const clampedLimit = Math.max(1, Math.min(365, Math.floor(limit)));
    const rows = this.getAll<DreamRunRow>(
      'SELECT * FROM metabot_dream_runs WHERE metabot_id = ? ORDER BY dream_date DESC LIMIT ?',
      [metabotId, clampedLimit]
    );
    return rows.map((row) => this.mapRunRow(row));
  }

  /**
   * How many non-empty dream nights the bot completed strictly before
   * `beforeDate` (RRSI P2 promotion-budget input, design §6.2 P2.1). The
   * telemetry rollup is the source of truth: re-dreamed dates overwrite in
   * place, so the count can never double-book a night.
   */
  countNonEmptyDreamNights(metabotId: number, beforeDate: string): number {
    const row = this.getOne<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND empty_day = 0 AND dream_date < ?',
      [metabotId, beforeDate],
    );
    return Math.max(0, Math.floor(Number(row?.count) || 0));
  }

  getDreamFragment(metabotId: number, dreamDate: string, fragmentKey: string): DreamFragment | null {
    const row = this.getOne<DreamFragmentRow>(
      `SELECT * FROM metabot_dream_fragments
       WHERE metabot_id = ? AND dream_date = ? AND fragment_key = ? LIMIT 1`,
      [metabotId, dreamDate, fragmentKey]
    );
    return row ? this.mapFragmentRow(row) : null;
  }

  listDreamFragments(metabotId: number, dreamDate: string): DreamFragment[] {
    const rows = this.getAll<DreamFragmentRow>(
      `SELECT * FROM metabot_dream_fragments
       WHERE metabot_id = ? AND dream_date = ? ORDER BY chunk_index ASC, fragment_key ASC`,
      [metabotId, dreamDate]
    );
    return rows.map((row) => this.mapFragmentRow(row));
  }

  beginDreamFragment(input: {
    metabotId: number;
    dreamDate: string;
    fragmentKey: string;
    sessionId: string;
    chunkIndex: number;
    contentHash: string;
    sourceMessageCount: number;
    sourceCharCount: number;
    estimatedInputTokens: number;
    llmId: string | null;
    dreamVersion: number;
  }): DreamFragment {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_dream_fragments (
        id, metabot_id, dream_date, fragment_key, session_id, chunk_index,
        content_hash, source_message_count, source_char_count, estimated_input_tokens,
        status, summary_json, llm_id, dream_version, error, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, NULL, 1, ?, ?)
      ON CONFLICT(metabot_id, dream_date, fragment_key) DO UPDATE SET
        session_id = excluded.session_id,
        chunk_index = excluded.chunk_index,
        content_hash = excluded.content_hash,
        source_message_count = excluded.source_message_count,
        source_char_count = excluded.source_char_count,
        estimated_input_tokens = excluded.estimated_input_tokens,
        status = 'running',
        summary_json = NULL,
        llm_id = excluded.llm_id,
        dream_version = excluded.dream_version,
        error = NULL,
        attempt_count = metabot_dream_fragments.attempt_count + 1,
        updated_at = excluded.updated_at
    `, [
      uuidv4(),
      input.metabotId,
      input.dreamDate,
      input.fragmentKey,
      input.sessionId,
      input.chunkIndex,
      input.contentHash,
      input.sourceMessageCount,
      input.sourceCharCount,
      input.estimatedInputTokens,
      input.llmId,
      input.dreamVersion,
      now,
      now,
    ]);
    this.saveDb();
    const fragment = this.getDreamFragment(input.metabotId, input.dreamDate, input.fragmentKey);
    if (!fragment) throw new Error('Failed to load dream fragment after beginDreamFragment');
    return fragment;
  }

  finishDreamFragment(
    metabotId: number,
    dreamDate: string,
    fragmentKey: string,
    status: 'completed' | 'failed',
    summaryJson: string | null = null,
    error: string | null = null,
  ): void {
    this.db.run(`
      UPDATE metabot_dream_fragments
      SET status = ?, summary_json = ?, error = ?, updated_at = ?
      WHERE metabot_id = ? AND dream_date = ? AND fragment_key = ?
    `, [status, summaryJson, error, Date.now(), metabotId, dreamDate, fragmentKey]);
    this.saveDb();
  }

  /** status + attempt_count + started_at + dream_version (+ last error text,
   * which feeds the rate-limit / consecutive-timeout backoff escalation in
   * computeDreamRetryDelayMs) for the given dates, keyed by dream_date. */
  getRunStates(metabotId: number, dreamDates: string[]): Map<string, { status: DreamRunStatus; attemptCount: number; startedAt: number; dreamVersion: number; error: string | null }> {
    const states = new Map<string, { status: DreamRunStatus; attemptCount: number; startedAt: number; dreamVersion: number; error: string | null }>();
    if (dreamDates.length === 0) return states;
    const placeholders = dreamDates.map(() => '?').join(', ');
    const rows = this.getAll<{ dream_date: string; status: string; attempt_count: number | string; started_at: number | string; dream_version: number | string | null; error: string | null }>(
      `SELECT dream_date, status, attempt_count, started_at, dream_version, error FROM metabot_dream_runs
       WHERE metabot_id = ? AND dream_date IN (${placeholders})`,
      [metabotId, ...dreamDates]
    );
    for (const row of rows) {
      states.set(row.dream_date, {
        status: (row.status === 'completed' || row.status === 'failed' || row.status === 'terminal-failed' ? row.status : 'running') as DreamRunStatus,
        attemptCount: parseIdNumber(row.attempt_count) ?? 1,
        startedAt: Number(row.started_at),
        dreamVersion: parseIdNumber(row.dream_version) ?? 0,
        error: row.error ?? null,
      });
    }
    return states;
  }

  /** Raw cowork_config lookup (e.g. the dreamLlmId global override). */
  getCoworkConfigValue(key: string): string | null {
    try {
      const row = this.getOne<{ value: string }>(
        'SELECT value FROM cowork_config WHERE key = ? LIMIT 1',
        [key]
      );
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Runs left in 'running' by an app restart are marked failed. */
  resetStaleRunningRuns(): number {
    this.db.run(`
      UPDATE metabot_dream_runs
      SET status = 'failed', error = 'Application restarted during dream run', updated_at = ?
      WHERE status = 'running'
    `, [Date.now()]);
    const runModified = this.db.getRowsModified?.() || 0;
    this.db.run(`
      UPDATE metabot_dream_fragments
      SET status = 'failed', error = 'Application restarted during dream run', updated_at = ?
      WHERE status = 'running'
    `, [Date.now()]);
    const fragmentModified = this.db.getRowsModified?.() || 0;
    const modified = runModified + fragmentModified;
    if (modified > 0) {
      this.saveDb();
    }
    return modified;
  }

  upsertDailySummary(input: {
    metabotId: number;
    summaryDate: string;
    summaryText: string;
    sections: Record<string, string>;
    stats: Record<string, number>;
    sessionRefs?: DailySummarySessionRef[];
    llmId: string | null;
  }): DailySummary {
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_daily_summaries (
        id, metabot_id, summary_date, summary_text, sections_json, stats_json, session_refs_json, llm_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id, summary_date) DO UPDATE SET
        summary_text = excluded.summary_text,
        sections_json = excluded.sections_json,
        stats_json = excluded.stats_json,
        session_refs_json = excluded.session_refs_json,
        llm_id = excluded.llm_id,
        updated_at = excluded.updated_at
    `, [
      uuidv4(),
      input.metabotId,
      input.summaryDate,
      input.summaryText,
      JSON.stringify(input.sections ?? {}),
      JSON.stringify(input.stats ?? {}),
      JSON.stringify(input.sessionRefs ?? []),
      input.llmId,
      now,
      now,
    ]);
    this.saveDb();
    const summary = this.getDailySummary(input.metabotId, input.summaryDate);
    if (!summary) {
      throw new Error('Failed to load daily summary after upsert');
    }
    return summary;
  }

  getDailySummary(metabotId: number, summaryDate: string): DailySummary | null {
    const row = this.getOne<DailySummaryRow>(
      'SELECT * FROM metabot_daily_summaries WHERE metabot_id = ? AND summary_date = ? LIMIT 1',
      [metabotId, summaryDate]
    );
    return row ? this.mapSummaryRow(row) : null;
  }

  listDailySummaries(metabotId: number, limit: number = 30, offset: number = 0): DailySummary[] {
    const clampedLimit = Math.max(1, Math.min(365, Math.floor(limit)));
    const clampedOffset = Math.max(0, Math.floor(offset));
    const rows = this.getAll<DailySummaryRow>(`
      SELECT * FROM metabot_daily_summaries
      WHERE metabot_id = ?
      ORDER BY summary_date DESC
      LIMIT ? OFFSET ?
    `, [metabotId, clampedLimit, clampedOffset]);
    return rows.map((row) => this.mapSummaryRow(row));
  }

  /**
   * Warm/cold experience retrieval over daily summaries. Without a query this
   * is a date-range lookup (warm layer); with a query it is a LIKE search
   * across the bot's full summary history (cold/deep layer). LIKE is used
   * deliberately: the sql.js fallback backend has no FTS5, and this table is
   * small by design (one row per bot per day).
   */
  searchDailySummaries(
    metabotId: number,
    options: { query?: string; dateFrom?: string; dateTo?: string; limit?: number } = {}
  ): DailySummary[] {
    const clauses: string[] = ['metabot_id = ?'];
    const params: Array<string | number> = [metabotId];

    const dateFrom = options.dateFrom?.trim();
    if (dateFrom) {
      clauses.push('summary_date >= ?');
      params.push(dateFrom);
    }
    const dateTo = options.dateTo?.trim();
    if (dateTo) {
      clauses.push('summary_date <= ?');
      params.push(dateTo);
    }
    const query = options.query?.trim();
    if (query) {
      const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
      clauses.push(`(summary_text LIKE ? ESCAPE '\\' OR sections_json LIKE ? ESCAPE '\\')`);
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 30)));
    const rows = this.getAll<DailySummaryRow>(`
      SELECT * FROM metabot_daily_summaries
      WHERE ${clauses.join(' AND ')}
      ORDER BY summary_date DESC
      LIMIT ?
    `, [...params, limit]);
    return rows.map((row) => this.mapSummaryRow(row));
  }

  /**
   * Everything the bot did on [dayStartMs, dayEndMs): cowork sessions with
   * user/assistant messages that day (orders flagged via service_orders),
   * scheduled task runs, same-day group-task acceptances / in-progress
   * summaries, on-chain group-chat transcripts for member tasks, and the
   * chain content history (pins published / pins fully read that day).
   * Hidden sessions are included on purpose — order execution sessions are
   * hidden from the UI list but are still experience.
   */
  getActivityForDate(
    metabotId: number,
    dayStartMs: number,
    dayEndMs: number,
    dropCounters?: DreamInputDropCounters,
  ): DreamDayActivity {
    const sessionRows = this.getAll<{
      id: string;
      title: string;
      session_type: string | null;
      peer_name: string | null;
      is_order: number;
    }>(`
      SELECT s.id, s.title, s.session_type, s.peer_name,
        EXISTS(SELECT 1 FROM service_orders o WHERE o.cowork_session_id = s.id) AS is_order
      FROM cowork_sessions s
      WHERE s.metabot_id = ?
        AND EXISTS(
          SELECT 1 FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ?
        )
        -- QQ/IM GROUP conversations are untrusted external content. They are
        -- answered as pure Q&A and must never become the bot's memory: keep
        -- them out of the nightly consolidation input entirely (not merely
        -- out of the prompt). Private chats are unaffected.
        AND NOT EXISTS(
          SELECT 1 FROM cowork_conversation_mappings gm
          WHERE gm.cowork_session_id = s.id
            AND gm.channel LIKE 'im:%:group'
        )
      ORDER BY s.updated_at ASC
    `, [metabotId, dayStartMs, dayEndMs]);

    const sessions: DreamSessionActivity[] = sessionRows.map((session) => {
      const messageRows = this.getAll<{
        type: string;
        content: string | null;
        created_at: number | string;
        feedback_rating: string | null;
        feedback_comment: string | null;
      }>(`
        SELECT m.type, m.content, m.created_at,
          mf.rating AS feedback_rating, mf.comment AS feedback_comment
        FROM cowork_messages m
        LEFT JOIN message_feedback mf ON mf.message_id = m.id
        WHERE m.session_id = ?
          AND m.created_at >= ? AND m.created_at < ?
          AND m.type IN ('user', 'assistant')
        ORDER BY m.created_at ASC
      `, [session.id, dayStartMs, dayEndMs]);
      return {
        sessionId: session.id,
        title: session.title,
        sessionType: session.session_type === 'agent_agent' ? 'a2a' : (session.session_type || 'standard'),
        peerName: session.peer_name ?? null,
        isOrder: Number(session.is_order) !== 0,
        messages: messageRows
          .filter((row) => (row.type === 'user' || row.type === 'assistant') && typeof row.content === 'string')
          .map((row) => ({
            type: row.type as 'user' | 'assistant',
            content: row.content as string,
            createdAt: Number(row.created_at),
            feedbackRating: row.feedback_rating === 'up' || row.feedback_rating === 'down'
              ? row.feedback_rating
              : undefined,
            feedbackComment: row.feedback_comment ?? undefined,
          })),
      };
    });

    // scheduled_task_runs.started_at is a UTC ISO string (scheduledTaskStore
    // writes new Date().toISOString()); lexicographic comparison is safe for
    // that uniform format.
    const taskRuns = this.getAll<{
      name: string;
      status: string;
      started_at: string;
      session_id: string | null;
    }>(`
      SELECT t.name, r.status, r.started_at, r.session_id
      FROM scheduled_task_runs r
      JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE t.metabot_id = ? AND r.started_at >= ? AND r.started_at < ?
      ORDER BY r.started_at ASC
    `, [metabotId, new Date(dayStartMs).toISOString(), new Date(dayEndMs).toISOString()]).map((row) => ({
      taskName: row.name,
      status: row.status,
      startedAt: Date.parse(row.started_at),
      sessionId: row.session_id ?? null,
    }));

    // Raw order count for the day — one order session can carry several
    // orders, so counting sessions alone under-reports (stats vs narrative).
    const orderCountRow = this.getOne<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM service_orders WHERE local_metabot_id = ? AND created_at >= ? AND created_at < ?',
      [metabotId, dayStartMs, dayEndMs]
    );

    // group_chat_messages.chain_timestamp is unix seconds (see sqliteStore).
    // Day attribution for acceptances uses rated_at, falling back to closed_at;
    // both are UTC datetime('now') strings.
    const dayStartSec = Math.floor(dayStartMs / 1000);
    const dayEndSec = Math.floor(dayEndMs / 1000);

    const groupChatRows = this.getAll<{
      task_id: number;
      title: string;
      group_id: string;
      status: string;
      role: string;
      sender_name: string | null;
      sender_global_metaid: string | null;
      content: string;
      chain_timestamp: number | string;
    }>(`
      SELECT t.id AS task_id, t.title, t.group_id, t.status, m.role,
        g.sender_name, g.sender_global_metaid, g.content, g.chain_timestamp
      FROM group_tasks t
      JOIN group_task_members m ON m.task_id = t.id
      JOIN group_chat_messages g ON g.group_id = t.group_id
      WHERE m.metabot_id = ? AND m.removed_at IS NULL
        AND t.group_id IS NOT NULL AND TRIM(t.group_id) != ''
        AND g.chain_timestamp IS NOT NULL
        AND g.content IS NOT NULL AND TRIM(g.content) != ''
        AND g.chain_timestamp >= ? AND g.chain_timestamp < ?
      ORDER BY t.id ASC, g.chain_timestamp ASC, g.id ASC
    `, [metabotId, dayStartSec, dayEndSec]);

    const groupChatsByTask = new Map<number, DreamGroupChatActivity>();
    for (const row of groupChatRows) {
      const taskId = parseIdNumber(row.task_id);
      if (taskId == null) continue;
      const existing = groupChatsByTask.get(taskId) ?? {
        taskId,
        title: row.title,
        groupId: row.group_id,
        taskStatus: row.status,
        memberRole: row.role === 'chair' ? 'chair' : 'worker',
        messages: [],
      };
      if (existing.messages.length >= MAX_GROUP_CHAT_MESSAGES_PER_TASK) {
        if (dropCounters) dropCounters.groupChatMessages += 1;
        continue;
      }
      const occurredSec = parseIdNumber(row.chain_timestamp);
      existing.messages.push({
        senderName: (row.sender_name ?? '').trim() || 'unknown',
        senderGlobalMetaID: (row.sender_global_metaid ?? '').trim() || null,
        content: row.content,
        occurredAt: occurredSec == null ? dayStartMs : occurredSec * 1000,
      });
      groupChatsByTask.set(taskId, existing);
    }
    const groupChats = [...groupChatsByTask.values()];
    const dayMessageCountByTask = new Map(
      groupChats.map((chat) => [chat.taskId, chat.messages.length]),
    );

    const acceptedTasks = this.getAll<{
      id: number;
      title: string;
      goal: string;
      status: string;
      role: string;
      rating: number | null;
      rating_comment: string | null;
    }>(`
      SELECT t.id, t.title, t.goal, t.status, m.role, t.rating, t.rating_comment
      FROM group_tasks t
      JOIN group_task_members m ON m.task_id = t.id
      WHERE m.metabot_id = ? AND m.removed_at IS NULL
        AND t.status IN ('done', 'cancelled')
        AND CAST(strftime('%s', COALESCE(t.rated_at, t.closed_at)) AS INTEGER) >= ?
        AND CAST(strftime('%s', COALESCE(t.rated_at, t.closed_at)) AS INTEGER) < ?
      ORDER BY t.id ASC
    `, [metabotId, dayStartSec, dayEndSec]).map((row) => ({
      taskId: row.id,
      title: row.title,
      goal: row.goal,
      memberRole: row.role === 'chair' ? 'chair' : 'worker',
      rating: row.rating ?? null,
      ratingComment: row.rating_comment ?? null,
      status: row.status,
      phase: 'accepted' as const,
      dayMessageCount: dayMessageCountByTask.get(row.id),
    }));
    const acceptedIds = new Set(acceptedTasks.map((task) => task.taskId));

    // Still-open tasks appear only when this bot had same-day activity:
    // on-chain group chat, or a mapped group-task cowork skill turn.
    const activeTasks = this.getAll<{
      id: number;
      title: string;
      goal: string;
      status: string;
      role: string;
    }>(`
      SELECT t.id, t.title, t.goal, t.status, m.role
      FROM group_tasks t
      JOIN group_task_members m ON m.task_id = t.id
      WHERE m.metabot_id = ? AND m.removed_at IS NULL
        AND t.status IN ('planning', 'executing', 'review')
        AND (
          EXISTS (
            SELECT 1 FROM group_chat_messages g
            WHERE g.group_id = t.group_id
              AND g.chain_timestamp IS NOT NULL
              AND g.chain_timestamp >= ? AND g.chain_timestamp < ?
          )
          OR EXISTS (
            SELECT 1 FROM cowork_conversation_mappings map
            JOIN cowork_messages cm ON cm.session_id = map.cowork_session_id
            WHERE map.channel = 'metaweb_group_task'
              AND map.external_conversation_id = 'group-task:' || t.id
              AND map.metabot_id = ?
              AND cm.created_at >= ? AND cm.created_at < ?
          )
        )
      ORDER BY t.id ASC
    `, [metabotId, dayStartSec, dayEndSec, metabotId, dayStartMs, dayEndMs])
      .filter((row) => !acceptedIds.has(row.id))
      .map((row) => ({
        taskId: row.id,
        title: row.title,
        goal: row.goal,
        memberRole: row.role === 'chair' ? 'chair' : 'worker',
        rating: null,
        ratingComment: null,
        status: row.status,
        phase: 'active' as const,
        dayMessageCount: dayMessageCountByTask.get(row.id),
      }));

    // Chain content history (own writes / full reads): timestamps are epoch
    // milliseconds, so the day window applies directly (no seconds conversion
    // like group_chat_messages needs).
    const chainWrites = this.getAll<{
      pin_id: string;
      path: string | null;
      operation: string | null;
      summary: string | null;
      content_text: string | null;
      occurred_at_ms: number | string;
    }>(`
      SELECT pin_id, path, operation, summary, content_text, occurred_at_ms
      FROM metabot_chain_writes
      WHERE metabot_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
      ORDER BY occurred_at_ms ASC
      LIMIT ?
    `, [metabotId, dayStartMs, dayEndMs, MAX_CHAIN_CONTENT_ENTRIES_PER_KIND]).map((row) => ({
      pinId: row.pin_id,
      path: row.path ?? null,
      operation: row.operation ?? null,
      summary: row.summary ?? null,
      contentText: row.content_text ?? null,
      occurredAtMs: Number(row.occurred_at_ms) || dayStartMs,
    }));
    if (dropCounters && chainWrites.length >= MAX_CHAIN_CONTENT_ENTRIES_PER_KIND) {
      const total = parseIdNumber(this.getOne<{ n: number | string }>(
        'SELECT COUNT(*) AS n FROM metabot_chain_writes WHERE metabot_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?',
        [metabotId, dayStartMs, dayEndMs],
      )?.n) ?? chainWrites.length;
      dropCounters.chainWrites += Math.max(0, total - MAX_CHAIN_CONTENT_ENTRIES_PER_KIND);
    }

    const chainReads = this.getAll<{
      pin_id: string;
      path: string | null;
      protocol: string | null;
      title: string | null;
      author_globalmetaid: string | null;
      summary: string | null;
      content_excerpt: string | null;
      saved_to_kb: number | string;
      last_read_at_ms: number | string;
    }>(`
      SELECT pin_id, path, protocol, title, author_globalmetaid,
        summary, content_excerpt, saved_to_kb, last_read_at_ms
      FROM metabot_chain_reads
      WHERE metabot_id = ? AND last_read_at_ms >= ? AND last_read_at_ms < ?
      ORDER BY last_read_at_ms ASC
      LIMIT ?
    `, [metabotId, dayStartMs, dayEndMs, MAX_CHAIN_CONTENT_ENTRIES_PER_KIND]).map((row) => ({
      pinId: row.pin_id,
      path: row.path ?? null,
      protocol: row.protocol ?? null,
      title: row.title ?? null,
      authorGlobalMetaId: row.author_globalmetaid ?? null,
      summary: row.summary ?? null,
      contentExcerpt: row.content_excerpt ?? null,
      savedToKb: Number(row.saved_to_kb) === 1,
      lastReadAtMs: Number(row.last_read_at_ms) || dayStartMs,
    }));
    if (dropCounters && chainReads.length >= MAX_CHAIN_CONTENT_ENTRIES_PER_KIND) {
      const total = parseIdNumber(this.getOne<{ n: number | string }>(
        'SELECT COUNT(*) AS n FROM metabot_chain_reads WHERE metabot_id = ? AND last_read_at_ms >= ? AND last_read_at_ms < ?',
        [metabotId, dayStartMs, dayEndMs],
      )?.n) ?? chainReads.length;
      dropCounters.chainReads += Math.max(0, total - MAX_CHAIN_CONTENT_ENTRIES_PER_KIND);
    }

    // Buyer ratings received that day on services THIS bot provides. The
    // rating pins are synced chain-wide by gigSquareRatingSyncService into
    // remote_skill_service_rating_seen; provider identity comes from the
    // synced remote_skill_service row (publisher metaid / globalmetaid).
    // created_at is epoch milliseconds (the sync normalizes legacy second
    // values on write), so the day window applies directly.
    const serviceRatings = this.getAll<{
      service_id: string;
      service_name: string | null;
      display_name: string | null;
      pin_id: string;
      rate: number | string | null;
      comment: string | null;
      service_paid_tx: string | null;
      rater_global_metaid: string | null;
      rater_metaid: string | null;
      created_at: number | string;
    }>(`
      SELECT s.id AS service_id, s.service_name, s.display_name,
        r.pin_id, r.rate, r.comment, r.service_paid_tx,
        r.rater_global_metaid, r.rater_metaid, r.created_at
      FROM remote_skill_service_rating_seen r
      JOIN remote_skill_service s ON s.id = r.service_id
      JOIN metabots b ON b.id = ?
      WHERE (s.metaid = b.metaid
          OR (b.globalmetaid IS NOT NULL AND TRIM(b.globalmetaid) != ''
            AND s.global_metaid = b.globalmetaid))
        AND r.created_at >= ? AND r.created_at < ?
      ORDER BY r.created_at ASC
      LIMIT ?
    `, [metabotId, dayStartMs, dayEndMs, MAX_SERVICE_RATINGS_PER_DAY]).map((row) => ({
      serviceId: row.service_id,
      serviceName: (row.display_name ?? row.service_name ?? '').trim() || null,
      ratingPinId: row.pin_id,
      rating: row.rate == null ? null : Number(row.rate),
      comment: row.comment ?? null,
      orderTxid: row.service_paid_tx ?? null,
      raterGlobalMetaId: (row.rater_global_metaid ?? '').trim() || null,
      raterMetaId: (row.rater_metaid ?? '').trim() || null,
      ratedAtMs: Number(row.created_at) || dayStartMs,
    }));
    // Review M4: same silent-truncation invariant as chainWrites/Reads — the
    // exact overflow is counted only when the capped query hits the limit (no
    // extra query on normal nights).
    if (dropCounters && serviceRatings.length >= MAX_SERVICE_RATINGS_PER_DAY) {
      const total = parseIdNumber(this.getOne<{ n: number | string }>(
        `SELECT COUNT(*) AS n
         FROM remote_skill_service_rating_seen r
         JOIN remote_skill_service s ON s.id = r.service_id
         JOIN metabots b ON b.id = ?
         WHERE (s.metaid = b.metaid
             OR (b.globalmetaid IS NOT NULL AND TRIM(b.globalmetaid) != ''
               AND s.global_metaid = b.globalmetaid))
           AND r.created_at >= ? AND r.created_at < ?`,
        [metabotId, dayStartMs, dayEndMs],
      )?.n) ?? serviceRatings.length;
      dropCounters.serviceRatings += Math.max(0, total - MAX_SERVICE_RATINGS_PER_DAY);
    }

    return {
      sessions,
      taskRuns,
      orderCount: parseIdNumber(orderCountRow?.n) ?? 0,
      groupTasks: [...acceptedTasks, ...activeTasks],
      groupChats,
      chainWrites,
      chainReads,
      serviceRatings,
    };
  }

  // ── RSI P0: prediction ledger ──────────────────────────────────────────────

  /**
   * Record one pre-action prediction (the prediction_record tool validates the
   * expectation schema deterministically; this write normalizes and persists).
   */
  recordPrediction(input: {
    metabotId: number;
    sessionId?: string | null;
    source: PredictionSource;
    actionType: PredictionActionType;
    subjectRef?: string | null;
    predictionText: string;
    expectation: Record<string, unknown>;
    resolveDeadline: string;
  }): MetabotPrediction {
    const id = uuidv4();
    const now = Date.now();
    this.db.run(`
      INSERT INTO metabot_predictions (
        id, metabot_id, created_at, session_id, source, action_type, subject_ref,
        prediction_text, expectation_json, resolve_deadline, status, resolved_at,
        resolved_by, outcome_text, outcome_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL)
    `, [
      id,
      input.metabotId,
      now,
      input.sessionId ?? null,
      PREDICTION_SOURCES.includes(input.source) ? input.source : 'cowork',
      input.actionType,
      input.subjectRef?.trim() || null,
      input.predictionText.trim(),
      JSON.stringify(input.expectation ?? {}),
      input.resolveDeadline,
    ]);
    this.saveDb();
    const row = this.getPrediction(id);
    if (!row) throw new Error('Failed to load prediction after insert');
    return row;
  }

  getPrediction(id: string): MetabotPrediction | null {
    const row = this.getOne<PredictionRow>(
      'SELECT * FROM metabot_predictions WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? this.mapPredictionRow(row) : null;
  }

  /** Open predictions for one bot, oldest deadline first (reconciliation order). */
  listPendingPredictions(metabotId: number, opts: { limit?: number } = {}): MetabotPrediction[] {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    return this.getAll<PredictionRow>(`
      SELECT * FROM metabot_predictions
      WHERE metabot_id = ? AND status = 'pending'
      ORDER BY resolve_deadline ASC, created_at ASC
      LIMIT ?
    `, [metabotId, limit]).map((row) => this.mapPredictionRow(row));
  }

  /**
   * Resolve one prediction. Idempotent: only a 'pending' row moves, so a
   * repeated nightly pass never rewrites a verdict.
   */
  resolvePrediction(id: string, input: {
    status: Exclude<PredictionStatus, 'pending'>;
    resolvedBy: string;
    outcomeText?: string | null;
    outcomeJson?: Record<string, unknown> | null;
    resolvedAtMs?: number;
  }): boolean {
    this.db.run(`
      UPDATE metabot_predictions
      SET status = ?, resolved_at = ?, resolved_by = ?, outcome_text = ?, outcome_json = ?
      WHERE id = ? AND status = 'pending'
    `, [
      input.status,
      Math.floor(input.resolvedAtMs ?? Date.now()),
      input.resolvedBy,
      input.outcomeText ?? null,
      input.outcomeJson ? JSON.stringify(input.outcomeJson) : null,
      id,
    ]);
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /**
   * Calibration aggregate for the dream prompt digest: per action type the
   * status counts over the trailing `sinceDays` (windowed on created_at), plus
   * the current pending backlog and the most recent misses/partials. RRSI P5
   * adds the same counts folded by source class (internal vs external) — the
   * OOD held-out split; unknown sources are skipped.
   */
  listPredictionCalibration(metabotId: number, sinceDays = 30): PredictionCalibrationDigest {
    const windowDays = Math.max(1, Math.floor(sinceDays));
    const sinceMs = Date.now() - windowDays * 86_400_000;
    const countRows = this.getAll<{ action_type: string; status: string; n: number | string }>(`
      SELECT action_type, status, COUNT(*) AS n
      FROM metabot_predictions
      WHERE metabot_id = ? AND created_at >= ?
      GROUP BY action_type, status
    `, [metabotId, sinceMs]);
    const sourceRows = this.getAll<{ source: string; status: string; n: number | string }>(`
      SELECT source, status, COUNT(*) AS n
      FROM metabot_predictions
      WHERE metabot_id = ? AND created_at >= ?
      GROUP BY source, status
    `, [metabotId, sinceMs]);
    const pendingRow = this.getOne<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM metabot_predictions WHERE metabot_id = ? AND status = 'pending'`,
      [metabotId],
    );
    const missRows = this.getAll<PredictionRow>(`
      SELECT * FROM metabot_predictions
      WHERE metabot_id = ? AND status IN ('miss', 'partial') AND resolved_at IS NOT NULL AND resolved_at >= ?
      ORDER BY resolved_at DESC
      LIMIT ?
    `, [metabotId, sinceMs, PREDICTION_DIGEST_MAX_RECENT_MISSES]);

    const byActionType: PredictionCalibrationDigest['byActionType'] = {};
    for (const actionType of PREDICTION_ACTION_TYPES) {
      byActionType[actionType] = { hit: 0, miss: 0, partial: 0, expired: 0, resolved: 0, hitRate: null };
    }
    for (const row of countRows) {
      const bucket = byActionType[row.action_type as PredictionActionType];
      if (!bucket) continue;
      const n = parseIdNumber(row.n) ?? 0;
      if (row.status === 'hit') bucket.hit += n;
      else if (row.status === 'miss') bucket.miss += n;
      else if (row.status === 'partial') bucket.partial += n;
      else if (row.status === 'expired') bucket.expired += n;
    }
    for (const bucket of Object.values(byActionType)) {
      bucket.resolved = bucket.hit + bucket.miss + bucket.partial;
      bucket.hitRate = bucket.resolved > 0 ? bucket.hit / bucket.resolved : null;
    }
    const bySourceClass: PredictionCalibrationDigest['bySourceClass'] = {
      internal: { hit: 0, miss: 0, partial: 0, expired: 0, resolved: 0, hitRate: null },
      external: { hit: 0, miss: 0, partial: 0, expired: 0, resolved: 0, hitRate: null },
    };
    for (const row of sourceRows) {
      const bucket = bySourceClass[PREDICTION_SOURCE_CLASS[row.source as PredictionSource]];
      if (!bucket) continue;
      const n = parseIdNumber(row.n) ?? 0;
      if (row.status === 'hit') bucket.hit += n;
      else if (row.status === 'miss') bucket.miss += n;
      else if (row.status === 'partial') bucket.partial += n;
      else if (row.status === 'expired') bucket.expired += n;
    }
    for (const bucket of Object.values(bySourceClass)) {
      bucket.resolved = bucket.hit + bucket.miss + bucket.partial;
      bucket.hitRate = bucket.resolved > 0 ? bucket.hit / bucket.resolved : null;
    }
    return {
      windowDays,
      pendingCount: parseIdNumber(pendingRow?.n) ?? 0,
      byActionType,
      bySourceClass,
      recentMisses: missRows.map((row) => {
        const mapped = this.mapPredictionRow(row);
        return {
          actionType: mapped.actionType,
          status: mapped.status === 'partial' ? 'partial' as const : 'miss' as const,
          predictionText: mapped.predictionText,
          outcomeText: mapped.outcomeText,
          resolvedAt: mapped.resolvedAt,
        };
      }),
    };
  }

  /**
   * Ledger hygiene: physically remove terminal (resolved) rows older than the
   * cutoff. Pending rows are never pruned — they are reconciled or expired by
   * the dream pass, never silently dropped.
   */
  pruneResolvedPredictions(input: { cutoffMs: number }): number {
    const cutoff = Math.floor(input.cutoffMs);
    if (!Number.isFinite(cutoff)) return 0;
    this.db.run(`
      DELETE FROM metabot_predictions
      WHERE status != 'pending' AND resolved_at IS NOT NULL AND resolved_at < ?
    `, [cutoff]);
    const deleted = this.db.getRowsModified?.() || 0;
    if (deleted > 0) {
      this.saveDb();
    }
    return deleted;
  }

  /**
   * Subject fallback for reception predictions recorded BEFORE the write
   * existed: the bot's earliest own chain write of the matching protocol at or
   * after the prediction was recorded (the action follows the prediction).
   */
  findOwnChainWriteForPrediction(
    metabotId: number,
    actionType: 'buzz_post' | 'metaweb_comment',
    afterMs: number,
  ): { pinId: string; occurredAtMs: number } | null {
    const pathPrefix = actionType === 'buzz_post' ? '/protocols/simplebuzz' : '/protocols/paycomment';
    const row = this.getOne<{ pin_id: string; occurred_at_ms: number | string }>(`
      SELECT pin_id, occurred_at_ms
      FROM metabot_chain_writes
      WHERE metabot_id = ? AND occurred_at_ms >= ? AND path LIKE ?
      ORDER BY occurred_at_ms ASC
      LIMIT 1
    `, [metabotId, Math.floor(afterMs), `${pathPrefix}%`]);
    return row ? { pinId: row.pin_id, occurredAtMs: Number(row.occurred_at_ms) || 0 } : null;
  }

  /** Final state read for service_delivery predictions (null = unknown order). */
  getServiceOrderStatus(orderId: string): string | null {
    const id = orderId.trim();
    if (!id) return null;
    const row = this.getOne<{ status: string }>(
      'SELECT status FROM service_orders WHERE id = ? LIMIT 1',
      [id],
    );
    return row?.status ?? null;
  }

  // ── RSI P0: prompt-layer snapshots (retention gate) ─────────────────────────

  /** Ids of the currently-active, hot-eligible procedures promoted from
   * capability drafts (RRSI P2: a demoted/rollback probation procedure left
   * the hot set but stays active for recall). */
  listActivePromotedProcedureIds(metabotId: number): string[] {
    return this.getAll<{ promoted_procedure_id: string }>(`
      SELECT d.promoted_procedure_id
      FROM capability_drafts d
      JOIN metaid_knowledge_procedures p ON p.id = d.promoted_procedure_id
      WHERE d.metabot_id = ? AND d.promoted_procedure_id IS NOT NULL AND p.status = 'active'
        AND COALESCE(p.hot_eligible, 1) = 1
    `, [metabotId]).map((row) => row.promoted_procedure_id);
  }

  // ── RRSI P3: usage evidence over hot_layer_usage (design §6.3) ────────────

  /**
   * The bot's exposure rows for one local date, hot injections first, then
   * repeat count, kind, id — the usage-audit pass reads its item list here.
   */
  listHotLayerExposures(metabotId: number, usageDate: string): HotLayerExposureRow[] {
    const id = Number(metabotId);
    const date = String(usageDate ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    try {
      return this.getAll<{
        item_kind: 'technique' | 'procedure' | 'knowledge' | 'memory';
        item_id: string;
        exposure: 'hot' | 'recall';
        exposure_count: number | string;
        applied: number | null;
        audited_at: number | string | null;
      }>(`
        SELECT item_kind, item_id, exposure, exposure_count, applied, audited_at
        FROM hot_layer_usage
        WHERE metabot_id = ? AND usage_date = ?
        ORDER BY exposure = 'hot' DESC, exposure_count DESC, item_kind ASC, item_id ASC
      `, [id, date]).map((row) => ({
        kind: row.item_kind as HotLayerExposureRow['kind'],
        itemId: String(row.item_id),
        exposure: row.exposure,
        exposureCount: Math.max(0, Math.floor(Number(row.exposure_count) || 0)),
        applied: row.applied == null ? null : Number(row.applied) === 1,
        auditedAt: row.audited_at == null ? null : Number(row.audited_at),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no such table')) return [];
      throw error;
    }
  }

  /**
   * Write the usage-audit verdicts back into the day's exposure rows
   * (applied / evidence / audited_at). Re-auditing the same date overwrites,
   * so a version-repair re-run is idempotent. Returns rows changed.
   */
  recordHotLayerUsageVerdicts(
    metabotId: number,
    usageDate: string,
    verdicts: Array<{
      kind: 'technique' | 'procedure' | 'knowledge' | 'memory';
      itemId: string;
      applied: boolean;
      evidence: { labels: string[]; channels: Array<'owner' | 'external'> };
    }>,
    atMs: number,
  ): number {
    const id = Number(metabotId);
    const date = String(usageDate ?? '').trim();
    const stamp = Math.floor(Number(atMs));
    if (!Number.isInteger(id) || id <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp)) return 0;
    const rows = (verdicts ?? []).filter((verdict) =>
      (verdict?.kind === 'technique' || verdict?.kind === 'procedure'
        || verdict?.kind === 'knowledge' || verdict?.kind === 'memory')
      && typeof verdict?.itemId === 'string' && verdict.itemId.length > 0);
    if (rows.length === 0) return 0;
    let changed = 0;
    for (const verdict of rows) {
      this.db.run(
        `UPDATE hot_layer_usage
         SET applied = ?, evidence = ?, audited_at = ?
         WHERE metabot_id = ? AND usage_date = ? AND item_kind = ? AND item_id = ?`,
        [
          verdict.applied ? 1 : 0,
          JSON.stringify({ labels: verdict.evidence?.labels ?? [], channels: verdict.evidence?.channels ?? [] }),
          stamp,
          id, date, verdict.kind, verdict.itemId,
        ],
      );
      changed += this.db.getRowsModified?.() || 0;
    }
    this.saveDb();
    return changed;
  }

  /** Trailing-window usage stats per item (shared aggregation helper). */
  listHotLayerUsageStats(
    metabotId: number,
    input: { kind: 'technique' | 'procedure' | 'knowledge' | 'memory'; sinceDate: string; untilDate: string; itemIds?: readonly string[] },
  ): Map<string, HotLayerUsageStats> {
    return queryHotLayerUsageStats(this.db, { metabotId, ...input });
  }

  /**
   * Capture the current dream-origin prompt layer (all non-deleted
   * dream-origin memories EXCEPT self_identity, plus the active promoted
   * procedure ids) and store it as the snapshot for (metabot, dreamDate).
   * One snapshot per date (upsert); any previous 'active' snapshot of this bot
   * is superseded, and the table is pruned to ROLLBACK_MAX_SNAPSHOTS_PER_BOT
   * rows per bot (oldest superseded/rolled_back first — never the active one).
   */
  capturePromptLayerSnapshot(metabotId: number, dreamDate: string): PromptLayerSnapshot {
    const memories = this.getAll<{
      id: string;
      text: string;
      fingerprint: string | null;
      status: string;
      archived_at: number | string | null;
      usage_class: string | null;
    }>(`
      SELECT id, text, fingerprint, status, archived_at, usage_class
      FROM user_memories
      WHERE metabot_id = ? AND origin = 'dream' AND status != 'deleted' AND usage_class != 'self_identity'
      ORDER BY created_at ASC
    `, [metabotId]).map((row) => ({
      id: row.id,
      text: row.text,
      fingerprint: row.fingerprint ?? '',
      status: row.status,
      archivedAt: row.archived_at == null ? null : Number(row.archived_at),
      usageClass: row.usage_class ?? null,
    }));
    return this.savePromptLayerSnapshot({
      metabotId,
      dreamDate,
      payload: {
        version: 1,
        memories,
        promotedProcedureIds: this.listActivePromotedProcedureIds(metabotId),
      },
    });
  }

  savePromptLayerSnapshot(input: {
    metabotId: number;
    dreamDate: string;
    payload: PromptLayerSnapshotPayload;
  }): PromptLayerSnapshot {
    const now = Date.now();
    this.db.run(
      `UPDATE metabot_prompt_layer_snapshots SET status = 'superseded' WHERE metabot_id = ? AND status = 'active'`,
      [input.metabotId],
    );
    this.db.run(`
      INSERT INTO metabot_prompt_layer_snapshots (
        id, metabot_id, dream_date, created_at, payload_json, status, rollback_reason, rolled_back_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL)
      ON CONFLICT(metabot_id, dream_date) DO UPDATE SET
        created_at = excluded.created_at,
        payload_json = excluded.payload_json,
        status = 'active',
        rollback_reason = NULL,
        rolled_back_at = NULL
    `, [uuidv4(), input.metabotId, input.dreamDate, now, JSON.stringify(input.payload ?? {})]);
    // Retention: at most ROLLBACK_MAX_SNAPSHOTS_PER_BOT per bot — prune the
    // oldest superseded/rolled_back rows first, never the active one.
    this.db.run(`
      DELETE FROM metabot_prompt_layer_snapshots
      WHERE id IN (
        SELECT id FROM metabot_prompt_layer_snapshots
        WHERE metabot_id = ? AND status != 'active'
        ORDER BY dream_date DESC
        LIMIT -1 OFFSET ?
      )
    `, [input.metabotId, ROLLBACK_MAX_SNAPSHOTS_PER_BOT - 1]);
    this.saveDb();
    const snapshot = this.getPromptLayerSnapshot(input.metabotId, input.dreamDate);
    if (!snapshot) throw new Error('Failed to load prompt-layer snapshot after save');
    return snapshot;
  }

  getPromptLayerSnapshot(metabotId: number, dreamDate: string): PromptLayerSnapshot | null {
    const row = this.getOne<PromptLayerSnapshotRow>(
      'SELECT * FROM metabot_prompt_layer_snapshots WHERE metabot_id = ? AND dream_date = ? LIMIT 1',
      [metabotId, dreamDate],
    );
    return row ? this.mapSnapshotRow(row) : null;
  }

  /** The newest snapshot still eligible for rollback (status 'active'). */
  getActivePromptLayerSnapshot(metabotId: number): PromptLayerSnapshot | null {
    const row = this.getOne<PromptLayerSnapshotRow>(`
      SELECT * FROM metabot_prompt_layer_snapshots
      WHERE metabot_id = ? AND status = 'active'
      ORDER BY dream_date DESC
      LIMIT 1
    `, [metabotId]);
    return row ? this.mapSnapshotRow(row) : null;
  }

  /** Terminal rollback mark: a rolled-back date can never be rolled back again. */
  markPromptLayerSnapshotRolledBack(id: string, reason: string): boolean {
    this.db.run(`
      UPDATE metabot_prompt_layer_snapshots
      SET status = 'rolled_back', rollback_reason = ?, rolled_back_at = ?
      WHERE id = ? AND status = 'active'
    `, [reason.trim() || null, Date.now(), id]);
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /** Audit/test listing, newest dream date first. */
  listPromptLayerSnapshots(metabotId: number, limit = 30): PromptLayerSnapshot[] {
    const clampedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.getAll<PromptLayerSnapshotRow>(`
      SELECT * FROM metabot_prompt_layer_snapshots
      WHERE metabot_id = ?
      ORDER BY dream_date DESC
      LIMIT ?
    `, [metabotId, clampedLimit]).map((row) => this.mapSnapshotRow(row));
  }

  private mapPredictionRow(row: PredictionRow): MetabotPrediction {
    const parseJson = (raw: string | null): Record<string, unknown> | null => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    };
    const status = (PREDICTION_STATUSES as readonly string[]).includes(row.status) ? row.status as PredictionStatus : 'pending';
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      createdAt: Number(row.created_at),
      sessionId: row.session_id ?? null,
      source: (PREDICTION_SOURCES as readonly string[]).includes(row.source) ? row.source as PredictionSource : 'cowork',
      actionType: (PREDICTION_ACTION_TYPES as readonly string[]).includes(row.action_type)
        ? row.action_type as PredictionActionType
        : 'buzz_post',
      subjectRef: row.subject_ref ?? null,
      predictionText: row.prediction_text,
      expectation: parseJson(row.expectation_json) ?? {},
      resolveDeadline: row.resolve_deadline,
      status,
      resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
      resolvedBy: row.resolved_by ?? null,
      outcomeText: row.outcome_text ?? null,
      outcomeJson: parseJson(row.outcome_json),
    };
  }

  private mapSnapshotRow(row: PromptLayerSnapshotRow): PromptLayerSnapshot {
    let payload: PromptLayerSnapshotPayload = { version: 1, memories: [], promotedProcedureIds: [] };
    try {
      const parsed = JSON.parse(row.payload_json ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        payload = {
          version: 1,
          memories: Array.isArray(record.memories)
            ? record.memories
              .filter((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string')
              .map((item) => {
                const entry = item as Record<string, unknown>;
                return {
                  id: String(entry.id),
                  text: typeof entry.text === 'string' ? entry.text : '',
                  fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint : '',
                  status: typeof entry.status === 'string' ? entry.status : 'created',
                  archivedAt: typeof entry.archivedAt === 'number' && Number.isFinite(entry.archivedAt) ? entry.archivedAt : null,
                  usageClass: typeof entry.usageClass === 'string' ? entry.usageClass : null,
                };
              })
            : [],
          promotedProcedureIds: Array.isArray(record.promotedProcedureIds)
            ? record.promotedProcedureIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
            : [],
        };
      }
    } catch {
      // A corrupt payload reads as an empty layer — rollback then only
      // tombstones the rolled-back date's batch (the safe half).
    }
    return {
      id: row.id,
      metabotId: parseIdNumber(row.metabot_id) ?? 0,
      dreamDate: row.dream_date,
      createdAt: Number(row.created_at),
      payload,
      status: row.status === 'rolled_back' || row.status === 'superseded' ? row.status : 'active',
      rollbackReason: row.rollback_reason ?? null,
      rolledBackAt: row.rolled_back_at == null ? null : Number(row.rolled_back_at),
    };
  }

  /**
   * Hygiene retention for dream bookkeeping: terminal runs (completed AND
   * failed — failed rows still drive retries, but only inside the 7-day
   * lookback, so past the horizon they are dead weight) and their fragment
   * caches older than the cutoff date key are physically removed. Running
   * rows are always kept: they may belong to an in-flight dream.
   */
  purgeOldRunsAndFragments(input: {
    cutoffDateKey: string;
    excludeMetabotIds?: ReadonlySet<number>;
  }): { runsDeleted: number; fragmentsDeleted: number } {
    const cutoffDate = input.cutoffDateKey.trim();
    if (!cutoffDate) return { runsDeleted: 0, fragmentsDeleted: 0 };
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const metabotExclusion = excluded.length > 0
      ? ` AND metabot_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';

    this.db.run('BEGIN IMMEDIATE');
    try {
      this.db.run(
        `DELETE FROM metabot_dream_runs
         WHERE status IN ('completed', 'failed') AND dream_date < ?${metabotExclusion}`,
        [cutoffDate, ...excluded],
      );
      const runsDeleted = this.db.getRowsModified?.() || 0;
      this.db.run(
        `DELETE FROM metabot_dream_fragments
         WHERE dream_date < ?${metabotExclusion}`,
        [cutoffDate, ...excluded],
      );
      const fragmentsDeleted = this.db.getRowsModified?.() || 0;
      this.db.run('COMMIT');
      if (runsDeleted > 0 || fragmentsDeleted > 0) {
        this.saveDb();
      }
      return { runsDeleted, fragmentsDeleted };
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }
}
