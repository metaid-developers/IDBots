import { app } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SqliteDatabase as Database } from './sqliteTypes';
import type { SqliteReadWorkerLike } from './sqliteReadWorker';
import { v4 as uuidv4 } from 'uuid';
import {
  extractTurnMemoryChanges,
  isSubstantiveMemoryText,
  type CoworkMemoryGuardLevel,
} from './libs/coworkMemoryExtractor';
import {
  judgeMemoryCandidate,
  judgeTurnMemoryExtraction,
  type TurnMemoryExtractionChange,
} from './libs/coworkMemoryJudge';
import { evaluateConversationMemoryQuality } from './libs/coworkMemoryQuality';
import { mergeTradeBadge, scanMessageTradeBadge } from './libs/tradeBadge';
import { stripLoneSurrogates, truncateUtf16Units } from './libs/llmSafeText';
import type { RecentSessionPulseEntry } from './libs/recentSessionsPrompt';
import { recordChainBackupTombstones } from './libs/chainBackupTombstones';
import {
  parseSessionGoal,
  serializeSessionGoal,
  type CoworkSessionGoal,
} from './libs/coworkSessionGoal';
import { normalizePracticeComponent, type PracticeComponent } from './libs/evolutionExploration';
import { normalizeCapabilityScope, type CapabilityScope } from './libs/capabilitySpecificity';
import type {
  MemoryBackend,
  MemoryCreateUserMemoryInput,
  MemoryDeleteUserMemoryInput,
  MemoryListUserMemoriesOptions,
  MemoryScopeSelectorInput,
  MemoryScopesOverview,
  MemoryScopeSummary,
  MemorySessionScopeResolution,
  MemoryUpdateUserMemoryInput,
  MemoryUserMemoryStats,
} from './memory/memoryBackend';
import {
  OWNER_SCOPE_KEY,
  createOwnerMemoryScope,
  normalizeMemoryScopeSelector,
  normalizeScopeChannel,
  normalizeScopeIdentity,
  parseContactScopeKey,
  type MemoryOrigin,
  type MemoryScope,
  type MemoryScopeKind,
  type MemoryUsageClass,
  type MemoryVisibility,
} from './memory/memoryScope';
import { resolveMemoryScopes, type ResolveMemoryScopesInput } from './memory/memoryScopeResolver';
import { clampMemoryPromptMaxChars } from './memory/memoryPromptBlocks';
import {
  FALSIFIED_BLOCK_DAYS,
  hypothesisTitleKey,
} from './libs/capabilityGateRegularizers';
import { clampMemoryImportance, deriveMemoryImportance } from './memory/memoryImportance';
import {
  normalizeMemoryMatchKey,
  normalizeMemorySemanticKey,
  scoreMemorySimilarity,
} from './memory/memorySimilarity';
import { applyMemoryDefense, defendMemoryQuote, MemoryDefenseError } from './memory/memoryDefense';
import {
  MEMORY_EVIDENCE_QUOTES_PER_MEMORY,
  MEMORY_REVISIONS_KEEP_PER_MEMORY,
  normalizeMemoryQuote,
  pickEvidenceQuote,
  type MemoryEvidenceSummary,
  type MemoryRevision,
  type MemoryRevisionReason,
} from './memory/memoryEvidence';
import { BOT_WORKSPACE_DIR_NAME, formatBotWorkspaceDate } from './libs/botWorkspace';
import { queryHotLayerUsageStats } from './libs/hotLayerUsageQueries';
import {
  HOT_LAYER_FRESH_SLOTS,
  HOT_LAYER_GRACE_DAYS,
  HOT_LAYER_UTILITY_WINDOW_DAYS,
  rankHotLayerItems,
} from './libs/hotLayerPruning';
import { shiftDateKey } from './libs/predictionLedger';
import {
  normalizeMemoryHygieneConfig,
  type MemoryHygieneConfig,
  type MemoryHygieneRunStats,
} from './libs/memoryHygienePolicy';
import { resolveCoworkExecutionMode } from './libs/coworkExecutionMode';
import {
  buildA2AChainMetadata,
  extractTxidFromA2AChainPinId,
  normalizeA2AChainTxid,
  type A2AChainMetadata,
} from './services/a2aChainMetadata';
import {
  buildCanonicalPrivateConversationExternalConversationId,
  buildOrderProtocolDisplayMetadata,
} from './services/simplemsgPeerConversation';
import {
  isA2ALiveWorkMessage,
  isA2ASystemErrorMessage,
  shouldHideA2AInternalMessage,
  type A2AHideContext,
} from './shared/a2aInternalMessageFilter';
import { resolveServerWorkspacePath } from './server/serverMode';

// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  // REQ-A-7: server mode defaults the cowork workspace to /data/workspace
  // (C1); desktop keeps ~/idbots/project.
  return resolveServerWorkspacePath(path.join(os.homedir(), 'idbots', 'project'));
};

const TASK_WORKSPACE_CONTAINER_DIR = '.idbots-tasks';

// Matches the per-bot dated workspace layout produced by libs/botWorkspace:
// <root>/bots/<metabotId>/<YYYY-MM-DD>. Recent-workspace entries normalize
// back to the root so date folders do not flood the picker list.
const BOT_DATED_WORKSPACE_RE = new RegExp(
  `[\\\\/]${BOT_WORKSPACE_DIR_NAME}[\\\\/]\\d+[\\\\/]\\d{4}-\\d{2}-\\d{2}(?=[\\\\/]|$)`
);

const normalizeRecentWorkspacePath = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}${TASK_WORKSPACE_CONTAINER_DIR}${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex > 0) {
    return resolved.slice(0, markerIndex);
  }
  const botWorkspaceMatch = BOT_DATED_WORKSPACE_RE.exec(resolved);
  if (botWorkspaceMatch && botWorkspaceMatch.index > 0) {
    return resolved.slice(0, botWorkspaceMatch.index);
  }
  return resolved;
};

const DEFAULT_MEMORY_ENABLED = true;
const DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED = true;
const DEFAULT_MEMORY_LLM_JUDGE_ENABLED = true;
const DEFAULT_MEMORY_GUARD_LEVEL: CoworkMemoryGuardLevel = 'strict';
const DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS = 30; // quota audit 2026-09-17 (F1): was 20
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 120; // quota audit 2026-09-17 (F1): was 60
const MEMORY_NEAR_DUPLICATE_MIN_SCORE = 0.82;
/**
 * Cross-night dream-write dedup (memory/persona audit P1): the bar sits below
 * MEMORY_NEAR_DUPLICATE_MIN_SCORE because dream distillations reword the same
 * rule much more freely than a same-scope restatement (production evidence:
 * one「付费写链授权硬规则」rule came back as three wording variants across
 * three nights).
 */
const DREAM_CROSS_NIGHT_DEDUP_MIN_SCORE = 0.75;
/** Incoming dream text replaces the stored wording only when materially richer. */
const DREAM_DEDUP_REPLACE_TEXT_MIN_LENGTH_RATIO = 1.3;
const MEMORY_OPERATIONAL_PREFERENCE_RE = /(默认语言|回复格式|输出风格|回复风格|尽量简洁|保持简短|reply(?:\s+in)?|respond(?:\s+in)?|language|format|style|tone|markdown|concise|brief)/i;
const MEMORY_PREFERENCE_RE = /(偏好|喜欢|prefer|preference|likes?|dislikes?)/i;
const SCOPED_USER_MEMORIES_BACKFILL_KEY = 'userMemories.scopeBackfill.v1.completed';
const MODEL_PROVIDER_METAID_FREE_MIGRATION_KEY = 'cowork.modelProviderMetaidFreeMigrated.v1';
const COWORK_MESSAGES_FTS_READY_KEY = 'cowork.messagesFtsReady.v1';
const COWORK_MESSAGES_FTS_CURSOR_KEY = 'cowork.messagesFtsCursorRowid.v1';
const COWORK_MESSAGES_FTS_INLINE_THRESHOLD = 5_000;
const COWORK_MESSAGES_FTS_BATCH_SIZE = 5_000;

const escapeFts5Phrase = (term: string): string => `"${term.replace(/"/g, '""')}"`;
const hasFtsTrigramMinLength = (term: string): boolean => Array.from(term).length >= 3;
const METAWEB_ORDER_SESSION_MIGRATION_KEY = 'cowork.metawebOrderSessionsToPeerConversations.v1.completed';
const METAWEB_ORDER_SIMPLEMSG_BACKFILL_KEY = 'cowork.backfillMetawebOrderSimplemsgMetadata.v1.completed';
const METAWEB_PRIVATE_SIMPLEMSG_BACKFILL_KEY = 'cowork.backfillMetawebPrivateSimplemsgMetadata.v1.completed';
/** Self-curriculum practice proposals (design 2026-10-10 §3.3): a 'pending'
 * proposal the owner never acted on expires after this many days. The sweep is
 * lazy — it runs inside every read/transition of the table. */
export const PRACTICE_PROPOSAL_TTL_DAYS = 3;
/**
 * Canonical JSON.stringify spelling of the metaweb-private sourceChannel flag.
 * Every metadata write goes through this store's stringify, so a LIKE on this
 * fragment is exact — it never matches a spaced or reordered spelling.
 */
const COWORK_METAWEB_PRIVATE_METADATA_FRAGMENT = '"sourceChannel":"metaweb_private"';
/**
 * The session-list activity key: the created_at of the last conversation event
 * that may reorder the sidebar. User turns count, and so do on-chain A2A private
 * DMs synced into the session (bot-driven owner threads must keep surfacing);
 * local stream chunks carry no sourceChannel metadata, so they never bump it —
 * that is the anti-flicker guarantee while several sessions run in parallel.
 */
const coworkActivityMessageMatch = (alias = ''): string =>
  `(${alias}type = 'user' OR ${alias}metadata LIKE '%${COWORK_METAWEB_PRIVATE_METADATA_FRAGMENT}%')`;
/**
 * The activity_at value of one session row: the stored column when it has been
 * stamped, else the pre-column computation (last activity message, else newest
 * message, else updated_at). `sessionRef` is the cowork_sessions reference the
 * subqueries correlate against ('s' in a SELECT, 'cowork_sessions' in an UPDATE).
 */
const coworkSessionActivityAtSelectSql = (sessionRef: string): string => `COALESCE((
          SELECT m.created_at
          FROM cowork_messages m INDEXED BY idx_cowork_messages_session_created_at
          WHERE m.session_id = ${sessionRef}.id
            AND ${coworkActivityMessageMatch('m.')}
          ORDER BY m.created_at DESC
          LIMIT 1
        ), (
          SELECT m.created_at
          FROM cowork_messages m INDEXED BY idx_cowork_messages_session_created_at
          WHERE m.session_id = ${sessionRef}.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ), ${sessionRef}.updated_at)`;
/** Activity key of a single session row, ignoring the stored column (may be NULL). */
const coworkSessionActivityAtMessageSql = (sessionRef: string): string => `(
          SELECT m.created_at
          FROM cowork_messages m INDEXED BY idx_cowork_messages_session_created_at
          WHERE m.session_id = ${sessionRef}.id
            AND ${coworkActivityMessageMatch('m.')}
          ORDER BY m.created_at DESC
          LIMIT 1
        )`;
const MEMORY_ROW_SELECT_COLUMNS = `
  id, text, fingerprint, confidence, is_explicit, status,
  created_at, updated_at, last_used_at, scope_kind, scope_key, usage_class, visibility, origin, archived_at, importance, occurred_at
`;
const PRIVATE_CHAT_SIMPLEMSG_BACKFILL_TIME_WINDOW_MS = 10 * 60 * 1000;
/**
 * How many of a session's newest messages a session view carries. The transcript
 * is paged from the bottom up from there (the A2A display window has always
 * worked this way); everything older is one "load earlier" away. 100 matches the
 * message page size the A2A window already used, so the same affordance walks
 * both session kinds.
 */
const COWORK_SESSION_VIEW_MESSAGE_LIMIT = 100;
const COWORK_MESSAGE_PAGE_LIMIT_MAX = 200;

/**
 * Page request normalization shared by the window and the page reader, so the
 * size a window advertises as pageSize is exactly the size it will page with.
 */
function normalizeCoworkMessagePageRequest(options?: {
  beforeSequence?: number | null;
  limit?: number;
}): { limit: number; beforeSequence: number | null } {
  const requestedLimit = Number(options?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(COWORK_MESSAGE_PAGE_LIMIT_MAX, Math.floor(requestedLimit)))
    : COWORK_SESSION_VIEW_MESSAGE_LIMIT;
  const requestedBeforeSequence = Number(options?.beforeSequence);
  const beforeSequence = Number.isFinite(requestedBeforeSequence) && requestedBeforeSequence > 0
    ? Math.floor(requestedBeforeSequence)
    : null;
  return { limit, beforeSequence };
}

/**
 * Wire format of a transcript page cursor: '<created_at>:<sequence>:<rowid>'.
 * Kept a plain string because it is a row key, not a value the renderer reads.
 */
function formatCoworkTranscriptCursor(row: CoworkMessageRow): string {
  const rowId = Number(row.rowid);
  const sequence = Number(row.sequence);
  return `${Math.floor(row.created_at)}:${Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 0}:${Number.isFinite(rowId) ? Math.floor(rowId) : 0}`;
}

function parseCoworkTranscriptCursor(raw: unknown): CoworkTranscriptCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  const match = /^(\d{1,15}):(\d{1,15}):(\d{1,15})$/.exec(raw);
  if (!match) return null;
  const createdAt = Number(match[1]);
  const sequence = Number(match[2]);
  const rowId = Number(match[3]);
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(sequence) || !Number.isSafeInteger(rowId)) {
    return null;
  }
  return { createdAt, sequence, rowId };
}

function normalizeMemoryGuardLevel(value: string | undefined): CoworkMemoryGuardLevel {
  if (value === 'strict' || value === 'standard' || value === 'relaxed') return value;
  return DEFAULT_MEMORY_GUARD_LEVEL;
}

function normalizeDreamPracticeProposalRiskClass(value?: string | null): DreamPracticeProposalRiskClass {
  return value === 'interact_local' || value === 'chain_write' ? value : 'read_only';
}

function parseBooleanConfig(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function clampMemoryUserMemoriesMaxItems(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS;
  return Math.max(
    MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
    Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(value))
  );
}

/**
 * Parse and validate the persisted last-workspace choice. A missing/invalid
 * record, or a folder/project whose cwd no longer exists, resolves to null so
 * the renderer falls back to the per-bot dated workspace. `botWorkspace` is
 * always valid (its cwd is computed at session start).
 */
function parseLastWorkspaceSelection(raw: string | undefined): CoworkWorkspaceSelection | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { kind?: unknown; cwd?: unknown; projectId?: unknown; name?: unknown };
  if (candidate.kind === 'botWorkspace') {
    return { kind: 'botWorkspace' };
  }
  if (candidate.kind === 'folder' && typeof candidate.cwd === 'string' && candidate.cwd.trim()) {
    const cwd = candidate.cwd.trim();
    return fs.existsSync(cwd) ? { kind: 'folder', cwd } : null;
  }
  if (
    candidate.kind === 'project'
    && typeof candidate.cwd === 'string' && candidate.cwd.trim()
    && typeof candidate.projectId === 'string' && candidate.projectId.trim()
    && typeof candidate.name === 'string' && candidate.name.trim()
  ) {
    const cwd = candidate.cwd.trim();
    return fs.existsSync(cwd)
      ? { kind: 'project', projectId: candidate.projectId.trim(), name: candidate.name.trim(), cwd }
      : null;
  }
  return null;
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const OCCURRED_ON_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Event-time axis (#3): validate + convert an extracted "occurred_on"
 * (YYYY-MM-DD, resolved against the turn's day by the judge) to epoch ms.
 * Null for timeless facts, malformed values, or dates absurdly in the future.
 */
function resolveOccurredAtEpochMs(occurredAt?: number | string | null): number | null {
  if (occurredAt == null) return null;
  if (typeof occurredAt === 'number') {
    return Number.isFinite(occurredAt) && occurredAt > 0 ? Math.floor(occurredAt) : null;
  }
  const value = occurredAt.trim();
  if (!OCCURRED_ON_RE.test(value)) return null;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) return null;
  if (epoch > Date.now() + 86_400_000) return null;
  return epoch;
}

function extractConversationSearchTerms(value: string): string[] {
  const normalized = normalizeMemoryText(value).toLowerCase();
  if (!normalized) return [];

  const terms: string[] = [];
  const seen = new Set<string>();
  const addTerm = (term: string): void => {
    const normalizedTerm = normalizeMemoryText(term).toLowerCase();
    if (!normalizedTerm) return;
    if (/^[a-z0-9]$/i.test(normalizedTerm)) return;
    if (seen.has(normalizedTerm)) return;
    seen.add(normalizedTerm);
    terms.push(normalizedTerm);
  };

  // Keep the full phrase and additionally match by per-token terms.
  addTerm(normalized);
  const tokens = normalized
    .split(/[\s,，、|/\\;；]+/g)
    .map((token) => token.replace(/^['"`]+|['"`]+$/g, '').trim())
    .filter(Boolean);

  for (const token of tokens) {
    addTerm(token);
    if (terms.length >= 8) break;
  }

  return terms.slice(0, 8);
}

function scoreMemoryTextQuality(value: string): number {
  const normalized = normalizeMemoryText(value);
  if (!normalized) return 0;
  let score = normalized.length;
  if (/^(?:该用户|这个用户|用户)\s*/u.test(normalized)) {
    score -= 12;
  }
  if (/^(?:the user|user)\b/i.test(normalized)) {
    score -= 12;
  }
  if (/^(?:我|我的|我是|我有|我会|我喜欢|我偏好)/u.test(normalized)) {
    score += 4;
  }
  if (/^(?:i|i am|i'm|my)\b/i.test(normalized)) {
    score += 4;
  }
  return score;
}

function choosePreferredMemoryText(currentText: string, incomingText: string): string {
  const normalizedCurrent = truncate(normalizeMemoryText(currentText), 360);
  const normalizedIncoming = truncate(normalizeMemoryText(incomingText), 360);
  if (!normalizedCurrent) return normalizedIncoming;
  if (!normalizedIncoming) return normalizedCurrent;

  const currentScore = scoreMemoryTextQuality(normalizedCurrent);
  const incomingScore = scoreMemoryTextQuality(normalizedIncoming);
  if (incomingScore > currentScore + 1) return normalizedIncoming;
  if (currentScore > incomingScore + 1) return normalizedCurrent;
  return normalizedIncoming.length >= normalizedCurrent.length ? normalizedIncoming : normalizedCurrent;
}

function isMeaningfulDeleteFragment(value: string): boolean {
  if (!value) return false;
  const tokens = value.split(/\s+/g).filter(Boolean);
  if (tokens.length >= 2) return true;
  if (/[\u3400-\u9fff]/u.test(value)) return value.length >= 4;
  return value.length >= 6;
}

function includesAsBoundedPhrase(target: string, fragment: string): boolean {
  if (!target || !fragment) return false;
  const paddedTarget = ` ${target} `;
  const paddedFragment = ` ${fragment} `;
  if (paddedTarget.includes(paddedFragment)) {
    return true;
  }
  // CJK phrases are often unsegmented, so token boundaries are unreliable.
  if (/[\u3400-\u9fff]/u.test(fragment) && !fragment.includes(' ')) {
    return target.includes(fragment);
  }
  return false;
}

function scoreDeleteMatch(targetKey: string, queryKey: string): number {
  if (!targetKey || !queryKey) return 0;
  if (targetKey === queryKey) {
    return 1000 + queryKey.length;
  }
  if (!isMeaningfulDeleteFragment(queryKey)) {
    return 0;
  }
  if (!includesAsBoundedPhrase(targetKey, queryKey)) {
    return 0;
  }
  return 100 + Math.min(targetKey.length, queryKey.length);
}

function buildMemoryFingerprint(text: string): string {
  const key = normalizeMemoryMatchKey(text);
  return crypto.createHash('sha1').update(key).digest('hex');
}

function truncate(value: string, maxChars: number): string {
  // Memory text is persisted AND re-rendered into prompts on every turn, so
  // the cut must never split a surrogate pair (see llmSafeText) — and any
  // rows polluted by the pre-fix hard cut are sanitized on read here too.
  const text = stripLoneSurrogates(value);
  if (text.length <= maxChars) return text;
  return `${truncateUtf16Units(text, maxChars - 1)}…`;
}

const MEMORY_TEXT_MAX_CHARS = 360;
/** self_identity holds the dream pipeline's four-part self-distillation
 * (200+ chars by contract, typically 350–600) — the generic 360-char memory
 * cap used to cut every identity entry mid-sentence. */
const SELF_IDENTITY_TEXT_MAX_CHARS = 1200;

function maxMemoryTextChars(usageClass?: string | null): number {
  return normalizeMemoryUsageClass(usageClass) === 'self_identity'
    ? SELF_IDENTITY_TEXT_MAX_CHARS
    : MEMORY_TEXT_MAX_CHARS;
}

function parseTimeToMs(input?: string | null): number | null {
  if (!input) return null;
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

function parseIdNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** MetaBot avatars may be stored as a BLOB; convert to a renderable data URL. */
function normalizeMetabotAvatarForDisplay(avatar: unknown): string | null {
  if (!avatar) return null;
  if (typeof avatar === 'string') return avatar.trim() || null;
  const buf = Buffer.from(avatar as Uint8Array);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function normalizeDbBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return fallback;
}

function normalizeMemoryUsageClass(value?: string | null): MemoryUsageClass {
  if (
    value === 'preference'
    || value === 'operational_preference'
    || value === 'self_identity'
    || value === 'work_review'
    || value === 'value_boundary'
  ) {
    return value;
  }
  return 'profile_fact';
}

function normalizeMemoryOrigin(value?: string | null): MemoryOrigin {
  return value === 'dream' ? 'dream' : 'conversation';
}

function normalizeMemoryVisibility(value?: string | null): MemoryVisibility {
  return value === 'external_safe' ? 'external_safe' : 'local_only';
}

function classifyMemoryText(text: string, scope: MemoryScope): {
  usageClass: MemoryUsageClass;
  visibility: MemoryVisibility;
} {
  const normalized = normalizeMemoryText(text);
  const usageClass = MEMORY_OPERATIONAL_PREFERENCE_RE.test(normalized)
    ? 'operational_preference'
    : MEMORY_PREFERENCE_RE.test(normalized)
      ? 'preference'
      : 'profile_fact';
  const visibility = scope.kind === 'owner' && usageClass === 'operational_preference'
    ? 'external_safe'
    : 'local_only';
  return { usageClass, visibility };
}

function inferPeerGlobalMetaIdFromConversationId(
  sourceChannel?: string | null,
  externalConversationId?: string | null
): string | null {
  if (normalizeScopeChannel(sourceChannel) !== 'metaweb_private') {
    return null;
  }
  const normalizedConversationId = normalizeScopeIdentity(externalConversationId);
  const match = normalizedConversationId.match(/^metaweb-private:(.+)$/);
  return match?.[1] ? normalizeScopeIdentity(match[1]) : null;
}

function parsePeerGlobalMetaIdFromMetadata(metadataJson?: string | null): string | null {
  if (!metadataJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadataJson) as { peerGlobalMetaId?: unknown };
    return normalizeScopeIdentity(
      typeof parsed.peerGlobalMetaId === 'string' ? parsed.peerGlobalMetaId : null
    ) || null;
  } catch {
    return null;
  }
}

function normalizeA2AParticipantId(value: string): string {
  return normalizeScopeIdentity(value).toLowerCase();
}

function hashA2AIdentity(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable across physical session rotation and directional for one local Bot's view. */
export function buildA2AConversationThreadId(localGlobalMetaId: string, peerGlobalMetaId: string): string {
  const local = normalizeA2AParticipantId(localGlobalMetaId);
  const peer = normalizeA2AParticipantId(peerGlobalMetaId);
  if (!local || !peer || local === peer) {
    throw new Error('Two distinct A2A participant GlobalMetaIDs are required');
  }
  return `a2a-thread:${hashA2AIdentity(`${local}>${peer}`)}`;
}

/** Direction-independent key reserved for future pair-wide history aggregation. */
export function buildA2AParticipantPairKey(localGlobalMetaId: string, peerGlobalMetaId: string): string {
  const participants = [
    normalizeA2AParticipantId(localGlobalMetaId),
    normalizeA2AParticipantId(peerGlobalMetaId),
  ].sort();
  if (!participants[0] || !participants[1] || participants[0] === participants[1]) {
    throw new Error('Two distinct A2A participant GlobalMetaIDs are required');
  }
  return `a2a-pair:${hashA2AIdentity(participants.join('|'))}`;
}

// Types mirroring src/types/cowork.ts for main process use
// 'error_retried' (清单 #12): an orchestration attempt failed AND the step was
// already retried with a fresh attempt — the session is a historical failure,
// distinguishable from an un-attended 'error'.
// 'stopped': the session was terminated before finishing (task cancelled, or
// stopped via the Twin's worker_session_stop) — a deliberate terminal state,
// never shown as 'running' again.
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error' | 'error_retried' | 'stopped';
export type CoworkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';
export type CoworkSessionType = 'standard' | 'a2a' | 'browser' | 'group_task' | 'longterm';
/**
 * Why a session was created without a human asking for it. Mirrors the
 * `auto_origin` column on cowork_sessions; NULL means human-initiated.
 * 'longterm' = [长期] long-term task session (incl. rotations),
 * 'orchestration' = [编排任务] delegation session,
 * 'schedule' = [定时] scheduled-task run session.
 */
export type CoworkSessionAutoOrigin = 'longterm' | 'orchestration' | 'schedule';
/**
 * Manual placement of a session in the sidebar's "Autonomous Tasks" fold,
 * mirroring the `fold_override` column. It wins over the auto-origin fold
 * policy: 'out' pulls an auto-created row back into the main conversation list,
 * 'in' parks a human row in the fold. NULL = no manual placement, so the policy
 * (shouldFoldIntoAutonomousTasks) decides.
 */
export type CoworkSessionFoldOverride = 'in' | 'out';
/**
 * Which lane put a session into the "Follow-Up Tasks" (待跟进任务) bucket,
 * mirroring the `follow_up_source` column. 'cerebellum' = the turn-end
 * classifier judged the latest turn to be waiting on the owner; 'ask_user' =
 * an AskUserQuestion is pending on the session; 'manual' = the owner moved
 * the row by hand (manual pins are sticky — the classifier never clears
 * them). NULL = the session is not pending human follow-up.
 */
export type CoworkSessionFollowUpSource = 'cerebellum' | 'ask_user' | 'manual';
export type CoworkPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
export type CoworkSteerStatus = 'queued' | 'delivered' | 'settled' | 'failed' | 'cancelled';
const SERVICE_ORDER_RATING_SESSION_HOLD_MS = 24 * 60 * 60 * 1000;

export interface CoworkMessageMetadata {
  interactionKind?: 'steer';
  submissionId?: string;
  submissionMode?: 'steer' | 'continue';
  steerStatus?: CoworkSteerStatus;
  steerDeliveredAt?: number;
  steerSettledAt?: number;
  steerFailedAt?: number;
  steerCancelledAt?: number;
  steerErrorCode?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  isDelegationInternal?: boolean;
  skillIds?: string[];
  /** Marks a user turn filled verbatim from a quick action (建议操作) entry. */
  source?: 'quick_action';
  /**
   * Origin of a user-type message — who/what submitted this turn
   * (composer, heartbeat, scheduled task, cross-session forward, MetaWeb
   * group/private relay, orchestrator, ...). Absent on legacy messages; the
   * renderer falls back to heuristics and finally 'user'.
   */
  origin?: 'user' | 'quick_action' | 'heartbeat' | 'schedule' | 'cross_session' | 'metaweb_group' | 'metaweb_private' | 'orchestrator' | 'group_task' | 'daily_report';
  /** Optional human-readable detail for the origin (e.g. scheduled task name). */
  originLabel?: string;
  /**
   * Ids of the whole messages this user message quotes (the reply entry), in
   * fragment order. Jump anchors for the sent quote blocks: the ordinal baked
   * into the block label is window-relative display copy that shifts whenever
   * an older history page loads, while ids stay stable.
   */
  quotedMessageIds?: string[];
  suppressRunningStatus?: boolean;
  [key: string]: unknown;
}

export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  /**
   * Per-session monotonic transcript position (MAX(sequence)+1 on insert;
   * absent on rows predating the column). The renderer uses it to detect a
   * dropped stream event: a jump in the live tail means a whole message never
   * arrived and the open session must be reloaded.
   */
  sequence?: number;
  metadata?: CoworkMessageMetadata;
}

export interface CoworkMessagePage {
  messages: CoworkMessage[];
  hasMoreBefore: boolean;
  beforeSequence: number | null;
  /**
   * Cursor for the next older page of a non-A2A window. Non-A2A sessions page in
   * transcript order (created_at, sequence, ROWID), which a bare sequence cannot
   * address — a migrated copy appends turns with old timestamps and fresh
   * sequences. Opaque to the renderer, which only ever hands it back.
   */
  beforeTranscriptCursor?: string | null;
}

export interface CoworkA2AHistoryCursor {
  /** Null fields together request the first page strictly below the anchor episode. */
  episodeIndex: number | null;
  beforeSequence: number | null;
}

export interface CoworkA2AHistoryMessage {
  sessionId: string;
  episodeIndex: number;
  message: CoworkMessage;
}

export interface CoworkA2AHistoryPage {
  threadId: string;
  participantPairKey: string;
  messages: CoworkA2AHistoryMessage[];
  hasMoreBefore: boolean;
  beforeCursor: CoworkA2AHistoryCursor | null;
}

export interface CoworkA2AConversationThread {
  id: string;
  participantPairKey: string;
  localMetabotId: number;
  localGlobalMetaId: string;
  peerGlobalMetaId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkA2AConversationEpisode {
  sessionId: string;
  threadId: string;
  episodeIndex: number;
  previousSessionId: string | null;
  nextSessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  closeReason: string | null;
  /** LLM handoff summary written when the episode closes via rollover. */
  summary: string | null;
}

export interface RegisterCoworkA2AEpisodeInput {
  sessionId: string;
  localMetabotId: number;
  localGlobalMetaId: string;
  peerGlobalMetaId: string;
  episodeIndex?: number;
  previousSessionId?: string | null;
  startedAt: number;
  endedAt?: number | null;
  closeReason?: string | null;
  previousCloseReason?: string | null;
}

export interface CoworkMessageHistoryState {
  hasMoreBefore: boolean;
  beforeSequence: number | null;
  pageSize: number;
  /**
   * A2A thread aggregation: episode index of the cross-episode paging cursor.
   * null/undefined while paging is still inside the current episode's
   * session-scoped window; set once "load earlier" crosses into previous
   * episodes of the thread.
   */
  beforeEpisodeIndex?: number | null;
  /**
   * Non-A2A sessions page in transcript order, whose cursor is a row key rather
   * than a sequence. Opaque to the renderer: it holds the value the window was
   * handed and passes it back to load earlier. Null once the start of the
   * transcript is reached.
   */
  beforeTranscriptCursor?: string | null;
}

export interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: CoworkSessionStatus;
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  activeSkillIds: string[];
  messages: CoworkMessage[];
  /**
   * IM channel that owns this session (`im:qq:group` / `im:qq:direct`). Read
   * from the conversation mapping so legacy IM rows stored as 'a2a' are shown
   * and rendered as IM rows without rewriting their session_type.
   */
  imChannel?: string | null;
  /** External conversation id behind `imChannel` (e.g. `qq:group:<openid>`). */
  imConversationId?: string | null;
  /** Renderer-only bounded history state. Absent for full internal session reads. */
  messageHistory?: CoworkMessageHistoryState;
  createdAt: number;
  updatedAt: number;
  /** FK to metabots.id; which MetaBot persona this session uses */
  metabotId?: number | null;
  /** Session type: 'standard' = human↔MetaBot, 'a2a' = MetaBot↔MetaBot */
  sessionType?: CoworkSessionType;
  /** Remote peer MetaBot's globalmetaid (A2A sessions only) */
  peerGlobalMetaId?: string | null;
  /** Remote peer MetaBot's display name (A2A sessions only) */
  peerName?: string | null;
  /** Remote peer MetaBot's avatar data URL (A2A sessions only) */
  peerAvatar?: string | null;
  /** Bot Browser context: URI of the tab this session is about (browser sessions only) */
  browserUri?: string | null;
  /** Bot Browser context: title of the tab this session is about (browser sessions only) */
  browserTitle?: string | null;
  /**
   * Bot Internet projector sessions (owner ruling 2026-11-07): set at
   * creation from the Bot Internet co-work panel; the session runs assistant
   * mode regardless of the global chatExperienceMode. Never flipped after
   * creation.
   */
  assistantMode?: boolean;
  hiddenFromSessionList?: boolean;
  /**
   * Auto-origin marker for sessions the app created on its own (long-term task
   * runs, orchestration/delegation runs, scheduled-task runs). Long-term and
   * orchestration rows fold into the sidebar's collapsed "Autonomous Tasks"
   * section (see sessionAutoGrouping). null/undefined = human-initiated.
   */
  autoOrigin?: CoworkSessionAutoOrigin | null;
  /**
   * Manual fold placement (see CoworkSessionFoldOverride); null = follow the
   * auto-origin policy. The renderer's fold membership reads this first.
   */
  foldOverride?: CoworkSessionFoldOverride | null;
  /**
   * Follow-up state for the sidebar's "Follow-Up Tasks" (待跟进任务) section:
   * 'pending' = the session currently needs a human decision or reply,
   * null/undefined = not waiting on the owner. Set and cleared by the
   * cerebellum turn-end classifier, the AskUserQuestion bridge, and manual
   * owner moves.
   */
  followUpState?: 'pending' | null;
  /** Which lane set the follow-up marker (see CoworkSessionFollowUpSource); null = none. */
  followUpSource?: CoworkSessionFollowUpSource | null;
  /** ISO timestamp of the last follow-up transition; null = never transitioned. */
  followUpAt?: string | null;
  /** Local MetaBot's display name (populated from metabots table) */
  metabotName?: string | null;
  /** Local MetaBot's avatar data URL (populated from metabots table) */
  metabotAvatar?: string | null;
  /** Permission mode for tool gating. Defaults to 'default'. Can change mid-session. */
  permissionMode?: CoworkPermissionMode;
  /** Per-session model override (null = inherit the global default model). */
  model?: string | null;
  /**
   * Provider key the session model was picked from. Disambiguates colliding
   * model ids (e.g. deepseek and opencode both serve deepseek-v4-flash).
   * Null on legacy rows and when the session inherits the bot/global default.
   */
  modelProvider?: string | null;
  /** Per-session reasoning effort (off/low/high/max, or the 'default' sentinel = explicit Default pick; null = follow the model default chain). */
  effort?: string | null;
  /** Source session id when this session was created by forking another session. */
  parentSessionId?: string | null;
  /** The source session's message id this fork was created from. */
  forkPointMessageId?: string | null;
  /** FK to projects.id; the Settings > Projects project this conversation is bound to. */
  projectId?: string | null;
  /** Session goal set via the composer /goal command; null = none. */
  goal?: CoworkSessionGoal | null;
}

export type CoworkSessionMetadata = Pick<
  CoworkSession,
  | 'id'
  | 'title'
  | 'status'
  | 'pinned'
  | 'createdAt'
  | 'updatedAt'
  | 'metabotId'
  | 'sessionType'
  | 'peerGlobalMetaId'
  | 'peerName'
  | 'hiddenFromSessionList'
>;

export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  metabotId?: number | null;
  /** Only populated by listArchivedSessions. */
  archivedAt?: number | null;
  sessionType?: CoworkSessionType;
  peerName?: string | null;
  /** Remote peer MetaBot's avatar (A2A sessions only) */
  peerAvatar?: string | null;
  peerAvatarVersion?: number | null;
  /** Owning MetaBot's display name, when attributed */
  metabotName?: string | null;
  /**
   * Owning MetaBot's avatar (data URL or remote URL), when attributed. Only
   * getSession populates it; list rows carry metabotAvatarVersion and the
   * renderer resolves the image through the avatar cache instead.
   */
  metabotAvatar?: string | null;
  /**
   * Revision of the owning MetaBot row (metabots.updated_at) the identity
   * fields came from — the freshness key of the renderer's avatar cache.
   */
  metabotAvatarVersion?: number | null;
  /** Bot Browser context: URI of the tab this session is about (browser sessions only) */
  browserUri?: string | null;
  /** Bot Browser context: title of the tab this session is about (browser sessions only) */
  browserTitle?: string | null;
  assistantMode?: boolean;
  /** Per-session model override (null = inherit the global default model). */
  model?: string | null;
  /** Provider key for the session model override (see CoworkSession.modelProvider). */
  modelProvider?: string | null;
  /** Per-session reasoning effort (off/low/high/max, or the 'default' sentinel; null = follow the model default chain). */
  effort?: string | null;
  hiddenFromSessionList?: boolean;
  /**
   * IM channel that owns this session (`im:qq:group` / `im:qq:direct`), read
   * from cowork_conversation_mappings. Display-layer only: it lets the session
   * list badge an IM row without a destructive `session_type` migration of
   * rows created before IM sessions were classified as 'standard'.
   */
  imChannel?: string | null;
  /** External conversation id behind `imChannel` (e.g. `qq:group:<openid>`). */
  imConversationId?: string | null;
  /** Auto-origin marker (see CoworkSession.autoOrigin); null = human-initiated. */
  autoOrigin?: CoworkSessionAutoOrigin | null;
  /** Manual fold placement (see CoworkSession.foldOverride); null = follow the policy. */
  foldOverride?: CoworkSessionFoldOverride | null;
  /** Follow-up state (see CoworkSession.followUpState); 'pending' = needs a human decision. */
  followUpState?: 'pending' | null;
  /** Which lane set the follow-up marker (see CoworkSessionFollowUpSource); null = none. */
  followUpSource?: CoworkSessionFollowUpSource | null;
  /** ISO timestamp of the last follow-up transition; null = never transitioned. */
  followUpAt?: string | null;
  /** FK to projects.id; the Settings > Projects project this conversation is bound to. */
  projectId?: string | null;
  /** Working directory the session runs in; used by the sidebar's by-project grouping. */
  cwd?: string | null;
}

export type CoworkUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface CoworkUserMemory {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: CoworkUserMemoryStatus;
  scopeKind?: MemoryScope['kind'];
  scopeKey?: string;
  usageClass?: MemoryUsageClass;
  visibility?: MemoryVisibility;
  origin?: MemoryOrigin;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /**
   * Dream review P1 (2026-10-23): stamped ONLY when the nightly hot-layer
   * usage audit judges the memory APPLIED in a reply (evidence-cited) —
   * injection touches last_used_at, application touches this. Hygiene decay
   * and prompt eviction read COALESCE(last_applied_at, last_used_at, ...).
   */
  lastAppliedAt?: number | null;
  /** Hygiene decay mark: archived dream memories leave injection but stay restorable. */
  archivedAt?: number | null;
  /** Recall weight: high-importance memories get guaranteed injection and late eviction. */
  importance: number;
  /**
   * Event-time axis (#3): when the underlying fact/event happened (epoch ms),
   * distinct from createdAt ("when we learned it"). Null = timeless or
   * recorded before the column existed.
   */
  occurredAt?: number | null;
  /**
   * Evidence ledger: active provenance rows corroborating this memory
   * (populated by listUserMemories; absent elsewhere = neutral in ranking).
   */
  proofCount?: number;
}

export interface CoworkUserMemorySource {
  id: string;
  memoryId: string;
  sessionId: string | null;
  messageId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  isActive: boolean;
  createdAt: number;
}

export interface CoworkUserMemorySourceInput {
  sessionId?: string;
  messageId?: string;
  role?: 'user' | 'assistant' | 'tool' | 'system';
  sourceChannel?: string;
  sourceType?: string;
  externalConversationId?: string;
  sourceId?: string;
  /** Dream pipeline: the YYYY-MM-DD this memory was distilled from. */
  dreamDate?: string;
  /**
   * Evidence ledger: the verbatim excerpt this source contributed (capped at
   * MEMORY_EVIDENCE_QUOTE_MAX_CHARS). Storage + idle-time input only; never
   * rendered into a turn.
   */
  quote?: string;
}

/** One L3b procedural-memory draft row (`capability_drafts`, SDD §4.1). */
export interface CapabilityDraft {
  id: number;
  metabotId: number;
  dreamDate: string;
  title: string;
  description: string;
  capabilityType: string;
  status: string;
  createdAt: number;
  /** Dream-time validation pass outcome; NULL while never validated. */
  validationScore: number | null;
  validationNotes: string | null;
  validatedAt: number | null;
  /** P2 utilization: how often this draft was rendered into a prompt. */
  timesInjected: number;
  lastInjectedAt: number | null;
  /** P2 promotion: when/into which procedure this draft was promoted (NULL = never). */
  promotedAt: number | null;
  promotedProcedureId: string | null;
  /** P1 re-review: the last time the verdict panel looked at this draft (NULL = never). */
  lastReviewedAt: number | null;
  /** Memory reconciliation (design 2026-10-10 §4.4): recorded applicability
   * conditions / residual uncertainty (NULL = never reconciled). */
  conditionsText: string | null;
  uncertaintyText: string | null;
  /** RRSI P2: the procedure this draft is the probation ticket for (NULL =
   * a dream-distilled draft). */
  sourceProcedureId: string | null;
  /** RRSI P3: when a validated draft was demoted to 'dormant' for never
   * being applied (NULL = not dormant). */
  dormantAt: number | null;
  /** RRSI P5 specificity verdict from reconciliation (NULL = not assessed,
   * behaves exactly like general). */
  scope: CapabilityScope | null;
  /** Distillation provenance (dream review P0): NULL = the dream output's own
   * capability_learnings; 'positive_replay' = the 👍-grounded positive replay
   * pass. */
  origin: string | null;
}

interface CapabilityDraftRow {
  id: number | string;
  metabot_id: number | string;
  dream_date: string;
  title: string;
  description: string;
  capability_type: string;
  status: string;
  created_at: number | string;
  validation_score?: number | null;
  validation_notes?: string | null;
  validated_at?: number | string | null;
  times_injected?: number | string | null;
  last_injected_at?: number | string | null;
  promoted_at?: number | string | null;
  promoted_procedure_id?: string | null;
  last_reviewed_at?: number | string | null;
  conditions_text?: string | null;
  uncertainty_text?: string | null;
  source_procedure_id?: string | null;
  dormant_at?: number | string | null;
  scope?: string | null;
  origin?: string | null;
}

/** Shared column list for every capability-draft SELECT (mapped by
 * CoworkStore.mapCapabilityDraftRow; new columns are added in one place). */
const CAPABILITY_DRAFT_COLUMNS = `id, metabot_id, dream_date, title, description, capability_type, status, created_at,
             validation_score, validation_notes, validated_at, times_injected, last_injected_at,
             promoted_at, promoted_procedure_id, last_reviewed_at, conditions_text, uncertainty_text,
             source_procedure_id, dormant_at, scope, origin`;

/** Which gate pass falsified a hypothesis (RRSI P1 ledger provenance). */
export type CapabilityFalsifiedSource = 'validation' | 're_review';

/** One `capability_falsified_hypotheses` row — the bot's edit history of
 * falsified ideas (design §6.1 P1.3); re-falsification upserts the row. */
export interface CapabilityFalsifiedHypothesis {
  id: number;
  metabotId: number;
  title: string;
  titleKey: string;
  description: string;
  reason: string;
  source: CapabilityFalsifiedSource;
  sourceDraftId: number | null;
  falsifiedAt: number;
  hitCount: number;
  lastHitAt: number | null;
}

/** Which hot-layer kind an exposure row tracks (RRSI P2, design §6.2 P2.4).
 * Dream review P1 (2026-10-23) widens the set: 'knowledge' = metaid knowledge
 * hot-layer entries, 'memory' = injected value_boundary / work_review
 * user_memories. The hot_layer_usage CHECK constraint is widened by a
 * table-rebuild migration in sqliteStore. */
export type HotLayerItemKind = 'technique' | 'procedure' | 'knowledge' | 'memory';

/** How the item reached the model: always-on injection or on-demand recall. */
export type HotLayerExposure = 'hot' | 'recall';

/** hot_layer_usage retention horizon in days (hygiene step, RRSI P2). */
export const HOT_LAYER_USAGE_RETENTION_DAYS = 120;

/** Outcome of a checked capability-draft insert (RRSI P1). */
export interface CapabilityDraftInsertResult {
  inserted: number;
  insertedIds: number[];
  skippedDuplicate: number;
  skippedFalsified: number;
}

interface CapabilityFalsifiedRow {
  id: number | string;
  metabot_id: number | string;
  title: string;
  title_key: string;
  description: string;
  reason: string;
  source: string;
  source_draft_id: number | string | null;
  falsified_at: number | string;
  hit_count: number | string;
  last_hit_at: number | string | null;
}

/** Risk class of a dream-proposed practice task (design 2026-10-10 §3.2). */
export type DreamPracticeProposalRiskClass = 'read_only' | 'interact_local' | 'chain_write';

/**
 * Lifecycle of one dream_practice_proposals row (design 2026-10-10 §3.3):
 * pending → approved → scheduled → completed|failed; pending → expired (lazy
 * TTL); pending|approved → rejected (owner, any point before scheduled).
 */
export type DreamPracticeProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'completed'
  | 'failed'
  | 'expired';

/** One dream_practice_proposals row (self-curriculum, design 2026-10-10 §3.3). */
export interface DreamPracticeProposalRecord {
  id: number;
  metabotId: number;
  dreamDate: string;
  title: string;
  /** Full self-contained task prompt for the practice cowork session. */
  prompt: string;
  rationale: string | null;
  /** Recorded-weakness citations (draft:<id>, procedure:<id>, surf:<runId>, date:<YYYY-MM-DD>). */
  targetRefs: string[];
  expectedEvidence: string | null;
  riskClass: DreamPracticeProposalRiskClass;
  /** Which practice component the proposal exercises (RRSI P4); NULL = unknown / pre-P4. */
  component: PracticeComponent | null;
  status: DreamPracticeProposalStatus;
  /** Link to the materialized scheduled task (scheduled_tasks.id), NULL until scheduled. */
  scheduledTaskId: string | null;
  /** Link to the executed run (scheduled_task_runs.id), NULL until executed. */
  runId: string | null;
  /** Filled by the next dream's consumption pass. */
  outcomeSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DreamPracticeProposalRow {
  id: number | string;
  metabot_id: number | string;
  dream_date: string;
  title: string;
  prompt: string;
  rationale?: string | null;
  target_refs_json?: string | null;
  expected_evidence?: string | null;
  risk_class?: string | null;
  component?: string | null;
  status: string;
  scheduled_task_id?: string | null;
  run_id?: string | null;
  outcome_summary?: string | null;
  created_at: number | string;
  updated_at: number | string;
}

export interface CoworkUserMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

export interface CoworkConversationSearchRecord {
  sessionId: string;
  title: string;
  updatedAt: number;
  url: string;
  human: string;
  assistant: string;
}

/** One verbatim message hit inside ONE session (conversation_recall). */
export interface CoworkSessionMessageSearchHit {
  id: string;
  type: 'user' | 'assistant';
  createdAt: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  /** Combined char budget for the injected memory blocks (oldest-first eviction). Global-only: no per-bot column to avoid a metabot_memory_policies migration. */
  memoryPromptMaxChars: number;
  /** Last workspace choice in the New Task composer (null = fall back to bot workspace). */
  lastWorkspaceSelection: CoworkWorkspaceSelection | null;
}

/** The New Task composer's persisted workspace choice (mirrors the renderer union). */
export type CoworkWorkspaceSelection =
  | { kind: 'project'; projectId: string; name: string; cwd: string }
  | { kind: 'folder'; cwd: string }
  | { kind: 'botWorkspace' };

export interface CoworkMemoryPolicy {
  metabotId: number;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  dreamEnabled: boolean;
  hygieneEnabled: boolean;
  /** Self-curriculum practice tasks (design 2026-10-10 §3.4); default off. */
  practiceTasksEnabled: boolean;
  /** Auto-approve read_only practice proposals (only effective with practiceTasksEnabled). */
  practiceAutoApproveReadOnly: boolean;
  updatedAt: number;
}

export interface CoworkEffectiveMemoryPolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  memoryPromptMaxChars: number;
  dreamEnabled: boolean;
  hygieneEnabled: boolean;
  /** Self-curriculum practice tasks (design 2026-10-10 §3.4); default off. */
  practiceTasksEnabled: boolean;
  /** Auto-approve read_only practice proposals (only effective with practiceTasksEnabled). */
  practiceAutoApproveReadOnly: boolean;
  source: 'global' | 'metabot';
}

export interface CoworkConversationMapping {
  channel: string;
  externalConversationId: string;
  metabotId: number | null;
  coworkSessionId: string;
  metadataJson: string | null;
  createdAt: number;
  lastActiveAt: number;
}

export type CoworkConfigUpdate = Partial<Pick<
  CoworkConfig,
  | 'workingDirectory'
  | 'executionMode'
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'memoryPromptMaxChars'
  | 'lastWorkspaceSelection'
>>;

export interface ApplyTurnMemoryUpdatesOptions {
  sessionId: string;
  userText: string;
  assistantText: string;
  implicitEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  guardLevel: CoworkMemoryGuardLevel;
  userMessageId?: string;
  assistantMessageId?: string;
}

export interface ApplyTurnMemoryUpdatesResult {
  totalChanges: number;
  created: number;
  updated: number;
  deleted: number;
  judgeRejected: number;
  llmReviewed: number;
  skipped: number;
  /** Memory defense (#6): candidates refused for containing secrets. */
  defenseRejected: number;
}

let cachedDefaultSystemPrompt: string | null = null;

const getDefaultSystemPrompt = (): string => {
  if (cachedDefaultSystemPrompt !== null) {
    return cachedDefaultSystemPrompt;
  }

  try {
    const promptPath = path.join(app.getAppPath(), 'sandbox', 'agent-runner', 'AGENT_SYSTEM_PROMPT.md');
    cachedDefaultSystemPrompt = fs.readFileSync(promptPath, 'utf-8');
  } catch (error) {
    console.warn('Failed to load default system prompt:', error);
    cachedDefaultSystemPrompt = '';
  }

  return cachedDefaultSystemPrompt;
};

interface CoworkMessageRow {
  id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
  sequence: number | null;
  /** Selected only where the row key itself is the page cursor. */
  rowid?: number;
}

/**
 * Row key of a transcript-order page cursor, in the (created_at, sequence,
 * ROWID) order the transcript is read in. Not part of the IPC contract: the
 * store hands the renderer an opaque string and parses it back.
 */
interface CoworkTranscriptCursor {
  createdAt: number;
  sequence: number;
  rowId: number;
}

interface MetawebOrderMessageBackfillRow {
  message_id: string;
  session_id: string;
  message_type?: string | null;
  metabot_id: number | string | null;
  peer_global_metaid: string | null;
  content: string;
  message_created_at: number | string | null;
  metadata: string | null;
  external_conversation_id: string;
  mapping_metadata_json: string | null;
}

interface MetawebPrivateMessageBackfillRow extends MetawebOrderMessageBackfillRow {
  local_global_metaid: string | null;
}

interface ServiceOrderSimplemsgBackfillRow {
  order_message_pin_id: string | null;
  delivery_message_pin_id: string | null;
  order_pin_id?: string | null;
  payment_txid?: string | null;
  order_message_txid?: string | null;
}

interface ServiceOrderSimplemsgBackfillMatchRow extends ServiceOrderSimplemsgBackfillRow {
  match_count?: number | string | null;
}

interface OrderBackfillIdentifiers {
  messageMappingExternalId: string;
  messageOrderTxid: string;
  mappingOrderTxid: string;
  messagePaymentTxid: string;
  mappingPaymentTxid: string;
  messageOrderPinId: string;
  mappingOrderPinId: string;
  orderMessageTxid: string;
  orderPinId: string;
  paymentTxid: string;
  role: 'buyer' | 'seller' | '';
  peerGlobalMetaId: string;
  metabotId: number | null;
}

interface PrivateChatSimplemsgBackfillRow {
  pin_id: string | null;
  tx_id: string | null;
  chain_timestamp: number | string | null;
  content?: string | null;
}

interface MetawebOrderBackfillPatch {
  content?: string;
  chainMetadata: A2AChainMetadata | null;
  extraMetadata?: CoworkMessageMetadata;
  removeMetadataKeys?: string[];
}

interface CoworkUserMemoryRow {
  id: string;
  text: string;
  fingerprint: string;
  confidence: number;
  is_explicit: number;
  status: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  last_applied_at?: number | null;
  metabot_id?: number | null;
  scope_kind?: string | null;
  scope_key?: string | null;
  usage_class?: string | null;
  visibility?: string | null;
  origin?: string | null;
  archived_at?: number | string | null;
  importance?: number | string | null;
  occurred_at?: number | string | null;
}

interface CoworkUserMemorySourceRow {
  session_id: string | null;
  source_channel: string | null;
  external_conversation_id: string | null;
  created_at: number | string;
}

interface CoworkMemoryPolicyRow {
  metabot_id: number | string;
  memory_enabled: number | string | null;
  memory_implicit_update_enabled: number | string | null;
  memory_llm_judge_enabled: number | string | null;
  memory_guard_level: string | null;
  memory_user_memories_max_items: number | string | null;
  dream_enabled?: number | string | null;
  hygiene_enabled?: number | string | null;
  practice_tasks_enabled?: number | string | null;
  practice_auto_approve_read_only?: number | string | null;
  updated_at: number | string | null;
}

interface CoworkConversationMappingRow {
  channel: string;
  external_conversation_id: string;
  metabot_id: number | string;
  cowork_session_id: string;
  metadata_json: string | null;
  created_at: number | string;
  last_active_at: number | string;
}

interface CoworkA2AThreadRow {
  id: string;
  participant_pair_key: string;
  local_metabot_id: number | string;
  local_global_metaid: string;
  peer_global_metaid: string;
  created_at: number | string;
  updated_at: number | string;
}

interface CoworkA2AEpisodeRow {
  session_id: string;
  thread_id: string;
  episode_index: number | string;
  previous_session_id: string | null;
  next_session_id: string | null;
  started_at: number | string;
  ended_at: number | string | null;
  close_reason: string | null;
  summary: string | null;
}

interface CoworkA2AHistoryRow extends CoworkMessageRow {
  session_id: string;
  episode_index: number | string;
}

interface MemoryScopeResolutionContext {
  sourceChannel?: string | null;
  externalConversationId?: string | null;
  sessionType?: CoworkSessionType | null;
  peerGlobalMetaId?: string | null;
}

export class CoworkStore implements MemoryBackend {
  private db: Database;
  private saveDb: () => void;
  private memoryBackend: MemoryBackend | null = null;
  /** Debounce anchor for last_used_at touch saves (full-file writes on wasm). */
  private lastMemoryTouchSaveAt: number | null = null;
  /**
   * Dream review P3: in-process write-behind buffer for hot_layer exposure
   * rows. High-frequency turns used to UPSERT once per rendered item per
   * turn; rows accumulate here and flush on a ≤5s unref'd timer, at 200
   * buffered keys, or via flushHotLayerExposureBuffer() (app shutdown).
   * Pure telemetry — a crash loses at most the buffer window.
   */
  private hotLayerExposureBuffer = new Map<string, {
    metabotId: number;
    usageDate: string;
    kind: HotLayerItemKind;
    id: string;
    exposure: HotLayerExposure;
    count: number;
    firstExposedAt: number;
  }>();
  private hotLayerExposureFlushTimer: ReturnType<typeof setInterval> | null = null;

  // In-memory tracking of delegation-blocked sessions
  private delegationBlockedSessions: Map<string, { orderId: string }> = new Map();
  // Whether the generated heal columns exist; false keeps the boot heals on
  // the legacy metadata LIKE scans.
  private coworkMessageHealColumnsReady = false;
  private messagesFtsAvailable = false;
  private messagesFtsReady = false;

  constructor(db: Database, saveDb: () => void, options?: { deferHeavyStartupMaintenance?: boolean }) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureSchemaCompatibility(Boolean(options?.deferHeavyStartupMaintenance));
  }

  getMemoryBackend(): MemoryBackend {
    return this.memoryBackend || this;
  }

  setMemoryBackend(backend: MemoryBackend | null): void {
    this.memoryBackend = backend;
  }

  /**
   * Set or clear delegation-blocking state for a cowork session.
   * When a delegation pipeline is in progress (waiting for remote service delivery),
   * the session is blocked to prevent user interaction.
   */
  setDelegationBlocking(sessionId: string, blocking: boolean, orderId?: string): void {
    if (blocking && orderId) {
      this.delegationBlockedSessions.set(sessionId, { orderId });
    } else {
      this.delegationBlockedSessions.delete(sessionId);
    }
  }

  /**
   * Returns true if the session is currently blocked waiting for a delegated
   * remote service to deliver its result.
   */
  isDelegationBlocking(sessionId: string): boolean {
    return this.delegationBlockedSessions.has(sessionId);
  }

  /**
   * Returns the delegation blocking info (orderId) for a session, or null
   * if the session is not in delegation-blocking mode.
   */
  getDelegationInfo(sessionId: string): { orderId: string } | null {
    return this.delegationBlockedSessions.get(sessionId) || null;
  }

  private ensureSchemaCompatibility(deferHeavyStartupMaintenance = false): void {
    this.ensureSessionPromptsSchema();
    this.ensureMemorySchemaCompatibility();
    this.ensureMemoryPolicySchemaCompatibility();
    this.ensureConversationMappingSchemaCompatibility();
    this.ensureA2AConversationSchemaCompatibility();
    this.ensureCoworkMessageHealColumns();
    this.ensureCoworkMessageIndexes();
    this.ensureCoworkMessagesFtsSchema(deferHeavyStartupMaintenance);
    this.ensureCoworkSessionIndexes();
    this.backfillScopedMemoryMetadata();
    this.restoreMissingSelfIdentities();
    if (deferHeavyStartupMaintenance) {
      return;
    }
    this.runHeavyStartupMaintenance();
  }

  runHeavyStartupMaintenance(): {
    migratedMetawebOrderSessions: number;
    backfilledMetawebOrderMessages: number;
    backfilledMetawebPrivateMessages: number;
    backfilledSessionActivityAt: number;
    migratedInlineSessionPrompts: number;
  } {
    const migratedMetawebOrderSessions = this.migrateMetawebOrderSessionsToPeerConversations();
    const backfilledMetawebOrderMessages = this.backfillMetawebOrderSimplemsgMetadata();
    const backfilledMetawebPrivateMessages = this.backfillMetawebPrivateSimplemsgMetadata();
    // The transcript-order indexes are built here rather than in the ensure
    // tier: the first build reads every message row, which on a multi-GB
    // database is exactly the kind of one-time cost the deferred tier exists
    // for. Every query stays correct without them, only sorted instead of
    // index-ordered.
    this.ensureCoworkMessageWindowIndexes();
    // Order matters: the metadata backfills above can tag legacy rows as
    // metaweb_private, and those rows must count toward the activity stamp.
    const backfilledSessionActivityAt = this.backfillSessionActivityAt();
    const migratedInlineSessionPrompts = this.backfillSessionPromptsOutOfLine();
    this.backfillMessagesFtsBatch(COWORK_MESSAGES_FTS_BATCH_SIZE);
    return {
      migratedMetawebOrderSessions,
      backfilledMetawebOrderMessages,
      backfilledMetawebPrivateMessages,
      backfilledSessionActivityAt,
      migratedInlineSessionPrompts,
    };
  }

  isMessagesFtsReady(): boolean {
    return this.messagesFtsReady;
  }

  private canUseMessagesFts(terms: readonly string[]): boolean {
    return (
      this.messagesFtsAvailable
      && this.messagesFtsReady
      && terms.length > 0
      && terms.every(hasFtsTrigramMinLength)
    );
  }

  private ensureCoworkMessagesFtsSchema(deferHeavyBackfill = false): void {
    if (!this.tableExists('cowork_messages')) {
      return;
    }
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS cowork_messages_fts USING fts5(
          content,
          content='cowork_messages',
          content_rowid='rowid',
          tokenize='trigram'
        )
      `);
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS trg_cowork_messages_fts_ai
        AFTER INSERT ON cowork_messages
        BEGIN
          INSERT INTO cowork_messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END
      `);
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS trg_cowork_messages_fts_ad
        AFTER DELETE ON cowork_messages
        BEGIN
          INSERT INTO cowork_messages_fts(cowork_messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        END
      `);
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS trg_cowork_messages_fts_au
        AFTER UPDATE OF content ON cowork_messages
        BEGIN
          INSERT INTO cowork_messages_fts(cowork_messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
          INSERT INTO cowork_messages_fts(rowid, content)
          VALUES (new.rowid, new.content);
        END
      `);
      this.messagesFtsAvailable = true;
      if (this.getKvValue(COWORK_MESSAGES_FTS_READY_KEY) === '1') {
        this.messagesFtsReady = true;
        return;
      }
      const maxRow = this.getOne<{ max_rowid: number }>(
        'SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM cowork_messages',
      );
      const maxRowid = Number(maxRow?.max_rowid ?? 0) || 0;
      if (maxRowid === 0) {
        this.setKvValue(COWORK_MESSAGES_FTS_CURSOR_KEY, '0');
        this.setKvValue(COWORK_MESSAGES_FTS_READY_KEY, '1');
        this.messagesFtsReady = true;
        return;
      }
      if (!deferHeavyBackfill && maxRowid <= COWORK_MESSAGES_FTS_INLINE_THRESHOLD) {
        this.backfillMessagesFtsBatch(COWORK_MESSAGES_FTS_INLINE_THRESHOLD + 1);
      }
    } catch {
      this.messagesFtsAvailable = false;
      this.messagesFtsReady = false;
    }
  }

  backfillMessagesFtsBatch(batchSize = COWORK_MESSAGES_FTS_BATCH_SIZE): { indexed: number; done: boolean } {
    if (!this.messagesFtsAvailable) {
      return { indexed: 0, done: true };
    }
    if (this.messagesFtsReady || this.getKvValue(COWORK_MESSAGES_FTS_READY_KEY) === '1') {
      this.messagesFtsReady = true;
      return { indexed: 0, done: true };
    }
    try {
      const cursor = Math.max(0, Number(this.getKvValue(COWORK_MESSAGES_FTS_CURSOR_KEY) ?? 0) || 0);
      const limit = Math.max(100, Math.floor(batchSize));
      const rows = this.getAll<{ rowid: number }>(
        'SELECT rowid FROM cowork_messages WHERE rowid > ? ORDER BY rowid ASC LIMIT ?',
        [cursor, limit],
      );
      if (rows.length === 0) {
        this.setKvValue(COWORK_MESSAGES_FTS_READY_KEY, '1');
        this.messagesFtsReady = true;
        return { indexed: 0, done: true };
      }
      const endRowid = Number(rows[rows.length - 1]!.rowid);
      this.db.run('BEGIN TRANSACTION');
      try {
        this.db.run(
          `INSERT INTO cowork_messages_fts(rowid, content)
           SELECT rowid, content FROM cowork_messages
           WHERE rowid > ? AND rowid <= ?`,
          [cursor, endRowid],
        );
        this.db.run('COMMIT');
      } catch (innerError) {
        try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
        throw innerError;
      }
      this.setKvValue(COWORK_MESSAGES_FTS_CURSOR_KEY, String(endRowid));
      const done = rows.length < limit;
      if (done) {
        this.setKvValue(COWORK_MESSAGES_FTS_READY_KEY, '1');
        this.messagesFtsReady = true;
      }
      return { indexed: rows.length, done };
    } catch (error) {
      console.warn('[CoworkStore] FTS5 batch backfill failed:', error);
      return { indexed: 0, done: true };
    }
  }

  private ensureSessionPromptsSchema(): void {
    if (!this.tableExists('cowork_sessions')) {
      return;
    }
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS cowork_session_prompts (
          session_id TEXT PRIMARY KEY,
          system_prompt TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
        )
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify cowork_session_prompts schema:', error);
    }
  }

  private backfillSessionPromptsOutOfLine(): number {
    if (!this.tableExists('cowork_sessions') || !this.tableExists('cowork_session_prompts')) {
      return 0;
    }
    try {
      const hasInline = this.getOne<{ found: number }>(`
        SELECT 1 AS found
        FROM cowork_sessions
        WHERE system_prompt IS NOT NULL AND system_prompt != ''
        LIMIT 1
      `);
      if (!hasInline) {
        return 0;
      }
      this.db.run('BEGIN TRANSACTION');
      try {
        this.db.run(`
          INSERT INTO cowork_session_prompts (session_id, system_prompt, updated_at)
          SELECT id, system_prompt, updated_at
          FROM cowork_sessions
          WHERE system_prompt IS NOT NULL AND system_prompt != ''
          ON CONFLICT(session_id) DO UPDATE SET
            system_prompt = excluded.system_prompt,
            updated_at = excluded.updated_at
        `);
        this.db.run(`
          UPDATE cowork_sessions
          SET system_prompt = ''
          WHERE system_prompt IS NOT NULL AND system_prompt != ''
        `);
        const changed = this.db.getRowsModified?.() || 0;
        this.db.run('COMMIT');
        if (changed > 0) {
          this.saveDb();
        }
        return changed;
      } catch (innerError) {
        try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
        throw innerError;
      }
    } catch (error) {
      console.warn('[CoworkStore] Failed to move cowork_sessions.system_prompt out of line:', error);
      return 0;
    }
  }

  /**
   * Stamp activity_at for every session row that predates the column (or was
   * left NULL by a write path). One statement, idempotent, re-entrant: rows
   * already stamped are not touched, so a re-run after an interrupted boot
   * continues where it left off. The value is the pre-column computation, so
   * an upgraded database lists in exactly the order it did before.
   */
  private backfillSessionActivityAt(): number {
    if (!this.tableExists('cowork_sessions') || !this.tableExists('cowork_messages')) {
      return 0;
    }
    try {
      this.db.run(`
        UPDATE cowork_sessions
        SET activity_at = ${coworkSessionActivityAtSelectSql('cowork_sessions')}
        WHERE activity_at IS NULL
      `);
      const changed = this.db.getRowsModified?.() || 0;
      if (changed > 0) {
        this.saveDb();
      }
      return changed;
    } catch (error) {
      console.warn('[CoworkStore] Failed to backfill cowork session activity_at:', error);
      return 0;
    }
  }

  private ensureCoworkMessageIndexes(): void {
    if (!this.tableExists('cowork_messages')) {
      return;
    }
    try {
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_created_at
        ON cowork_messages(session_id, created_at DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_sequence
        ON cowork_messages(session_id, sequence DESC)
      `);
      this.saveDb();
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify cowork_messages indexes:', error);
    }
  }

  /**
   * Heal columns for the boot-time leftover-state scans, so those queries stop
   * scanning every metadata blob. Both are VIRTUAL generated columns: any
   * insert or update keeps them correct without touching a single write path.
   * The matched substrings are the canonical JSON.stringify spelling of the
   * metadata flags (every metadata write goes through this store).
   */
  /**
   * Indexes that turn the transcript order into an index-ordered walk.
   *
   * The transcript order is (created_at, sequence, ROWID) — the order
   * getSessionMessages returns, the order a message page walks, and the order
   * getSession rewinds along. An index on (session_id, created_at, sequence)
   * carries the rowid last implicitly, so a forward scan yields that order
   * exactly (older-message pages, the full transcript) and a backward scan
   * yields its exact reverse (the newest-first window). The sequence-led index
   * does the same for the newest-first page whose cursor is a sequence.
   *
   * Every ORDER BY these serve used to spell sequence as COALESCE(sequence, 0),
   * an expression no index can order by, so each page materialized the whole
   * session into a temp B-tree before applying its LIMIT.
   */
  private ensureCoworkMessageWindowIndexes(): void {
    if (!this.tableExists('cowork_messages')) {
      return;
    }
    try {
      let changed = false;
      if (!this.indexExists('idx_cowork_messages_session_created_sequence')) {
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_created_sequence
          ON cowork_messages(session_id, created_at, sequence)
        `);
        changed = true;
      }
      if (!this.indexExists('idx_cowork_messages_session_sequence_created')) {
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_sequence_created
          ON cowork_messages(session_id, sequence, created_at)
        `);
        changed = true;
      }
      if (changed) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('[CoworkStore] Failed to build cowork_messages transcript-order indexes:', error);
    }
  }

  private ensureCoworkMessageHealColumns(): void {
    if (!this.tableExists('cowork_messages')) {
      return;
    }
    try {
      const colsResult = this.db.exec('PRAGMA table_xinfo(cowork_messages);');
      const columns = (colsResult[0]?.values || []).map((row) => String(row[1]));
      let changed = false;
      if (!columns.includes('is_streaming')) {
        this.db.run(`
          ALTER TABLE cowork_messages ADD COLUMN is_streaming INTEGER
          GENERATED ALWAYS AS (
            CASE
              WHEN metadata IS NOT NULL AND instr(metadata, '"isStreaming":true') > 0 THEN 1
              ELSE 0
            END
          ) VIRTUAL
        `);
        changed = true;
      }
      if (!columns.includes('steer_pending')) {
        this.db.run(`
          ALTER TABLE cowork_messages ADD COLUMN steer_pending INTEGER
          GENERATED ALWAYS AS (
            CASE
              WHEN metadata IS NOT NULL
                AND instr(metadata, '"interactionKind":"steer"') > 0
                AND (
                  instr(metadata, '"steerStatus":"queued"') > 0
                  OR instr(metadata, '"steerStatus":"delivered"') > 0
                )
              THEN 1
              ELSE 0
            END
          ) VIRTUAL
        `);
        changed = true;
      }
      if (changed) {
        this.saveDb();
      }
      this.coworkMessageHealColumnsReady = true;
    } catch (error) {
      console.warn('[CoworkStore] Failed to add cowork_messages heal columns:', error);
    }
  }

  /**
   * Partial indexes for the two boot heals. Built lazily by the heals rather
   * than at construction: the first build evaluates the generated expressions
   * over every row, and once the dirty rows are healed the index is empty, so
   * every later scan is an index seek over nothing. Deliberately does not save:
   * the callers already save once when they change rows, and an extra
   * saveDb() here would rewrite the whole database file a second time.
   */
  private ensureCoworkMessageHealIndexes(): void {
    if (!this.tableExists('cowork_messages')) {
      return;
    }
    try {
      if (!this.indexExists('idx_cowork_messages_streaming_heal')) {
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_cowork_messages_streaming_heal
          ON cowork_messages(type) WHERE is_streaming = 1
        `);
      }
      if (!this.indexExists('idx_cowork_messages_steer_heal')) {
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_cowork_messages_steer_heal
          ON cowork_messages(type) WHERE steer_pending = 1
        `);
      }
    } catch (error) {
      console.warn('[CoworkStore] Failed to build cowork_messages heal indexes:', error);
    }
  }

  private indexExists(indexName: string): boolean {
    const result = this.db.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
      [indexName],
    );
    return (result[0]?.values?.length ?? 0) > 0;
  }

  private ensureCoworkSessionIndexes(): void {
    if (!this.tableExists('cowork_sessions')) {
      return;
    }
    try {
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_metabot_updated
        ON cowork_sessions(metabot_id, updated_at DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_visible_activity
        ON cowork_sessions(pinned DESC, COALESCE(activity_at, updated_at) DESC, updated_at DESC, created_at DESC, id DESC)
        WHERE COALESCE(hidden_from_session_list, 0) = 0 AND archived_at IS NULL
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_visible_metabot_activity
        ON cowork_sessions(metabot_id, COALESCE(activity_at, updated_at) DESC, updated_at DESC, created_at DESC)
        WHERE COALESCE(hidden_from_session_list, 0) = 0 AND archived_at IS NULL
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_null_activity
        ON cowork_sessions(id)
        WHERE activity_at IS NULL
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_null_metabot
        ON cowork_sessions(id)
        WHERE metabot_id IS NULL
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_fork_parent
        ON cowork_sessions(id)
        WHERE parent_session_id IS NOT NULL
      `);
      this.saveDb();
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify cowork_sessions indexes:', error);
    }
  }

  private ensureMemorySchemaCompatibility(): void {
    let changed = false;
    try {
      const sessionCols = this.db.exec('PRAGMA table_info(cowork_sessions);');
      const sessionColumns = (sessionCols[0]?.values || []).map((row) => String(row[1]));
      if (!sessionColumns.includes('metabot_id')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN metabot_id INTEGER NULL;');
        changed = true;
      }
      if (!sessionColumns.includes('session_type')) {
        this.db.run("ALTER TABLE cowork_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard';");
        changed = true;
      }
      if (!sessionColumns.includes('model')) {
        // Per-session model override (NULL = inherit the global default model).
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN model TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('model_provider')) {
        // Provider key that owns the session model id. Model ids collide
        // across gateways (opencode listing deepseek-v4-flash next to the
        // official deepseek catalog); without this column the picker and
        // runtime both first-match the earlier provider.
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN model_provider TEXT;');
        changed = true;
      }
      if (this.getKvValue(MODEL_PROVIDER_METAID_FREE_MIGRATION_KEY) !== '1') {
        this.db.run(
          `UPDATE cowork_sessions SET model_provider = 'idbots' WHERE LOWER(TRIM(model_provider)) = 'metaid-free'`,
        );
        if ((this.db.getRowsModified?.() ?? 0) > 0) {
          changed = true;
        }
        this.setKvValue(MODEL_PROVIDER_METAID_FREE_MIGRATION_KEY, '1');
      }
      if (!sessionColumns.includes('effort')) {
        // Per-session reasoning effort (off/low/high/max/'default'; NULL = model default chain).
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN effort TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('peer_global_metaid')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN peer_global_metaid TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('peer_name')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN peer_name TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('peer_avatar')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN peer_avatar TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('hidden_from_session_list')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN hidden_from_session_list INTEGER NOT NULL DEFAULT 0;');
        changed = true;
      }
      if (!sessionColumns.includes('archived_at')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN archived_at INTEGER;');
        changed = true;
      }
      if (!sessionColumns.includes('browser_uri')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN browser_uri TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('browser_title')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN browser_title TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('assistant_mode')) {
        // Bot Internet projector sessions (owner ruling 2026-11-07): a
        // per-session assistant-mode marker stamped at creation by the Bot
        // Internet co-work panel; marked sessions run assistant mode
        // regardless of the global chatExperienceMode.
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN assistant_mode INTEGER NOT NULL DEFAULT 0;');
        changed = true;
      }
      if (!sessionColumns.includes('permission_mode')) {
        this.db.run("ALTER TABLE cowork_sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';");
        changed = true;
      }
      if (!sessionColumns.includes('parent_session_id')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN parent_session_id TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('fork_point_message_id')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN fork_point_message_id TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('usage_stats')) {
        // Persisted per-session token/cache usage so the usage chip survives
        // app restarts (the in-memory CoworkRunner map is lost on restart).
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN usage_stats TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('goal')) {
        // /goal command state: JSON {text, status: active|paused, updatedAt}.
        // NULL = no goal (the DSH /goal port's storage).
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN goal TEXT;');
        changed = true;
      }
      if (!sessionColumns.includes('activity_at')) {
        // Session-list ordering key (see coworkSessionActivityAtSelectSql): the
        // created_at of the last activity message. The message write paths keep
        // it current; the one-time backfill for pre-existing rows runs in the
        // deferred heavy tier (runHeavyStartupMaintenance), so the ALTER here
        // stays instant on a multi-GB database. A NULL row simply keeps sorting
        // through the older correlated-subquery computation.
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN activity_at INTEGER;');
        changed = true;
      }
      if (!sessionColumns.includes('last_turn_failed_at_ms')) {
        // Turn-outcome markers for the long-term-task heartbeat self-heal
        // (see recordSessionTurnFailure): the newest turn settlement that left
        // the owner without an answer. NULL = no such settlement recorded.
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN last_turn_failed_at_ms INTEGER;');
        changed = true;
      }
      if (!sessionColumns.includes('last_turn_completed_at_ms')) {
        // Newest turn settlement that DID answer (kind completed); pairs with
        // last_turn_failed_at_ms so a heartbeat probe can tell "the owner's
        // message died in a failed turn" apart from "a later turn failed for
        // unrelated reasons after the owner was already answered".
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN last_turn_completed_at_ms INTEGER;');
        changed = true;
      }

      // Ensure partial session indexes before running the startup sweeps so
      // multi-GB databases with large system_prompt overflow chains seek only
      // matching rows instead of scanning the entire table on every launch.
      this.ensureCoworkSessionIndexes();

      // Sweep failed-fork orphans: a fork whose session row exists but has
      // zero messages is unambiguously a fork that died mid-copy (forkSession
      // always copies at least the fork-point message; the historical id-reuse
      // UNIQUE violation left exactly these rows behind). Idempotent: after
      // the first pass there is nothing to delete.
      this.db.run(`
        DELETE FROM cowork_sessions
        WHERE parent_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM cowork_messages WHERE session_id = cowork_sessions.id
          )
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify cowork_sessions columns:', error);
    }

    try {
      const memoryCols = this.db.exec('PRAGMA table_info(user_memories);');
      const memoryColumns = (memoryCols[0]?.values || []).map((row) => String(row[1]));
      if (!memoryColumns.includes('metabot_id')) {
        this.db.run('ALTER TABLE user_memories ADD COLUMN metabot_id INTEGER REFERENCES metabots(id);');
        const fallbackMetabotId = this.getDefaultMetabotId() ?? this.getAnyMetabotId();
        if (fallbackMetabotId != null) {
          this.db.run('UPDATE user_memories SET metabot_id = ? WHERE metabot_id IS NULL', [fallbackMetabotId]);
        }
        changed = true;
      }
      if (!memoryColumns.includes('scope_kind')) {
        this.db.run("ALTER TABLE user_memories ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'owner';");
        changed = true;
      }
      if (!memoryColumns.includes('scope_key')) {
        this.db.run(`ALTER TABLE user_memories ADD COLUMN scope_key TEXT NOT NULL DEFAULT '${OWNER_SCOPE_KEY}';`);
        changed = true;
      }
      if (!memoryColumns.includes('usage_class')) {
        this.db.run("ALTER TABLE user_memories ADD COLUMN usage_class TEXT NOT NULL DEFAULT 'profile_fact';");
        changed = true;
      }
      if (!memoryColumns.includes('visibility')) {
        this.db.run("ALTER TABLE user_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'local_only';");
        changed = true;
      }
      if (!memoryColumns.includes('origin')) {
        this.db.run("ALTER TABLE user_memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'conversation';");
        changed = true;
      }
      if (!memoryColumns.includes('archived_at')) {
        this.db.run('ALTER TABLE user_memories ADD COLUMN archived_at INTEGER;');
        changed = true;
      }
      // Dream review P1 (2026-10-23): "applied" timestamp, written ONLY by the
      // nightly hot-layer usage audit when a memory is judged applied in a
      // reply (evidence-cited). Injection keeps touching last_used_at; decay
      // and eviction read COALESCE(last_applied_at, last_used_at, updated_at)
      // so "was used" outranks "was injected".
      if (!memoryColumns.includes('last_applied_at')) {
        this.db.run('ALTER TABLE user_memories ADD COLUMN last_applied_at INTEGER;');
        changed = true;
      }
      if (!memoryColumns.includes('occurred_at')) {
        // Event-time axis (memory evolution #3): when the underlying fact or
        // event actually happened, distinct from created_at ("when we learned
        // it"). Pre-existing rows stay NULL — event time cannot be backfilled.
        this.db.run('ALTER TABLE user_memories ADD COLUMN occurred_at INTEGER;');
        changed = true;
      }
      if (!memoryColumns.includes('importance')) {
        this.db.run('ALTER TABLE user_memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;');
        // One-time deterministic backfill; keep this CASE in sync with
        // deriveMemoryImportance (src/main/memory/memoryImportance.ts).
        this.db.run(`
          UPDATE user_memories
          SET importance = CASE
            WHEN usage_class = 'self_identity' THEN 1.0
            WHEN is_explicit = 1 THEN 0.9
            WHEN origin = 'dream' AND usage_class = 'value_boundary' THEN 0.75
            WHEN origin = 'dream' AND usage_class = 'work_review' THEN 0.7
            WHEN origin = 'dream' AND usage_class = 'profile_fact' THEN 0.65
            WHEN usage_class IN ('preference', 'operational_preference') THEN 0.6
            ELSE 0.5
          END
        `);
        changed = true;
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memories_scope_status_updated
        ON user_memories(metabot_id, scope_kind, scope_key, status, updated_at DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memories_scope_fingerprint
        ON user_memories(metabot_id, scope_kind, scope_key, fingerprint)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memories_usage_visibility
        ON user_memories(metabot_id, usage_class, visibility, status, updated_at DESC)
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify user_memories scoped columns:', error);
    }

    try {
      const sourceCols = this.db.exec('PRAGMA table_info(user_memory_sources);');
      const sourceColumns = (sourceCols[0]?.values || []).map((row) => String(row[1]));
      if (!sourceColumns.includes('metabot_id')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN metabot_id INTEGER NULL;');
        changed = true;
      }
      if (!sourceColumns.includes('source_channel')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN source_channel TEXT NULL;');
        changed = true;
      }
      if (!sourceColumns.includes('source_type')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN source_type TEXT NULL;');
        changed = true;
      }
      if (!sourceColumns.includes('external_conversation_id')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN external_conversation_id TEXT NULL;');
        changed = true;
      }
      if (!sourceColumns.includes('source_id')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN source_id TEXT NULL;');
        changed = true;
      }
      if (!sourceColumns.includes('dream_date')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN dream_date TEXT NULL;');
        changed = true;
      }
      if (!sourceColumns.includes('quote')) {
        // Evidence ledger (memory evolution 2026-10-24): the verbatim excerpt
        // this source contributed. Pre-existing rows stay NULL — they were
        // written before quotes were captured and are not backfilled.
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN quote TEXT NULL;');
        changed = true;
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_channel_conversation
        ON user_memory_sources(source_channel, external_conversation_id, created_at DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_metabot
        ON user_memory_sources(metabot_id, created_at DESC)
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify user_memory_sources source columns:', error);
    }

    try {
      // Revision history (memory evolution 2026-10-24): the text a merge or
      // rewrite replaced — near-duplicate merge, cross-night dream merge,
      // deep-consolidation evolution rewrite, owner edit. Turns every change
      // of wording into an audit trail and keeps consolidation rewrites
      // reversible. CREATE TABLE IF NOT EXISTS is the idempotent first-run
      // migration; existing memory rows are never touched.
      if (!this.tableExists('user_memory_revisions')) {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS user_memory_revisions (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL,
            metabot_id INTEGER,
            previous_text TEXT NOT NULL,
            new_text TEXT NOT NULL,
            reason TEXT NOT NULL,
            source_type TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES user_memories(id) ON DELETE CASCADE
          )
        `);
        changed = true;
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_revisions_memory
        ON user_memory_revisions(memory_id, created_at DESC)
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify user_memory_revisions table:', error);
    }

    try {
      const fallbackMetabotId = this.getDefaultMetabotId() ?? this.getAnyMetabotId();
      if (fallbackMetabotId != null) {
        this.db.run('UPDATE cowork_sessions SET metabot_id = ? WHERE metabot_id IS NULL', [fallbackMetabotId]);
        if ((this.db.getRowsModified?.() || 0) > 0) {
          changed = true;
        }
        this.db.run('UPDATE user_memories SET metabot_id = ? WHERE metabot_id IS NULL', [fallbackMetabotId]);
        if ((this.db.getRowsModified?.() || 0) > 0) {
          changed = true;
        }
      }
    } catch (error) {
      console.warn('[CoworkStore] Failed to backfill NULL metabot_id values:', error);
    }

    if (changed) {
      this.saveDb();
    }
  }

  private ensureMemoryPolicySchemaCompatibility(): void {
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS metabot_memory_policies (
          metabot_id INTEGER PRIMARY KEY,
          memory_enabled INTEGER NOT NULL DEFAULT 1,
          memory_implicit_update_enabled INTEGER NOT NULL DEFAULT 1,
          memory_llm_judge_enabled INTEGER NOT NULL DEFAULT 1,
          memory_guard_level TEXT NOT NULL DEFAULT 'strict',
          memory_user_memories_max_items INTEGER NOT NULL DEFAULT 12,
          hygiene_enabled INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (metabot_id) REFERENCES metabots(id) ON DELETE CASCADE
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_metabot_memory_policies_updated
        ON metabot_memory_policies(updated_at DESC)
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify metabot_memory_policies schema:', error);
      return;
    }

    try {
      const cols = this.db.exec('PRAGMA table_info(metabot_memory_policies);');
      const columns = (cols[0]?.values || []).map((row) => String(row[1]));
      let changed = false;
      if (!columns.includes('memory_enabled')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1');
        changed = true;
      }
      if (!columns.includes('memory_implicit_update_enabled')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN memory_implicit_update_enabled INTEGER NOT NULL DEFAULT 1');
        changed = true;
      }
      if (!columns.includes('memory_llm_judge_enabled')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN memory_llm_judge_enabled INTEGER NOT NULL DEFAULT 1');
        changed = true;
      }
      if (!columns.includes('memory_guard_level')) {
        this.db.run("ALTER TABLE metabot_memory_policies ADD COLUMN memory_guard_level TEXT NOT NULL DEFAULT 'strict'");
        changed = true;
      }
      if (!columns.includes('memory_user_memories_max_items')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN memory_user_memories_max_items INTEGER NOT NULL DEFAULT 12');
        changed = true;
      }
      if (!columns.includes('dream_enabled')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN dream_enabled INTEGER NOT NULL DEFAULT 1');
        changed = true;
      }
      if (!columns.includes('hygiene_enabled')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN hygiene_enabled INTEGER NOT NULL DEFAULT 1');
        changed = true;
      }
      // Self-curriculum practice tasks (design 2026-10-10 §3.4): opt-in per
      // bot (default off); the auto-approve knob only matters when the feature
      // is on and defaults to on so enabling the feature is one switch.
      if (!columns.includes('practice_tasks_enabled')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN practice_tasks_enabled INTEGER NOT NULL DEFAULT 0');
        changed = true;
      }
      if (!columns.includes('practice_auto_approve_read_only')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN practice_auto_approve_read_only INTEGER NOT NULL DEFAULT 1');
        changed = true;
      }
      if (!columns.includes('updated_at')) {
        this.db.run('ALTER TABLE metabot_memory_policies ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
        this.db.run('UPDATE metabot_memory_policies SET updated_at = ? WHERE updated_at = 0', [Date.now()]);
        changed = true;
      }
      if (changed) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('[CoworkStore] Failed to migrate metabot_memory_policies columns:', error);
    }
  }

  private ensureConversationMappingSchemaCompatibility(): void {
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS cowork_conversation_mappings (
          channel TEXT NOT NULL,
          external_conversation_id TEXT NOT NULL,
          metabot_id INTEGER NOT NULL DEFAULT 0,
          cowork_session_id TEXT NOT NULL,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          PRIMARY KEY (channel, external_conversation_id, metabot_id)
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_conversation_mappings_session
        ON cowork_conversation_mappings(cowork_session_id)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_conversation_mappings_channel_last_active
        ON cowork_conversation_mappings(channel, last_active_at DESC)
      `);
      this.db.run(`
        INSERT OR IGNORE INTO cowork_conversation_mappings (
          channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
        )
        SELECT 'cowork_ui', id, COALESCE(metabot_id, 0), id, NULL, created_at, updated_at
        FROM cowork_sessions
      `);
      if ((this.db.getRowsModified?.() || 0) > 0) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify cowork_conversation_mappings schema:', error);
    }
  }

  private ensureA2AConversationSchemaCompatibility(): void {
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS a2a_conversation_threads (
          id TEXT PRIMARY KEY,
          participant_pair_key TEXT NOT NULL,
          local_metabot_id INTEGER NOT NULL,
          local_global_metaid TEXT NOT NULL,
          peer_global_metaid TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_a2a_threads_participant_pair
        ON a2a_conversation_threads(participant_pair_key, updated_at DESC)
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS a2a_conversation_episodes (
          session_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          episode_index INTEGER NOT NULL,
          previous_session_id TEXT,
          next_session_id TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          close_reason TEXT,
          UNIQUE(thread_id, episode_index),
          FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (thread_id) REFERENCES a2a_conversation_threads(id) ON DELETE CASCADE
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_a2a_episodes_thread_index
        ON a2a_conversation_episodes(thread_id, episode_index DESC)
      `);
      // Episode rollover is a live policy again (long-lived A2A threads roll
      // over to a fresh session past a message threshold, aggregated as one
      // conversation in the UI) — threads may legitimately hold multiple
      // episodes, so no startup consolidation may collapse them.
      const episodeSchemaColumns = this.db.exec('PRAGMA table_info(a2a_conversation_episodes);');
      const episodeSchemaColumnNames = (episodeSchemaColumns[0]?.values || []).map((row) => String(row[1]));
      if (!episodeSchemaColumnNames.includes('summary')) {
        this.db.run('ALTER TABLE a2a_conversation_episodes ADD COLUMN summary TEXT;');
      }
      this.backfillA2AConversationEpisodes();
      this.saveDb();
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify A2A conversation schema:', error);
    }
  }

  private backfillA2AConversationEpisodes(): void {
    if (!this.tableExists('metabots')) return;
    const metabotColumns = this.db.exec('PRAGMA table_info(metabots);');
    const metabotColumnNames = (metabotColumns[0]?.values || []).map((row) => String(row[1]));
    if (!metabotColumnNames.includes('globalmetaid')) return;

    const rows = this.getAll<{
      session_id: string;
      metabot_id: number | string;
      peer_global_metaid: string;
      created_at: number | string;
      updated_at: number | string;
      local_global_metaid: string | null;
      ui_metadata_json: string | null;
      private_metadata_json: string | null;
    }>(`
      SELECT
        s.id AS session_id,
        s.metabot_id,
        s.peer_global_metaid,
        s.created_at,
        s.updated_at,
        b.globalmetaid AS local_global_metaid,
        ui.metadata_json AS ui_metadata_json,
        (
          SELECT private_mapping.metadata_json
          FROM cowork_conversation_mappings private_mapping
          WHERE private_mapping.channel = 'metaweb_private'
            AND private_mapping.cowork_session_id = s.id
            AND private_mapping.metabot_id = COALESCE(s.metabot_id, 0)
          LIMIT 1
        ) AS private_metadata_json
      FROM cowork_sessions s
      LEFT JOIN metabots b ON b.id = s.metabot_id
      LEFT JOIN cowork_conversation_mappings ui
        ON ui.channel = 'cowork_ui'
        AND ui.external_conversation_id = s.id
        AND ui.metabot_id = COALESCE(s.metabot_id, 0)
      WHERE s.session_type = 'a2a'
        AND TRIM(COALESCE(s.peer_global_metaid, '')) <> ''
        AND (
          ui.metadata_json LIKE '%"a2aConversationId"%'
          OR EXISTS (
            SELECT 1
            FROM cowork_conversation_mappings private_mapping
            WHERE private_mapping.channel = 'metaweb_private'
              AND private_mapping.cowork_session_id = s.id
              AND private_mapping.metabot_id = COALESCE(s.metabot_id, 0)
          )
        )
      ORDER BY s.created_at ASC, s.id ASC
    `);

    for (const row of rows) {
      const localMetabotId = parseIdNumber(row.metabot_id);
      const localGlobalMetaId = normalizeA2AParticipantId(row.local_global_metaid || '');
      const peerGlobalMetaId = normalizeA2AParticipantId(row.peer_global_metaid || '');
      if (localMetabotId == null || !localGlobalMetaId || !peerGlobalMetaId || localGlobalMetaId === peerGlobalMetaId) {
        continue;
      }
      let metadata: CoworkMessageMetadata = {};
      for (const rawMetadata of [row.ui_metadata_json, row.private_metadata_json]) {
        if (!rawMetadata) continue;
        try {
          const parsed = JSON.parse(rawMetadata) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadata = { ...metadata, ...parsed as CoworkMessageMetadata };
          }
        } catch {
          // Ignore malformed legacy mapping metadata and preserve the session itself.
        }
      }
      this.writeA2AEpisode({
        sessionId: row.session_id,
        localMetabotId,
        localGlobalMetaId,
        peerGlobalMetaId,
        episodeIndex: parseIdNumber(metadata.episodeIndex) ?? undefined,
        previousSessionId: typeof metadata.previousEpisodeSessionId === 'string'
          ? metadata.previousEpisodeSessionId
          : null,
        startedAt: parseIdNumber(metadata.episodeStartedAt) ?? parseIdNumber(row.created_at) ?? Date.now(),
        endedAt: parseIdNumber(metadata.episodeClosedAt),
        closeReason: typeof metadata.episodeCloseReason === 'string'
          ? metadata.episodeCloseReason
          : null,
      });
    }
  }
  private getKvValue(key: string): string | null {
    const row = this.getOne<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
    if (!row?.value) {
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return typeof parsed === 'string' ? parsed : row.value;
    } catch {
      return row.value;
    }
  }

  private setKvValue(key: string, value: string): void {
    this.db.run(`
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [key, JSON.stringify(value), Date.now()]);
    this.saveDb();
  }

  private resolveMemoryScopeSelector(input: {
    scope?: MemoryScope | null;
    scopeKind?: MemoryScope['kind'] | null;
    scopeKey?: string | null;
  }): MemoryScope {
    return normalizeMemoryScopeSelector(input) ?? createOwnerMemoryScope();
  }

  private resolveMemoryClassification(
    text: string,
    scope: MemoryScope,
    overrides: {
      usageClass?: MemoryUsageClass | null;
      visibility?: MemoryVisibility | null;
    } = {}
  ): {
    usageClass: MemoryUsageClass;
    visibility: MemoryVisibility;
  } {
    const inferred = classifyMemoryText(text, scope);
    const usageClass = normalizeMemoryUsageClass(overrides.usageClass ?? inferred.usageClass);
    let visibility = normalizeMemoryVisibility(overrides.visibility ?? inferred.visibility);
    if (scope.kind !== 'owner' || usageClass !== 'operational_preference') {
      visibility = 'local_only';
    }
    return { usageClass, visibility };
  }

  private getMemoryScopeResolutionContextBySession(sessionId?: string | null): MemoryScopeResolutionContext {
    if (!sessionId) {
      return {
        sourceChannel: 'cowork_ui',
        externalConversationId: null,
        sessionType: null,
        peerGlobalMetaId: null,
      };
    }

    const sessionRow = this.getOne<{
      session_type?: string | null;
      peer_global_metaid?: string | null;
    }>(`
      SELECT session_type, peer_global_metaid
      FROM cowork_sessions
      WHERE id = ?
      LIMIT 1
    `, [sessionId]);

    const mappingRow = this.getOne<{
      channel: string;
      external_conversation_id: string | null;
      metadata_json: string | null;
    }>(`
      SELECT channel, external_conversation_id, metadata_json
      FROM cowork_conversation_mappings
      WHERE cowork_session_id = ?
      ORDER BY
        CASE
          WHEN channel = 'metaweb_private' THEN 0
          WHEN channel = 'metaweb_order' THEN 1
          WHEN channel = 'cowork_ui' THEN 3
          ELSE 2
        END ASC,
        last_active_at DESC
      LIMIT 1
    `, [sessionId]);

    const mappingMetadata = this.parseMessageMetadata(mappingRow?.metadata_json);
    const episodeConversationId = typeof mappingMetadata.a2aConversationId === 'string'
      ? mappingMetadata.a2aConversationId.trim()
      : '';
    const sourceChannel = mappingRow?.channel === 'cowork_ui' && episodeConversationId
      ? 'metaweb_private'
      : mappingRow?.channel || 'cowork_ui';
    const externalConversationId = episodeConversationId || mappingRow?.external_conversation_id || sessionId;

    return {
      sourceChannel,
      externalConversationId,
      sessionType: (sessionRow?.session_type === 'agent_agent'
        ? 'a2a'
        : sessionRow?.session_type) as CoworkSessionType | null | undefined ?? 'standard',
      peerGlobalMetaId:
        normalizeScopeIdentity(sessionRow?.peer_global_metaid)
        || parsePeerGlobalMetaIdFromMetadata(mappingRow?.metadata_json)
        || null,
    };
  }

  private getMemoryScopeResolutionContextFromMapping(
    sourceChannel?: string | null,
    externalConversationId?: string | null,
    metabotId?: number | null
  ): MemoryScopeResolutionContext {
    const normalizedChannel = normalizeScopeChannel(sourceChannel);
    const normalizedConversationId = normalizeScopeIdentity(externalConversationId);
    if (!normalizedChannel || !normalizedConversationId) {
      return {};
    }

    const mapping = this.getConversationMapping(normalizedChannel, normalizedConversationId, metabotId ?? null);
    if (!mapping) {
      return {};
    }

    const sessionContext = this.getMemoryScopeResolutionContextBySession(mapping.coworkSessionId);
    return {
      sourceChannel: mapping.channel,
      externalConversationId: mapping.externalConversationId,
      sessionType: sessionContext.sessionType ?? null,
      peerGlobalMetaId:
        sessionContext.peerGlobalMetaId
        || parsePeerGlobalMetaIdFromMetadata(mapping.metadataJson)
        || inferPeerGlobalMetaIdFromConversationId(mapping.channel, mapping.externalConversationId),
    };
  }

  private buildResolvedMemoryScopeInput(input: ResolveMemoryScopesInput & { sessionId?: string | null }): ResolveMemoryScopesInput {
    const sessionContext = this.getMemoryScopeResolutionContextBySession(input.sessionId);
    const sourceChannel = normalizeScopeChannel(input.sourceChannel)
      || normalizeScopeChannel(sessionContext.sourceChannel)
      || '';
    const externalConversationId = normalizeScopeIdentity(input.externalConversationId)
      || normalizeScopeIdentity(sessionContext.externalConversationId)
      || null;
    const mappingContext = this.getMemoryScopeResolutionContextFromMapping(
      sourceChannel,
      externalConversationId,
      input.metabotId ?? null
    );

    const resolvedChannel = sourceChannel
      || normalizeScopeChannel(mappingContext.sourceChannel)
      || '';
    const resolvedConversationId = externalConversationId
      || normalizeScopeIdentity(mappingContext.externalConversationId)
      || null;
    const resolvedPeerGlobalMetaId = normalizeScopeIdentity(input.peerGlobalMetaId)
      || normalizeScopeIdentity(sessionContext.peerGlobalMetaId)
      || normalizeScopeIdentity(mappingContext.peerGlobalMetaId)
      || inferPeerGlobalMetaIdFromConversationId(resolvedChannel, resolvedConversationId)
      || null;

    const inputSessionType = input.sessionType === 'agent_agent' ? 'a2a' : input.sessionType;
    const resolvedSessionType = inputSessionType
      || sessionContext.sessionType
      || mappingContext.sessionType
      || null;

    return {
      metabotId: input.metabotId,
      sourceChannel: resolvedChannel || null,
      externalConversationId: resolvedConversationId,
      peerGlobalMetaId: resolvedPeerGlobalMetaId,
      sessionType: resolvedSessionType,
    };
  }

  private inferBackfilledMemoryScope(memoryId: string, metabotId: number): MemoryScope {
    const sources = this.getAll<CoworkUserMemorySourceRow>(`
      SELECT session_id, source_channel, external_conversation_id, created_at
      FROM user_memory_sources
      WHERE memory_id = ?
      ORDER BY is_active DESC, created_at DESC
    `, [memoryId]);

    for (const source of sources) {
      const resolved = resolveMemoryScopes(this.buildResolvedMemoryScopeInput({
        metabotId,
        sessionId: source.session_id,
        sourceChannel: source.source_channel,
        externalConversationId: source.external_conversation_id,
      }));
      if (resolved.resolutionReason !== 'owner_default') {
        return resolved.writeScope;
      }
    }

    return createOwnerMemoryScope();
  }

  private backfillScopedMemoryMetadata(): void {
    if (this.getKvValue(SCOPED_USER_MEMORIES_BACKFILL_KEY) === '1') {
      return;
    }

    const memoryColumns = this.db.exec('PRAGMA table_info(user_memories);');
    const columnNames = (memoryColumns[0]?.values || []).map((row) => String(row[1]));
    if (!columnNames.includes('scope_kind') || !columnNames.includes('scope_key')) {
      return;
    }

    const rows = this.getAll<{
      id: string;
      metabot_id: number | string | null;
      text: string;
    }>(`
      SELECT id, metabot_id, text
      FROM user_memories
    `);

    this.db.run('BEGIN TRANSACTION');
    try {
      for (const row of rows) {
        const metabotId = parseIdNumber(row.metabot_id);
        if (metabotId == null) {
          continue;
        }
        const existing = this.getOne<{
          scope_kind?: string | null;
          scope_key?: string | null;
          usage_class?: string | null;
          visibility?: string | null;
        }>(`
          SELECT scope_kind, scope_key, usage_class, visibility
          FROM user_memories
          WHERE id = ? AND metabot_id = ?
          LIMIT 1
        `, [row.id, metabotId]);
        const hasNonDefaultScopedMetadata = (
          (existing?.scope_kind != null && existing.scope_kind !== 'owner')
          || (existing?.scope_key != null && existing.scope_key !== OWNER_SCOPE_KEY)
          || (existing?.usage_class != null && existing.usage_class !== 'profile_fact')
          || (existing?.visibility != null && existing.visibility !== 'local_only')
        );
        if (hasNonDefaultScopedMetadata) {
          continue;
        }
        const scope = this.inferBackfilledMemoryScope(row.id, metabotId);
        const classification = this.resolveMemoryClassification(row.text, scope);
        this.db.run(`
          UPDATE user_memories
          SET scope_kind = ?, scope_key = ?, usage_class = ?, visibility = ?
          WHERE id = ? AND metabot_id = ?
        `, [
          scope.kind,
          scope.key,
          classification.usageClass,
          classification.visibility,
          row.id,
          metabotId,
        ]);
      }
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      console.warn('[CoworkStore] Failed to backfill scoped memory metadata:', error);
      return;
    }

    this.setKvValue(SCOPED_USER_MEMORIES_BACKFILL_KEY, '1');
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
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

  private mapA2AThreadRow(row: CoworkA2AThreadRow): CoworkA2AConversationThread {
    return {
      id: row.id,
      participantPairKey: row.participant_pair_key,
      localMetabotId: parseIdNumber(row.local_metabot_id) ?? 0,
      localGlobalMetaId: row.local_global_metaid,
      peerGlobalMetaId: row.peer_global_metaid,
      createdAt: parseIdNumber(row.created_at) ?? 0,
      updatedAt: parseIdNumber(row.updated_at) ?? 0,
    };
  }

  private mapA2AEpisodeRow(row: CoworkA2AEpisodeRow): CoworkA2AConversationEpisode {
    return {
      sessionId: row.session_id,
      threadId: row.thread_id,
      episodeIndex: parseIdNumber(row.episode_index) ?? 1,
      previousSessionId: row.previous_session_id,
      nextSessionId: row.next_session_id,
      startedAt: parseIdNumber(row.started_at) ?? 0,
      endedAt: parseIdNumber(row.ended_at),
      closeReason: row.close_reason,
      summary: row.summary ?? null,
    };
  }

  /**
   * Persist the LLM handoff summary onto a closed episode. Written by the
   * rollover flow after the successor episode has been registered.
   */
  updateA2AEpisodeSummary(sessionId: string, summary: string): boolean {
    const trimmed = String(summary ?? '').trim();
    if (!trimmed) return false;
    this.db.run(
      'UPDATE a2a_conversation_episodes SET summary = ? WHERE session_id = ?',
      [trimmed, sessionId],
    );
    const updated = this.getOne<{ session_id: string }>(
      'SELECT session_id FROM a2a_conversation_episodes WHERE session_id = ? AND summary IS NOT NULL',
      [sessionId],
    );
    this.saveDb();
    return Boolean(updated);
  }

  /**
   * Newest N A2A user/assistant messages across ALL episodes of the thread the
   * given session belongs to (oldest-first). Backs thread-level bye-pressure
   * counting and rollover handoff summaries; non-thread sessions fall back to
   * the single-session window.
   */
  getRecentA2AThreadMessages(sessionId: string, requestedLimit: number = 400): CoworkMessage[] {
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(2000, Math.floor(requestedLimit)))
      : 400;
    const anchor = this.getOne<{ thread_id: string }>(
      'SELECT thread_id FROM a2a_conversation_episodes WHERE session_id = ? LIMIT 1',
      [sessionId],
    );
    if (!anchor) return this.getRecentPrivateA2AMessages(sessionId, limit);
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT message.id, message.type, message.content, message.metadata, message.created_at, message.sequence
      FROM a2a_conversation_episodes episode
      JOIN cowork_messages message ON message.session_id = episode.session_id
      WHERE episode.thread_id = ?
        AND message.type IN ('user', 'assistant')
        AND message.metadata LIKE '%"sourceChannel":"metaweb_private"%'
        AND message.metadata NOT LIKE '%"orderExecutionTrace":true%'
      ORDER BY
        episode.episode_index DESC,
        COALESCE(message.sequence, 0) DESC,
        message.created_at DESC,
        message.ROWID DESC
      LIMIT ?
    `, [anchor.thread_id, limit]);
    return rows.reverse().map((row) => ({
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  private writeA2AEpisode(input: RegisterCoworkA2AEpisodeInput): CoworkA2AConversationEpisode {
    const localMetabotId = parseIdNumber(input.localMetabotId);
    if (localMetabotId == null) throw new Error('A valid local MetaBot id is required');
    const localGlobalMetaId = normalizeA2AParticipantId(input.localGlobalMetaId);
    const peerGlobalMetaId = normalizeA2AParticipantId(input.peerGlobalMetaId);
    const threadId = buildA2AConversationThreadId(localGlobalMetaId, peerGlobalMetaId);
    const participantPairKey = buildA2AParticipantPairKey(localGlobalMetaId, peerGlobalMetaId);
    const startedAt = parseIdNumber(input.startedAt) ?? Date.now();

    this.db.run(`
      INSERT INTO a2a_conversation_threads (
        id, participant_pair_key, local_metabot_id, local_global_metaid,
        peer_global_metaid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        participant_pair_key = excluded.participant_pair_key,
        local_metabot_id = excluded.local_metabot_id,
        local_global_metaid = excluded.local_global_metaid,
        peer_global_metaid = excluded.peer_global_metaid,
        updated_at = MAX(a2a_conversation_threads.updated_at, excluded.updated_at)
    `, [
      threadId,
      participantPairKey,
      localMetabotId,
      localGlobalMetaId,
      peerGlobalMetaId,
      startedAt,
      input.endedAt ?? startedAt,
    ]);

    const existing = this.getOne<CoworkA2AEpisodeRow>(`
      SELECT * FROM a2a_conversation_episodes WHERE session_id = ? LIMIT 1
    `, [input.sessionId]);
    if (existing) return this.mapA2AEpisodeRow(existing);

    const latest = this.getOne<CoworkA2AEpisodeRow>(`
      SELECT *
      FROM a2a_conversation_episodes
      WHERE thread_id = ?
      ORDER BY episode_index DESC
      LIMIT 1
    `, [threadId]);
    const latestIndex = parseIdNumber(latest?.episode_index) ?? 0;
    const requestedIndex = parseIdNumber(input.episodeIndex);
    let episodeIndex = requestedIndex ?? latestIndex + 1;
    const occupied = this.getOne<{ session_id: string }>(`
      SELECT session_id
      FROM a2a_conversation_episodes
      WHERE thread_id = ? AND episode_index = ?
      LIMIT 1
    `, [threadId, episodeIndex]);
    if (occupied && occupied.session_id !== input.sessionId) {
      episodeIndex = latestIndex + 1;
    }
    const previousSessionId = input.previousSessionId
      ?? (latest && (parseIdNumber(latest.episode_index) ?? 0) < episodeIndex ? latest.session_id : null);

    this.db.run(`
      INSERT INTO a2a_conversation_episodes (
        session_id, thread_id, episode_index, previous_session_id, next_session_id,
        started_at, ended_at, close_reason
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `, [
      input.sessionId,
      threadId,
      episodeIndex,
      previousSessionId,
      startedAt,
      input.endedAt ?? null,
      input.closeReason ?? null,
    ]);

    if (previousSessionId) {
      this.db.run(`
        UPDATE a2a_conversation_episodes
        SET next_session_id = ?, ended_at = COALESCE(ended_at, ?), close_reason = COALESCE(close_reason, ?)
        WHERE session_id = ? AND thread_id = ?
      `, [
        input.sessionId,
        startedAt,
        input.previousCloseReason ?? null,
        previousSessionId,
        threadId,
      ]);
    }

    return this.mapA2AEpisodeRow(this.getOne<CoworkA2AEpisodeRow>(`
      SELECT * FROM a2a_conversation_episodes WHERE session_id = ? LIMIT 1
    `, [input.sessionId])!);
  }

  registerA2AEpisode(input: RegisterCoworkA2AEpisodeInput): CoworkA2AConversationEpisode {
    const episode = this.writeA2AEpisode(input);
    this.saveDb();
    return episode;
  }

  getA2AConversationThreadBySession(sessionId: string): CoworkA2AConversationThread | null {
    const row = this.getOne<CoworkA2AThreadRow>(`
      SELECT thread.*
      FROM a2a_conversation_episodes episode
      JOIN a2a_conversation_threads thread ON thread.id = episode.thread_id
      WHERE episode.session_id = ?
      LIMIT 1
    `, [sessionId]);
    return row ? this.mapA2AThreadRow(row) : null;
  }

  listA2AConversationEpisodes(sessionId: string): CoworkA2AConversationEpisode[] {
    const anchor = this.getOne<{ thread_id: string }>(`
      SELECT thread_id FROM a2a_conversation_episodes WHERE session_id = ? LIMIT 1
    `, [sessionId]);
    if (!anchor) return [];
    return this.getAll<CoworkA2AEpisodeRow>(`
      SELECT *
      FROM a2a_conversation_episodes
      WHERE thread_id = ?
      ORDER BY episode_index ASC
    `, [anchor.thread_id]).map((row) => this.mapA2AEpisodeRow(row));
  }

  /** Get metabot_id for a session; returns null if session not found or has no metabot_id. */
  getMetabotIdForSession(sessionId: string): number | null {
    const row = this.getOne<{ metabot_id: number | string | null }>(
      'SELECT metabot_id FROM cowork_sessions WHERE id = ?',
      [sessionId]
    );
    if (!row || row.metabot_id == null) return null;
    return parseIdNumber(row.metabot_id);
  }

  /** Get default MetaBot id (first twin) for fallback when session has no metabot_id. */
  getDefaultMetabotId(): number | null {
    const row = this.getOne<{ id: number | string }>(
      "SELECT id FROM metabots WHERE metabot_type = 'twin' ORDER BY id ASC LIMIT 1"
    );
    return parseIdNumber(row?.id);
  }

  /** Get first MetaBot id regardless of type, for environments without a twin bot. */
  getAnyMetabotId(): number | null {
    const row = this.getOne<{ id: number | string }>(
      'SELECT id FROM metabots ORDER BY id ASC LIMIT 1'
    );
    return parseIdNumber(row?.id);
  }

  /**
   * Resolve the metabot a memory belongs to. When a sessionId is given, the
   * session's own metabot_id is authoritative — unknown or unattributed
   * sessions resolve to null rather than guessing the default bot, so memories
   * never leak across bots. The default-twin/any-bot fallback only applies to
   * legacy callers that have no session context at all.
   */
  resolveMetabotIdForMemory(sessionId?: string | null): number | null {
    if (sessionId) {
      return this.getMetabotIdForSession(sessionId);
    }
    return this.getDefaultMetabotId() ?? this.getAnyMetabotId();
  }

  getEffectiveMemoryPolicyForMetabot(metabotId?: number | null): CoworkEffectiveMemoryPolicy {
    const config = this.getConfig();
    const resolvedMetabotId = parseIdNumber(metabotId);
    if (resolvedMetabotId == null) {
      return {
        metabotId: null,
        memoryEnabled: config.memoryEnabled,
        memoryImplicitUpdateEnabled: config.memoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: config.memoryLlmJudgeEnabled,
        memoryGuardLevel: config.memoryGuardLevel,
        memoryUserMemoriesMaxItems: config.memoryUserMemoriesMaxItems,
        memoryPromptMaxChars: config.memoryPromptMaxChars,
        dreamEnabled: true,
        hygieneEnabled: true,
        practiceTasksEnabled: false,
        practiceAutoApproveReadOnly: true,
        source: 'global',
      };
    }

    const row = this.getOne<CoworkMemoryPolicyRow>(`
      SELECT metabot_id, memory_enabled, memory_implicit_update_enabled, memory_llm_judge_enabled,
             memory_guard_level, memory_user_memories_max_items, dream_enabled, hygiene_enabled,
             practice_tasks_enabled, practice_auto_approve_read_only, updated_at
      FROM metabot_memory_policies
      WHERE metabot_id = ?
      LIMIT 1
    `, [resolvedMetabotId]);

    if (!row) {
      return {
        metabotId: resolvedMetabotId,
        memoryEnabled: config.memoryEnabled,
        memoryImplicitUpdateEnabled: config.memoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: config.memoryLlmJudgeEnabled,
        memoryGuardLevel: config.memoryGuardLevel,
        memoryUserMemoriesMaxItems: config.memoryUserMemoriesMaxItems,
        memoryPromptMaxChars: config.memoryPromptMaxChars,
        dreamEnabled: true,
        hygieneEnabled: true,
        practiceTasksEnabled: false,
        practiceAutoApproveReadOnly: true,
        source: 'global',
      };
    }

    return {
      metabotId: resolvedMetabotId,
      memoryEnabled: normalizeDbBoolean(row.memory_enabled, config.memoryEnabled),
      memoryImplicitUpdateEnabled: normalizeDbBoolean(
        row.memory_implicit_update_enabled,
        config.memoryImplicitUpdateEnabled
      ),
      memoryLlmJudgeEnabled: normalizeDbBoolean(row.memory_llm_judge_enabled, config.memoryLlmJudgeEnabled),
      memoryGuardLevel: normalizeMemoryGuardLevel(row.memory_guard_level ?? config.memoryGuardLevel),
      memoryUserMemoriesMaxItems: clampMemoryUserMemoriesMaxItems(
        Number(row.memory_user_memories_max_items ?? config.memoryUserMemoriesMaxItems)
      ),
      // Global-only knob (no per-bot column): the metabot override merges the
      // count limit, the prompt budget stays the global value either way.
      memoryPromptMaxChars: config.memoryPromptMaxChars,
      dreamEnabled: normalizeDbBoolean(row.dream_enabled, true),
      hygieneEnabled: normalizeDbBoolean(row.hygiene_enabled, true),
      practiceTasksEnabled: normalizeDbBoolean(row.practice_tasks_enabled, false),
      practiceAutoApproveReadOnly: normalizeDbBoolean(row.practice_auto_approve_read_only, true),
      source: 'metabot',
    };
  }

  getEffectiveMemoryPolicyForSession(sessionId?: string | null): CoworkEffectiveMemoryPolicy {
    const metabotId = this.resolveMetabotIdForMemory(sessionId);
    return this.getEffectiveMemoryPolicyForMetabot(metabotId);
  }

  setMemoryPolicyForMetabot(
    metabotId: number,
    updates: Partial<Pick<
      CoworkEffectiveMemoryPolicy,
      | 'memoryEnabled'
      | 'memoryImplicitUpdateEnabled'
      | 'memoryLlmJudgeEnabled'
      | 'memoryGuardLevel'
      | 'memoryUserMemoriesMaxItems'
      | 'dreamEnabled'
      | 'hygieneEnabled'
      | 'practiceTasksEnabled'
      | 'practiceAutoApproveReadOnly'
    >>
  ): CoworkMemoryPolicy {
    const resolvedMetabotId = parseIdNumber(metabotId);
    if (resolvedMetabotId == null || resolvedMetabotId <= 0) {
      throw new Error('Invalid metabotId');
    }
    const exists = this.getOne<{ id: number | string }>(
      'SELECT id FROM metabots WHERE id = ? LIMIT 1',
      [resolvedMetabotId]
    );
    if (!exists) {
      throw new Error(`MetaBot ${resolvedMetabotId} not found`);
    }

    const base = this.getEffectiveMemoryPolicyForMetabot(resolvedMetabotId);
    const nextMemoryEnabled = updates.memoryEnabled !== undefined
      ? Boolean(updates.memoryEnabled)
      : base.memoryEnabled;
    const nextImplicit = updates.memoryImplicitUpdateEnabled !== undefined
      ? Boolean(updates.memoryImplicitUpdateEnabled)
      : base.memoryImplicitUpdateEnabled;
    const nextJudge = updates.memoryLlmJudgeEnabled !== undefined
      ? Boolean(updates.memoryLlmJudgeEnabled)
      : base.memoryLlmJudgeEnabled;
    const nextGuard = updates.memoryGuardLevel !== undefined
      ? normalizeMemoryGuardLevel(updates.memoryGuardLevel)
      : base.memoryGuardLevel;
    const nextMaxItems = updates.memoryUserMemoriesMaxItems !== undefined
      ? clampMemoryUserMemoriesMaxItems(Number(updates.memoryUserMemoriesMaxItems))
      : base.memoryUserMemoriesMaxItems;
    const nextDreamEnabled = updates.dreamEnabled !== undefined
      ? Boolean(updates.dreamEnabled)
      : base.dreamEnabled;
    const nextHygieneEnabled = updates.hygieneEnabled !== undefined
      ? Boolean(updates.hygieneEnabled)
      : base.hygieneEnabled;
    const nextPracticeTasksEnabled = updates.practiceTasksEnabled !== undefined
      ? Boolean(updates.practiceTasksEnabled)
      : base.practiceTasksEnabled;
    const nextPracticeAutoApproveReadOnly = updates.practiceAutoApproveReadOnly !== undefined
      ? Boolean(updates.practiceAutoApproveReadOnly)
      : base.practiceAutoApproveReadOnly;
    const now = Date.now();

    this.db.run(`
      INSERT INTO metabot_memory_policies (
        metabot_id, memory_enabled, memory_implicit_update_enabled, memory_llm_judge_enabled,
        memory_guard_level, memory_user_memories_max_items, dream_enabled, hygiene_enabled,
        practice_tasks_enabled, practice_auto_approve_read_only, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id) DO UPDATE SET
        memory_enabled = excluded.memory_enabled,
        memory_implicit_update_enabled = excluded.memory_implicit_update_enabled,
        memory_llm_judge_enabled = excluded.memory_llm_judge_enabled,
        memory_guard_level = excluded.memory_guard_level,
        memory_user_memories_max_items = excluded.memory_user_memories_max_items,
        dream_enabled = excluded.dream_enabled,
        hygiene_enabled = excluded.hygiene_enabled,
        practice_tasks_enabled = excluded.practice_tasks_enabled,
        practice_auto_approve_read_only = excluded.practice_auto_approve_read_only,
        updated_at = excluded.updated_at
    `, [
      resolvedMetabotId,
      nextMemoryEnabled ? 1 : 0,
      nextImplicit ? 1 : 0,
      nextJudge ? 1 : 0,
      nextGuard,
      nextMaxItems,
      nextDreamEnabled ? 1 : 0,
      nextHygieneEnabled ? 1 : 0,
      nextPracticeTasksEnabled ? 1 : 0,
      nextPracticeAutoApproveReadOnly ? 1 : 0,
      now,
    ]);
    this.saveDb();

    return {
      metabotId: resolvedMetabotId,
      memoryEnabled: nextMemoryEnabled,
      memoryImplicitUpdateEnabled: nextImplicit,
      memoryLlmJudgeEnabled: nextJudge,
      memoryGuardLevel: nextGuard,
      memoryUserMemoriesMaxItems: nextMaxItems,
      dreamEnabled: nextDreamEnabled,
      hygieneEnabled: nextHygieneEnabled,
      practiceTasksEnabled: nextPracticeTasksEnabled,
      practiceAutoApproveReadOnly: nextPracticeAutoApproveReadOnly,
      updatedAt: now,
    };
  }

  /**
   * Remove a per-MetaBot memory policy override so the bot falls back to the
   * global default again. Returns true when a row was actually deleted.
   * Idempotent: returns false (no throw) when no override existed.
   */
  deleteMemoryPolicyForMetabot(metabotId: number): boolean {
    const resolvedMetabotId = parseIdNumber(metabotId);
    if (resolvedMetabotId == null || resolvedMetabotId <= 0) {
      return false;
    }
    const existing = this.getOne<{ metabot_id: number }>(
      'SELECT metabot_id FROM metabot_memory_policies WHERE metabot_id = ? LIMIT 1',
      [resolvedMetabotId],
    );
    if (!existing) {
      return false;
    }
    this.db.run(
      'DELETE FROM metabot_memory_policies WHERE metabot_id = ?',
      [resolvedMetabotId],
    );
    this.saveDb();
    return true;
  }

  private normalizeConversationChannel(channel: string): string {
    return String(channel || '').trim().toLowerCase();
  }

  private normalizeExternalConversationId(externalConversationId: string): string {
    return String(externalConversationId || '').trim();
  }

  private normalizeMappingMetabotId(metabotId?: number | null): number {
    const parsed = parseIdNumber(metabotId);
    if (parsed == null || parsed <= 0) return 0;
    return Math.floor(parsed);
  }

  private mapConversationMappingRow(row: CoworkConversationMappingRow): CoworkConversationMapping {
    const parsedMetabotId = parseIdNumber(row.metabot_id);
    return {
      channel: String(row.channel || ''),
      externalConversationId: String(row.external_conversation_id || ''),
      metabotId: parsedMetabotId && parsedMetabotId > 0 ? parsedMetabotId : null,
      coworkSessionId: String(row.cowork_session_id || ''),
      metadataJson: row.metadata_json ?? null,
      createdAt: parseIdNumber(row.created_at) ?? 0,
      lastActiveAt: parseIdNumber(row.last_active_at) ?? 0,
    };
  }

  getConversationMapping(
    channel: string,
    externalConversationId: string,
    metabotId?: number | null
  ): CoworkConversationMapping | null {
    const normalizedChannel = this.normalizeConversationChannel(channel);
    const normalizedConversationId = this.normalizeExternalConversationId(externalConversationId);
    if (!normalizedChannel || !normalizedConversationId) return null;
    const normalizedMetabotId = this.normalizeMappingMetabotId(metabotId);

    const row = this.getOne<CoworkConversationMappingRow>(`
      SELECT channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      FROM cowork_conversation_mappings
      WHERE channel = ? AND external_conversation_id = ? AND metabot_id = ?
      LIMIT 1
    `, [normalizedChannel, normalizedConversationId, normalizedMetabotId]);


    return row ? this.mapConversationMappingRow(row) : null;
  }

  /**
   * Reverse lookup: the newest mapping of `channel` bound to a cowork session.
   * Used by tooling that knows only the session (e.g. routing the group_chat
   * tool inside a group-task worker session to its task group).
   */
  getConversationMappingForSession(
    channel: string,
    coworkSessionId: string,
  ): CoworkConversationMapping | null {
    const normalizedChannel = this.normalizeConversationChannel(channel);
    const normalizedSessionId = String(coworkSessionId ?? '').trim();
    if (!normalizedChannel || !normalizedSessionId) return null;
    const row = this.getOne<CoworkConversationMappingRow>(`
      SELECT channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      FROM cowork_conversation_mappings
      WHERE channel = ? AND cowork_session_id = ?
      ORDER BY last_active_at DESC, created_at DESC
      LIMIT 1
    `, [normalizedChannel, normalizedSessionId]);
    return row ? this.mapConversationMappingRow(row) : null;
  }

  upsertConversationMapping(input: {
    channel: string;
    externalConversationId: string;
    metabotId?: number | null;
    coworkSessionId: string;
    metadataJson?: string | null;
  }): CoworkConversationMapping {
    const normalizedChannel = this.normalizeConversationChannel(input.channel);
    const normalizedConversationId = this.normalizeExternalConversationId(input.externalConversationId);
    const normalizedMetabotId = this.normalizeMappingMetabotId(input.metabotId);
    const sessionId = String(input.coworkSessionId || '').trim();
    if (!normalizedChannel || !normalizedConversationId || !sessionId) {
      throw new Error('Invalid conversation mapping input');
    }
    const now = Date.now();

    this.db.run(`
      INSERT INTO cowork_conversation_mappings (
        channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, external_conversation_id, metabot_id) DO UPDATE SET
        cowork_session_id = excluded.cowork_session_id,
        metadata_json = COALESCE(excluded.metadata_json, cowork_conversation_mappings.metadata_json),
        last_active_at = excluded.last_active_at
    `, [
      normalizedChannel,
      normalizedConversationId,
      normalizedMetabotId,
      sessionId,
      input.metadataJson ?? null,
      now,
      now,
    ]);
    this.saveDb();

    const row = this.getOne<CoworkConversationMappingRow>(`
      SELECT channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      FROM cowork_conversation_mappings
      WHERE channel = ? AND external_conversation_id = ? AND metabot_id = ?
      LIMIT 1
    `, [normalizedChannel, normalizedConversationId, normalizedMetabotId]);

    if (!row) {
      throw new Error('Failed to upsert conversation mapping');
    }
    return this.mapConversationMappingRow(row);
  }

  /**
   * Find the most recent metaweb_order session for a given (metabotId, peerGlobalMetaId) pair.
   * Used by the buyer side to detect incoming order replies and attach them to the right session.
   */
  findOrderSessionByPeer(metabotId: number, peerGlobalMetaId: string): CoworkConversationMapping | null {
    const normalizedMetabotId = this.normalizeMappingMetabotId(metabotId);
    // Primary: match by peer_global_metaid column on the session
    const row = this.getOne<CoworkConversationMappingRow>(`
      SELECT m.channel, m.external_conversation_id, m.metabot_id, m.cowork_session_id, m.metadata_json, m.created_at, m.last_active_at
      FROM cowork_conversation_mappings m
      JOIN cowork_sessions s ON s.id = m.cowork_session_id
      WHERE m.channel = 'metaweb_order'
        AND m.metabot_id = ?
        AND s.peer_global_metaid = ?
      ORDER BY m.last_active_at DESC
      LIMIT 1
    `, [normalizedMetabotId, peerGlobalMetaId]);
    if (row) return this.mapConversationMappingRow(row);

    // Fallback: match by peerGlobalMetaId stored in metadata_json (handles providerMetaId vs providerGlobalMetaId mismatch)
    const fallbackRow = this.getOne<CoworkConversationMappingRow>(`
      SELECT channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      FROM cowork_conversation_mappings
      WHERE channel = 'metaweb_order'
        AND metabot_id = ?
        AND metadata_json LIKE ?
      ORDER BY last_active_at DESC
      LIMIT 1
    `, [normalizedMetabotId, `%"peerGlobalMetaId":"${peerGlobalMetaId}"%`]);
    return fallbackRow ? this.mapConversationMappingRow(fallbackRow) : null;
  }

  findOrderSessionByOrderTxid(
    metabotId: number,
    peerGlobalMetaId: string,
    orderTxid: string,
    role?: 'buyer' | 'seller'
  ): CoworkConversationMapping | null {
    const normalizedMetabotId = this.normalizeMappingMetabotId(metabotId);
    const normalizedOrderTxid = String(orderTxid || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(normalizedOrderTxid)) return null;
    const roleClause = role ? 'AND m.metadata_json LIKE ?' : '';
    const params: (string | number)[] = [
      normalizedMetabotId,
      peerGlobalMetaId,
      `%"orderTxid":"${normalizedOrderTxid}"%`,
    ];
    if (role) {
      params.push(`%"role":"${role}"%`);
    }
    const row = this.getOne<CoworkConversationMappingRow>(`
      SELECT m.channel, m.external_conversation_id, m.metabot_id, m.cowork_session_id, m.metadata_json, m.created_at, m.last_active_at
      FROM cowork_conversation_mappings m
      JOIN cowork_sessions s ON s.id = m.cowork_session_id
      WHERE m.channel = 'metaweb_order'
        AND m.metabot_id = ?
        AND s.peer_global_metaid = ?
        AND m.metadata_json LIKE ?
        ${roleClause}
      ORDER BY m.last_active_at DESC
      LIMIT 1
    `, params);
    return row ? this.mapConversationMappingRow(row) : null;
  }

  findOrderSessionByOrderPinId(
    metabotId: number,
    peerGlobalMetaId: string,
    orderPinId: string,
    role?: 'buyer' | 'seller'
  ): CoworkConversationMapping | null {
    const normalizedMetabotId = this.normalizeMappingMetabotId(metabotId);
    const normalizedOrderPinId = String(orderPinId || '').trim();
    const normalizedPeerGlobalMetaId = String(peerGlobalMetaId || '').trim();
    if (!normalizedOrderPinId || !normalizedPeerGlobalMetaId) return null;

    const roleClause = role ? 'AND m.metadata_json LIKE ?' : '';
    const params: (string | number)[] = [
      normalizedMetabotId,
      normalizedPeerGlobalMetaId,
      `%"serviceOrderPinId":"${normalizedOrderPinId}"%`,
      `%"orderPinId":"${normalizedOrderPinId}"%`,
    ];
    if (role) {
      params.push(`%"role":"${role}"%`);
    }
    const row = this.getOne<CoworkConversationMappingRow>(`
      SELECT m.channel, m.external_conversation_id, m.metabot_id, m.cowork_session_id, m.metadata_json, m.created_at, m.last_active_at
      FROM cowork_conversation_mappings m
      JOIN cowork_sessions s ON s.id = m.cowork_session_id
      WHERE m.channel = 'metaweb_order'
        AND m.metabot_id = ?
        AND s.peer_global_metaid = ?
        AND (m.metadata_json LIKE ? OR m.metadata_json LIKE ?)
        ${roleClause}
      ORDER BY m.last_active_at DESC
      LIMIT 1
    `, params);
    if (row) return this.mapConversationMappingRow(row);

    if (!this.tableExists('service_orders')) return null;
    const serviceOrderRoleClause = role ? 'AND o.role = ?' : '';
    const serviceOrderParams: (string | number)[] = [
      normalizedMetabotId,
      normalizedPeerGlobalMetaId,
      normalizedOrderPinId,
    ];
    if (role) serviceOrderParams.push(role);
    const serviceOrderRow = this.getOne<CoworkConversationMappingRow>(`
      SELECT m.channel, m.external_conversation_id, m.metabot_id, m.cowork_session_id, m.metadata_json, m.created_at, m.last_active_at
      FROM service_orders o
      JOIN cowork_conversation_mappings m
        ON m.channel = 'metaweb_order'
       AND m.metabot_id = o.local_metabot_id
       AND m.cowork_session_id = o.cowork_session_id
      WHERE o.local_metabot_id = ?
        AND o.counterparty_global_metaid = ?
        AND o.order_pin_id = ?
        ${serviceOrderRoleClause}
      ORDER BY o.updated_at DESC, m.last_active_at DESC
      LIMIT 1
    `, serviceOrderParams);
    return serviceOrderRow ? this.mapConversationMappingRow(serviceOrderRow) : null;
  }

  updateConversationMappingMetadata(
    channel: string,
    externalConversationId: string,
    metabotId: number | null,
    metadata: Record<string, unknown>
  ): void {
    const normalizedChannel = this.normalizeConversationChannel(channel);
    const normalizedConversationId = this.normalizeExternalConversationId(externalConversationId);
    if (!normalizedChannel || !normalizedConversationId) return;
    const normalizedMetabotId = this.normalizeMappingMetabotId(metabotId);
    this.db.run(`
      UPDATE cowork_conversation_mappings
      SET metadata_json = ?
      WHERE channel = ? AND external_conversation_id = ? AND metabot_id = ?
    `, [JSON.stringify(metadata), normalizedChannel, normalizedConversationId, normalizedMetabotId]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  touchConversationMapping(channel: string, externalConversationId: string, metabotId?: number | null): void {
    const normalizedChannel = this.normalizeConversationChannel(channel);
    const normalizedConversationId = this.normalizeExternalConversationId(externalConversationId);
    if (!normalizedChannel || !normalizedConversationId) return;
    const normalizedMetabotId = this.normalizeMappingMetabotId(metabotId);
    this.db.run(`
      UPDATE cowork_conversation_mappings
      SET last_active_at = ?
      WHERE channel = ? AND external_conversation_id = ? AND metabot_id = ?
    `, [Date.now(), normalizedChannel, normalizedConversationId, normalizedMetabotId]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  ensureCanonicalPeerSessionShape(input: {
    sessionId: string;
    metabotId: number;
    peerGlobalMetaId: string;
    peerName?: string | null;
    peerAvatar?: string | null;
  }): boolean {
    const sessionId = String(input.sessionId || '').trim();
    const peerGlobalMetaId = String(input.peerGlobalMetaId || '').trim();
    if (!sessionId || !peerGlobalMetaId) return false;

    const session = this.getSessionWithoutMessages(sessionId);
    if (!session) return false;

    const existingPeer = String(session.peerGlobalMetaId || '').trim();
    if (existingPeer && existingPeer !== peerGlobalMetaId) {
      return false;
    }

    const existingMetabotId = parseIdNumber(session.metabotId);
    if (existingMetabotId != null && existingMetabotId !== input.metabotId) {
      return false;
    }

    const peerName = String(input.peerName || '').trim();
    const peerAvatar = String(input.peerAvatar || '').trim();
    this.db.run(`
      UPDATE cowork_sessions
      SET
        session_type = 'a2a',
        metabot_id = COALESCE(metabot_id, ?),
        peer_global_metaid = ?,
        peer_name = CASE
          WHEN ? <> '' THEN ?
          ELSE peer_name
        END,
        peer_avatar = CASE
          WHEN ? <> '' THEN ?
          ELSE peer_avatar
        END
      WHERE id = ?
    `, [
      input.metabotId,
      peerGlobalMetaId,
      peerName,
      peerName,
      peerAvatar,
      peerAvatar,
      sessionId,
    ]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
    return true;
  }

  /**
   * Update the stored peer display profile (name/avatar) of an A2A session
   * after a refresh from the latest chain data. Also renames the session
   * title when it still equals the previous peer name (sessions created from
   * the Bot Browser use the peer name as their title), and syncs the
   * metaweb_private conversation mapping metadata so future reads stay
   * consistent. Returns true when the session row was updated.
   */
  updateA2APeerProfile(
    sessionId: string,
    input: { peerName?: string | null; peerAvatar?: string | null }
  ): boolean {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) return false;
    const session = this.getSessionWithoutMessages(normalizedSessionId);
    if (!session || session.sessionType !== 'a2a') return false;

    const peerName = String(input.peerName || '').trim() || session.peerName || null;
    const peerAvatar = String(input.peerAvatar || '').trim() || session.peerAvatar || null;
    const previousPeerName = String(session.peerName || '').trim();
    const shouldRetitle = Boolean(
      peerName
      && previousPeerName
      && String(session.title || '').trim() === previousPeerName
      && peerName !== previousPeerName
    );

    this.db.run(`
      UPDATE cowork_sessions
      SET peer_name = ?, peer_avatar = ?, title = CASE WHEN ? THEN ? ELSE title END, updated_at = ?
      WHERE id = ?
    `, [peerName, peerAvatar, shouldRetitle ? 1 : 0, shouldRetitle ? peerName : session.title, Date.now(), normalizedSessionId]);
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (!updated) return false;
    this.saveDb();

    const mappings = this.getAll<{
      channel: string;
      external_conversation_id: string;
      metabot_id: number | null;
      metadata_json: string | null;
    }>(`
      SELECT channel, external_conversation_id, metabot_id, metadata_json
      FROM cowork_conversation_mappings
      WHERE cowork_session_id = ?
    `, [normalizedSessionId]);
    for (const mapping of mappings) {
      if (this.normalizeConversationChannel(mapping.channel) !== 'metaweb_private') continue;
      let metadata: Record<string, unknown> = {};
      try {
        metadata = mapping.metadata_json ? JSON.parse(mapping.metadata_json) as Record<string, unknown> : {};
      } catch { /* keep empty metadata on parse failure */ }
      this.updateConversationMappingMetadata(
        mapping.channel,
        mapping.external_conversation_id,
        mapping.metabot_id,
        { ...metadata, peerName, peerAvatar },
      );
    }
    return true;
  }

  deleteConversationMapping(channel: string, externalConversationId: string, metabotId?: number | null): void {
    const normalizedChannel = this.normalizeConversationChannel(channel);
    const normalizedConversationId = this.normalizeExternalConversationId(externalConversationId);
    if (!normalizedChannel || !normalizedConversationId) return;
    if (metabotId == null) {
      this.db.run(`
        DELETE FROM cowork_conversation_mappings
        WHERE channel = ? AND external_conversation_id = ?
      `, [normalizedChannel, normalizedConversationId]);
    } else {
      this.db.run(`
        DELETE FROM cowork_conversation_mappings
        WHERE channel = ? AND external_conversation_id = ? AND metabot_id = ?
      `, [normalizedChannel, normalizedConversationId, this.normalizeMappingMetabotId(metabotId)]);
    }
    this.saveDb();
  }

  deleteConversationMappingsByChannel(channel: string): void {
    const normalizedChannel = this.normalizeConversationChannel(channel);
    if (!normalizedChannel) return;
    this.db.run('DELETE FROM cowork_conversation_mappings WHERE channel = ?', [normalizedChannel]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  deleteConversationMappingsBySession(sessionId: string): void {
    this.db.run('DELETE FROM cowork_conversation_mappings WHERE cowork_session_id = ?', [sessionId]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  getConversationSourceContextBySession(sessionId?: string): {
    sourceChannel: string;
    externalConversationId: string | null;
  } {
    const context = this.getMemoryScopeResolutionContextBySession(sessionId);
    return {
      sourceChannel: context.sourceChannel || 'cowork_ui',
      externalConversationId: context.externalConversationId ?? sessionId ?? null,
    };
  }

  createSession(
    title: string,
    cwd: string,
    systemPrompt: string = '',
    executionMode: CoworkExecutionMode = 'local',
    activeSkillIds: string[] = [],
    metabotId: number | null = null,
    sessionType: CoworkSessionType = 'standard',
    peerGlobalMetaId: string | null = null,
    peerName: string | null = null,
    peerAvatar: string | null = null,
    permissionMode: CoworkPermissionMode = 'default',
    model: string | null = null,
    effort: string | null = null,
    modelProvider: string | null = null,
    projectId: string | null = null,
    goal: CoworkSessionGoal | null = null,
    parentSessionId: string | null = null,
    assistantMode: boolean = false
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db.run(`
      INSERT INTO cowork_sessions (id, title, claude_session_id, status, cwd, system_prompt, execution_mode, active_skill_ids, metabot_id, pinned, session_type, peer_global_metaid, peer_name, peer_avatar, permission_mode, model, effort, model_provider, project_id, goal, parent_session_id, assistant_mode, created_at, updated_at)
      VALUES (?, ?, NULL, 'idle', ?, '', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, title, cwd, resolveCoworkExecutionMode(executionMode), JSON.stringify(activeSkillIds), metabotId, sessionType, peerGlobalMetaId, peerName, peerAvatar, permissionMode, model, effort, modelProvider, projectId, goal ? serializeSessionGoal(goal) : null, parentSessionId, assistantMode ? 1 : 0, now, now]);

    if (systemPrompt && this.tableExists('cowork_session_prompts')) {
      this.db.run(`
        INSERT INTO cowork_session_prompts (session_id, system_prompt, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          system_prompt = excluded.system_prompt,
          updated_at = excluded.updated_at
      `, [id, systemPrompt, now]);
    } else if (systemPrompt) {
      this.db.run('UPDATE cowork_sessions SET system_prompt = ? WHERE id = ?', [systemPrompt, id]);
    }

    this.upsertConversationMapping({
      channel: 'cowork_ui',
      externalConversationId: id,
      metabotId,
      coworkSessionId: id,
      metadataJson: null,
    });

    this.saveDb();

    return {
      id,
      title,
      claudeSessionId: null,
      status: 'idle',
      pinned: false,
      cwd,
      systemPrompt,
      executionMode: resolveCoworkExecutionMode(executionMode),
      activeSkillIds,
      messages: [],
      createdAt: now,
      updatedAt: now,
      metabotId: metabotId ?? undefined,
      sessionType,
      peerGlobalMetaId,
      peerName,
      peerAvatar,
      // Auto-created flows stamp the real origin with setSessionAutoOrigin right
      // after this call; a freshly created row starts human-initiated.
      autoOrigin: null,
      foldOverride: null,
      followUpState: null,
      followUpSource: null,
      followUpAt: null,
      permissionMode,
      model,
      effort,
      modelProvider,
      projectId,
      goal,
      parentSessionId: parentSessionId ?? undefined,
      assistantMode,
    };
  }

  getSession(id: string): CoworkSession | null {
    const session = this.getSessionWithoutMessages(id);
    if (!session) return null;
    return {
      ...session,
      messages: this.getSessionMessages(id),
    };
  }

  /**
   * A session as the renderer opens it: its newest messages plus the state
   * needed to page the rest in. A real conversation reaches five figures of
   * messages and 12MB of content, and the whole transcript used to cross IPC on
   * every open, every stream completion and every summary refresh (11,554
   * messages / 12.1MB for the largest session in a live library) only for the
   * transcript to render its newest screenful.
   *
   * Browser-panel sessions are the one exception: the Bot Browser side panel
   * renders a minimal projection of the transcript and has no "load earlier"
   * affordance, so those keep the full read.
   */
  getSessionView(id: string, messageLimit: number = COWORK_SESSION_VIEW_MESSAGE_LIMIT): CoworkSession | null {
    const session = this.getSessionWithoutMessages(id);
    if (!session) return null;
    if (session.sessionType === 'a2a') {
      const limit = normalizeCoworkMessagePageRequest({ limit: messageLimit }).limit;
      const page = this.getSessionMessagesPage(id, { limit, displayWindow: true });
      // Thread aggregation: "load earlier" must be offered not only while the
      // session's own window has more, but also when previous episodes of the
      // thread exist below it.
      const hasEarlierEpisodes = this.getOne<{ found: number }>(`
        SELECT 1 AS found
        FROM a2a_conversation_episodes anchor
        WHERE anchor.session_id = ?
          AND EXISTS (
            SELECT 1 FROM a2a_conversation_episodes earlier
            WHERE earlier.thread_id = anchor.thread_id
              AND earlier.episode_index < anchor.episode_index
          )
        LIMIT 1
      `, [id]) != null;
      let messages = page.messages;
      let hasMoreBefore = page.hasMoreBefore || hasEarlierEpisodes;
      let beforeSequence = page.beforeSequence;
      let beforeEpisodeIndex: number | null = null;
      // A successor episode often holds only the tail of a long bot-to-bot
      // thread. Opening it alone looks like the peer's unrolled session is
      // missing days of messages. Fill the rest of this display page from
      // the previous episodes so both perspectives open on the same span.
      if (!page.hasMoreBefore && hasEarlierEpisodes && messages.length < limit) {
        const earlier = this.getA2AConversationHistoryPage(id, {
          beforeCursor: { episodeIndex: null, beforeSequence: null },
          limit: limit - messages.length,
        });
        if (earlier && earlier.messages.length > 0) {
          messages = [
            ...earlier.messages.map((entry) => ({
              ...entry.message,
              metadata: {
                ...(entry.message.metadata ?? {}),
                a2aEpisodeIndex: entry.episodeIndex,
              },
            })),
            ...messages,
          ];
          hasMoreBefore = earlier.hasMoreBefore;
          beforeSequence = earlier.beforeCursor?.beforeSequence ?? null;
          beforeEpisodeIndex = earlier.beforeCursor?.episodeIndex ?? null;
        }
      }
      return {
        ...session,
        messages,
        messageHistory: {
          hasMoreBefore,
          beforeSequence,
          pageSize: limit,
          beforeEpisodeIndex,
        },
      };
    }
    const page = this.getSessionMessagesPage(id, { limit: messageLimit });
    return {
      ...session,
      messages: page.messages,
      messageHistory: {
        hasMoreBefore: page.hasMoreBefore,
        beforeSequence: null,
        beforeTranscriptCursor: page.beforeTranscriptCursor ?? null,
        pageSize: normalizeCoworkMessagePageRequest({ limit: messageLimit }).limit,
        beforeEpisodeIndex: null,
      },
    };
  }

  getSessionWithoutMessages(id: string): CoworkSession | null {
    interface SessionRow {
      id: string;
      title: string;
      claude_session_id: string | null;
      status: string;
      pinned?: number | null;
      cwd: string;
      system_prompt: string;
      execution_mode?: string | null;
      active_skill_ids?: string | null;
      metabot_id?: number | string | null;
      session_type?: string | null;
      peer_global_metaid?: string | null;
      peer_name?: string | null;
      peer_avatar?: string | null;
      browser_uri?: string | null;
      browser_title?: string | null;
      assistant_mode?: number | null;
      hidden_from_session_list?: number | null;
      im_channel?: string | null;
      im_conversation_id?: string | null;
      auto_origin?: string | null;
      fold_override?: string | null;
      follow_up_state?: string | null;
      follow_up_source?: string | null;
      follow_up_at?: string | null;
      permission_mode?: string | null;
      parent_session_id?: string | null;
      fork_point_message_id?: string | null;
      model?: string | null;
      model_provider?: string | null;
      effort?: string | null;
      project_id?: string | null;
      goal?: string | null;
      created_at: number;
      updated_at: number;
    }

    const hasPromptsTable = this.tableExists('cowork_session_prompts');
    const row = this.getOne<SessionRow>(`
      SELECT cowork_sessions.id, cowork_sessions.title, cowork_sessions.claude_session_id, cowork_sessions.status, cowork_sessions.pinned, cowork_sessions.cwd,
             ${hasPromptsTable ? "COALESCE(NULLIF(sp.system_prompt, ''), cowork_sessions.system_prompt, '')" : 'cowork_sessions.system_prompt'} AS system_prompt,
             cowork_sessions.execution_mode, cowork_sessions.active_skill_ids, cowork_sessions.metabot_id,
             cowork_sessions.session_type, cowork_sessions.peer_global_metaid, cowork_sessions.peer_name, cowork_sessions.peer_avatar, cowork_sessions.browser_uri, cowork_sessions.browser_title, cowork_sessions.hidden_from_session_list, cowork_sessions.assistant_mode,
             (
               SELECT im.channel FROM cowork_conversation_mappings im
               WHERE im.cowork_session_id = cowork_sessions.id AND im.channel LIKE 'im:%'
               ORDER BY (im.channel LIKE 'im:%:group') DESC, im.last_active_at DESC
               LIMIT 1
             ) AS im_channel,
             (
               SELECT im.external_conversation_id FROM cowork_conversation_mappings im
               WHERE im.cowork_session_id = cowork_sessions.id AND im.channel LIKE 'im:%'
               ORDER BY (im.channel LIKE 'im:%:group') DESC, im.last_active_at DESC
               LIMIT 1
             ) AS im_conversation_id,
             cowork_sessions.auto_origin, cowork_sessions.fold_override, cowork_sessions.follow_up_state, cowork_sessions.follow_up_source, cowork_sessions.follow_up_at, cowork_sessions.permission_mode, cowork_sessions.parent_session_id, cowork_sessions.fork_point_message_id, cowork_sessions.model, cowork_sessions.model_provider, cowork_sessions.effort, cowork_sessions.project_id, cowork_sessions.goal, cowork_sessions.created_at, cowork_sessions.updated_at
      FROM cowork_sessions
      ${hasPromptsTable ? 'LEFT JOIN cowork_session_prompts sp ON sp.session_id = cowork_sessions.id' : ''}
      WHERE cowork_sessions.id = ?
    `, [id]);

    if (!row) return null;

    let activeSkillIds: string[] = [];
    if (row.active_skill_ids) {
      try {
        activeSkillIds = JSON.parse(row.active_skill_ids);
      } catch {
        activeSkillIds = [];
      }
    }

    const metabotId = parseIdNumber(row.metabot_id);
    let metabotName: string | null = null;
    let metabotAvatar: string | null = null;
    if (metabotId != null) {
      interface MetabotNameRow { name: string; avatar: string | Uint8Array | null; }
      const mbRow = this.getOne<MetabotNameRow>('SELECT name, avatar FROM metabots WHERE id = ? LIMIT 1', [metabotId]);
      if (mbRow) {
        metabotName = mbRow.name;
        metabotAvatar = normalizeMetabotAvatarForDisplay(mbRow.avatar);
      }
    }

    return {
      id: row.id,
      title: row.title,
      claudeSessionId: row.claude_session_id,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      cwd: row.cwd,
      systemPrompt: row.system_prompt,
      executionMode: resolveCoworkExecutionMode(row.execution_mode),
      activeSkillIds,
      messages: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metabotId: metabotId ?? undefined,
      sessionType: (row.session_type === 'agent_agent' ? 'a2a' : row.session_type as CoworkSessionType) || 'standard',
      peerGlobalMetaId: row.peer_global_metaid ?? null,
      peerName: row.peer_name ?? null,
      peerAvatar: row.peer_avatar ?? null,
      hiddenFromSessionList: Boolean(row.hidden_from_session_list),
      imChannel: row.im_channel ?? null,
      imConversationId: row.im_conversation_id ?? null,
      autoOrigin: (row.auto_origin as CoworkSessionAutoOrigin | null) ?? null,
      foldOverride: (row.fold_override as CoworkSessionFoldOverride | null) ?? null,
      followUpState: (row.follow_up_state as 'pending' | null) ?? null,
      followUpSource: (row.follow_up_source as CoworkSessionFollowUpSource | null) ?? null,
      followUpAt: row.follow_up_at ?? null,
      browserUri: row.browser_uri ?? null,
      browserTitle: row.browser_title ?? null,
      assistantMode: Boolean(row.assistant_mode),
      permissionMode: (row.permission_mode as CoworkPermissionMode) || 'default',
      parentSessionId: row.parent_session_id ?? null,
      forkPointMessageId: row.fork_point_message_id ?? null,
      model: row.model ?? null,
      modelProvider: row.model_provider ?? null,
      effort: row.effort ?? null,
      projectId: row.project_id ?? null,
      goal: parseSessionGoal(row.goal),
      metabotName,
      metabotAvatar,
    };
  }

  getSessionMetadata(id: string): CoworkSessionMetadata | null {
    interface SessionMetadataRow {
      id: string;
      title: string;
      status: string;
      pinned?: number | null;
      metabot_id?: number | string | null;
      session_type?: string | null;
      peer_global_metaid?: string | null;
      peer_name?: string | null;
      hidden_from_session_list?: number | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SessionMetadataRow>(`
      SELECT id, title, status, pinned, metabot_id, session_type, peer_global_metaid,
             peer_name, hidden_from_session_list, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
    `, [id]);

    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metabotId: parseIdNumber(row.metabot_id) ?? undefined,
      sessionType: (row.session_type === 'agent_agent' ? 'a2a' : row.session_type as CoworkSessionType) || 'standard',
      peerGlobalMetaId: row.peer_global_metaid ?? null,
      peerName: row.peer_name ?? null,
      hiddenFromSessionList: Boolean(row.hidden_from_session_list),
    };
  }

  updateSession(
    id: string,
    updates: Partial<Pick<CoworkSession, 'title' | 'claudeSessionId' | 'status' | 'cwd' | 'systemPrompt' | 'executionMode' | 'browserUri' | 'browserTitle' | 'permissionMode' | 'parentSessionId' | 'forkPointMessageId' | 'activeSkillIds' | 'projectId' | 'goal'>>
  ): void {
    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }
    if (updates.claudeSessionId !== undefined) {
      setClauses.push('claude_session_id = ?');
      values.push(updates.claudeSessionId);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.cwd !== undefined) {
      setClauses.push('cwd = ?');
      values.push(updates.cwd);
    }
    if (updates.systemPrompt !== undefined) {
      if (this.tableExists('cowork_session_prompts')) {
        setClauses.push("system_prompt = ''");
        if (updates.systemPrompt) {
          this.db.run(`
            INSERT INTO cowork_session_prompts (session_id, system_prompt, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              system_prompt = excluded.system_prompt,
              updated_at = excluded.updated_at
          `, [id, updates.systemPrompt, now]);
        } else {
          this.db.run('DELETE FROM cowork_session_prompts WHERE session_id = ?', [id]);
        }
      } else {
        setClauses.push('system_prompt = ?');
        values.push(updates.systemPrompt);
      }
    }
    if (updates.executionMode !== undefined) {
      setClauses.push('execution_mode = ?');
      values.push(resolveCoworkExecutionMode(updates.executionMode));
    }
    if (updates.browserUri !== undefined) {
      setClauses.push('browser_uri = ?');
      values.push(updates.browserUri);
    }
    if (updates.browserTitle !== undefined) {
      setClauses.push('browser_title = ?');
      values.push(updates.browserTitle);
    }
    if (updates.permissionMode !== undefined) {
      setClauses.push('permission_mode = ?');
      values.push(updates.permissionMode);
    }
    if (updates.forkPointMessageId !== undefined) {
      setClauses.push('fork_point_message_id = ?');
      values.push(updates.forkPointMessageId);
    }
    if (updates.activeSkillIds !== undefined) {
      setClauses.push('active_skill_ids = ?');
      values.push(JSON.stringify(updates.activeSkillIds));
    }
    if (updates.projectId !== undefined) {
      setClauses.push('project_id = ?');
      values.push(updates.projectId);
    }
    if (updates.goal !== undefined) {
      setClauses.push('goal = ?');
      values.push(updates.goal ? serializeSessionGoal(updates.goal) : null);
    }

    values.push(id);
    this.db.run(`
      UPDATE cowork_sessions
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `, values);

    this.saveDb();
  }

  /**
   * Persist per-session token/cache usage stats so the usage chip survives app
   * restarts. The in-memory CoworkRunner map is lost on restart; this column
   * is the durable copy. Accepts a null/undefined value to clear.
   */
  setSessionUsageStats(sessionId: string, usageStats: Record<string, unknown> | null): void {
    const now = Date.now();
    this.db.run(
      'UPDATE cowork_sessions SET usage_stats = ?, updated_at = ? WHERE id = ?',
      [usageStats ? JSON.stringify(usageStats) : null, now, sessionId]
    );
    this.saveDb();
  }

  /** Read persisted per-session usage stats (null when none stored). */
  getSessionUsageStats(sessionId: string): Record<string, unknown> | null {
    const row = this.getOne<{ usage_stats: string | null }>(
      'SELECT usage_stats FROM cowork_sessions WHERE id = ? LIMIT 1',
      [sessionId]
    );
    if (!row?.usage_stats) return null;
    try {
      return JSON.parse(row.usage_stats) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  deleteSession(id: string): void {
    const session = this.getSessionWithoutMessages(id);
    const a2aEpisode = this.getOne<CoworkA2AEpisodeRow>(`
      SELECT * FROM a2a_conversation_episodes WHERE session_id = ? LIMIT 1
    `, [id]);
    const metabotId = session?.metabotId ?? this.getDefaultMetabotId();
    const sourceContext = this.getConversationSourceContextBySession(id);
    const resolvedWriteScope = metabotId == null
      ? createOwnerMemoryScope()
      : resolveMemoryScopes({
          metabotId,
          sourceChannel: sourceContext.sourceChannel,
          externalConversationId: sourceContext.externalConversationId,
          sessionType: session?.sessionType,
          peerGlobalMetaId: session?.peerGlobalMetaId,
        }).writeScope;
    this.markMemorySourcesInactiveBySession(id);
    this.db.run('DELETE FROM cowork_conversation_mappings WHERE cowork_session_id = ?', [id]);
    if (a2aEpisode) {
      if (a2aEpisode.previous_session_id) {
        this.db.run(`
          UPDATE a2a_conversation_episodes SET next_session_id = ? WHERE session_id = ?
        `, [a2aEpisode.next_session_id, a2aEpisode.previous_session_id]);
      }
      if (a2aEpisode.next_session_id) {
        this.db.run(`
          UPDATE a2a_conversation_episodes SET previous_session_id = ? WHERE session_id = ?
        `, [a2aEpisode.previous_session_id, a2aEpisode.next_session_id]);
      }
      this.db.run('DELETE FROM a2a_conversation_episodes WHERE session_id = ?', [id]);
    }
    if (this.tableExists('cowork_session_prompts')) {
      this.db.run('DELETE FROM cowork_session_prompts WHERE session_id = ?', [id]);
    }
    this.db.run('DELETE FROM cowork_sessions WHERE id = ?', [id]);
    if (a2aEpisode) {
      this.db.run(`
        DELETE FROM a2a_conversation_threads
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM a2a_conversation_episodes WHERE thread_id = ?
          )
      `, [a2aEpisode.thread_id, a2aEpisode.thread_id]);
    }
    if (metabotId != null) {
      this.markOrphanImplicitMemoriesStale(metabotId, { scope: resolvedWriteScope });
    }
    this.saveDb();
  }

  setSessionPinned(id: string, pinned: boolean): void {
    this.db.run('UPDATE cowork_sessions SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
    this.saveDb();
  }

  /**
   * Manual placement of a session in the sidebar's "Autonomous Tasks" fold.
   * 'in' parks a human row in the fold, 'out' pulls an auto-created run back
   * into the main list, null clears the override so the auto-origin policy
   * decides again. This is a pure renderer preference — it never touches the
   * session's content, status or origin marker.
   */
  setSessionFoldOverride(id: string, override: CoworkSessionFoldOverride | null): void {
    this.db.run('UPDATE cowork_sessions SET fold_override = ?, updated_at = ? WHERE id = ?', [
      override,
      Date.now(),
      id,
    ]);
    this.saveDb();
  }

  /**
   * Per-session model override. null clears the override so the session falls
   * back to the global default model again. The choice only affects this
   * session — other (running or idle) cowork sessions are untouched.
   * `effort` (optional) updates the per-session reasoning effort in the same
   * write; undefined leaves the stored effort untouched.
   * `modelProvider` is the provider key the model was picked from and is
   * required to disambiguate colliding model ids across providers.
   */
  setSessionModel(id: string, model: string | null, effort?: string | null, modelProvider?: string | null): void {
    const provider = model == null ? null : (modelProvider?.trim() || null);
    if (effort === undefined) {
      this.db.run('UPDATE cowork_sessions SET model = ?, model_provider = ?, updated_at = ? WHERE id = ?', [
        model,
        provider,
        Date.now(),
        id,
      ]);
    } else {
      this.db.run('UPDATE cowork_sessions SET model = ?, model_provider = ?, effort = ?, updated_at = ? WHERE id = ?', [
        model,
        provider,
        effort,
        Date.now(),
        id,
      ]);
    }
    this.saveDb();
  }

  /**
   * Archive a session: it disappears from the UI list, but all raw records
   * (messages, mappings, derived memories) are preserved and remain visible
   * to the dream consolidation and experience retrieval. Archiving — not
   * deletion — is the user-facing way to put a conversation away, because a
   * bot's history is part of who it is.
   */
  archiveSession(id: string): void {
    this.db.run('UPDATE cowork_sessions SET archived_at = ?, updated_at = ? WHERE id = ?', [
      Date.now(),
      Date.now(),
      id,
    ]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  unarchiveSession(id: string): void {
    this.db.run('UPDATE cowork_sessions SET archived_at = NULL, updated_at = ? WHERE id = ?', [
      Date.now(),
      id,
    ]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  isSessionArchived(id: string): boolean {
    const row = this.getOne<{ archived_at?: number | null }>(
      'SELECT archived_at FROM cowork_sessions WHERE id = ? LIMIT 1',
      [id],
    );
    return row?.archived_at != null;
  }

  setSessionHiddenFromList(id: string, hidden: boolean): void {
    this.db.run('UPDATE cowork_sessions SET hidden_from_session_list = ?, updated_at = ? WHERE id = ?', [
      hidden ? 1 : 0,
      Date.now(),
      id,
    ]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  isSessionHiddenFromList(id: string): boolean {
    const row = this.getOne<{ hidden_from_session_list?: number | null }>(
      'SELECT hidden_from_session_list FROM cowork_sessions WHERE id = ? LIMIT 1',
      [id],
    );
    return Boolean(row?.hidden_from_session_list);
  }

  /**
   * Stamp the auto-origin marker on a session the app created on its own.
   * Called right after createSession by the three auto-creating flows
   * (long-term task, orchestration/delegation, scheduled run); human sessions
   * leave the column NULL.
   */
  setSessionAutoOrigin(sessionId: string, autoOrigin: CoworkSessionAutoOrigin): void {
    this.db.run('UPDATE cowork_sessions SET auto_origin = ?, updated_at = ? WHERE id = ?', [
      autoOrigin,
      Date.now(),
      sessionId,
    ]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  /**
   * Auto-origin marker of one session (NULL = human-initiated). The long-term
   * heartbeat's session-rotation ownership check: only sessions the heartbeat
   * created itself ('longterm') are ever rotated.
   */
  getSessionAutoOrigin(sessionId: string): CoworkSessionAutoOrigin | null {
    const row = this.getOne<{ auto_origin: string | null }>(
      'SELECT auto_origin FROM cowork_sessions WHERE id = ?',
      [sessionId],
    );
    return (row?.auto_origin as CoworkSessionAutoOrigin | null) ?? null;
  }

  /**
   * Mark a session as waiting on the owner for the "Follow-Up Tasks"
   * (待跟进任务) sidebar section. Stamps state 'pending', the lane that set
   * it, and the transition time. Manual pins are sticky: an existing pending
   * marker with source 'manual' is never overwritten by another lane (the
   * owner deliberately parked the row), while a manual write always lands.
   */
  setSessionFollowUp(sessionId: string, source: CoworkSessionFollowUpSource): void {
    this.db.run(
      `UPDATE cowork_sessions
       SET follow_up_state = 'pending', follow_up_source = ?, follow_up_at = ?, updated_at = ?
       WHERE id = ?
         AND (
           ? = 'manual'
           OR follow_up_state IS NULL
           OR follow_up_source IS NULL
           OR follow_up_source != 'manual'
         )`,
      [source, new Date().toISOString(), Date.now(), sessionId, source],
    );
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  /**
   * Clear the follow-up marker so the session falls back to the auto-origin
   * policy. When `onlySources` is given, only a pending marker whose current
   * source is in the list is cleared — the cerebellum classifier uses this to
   * leave manual and structured (ask_user) markers untouched. Without
   * `onlySources` any pending marker is cleared (the manual 移出待跟进 move).
   */
  clearSessionFollowUp(
    sessionId: string,
    opts?: { onlySources?: CoworkSessionFollowUpSource[] },
  ): void {
    if (opts?.onlySources !== undefined) {
      // Lane-guarded clear: only a pending marker whose current source is in
      // the list is cleared (the cerebellum classifier never touches 'manual'
      // or 'ask_user' markers). An explicit empty list matches no lane and
      // therefore clears nothing — only an ABSENT onlySources means "clear
      // any pending" (the manual 移出待跟进 move).
      const onlySources = opts.onlySources.filter((source): source is CoworkSessionFollowUpSource =>
        source === 'cerebellum' || source === 'ask_user' || source === 'manual',
      );
      if (onlySources.length === 0) return;
      const placeholders = onlySources.map(() => '?').join(', ');
      this.db.run(
        `UPDATE cowork_sessions
         SET follow_up_state = NULL, follow_up_source = NULL, follow_up_at = NULL, updated_at = ?
         WHERE id = ? AND follow_up_source IN (${placeholders})`,
        [Date.now(), sessionId, ...onlySources],
      );
    } else {
      this.db.run(
        `UPDATE cowork_sessions
         SET follow_up_state = NULL, follow_up_source = NULL, follow_up_at = NULL, updated_at = ?
         WHERE id = ?`,
        [Date.now(), sessionId],
      );
    }
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  /**
   * Startup residue sweep for the Follow-Up Tasks bucket: an 'ask_user'
   * marker persisted by a previous process is ALWAYS stale — the pending
   * AskUserQuestion lives only in that process's memory (CoworkRunner's
   * pendingPermissions map) and can never be answered after a restart, so
   * without this sweep the row would park in Follow-Up forever. 'cerebellum'
   * verdicts and 'manual' pins are judgement/pin state that legitimately
   * survives restarts and stay untouched. Deliberately narrow: only the three
   * follow-up columns are reset — updated_at and every other column are left
   * alone so a pure residue sweep cannot perturb session-list ordering.
   * Called once when the app first makes the cowork store available.
   * Returns the number of cleared rows.
   */
  clearStaleAskUserFollowUpsAfterRestart(): number {
    if (!this.tableExists('cowork_sessions')) {
      return 0;
    }
    this.db.run(
      `UPDATE cowork_sessions
       SET follow_up_state = NULL, follow_up_source = NULL, follow_up_at = NULL
       WHERE follow_up_state = 'pending' AND follow_up_source = 'ask_user'`,
    );
    const cleared = this.db.getRowsModified?.() || 0;
    if (cleared > 0) {
      this.saveDb();
    }
    return cleared;
  }

  /**
   * Session ids currently parked in Follow-Up by one classifier lane, oldest
   * verdict first. The startup re-judge sweep consumes this: each row's last
   * turn gets re-classified under the CURRENT gate (threshold, instructions,
   * and the end-of-run follow-up tag) so verdicts written by an older gate
   * revision do not park in Follow-Up forever when their session never turns
   * again. 'manual' pins and 'ask_user' markers are never listed — they are
   * not the classifier's lane to re-judge.
   */
  listPendingFollowUpSessionIds(source: 'cerebellum', limit: number): string[] {
    if (!this.tableExists('cowork_sessions') || limit <= 0) {
      return [];
    }
    return this.getAll<{ id: string }>(
      `SELECT id FROM cowork_sessions
       WHERE follow_up_state = 'pending' AND follow_up_source = ?
       ORDER BY follow_up_at ASC
       LIMIT ?`,
      [source, limit],
    ).map((row) => row.id);
  }


  listSessions(options?: { metabotId?: number | null; omitInlinePeerDataAvatar?: boolean }): CoworkSessionSummary[] {
    interface SessionSummaryRow {
      id: string;
      title: string;
      status: string;
      pinned: number | null;
      metabot_id?: number | null;
      session_type?: string | null;
      peer_name?: string | null;
      peer_avatar?: string | null;
      peer_avatar_version?: number | null;
      metabot_name?: string | null;
      metabot_updated_at?: number | null;
      browser_uri?: string | null;
      browser_title?: string | null;
      assistant_mode?: number | null;
      hidden_from_session_list?: number | null;
      im_channel?: string | null;
      im_conversation_id?: string | null;
      auto_origin?: string | null;
      fold_override?: string | null;
      trade_badge?: string | null;
      follow_up_state?: string | null;
      follow_up_source?: string | null;
      follow_up_at?: string | null;
      model?: string | null;
      model_provider?: string | null;
      effort?: string | null;
      project_id?: string | null;
      cwd?: string | null;
      created_at: number;
      updated_at: number;
      stored_activity_at?: number | null;
      activity_at?: number | null;
    }

    const metabotId = options?.metabotId;
    const omitInlinePeerDataAvatar = options?.omitInlinePeerDataAvatar === true;
    const filterByMetabot = typeof metabotId === 'number' && Number.isInteger(metabotId) && metabotId > 0;
    const peerAvatarColumnsSql = omitInlinePeerDataAvatar
      ? `CASE WHEN s.peer_avatar LIKE 'data:%' THEN NULL ELSE s.peer_avatar END AS peer_avatar,
        CASE WHEN s.peer_avatar LIKE 'data:%' THEN (s.updated_at * 1000 + (LENGTH(s.peer_avatar) % 1000)) ELSE NULL END AS peer_avatar_version,`
      : `s.peer_avatar,
        NULL AS peer_avatar_version,`;
    const rows = this.getAll<SessionSummaryRow>(`
      WITH im_ranked AS (
        SELECT
          cowork_session_id,
          channel,
          external_conversation_id,
          ROW_NUMBER() OVER (
            PARTITION BY cowork_session_id
            ORDER BY (channel LIKE 'im:%:group') DESC, last_active_at DESC
          ) AS rn
        FROM cowork_conversation_mappings
        WHERE channel >= 'im:' AND channel < 'im;'
      )
      SELECT
        s.id,
        s.title,
        s.status,
        s.pinned,
        s.metabot_id,
        s.session_type,
        s.peer_name,
        ${peerAvatarColumnsSql}
        mb.name AS metabot_name,
        mb.updated_at AS metabot_updated_at,
        s.browser_uri,
        s.browser_title,
        s.assistant_mode,
        s.hidden_from_session_list,
        -- IM classification for the session row (badge + title fallback).
        -- Read from the mapping table so rows created BEFORE IM sessions moved
        -- from 'a2a' to 'standard' are classified identically without a
        -- destructive data migration. The :group channel wins over the
        -- legacy im:<platform> channel when both exist.
        im.channel AS im_channel,
        im.external_conversation_id AS im_conversation_id,
        s.auto_origin,
        s.fold_override,
        -- S4 chat trade markers: 'p2p' | 'escrow' | NULL (write-path
        -- maintained, migration backfilled once; see tradeBadge.ts).
        s.trade_badge,
        s.follow_up_state,
        s.follow_up_source,
        s.follow_up_at,
        s.model,
        s.model_provider,
        s.effort,
        s.project_id,
        s.cwd,
        s.created_at,
        s.updated_at,
        s.activity_at AS stored_activity_at,
        -- Sort by the LAST CONVERSATION EVENT time (a user message OR an
        -- on-chain A2A private DM synced into the session), not the newest
        -- assistant stream message: while tasks run, stream updates no longer
        -- reshuffle the session list top (no more flickering). The key is
        -- stored on the session row (activity_at) and maintained by the message
        -- write paths; this used to be the correlated subquery below, run once
        -- per session on every list read (0.3-0.83s on a real library, most of
        -- it metadata LIKE scans). The subquery stays as the fallback for a row
        -- the stamp has not reached yet (a pre-upgrade database before the
        -- deferred backfill, or a session that never saw an activity message),
        -- and COALESCE short-circuits, so the steady state never evaluates it.
        -- Stable tie-breakers keep the order deterministic.
        COALESCE(s.activity_at, ${coworkSessionActivityAtSelectSql('s')}) AS activity_at
      FROM cowork_sessions s
      LEFT JOIN metabots mb ON mb.id = s.metabot_id
      LEFT JOIN im_ranked im ON im.cowork_session_id = s.id AND im.rn = 1
      WHERE COALESCE(s.hidden_from_session_list, 0) = 0
      AND s.archived_at IS NULL
      -- Thread aggregation: a superseded A2A episode (a successor session
      -- took over the conversation) is not listed on its own — the thread's
      -- latest episode entry represents the whole bot-2-bot conversation.
      AND NOT EXISTS (
        SELECT 1 FROM a2a_conversation_episodes episode
        WHERE episode.session_id = s.id AND episode.next_session_id IS NOT NULL
      )
      ${filterByMetabot ? 'AND s.metabot_id = ?' : ''}
      ORDER BY s.pinned DESC, COALESCE(s.activity_at, s.updated_at) DESC, s.updated_at DESC, s.created_at DESC, s.id DESC
    `, filterByMetabot ? [metabotId] : []);

    const needsFallbackResort = rows.some(
      (row) => row.stored_activity_at == null && (parseIdNumber(row.activity_at) ?? row.updated_at) !== row.updated_at,
    );
    if (needsFallbackResort) {
      rows.sort((left, right) => {
        const pinDiff = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
        if (pinDiff !== 0) return pinDiff;
        const leftAct = parseIdNumber(left.activity_at) ?? left.updated_at;
        const rightAct = parseIdNumber(right.activity_at) ?? right.updated_at;
        if (rightAct !== leftAct) return rightAct - leftAct;
        if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at;
        if (right.created_at !== left.created_at) return right.created_at - left.created_at;
        return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
      });
    }

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: parseIdNumber(row.activity_at) ?? row.updated_at,
      metabotId: parseIdNumber(row.metabot_id),
      sessionType: (row.session_type === 'agent_agent' ? 'a2a' : row.session_type as CoworkSessionType) || 'standard',
      peerName: row.peer_name ?? null,
      peerAvatar: row.peer_avatar ?? null,
      ...(row.peer_avatar_version != null ? { peerAvatarVersion: parseIdNumber(row.peer_avatar_version) } : {}),
      metabotName: row.metabot_name ?? null,
      metabotAvatarVersion: parseIdNumber(row.metabot_updated_at),
      browserUri: row.browser_uri ?? null,
      browserTitle: row.browser_title ?? null,
      assistantMode: Boolean(row.assistant_mode),
      hiddenFromSessionList: Boolean(row.hidden_from_session_list),
      imChannel: row.im_channel ?? null,
      imConversationId: row.im_conversation_id ?? null,
      autoOrigin: (row.auto_origin as CoworkSessionAutoOrigin | null) ?? null,
      foldOverride: (row.fold_override as CoworkSessionFoldOverride | null) ?? null,
      tradeBadge: (row.trade_badge === 'p2p' || row.trade_badge === 'escrow' ? row.trade_badge : null),
      followUpState: (row.follow_up_state as 'pending' | null) ?? null,
      followUpSource: (row.follow_up_source as CoworkSessionFollowUpSource | null) ?? null,
      followUpAt: row.follow_up_at ?? null,
      model: row.model ?? null,
      modelProvider: row.model_provider ?? null,
      effort: row.effort ?? null,
      projectId: row.project_id ?? null,
      cwd: row.cwd ?? null,
    }));
  }

  /**
   * Display avatars of the given MetaBots, read from the same metabots.avatar
   * column listSessions used to inline. Avatar images travel over IPC once per
   * bot instead of once per session row: callers keep a cache keyed by the
   * metabotAvatarVersion the list rows carry and ask only for the ids whose
   * revision moved (unknown ids included). The id list is capped so a runaway
   * caller cannot exhaust the SQLite bind-parameter budget.
   */
  listMetabotAvatars(metabotIds?: number[] | null): Array<{ metabotId: number; avatar: string | null }> {
    const ids = Array.isArray(metabotIds)
      ? [...new Set(
          metabotIds
            .map((id) => parseIdNumber(id))
            .filter((id): id is number => typeof id === 'number' && id > 0),
        )].slice(0, 200)
      : [];
    if (ids.length === 0) {
      return [];
    }

    const rows = this.getAll<{ id?: number | null; avatar?: string | Uint8Array | null }>(
      `SELECT id, avatar FROM metabots WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );

    return rows.map((row) => ({
      metabotId: parseIdNumber(row.id) ?? 0,
      avatar: normalizeMetabotAvatarForDisplay(row.avatar),
    }));
  }

  listSessionPeerAvatars(sessionIds?: string[] | null): Array<{ sessionId: string; peerAvatar: string | null }> {
    const ids = Array.isArray(sessionIds)
      ? [...new Set(
          sessionIds
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter((id) => id.length > 0),
        )].slice(0, 200)
      : [];
    if (ids.length === 0) {
      return [];
    }

    const rows = this.getAll<{ id: string; peer_avatar?: string | null }>(
      `SELECT id, peer_avatar FROM cowork_sessions WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );

    return rows.map((row) => ({
      sessionId: row.id,
      peerAvatar: row.peer_avatar ?? null,
    }));
  }

  /**
   * Shared WHERE builder for archived-session listing/counting: archived rows,
   * optional bot filter, and text search across title / peer name / message
   * content. Content search is intentionally a LIKE scan (the UI accepts
   * slower results in exchange for finding older conversation bodies).
   */
  private buildArchivedSessionFilter(options?: {
    metabotId?: number | null;
    query?: string;
    /** When true, also match archived conversations whose message bodies contain the query. */
    searchContent?: boolean;
    /** Restrict to one session type ('a2a' = MetaBot↔MetaBot). */
    sessionType?: CoworkSessionType;
  }): { clauses: string[]; params: Array<string | number> } {
    const clauses: string[] = ['s.archived_at IS NOT NULL'];
    const params: Array<string | number> = [];

    const sessionType = options?.sessionType;
    if (sessionType) {
      if (sessionType === 'a2a') {
        // A2A sessions are stored as 'a2a'; legacy rows may hold 'agent_agent'.
        clauses.push("s.session_type IN ('a2a', 'agent_agent')");
      } else {
        clauses.push('s.session_type = ?');
        params.push(sessionType);
      }
    }

    const metabotId = options?.metabotId;
    if (typeof metabotId === 'number' && Number.isInteger(metabotId) && metabotId > 0) {
      clauses.push('s.metabot_id = ?');
      params.push(metabotId);
    }
    const query = options?.query?.trim();
    if (query) {
      const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`).toLowerCase();
      const titleClauses = [
        `LOWER(s.title) LIKE ? ESCAPE '\\'`,
        `LOWER(COALESCE(s.peer_name, '')) LIKE ? ESCAPE '\\'`,
      ];
      params.push(`%${escaped}%`, `%${escaped}%`);
      if (options?.searchContent === true) {
        if (this.canUseMessagesFts([query])) {
          titleClauses.push(`EXISTS (
            SELECT 1 FROM cowork_messages m
            WHERE m.session_id = s.id
              AND m.rowid IN (
                SELECT rowid FROM cowork_messages_fts WHERE cowork_messages_fts MATCH ?
              )
          )`);
          params.push(escapeFts5Phrase(query.toLowerCase()));
        } else {
          titleClauses.push(`EXISTS (
            SELECT 1 FROM cowork_messages m
            WHERE m.session_id = s.id AND LOWER(m.content) LIKE ? ESCAPE '\\'
          )`);
          params.push(`%${escaped}%`);
        }
      }
      clauses.push(`(${titleClauses.join(' OR ')})`);
    }
    return { clauses, params };
  }

  /** Total archived sessions matching the same filters (for pagination). */
  countArchivedSessions(options?: {
    metabotId?: number | null;
    query?: string;
    searchContent?: boolean;
    sessionType?: CoworkSessionType;
  }): number {
    const { clauses, params } = this.buildArchivedSessionFilter(options);
    const row = this.getOne<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM cowork_sessions s
      WHERE ${clauses.join(' AND ')}
    `, params);
    return Number(row?.count ?? 0);
  }

  /**
   * Message count of one session — the long-term heartbeat's session-rotation
   * budget check (indexed on cowork_messages.session_id).
   */
  countSessionMessages(sessionId: string): number {
    const row = this.getOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM cowork_messages WHERE session_id = ?',
      [sessionId],
    );
    return Number(row?.count ?? 0);
  }

  hasMultipleUserMessages(sessionId: string): boolean {
    const rows = this.getAll<{ found: number }>(
      "SELECT 1 AS found FROM cowork_messages WHERE session_id = ? AND type = 'user' LIMIT 2",
      [sessionId],
    );
    return rows.length > 1;
  }

  /**
   * Engagement signals for one session — the long-term heartbeat's
   * owner-presence / twin-activity probe over the task's related sessions.
   * "Owner" rows are user-typed messages: heartbeat escalation prompts
   * (metadata.origin="heartbeat") and bot-to-bot cross-session relays
   * (metadata.sourceChannel="idbots_cross_session") are both excluded —
   * neither is the owner talking.
   */
  getSessionEngagement(sessionId: string): { lastOwnerMessageAtMs: number | null; lastAssistantMessageAtMs: number | null } {
    const row = this.getOne<{ last_owner: number | null; last_assistant: number | null }>(
      `SELECT
         MAX(CASE WHEN type = 'user' AND (
           metadata IS NULL OR (
             instr(metadata, '"origin":"heartbeat"') = 0
             AND instr(metadata, '"sourceChannel":"idbots_cross_session"') = 0
           )
         ) THEN created_at END) AS last_owner,
         MAX(CASE WHEN type = 'assistant' THEN created_at END) AS last_assistant
       FROM cowork_messages WHERE session_id = ?`,
      [sessionId],
    );
    return {
      lastOwnerMessageAtMs: row?.last_owner != null ? Number(row.last_owner) : null,
      lastAssistantMessageAtMs: row?.last_assistant != null ? Number(row.last_assistant) : null,
    };
  }

  /** The bot a session belongs to (null = none/unknown) — the heartbeat scopes twin-activity suppression to the twin's own sessions. */
  getSessionMetabotId(sessionId: string): number | null {
    const row = this.getOne<{ metabot_id: number | null }>('SELECT metabot_id FROM cowork_sessions WHERE id = ?', [sessionId]);
    return row?.metabot_id != null ? Number(row.metabot_id) : null;
  }

  /**
   * Record that a turn settled WITHOUT answering (provider error, stall abort,
   * empty terminal, truncated) — the long-term-task heartbeat's
   * unanswered-owner-reply self-heal keys off this marker: an owner message
   * whose answering turn died must not read as owner engagement that resets
   * the reminder clock (2026-11-03 session 68650d7b: the owner's reply died
   * with STREAM_CLOSED and the task sat silent for the full 12h re-present
   * window because the dead message anchored the quiet clock).
   */
  recordSessionTurnFailure(sessionId: string, atMs: number): void {
    // No saveDb(): per-turn hot writes follow the addMessage pattern — the
    // native backend persists via WAL and the wasm backend's full-file export
    // is far too expensive per turn (the debounced saves cover it).
    this.db.run('UPDATE cowork_sessions SET last_turn_failed_at_ms = ? WHERE id = ?', [atMs, sessionId]);
  }

  /** Record a turn settlement that DID answer (see recordSessionTurnFailure). */
  recordSessionTurnCompletion(sessionId: string, atMs: number): void {
    this.db.run('UPDATE cowork_sessions SET last_turn_completed_at_ms = ? WHERE id = ?', [atMs, sessionId]);
  }

  /** Turn-outcome markers for one session (null = never recorded). */
  getSessionTurnOutcome(sessionId: string): { lastFailedAtMs: number | null; lastCompletedAtMs: number | null } {
    const row = this.getOne<{ last_failed: number | null; last_completed: number | null }>(
      'SELECT last_turn_failed_at_ms AS last_failed, last_turn_completed_at_ms AS last_completed FROM cowork_sessions WHERE id = ?',
      [sessionId],
    );
    return {
      lastFailedAtMs: row?.last_failed != null ? Number(row.last_failed) : null,
      lastCompletedAtMs: row?.last_completed != null ? Number(row.last_completed) : null,
    };
  }

  /**
   * Archived conversations for the Settings "Archived Chats" panel: sessions
   * put away by the user (records preserved), newest archive first. Separate
   * from listSessions, which deliberately excludes archived rows.
   */
  private mapArchivedSessionRow(row: {
    id: string;
    title: string;
    status: string;
    pinned: number | null;
    metabot_id?: number | null;
    session_type?: string | null;
    peer_name?: string | null;
    browser_uri?: string | null;
    browser_title?: string | null;
    assistant_mode?: number | null;
    hidden_from_session_list?: number | null;
    auto_origin?: string | null;
    fold_override?: string | null;
    follow_up_state?: string | null;
    follow_up_source?: string | null;
    follow_up_at?: string | null;
    model?: string | null;
    model_provider?: string | null;
    effort?: string | null;
    project_id?: string | null;
    archived_at: number;
    created_at: number;
    updated_at: number;
  }): CoworkSessionSummary {
    return {
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metabotId: parseIdNumber(row.metabot_id),
      archivedAt: Number(row.archived_at),
      sessionType: (row.session_type === 'agent_agent' ? 'a2a' : row.session_type as CoworkSessionType) || 'standard',
      peerName: row.peer_name ?? null,
      browserUri: row.browser_uri ?? null,
      browserTitle: row.browser_title ?? null,
      assistantMode: Boolean(row.assistant_mode),
      hiddenFromSessionList: Boolean(row.hidden_from_session_list),
      autoOrigin: (row.auto_origin as CoworkSessionAutoOrigin | null) ?? null,
      foldOverride: (row.fold_override as CoworkSessionFoldOverride | null) ?? null,
      followUpState: (row.follow_up_state as 'pending' | null) ?? null,
      followUpSource: (row.follow_up_source as CoworkSessionFollowUpSource | null) ?? null,
      followUpAt: row.follow_up_at ?? null,
      model: row.model ?? null,
      modelProvider: row.model_provider ?? null,
      effort: row.effort ?? null,
      projectId: row.project_id ?? null,
    };
  }

  listArchivedSessions(options?: {
    metabotId?: number | null;
    query?: string;
    searchContent?: boolean;
    sessionType?: CoworkSessionType;
    limit?: number;
    offset?: number;
  }): CoworkSessionSummary[] {
    const { clauses, params } = this.buildArchivedSessionFilter(options);
    const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));

    const rows = this.getAll<Parameters<CoworkStore['mapArchivedSessionRow']>[0]>(`
      SELECT
        s.id, s.title, s.status, s.pinned, s.metabot_id, s.session_type, s.peer_name,
        s.browser_uri, s.browser_title, s.hidden_from_session_list, s.auto_origin, s.fold_override, s.follow_up_state, s.follow_up_source, s.follow_up_at, s.model, s.model_provider, s.effort, s.project_id, s.assistant_mode,
        s.archived_at, s.created_at, s.updated_at
      FROM cowork_sessions s
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.archived_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return rows.map((row) => this.mapArchivedSessionRow(row));
  }

  async listArchivedSessionsPageAsync(
    options?: {
      metabotId?: number | null;
      query?: string;
      searchContent?: boolean;
      sessionType?: CoworkSessionType;
      limit?: number;
      offset?: number;
    },
    readWorker?: SqliteReadWorkerLike | null,
  ): Promise<{ sessions: CoworkSessionSummary[]; total: number }> {
    if (!readWorker) {
      return {
        sessions: this.listArchivedSessions(options),
        total: this.countArchivedSessions(options),
      };
    }
    try {
      const { clauses, params } = this.buildArchivedSessionFilter(options);
      const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 50)));
      const offset = Math.max(0, Math.floor(options?.offset ?? 0));
      const whereSql = clauses.join(' AND ');
      const [listRows, countRows] = await readWorker.batchQueryAll([
        {
          sql: `
            SELECT
              s.id, s.title, s.status, s.pinned, s.metabot_id, s.session_type, s.peer_name,
              s.browser_uri, s.browser_title, s.hidden_from_session_list, s.auto_origin, s.fold_override, s.follow_up_state, s.follow_up_source, s.follow_up_at, s.model, s.model_provider, s.effort, s.project_id, s.assistant_mode,
              s.archived_at, s.created_at, s.updated_at
            FROM cowork_sessions s
            WHERE ${whereSql}
            ORDER BY s.archived_at DESC
            LIMIT ? OFFSET ?
          `,
          params: [...params, limit, offset],
        },
        {
          sql: `
            SELECT COUNT(*) AS count
            FROM cowork_sessions s
            WHERE ${whereSql}
          `,
          params,
        },
      ]);
      const sessions = (listRows as Array<Parameters<CoworkStore['mapArchivedSessionRow']>[0]>).map((row) =>
        this.mapArchivedSessionRow(row),
      );
      const total = Number((countRows[0] as { count?: unknown } | undefined)?.count ?? 0);
      return { sessions, total };
    } catch {
      return {
        sessions: this.listArchivedSessions(options),
        total: this.countArchivedSessions(options),
      };
    }
  }

  resetRunningSessions(): number {
    const now = Date.now();
    this.db.run(`
      UPDATE cowork_sessions
      SET status = 'idle', updated_at = ?
      WHERE status = 'running'
    `, [now]);

    const changes = this.db.getRowsModified?.();
    const modified = typeof changes === 'number' ? changes : 0;
    if (modified > 0) {
      this.saveDb();
    }

    return modified;
  }

  /**
   * Boot-time heal for DSH streaming placeholders abandoned by a hard quit
   * (electron:dev SIGKILL, force-quit). resetRunningSessions only flips
   * status running→idle; it leaves assistant rows with isStreaming=true,
   * so the Think row keeps pulsing with no error (2026-09-14 50780b67).
   * Finalize those rows and, when the leftover is empty thinking, insert a
   * localized idle diagnostic.
   */
  healAbandonedStreamingMessages(): number {
    if (!this.tableExists('cowork_messages')) {
      return 0;
    }

    this.ensureCoworkMessageHealIndexes();
    const rows = this.getAll<{
      id: string;
      session_id: string;
      type: string;
      content: string;
      metadata: string | null;
    }>(`
      SELECT id, session_id, type, content, metadata
      FROM cowork_messages
      WHERE metadata IS NOT NULL
        AND metadata LIKE '%"isStreaming":true%'
        ${this.coworkMessageHealColumnsReady ? 'AND is_streaming = 1' : ''}
    `);
    if (rows.length === 0) {
      return 0;
    }

    const sessionsNeedingDiagnostic = new Set<string>();
    let changed = 0;
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const row of rows) {
        let metadata: CoworkMessageMetadata;
        try {
          const parsed = JSON.parse(row.metadata ?? '') as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          metadata = parsed as CoworkMessageMetadata;
        } catch {
          continue;
        }
        if (metadata.isStreaming !== true) continue;

        const nextMetadata: CoworkMessageMetadata = {
          ...metadata,
          isStreaming: false,
          isFinal: true,
        };
        this.db.run(
          'UPDATE cowork_messages SET metadata = ? WHERE id = ? AND session_id = ?',
          [JSON.stringify(nextMetadata), row.id, row.session_id],
        );
        changed += this.db.getRowsModified?.() || 0;

        const empty = !String(row.content ?? '').trim();
        if (row.type === 'assistant' && metadata.isThinking === true && empty) {
          sessionsNeedingDiagnostic.add(row.session_id);
        }
      }
      this.db.run('COMMIT');
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Preserve the transaction failure as the authoritative startup error.
      }
      throw error;
    }

    for (const sessionId of sessionsNeedingDiagnostic) {
      const latest = this.getSessionLatestMessage(sessionId);
      if (latest?.metadata?.dshTurnInterrupted === true) continue;
      this.addMessage(sessionId, {
        type: 'system',
        content: '',
        metadata: { dshTurnInterrupted: true },
      });
      changed += 1;
    }

    if (changed > 0) {
      this.saveDb();
    }
    return changed;
  }

  /**
   * Boot-time heal for shutdown-aborted A2A sessions (the 2026-09-12 mass
   * 'error' incident): when the app quit closes the DSH runtime, in-flight
   * A2A turns crashed with `DshKernel: closed` and CoworkRunner.handleError
   * parked the conversation on 'error' with a persisted system marker. That
   * was never a conversation failure — restore the healthy resting status
   * 'completed' so the session list drops the error banner. Deliberately
   * narrow: only a2a/agent_agent sessions still on 'error' whose LATEST
   * transcript message is exactly that shutdown marker are touched; any
   * later activity means the live heal (healStaleA2AErrorStatus) owns the
   * session. The system message stays in the transcript as history.
   */
  healDshShutdownA2AErrorSessions(): number {
    if (!this.tableExists('cowork_sessions') || !this.tableExists('cowork_messages')) {
      return 0;
    }
    const candidates = this.getAll<{ id: string }>(`
      SELECT id FROM cowork_sessions
      WHERE status = 'error' AND session_type IN ('a2a', 'agent_agent')
    `);
    let healed = 0;
    for (const candidate of candidates) {
      const latest = this.getSessionMessagesPage(candidate.id, { limit: 1 });
      const last = latest?.messages?.[latest.messages.length - 1];
      if (last?.type !== 'system') continue;
      if (!/^Error: (DshKernel: closed|DshTurnHub: shutting down)/.test(last.content ?? '')) continue;
      this.updateSession(candidate.id, { status: 'completed' });
      healed += 1;
    }
    return healed;
  }

  markInterruptedSteersAfterRestart(now: number = Date.now()): number {
    if (!this.tableExists('cowork_messages')) {
      return 0;
    }

    this.ensureCoworkMessageHealIndexes();
    let changed = 0;
    this.db.run('BEGIN TRANSACTION');
    try {
      const result = this.db.exec(`
        SELECT id, session_id, metadata
        FROM cowork_messages
        WHERE type = 'user'
          AND metadata IS NOT NULL
          AND metadata LIKE ?
          AND (metadata LIKE ? OR metadata LIKE ?)
          ${this.coworkMessageHealColumnsReady ? 'AND steer_pending = 1' : ''}
      `, [
        '%"interactionKind":"steer"%',
        '%"steerStatus":"queued"%',
        '%"steerStatus":"delivered"%',
      ]);
      const rows = result[0]?.values ?? [];

      for (const row of rows) {
        const messageId = String(row[0]);
        const sessionId = String(row[1]);
        const rawMetadata = String(row[2]);
        let metadata: CoworkMessageMetadata;
        try {
          const parsed = JSON.parse(rawMetadata) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
          }
          metadata = parsed as CoworkMessageMetadata;
        } catch {
          continue;
        }

        if (metadata.interactionKind !== 'steer') continue;
        if (metadata.steerStatus !== 'queued' && metadata.steerStatus !== 'delivered') continue;

        const recoveredMetadata: CoworkMessageMetadata = {
          ...metadata,
          submissionMode: 'steer',
          submissionResult: 'failed',
          steerStatus: 'failed',
          steerFailedAt: now,
          steerErrorCode: 'app_restarted',
        };
        this.db.run(`
          UPDATE cowork_messages
          SET metadata = ?
          WHERE id = ? AND session_id = ?
        `, [JSON.stringify(recoveredMetadata), messageId, sessionId]);
        changed += this.db.getRowsModified?.() || 0;
      }

      this.db.run('COMMIT');
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Preserve the transaction failure as the authoritative startup error.
      }
      throw error;
    }

    if (changed > 0) {
      this.saveDb();
    }
    return changed;
  }

  listRecentCwds(limit: number = 8): string[] {
    interface CwdRow {
      cwd: string;
      updated_at: number;
    }

    const rows = this.getAll<CwdRow>(`
      SELECT cwd, updated_at
      FROM cowork_sessions
      WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
      ORDER BY updated_at DESC
      LIMIT ?
    `, [Math.max(limit * 8, limit)]);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeRecentWorkspacePath(row.cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      deduped.push(normalized);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped;
  }

  /**
   * The full transcript, oldest first, in the canonical order every transcript
   * consumer shares: (created_at, sequence, ROWID). Spelled without the
   * COALESCE(sequence, 0) it used to carry — that expression forced SQLite to
   * sort every row of the session (a real chat session reaches five figures),
   * while idx_cowork_messages_session_created_sequence carries exactly this key
   * and serves the read as a plain index scan.
   *
   * The two spellings are interchangeable: sequence is never 0 or negative
   * (every insert path assigns MAX(sequence) + 1), so COALESCE(sequence, 0)
   * only ever rewrites NULL — and a NULL sorts first in ASC either way. NULL
   * sequence rows can only come from a database predating the column.
   */
  private getSessionMessages(sessionId: string): CoworkMessage[] {
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY
        created_at ASC,
        sequence ASC,
        ROWID ASC
    `, [sessionId]);

    return rows.map(row => ({
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      ...(row.sequence != null && row.sequence > 0 ? { sequence: row.sequence } : {}),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  getSessionOrderHeaderMessages(sessionId: string): CoworkMessage[] {
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
        AND content IS NOT NULL
        AND UPPER(SUBSTR(LTRIM(content), 1, 7)) = '[ORDER]'
      ORDER BY
        created_at ASC,
        sequence ASC,
        ROWID ASC
    `, [sessionId]);

    return rows.map((row) => this.mapCoworkMessageRow(row));
  }

  getSessionOrderLinkageMessages(sessionId: string): CoworkMessage[] {
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
        AND (
          (metadata IS NOT NULL AND (instr(metadata, 'serviceOrderPinId') > 0 OR instr(metadata, 'orderPinId') > 0))
          OR (content IS NOT NULL AND (instr(LOWER(content), 'txid') > 0 OR instr(LOWER(content), 'order') > 0))
        )
      ORDER BY
        created_at ASC,
        sequence ASC,
        ROWID ASC
    `, [sessionId]);

    return rows.map((row) => this.mapCoworkMessageRow(row));
  }

  getRecentPrivateA2AMessages(sessionId: string, requestedLimit: number = 100): CoworkMessage[] {
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
      : 100;
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages INDEXED BY idx_cowork_messages_session_sequence
      WHERE session_id = ?
        AND type IN ('user', 'assistant')
        AND metadata LIKE '%"sourceChannel":"metaweb_private"%'
        AND metadata NOT LIKE '%"orderExecutionTrace":true%'
      ORDER BY
        COALESCE(sequence, 0) DESC,
        created_at DESC,
        ROWID DESC
      LIMIT ?
    `, [sessionId, limit]);

    return rows.reverse().map(row => ({
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  getSessionMessagesMatchingMetadataValues(
    sessionId: string,
    values: string[],
    requestedLimit: number = 100,
  ): CoworkMessage[] {
    const normalizedValues = Array.from(new Set(
      values.map(value => String(value || '').trim()).filter(Boolean),
    )).slice(0, 20);
    if (normalizedValues.length === 0) return [];

    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
      : 100;
    const metadataClauses = normalizedValues.map(() => 'metadata LIKE ?').join(' OR ');
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages INDEXED BY idx_cowork_messages_session_sequence
      WHERE session_id = ?
        AND metadata IS NOT NULL
        AND (${metadataClauses})
      ORDER BY
        COALESCE(sequence, 0) DESC,
        created_at DESC,
        ROWID DESC
      LIMIT ?
    `, [sessionId, ...normalizedValues.map(value => `%${value}%`), limit]);

    return rows.map(row => ({
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  hasPriorPrivateA2AOutboundMessage(sessionId: string): boolean {
    const row = this.getOne<{ found: number }>(`
      SELECT 1 AS found
      FROM cowork_messages
      WHERE session_id = ?
        AND type = 'assistant'
        AND metadata LIKE '%"sourceChannel":"metaweb_private"%'
        AND metadata NOT LIKE '%"orderExecutionTrace":true%'
        AND TRIM(content) <> ''
        AND LOWER(TRIM(content)) NOT IN ('ping', 'pong')
      LIMIT 1
    `, [sessionId]);
    return Boolean(row?.found);
  }

  getSessionMessageCount(sessionId: string): number {
    const row = this.getOne<{ count: number | string }>(`
      SELECT COUNT(*) AS count
      FROM cowork_messages
      WHERE session_id = ?
    `, [sessionId]);
    return parseIdNumber(row?.count) ?? 0;
  }

  /** Keep live delivery/refund work, plus fresh rating handoffs, on the current episode. */
  hasBlockingServiceOrdersForSession(sessionId: string, now: number = Date.now()): boolean {
    if (!this.tableExists('service_orders')) return false;
    const row = this.getOne<{ found: number }>(`
      SELECT 1 AS found
      FROM service_orders
      WHERE cowork_session_id = ?
        AND (
          status IN ('awaiting_first_response', 'in_progress', 'refund_pending')
          OR (status = 'rating_pending' AND updated_at >= ?)
        )
      LIMIT 1
    `, [sessionId, now - SERVICE_ORDER_RATING_SESSION_HOLD_MS]);
    return Boolean(row?.found);
  }

  /**
   * One page of a session's transcript, newest page first.
   *
   * `displayWindow` pages an A2A session through its display projection (hidden
   * internals skipped) and answers with a sequence cursor — the shape A2A has
   * always used. Everything else pages in transcript order and answers with the
   * opaque `beforeTranscriptCursor` the previous page handed over. Each kind of
   * view therefore has exactly one cursor, and a caller always passes back the
   * one it was given: the page order can never quietly differ from the window's.
   */
  getSessionMessagesPage(
    sessionId: string,
    options?: {
      beforeSequence?: number | null;
      beforeTranscriptCursor?: string | null;
      limit?: number;
      displayWindow?: boolean;
    },
  ): CoworkMessagePage {
    const { limit, beforeSequence } = normalizeCoworkMessagePageRequest(options);
    if (options?.displayWindow === true) {
      return this.getA2ADisplayMessagesPage(sessionId, { beforeSequence, limit });
    }
    return this.getTranscriptSessionMessagesPage(sessionId, {
      cursor: parseCoworkTranscriptCursor(options?.beforeTranscriptCursor),
      limit,
    });
  }

  private mapCoworkMessageRow(row: CoworkMessageRow): CoworkMessage {
    return {
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      ...(row.sequence != null && row.sequence > 0 ? { sequence: row.sequence } : {}),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Newest-first page in transcript order — the order getSessionMessages reads
   * the whole session in, so the window and the full read agree wherever a
   * session's timestamps and its sequences disagree (a migrated copy appends
   * old turns with fresh sequences).
   *
   * idx_cowork_messages_session_created_sequence carries the key, so this is a
   * backward index scan; the cursor predicate costs nothing extra because the
   * scan is already in that order and stops after limit + 1 matches. The index
   * is not forced: without it SQLite sorts instead, which is the pre-existing
   * shape rather than an error.
   */
  private queryTranscriptMessageRows(
    sessionId: string,
    options: { cursor: CoworkTranscriptCursor | null; limit: number },
  ): { rows: CoworkMessageRow[]; hasMoreBefore: boolean } {
    const params: Array<string | number> = [sessionId];
    let beforeClause = '';
    if (options.cursor) {
      // Strictly below the cursor row, in (created_at, sequence, ROWID) order.
      // COALESCE on the cursor side only: it is the same mapping the ASC
      // transcript read applies to a NULL sequence, which cannot occur for rows
      // written by this store.
      beforeClause = `
        AND (
          created_at < ?
          OR (created_at = ? AND COALESCE(sequence, 0) < ?)
          OR (created_at = ? AND COALESCE(sequence, 0) = ? AND ROWID < ?)
        )`;
      params.push(
        options.cursor.createdAt,
        options.cursor.createdAt,
        options.cursor.sequence,
        options.cursor.createdAt,
        options.cursor.sequence,
        options.cursor.rowId,
      );
    }
    params.push(options.limit + 1);

    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence, ROWID AS rowid
      FROM cowork_messages
      WHERE session_id = ?
      ${beforeClause}
      ORDER BY
        created_at DESC,
        sequence DESC,
        ROWID DESC
      LIMIT ?
    `, params);
    return {
      rows,
      hasMoreBefore: rows.length > options.limit,
    };
  }

  private getTranscriptSessionMessagesPage(
    sessionId: string,
    options: { cursor: CoworkTranscriptCursor | null; limit: number },
  ): CoworkMessagePage {
    const { rows, hasMoreBefore } = this.queryTranscriptMessageRows(sessionId, options);
    const page = rows.slice(0, options.limit);
    const oldest = page.length > 0 ? page[page.length - 1] : null;
    return {
      // Rows arrive newest-first and are handed over oldest-first.
      messages: page.slice().reverse().map((row) => this.mapCoworkMessageRow(row)),
      hasMoreBefore,
      beforeSequence: null,
      beforeTranscriptCursor: hasMoreBefore && oldest ? formatCoworkTranscriptCursor(oldest) : null,
    };
  }

  /**
   * Newest-first SQL page. `hasMoreBefore` means older rows exist beyond this chunk.
   *
   * Ordering is the sequence-led newest-first order, spelled without the
   * COALESCE(sequence, 0) it used to carry: that expression made every page a
   * temp B-tree sort of the whole session, while
   * idx_cowork_messages_session_sequence_created carries exactly this key
   * (sequence, then created_at, then the implicit rowid) and serves it as a
   * backward index scan. NULL sequences — rows written before the column
   * existed, and only those: every insert path assigns MAX(sequence) + 1 —
   * still sort last, which is what COALESCE(sequence, 0) achieved by mapping
   * them onto key 0. The index is not forced: without it the planner falls back
   * to the sort, which is the old shape rather than an error.
   */
  private querySessionMessageRows(
    sessionId: string,
    options: { beforeSequence: number | null; limit: number },
  ): { rows: CoworkMessageRow[]; hasMoreBefore: boolean } {
    const params: Array<string | number> = [sessionId];
    const beforeClause = options.beforeSequence == null
      ? ''
      : 'AND COALESCE(sequence, 0) < ?';
    if (options.beforeSequence != null) {
      params.push(options.beforeSequence);
    }
    params.push(options.limit + 1);

    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ${beforeClause}
      ORDER BY
        sequence DESC,
        created_at DESC,
        ROWID DESC
      LIMIT ?
    `, params);
    const hasMoreBefore = rows.length > options.limit;
    return {
      rows: rows.slice(0, options.limit),
      hasMoreBefore,
    };
  }

  /**
   * Whether this session carries metaweb_private chain traffic. Only those
   * bot↔bot conversations patch a txid into every delivered reply, so only
   * there does "assistant message without a txid" mean "internal monologue".
   */
  private getA2AHideContext(sessionId: string): A2AHideContext {
    const row = this.getOne<{ found: number }>(`
      SELECT 1 AS found FROM cowork_messages
      WHERE session_id = ? AND metadata LIKE '%"sourceChannel":"metaweb_private"%'
      LIMIT 1
    `, [sessionId]);
    return { chainBackedConversation: row != null };
  }

  private getA2AThreadHideContext(threadId: string): A2AHideContext {
    const row = this.getOne<{ found: number }>(`
      SELECT 1 AS found
      FROM a2a_conversation_episodes episode
      JOIN cowork_messages message ON message.session_id = episode.session_id
      WHERE episode.thread_id = ?
        AND message.metadata LIKE '%"sourceChannel":"metaweb_private"%'
      LIMIT 1
    `, [threadId]);
    return { chainBackedConversation: row != null };
  }

  /**
   * A2A UI window: walk newest→oldest skipping hidden internals so a flood of
   * system errors cannot empty the conversation. Keeps trailing live work
   * (tools/thinking) and at most one latest system error for banners.
   */
  private getA2ADisplayMessagesPage(
    sessionId: string,
    options: { beforeSequence: number | null; limit: number },
  ): CoworkMessagePage {
    const hideContext = this.getA2AHideContext(sessionId);
    const chunkSize = 100;
    const maxChunks = 40;
    const selected: Array<{ message: CoworkMessage; sequence: number }> = [];
    let visibleCount = 0;
    let latestErrorKept = false;
    let cursor = options.beforeSequence;
    let inTrailingHidden = true;

    for (let chunkIndex = 0; chunkIndex < maxChunks && visibleCount < options.limit; chunkIndex += 1) {
      const { rows, hasMoreBefore } = this.querySessionMessageRows(sessionId, {
        beforeSequence: cursor,
        limit: chunkSize,
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        const message = this.mapCoworkMessageRow(row);
        const sequence = Number(row.sequence);
        const normalizedSequence = Number.isFinite(sequence) && sequence > 0 ? sequence : 0;
        if (!shouldHideA2AInternalMessage(message, hideContext)) {
          selected.push({ message, sequence: normalizedSequence });
          visibleCount += 1;
          inTrailingHidden = false;
        } else if (inTrailingHidden && isA2ALiveWorkMessage(message)) {
          selected.push({ message, sequence: normalizedSequence });
        } else if (
          inTrailingHidden
          && isA2ASystemErrorMessage(message)
          && !latestErrorKept
        ) {
          selected.push({ message, sequence: normalizedSequence });
          latestErrorKept = true;
        }
        if (visibleCount >= options.limit) break;
      }

      if (!hasMoreBefore) {
        cursor = null;
        break;
      }
      const oldestSequence = Number(rows[rows.length - 1]?.sequence);
      cursor = Number.isFinite(oldestSequence) && oldestSequence > 0 ? oldestSequence : null;
      if (cursor == null) break;
    }

    selected.reverse();
    const oldestKeptSequence = selected.length > 0 ? selected[0].sequence : null;
    const hasMoreBefore = this.hasOlderA2ADisplayMessage(sessionId, oldestKeptSequence);

    return {
      messages: selected.map((item) => item.message),
      hasMoreBefore,
      beforeSequence: hasMoreBefore && oldestKeptSequence != null && oldestKeptSequence > 0
        ? oldestKeptSequence
        : null,
    };
  }

  private hasOlderA2ADisplayMessage(sessionId: string, beforeSequence: number | null): boolean {
    if (beforeSequence == null || beforeSequence <= 0) return false;
    const hideContext = this.getA2AHideContext(sessionId);
    let cursor: number | null = beforeSequence;
    const chunkSize = 100;
    for (let chunkIndex = 0; chunkIndex < 40 && cursor != null; chunkIndex += 1) {
      const { rows, hasMoreBefore } = this.querySessionMessageRows(sessionId, {
        beforeSequence: cursor,
        limit: chunkSize,
      });
      if (rows.some((row) => !shouldHideA2AInternalMessage(this.mapCoworkMessageRow(row), hideContext))) {
        return true;
      }
      if (!hasMoreBefore || rows.length === 0) return false;
      const oldestSequence = Number(rows[rows.length - 1]?.sequence);
      if (!Number.isFinite(oldestSequence) || oldestSequence <= 0 || oldestSequence >= cursor) {
        return false;
      }
      cursor = oldestSequence;
    }
    return false;
  }

  getA2AConversationHistoryPage(
    sessionId: string,
    options?: { beforeCursor?: CoworkA2AHistoryCursor | null; limit?: number },
  ): CoworkA2AHistoryPage | null {
    const anchor = this.getOne<CoworkA2AEpisodeRow>(`
      SELECT * FROM a2a_conversation_episodes WHERE session_id = ? LIMIT 1
    `, [sessionId]);
    if (!anchor) return null;
    const thread = this.getOne<CoworkA2AThreadRow>(`
      SELECT * FROM a2a_conversation_threads WHERE id = ? LIMIT 1
    `, [anchor.thread_id]);
    if (!thread) return null;

    const requestedLimit = Number(options?.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, Math.floor(requestedLimit)))
      : 100;
    const cursorEpisodeIndex = parseIdNumber(options?.beforeCursor?.episodeIndex);
    const cursorBeforeSequence = parseIdNumber(options?.beforeCursor?.beforeSequence);
    const anchorEpisodeIndex = parseIdNumber(anchor.episode_index) ?? 1;
    const anchorThreadId = anchor.thread_id;

    // Release-audit follow-up 2026-09-19: hidden internal messages (tool_use,
    // tool_result, thinking, sentinels) must not consume the VISIBLE page
    // budget — a skill-heavy old episode returned pages that rendered as
    // nothing while hasMoreBefore burned down, so "load earlier" looked
    // broken. Walk raw chunks newest→oldest, keep only displayable rows
    // (same filter as the in-session pager), and stop at limit+1 visible.
    const rawChunkSize = Math.max(limit * 3, 60);
    const maxChunks = 20;
    // One thread spans several episode sessions of the same conversation pair,
    // so the chain-backed flag is resolved once across all of them.
    const hideContext = this.getA2AThreadHideContext(anchorThreadId);
    const fetchRawRows = (
      chunkEpisodeIndex: number | null,
      chunkBeforeSequence: number | null,
      rawLimit: number,
      firstPageAnchorMode: boolean,
    ): CoworkA2AHistoryRow[] => {
      const params: Array<string | number> = [anchorThreadId];
      let cursorClause: string;
      if (chunkEpisodeIndex != null && chunkBeforeSequence != null) {
        cursorClause = `
          AND (
            episode.episode_index < ?
            OR (episode.episode_index = ? AND COALESCE(message.sequence, 0) < ?)
          )
        `;
        params.push(chunkEpisodeIndex, chunkEpisodeIndex, chunkBeforeSequence);
      } else if (firstPageAnchorMode) {
        // First cross-episode page: a cursor object with null fields means
        // "strictly below the anchor episode" — the current session's own
        // window has been exhausted and the view wants earlier episodes only.
        cursorClause = 'AND episode.episode_index < ?';
        params.push(anchorEpisodeIndex);
      } else {
        cursorClause = 'AND episode.episode_index <= ?';
        params.push(anchorEpisodeIndex);
      }
      params.push(rawLimit);
      return this.getAll<CoworkA2AHistoryRow>(`
        SELECT
          message.id,
          message.session_id,
          message.type,
          message.content,
          message.metadata,
          message.created_at,
          message.sequence,
          episode.episode_index
        FROM a2a_conversation_episodes episode
        JOIN cowork_messages message ON message.session_id = episode.session_id
        WHERE episode.thread_id = ?
          ${cursorClause}
        ORDER BY
          episode.episode_index DESC,
          COALESCE(message.sequence, 0) DESC,
          message.created_at DESC,
          message.ROWID DESC
        LIMIT ?
      `, params);
    };

    const visible: Array<{ row: CoworkA2AHistoryRow; episodeIndex: number }> = [];
    let firstPageAnchorMode = Boolean(options?.beforeCursor)
      && !(cursorEpisodeIndex != null && cursorBeforeSequence != null);
    let chunkEpisodeIndex: number | null = cursorEpisodeIndex;
    let chunkBeforeSequence: number | null = cursorBeforeSequence;
    let rawExhausted = false;
    for (let chunkIndex = 0; chunkIndex < maxChunks && visible.length <= limit; chunkIndex += 1) {
      const rows = fetchRawRows(chunkEpisodeIndex, chunkBeforeSequence, rawChunkSize + 1, firstPageAnchorMode);
      if (rows.length === 0) {
        rawExhausted = true;
        break;
      }
      rawExhausted = rows.length <= rawChunkSize;
      const rowsPage = rows.slice(0, rawChunkSize);
      for (const row of rowsPage) {
        const message: CoworkMessage = {
          id: row.id,
          type: row.type as CoworkMessageType,
          content: row.content,
          timestamp: row.created_at,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        };
        if (shouldHideA2AInternalMessage(message, hideContext)) continue;
        visible.push({ row, episodeIndex: parseIdNumber(row.episode_index) ?? 1 });
      }
      if (rawExhausted) break;
      const oldestRaw = rowsPage[rowsPage.length - 1];
      chunkEpisodeIndex = parseIdNumber(oldestRaw.episode_index) ?? 1;
      chunkBeforeSequence = parseIdNumber(oldestRaw.sequence) ?? 1;
      firstPageAnchorMode = false;
    }
    const hasMoreBefore = visible.length > limit || (!rawExhausted && visible.length === limit && visible.length > 0);
    const pageEntries = visible.slice(0, limit);
    const oldestEntry = pageEntries[pageEntries.length - 1];

    return {
      threadId: thread.id,
      participantPairKey: thread.participant_pair_key,
      messages: pageEntries.slice().reverse().map((entry) => ({
        sessionId: entry.row.session_id,
        episodeIndex: entry.episodeIndex,
        message: {
          id: entry.row.id,
          type: entry.row.type as CoworkMessageType,
          content: entry.row.content,
          timestamp: entry.row.created_at,
          metadata: entry.row.metadata ? JSON.parse(entry.row.metadata) : undefined,
        },
      })),
      hasMoreBefore,
      beforeCursor: hasMoreBefore && oldestEntry
        ? {
            episodeIndex: oldestEntry.episodeIndex,
            beforeSequence: parseIdNumber(oldestEntry.row.sequence) ?? 1,
          }
        : null,
    };
  }

  getSessionLatestMessage(sessionId: string): CoworkMessage | null {
    const row = this.getOne<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY
        created_at DESC,
        COALESCE(sequence, 0) DESC,
        ROWID DESC
      LIMIT 1
    `, [sessionId]);

    if (!row) return null;

    return {
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Latest EXTERNALLY VISIBLE message: skips thinking drafts
   * (metadata.isThinking=true) and unfinished streaming placeholders
   * (metadata.isStreaming=true) so session-history consumers (readLatest /
   * idbots_session_read_latest) never see a chain-of-thought draft or a
   * half-streamed message masquerading as the formal reply (GT#12 N3).
   * Same lightweight single-row query shape as getSessionLatestMessage.
   */
  getSessionLatestVisibleMessage(sessionId: string): CoworkMessage | null {
    const row = this.getOne<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
        AND (metadata IS NULL OR metadata NOT LIKE '%"isThinking":true%')
        AND (metadata IS NULL OR metadata NOT LIKE '%"isStreaming":true%')
      ORDER BY
        created_at DESC,
        COALESCE(sequence, 0) DESC,
        ROWID DESC
      LIMIT 1
    `, [sessionId]);

    if (!row) return null;

    return {
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private shouldApplyExplicitMemoryFromUserText(text: string, guardLevel: CoworkMemoryGuardLevel): boolean {
    const trimmed = text?.trim();
    if (!trimmed) return false;
    const changes = extractTurnMemoryChanges({
      userText: trimmed,
      assistantText: '',
      guardLevel,
      maxImplicitAdds: 0,
    });
    return changes.some((change) => change.isExplicit);
  }

  private enqueueExplicitMemoryUpdate(sessionId: string, message: CoworkMessage): void {
    if (message.type !== 'user') return;
    if (!message.content?.trim()) return;

    const policy = this.getEffectiveMemoryPolicyForSession(sessionId);
    if (!this.shouldApplyExplicitMemoryFromUserText(message.content, policy.memoryGuardLevel)) {
      return;
    }

    void this.applyTurnMemoryUpdates({
      sessionId,
      userText: message.content,
      assistantText: '',
      implicitEnabled: false,
      memoryLlmJudgeEnabled: policy.memoryLlmJudgeEnabled,
      guardLevel: policy.memoryGuardLevel,
      userMessageId: message.id,
    }).catch((error) => {
      console.warn('[CoworkStore] Failed to apply explicit memory updates:', error);
    });
  }

  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage {
    return this.addMessageWithId(sessionId, uuidv4(), message);
  }

  /**
   * Insert a private-chat bubble at a historical chain time without touching
   * the session's list stamp. Sequence is spliced so the A2A display window
   * (ordered by sequence) keeps chronological order. Does not flush the
   * database; the caller saves once for a batch.
   */
  insertHistoricalCoworkMessage(
    sessionId: string,
    message: Omit<CoworkMessage, 'id' | 'timestamp' | 'sequence'> & { timestamp: number },
  ): CoworkMessage | null {
    const createdAt = Math.floor(Number(message.timestamp));
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
    if (!String(message.content ?? '').trim()) return null;

    const successor = this.getOne<{ sequence: number | string | null }>(`
      SELECT sequence
      FROM cowork_messages
      WHERE session_id = ? AND created_at > ?
      ORDER BY created_at ASC, sequence ASC, ROWID ASC
      LIMIT 1
    `, [sessionId, createdAt]);
    const successorSequence = parseIdNumber(successor?.sequence);
    let sequence: number;
    if (successorSequence != null && successorSequence > 0) {
      this.db.run(`
        UPDATE cowork_messages
        SET sequence = sequence + 1
        WHERE session_id = ? AND sequence >= ?
      `, [sessionId, successorSequence]);
      sequence = successorSequence;
    } else {
      const sequenceRow = this.db.exec(`
        SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
        FROM cowork_messages
        WHERE session_id = ?
      `, [sessionId]);
      sequence = sequenceRow[0]?.values[0]?.[0] as number || 1;
    }

    const id = uuidv4();
    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;
    this.db.run(`
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      sessionId,
      message.type,
      message.content,
      metadataJson,
      createdAt,
      sequence,
    ]);
    this.bumpSessionTradeBadge(sessionId, message.content);

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: createdAt,
      sequence,
      metadata: message.metadata,
    };
  }

  /**
   * S4 chat trade markers: upgrade the session's trade_badge from one
   * message's text. Upgrade-only by design — a session that carried a trade
   * keeps its marker even after later plain messages (trade history is a
   * fact); escrow outranks p2p (mergeTradeBadge). The scan short-circuits on
   * fence-less text, so plain messages pay one substring probe.
   *
   * Source-signing slice: the scan verifies host stamps against THIS session
   * id — a signed card copy relayed from another session's emit fails the
   * binding here, so the mislabel (a relay copy marking an orchestration
   * session) cannot reproduce.
   */
  private bumpSessionTradeBadge(sessionId: string, content: string): void {
    const kind = scanMessageTradeBadge(content, { sessionId });
    if (!kind) return;
    const current = this.getOne<{ trade_badge: string | null }>(
      'SELECT trade_badge FROM cowork_sessions WHERE id = ?',
      [sessionId],
    )?.trade_badge ?? null;
    const merged = mergeTradeBadge(current as 'p2p' | 'escrow' | null, kind);
    if (merged === current) return;
    this.db.run('UPDATE cowork_sessions SET trade_badge = ? WHERE id = ?', [merged, sessionId]);
  }

  /**
   * Bump a session's stored activity key for a message that may reorder the
   * session list (see coworkActivityMessageMatch). Monotonic: an insert whose
   * created_at is older than the stamp (a migrated/legacy copy) leaves it alone,
   * so the column always equals the newest activity message. Messages that do
   * not qualify — assistant stream chunks above all — never touch the row, which
   * is what keeps a running task from reshuffling the sidebar.
   */
  private touchSessionActivityAt(
    sessionId: string,
    createdAt: number,
    type: string,
    metadataJson: string | null,
  ): void {
    if (type !== 'user' && !metadataJson?.includes(COWORK_METAWEB_PRIVATE_METADATA_FRAGMENT)) {
      return;
    }
    this.db.run(`
      UPDATE cowork_sessions
      SET activity_at = ?
      WHERE id = ? AND ? > COALESCE(activity_at, 0)
    `, [createdAt, sessionId, createdAt]);
  }

  /**
   * Recompute one session's activity key from its remaining messages after a
   * history truncation (rewind). Writes NULL when no activity message is left,
   * which hands the row back to the list's fallback computation instead of
   * freezing a value that no longer describes the session.
   */
  private refreshSessionActivityAt(sessionId: string): void {
    this.db.run(`
      UPDATE cowork_sessions
      SET activity_at = ${coworkSessionActivityAtMessageSql('cowork_sessions')}
      WHERE id = ?
    `, [sessionId]);
  }

  /**
   * fix/group-task-duration: pin a session's updated_at back to a prior value
   * after a HOST-generated system notice (e.g. the stale-working wake).
   * addMessage refreshes updated_at, and the group-task daemon classifies
   * member liveness from that timestamp — a host notice must never read as
   * member activity (it would mask the unreachable stamp and flap the badge).
   */
  setSessionUpdatedAt(sessionId: string, updatedAtMs: number): void {
    this.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [updatedAtMs, sessionId]);
    this.saveDb();
  }

  addMessageWithId(
    sessionId: string,
    id: string,
    message: Omit<CoworkMessage, 'id' | 'timestamp'>
  ): CoworkMessage {
    const existing = this.getMessageById(sessionId, id);
    if (existing) return existing;

    const now = Date.now();

    const sequenceRow = this.db.exec(`
      SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
      FROM cowork_messages
      WHERE session_id = ?
    `, [sessionId]);
    const sequence = sequenceRow[0]?.values[0]?.[0] as number || 1;

    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;
    this.db.run(`
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      sessionId,
      message.type,
      message.content,
      metadataJson,
      now,
      sequence,
    ]);

    this.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);
    this.touchSessionActivityAt(sessionId, now, message.type, metadataJson);
    this.bumpSessionTradeBadge(sessionId, message.content);
    this.db.run(`
      UPDATE a2a_conversation_threads
      SET updated_at = ?
      WHERE id = (
        SELECT thread_id FROM a2a_conversation_episodes WHERE session_id = ? LIMIT 1
      )
    `, [now, sessionId]);

    this.saveDb();

    const createdMessage: CoworkMessage = {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      sequence,
      metadata: message.metadata,
    };
    this.enqueueExplicitMemoryUpdate(sessionId, createdMessage);
    return createdMessage;
  }

  getMessageById(sessionId: string, messageId: string): CoworkMessage | null {
    const result = this.db.exec(`
      SELECT id, type, content, metadata, created_at
      FROM cowork_messages
      WHERE session_id = ? AND id = ?
      LIMIT 1
    `, [sessionId, messageId]);
    const row = result[0]?.values[0];
    if (!row) return null;

    return {
      id: String(row[0]),
      type: String(row[1]) as CoworkMessage['type'],
      content: String(row[2] ?? ''),
      metadata: row[3]
        ? JSON.parse(String(row[3])) as CoworkMessageMetadata
        : undefined,
      timestamp: Number(row[4]),
    };
  }

  getMessageOwnerSessionId(messageId: string): string | null {
    const result = this.db.exec(`
      SELECT session_id
      FROM cowork_messages
      WHERE id = ?
      LIMIT 1
    `, [messageId]);
    const row = result[0]?.values[0];
    return row ? String(row[0]) : null;
  }

  updateMessage(sessionId: string, messageId: string, updates: { content?: string; metadata?: CoworkMessageMetadata }): void {
    const setClauses: string[] = [];
    const values: (string | null)[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    if (setClauses.length === 0) return;

    values.push(messageId);
    values.push(sessionId);
    this.db.run(`
      UPDATE cowork_messages
      SET ${setClauses.join(', ')}
      WHERE id = ? AND session_id = ?
    `, values);

    this.saveDb();
  }

  migrateMetawebOrderSessionsToPeerConversations(): number {
    if (this.getKvValue(METAWEB_ORDER_SESSION_MIGRATION_KEY) === '1') {
      return 0;
    }
    if (
      !this.tableExists('cowork_conversation_mappings')
      || !this.tableExists('cowork_sessions')
      || !this.tableExists('cowork_messages')
    ) {
      return 0;
    }

    interface OrderMappingRow {
      channel: string;
      external_conversation_id: string;
      metabot_id: number | string | null;
      cowork_session_id: string;
      metadata_json: string | null;
      title: string | null;
      cwd: string | null;
      system_prompt: string | null;
      execution_mode: string | null;
      session_type: string | null;
      peer_global_metaid: string | null;
      peer_name: string | null;
      peer_avatar: string | null;
      created_at: number | null;
      updated_at: number | null;
    }

    const hasPromptsTable = this.tableExists('cowork_session_prompts');
    const rows = this.getAll<OrderMappingRow>(`
      SELECT
        m.channel,
        m.external_conversation_id,
        m.metabot_id,
        m.cowork_session_id,
        m.metadata_json,
        s.title,
        s.cwd,
        ${hasPromptsTable ? "COALESCE(NULLIF(sp.system_prompt, ''), s.system_prompt, '')" : 's.system_prompt'} AS system_prompt,
        s.execution_mode,
        s.session_type,
        s.peer_global_metaid,
        s.peer_name,
        s.peer_avatar,
        s.created_at,
        s.updated_at
      FROM cowork_conversation_mappings m
      LEFT JOIN cowork_sessions s ON s.id = m.cowork_session_id
      ${hasPromptsTable ? 'LEFT JOIN cowork_session_prompts sp ON sp.session_id = s.id' : ''}
      WHERE m.channel = 'metaweb_order'
    `);

    let changed = 0;
    const createdCanonicalByKey = new Map<string, string>();
    for (const row of rows) {
      const metabotId = this.normalizeMappingMetabotId(parseIdNumber(row.metabot_id));
      const mappingMetadata = this.parseMessageMetadata(row.metadata_json);
      const peerGlobalMetaId = this.resolveMetawebOrderPeerGlobalMetaId(row, mappingMetadata);
      if (!peerGlobalMetaId) continue;

      const privateExternalConversationId = buildCanonicalPrivateConversationExternalConversationId(peerGlobalMetaId);
      const canonicalKey = `${metabotId}:${privateExternalConversationId}`;
      let canonicalSessionId = createdCanonicalByKey.get(canonicalKey) || '';
      if (!canonicalSessionId) {
        canonicalSessionId = this.ensureCanonicalPrivateSessionForOrderMigration({
          metabotId,
          peerGlobalMetaId,
          privateExternalConversationId,
          legacy: row,
          mappingMetadata,
        });
        createdCanonicalByKey.set(canonicalKey, canonicalSessionId);
      }
      if (!canonicalSessionId) continue;

      if (row.cowork_session_id !== canonicalSessionId) {
        const copied = this.copyMissingOrderMessagesToCanonicalSession({
          fromSessionId: row.cowork_session_id,
          toSessionId: canonicalSessionId,
          privateExternalConversationId,
          orderExternalConversationId: row.external_conversation_id,
          mappingMetadata,
        });
        changed += copied;

        this.db.run(`
          UPDATE cowork_conversation_mappings
          SET cowork_session_id = ?, last_active_at = ?
          WHERE channel = 'metaweb_order'
            AND external_conversation_id = ?
            AND metabot_id = ?
            AND cowork_session_id <> ?
        `, [canonicalSessionId, Date.now(), row.external_conversation_id, metabotId, canonicalSessionId]);
        if ((this.db.getRowsModified?.() || 0) > 0) changed += 1;

        if (this.tableExists('service_orders')) {
          this.db.run(`
            UPDATE service_orders
            SET cowork_session_id = ?, updated_at = ?
            WHERE cowork_session_id = ?
          `, [canonicalSessionId, Date.now(), row.cowork_session_id]);
          if ((this.db.getRowsModified?.() || 0) > 0) changed += 1;
        }

        this.db.run(`
          UPDATE cowork_sessions
          SET hidden_from_session_list = 1
          WHERE id = ?
            AND COALESCE(hidden_from_session_list, 0) = 0
        `, [row.cowork_session_id]);
        if ((this.db.getRowsModified?.() || 0) > 0) changed += 1;
      }
    }

    if (changed > 0) {
      this.setKvValue(METAWEB_ORDER_SESSION_MIGRATION_KEY, '1');
    } else {
      this.setKvValue(METAWEB_ORDER_SESSION_MIGRATION_KEY, '1');
    }
    return changed;
  }

  private resolveMetawebOrderPeerGlobalMetaId(
    row: { external_conversation_id: string; peer_global_metaid: string | null },
    mappingMetadata: CoworkMessageMetadata,
  ): string {
    const fromMetadata = typeof mappingMetadata.peerGlobalMetaId === 'string'
      ? mappingMetadata.peerGlobalMetaId.trim()
      : '';
    const fromSession = typeof row.peer_global_metaid === 'string'
      ? row.peer_global_metaid.trim()
      : '';
    const fromConversationId = String(row.external_conversation_id || '').match(/^metaweb_order:[^:]+:[^:]+:([^:]+):/)?.[1] ?? '';
    return fromMetadata || fromSession || fromConversationId;
  }

  private ensureCanonicalPrivateSessionForOrderMigration(input: {
    metabotId: number;
    peerGlobalMetaId: string;
    privateExternalConversationId: string;
    legacy: {
      cowork_session_id: string;
      title: string | null;
      cwd: string | null;
      system_prompt: string | null;
      execution_mode: string | null;
      peer_name: string | null;
      peer_avatar: string | null;
      created_at: number | null;
      updated_at: number | null;
    };
    mappingMetadata: CoworkMessageMetadata;
  }): string {
    const existing = this.getConversationMapping(
      'metaweb_private',
      input.privateExternalConversationId,
      input.metabotId,
    );
    if (existing && this.getSessionWithoutMessages(existing.coworkSessionId)) {
      if (this.ensureCanonicalPeerSessionShape({
        sessionId: existing.coworkSessionId,
        metabotId: input.metabotId,
        peerGlobalMetaId: input.peerGlobalMetaId,
        peerName: typeof input.mappingMetadata.peerName === 'string'
          ? input.mappingMetadata.peerName
          : input.legacy.peer_name,
        peerAvatar: typeof input.mappingMetadata.peerAvatar === 'string'
          ? input.mappingMetadata.peerAvatar
          : input.legacy.peer_avatar,
      })) {
        return existing.coworkSessionId;
      }
      this.deleteConversationMapping('metaweb_private', input.privateExternalConversationId, input.metabotId);
    }
    if (existing && !this.getSessionWithoutMessages(existing.coworkSessionId)) {
      this.deleteConversationMapping('metaweb_private', input.privateExternalConversationId, input.metabotId);
    }

    const peerName = typeof input.mappingMetadata.peerName === 'string'
      ? input.mappingMetadata.peerName.trim()
      : input.legacy.peer_name;
    const peerAvatar = typeof input.mappingMetadata.peerAvatar === 'string'
      ? input.mappingMetadata.peerAvatar.trim()
      : input.legacy.peer_avatar;
    const session = this.createSession(
      peerName || input.legacy.title || `Private-${input.peerGlobalMetaId.slice(0, 12)}`,
      input.legacy.cwd || getDefaultWorkingDirectory(),
      '',
      (input.legacy.execution_mode as CoworkExecutionMode) || 'local',
      [],
      input.metabotId,
      'a2a',
      input.peerGlobalMetaId,
      peerName || null,
      peerAvatar || null,
    );
    this.setSessionMigrationTimestamps(
      session.id,
      parseIdNumber(input.legacy.created_at) ?? Date.now(),
      parseIdNumber(input.legacy.updated_at) ?? parseIdNumber(input.legacy.created_at) ?? Date.now(),
    );
    this.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: input.privateExternalConversationId,
      metabotId: input.metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        peerGlobalMetaId: input.peerGlobalMetaId,
        peerName: peerName || null,
        peerAvatar: peerAvatar || null,
      }),
    });
    return session.id;
  }

  private setSessionMigrationTimestamps(sessionId: string, createdAt: number, updatedAt: number): void {
    const normalizedCreatedAt = Number.isFinite(createdAt) ? Math.trunc(createdAt) : Date.now();
    const normalizedUpdatedAt = Number.isFinite(updatedAt) ? Math.trunc(updatedAt) : normalizedCreatedAt;
    this.db.run(`
      UPDATE cowork_sessions
      SET created_at = ?, updated_at = ?
      WHERE id = ?
    `, [normalizedCreatedAt, normalizedUpdatedAt, sessionId]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  private copyMissingOrderMessagesToCanonicalSession(input: {
    fromSessionId: string;
    toSessionId: string;
    privateExternalConversationId: string;
    orderExternalConversationId: string;
    mappingMetadata: CoworkMessageMetadata;
  }): number {
    const existingMessages = this.getSessionMessages(input.toSessionId);
    const identityIndex = this.buildMessageIdentityIndex(existingMessages);
    const legacyMessages = this.getAll<{
      type: CoworkMessageType;
      content: string;
      metadata: string | null;
      created_at: number;
      sequence: number | null;
    }>(`
      SELECT type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY COALESCE(sequence, 0) ASC, created_at ASC, rowid ASC
    `, [input.fromSessionId]);

    let copied = 0;
    for (const message of legacyMessages) {
      const metadata = this.parseMessageMetadata(message.metadata);
      const identities = this.getMessageIdentities(metadata);
      if (this.messageIdentityExists(identityIndex, identities, message.content)) {
        continue;
      }

      const copiedMetadata: CoworkMessageMetadata = {
        ...metadata,
        sourceChannel: 'metaweb_private',
        externalConversationId: input.privateExternalConversationId,
        orderMappingExternalConversationId: input.orderExternalConversationId,
      };
      if (!copiedMetadata.orderTxid && typeof input.mappingMetadata.orderTxid === 'string') {
        copiedMetadata.orderTxid = input.mappingMetadata.orderTxid;
      }
      if (!copiedMetadata.orderRole && typeof input.mappingMetadata.role === 'string') {
        copiedMetadata.orderRole = input.mappingMetadata.role;
      }
      if (!copiedMetadata.paymentTxid && typeof input.mappingMetadata.servicePaidTx === 'string') {
        copiedMetadata.paymentTxid = input.mappingMetadata.servicePaidTx;
        copiedMetadata.orderPaymentTxid = input.mappingMetadata.servicePaidTx;
      }

      const created = this.insertMigratedMessage(input.toSessionId, {
        type: message.type,
        content: message.content,
        metadata: copiedMetadata,
        timestamp: message.created_at,
      });
      const createdIdentities = this.getMessageIdentities(created.metadata ?? {});
      this.addMessageIdentitiesToIndex(
        identityIndex,
        createdIdentities,
        created.content,
        Boolean(createdIdentities.pinId || createdIdentities.txids.size > 0),
      );
      copied += 1;
    }
    return copied;
  }

  /**
   * Forks a session from a message: creates a new session whose message history
   * is a copy of the source session up to and including the fork-point message.
   * The fork's claude_session_id stays NULL (the SDK conversation restarts from
   * the branch point), so the user continues from a fresh SDK session. The
   * fork inherits the source's cwd/systemPrompt/executionMode/metabot/type/
   * permissionMode. Fork provenance is recorded on the new session row.
   *
   * Message ids and timestamps are preserved (metadata references like
   * toolUseId and memory source message_id stay valid). No memory updates are
   * triggered — copying history is not new user input.
   */
  forkSession(
    sourceSessionId: string,
    forkPointMessageId: string,
    options: { title?: string; systemPromptOverride?: string } = {}
  ): CoworkSession | null {
    const source = this.getSession(sourceSessionId);
    if (!source) return null;

    const messages = this.getSessionMessages(sourceSessionId);
    const forkIndex = messages.findIndex((m) => m.id === forkPointMessageId);
    if (forkIndex === -1) return null;
    const forkMessages = messages.slice(0, forkIndex + 1);

    const forked = this.createSession(
      options.title?.trim() || `${source.title} (fork)`,
      source.cwd,
      options.systemPromptOverride ?? source.systemPrompt,
      source.executionMode,
      source.activeSkillIds,
      source.metabotId ?? null,
      source.sessionType ?? 'standard',
      source.peerGlobalMetaId ?? null,
      source.peerName ?? null,
      source.peerAvatar ?? null,
      source.permissionMode ?? 'default',
      source.model ?? null,
      source.effort ?? null,
      source.modelProvider ?? null,
      null,
      null,
      sourceSessionId
    );

    // Batch-copy messages with one flush. Timestamps are preserved; ids are
    // NOT: cowork_messages.id is a global primary key, so reusing the source
    // ids hit a UNIQUE constraint on the first row and left an orphan session
    // behind (createSession had already flushed). Copies take fresh uuids.
    try {
      for (const message of forkMessages) {
        const sequenceRow = this.db.exec(`
          SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
          FROM cowork_messages
          WHERE session_id = ?
        `, [forked.id]);
        const sequence = sequenceRow[0]?.values[0]?.[0] as number || 1;
        const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;
        this.db.run(`
          INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          uuidv4(),
          forked.id,
          message.type,
          message.content,
          metadataJson,
          message.timestamp,
          sequence,
        ]);
        this.touchSessionActivityAt(forked.id, message.timestamp, message.type, metadataJson);
      }
    } catch (error) {
      // Defensive: never leak a half-forked session row. FK cascade is not
      // guaranteed (PRAGMA foreign_keys), so delete children explicitly.
      this.db.run('DELETE FROM cowork_messages WHERE session_id = ?', [forked.id]);
      this.db.run('DELETE FROM cowork_sessions WHERE id = ?', [forked.id]);
      this.saveDb();
      throw error;
    }
    this.db.run(`
      UPDATE cowork_sessions
      SET fork_point_message_id = ?, updated_at = ?
      WHERE id = ?
    `, [forkPointMessageId, Date.now(), forked.id]);
    this.saveDb();

    return this.getSession(forked.id);
  }

  /**
   * Rewinds a session to a message: deletes all messages after the given one
   * and clears claude_session_id so the next continue starts a fresh SDK
   * conversation from the rewind point. Returns the truncated session, or null
   * when the session/message does not exist.
   */
  rewindSession(sessionId: string, rewindPointMessageId: string): CoworkSession | null {
    const messages = this.getSessionMessages(sessionId);
    const rewindIndex = messages.findIndex((m) => m.id === rewindPointMessageId);
    if (rewindIndex === -1) return null;

    const rewindMessage = messages[rewindIndex];
    const rewindSequence = this.getRewindSequence(sessionId, rewindPointMessageId);
    const rewindRowId = this.getRewindRowId(sessionId, rewindPointMessageId);
    // Delete rows ordered strictly after the rewind point using the same
    // (created_at, sequence, ROWID) composite ordering as getSessionMessages.
    this.db.run(`
      DELETE FROM cowork_messages
      WHERE session_id = ?
        AND (
          created_at > ?
          OR (created_at = ? AND COALESCE(sequence, 0) > ?)
          OR (created_at = ? AND COALESCE(sequence, 0) = ? AND rowid > ?)
        )
    `, [
      sessionId,
      rewindMessage.timestamp,
      rewindMessage.timestamp,
      rewindSequence,
      rewindMessage.timestamp,
      rewindSequence,
      rewindRowId,
    ]);
    this.db.run('UPDATE cowork_sessions SET claude_session_id = NULL, updated_at = ? WHERE id = ?', [Date.now(), sessionId]);
    // The truncated tail may have held the newest activity message; recompute
    // from what is left so the sidebar rank matches the surviving transcript.
    this.refreshSessionActivityAt(sessionId);
    this.saveDb();

    return this.getSession(sessionId);
  }

  private getRewindSequence(sessionId: string, messageId: string): number {
    const row = this.getOne<{ sequence: number | null }>(`
      SELECT sequence FROM cowork_messages WHERE session_id = ? AND id = ?
    `, [sessionId, messageId]);
    return row?.sequence ?? 0;
  }

  private getRewindRowId(sessionId: string, messageId: string): number {
    const row = this.getOne<{ rowid: number }>(`
      SELECT rowid FROM cowork_messages WHERE session_id = ? AND id = ?
    `, [sessionId, messageId]);
    return row?.rowid ?? 0;
  }

  private insertMigratedMessage(
    sessionId: string,
    message: Omit<CoworkMessage, 'id'>,
  ): CoworkMessage {
    const id = uuidv4();
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    const sequenceRow = this.db.exec(`
      SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
      FROM cowork_messages
      WHERE session_id = ?
    `, [sessionId]);
    const sequence = sequenceRow[0]?.values[0]?.[0] as number || 1;
    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;
    this.db.run(`
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      sessionId,
      message.type,
      message.content,
      metadataJson,
      timestamp,
      sequence,
    ]);
    this.db.run('UPDATE cowork_sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?', [timestamp, sessionId]);
    // A migrated row keeps its original created_at, so the activity stamp is
    // monotonic here too — an old copied turn never sinks a busy session.
    this.touchSessionActivityAt(sessionId, timestamp, message.type, metadataJson);
    return {
      id,
      type: message.type,
      content: message.content,
      timestamp,
      metadata: message.metadata,
    };
  }

  private buildMessageIdentityIndex(messages: CoworkMessage[]): {
    pinIds: Set<string>;
    txids: Set<string>;
    contentKeys: Set<string>;
  } {
    const index = {
      pinIds: new Set<string>(),
      txids: new Set<string>(),
      contentKeys: new Set<string>(),
    };
    for (const message of messages) {
      this.addMessageIdentitiesToIndex(index, this.getMessageIdentities(message.metadata ?? {}), message.content);
    }
    return index;
  }

  private addMessageIdentitiesToIndex(
    index: { pinIds: Set<string>; txids: Set<string>; contentKeys: Set<string> },
    identities: { pinId: string; txids: Set<string> },
    content: string,
    includeContentKey = true,
  ): void {
    if (identities.pinId) index.pinIds.add(identities.pinId);
    for (const txid of identities.txids) index.txids.add(txid);
    if (includeContentKey && !identities.pinId && identities.txids.size === 0) {
      const contentKey = String(content || '').trim();
      if (contentKey) index.contentKeys.add(contentKey);
    }
  }

  private getMessageIdentities(metadata: CoworkMessageMetadata): { pinId: string; txids: Set<string> } {
    const pinId = typeof metadata.pinId === 'string' ? metadata.pinId.trim() : '';
    const txids = new Set<string>();
    const txid = normalizeA2AChainTxid(metadata.txid);
    if (txid) txids.add(txid);
    if (Array.isArray(metadata.txids)) {
      for (const item of metadata.txids) {
        const normalized = normalizeA2AChainTxid(item);
        if (normalized) txids.add(normalized);
      }
    }
    return { pinId, txids };
  }

  private messageIdentityExists(
    index: { pinIds: Set<string>; txids: Set<string>; contentKeys: Set<string> },
    identities: { pinId: string; txids: Set<string> },
    content: string,
  ): boolean {
    if (identities.pinId && index.pinIds.has(identities.pinId)) return true;
    for (const txid of identities.txids) {
      if (index.txids.has(txid)) return true;
    }
    if (!identities.pinId && identities.txids.size === 0) {
      const contentKey = String(content || '').trim();
      return Boolean(contentKey && index.contentKeys.has(contentKey));
    }
    return false;
  }

  backfillMetawebOrderSimplemsgMetadata(): number {
    if (this.getKvValue(METAWEB_ORDER_SIMPLEMSG_BACKFILL_KEY) === '1') {
      return 0;
    }
    if (!this.tableExists('cowork_conversation_mappings') || !this.tableExists('cowork_messages')) {
      return 0;
    }

    let rows: MetawebOrderMessageBackfillRow[] = [];
    try {
      rows = this.getAll<MetawebOrderMessageBackfillRow>(`
        SELECT
          m.id AS message_id,
          m.session_id AS session_id,
          m.type AS message_type,
          s.metabot_id AS metabot_id,
          s.peer_global_metaid AS peer_global_metaid,
          m.content AS content,
          m.created_at AS message_created_at,
          m.metadata AS metadata,
          cm.external_conversation_id AS external_conversation_id,
          cm.metadata_json AS mapping_metadata_json
        FROM cowork_messages m
        INNER JOIN cowork_conversation_mappings cm
          ON cm.cowork_session_id = m.session_id
          AND cm.channel = 'metaweb_order'
        LEFT JOIN cowork_sessions s ON s.id = m.session_id
        WHERE m.type IN ('user', 'assistant')
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to scan metaweb_order messages for simplemsg metadata backfill:', error);
      return 0;
    }

    let changed = 0;
    for (const row of rows) {
      const metadata = this.parseMessageMetadata(row.metadata);
      const mappingMetadata = this.parseMessageMetadata(row.mapping_metadata_json);
      const sellerDeliveryPatch = this.resolveSellerDeliverySimplemsgPatch(row, metadata, mappingMetadata);
      const sellerProcessingNoticePatch = sellerDeliveryPatch
        ? null
        : this.resolveSellerProcessingNoticeSimplemsgPatch(row, metadata, mappingMetadata);
      const messagePatch = sellerDeliveryPatch || sellerProcessingNoticePatch;
      const serviceOrderMetadata = this.resolveServiceOrderSimplemsgMetadata(row, metadata, mappingMetadata);
      const privateChatMetadata = (messagePatch?.chainMetadata || (serviceOrderMetadata && Object.keys(serviceOrderMetadata).length > 0))
        ? null
        : this.resolvePrivateChatSimplemsgMetadata(row, metadata, mappingMetadata);
      const chainMetadata = messagePatch?.chainMetadata
        || (serviceOrderMetadata && Object.keys(serviceOrderMetadata).length > 0
        ? serviceOrderMetadata
        : privateChatMetadata);
      const hasChainMetadata = Boolean(chainMetadata && Object.keys(chainMetadata).length > 0);
      const hasMessagePatch = Boolean(
        messagePatch?.content
        || messagePatch?.extraMetadata
        || (messagePatch?.removeMetadataKeys?.length ?? 0) > 0,
      );
      if (!hasChainMetadata && !hasMessagePatch) continue;
      const merged = this.mergeBackfilledA2AMessageMetadata(metadata, chainMetadata);
      const patchedMetadata: CoworkMessageMetadata = { ...merged.metadata };
      if (messagePatch?.removeMetadataKeys) {
        for (const key of messagePatch.removeMetadataKeys) {
          delete patchedMetadata[key];
        }
      }
      if (messagePatch?.extraMetadata) {
        Object.assign(patchedMetadata, messagePatch.extraMetadata);
      }
      const metadataChanged = JSON.stringify(patchedMetadata) !== JSON.stringify(metadata);
      const nextContent = messagePatch?.content
        && messagePatch.content !== row.content
        ? messagePatch.content
        : null;
      if (!metadataChanged && nextContent == null) continue;

      if (nextContent != null) {
        this.db.run(`
          UPDATE cowork_messages
          SET content = ?, metadata = ?
          WHERE id = ? AND session_id = ?
        `, [nextContent, JSON.stringify(patchedMetadata), row.message_id, row.session_id]);
      } else {
        this.db.run(`
          UPDATE cowork_messages
          SET metadata = ?
          WHERE id = ? AND session_id = ?
        `, [JSON.stringify(patchedMetadata), row.message_id, row.session_id]);
      }
      if ((this.db.getRowsModified?.() || 0) > 0) {
        changed += 1;
      }
    }

    if (changed > 0) {
      this.setKvValue(METAWEB_ORDER_SIMPLEMSG_BACKFILL_KEY, '1');
    } else {
      this.setKvValue(METAWEB_ORDER_SIMPLEMSG_BACKFILL_KEY, '1');
    }
    return changed;
  }

  backfillMetawebPrivateSimplemsgMetadata(): number {
    if (this.getKvValue(METAWEB_PRIVATE_SIMPLEMSG_BACKFILL_KEY) === '1') {
      return 0;
    }
    if (
      !this.tableExists('cowork_conversation_mappings')
      || !this.tableExists('cowork_messages')
      || !this.tableExists('private_chat_messages')
    ) {
      return 0;
    }

    const hasMetabotsTable = this.tableExists('metabots');
    let rows: MetawebPrivateMessageBackfillRow[] = [];
    try {
      rows = this.getAll<MetawebPrivateMessageBackfillRow>(`
        SELECT
          m.id AS message_id,
          m.session_id AS session_id,
          m.type AS message_type,
          s.metabot_id AS metabot_id,
          s.peer_global_metaid AS peer_global_metaid,
          ${hasMetabotsTable ? 'mb.globalmetaid' : 'NULL'} AS local_global_metaid,
          m.content AS content,
          m.created_at AS message_created_at,
          m.metadata AS metadata,
          cm.external_conversation_id AS external_conversation_id,
          cm.metadata_json AS mapping_metadata_json
        FROM cowork_messages m
        INNER JOIN cowork_conversation_mappings cm
          ON cm.cowork_session_id = m.session_id
          AND cm.channel = 'metaweb_private'
        LEFT JOIN cowork_sessions s ON s.id = m.session_id
        ${hasMetabotsTable ? 'LEFT JOIN metabots mb ON mb.id = s.metabot_id' : ''}
        WHERE m.type IN ('user', 'assistant')
      `);
    } catch (error) {
      console.warn('[CoworkStore] Failed to scan metaweb_private messages for simplemsg metadata backfill:', error);
      return 0;
    }

    let changed = 0;
    for (const row of rows) {
      const metadata = this.parseMessageMetadata(row.metadata);
      const mappingMetadata = this.parseMessageMetadata(row.mapping_metadata_json);
      const chainMetadata = this.resolveMetawebPrivateSimplemsgMetadata(row, metadata, mappingMetadata);
      const merged = this.mergeBackfilledA2AMessageMetadata(metadata, chainMetadata);
      if (!merged.changed) continue;

      this.db.run(`
        UPDATE cowork_messages
        SET metadata = ?
        WHERE id = ? AND session_id = ?
      `, [JSON.stringify(merged.metadata), row.message_id, row.session_id]);
      if ((this.db.getRowsModified?.() || 0) > 0) {
        changed += 1;
      }
    }

    if (changed > 0) {
      this.setKvValue(METAWEB_PRIVATE_SIMPLEMSG_BACKFILL_KEY, '1');
    } else {
      this.setKvValue(METAWEB_PRIVATE_SIMPLEMSG_BACKFILL_KEY, '1');
    }
    return changed;
  }

  private tableExists(tableName: string): boolean {
    const row = this.getOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      [tableName]
    );
    return Boolean(row?.name);
  }

  private parseMessageMetadata(value: string | null | undefined): CoworkMessageMetadata {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as CoworkMessageMetadata
        : {};
    } catch {
      return {};
    }
  }

  private normalizeOrderBackfillRole(value: unknown): 'buyer' | 'seller' | '' {
    const role = String(value || '').trim();
    return role === 'buyer' || role === 'seller' ? role : '';
  }

  private extractOrderProtocolTagTxid(content: string): string {
    return normalizeA2AChainTxid(
      content.match(/^\[(?:DELIVERY|ORDER_STATUS|NeedsRating|ORDER_END):([0-9a-f]{64})(?:[\s\]]|[^\]]*\])/i)?.[1],
    );
  }

  private extractPaymentTxidFromSimplemsgContent(content: string): string {
    return normalizeA2AChainTxid(
      content.match(/\bpaymentTxid["']?\s*[:=]\s*["']?([0-9a-f]{64})/i)?.[1],
    ) || normalizeA2AChainTxid(
      content.match(/\btxid\s*:\s*([0-9a-f]{64})/i)?.[1],
    );
  }

  private extractOrderPinIdFromSimplemsgContent(content: string): string {
    const match = String(content || '').match(/^\s*order\s+pin\s+id\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9._:-]{5,127})\s*$/im);
    return typeof match?.[1] === 'string' ? match[1].trim() : '';
  }

  private getOrderBackfillIdentifiers(
    row: MetawebOrderMessageBackfillRow,
    metadata: CoworkMessageMetadata,
    mappingMetadata: CoworkMessageMetadata,
  ): OrderBackfillIdentifiers {
    const content = String(row.content || '').trim();
    const messageOrderTxid = normalizeA2AChainTxid(metadata.orderTxid)
      || this.extractOrderProtocolTagTxid(content);
    const mappingOrderTxid = normalizeA2AChainTxid(mappingMetadata.orderTxid);
    const messagePaymentTxid = normalizeA2AChainTxid(metadata.paymentTxid)
      || normalizeA2AChainTxid(metadata.orderPaymentTxid)
      || this.extractPaymentTxidFromSimplemsgContent(content);
    const mappingPaymentTxid = normalizeA2AChainTxid(mappingMetadata.servicePaidTx)
      || normalizeA2AChainTxid(mappingMetadata.paymentTxid)
      || normalizeA2AChainTxid(mappingMetadata.orderPaymentTxid);
    const messageOrderPinId = String(metadata.serviceOrderPinId || metadata.orderPinId || '').trim()
      || this.extractOrderPinIdFromSimplemsgContent(content);
    const mappingOrderPinId = String(mappingMetadata.serviceOrderPinId || mappingMetadata.orderPinId || '').trim();

    return {
      messageMappingExternalId: String(metadata.orderMappingExternalConversationId || '').trim(),
      messageOrderTxid,
      mappingOrderTxid,
      messagePaymentTxid,
      mappingPaymentTxid,
      messageOrderPinId,
      mappingOrderPinId,
      orderMessageTxid: messageOrderTxid || mappingOrderTxid,
      orderPinId: messageOrderPinId || mappingOrderPinId,
      paymentTxid: messagePaymentTxid || mappingPaymentTxid,
      role: this.normalizeOrderBackfillRole(metadata.orderRole) || this.normalizeOrderBackfillRole(mappingMetadata.role),
      peerGlobalMetaId: String(row.peer_global_metaid || mappingMetadata.peerGlobalMetaId || '').trim(),
      metabotId: parseIdNumber(row.metabot_id),
    };
  }

  private countMetawebOrderMappingsForSession(sessionId: string): number {
    try {
      const row = this.getOne<{ count: number | string | null }>(`
        SELECT COUNT(DISTINCT external_conversation_id) AS count
        FROM cowork_conversation_mappings
        WHERE cowork_session_id = ?
          AND channel = 'metaweb_order'
      `, [sessionId]);
      return parseIdNumber(row?.count) ?? 0;
    } catch {
      return 0;
    }
  }

  private isMetawebOrderMappingApplicableToMessage(
    row: MetawebOrderMessageBackfillRow,
    identifiers: OrderBackfillIdentifiers,
  ): boolean {
    if (
      identifiers.messageMappingExternalId
      && identifiers.messageMappingExternalId !== row.external_conversation_id
    ) {
      return false;
    }
    if (
      identifiers.messageOrderTxid
      && identifiers.mappingOrderTxid
      && identifiers.messageOrderTxid !== identifiers.mappingOrderTxid
    ) {
      return false;
    }
    if (
      identifiers.messagePaymentTxid
      && identifiers.mappingPaymentTxid
      && identifiers.messagePaymentTxid !== identifiers.mappingPaymentTxid
    ) {
      return false;
    }
    if (
      identifiers.messageOrderPinId
      && identifiers.mappingOrderPinId
      && identifiers.messageOrderPinId !== identifiers.mappingOrderPinId
    ) {
      return false;
    }

    if (this.countMetawebOrderMappingsForSession(row.session_id) <= 1) {
      return true;
    }
    if (identifiers.messageMappingExternalId === row.external_conversation_id) {
      return true;
    }
    if (identifiers.messageOrderTxid && identifiers.messageOrderTxid === identifiers.mappingOrderTxid) {
      return true;
    }
    if (identifiers.messagePaymentTxid && identifiers.messagePaymentTxid === identifiers.mappingPaymentTxid) {
      return true;
    }
    if (identifiers.messageOrderPinId && identifiers.messageOrderPinId === identifiers.mappingOrderPinId) {
      return true;
    }
    return false;
  }

  private resolveServiceOrderBackfillRow(input: {
    row: MetawebOrderMessageBackfillRow;
    metadata: CoworkMessageMetadata;
    mappingMetadata: CoworkMessageMetadata;
    requiredRole?: 'buyer' | 'seller';
    requireDeliveryPin?: boolean;
    orderByDelivery?: boolean;
  }): ServiceOrderSimplemsgBackfillRow | null {
    if (!this.tableExists('service_orders')) return null;
    const identifiers = this.getOrderBackfillIdentifiers(input.row, input.metadata, input.mappingMetadata);
    if (!this.isMetawebOrderMappingApplicableToMessage(input.row, identifiers)) return null;

    const role = input.requiredRole || identifiers.role;
    const roleClause = role ? 'AND role = ?' : '';
    const deliveryClause = input.requireDeliveryPin
      ? "AND delivery_message_pin_id IS NOT NULL AND TRIM(delivery_message_pin_id) <> ''"
      : '';
    const orderBy = input.orderByDelivery
      ? 'ORDER BY delivered_at DESC, updated_at DESC'
      : 'ORDER BY updated_at DESC';
    const selectColumns = 'order_pin_id, payment_txid, order_message_txid, order_message_pin_id, delivery_message_pin_id';

    const buildParams = (chainTxid: string): (string | number)[] => {
      const params: (string | number)[] = [
        identifiers.metabotId ?? 0,
        identifiers.peerGlobalMetaId,
        chainTxid,
      ];
      if (role) params.push(role);
      return params;
    };

    try {
      if (identifiers.metabotId != null && identifiers.peerGlobalMetaId && identifiers.orderMessageTxid) {
        const orderRow = this.getOne<ServiceOrderSimplemsgBackfillRow>(`
          SELECT ${selectColumns}
          FROM service_orders
          WHERE local_metabot_id = ?
            AND counterparty_global_metaid = ?
            AND order_message_txid = ?
            ${roleClause}
            ${deliveryClause}
          ${orderBy}
          LIMIT 1
        `, buildParams(identifiers.orderMessageTxid));
        if (orderRow) return orderRow;
      }

      if (identifiers.metabotId != null && identifiers.peerGlobalMetaId && identifiers.orderPinId) {
        const orderPinRow = this.getOne<ServiceOrderSimplemsgBackfillRow>(`
          SELECT ${selectColumns}
          FROM service_orders
          WHERE local_metabot_id = ?
            AND counterparty_global_metaid = ?
            AND order_pin_id = ?
            ${roleClause}
            ${deliveryClause}
          ${orderBy}
          LIMIT 1
        `, buildParams(identifiers.orderPinId));
        if (orderPinRow) return orderPinRow;
      }

      if (identifiers.metabotId != null && identifiers.peerGlobalMetaId && identifiers.paymentTxid) {
        const paymentRow = this.getOne<ServiceOrderSimplemsgBackfillRow>(`
          SELECT ${selectColumns}
          FROM service_orders
          WHERE local_metabot_id = ?
            AND counterparty_global_metaid = ?
            AND payment_txid = ?
            ${roleClause}
            ${deliveryClause}
          ${orderBy}
          LIMIT 1
        `, buildParams(identifiers.paymentTxid));
        if (paymentRow) return paymentRow;
      }

      if (identifiers.orderMessageTxid || identifiers.orderPinId || identifiers.paymentTxid) {
        return null;
      }

      const fallbackParams: (string | number)[] = [input.row.session_id];
      if (role) fallbackParams.push(role);
      const fallback = this.getOne<ServiceOrderSimplemsgBackfillMatchRow>(`
        SELECT
          COUNT(*) AS match_count,
          MAX(payment_txid) AS payment_txid,
          MAX(order_message_txid) AS order_message_txid,
          MAX(order_message_pin_id) AS order_message_pin_id,
          MAX(delivery_message_pin_id) AS delivery_message_pin_id
        FROM service_orders
        WHERE cowork_session_id = ?
          ${roleClause}
          ${deliveryClause}
      `, fallbackParams);
      return parseIdNumber(fallback?.match_count) === 1 ? fallback : null;
    } catch {
      return null;
    }
  }

  private resolveSellerDeliverySimplemsgPatch(
    row: MetawebOrderMessageBackfillRow,
    metadata: CoworkMessageMetadata,
    mappingMetadata: CoworkMessageMetadata,
  ): MetawebOrderBackfillPatch | null {
    if (!this.tableExists('service_orders') || !this.tableExists('private_chat_messages')) return null;
    if (String(mappingMetadata.role || '').trim() !== 'seller') return null;
    const isUploadCompleteDeliveryNotice = metadata.orderDeliveryUploadComplete === true;
    const isLegacyFinalDeliveryResult = this.isLegacySellerFinalDeliveryResult(row, metadata);
    if (!isUploadCompleteDeliveryNotice && !isLegacyFinalDeliveryResult) return null;
    if (isUploadCompleteDeliveryNotice && metadata.direction !== 'outgoing') return null;

    const orderRow = this.resolveServiceOrderBackfillRow({
      row,
      metadata,
      mappingMetadata,
      requiredRole: 'seller',
      requireDeliveryPin: true,
      orderByDelivery: true,
    });

    const deliveryPinId = typeof orderRow?.delivery_message_pin_id === 'string'
      ? orderRow.delivery_message_pin_id.trim()
      : '';
    if (!deliveryPinId) return null;

    let deliveryMessage: PrivateChatSimplemsgBackfillRow | undefined;
    try {
      deliveryMessage = this.getOne<PrivateChatSimplemsgBackfillRow>(`
        SELECT pin_id, tx_id, chain_timestamp, content
        FROM private_chat_messages
        WHERE pin_id = ?
          AND LOWER(TRIM(protocol)) IN ('simplemsg', '/protocols/simplemsg')
          AND TRIM(content) LIKE '[DELIVERY%'
        LIMIT 1
      `, [deliveryPinId]);
    } catch {
      return null;
    }

    const transmittedContent = typeof deliveryMessage?.content === 'string'
      ? deliveryMessage.content.trim()
      : '';
    if (!transmittedContent) return null;
    if (
      isLegacyFinalDeliveryResult
      && !this.deliverySimplemsgContainsResultText(transmittedContent, row.content)
    ) {
      return null;
    }
    if (
      isLegacyFinalDeliveryResult
      && this.sessionAlreadyHasDeliverySimplemsgBubble(row.session_id, row.message_id, deliveryPinId, transmittedContent)
    ) {
      return null;
    }

    return {
      content: transmittedContent,
      chainMetadata: buildA2AChainMetadata({
        txId: deliveryMessage?.tx_id,
        pinId: deliveryPinId,
      }),
      extraMetadata: {
        ...buildOrderProtocolDisplayMetadata({
          peerGlobalMetaId: String(row.peer_global_metaid || mappingMetadata.peerGlobalMetaId || ''),
          direction: 'outgoing',
          tag: 'DELIVERY',
          orderTxid: typeof mappingMetadata.orderTxid === 'string' ? mappingMetadata.orderTxid : null,
          orderRole: 'seller',
          orderPinId: String(orderRow?.order_pin_id || mappingMetadata.serviceOrderPinId || mappingMetadata.orderPinId || ''),
          paymentTxid: normalizeA2AChainTxid(orderRow?.payment_txid)
            || normalizeA2AChainTxid(mappingMetadata.servicePaidTx)
            || undefined,
          orderMappingExternalConversationId: row.external_conversation_id,
        }),
        excludeFromSandboxHistory: true,
        orderDeliveryMessage: true,
      },
      removeMetadataKeys: isUploadCompleteDeliveryNotice ? ['orderDeliveryUploadComplete'] : undefined,
    };
  }

  private isLegacySellerFinalDeliveryResult(
    row: MetawebOrderMessageBackfillRow,
    metadata: CoworkMessageMetadata,
  ): boolean {
    const content = String(row.content || '').trim();
    if (!content) return false;
    if (content.startsWith('[ORDER]') || content.startsWith('[DELIVERY]') || content.startsWith('[DELIVERY:')) {
      return false;
    }
    if (row.message_type !== 'assistant') return false;
    if (metadata.isFinal !== true || metadata.isStreaming !== false) return false;
    if (metadata.direction != null && metadata.direction !== 'outgoing') return false;
    return true;
  }

  private deliverySimplemsgContainsResultText(transmittedContent: string, resultText: string): boolean {
    const expected = String(resultText || '').replace(/\r\n/g, '\n').trim();
    if (!expected) return false;

    const tagEnd = transmittedContent.indexOf(']');
    if (tagEnd < 0) return false;
    const payload = transmittedContent.slice(tagEnd + 1).trim();
    if (!payload.startsWith('{')) return false;

    try {
      const parsed = JSON.parse(payload) as { result?: unknown; content?: unknown; text?: unknown };
      const candidates = [parsed.result, parsed.content, parsed.text]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.replace(/\r\n/g, '\n').trim());
      return candidates.some((value) => value.includes(expected));
    } catch {
      return false;
    }
  }

  private sessionAlreadyHasDeliverySimplemsgBubble(
    sessionId: string,
    currentMessageId: string,
    deliveryPinId: string,
    transmittedContent: string,
  ): boolean {
    let rows: Array<{ content: string | null; metadata: string | null }> = [];
    try {
      rows = this.getAll<{ content: string | null; metadata: string | null }>(`
        SELECT content, metadata
        FROM cowork_messages
        WHERE session_id = ?
          AND id <> ?
          AND (
            content = ?
            OR metadata LIKE '%orderDeliveryMessage%'
            OR metadata LIKE '%orderDeliveryUploadComplete%'
            OR metadata LIKE ?
          )
        LIMIT 20
      `, [sessionId, currentMessageId, transmittedContent, `%${deliveryPinId}%`]);
    } catch {
      return false;
    }

    for (const candidate of rows) {
      const candidateContent = typeof candidate.content === 'string' ? candidate.content.trim() : '';
      if (candidateContent === transmittedContent) return true;
      const candidateMetadata = this.parseMessageMetadata(candidate.metadata);
      if (String(candidateMetadata.pinId || '').trim() === deliveryPinId) return true;
      if (
        candidateMetadata.orderDeliveryUploadComplete === true
        && candidateContent
        && this.deliverySimplemsgContainsResultText(transmittedContent, candidateContent)
      ) {
        return true;
      }
      if (
        candidateMetadata.orderDeliveryMessage === true
        && candidateContent
        && this.deliverySimplemsgContainsResultText(transmittedContent, candidateContent)
      ) {
        return true;
      }
    }
    return false;
  }

  private resolveSellerProcessingNoticeSimplemsgPatch(
    row: MetawebOrderMessageBackfillRow,
    metadata: CoworkMessageMetadata,
    mappingMetadata: CoworkMessageMetadata,
  ): MetawebOrderBackfillPatch | null {
    if (!this.tableExists('private_chat_messages')) return null;
    if (metadata.orderProcessingNotice !== true) return null;
    if (metadata.direction !== 'outgoing') return null;
    if (String(mappingMetadata.role || '').trim() !== 'seller') return null;

    const peerGlobalMetaId = String(row.peer_global_metaid || mappingMetadata.peerGlobalMetaId || '').trim();
    const localGlobalMetaId = String(mappingMetadata.serverBotGlobalMetaId || '').trim();
    if (!peerGlobalMetaId) return null;

    let candidates: PrivateChatSimplemsgBackfillRow[] = [];
    try {
      candidates = this.getAll<PrivateChatSimplemsgBackfillRow>(`
        SELECT pin_id, tx_id, chain_timestamp, content
        FROM private_chat_messages
        WHERE LOWER(TRIM(protocol)) IN ('simplemsg', '/protocols/simplemsg')
          AND to_global_metaid = ?
          AND (? = '' OR from_global_metaid = ?)
          AND content IS NOT NULL
          AND TRIM(content) <> ''
          AND TRIM(content) NOT LIKE '[ORDER]%'
          AND TRIM(content) NOT LIKE '[DELIVERY%'
          AND TRIM(content) NOT LIKE '[NeedsRating%'
        ORDER BY id DESC
        LIMIT 20
      `, [peerGlobalMetaId, localGlobalMetaId, localGlobalMetaId]);
    } catch {
      return null;
    }

    const candidate = this.selectNearestPrivateChatSimplemsgCandidate(row, candidates);
    if (!candidate) return null;
    const transmittedContent = typeof candidate.content === 'string' ? candidate.content.trim() : '';
    if (!transmittedContent) return null;

    return {
      content: transmittedContent,
      chainMetadata: buildA2AChainMetadata({
        txId: candidate.tx_id,
        pinId: candidate.pin_id,
      }),
    };
  }

  private resolveServiceOrderSimplemsgMetadata(
    row: MetawebOrderMessageBackfillRow,
    metadata: CoworkMessageMetadata,
    mappingMetadata: CoworkMessageMetadata,
  ): A2AChainMetadata | null {
    const content = String(row.content || '').trim();
    const isOrderMessage = content.startsWith('[ORDER]');
    const isDeliveryMessage = content.startsWith('[DELIVERY]') || content.startsWith('[DELIVERY:');
    if (!isOrderMessage && !isDeliveryMessage) return null;

    const orderRow = this.resolveServiceOrderBackfillRow({ row, metadata, mappingMetadata });
    if (!orderRow) return null;
    const pinId = isOrderMessage ? orderRow.order_message_pin_id : orderRow.delivery_message_pin_id;
    return buildA2AChainMetadata({ pinId });
  }

  private resolvePrivateChatSimplemsgMetadata(
    row: MetawebOrderMessageBackfillRow,
    metadata: CoworkMessageMetadata,
    mappingMetadata: CoworkMessageMetadata,
  ): A2AChainMetadata | null {
    if (!this.tableExists('private_chat_messages')) return null;
    const content = String(row.content || '').trim();
    if (!content) return null;
    const direction = metadata.direction === 'incoming' || metadata.direction === 'outgoing'
      ? metadata.direction
      : null;
    if (!direction) return null;
    const peerGlobalMetaId = String(row.peer_global_metaid || mappingMetadata.peerGlobalMetaId || '').trim();
    if (!peerGlobalMetaId) return null;

    let candidates: PrivateChatSimplemsgBackfillRow[] = [];
    try {
      candidates = this.getAll<PrivateChatSimplemsgBackfillRow>(`
        SELECT pin_id, tx_id, chain_timestamp
        FROM private_chat_messages
        WHERE content = ?
          AND LOWER(TRIM(protocol)) IN ('simplemsg', '/protocols/simplemsg')
          AND (
            (? = 'incoming' AND from_global_metaid = ?)
            OR (? = 'outgoing' AND to_global_metaid = ?)
          )
        ORDER BY id DESC
        LIMIT 20
      `, [content, direction, peerGlobalMetaId, direction, peerGlobalMetaId]);
    } catch {
      return null;
    }
    const byPinId = new Map<string, PrivateChatSimplemsgBackfillRow>();
    for (const candidate of candidates) {
      const pinId = typeof candidate.pin_id === 'string' ? candidate.pin_id.trim() : '';
      if (!pinId) continue;
      byPinId.set(pinId, candidate);
    }
    const uniqueCandidates = Array.from(byPinId.values());
    if (uniqueCandidates.length !== 1) {
      const candidate = this.selectNearestPrivateChatSimplemsgCandidate(row, uniqueCandidates);
      if (!candidate) return null;
      return buildA2AChainMetadata({
        txId: candidate.tx_id,
        pinId: candidate.pin_id,
      });
    }
    const [candidate] = uniqueCandidates;
    return buildA2AChainMetadata({
      txId: candidate.tx_id,
      pinId: candidate.pin_id,
    });
  }

  private resolveMetawebPrivateSimplemsgMetadata(
    row: MetawebPrivateMessageBackfillRow,
    metadata: CoworkMessageMetadata,
    mappingMetadata: CoworkMessageMetadata,
  ): A2AChainMetadata | null {
    const content = String(row.content || '').trim();
    if (!content) return null;
    const direction = metadata.direction === 'incoming' || metadata.direction === 'outgoing'
      ? metadata.direction
      : row.message_type === 'user'
        ? 'incoming'
        : row.message_type === 'assistant'
          ? 'outgoing'
          : null;
    if (!direction) return null;

    const peerGlobalMetaId = String(
      row.peer_global_metaid
      || mappingMetadata.peerGlobalMetaId
      || metadata.senderGlobalMetaId
      || ''
    ).trim();
    if (!peerGlobalMetaId) return null;
    const localGlobalMetaId = String(
      row.local_global_metaid
      || mappingMetadata.localGlobalMetaId
      || mappingMetadata.serverBotGlobalMetaId
      || ''
    ).trim();

    let candidates: PrivateChatSimplemsgBackfillRow[] = [];
    try {
      candidates = this.getAll<PrivateChatSimplemsgBackfillRow>(`
        SELECT pin_id, tx_id, chain_timestamp
        FROM private_chat_messages
        WHERE content = ?
          AND LOWER(TRIM(protocol)) IN ('simplemsg', '/protocols/simplemsg')
          AND (
            (
              ? = 'incoming'
              AND from_global_metaid = ?
              AND (? = '' OR to_global_metaid = ?)
            )
            OR (
              ? = 'outgoing'
              AND to_global_metaid = ?
              AND (? = '' OR from_global_metaid = ?)
            )
          )
        ORDER BY id DESC
        LIMIT 20
      `, [
        content,
        direction,
        peerGlobalMetaId,
        localGlobalMetaId,
        localGlobalMetaId,
        direction,
        peerGlobalMetaId,
        localGlobalMetaId,
        localGlobalMetaId,
      ]);
    } catch {
      return null;
    }

    const byPinId = new Map<string, PrivateChatSimplemsgBackfillRow>();
    for (const candidate of candidates) {
      const pinId = typeof candidate.pin_id === 'string' ? candidate.pin_id.trim() : '';
      if (!pinId) continue;
      byPinId.set(pinId, candidate);
    }
    const uniqueCandidates = Array.from(byPinId.values());
    if (uniqueCandidates.length !== 1) {
      const candidate = this.selectNearestPrivateChatSimplemsgCandidate(row, uniqueCandidates);
      if (!candidate) return null;
      return buildA2AChainMetadata({
        txId: candidate.tx_id,
        pinId: candidate.pin_id,
      });
    }

    const [candidate] = uniqueCandidates;
    return buildA2AChainMetadata({
      txId: candidate.tx_id,
      pinId: candidate.pin_id,
    });
  }

  private selectNearestPrivateChatSimplemsgCandidate(
    row: MetawebOrderMessageBackfillRow,
    candidates: PrivateChatSimplemsgBackfillRow[],
  ): PrivateChatSimplemsgBackfillRow | null {
    const messageCreatedAt = parseIdNumber(row.message_created_at);
    if (messageCreatedAt == null) return null;

    let nearest: PrivateChatSimplemsgBackfillRow | null = null;
    let nearestDiffMs = Number.POSITIVE_INFINITY;
    let tied = false;

    for (const candidate of candidates) {
      const pinId = typeof candidate.pin_id === 'string' ? candidate.pin_id.trim() : '';
      if (!pinId) continue;
      const chainTimestampSec = parseIdNumber(candidate.chain_timestamp);
      if (chainTimestampSec == null) continue;
      const diffMs = Math.abs((chainTimestampSec * 1000) - messageCreatedAt);
      if (diffMs > PRIVATE_CHAT_SIMPLEMSG_BACKFILL_TIME_WINDOW_MS) continue;
      if (diffMs < nearestDiffMs) {
        nearest = candidate;
        nearestDiffMs = diffMs;
        tied = false;
      } else if (diffMs === nearestDiffMs) {
        tied = true;
      }
    }

    return tied ? null : nearest;
  }

  private mergeBackfilledA2AMessageMetadata(
    metadata: CoworkMessageMetadata,
    chainMetadata: A2AChainMetadata | null | undefined,
  ): { metadata: CoworkMessageMetadata; changed: boolean } {
    const before = JSON.stringify(metadata);
    const updated: CoworkMessageMetadata = { ...metadata };
    if (chainMetadata && Object.keys(chainMetadata).length > 0) {
      const paymentTxid = normalizeA2AChainTxid(updated.paymentTxid);
      const existingTxid = normalizeA2AChainTxid(updated.txid);
      if (paymentTxid && existingTxid === paymentTxid) {
        delete updated.txid;
      }
      if (paymentTxid && Array.isArray(updated.txids)) {
        const normalizedTxids = updated.txids.map(normalizeA2AChainTxid).filter(Boolean);
        if (normalizedTxids.length > 0 && normalizedTxids.every((txid) => txid === paymentTxid)) {
          delete updated.txids;
        }
      }
      if (paymentTxid && extractTxidFromA2AChainPinId(updated.pinId) === paymentTxid) {
        delete updated.pinId;
      }
      this.applyBackfilledA2AChainMetadata(updated, chainMetadata);
    }
    return {
      metadata: updated,
      changed: JSON.stringify(updated) !== before,
    };
  }

  private applyBackfilledA2AChainMetadata(
    metadata: CoworkMessageMetadata,
    chainMetadata: A2AChainMetadata,
  ): void {
    const existingTxids = this.collectA2AChainTxids(metadata);
    const candidateTxids = this.collectA2AChainTxids(chainMetadata);
    if (!this.areA2AChainTxidSetsCompatible(existingTxids, candidateTxids)) {
      return;
    }

    const candidateTxid = normalizeA2AChainTxid(chainMetadata.txid);
    const existingTxid = normalizeA2AChainTxid(metadata.txid);
    if (candidateTxid && !existingTxid) {
      metadata.txid = candidateTxid;
    }

    const candidateTxidsList = Array.isArray(chainMetadata.txids)
      ? Array.from(new Set(chainMetadata.txids.map(normalizeA2AChainTxid).filter(Boolean)))
      : [];
    const existingTxidsList = Array.isArray(metadata.txids)
      ? metadata.txids.map(normalizeA2AChainTxid).filter(Boolean)
      : [];
    if (candidateTxidsList.length > 0 && existingTxidsList.length === 0) {
      metadata.txids = candidateTxidsList;
    }

    const candidatePinId = typeof chainMetadata.pinId === 'string' ? chainMetadata.pinId.trim() : '';
    const existingPinId = typeof metadata.pinId === 'string' ? metadata.pinId.trim() : '';
    if (candidatePinId && !existingPinId) {
      metadata.pinId = candidatePinId;
    }
  }

  private collectA2AChainTxids(metadata: Record<string, unknown>): Set<string> {
    const txids = new Set<string>();
    const txid = normalizeA2AChainTxid(metadata.txid);
    if (txid) txids.add(txid);
    if (Array.isArray(metadata.txids)) {
      for (const item of metadata.txids) {
        const normalized = normalizeA2AChainTxid(item);
        if (normalized) txids.add(normalized);
      }
    }
    const pinTxid = extractTxidFromA2AChainPinId(metadata.pinId);
    if (pinTxid) txids.add(pinTxid);
    return txids;
  }

  private areA2AChainTxidSetsCompatible(existingTxids: Set<string>, candidateTxids: Set<string>): boolean {
    if (existingTxids.size === 0 || candidateTxids.size === 0) {
      return true;
    }
    if (existingTxids.size !== candidateTxids.size) {
      return false;
    }
    for (const candidateTxid of candidateTxids) {
      if (!existingTxids.has(candidateTxid)) {
        return false;
      }
    }
    return true;
  }

  deleteMessage(sessionId: string, messageId: string): void {
    this.db.run(`
      DELETE FROM cowork_messages
      WHERE id = ? AND session_id = ?
    `, [messageId, sessionId]);

    if ((this.db.getRowsModified?.() || 0) > 0) {
      this.saveDb();
    }
  }

  /**
   * Dream review P3: persisted capability-gate knob (cowork_config kv, same
   * pattern as the memory policy rows below). ONLY the panel count is
   * configurable — the prospective post-origin citation rule is a data-leak
   * guard and stays unconditionally on. Default 2 panels (behavior
   * unchanged).
   */
  getCapabilityGateConfig(): { panels: 1 | 2 } {
    const row = this.getOne<{ value: string }>(
      "SELECT value FROM cowork_config WHERE key = 'capabilityGateConfig'",
      [],
    );
    if (!row?.value) return { panels: 2 };
    try {
      const parsed = JSON.parse(row.value) as { panels?: unknown };
      return { panels: parsed.panels === 1 ? 1 : 2 };
    } catch {
      return { panels: 2 };
    }
  }

  setCapabilityGateConfig(input: { panels: 1 | 2 }): { panels: 1 | 2 } {
    const panels = input?.panels === 1 ? 1 : 2;
    this.db.run(
      `INSERT INTO cowork_config (key, value, updated_at)
       VALUES ('capabilityGateConfig', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify({ panels }), Date.now()],
    );
    this.saveDb();
    return { panels };
  }

  // Config operations
  getConfig(): CoworkConfig {
    interface ConfigRow {
      value: string;
    }

    const workingDirRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['workingDirectory']);
    const executionModeRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['executionMode']);
    const memoryEnabledRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['memoryEnabled']);
    const memoryImplicitUpdateEnabledRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['memoryImplicitUpdateEnabled']);
    const memoryLlmJudgeEnabledRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['memoryLlmJudgeEnabled']);
    const memoryGuardLevelRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['memoryGuardLevel']);
    const memoryUserMemoriesMaxItemsRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['memoryUserMemoriesMaxItems']);
    const memoryPromptMaxCharsRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['memoryPromptMaxChars']);
    const lastWorkspaceSelectionRow = this.getOne<ConfigRow>('SELECT value FROM cowork_config WHERE key = ?', ['lastWorkspaceSelection']);

    return {
      workingDirectory: workingDirRow?.value || getDefaultWorkingDirectory(),
      systemPrompt: getDefaultSystemPrompt(),
      executionMode: resolveCoworkExecutionMode(executionModeRow?.value),
      memoryEnabled: parseBooleanConfig(memoryEnabledRow?.value, DEFAULT_MEMORY_ENABLED),
      memoryImplicitUpdateEnabled: parseBooleanConfig(
        memoryImplicitUpdateEnabledRow?.value,
        DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED
      ),
      memoryLlmJudgeEnabled: parseBooleanConfig(
        memoryLlmJudgeEnabledRow?.value,
        DEFAULT_MEMORY_LLM_JUDGE_ENABLED
      ),
      memoryGuardLevel: normalizeMemoryGuardLevel(memoryGuardLevelRow?.value),
      memoryUserMemoriesMaxItems: clampMemoryUserMemoriesMaxItems(Number(memoryUserMemoriesMaxItemsRow?.value)),
      memoryPromptMaxChars: clampMemoryPromptMaxChars(Number(memoryPromptMaxCharsRow?.value)),
      lastWorkspaceSelection: parseLastWorkspaceSelection(lastWorkspaceSelectionRow?.value),
    };
  }

  setConfig(config: CoworkConfigUpdate): void {
    const now = Date.now();

    if (config.workingDirectory !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('workingDirectory', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.workingDirectory, now]);
    }

    if (config.executionMode !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('executionMode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [resolveCoworkExecutionMode(config.executionMode), now]);
    }

    if (config.memoryEnabled !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryEnabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.memoryEnabled ? '1' : '0', now]);
    }

    if (config.memoryImplicitUpdateEnabled !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryImplicitUpdateEnabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.memoryImplicitUpdateEnabled ? '1' : '0', now]);
    }

    if (config.memoryLlmJudgeEnabled !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryLlmJudgeEnabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.memoryLlmJudgeEnabled ? '1' : '0', now]);
    }

    if (config.memoryGuardLevel !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryGuardLevel', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [normalizeMemoryGuardLevel(config.memoryGuardLevel), now]);
    }

    if (config.memoryUserMemoriesMaxItems !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryUserMemoriesMaxItems', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [String(clampMemoryUserMemoriesMaxItems(config.memoryUserMemoriesMaxItems)), now]);
    }

    if (config.memoryPromptMaxChars !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('memoryPromptMaxChars', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [String(clampMemoryPromptMaxChars(config.memoryPromptMaxChars)), now]);
    }

    if (config.lastWorkspaceSelection !== undefined) {
      this.db.run(`
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('lastWorkspaceSelection', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `, [config.lastWorkspaceSelection ? JSON.stringify(config.lastWorkspaceSelection) : '', now]);
    }

    this.saveDb();
  }

  // Memory hygiene ("记忆整理"): global thresholds as one JSON row plus the
  // persisted last-run record that drives once-per-night scheduling and the
  // settings stats view.
  getMemoryHygieneConfig(): MemoryHygieneConfig {
    const row = this.getOne<{ value: string }>('SELECT value FROM cowork_config WHERE key = ?', ['memoryHygiene']);
    let parsed: unknown = {};
    if (row?.value) {
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = {};
      }
    }
    return normalizeMemoryHygieneConfig(parsed);
  }

  setMemoryHygieneConfig(update: Partial<MemoryHygieneConfig> | Record<string, unknown>): MemoryHygieneConfig {
    const next = normalizeMemoryHygieneConfig({ ...this.getMemoryHygieneConfig(), ...update });
    this.db.run(`
      INSERT INTO cowork_config (key, value, updated_at)
      VALUES ('memoryHygiene', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [JSON.stringify(next), Date.now()]);
    this.saveDb();
    return next;
  }

  getMemoryHygieneLastRun(): MemoryHygieneRunStats | null {
    const row = this.getOne<{ value: string }>('SELECT value FROM cowork_config WHERE key = ?', ['memoryHygieneLastRun']);
    if (!row?.value) {
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as MemoryHygieneRunStats;
      if (!parsed || typeof parsed.dateKey !== 'string' || typeof parsed.ranAt !== 'number') {
        return null;
      }
      return { ...parsed, counts: parsed.counts ?? {}, errors: parsed.errors ?? [] };
    } catch {
      return null;
    }
  }

  setMemoryHygieneLastRun(stats: MemoryHygieneRunStats): void {
    this.db.run(`
      INSERT INTO cowork_config (key, value, updated_at)
      VALUES ('memoryHygieneLastRun', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [JSON.stringify(stats), Date.now()]);
    this.saveDb();
  }

  getAppLanguage(): 'zh' | 'en' {
    interface KvRow {
      value: string;
    }

    const row = this.getOne<KvRow>('SELECT value FROM kv WHERE key = ?', ['app_config']);
    if (!row?.value) {
      return 'zh';
    }

    try {
      const config = JSON.parse(row.value) as { language?: string };
      return config.language === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  }

  private mapMemoryRow(row: CoworkUserMemoryRow): CoworkUserMemory {
    return {
      id: row.id,
      // Read-side sanitize: rows written before the surrogate-safe truncate
      // fix may still carry a split-emoji half; this view feeds the scoped
      // memory prompt blocks on EVERY turn, so polluted text 400'd strict
      // upstream parsers until the row was rewritten. Fingerprinting and
      // match keys keep using the stored raw text (write path strips).
      text: stripLoneSurrogates(row.text ?? ''),
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.7,
      isExplicit: Number(row.is_explicit) !== 0,
      status: (row.status === 'stale' || row.status === 'deleted' ? row.status : 'created') as CoworkUserMemoryStatus,
      scopeKind: row.scope_kind === 'contact' || row.scope_kind === 'conversation' ? row.scope_kind : 'owner',
      scopeKey: normalizeScopeIdentity(row.scope_key) || OWNER_SCOPE_KEY,
      usageClass: normalizeMemoryUsageClass(row.usage_class),
      visibility: normalizeMemoryVisibility(row.visibility),
      origin: normalizeMemoryOrigin(row.origin),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      lastAppliedAt: row.last_applied_at == null ? null : Number(row.last_applied_at),
      archivedAt: row.archived_at == null ? null : Number(row.archived_at),
      importance: clampMemoryImportance(row.importance),
      occurredAt: row.occurred_at == null ? null : Number(row.occurred_at),
    };
  }

  private addMemorySource(memoryId: string, metabotId: number, source?: CoworkUserMemorySourceInput): void {
    const now = Date.now();
    const sessionId = source?.sessionId || null;
    const context = this.getConversationSourceContextBySession(sessionId ?? undefined);
    const sourceChannel = source?.sourceChannel?.trim()
      ? source.sourceChannel.trim()
      : context.sourceChannel;
    const externalConversationId = source?.externalConversationId?.trim()
      ? source.externalConversationId.trim()
      : context.externalConversationId;
    const sourceType = source?.sourceType?.trim()
      ? source.sourceType.trim()
      : 'session_turn';
    const sourceId = source?.sourceId?.trim()
      ? source.sourceId.trim()
      : (source?.messageId || null);

    this.db.run(`
      INSERT INTO user_memory_sources (
        id, memory_id, metabot_id, session_id, source_channel, source_type, external_conversation_id, source_id,
        message_id, role, is_active, created_at, dream_date, quote
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `, [
      uuidv4(),
      memoryId,
      metabotId,
      sessionId,
      sourceChannel || null,
      sourceType || null,
      externalConversationId || null,
      sourceId,
      source?.messageId || null,
      source?.role || 'system',
      now,
      source?.dreamDate?.trim() || null,
      // The quote carries raw conversation wording the memory text may have
      // paraphrased away — screen it like memory text (redact, or drop on a
      // blocking detector; provenance never refuses the write).
      defendMemoryQuote(normalizeMemoryQuote(source?.quote)),
    ]);
  }

  /**
   * Evidence ledger: keep the wording a merge/rewrite replaced. No-op when the
   * text did not change (a corroborating merge that keeps the stored wording
   * is provenance, not a revision). History is bounded per memory — the
   * newest MEMORY_REVISIONS_KEEP_PER_MEMORY rows survive.
   */
  private recordMemoryRevision(input: {
    memoryId: string;
    metabotId: number | null;
    previousText: string;
    newText: string;
    reason: MemoryRevisionReason;
    sourceType?: string | null;
  }): void {
    if (input.previousText === input.newText) return;
    const now = Date.now();
    this.db.run(`
      INSERT INTO user_memory_revisions (
        id, memory_id, metabot_id, previous_text, new_text, reason, source_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuidv4(),
      input.memoryId,
      input.metabotId,
      input.previousText,
      input.newText,
      input.reason,
      input.sourceType?.trim() || null,
      now,
    ]);
    this.db.run(`
      DELETE FROM user_memory_revisions
      WHERE memory_id = ?
        AND id NOT IN (
          SELECT id FROM user_memory_revisions
          WHERE memory_id = ?
          ORDER BY created_at DESC, ROWID DESC
          LIMIT ?
        )
    `, [input.memoryId, input.memoryId, MEMORY_REVISIONS_KEEP_PER_MEMORY]);
  }

  private createOrReviveUserMemory(input: MemoryCreateUserMemoryInput): { memory: CoworkUserMemory; created: boolean; updated: boolean } {
    let normalizedText = truncate(normalizeMemoryText(input.text), maxMemoryTextChars(input.usageClass));
    if (!normalizedText) {
      throw new Error('Memory text is required');
    }
    // Memory defense (#6): deterministic secret screening at the single write
    // chokepoint every path (turn, dream, UI, agent tool) funnels through.
    // Redact-in-place for token-shaped matches; throw for mnemonics/keys.
    normalizedText = applyMemoryDefense(normalizedText);

    const now = Date.now();
    const fingerprint = buildMemoryFingerprint(normalizedText);
    const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 0.75));
    const explicitFlag = input.isExplicit ? 1 : 0;
    const metabotId = input.metabotId;
    const scope = this.resolveMemoryScopeSelector(input);
    const classification = this.resolveMemoryClassification(normalizedText, scope, {
      usageClass: input.usageClass ?? null,
      visibility: input.visibility ?? null,
    });

    let existing: CoworkUserMemoryRow | null = null;
    if (!input.forceNew) {
      existing = this.getOne<CoworkUserMemoryRow>(`
        SELECT ${MEMORY_ROW_SELECT_COLUMNS}
        FROM user_memories
        WHERE fingerprint = ? AND status != 'deleted' AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `, [fingerprint, metabotId, scope.kind, scope.key]);

      if (!existing) {
        const incomingSemanticKey = normalizeMemorySemanticKey(normalizedText);
        if (incomingSemanticKey) {
          const candidates = this.getAll<CoworkUserMemoryRow>(`
            SELECT ${MEMORY_ROW_SELECT_COLUMNS}
            FROM user_memories
            WHERE status != 'deleted' AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
            ORDER BY updated_at DESC
            LIMIT 200
          `, [metabotId, scope.kind, scope.key]);
          let bestCandidate: CoworkUserMemoryRow | null = null;
          let bestScore = 0;
          for (const candidate of candidates) {
            const candidateSemanticKey = normalizeMemorySemanticKey(candidate.text);
            if (!candidateSemanticKey) continue;
            const score = scoreMemorySimilarity(candidateSemanticKey, incomingSemanticKey);
            if (score <= bestScore) continue;
            bestScore = score;
            bestCandidate = candidate;
          }
          if (bestCandidate && bestScore >= MEMORY_NEAR_DUPLICATE_MIN_SCORE) {
            existing = bestCandidate;
          }
        }
      }
    }

    if (existing) {
      const mergedText = choosePreferredMemoryText(existing.text, normalizedText);
      const mergedExplicit = Number(existing.is_explicit) !== 0 ? 1 : explicitFlag;
      const mergedConfidence = Math.max(Number(existing.confidence) || 0, confidence);
      const mergedClassification = this.resolveMemoryClassification(mergedText, scope, {
        usageClass: input.usageClass ?? normalizeMemoryUsageClass(existing.usage_class),
        visibility: input.visibility ?? normalizeMemoryVisibility(existing.visibility),
      });
      // Revive never lowers importance: keep the max of the stored value and
      // what the merged row would derive today.
      const mergedImportance = Math.max(
        clampMemoryImportance(existing.importance),
        input.importance !== undefined
          ? clampMemoryImportance(input.importance)
          : deriveMemoryImportance({
            usageClass: mergedClassification.usageClass,
            origin: normalizeMemoryOrigin(existing.origin),
            isExplicit: mergedExplicit === 1,
          }),
      );
      const mergedOccurredAt = existing.occurred_at != null
        ? Number(existing.occurred_at)
        : (resolveOccurredAtEpochMs(input.occurredAt) ?? null);
      // Match queries only filter status != 'deleted', so a restatement can
      // land on an archived row; revive must clear archived_at or the memory
      // stays invisible to injection and listings forever.
      this.recordMemoryRevision({
        memoryId: existing.id,
        metabotId,
        previousText: existing.text,
        newText: mergedText,
        reason: 'near_duplicate_merge',
        sourceType: input.source?.sourceType ?? null,
      });
      this.db.run(`
        UPDATE user_memories
        SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = 'created',
            usage_class = ?, visibility = ?, updated_at = ?, archived_at = NULL, importance = ?,
            occurred_at = COALESCE(occurred_at, ?)
        WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
      `, [
        mergedText,
        buildMemoryFingerprint(mergedText),
        mergedConfidence,
        mergedExplicit,
        mergedClassification.usageClass,
        mergedClassification.visibility,
        now,
        mergedImportance,
        mergedOccurredAt,
        existing.id,
        metabotId,
        scope.kind,
        scope.key,
      ]);
      this.addMemorySource(existing.id, metabotId, input.source);
      const memory = this.getOne<CoworkUserMemoryRow>(`
        SELECT ${MEMORY_ROW_SELECT_COLUMNS}
        FROM user_memories
        WHERE id = ?
      `, [existing.id]);
      if (!memory) {
        throw new Error('Failed to reload updated memory');
      }
      return { memory: this.mapMemoryRow(memory), created: false, updated: true };
    }

    const id = uuidv4();
    const origin = normalizeMemoryOrigin(input.origin);
    const importance = input.importance !== undefined
      ? clampMemoryImportance(input.importance)
      : deriveMemoryImportance({
        usageClass: classification.usageClass,
        origin,
        isExplicit: explicitFlag === 1,
      });
    this.db.run(`
      INSERT INTO user_memories (
        id, metabot_id, text, fingerprint, confidence, is_explicit, status,
        scope_kind, scope_key, usage_class, visibility, origin, created_at, updated_at, last_used_at, importance, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `, [
      id,
      metabotId,
      normalizedText,
      fingerprint,
      confidence,
      explicitFlag,
      scope.kind,
      scope.key,
      classification.usageClass,
      classification.visibility,
      origin,
      now,
      now,
      importance,
      resolveOccurredAtEpochMs(input.occurredAt),
    ]);
    this.addMemorySource(id, metabotId, input.source);

    const memory = this.getOne<CoworkUserMemoryRow>(`
      SELECT ${MEMORY_ROW_SELECT_COLUMNS}
      FROM user_memories
      WHERE id = ?
    `, [id]);
    if (!memory) {
      throw new Error('Failed to load created memory');
    }

    return { memory: this.mapMemoryRow(memory), created: true, updated: false };
  }

  listUserMemories(options: MemoryListUserMemoriesOptions): CoworkUserMemory[] {
    const metabotId = options.metabotId;
    const query = normalizeMemoryText(options.query || '');
    const includeDeleted = Boolean(options.includeDeleted);
    const status = options.status || 'all';
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const scope = this.resolveMemoryScopeSelector(options);

    const clauses: string[] = ['metabot_id = ?', 'scope_kind = ?', 'scope_key = ?'];
    const params: Array<string | number> = [metabotId, scope.kind, scope.key];

    if (!includeDeleted && status === 'all') {
      clauses.push(`status != 'deleted'`);
    }
    // Hygiene decay: archived dream memories leave injection and default
    // listings; admin/UI surfaces opt back in with includeArchived.
    if (!options.includeArchived) {
      clauses.push('archived_at IS NULL');
    }
    if (status !== 'all') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (query) {
      clauses.push('LOWER(text) LIKE ?');
      params.push(`%${query.toLowerCase()}%`);
    }
    if (options.usageClass) {
      clauses.push('usage_class = ?');
      params.push(normalizeMemoryUsageClass(options.usageClass));
    }
    if (options.origin) {
      clauses.push('origin = ?');
      params.push(normalizeMemoryOrigin(options.origin));
    }

    const whereClause = `WHERE ${clauses.join(' AND ')}`;

    // Recency = last use, else last edit: memories the bot keeps injecting
    // (touchLastUsed) must not age out of the candidate pool just because
    // their text never changes.
    const rows = this.getAll<CoworkUserMemoryRow>(`
      SELECT ${MEMORY_ROW_SELECT_COLUMNS}
      FROM user_memories
      ${whereClause}
      ORDER BY COALESCE(last_used_at, updated_at) DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const entries = rows.map((row) => this.mapMemoryRow(row));
    // Evidence ledger: one grouped count per listing (pool <= 200 rows, index
    // on (memory_id, is_active)) so recall ranking can apply the bounded proof
    // boost without a per-row query.
    const proofCounts = this.countActiveMemorySources(entries.map((entry) => entry.id));
    for (const entry of entries) {
      entry.proofCount = proofCounts.get(entry.id) ?? 0;
    }
    if (options.touchLastUsed) {
      this.touchUserMemoriesLastUsed(metabotId, entries.map((entry) => entry.id));
    }
    return entries;
  }

  private countActiveMemorySources(memoryIds: readonly string[]): Map<string, number> {
    const ids = Array.from(new Set(memoryIds.map((id) => id.trim()).filter(Boolean)));
    const counts = new Map<string, number>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const rows = this.getAll<{ memory_id: string; n: number }>(`
        SELECT memory_id, COUNT(*) AS n
        FROM user_memory_sources
        WHERE is_active = 1 AND memory_id IN (${chunk.map(() => '?').join(', ')})
        GROUP BY memory_id
      `, chunk);
      for (const row of rows) {
        counts.set(row.memory_id, Number(row.n) || 0);
      }
    }
    return counts;
  }

  touchUserMemoriesLastUsed(metabotId: number, memoryIds: string[]): void {
    const uniqueIds = Array.from(new Set(memoryIds.map((id) => id.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const now = Date.now();
    this.db.run(`
      UPDATE user_memories
      SET last_used_at = ?
      WHERE metabot_id = ?
        AND id IN (${placeholders})
    `, [now, metabotId, ...uniqueIds]);
    if ((this.db.getRowsModified?.() || 0) > 0) {
      // Injection touches fire on every turn; on the wasm backend saveDb is a
      // full-file atomic write, so debounce to one write per window. A lost
      // tail of last_used_at ticks is cosmetic (it only feeds the decay clock).
      if (now - (this.lastMemoryTouchSaveAt ?? 0) >= 10_000) {
        this.lastMemoryTouchSaveAt = now;
        this.saveDb();
      }
    }
  }

  /**
   * Dream review P1: stamp last_applied_at for memories the nightly usage
   * audit judged APPLIED (evidence-cited) in a reply. Distinct from the
   * injection touch above — this is the "was actually used" signal feeding
   * hygiene decay and prompt eviction. Debounced save like the injection touch.
   */
  touchUserMemoriesLastApplied(metabotId: number, memoryIds: string[]): number {
    const uniqueIds = Array.from(new Set(memoryIds.map((id) => id.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return 0;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const now = Date.now();
    this.db.run(`
      UPDATE user_memories
      SET last_applied_at = ?
      WHERE metabot_id = ?
        AND id IN (${placeholders})
    `, [now, metabotId, ...uniqueIds]);
    const changed = this.db.getRowsModified?.() || 0;
    if (changed > 0 && now - (this.lastMemoryTouchSaveAt ?? 0) >= 10_000) {
      this.lastMemoryTouchSaveAt = now;
      this.saveDb();
    }
    return changed;
  }

  createUserMemory(input: MemoryCreateUserMemoryInput): CoworkUserMemory {
    const result = this.createOrReviveUserMemory(input);
    this.saveDb();
    return result.memory;
  }

  /**
   * Dream-only creation with cross-night semantic dedup (memory/persona audit
   * P1). The dream pipeline wrote every entry with forceNew — "authoritative
   * per-date batches" — so the SAME rule kept coming back night after night
   * with fresh wording and piled up as near-duplicate rows (~12-15% of all
   * active memories in production), diluting the injection budget and
   * bloating the belief layer. This entry point first scans the bot's ACTIVE
   * memories of the same scope and usage class for a semantic match, using
   * the same normalizeMemorySemanticKey + scoreMemorySimilarity pair the
   * revive path uses (CJK-safe: character-bigram Dice plus word-level token
   * overlap), at the dream-specific DREAM_CROSS_NIGHT_DEDUP_MIN_SCORE bar.
   * On a hit the old row is REFRESHED instead of inserting a new one:
   *   - updated_at = now — corroboration keeps the row inside the
   *     recency-ordered candidate pools instead of aging out of them;
   *   - importance = MAX(stored, what the incoming write would derive) — a
   *     corroborated rule never loses standing;
   *   - the producing night is appended to user_memory_sources (one
   *     provenance row per night, same as a fresh write would add);
   *   - text: the stored wording wins by default (a stable row keeps the
   *     prompt surface stable); it is replaced only when the incoming text
   *     is materially richer (>=30% longer), which also re-derives the
   *     fingerprint. confidence / is_explicit / origin stay as stored.
   * Same-day batch semantics are untouched: softDeleteDreamMemoriesForDate
   * runs before the night's writes, so just-deleted same-date rows are
   * invisible to this scan (status != 'created'); a re-dreamed day still
   * rewrites its own batch. Archived rows are deliberately NOT match
   * targets — bringing those back stays with the revive path. On a miss the
   * write falls through to the legacy forceNew insert.
   */
  createDreamUserMemory(input: MemoryCreateUserMemoryInput): { memory: CoworkUserMemory; merged: boolean } | null {
    let normalizedText = truncate(normalizeMemoryText(input.text), maxMemoryTextChars(input.usageClass));
    if (!normalizedText) {
      throw new Error('Memory text is required');
    }
    try {
      normalizedText = applyMemoryDefense(normalizedText);
    } catch (error) {
      if (error instanceof MemoryDefenseError) {
        console.warn('[MemoryDefense] dropped a dream memory write (secret detected)');
        return null;
      }
      throw error;
    }
    const metabotId = input.metabotId;
    const scope = this.resolveMemoryScopeSelector(input);
    const usageClass = input.usageClass ?? null;
    const incomingKey = normalizeMemorySemanticKey(normalizedText);
    if (incomingKey && usageClass) {
      const candidates = this.getAll<CoworkUserMemoryRow>(`
        SELECT ${MEMORY_ROW_SELECT_COLUMNS}
        FROM user_memories
        WHERE metabot_id = ? AND scope_kind = ? AND scope_key = ?
          AND usage_class = ? AND status = 'created' AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 200
      `, [metabotId, scope.kind, scope.key, usageClass]);
      let bestCandidate: CoworkUserMemoryRow | null = null;
      let bestScore = 0;
      for (const candidate of candidates) {
        const candidateKey = normalizeMemorySemanticKey(candidate.text);
        if (!candidateKey) continue;
        const score = scoreMemorySimilarity(candidateKey, incomingKey);
        if (score <= bestScore) continue;
        bestScore = score;
        bestCandidate = candidate;
      }
      if (bestCandidate && bestScore >= DREAM_CROSS_NIGHT_DEDUP_MIN_SCORE) {
        const mergedText = normalizedText.length >= Math.ceil(bestCandidate.text.length * DREAM_DEDUP_REPLACE_TEXT_MIN_LENGTH_RATIO)
          ? normalizedText
          : bestCandidate.text;
        const mergedImportance = Math.max(
          clampMemoryImportance(bestCandidate.importance),
          input.importance !== undefined
            ? clampMemoryImportance(input.importance)
            : deriveMemoryImportance({
              usageClass,
              origin: 'dream',
              isExplicit: input.isExplicit === true,
            }),
        );
        this.recordMemoryRevision({
          memoryId: bestCandidate.id,
          metabotId,
          previousText: bestCandidate.text,
          newText: mergedText,
          reason: 'dream_cross_night_merge',
          sourceType: input.source?.sourceType ?? 'dream',
        });
        this.db.run(`
          UPDATE user_memories
          SET text = ?, fingerprint = ?, updated_at = ?, importance = ?,
              occurred_at = COALESCE(occurred_at, ?)
          WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
        `, [
          mergedText,
          buildMemoryFingerprint(mergedText),
          Date.now(),
          mergedImportance,
          resolveOccurredAtEpochMs(input.occurredAt),
          bestCandidate.id,
          metabotId,
          scope.kind,
          scope.key,
        ]);
        this.addMemorySource(bestCandidate.id, metabotId, input.source);
        this.saveDb();
        const memory = this.getOne<CoworkUserMemoryRow>(`
          SELECT ${MEMORY_ROW_SELECT_COLUMNS}
          FROM user_memories
          WHERE id = ?
        `, [bestCandidate.id]);
        if (!memory) {
          throw new Error('Failed to reload merged dream memory');
        }
        return { memory: this.mapMemoryRow(memory), merged: true };
      }
    }
    const created = this.createOrReviveUserMemory({ ...input, forceNew: true });
    this.saveDb();
    return { memory: created.memory, merged: false };
  }

  /**
   * Insert capability-learning candidates from a dream run into
   * `capability_drafts` (L3b procedural-memory drafts, SDD §4.1). Every row is
   * written with status 'draft'; the dream-time validation pass later promotes
   * them to 'validated' or demotes them to 'rejected'. This method never
   * touches the skill tables (R4.3 — no pollution).
   * Invalid entries (empty title/description) are skipped. Returns the number
   * of rows inserted.
   */
  insertCapabilityDrafts(
    metabotId: number,
    dreamDate: string,
    learnings: Array<{
      title?: string | null;
      description?: string | null;
      capabilityType?: string | null;
    }>,
  ): number {
    const now = Date.now();
    let inserted = 0;
    for (const learning of Array.isArray(learnings) ? learnings : []) {
      const title = String(learning?.title ?? '').trim();
      const description = String(learning?.description ?? '').trim();
      const capabilityType = String(learning?.capabilityType ?? 'skill').trim() || 'skill';
      if (!title || !description || !Number.isInteger(metabotId) || metabotId <= 0) {
        continue;
      }
      this.db.run(`
        INSERT INTO capability_drafts (
          metabot_id, dream_date, title, description, capability_type, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, 'draft', ?)
      `, [metabotId, dreamDate, title, description, capabilityType, now]);
      inserted += 1;
    }
    if (inserted > 0) {
      this.saveDb();
    }
    return inserted;
  }

  /**
   * Record (or re-falsify) one hypothesis in the falsified ledger (RRSI P1,
   * design §6.1 P1.3). Rows are keyed by (bot, normalized title key); an
   * upsert refreshes title/description/reason/source/timestamp but keeps
   * hit_count. Returns null for an unusable title (empty or keyless).
   */
  recordFalsifiedHypothesis(input: {
    metabotId: number;
    title: string;
    description: string;
    reason: string;
    source: CapabilityFalsifiedSource;
    sourceDraftId: number | null;
    falsifiedAt?: number;
  }): CapabilityFalsifiedHypothesis | null {
    const title = String(input?.title ?? '').trim();
    const titleKey = hypothesisTitleKey(title);
    if (!title || !titleKey || !Number.isInteger(input.metabotId) || input.metabotId <= 0) {
      return null;
    }
    const description = String(input?.description ?? '').slice(0, 600);
    const reason = String(input?.reason ?? '').slice(0, 300);
    const source: CapabilityFalsifiedSource = input.source === 're_review' ? 're_review' : 'validation';
    const sourceDraftId = Number.isInteger(input?.sourceDraftId) ? Number(input.sourceDraftId) : null;
    const falsifiedAt = Number.isFinite(input?.falsifiedAt) ? Number(input.falsifiedAt) : Date.now();
    this.db.run(`
      INSERT INTO capability_falsified_hypotheses (
        metabot_id, title, title_key, description, reason, source, source_draft_id, falsified_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id, title_key) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        reason = excluded.reason,
        source = excluded.source,
        source_draft_id = excluded.source_draft_id,
        falsified_at = excluded.falsified_at
    `, [input.metabotId, title, titleKey, description, reason, source, sourceDraftId, falsifiedAt]);
    this.saveDb();
    return this.listFalsifiedHypotheses(input.metabotId, { limit: 500 })
      .find((row) => row.titleKey === titleKey) ?? null;
  }

  /**
   * Read the bot's falsified-hypothesis ledger, newest falsification first.
   */
  listFalsifiedHypotheses(
    metabotId: number,
    options?: { sinceMs?: number; limit?: number },
  ): CapabilityFalsifiedHypothesis[] {
    const where: string[] = ['metabot_id = ?'];
    const params: Array<string | number> = [metabotId];
    if (typeof options?.sinceMs === 'number' && Number.isFinite(options.sinceMs)) {
      where.push('falsified_at >= ?');
      params.push(Math.floor(options.sinceMs));
    }
    const limit = Number.isInteger(options?.limit)
      ? Math.min(500, Math.max(1, Math.floor(options!.limit!)))
      : 200;
    const rows = this.getAll<CapabilityFalsifiedRow>(`
      SELECT id, metabot_id, title, title_key, description, reason, source, source_draft_id,
             falsified_at, hit_count, last_hit_at
      FROM capability_falsified_hypotheses
      WHERE ${where.join(' AND ')}
      ORDER BY falsified_at DESC, id DESC
      LIMIT ${limit}
    `, params);
    return rows.map((row) => this.mapFalsifiedRow(row));
  }

  /** Bump the ledger row's hit counter — a blocked re-proposal was observed. */
  markFalsifiedHypothesisHit(id: number, atMs: number = Date.now()): boolean {
    if (!Number.isInteger(id) || id <= 0) return false;
    this.db.run(
      'UPDATE capability_falsified_hypotheses SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?',
      [Math.floor(Number.isFinite(atMs) ? atMs : Date.now()), id],
    );
    const bumped = this.db.getRowsModified?.() || 0;
    if (bumped > 0) {
      this.saveDb();
    }
    return bumped > 0;
  }

  /**
   * Retention stroke for the falsified ledger (RRSI P1): delete rows
   * falsified before `cutoffMs`, then cap every included bot at `maxPerBot`
   * newest rows. Bots in `excludeMetabotIds` (hygiene opt-out) are untouched.
   */
  purgeFalsifiedHypotheses(input: {
    cutoffMs: number;
    maxPerBot: number;
    excludeMetabotIds?: ReadonlySet<number>;
  }): number {
    const cutoffMs = Math.floor(Number.isFinite(input?.cutoffMs) ? input.cutoffMs : 0);
    const maxPerBot = Math.max(0, Math.floor(Number(input?.maxPerBot) || 0));
    const exclude = input?.excludeMetabotIds instanceof Set ? [...input.excludeMetabotIds] : [];
    const exclusion = exclude.length > 0
      ? ` AND metabot_id NOT IN (${exclude.map(() => '?').join(', ')})`
      : '';
    let deleted = 0;
    this.db.run(
      `DELETE FROM capability_falsified_hypotheses WHERE falsified_at < ?${exclusion}`,
      [cutoffMs, ...exclude],
    );
    deleted += this.db.getRowsModified?.() || 0;
    if (maxPerBot > 0) {
      const botRows = this.getAll<{ metabot_id: number | string }>(
        'SELECT DISTINCT metabot_id FROM capability_falsified_hypotheses',
        [],
      );
      const excludedSet = new Set(exclude);
      for (const { metabot_id } of botRows) {
        const metabotId = Number(metabot_id);
        if (excludedSet.has(metabotId)) continue;
        this.db.run(
          `DELETE FROM capability_falsified_hypotheses
           WHERE metabot_id = ? AND id NOT IN (
             SELECT id FROM capability_falsified_hypotheses
             WHERE metabot_id = ?
             ORDER BY falsified_at DESC, id DESC
             LIMIT ${maxPerBot}
           )`,
          [metabotId, metabotId],
        );
        deleted += this.db.getRowsModified?.() || 0;
      }
    }
    if (deleted > 0) {
      this.saveDb();
    }
    return deleted;
  }

  /**
   * Checked capability-draft insert (RRSI P1): same entry validation as
   * insertCapabilityDrafts, plus two pre-insert skips — a title key already
   * live in a draft / validated / disputed row of this bot (also stops
   * version-repair runs from duplicating), and a title key falsified within
   * FALSIFIED_BLOCK_DAYS (bumps the ledger row's hit counter). A batch cannot
   * insert the same key twice.
   */
  insertCapabilityDraftsChecked(
    metabotId: number,
    dreamDate: string,
    learnings: Array<{
      title?: string | null;
      description?: string | null;
      capabilityType?: string | null;
      /** Distillation provenance (dream review P0); NULL/omitted = dream output. */
      origin?: string | null;
    }>,
    options?: { nowMs?: number },
  ): CapabilityDraftInsertResult {
    const nowMs = Number.isFinite(options?.nowMs) ? Math.floor(options!.nowMs!) : Date.now();
    const result: CapabilityDraftInsertResult = {
      inserted: 0,
      insertedIds: [],
      skippedDuplicate: 0,
      skippedFalsified: 0,
    };
    if (!Number.isInteger(metabotId) || metabotId <= 0) return result;
    const liveKeys = new Set<string>();
    for (const draft of this.listCapabilityDrafts(metabotId)) {
      if (draft.status === 'draft' || draft.status === 'validated' || draft.status === 'disputed') {
        const key = hypothesisTitleKey(draft.title);
        if (key) liveKeys.add(key);
      }
    }
    const ledgerByKey = new Map<string, CapabilityFalsifiedHypothesis>();
    for (const row of this.listFalsifiedHypotheses(metabotId, {
      sinceMs: nowMs - FALSIFIED_BLOCK_DAYS * 86_400_000,
      limit: 500,
    })) {
      ledgerByKey.set(row.titleKey, row);
    }
    let changed = false;
    for (const learning of Array.isArray(learnings) ? learnings : []) {
      const title = String(learning?.title ?? '').trim();
      const description = String(learning?.description ?? '').trim();
      const capabilityType = String(learning?.capabilityType ?? 'skill').trim() || 'skill';
      if (!title || !description) continue;
      const key = hypothesisTitleKey(title);
      if (!key) continue;
      if (liveKeys.has(key)) {
        result.skippedDuplicate += 1;
        continue;
      }
      const falsified = ledgerByKey.get(key);
      if (falsified) {
        this.markFalsifiedHypothesisHit(falsified.id, nowMs);
        result.skippedFalsified += 1;
        changed = true;
        continue;
      }
      this.db.run(`
        INSERT INTO capability_drafts (
          metabot_id, dream_date, title, description, capability_type, status, created_at, origin
        )
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
      `, [metabotId, dreamDate, title, description, capabilityType, nowMs, learning.origin?.trim() || null]);
      const newId = Number(this.getOne<{ id: number | string }>('SELECT last_insert_rowid() AS id', [])?.id);
      result.inserted += 1;
      result.insertedIds.push(newId);
      liveKeys.add(key);
      changed = true;
    }
    if (changed) {
      this.saveDb();
    }
    return result;
  }

  private mapFalsifiedRow(row: CapabilityFalsifiedRow): CapabilityFalsifiedHypothesis {
    return {
      id: Number(row.id),
      metabotId: Number(row.metabot_id),
      title: String(row.title),
      titleKey: String(row.title_key),
      description: String(row.description ?? ''),
      reason: String(row.reason ?? ''),
      source: row.source === 're_review' ? 're_review' : 'validation',
      sourceDraftId: row.source_draft_id == null ? null : Number(row.source_draft_id),
      falsifiedAt: Number(row.falsified_at),
      hitCount: Math.max(0, Math.floor(Number(row.hit_count) || 0)),
      lastHitAt: row.last_hit_at == null ? null : Number(row.last_hit_at),
    };
  }

  /**
   * Read capability drafts, newest first; scoped to one MetaBot when
   * `metabotId` is given, and optionally filtered by status (e.g. 'draft'
   * pending validation, 'validated' for prompt injection).
   */
  listCapabilityDrafts(
    metabotId?: number,
    options?: { status?: string; limit?: number },
  ): CapabilityDraft[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (metabotId !== undefined && Number.isInteger(metabotId)) {
      where.push('metabot_id = ?');
      params.push(metabotId);
    }
    if (typeof options?.status === 'string' && options.status.trim()) {
      where.push('status = ?');
      params.push(options.status.trim());
    }
    const limit = Number.isInteger(options?.limit) && (options?.limit ?? 0) > 0
      ? Math.floor(options!.limit!)
      : null;
    const sql = `
      SELECT ${CAPABILITY_DRAFT_COLUMNS}
      FROM capability_drafts
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      ${limit != null ? `LIMIT ${limit}` : ''}
    `;
    const rows = this.getAll<CapabilityDraftRow>(sql, params);
    return rows.map((row) => this.mapCapabilityDraftRow(row));
  }

  /**
   * RRSI P2 single injection path (design §6.2 P2.3): validated drafts that
   * were NEVER promoted — the only drafts allowed into
   * <proven_techniques>. A promoted draft hardened into procedure memory and
   * must not also ride the technique block (double injection).
   * RRSI P3 utility ordering (design §6.3 P3.2): the roster is ranked by
   * applied nights in the trailing 30 days, then recency, with one slot
   * reserved for a newcomer still inside the 14-day grace period.
   */
  listInjectableTechniques(metabotId: number, limit: number = 5, options?: { nowMs?: number }): CapabilityDraft[] {
    const id = Number(metabotId);
    if (!Number.isInteger(id) || id <= 0) return [];
    const clampedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 5));
    const rows = this.getAll<CapabilityDraftRow>(`
      SELECT ${CAPABILITY_DRAFT_COLUMNS}
      FROM capability_drafts
      WHERE metabot_id = ? AND status = 'validated' AND promoted_at IS NULL
        AND COALESCE(scope, 'general') != 'situational'
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `, [id]);
    if (rows.length === 0) return [];
    const drafts = rows.map((row) => this.mapCapabilityDraftRow(row));
    const nowMs = options?.nowMs ?? Date.now();
    const today = formatBotWorkspaceDate(new Date(nowMs));
    const stats = queryHotLayerUsageStats(this.db, {
      metabotId: id,
      kind: 'technique',
      sinceDate: shiftDateKey(today, -(HOT_LAYER_UTILITY_WINDOW_DAYS - 1)),
      untilDate: today,
      itemIds: drafts.map((draft) => String(draft.id)),
    });
    return rankHotLayerItems(
      drafts.map((draft) => ({
        draft,
        key: String(draft.id),
        kind: 'technique' as const,
        hotSinceMs: draft.validatedAt ?? draft.createdAt,
        appliedNights: stats.get(String(draft.id))?.appliedNights ?? 0,
        exposedNights: stats.get(String(draft.id))?.exposedNights ?? 0,
      })),
      { cap: clampedLimit, nowMs, freshSlots: HOT_LAYER_FRESH_SLOTS, graceDays: HOT_LAYER_GRACE_DAYS },
    ).map((candidate) => candidate.draft);
  }

  /**
   * RRSI P3 L1 demotion (design §6.3 P3.3): a validated, never-promoted draft
   * that kept being shown but never applied moves to 'dormant' — kept as
   * history, never injected / re-reviewed / promoted / purged; a later dream
   * re-proposal of the same title is a new draft. The note appends to the
   * existing validation notes (capped). Returns whether a row changed.
   */
  markCapabilityDraftDormant(input: { id: number; metabotId: number; atMs: number; note: string }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    const atMs = Math.floor(Number(input.atMs));
    const note = String(input.note ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0
      || !Number.isFinite(atMs) || !note) {
      return false;
    }
    const existing = this.getOne<{ validation_notes: string | null }>(
      `SELECT validation_notes FROM capability_drafts
       WHERE id = ? AND metabot_id = ? AND status = 'validated' AND promoted_at IS NULL
       LIMIT 1`,
      [id, metabotId],
    );
    if (!existing) return false;
    const currentNotes = existing.validation_notes == null ? '' : String(existing.validation_notes);
    const notes = truncateUtf16Units(currentNotes ? `${currentNotes} — ${note}` : note, 1000);
    this.db.run(
      `UPDATE capability_drafts
       SET status = 'dormant', dormant_at = ?, validation_notes = ?
       WHERE id = ? AND metabot_id = ? AND status = 'validated' AND promoted_at IS NULL`,
      [atMs, notes, id, metabotId],
    );
    const changed = (this.db.getRowsModified?.() || 0) > 0;
    if (changed) {
      this.saveDb();
    }
    return changed;
  }

  private mapCapabilityDraftRow(row: CapabilityDraftRow): CapabilityDraft {
    return {
      id: Number(row.id),
      metabotId: Number(row.metabot_id),
      dreamDate: String(row.dream_date),
      title: String(row.title),
      description: String(row.description),
      capabilityType: String(row.capability_type),
      status: String(row.status),
      createdAt: Number(row.created_at),
      validationScore: row.validation_score == null ? null : Number(row.validation_score),
      validationNotes: row.validation_notes == null ? null : String(row.validation_notes),
      validatedAt: row.validated_at == null ? null : Number(row.validated_at),
      timesInjected: Math.max(0, Math.floor(Number(row.times_injected) || 0)),
      lastInjectedAt: row.last_injected_at == null ? null : Number(row.last_injected_at),
      promotedAt: row.promoted_at == null ? null : Number(row.promoted_at),
      promotedProcedureId: row.promoted_procedure_id == null ? null : String(row.promoted_procedure_id),
      lastReviewedAt: row.last_reviewed_at == null ? null : Number(row.last_reviewed_at),
      conditionsText: row.conditions_text == null ? null : String(row.conditions_text),
      uncertaintyText: row.uncertainty_text == null ? null : String(row.uncertainty_text),
      sourceProcedureId: row.source_procedure_id == null ? null : String(row.source_procedure_id),
      dormantAt: row.dormant_at == null ? null : Number(row.dormant_at),
      scope: normalizeCapabilityScope(row.scope),
      origin: row.origin == null ? null : String(row.origin),
    };
  }

  /**
   * RRSI P3: one capability draft by id, through the shared column list and
   * mapper. Null when the row does not exist or belongs to another bot.
   */
  getCapabilityDraft(metabotId: number, id: number): CapabilityDraft | null {
    const botId = Number(metabotId);
    const draftId = Number(id);
    if (!Number.isInteger(botId) || botId <= 0 || !Number.isInteger(draftId) || draftId <= 0) return null;
    const row = this.getOne<CapabilityDraftRow>(
      `SELECT ${CAPABILITY_DRAFT_COLUMNS}
       FROM capability_drafts
       WHERE id = ? AND metabot_id = ?
       LIMIT 1`,
      [draftId, botId],
    );
    return row ? this.mapCapabilityDraftRow(row) : null;
  }

  /**
   * Open (or refresh) the probation ticket for a runtime-saved procedure
   * (RRSI P2, design §6.2 P2.2): one capability_drafts row per procedure that
   * the existing dream validation gate judges. A pending ticket (draft /
   * disputed) is refreshed in place — title and description follow the
   * procedure's latest revision while dream_date, created_at and status stay
   * (the gate calendar keeps counting from the first save). A VALIDATED but
   * not-yet-promoted ticket is also reopened in place: the procedure body the
   * verdict approved is gone, so the verdict is wiped (status back to
   * 'draft', score/notes/validated_at cleared, dream_date re-anchored) and
   * the gate re-judges the revision before any promotion can harden it.
   * Deliberately bypasses the falsified-ledger block of
   * insertCapabilityDraftsChecked: an explicit agent save is never silently
   * dropped; the gate still sees the similar-falsified prompt line. Returns
   * null on invalid input.
   */
  ensureProbationDraftForProcedure(input: {
    metabotId: number;
    procedureId: string;
    title: string;
    description: string;
    dreamDate: string;
  }): { draftId: number; created: boolean } | null {
    const metabotId = Number(input.metabotId);
    const procedureId = String(input.procedureId ?? '').trim();
    const title = String(input.title ?? '').trim();
    const description = String(input.description ?? '').trim();
    const dreamDate = String(input.dreamDate ?? '').trim();
    if (!Number.isInteger(metabotId) || metabotId <= 0 || !procedureId || !title || !description || !dreamDate) {
      return null;
    }
    const existing = this.getOne<{ id: number | string }>(
      `SELECT id FROM capability_drafts
       WHERE metabot_id = ? AND source_procedure_id = ? AND status IN ('draft', 'disputed')
       ORDER BY id DESC LIMIT 1`,
      [metabotId, procedureId],
    );
    if (existing) {
      this.db.run(
        `UPDATE capability_drafts SET title = ?, description = ? WHERE id = ? AND metabot_id = ?`,
        [title, description, Number(existing.id), metabotId],
      );
      this.saveDb();
      return { draftId: Number(existing.id), created: false };
    }
    // A validated-but-unpromoted ticket whose procedure was revised since the
    // verdict: reopen it instead of leaving a stale approval in the promotion
    // queue.
    const validated = this.getOne<{ id: number | string }>(
      `SELECT id FROM capability_drafts
       WHERE metabot_id = ? AND source_procedure_id = ? AND status = 'validated' AND promoted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [metabotId, procedureId],
    );
    if (validated) {
      this.db.run(
        `UPDATE capability_drafts
         SET title = ?, description = ?, dream_date = ?, status = 'draft',
             validation_score = NULL, validation_notes = NULL, validated_at = NULL
         WHERE id = ? AND metabot_id = ?`,
        [title, description, dreamDate, Number(validated.id), metabotId],
      );
      this.saveDb();
      return { draftId: Number(validated.id), created: false };
    }
    const now = Date.now();
    this.db.run(
      `INSERT INTO capability_drafts (
         metabot_id, dream_date, title, description, capability_type, status,
         created_at, source_procedure_id
       ) VALUES (?, ?, ?, ?, 'workflow', 'draft', ?, ?)`,
      [metabotId, dreamDate, title, description, now, procedureId],
    );
    this.saveDb();
    const newId = Number(this.getOne<{ id: number | string }>('SELECT last_insert_rowid() AS id', [])?.id);
    return { draftId: newId, created: true };
  }

  /**
   * P2 utilization telemetry (Dream-RSI): bump times_injected / last_injected_at
   * for the drafts an injection path actually rendered into a
   * `<proven_techniques>` prompt block — the same times_injected pattern as
   * team_culture_entries. Returns the number of rows bumped.
   */
  markCapabilityDraftsInjected(ids: number[]): number {
    const uniqueIds = Array.from(
      new Set((ids ?? []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)),
    );
    if (uniqueIds.length === 0) return 0;
    const now = Date.now();
    const placeholders = uniqueIds.map(() => '?').join(', ');
    this.db.run(
      `UPDATE capability_drafts
       SET times_injected = times_injected + 1, last_injected_at = ?
       WHERE id IN (${placeholders})`,
      [now, ...uniqueIds],
    );
    const bumped = this.db.getRowsModified?.() || 0;
    if (bumped > 0) {
      this.saveDb();
    }
    // RRSI P2 exposure ledger: today's hot technique exposures for exactly
    // the injected drafts. Dream review P3: rides the same write-behind
    // buffer as recordHotLayerExposures (the old INSERT … SELECT ran one
    // synchronous write per injection). Best-effort telemetry — a failure
    // never undoes the counter bump above.
    try {
      const injectedRows = this.getAll<{ metabot_id: number | string; id: number | string }>(
        `SELECT metabot_id, id FROM capability_drafts WHERE id IN (${placeholders})`,
        [...uniqueIds],
      );
      const usageDate = formatBotWorkspaceDate(new Date(now));
      for (const row of injectedRows) {
        const metabotId = Number(row.metabot_id);
        const id = String(row.id);
        const key = `${metabotId}|${usageDate}|technique|${id}`;
        const existing = this.hotLayerExposureBuffer.get(key);
        if (existing) {
          existing.count += 1;
          existing.exposure = 'hot';
        } else {
          this.hotLayerExposureBuffer.set(key, {
            metabotId,
            usageDate,
            kind: 'technique',
            id,
            exposure: 'hot',
            count: 1,
            firstExposedAt: now,
          });
        }
      }
      if (injectedRows.length > 0) {
        this.ensureHotLayerExposureFlushTimer();
        if (this.hotLayerExposureBuffer.size >= 200) {
          this.flushHotLayerExposureBuffer();
        }
        // Review nit: no saveDb here — the exposure rows ride the write-behind
        // flush (≤5s), and the times_injected counter bump is telemetry whose
        // tail can ride the next save (same debounce rationale as the culture
        // usage counters).
      }
    } catch (error) {
      console.warn('[CoworkStore] hot_layer_usage technique exposure write failed:', error);
    }
    return bumped;
  }

  /**
   * RRSI P2 exposure ledger (design §6.2 P2.4), write-behind since the dream
   * review P3 batching: items coalesce into an in-process buffer and flush on
   * a ≤5s timer, at 200 buffered keys, or via flushHotLayerExposureBuffer().
   * Within a day, 'hot' is sticky — an item that was injected hot and later
   * recalled still counts as hot. Best-effort telemetry: invalid items are
   * dropped, buffering throws only on a genuinely broken database, and the
   * return value is the number of items ACCEPTED (not yet written).
   */
  recordHotLayerExposures(input: {
    metabotId: number;
    usageDate: string;
    items: Array<{ kind: HotLayerItemKind; id: string; exposure: HotLayerExposure }>;
    atMs?: number;
  }): number {
    const metabotId = Number(input.metabotId);
    const usageDate = String(input.usageDate ?? '').trim();
    if (!Number.isInteger(metabotId) || metabotId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) return 0;
    const atMs = Math.floor(Number(input.atMs ?? Date.now())) || Date.now();
    const items = (input.items ?? []).filter((item) =>
      (item.kind === 'technique' || item.kind === 'procedure' || item.kind === 'knowledge' || item.kind === 'memory')
      && typeof item.id === 'string' && item.id.trim().length > 0
      && (item.exposure === 'hot' || item.exposure === 'recall'));
    if (items.length === 0) return 0;
    // Dream review P3: buffer instead of per-item synchronous writes. The
    // UPSERT semantics are preserved at flush time (count accumulation,
    // 'hot' sticky). Same-day repeats coalesce into one row per key.
    for (const item of items) {
      const key = `${metabotId}|${usageDate}|${item.kind}|${item.id}`;
      const existing = this.hotLayerExposureBuffer.get(key);
      if (existing) {
        existing.count += 1;
        if (item.exposure === 'hot') existing.exposure = 'hot';
      } else {
        this.hotLayerExposureBuffer.set(key, {
          metabotId,
          usageDate,
          kind: item.kind,
          id: item.id,
          exposure: item.exposure,
          count: 1,
          firstExposedAt: atMs,
        });
      }
    }
    this.ensureHotLayerExposureFlushTimer();
    if (this.hotLayerExposureBuffer.size >= 200) {
      this.flushHotLayerExposureBuffer();
    }
    return items.length;
  }

  /** Lazily-arm the ≤5s flush timer (unref'd so it never holds the process). */
  private ensureHotLayerExposureFlushTimer(): void {
    if (this.hotLayerExposureFlushTimer) return;
    this.hotLayerExposureFlushTimer = setInterval(() => {
      try {
        this.flushHotLayerExposureBuffer();
      } catch (error) {
        // Review Minor 2: the failure warning is throttled by the drain-stop
        // below — a broken database warns once per failed window, not every
        // 5s forever.
        console.warn('[CoworkStore] hot-layer exposure flush failed:', error);
      }
      // Review Minor 2: stop the timer when the buffer drains — an idle
      // store must not wake every 5s for the rest of the process lifetime.
      // The next recordHotLayerExposures call re-arms it on demand.
      if (this.hotLayerExposureBuffer.size === 0 && this.hotLayerExposureFlushTimer) {
        clearInterval(this.hotLayerExposureFlushTimer);
        this.hotLayerExposureFlushTimer = null;
      }
    }, 5_000);
    (this.hotLayerExposureFlushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Dream review P3: drain the exposure buffer into hot_layer_usage with the
   * same UPSERT semantics as the old synchronous path (exposure_count
   * accumulation, 'hot' sticky within a day). Called by the ≤5s timer, the
   * 200-key burst cap, and the app-shutdown cleanup; safe to call when the
   * buffer is empty. Returns rows written.
   */
  flushHotLayerExposureBuffer(): number {
    if (this.hotLayerExposureBuffer.size === 0) return 0;
    const rows = [...this.hotLayerExposureBuffer.values()];
    // Review Minor 2: snapshot-and-clear BEFORE writing; on failure the rows
    // go back (merged with anything recorded while we wrote) instead of the
    // whole window being lost or double-counted.
    this.hotLayerExposureBuffer.clear();
    try {
      let written = 0;
      for (const row of rows) {
        this.db.run(
          `INSERT INTO hot_layer_usage (metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(metabot_id, usage_date, item_kind, item_id) DO UPDATE SET
             exposure_count = exposure_count + excluded.exposure_count,
             exposure = CASE WHEN hot_layer_usage.exposure = 'hot' OR excluded.exposure = 'hot' THEN 'hot' ELSE 'recall' END`,
          [row.metabotId, row.usageDate, row.kind, row.id, row.exposure, row.firstExposedAt, row.count],
        );
        written += 1;
      }
      this.saveDb();
      return written;
    } catch (error) {
      for (const row of rows) {
        const key = `${row.metabotId}|${row.usageDate}|${row.kind}|${row.id}`;
        const existing = this.hotLayerExposureBuffer.get(key);
        if (existing) {
          existing.count += row.count;
          if (row.exposure === 'hot') existing.exposure = 'hot';
        } else {
          this.hotLayerExposureBuffer.set(key, row);
        }
      }
      throw error;
    }
  }

  /** Retention horizon for hot_layer_usage rows (hygiene step, RRSI P2). */
  purgeHotLayerUsage(input: { cutoffDate: string; excludeMetabotIds?: ReadonlySet<number> }): number {
    const cutoff = String(input.cutoffDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) return 0;
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const exclusion = excluded.length > 0
      ? ` AND metabot_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    this.db.run(`DELETE FROM hot_layer_usage WHERE usage_date < ?${exclusion}`, [cutoff, ...excluded]);
    const deleted = this.db.getRowsModified?.() || 0;
    if (deleted > 0) {
      this.saveDb();
    }
    return deleted;
  }

  /** How many hot-layer items were exposed to this bot on one local day. */
  countHotLayerExposures(metabotId: number, usageDate: string): number {
    const id = Number(metabotId);
    const date = String(usageDate ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
    const row = this.getOne<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM hot_layer_usage WHERE metabot_id = ? AND usage_date = ?',
      [id, date],
    );
    return Math.max(0, Math.floor(Number(row?.count) || 0));
  }

  /**
   * Utilization rollup for the nightly dream telemetry: how many validated
   * drafts the bot has, their cumulative injection count, and how many were
   * injected at least once since `activeSinceMs` (the dream service passes
   * now-24h, i.e. drafts that were actually in play that day).
   */
  getCapabilityDraftUtilization(
    metabotId: number,
    activeSinceMs: number,
  ): { validatedDrafts: number; totalInjections: number; activeDraftsLast24h: number } {
    const row = this.getOne<{
      validated_count: number | string;
      total_injections: number | string | null;
      active_count: number | string | null;
    }>(`
      SELECT COUNT(*) AS validated_count,
             COALESCE(SUM(times_injected), 0) AS total_injections,
             COALESCE(SUM(CASE WHEN last_injected_at >= ? THEN 1 ELSE 0 END), 0) AS active_count
      FROM capability_drafts
      WHERE metabot_id = ? AND status = 'validated'
    `, [Math.floor(Number(activeSinceMs) || 0), metabotId]);
    return {
      validatedDrafts: Number(row?.validated_count) || 0,
      totalInjections: Number(row?.total_injections) || 0,
      activeDraftsLast24h: Number(row?.active_count) || 0,
    };
  }

  /**
   * Candidates for the nightly promotion pass (Dream-RSI P2): validated drafts
   * at/above `minScore` whose verdict is OLDER than `validatedBeforeMs` (the
   * dream date's day start — the pragmatic stand-in for the full P1 re-review:
   * a draft must survive at least one night of calendar distance before it
   * hardens into procedure memory) and that were never promoted. Strongest
   * score first, ties broken toward the oldest verdict.
   */
  listPromotableCapabilityDrafts(
    metabotId: number,
    options: { minScore: number; validatedBeforeMs: number; limit: number },
  ): CapabilityDraft[] {
    const limit = Math.max(1, Math.floor(options.limit));
    const rows = this.getAll<CapabilityDraftRow>(`
      SELECT ${CAPABILITY_DRAFT_COLUMNS}
      FROM capability_drafts
      WHERE metabot_id = ?
        AND status = 'validated'
        AND validation_score >= ?
        AND validated_at IS NOT NULL
        AND validated_at < ?
        AND promoted_at IS NULL
      ORDER BY validation_score DESC, validated_at ASC, id ASC
      LIMIT ?
    `, [metabotId, Number(options.minScore) || 0, Math.floor(Number(options.validatedBeforeMs) || 0), limit]);
    return rows.map((row) => this.mapCapabilityDraftRow(row));
  }

  /**
   * Back-fill the promotion link after a draft was written into procedure
   * memory. The `promoted_at IS NULL` guard makes a re-run of the same nightly
   * pass a no-op (idempotent); returns false when the row was already promoted
   * (or does not belong to the bot).
   */
  markCapabilityDraftPromoted(input: { id: number; metabotId: number; procedureId: string }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    const procedureId = String(input.procedureId ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0 || !procedureId) {
      return false;
    }
    this.db.run(
      `UPDATE capability_drafts
       SET promoted_at = ?, promoted_procedure_id = ?
       WHERE id = ? AND metabot_id = ? AND promoted_at IS NULL`,
      [Date.now(), procedureId, id, metabotId],
    );
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /**
   * Record the dream-time validation verdict for one capability draft
   * (Dream-RSI P0 replay gate). Only the validation columns and status move;
   * the draft content itself is immutable dream output. Every verdict-panel
   * contact also stamps last_reviewed_at — the periodic re-review
   * (listReReviewableCapabilityDrafts) schedules from it.
   */
  updateCapabilityDraftValidation(input: {
    id: number;
    metabotId: number;
    /** 'disputed' (design §4.3): neither validated nor rejected — a claim the
     * reconciliation pass could not resolve; it re-enters validation the next
     * night and auto-rejects after DISPUTED_AUTO_REJECT_DAYS. */
    status: 'draft' | 'validated' | 'rejected' | 'disputed';
    validationScore?: number | null;
    validationNotes?: string | null;
  }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0) {
      return false;
    }
    const existing = this.getOne<{ id: number | string }>(
      'SELECT id FROM capability_drafts WHERE id = ? AND metabot_id = ? LIMIT 1',
      [id, metabotId],
    );
    if (!existing) return false;
    this.db.run(`
      UPDATE capability_drafts
      SET status = ?, validation_score = ?, validation_notes = ?, validated_at = ?, last_reviewed_at = ?
      WHERE id = ? AND metabot_id = ?
    `, [
      input.status,
      typeof input.validationScore === 'number' && Number.isFinite(input.validationScore)
        ? input.validationScore
        : null,
      typeof input.validationNotes === 'string' && input.validationNotes.trim()
        ? input.validationNotes.trim().slice(0, 500)
        : null,
      Date.now(),
      Date.now(),
      id,
      metabotId,
    ]);
    this.saveDb();
    return true;
  }

  /**
   * RRSI P5 specificity critic: persist the reconciliation scope verdict (or
   * the host marker rule's situational override). Scope never changes status
   * or content — it only steers roster eligibility and promotion shape.
   * Returns whether a row changed.
   */
  setCapabilityDraftScope(input: { id: number; metabotId: number; scope: CapabilityScope }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0
      || normalizeCapabilityScope(input.scope) == null) {
      return false;
    }
    this.db.run(
      'UPDATE capability_drafts SET scope = ? WHERE id = ? AND metabot_id = ?',
      [input.scope, id, metabotId],
    );
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /**
   * Memory reconciliation, `keep` action (design 2026-10-10 §4.3): record the
   * rule's applicability conditions and residual uncertainty on the draft —
   * the paper's "preserve the conditions and uncertainty of an experience".
   * Status and score stay untouched.
   */
  setCapabilityDraftConditions(input: {
    id: number;
    metabotId: number;
    conditionsText?: string | null;
    uncertaintyText?: string | null;
  }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0) {
      return false;
    }
    this.db.run(`
      UPDATE capability_drafts
      SET conditions_text = ?, uncertainty_text = ?
      WHERE id = ? AND metabot_id = ?
    `, [
      typeof input.conditionsText === 'string' && input.conditionsText.trim()
        ? input.conditionsText.trim()
        : null,
      typeof input.uncertaintyText === 'string' && input.uncertaintyText.trim()
        ? input.uncertaintyText.trim()
        : null,
      id,
      metabotId,
    ]);
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /**
   * Memory reconciliation, `narrow` action (design §4.3): the draft text is
   * rewritten by the HOST TEMPLATE — original text + "Applies when:" +
   * "Untested:" — never free-form LLM output; the validation score is
   * unchanged. The conditions/uncertainty columns are set alongside.
   */
  narrowCapabilityDraft(input: {
    id: number;
    metabotId: number;
    conditionsText: string;
    uncertaintyText?: string | null;
  }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    const conditions = String(input.conditionsText ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0 || !conditions) {
      return false;
    }
    const existing = this.getOne<{ description: string }>(
      'SELECT description FROM capability_drafts WHERE id = ? AND metabot_id = ? LIMIT 1',
      [id, metabotId],
    );
    if (!existing) return false;
    const uncertainty = typeof input.uncertaintyText === 'string' ? input.uncertaintyText.trim() : '';
    const narrowed = [
      existing.description,
      `Applies when: ${conditions}`,
      uncertainty ? `Untested: ${uncertainty}` : '',
    ].filter(Boolean).join('\n');
    this.db.run(`
      UPDATE capability_drafts
      SET description = ?, conditions_text = ?, uncertainty_text = ?
      WHERE id = ? AND metabot_id = ?
    `, [narrowed, conditions, uncertainty || null, id, metabotId]);
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /**
   * Disputed drafts whose last verdict-panel contact is older than
   * `olderThanMs` (design §4.4: unresolved claims auto-reject after 7 nights).
   * last_reviewed_at (falling back to validated_at, then created_at) is the
   * "disputed since" anchor — entering disputed stamps it, and only a real
   * verdict moves it.
   */
  listStaleDisputedCapabilityDrafts(
    metabotId: number,
    options: { olderThanMs: number; limit?: number },
  ): CapabilityDraft[] {
    const limit = Math.max(1, Math.floor(options.limit ?? 10));
    const rows = this.getAll<CapabilityDraftRow>(`
      SELECT ${CAPABILITY_DRAFT_COLUMNS}
      FROM capability_drafts
      WHERE metabot_id = ?
        AND status = 'disputed'
        AND COALESCE(last_reviewed_at, validated_at, created_at) < ?
      ORDER BY COALESCE(last_reviewed_at, validated_at, created_at) ASC, id ASC
      LIMIT ?
    `, [metabotId, Math.floor(Number(options.olderThanMs) || 0), limit]);
    return rows.map((row) => this.mapCapabilityDraftRow(row));
  }

  /**
   * Candidates for the nightly periodic re-review (Dream-RSI P1): VALIDATED
   * drafts whose last verdict-panel contact (last_reviewed_at, falling back
   * to validated_at for pre-migration rows) is older than `olderThanMs`,
   * oldest contact first. The re-review re-runs the same verdict prompt and
   * evidence pool as the fresh-draft gate — a validated technique must keep
   * surviving the bot's recorded history to keep its injection slot.
   */
  listReReviewableCapabilityDrafts(
    metabotId: number,
    options: { olderThanMs: number; limit: number },
  ): CapabilityDraft[] {
    const limit = Math.max(1, Math.floor(options.limit));
    const rows = this.getAll<CapabilityDraftRow>(`
      SELECT ${CAPABILITY_DRAFT_COLUMNS}
      FROM capability_drafts
      WHERE metabot_id = ?
        AND status = 'validated'
        AND COALESCE(last_reviewed_at, validated_at) IS NOT NULL
        AND COALESCE(last_reviewed_at, validated_at) < ?
      ORDER BY COALESCE(last_reviewed_at, validated_at) ASC, id ASC
      LIMIT ?
    `, [metabotId, Math.floor(Number(options.olderThanMs) || 0), limit]);
    return rows.map((row) => this.mapCapabilityDraftRow(row));
  }

  /**
   * Refresh the review bookkeeping of a draft that SURVIVED a periodic
   * re-review (verdict stayed validated, keep_draft, or a rejected verdict
   * too weak to demote): last_reviewed_at moves to now, and the score/notes
   * take the panel's fresh reading when the verdict carries them. Status and
   * validated_at stay untouched — the first-validation timestamp keeps
   * driving the promotion calendar-distance guard.
   */
  markCapabilityDraftReviewed(input: {
    id: number;
    metabotId: number;
    validationScore?: number | null;
    validationNotes?: string | null;
  }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0) {
      return false;
    }
    const sets: string[] = ['last_reviewed_at = ?'];
    const params: Array<number | string | null> = [Date.now()];
    if (typeof input.validationScore === 'number' && Number.isFinite(input.validationScore)) {
      sets.push('validation_score = ?');
      params.push(input.validationScore);
    }
    if (typeof input.validationNotes === 'string' && input.validationNotes.trim()) {
      sets.push('validation_notes = ?');
      params.push(input.validationNotes.trim().slice(0, 500));
    }
    params.push(id, metabotId);
    this.db.run(
      `UPDATE capability_drafts SET ${sets.join(', ')} WHERE id = ? AND metabot_id = ?`,
      params,
    );
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /**
   * Retention cleanup (hygiene): physically delete 'rejected' and
   * never-validated 'draft' rows older than the cutoff. These rows are DREAM
   * BOOKKEEPING (verdict candidates and their corpses), not user memories —
   * the capability they described lives on in the night's diary.
   * 'validated' rows are NEVER deleted here; their quality control is the
   * periodic re-review's job (dreamService). A pending probation draft
   * (source_procedure_id set) also never ages out here — its procedure is
   * still waiting for the gate, so the ticket must survive (RRSI P2).
   */
  purgeExpiredCapabilityDrafts(input: {
    cutoffMs: number;
    excludeMetabotIds?: ReadonlySet<number>;
  }): number {
    const cutoff = Math.floor(Number(input.cutoffMs) || 0);
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const exclusion = excluded.length > 0
      ? ` AND metabot_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    this.db.run(
      `DELETE FROM capability_drafts
       WHERE status IN ('rejected', 'draft') AND created_at < ?
         AND NOT (status = 'draft' AND source_procedure_id IS NOT NULL)${exclusion}`,
      [cutoff, ...excluded],
    );
    const deleted = this.db.getRowsModified?.() || 0;
    if (deleted > 0) {
      this.saveDb();
    }
    return deleted;
  }

  private mapDreamPracticeProposalRow(row: DreamPracticeProposalRow): DreamPracticeProposalRecord {
    let targetRefs: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.target_refs_json ?? '[]');
      if (Array.isArray(parsed)) {
        targetRefs = parsed.filter((ref): ref is string => typeof ref === 'string');
      }
    } catch {
      targetRefs = [];
    }
    return {
      id: Number(row.id),
      metabotId: Number(row.metabot_id),
      dreamDate: String(row.dream_date),
      title: String(row.title),
      prompt: String(row.prompt),
      rationale: row.rationale == null ? null : String(row.rationale),
      targetRefs,
      expectedEvidence: row.expected_evidence == null ? null : String(row.expected_evidence),
      riskClass: normalizeDreamPracticeProposalRiskClass(row.risk_class),
      component: normalizePracticeComponent(row.component),
      status: String(row.status) as DreamPracticeProposalStatus,
      scheduledTaskId: row.scheduled_task_id == null ? null : String(row.scheduled_task_id),
      runId: row.run_id == null ? null : String(row.run_id),
      outcomeSummary: row.outcome_summary == null ? null : String(row.outcome_summary),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Insert dream-proposed practice tasks into `dream_practice_proposals`
   * (self-curriculum, design 2026-10-10 §3.3). Every row lands as 'pending';
   * approval and scheduling are separate, deliberate transitions. Entries with
   * an empty title/prompt are skipped; an unknown risk class falls back to
   * 'read_only'. Returns the number of rows inserted.
   */
  insertDreamPracticeProposals(
    metabotId: number,
    dreamDate: string,
    proposals: Array<{
      title?: string | null;
      prompt?: string | null;
      rationale?: string | null;
      targetRefs?: string[] | null;
      expectedEvidence?: string | null;
      riskClass?: string | null;
      component?: string | null;
    }>,
  ): number {
    const now = Date.now();
    let inserted = 0;
    for (const proposal of Array.isArray(proposals) ? proposals : []) {
      const title = String(proposal?.title ?? '').trim();
      const prompt = String(proposal?.prompt ?? '').trim();
      if (!title || !prompt || !Number.isInteger(metabotId) || metabotId <= 0) {
        continue;
      }
      const rationale = String(proposal?.rationale ?? '').trim() || null;
      const expectedEvidence = String(proposal?.expectedEvidence ?? '').trim() || null;
      const targetRefs = Array.isArray(proposal?.targetRefs)
        ? [...new Set(proposal.targetRefs.map((ref) => String(ref ?? '').trim()).filter(Boolean))]
        : [];
      this.db.run(`
        INSERT INTO dream_practice_proposals (
          metabot_id, dream_date, title, prompt, rationale, target_refs_json,
          expected_evidence, risk_class, component, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `, [
        metabotId,
        dreamDate,
        title,
        prompt,
        rationale,
        JSON.stringify(targetRefs),
        expectedEvidence,
        normalizeDreamPracticeProposalRiskClass(proposal?.riskClass),
        normalizePracticeComponent(proposal?.component),
        now,
        now,
      ]);
      inserted += 1;
    }
    if (inserted > 0) {
      this.saveDb();
    }
    return inserted;
  }

  /**
   * Read practice proposals, newest first; scoped to one MetaBot when
   * `metabotId` is given, optionally filtered by status. Runs the lazy TTL
   * sweep first so a stale 'pending' row never surfaces as actionable.
   */
  listDreamPracticeProposals(
    metabotId?: number,
    options?: { status?: DreamPracticeProposalStatus; limit?: number },
  ): DreamPracticeProposalRecord[] {
    this.expireStaleDreamPracticeProposals();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (metabotId !== undefined && Number.isInteger(metabotId)) {
      where.push('metabot_id = ?');
      params.push(metabotId);
    }
    if (typeof options?.status === 'string' && options.status.trim()) {
      where.push('status = ?');
      params.push(options.status.trim());
    }
    const limit = Number.isInteger(options?.limit) && (options?.limit ?? 0) > 0
      ? Math.floor(options!.limit!)
      : null;
    const rows = this.getAll<DreamPracticeProposalRow>(`
      SELECT id, metabot_id, dream_date, title, prompt, rationale, target_refs_json,
             expected_evidence, risk_class, component, status, scheduled_task_id, run_id,
             outcome_summary, created_at, updated_at
      FROM dream_practice_proposals
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      ${limit != null ? `LIMIT ${limit}` : ''}
    `, params);
    return rows.map((row) => this.mapDreamPracticeProposalRow(row));
  }

  /** One proposal by id (optionally ownership-scoped), after the TTL sweep. */
  getDreamPracticeProposal(id: number, metabotId?: number): DreamPracticeProposalRecord | null {
    this.expireStaleDreamPracticeProposals();
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const scoped = metabotId !== undefined && Number.isInteger(metabotId);
    const row = this.getOne<DreamPracticeProposalRow>(`
      SELECT id, metabot_id, dream_date, title, prompt, rationale, target_refs_json,
             expected_evidence, risk_class, component, status, scheduled_task_id, run_id,
             outcome_summary, created_at, updated_at
      FROM dream_practice_proposals
      WHERE id = ?${scoped ? ' AND metabot_id = ?' : ''}
      LIMIT 1
    `, scoped ? [numericId, Number(metabotId)] : [numericId]);
    return row ? this.mapDreamPracticeProposalRow(row) : null;
  }

  /**
   * Shared guarded status transition: the UPDATE carries the expected current
   * statuses in its WHERE clause, so an illegal transition — or one lost to a
   * concurrent write — is a no-op returning false.
   */
  private transitionDreamPracticeProposal(input: {
    id: number;
    metabotId: number;
    from: readonly DreamPracticeProposalStatus[];
    to: DreamPracticeProposalStatus;
    scheduledTaskId?: string | null;
    runId?: string | null;
    outcomeSummary?: string | null;
  }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0) {
      return false;
    }
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: Array<string | number | null> = [input.to, Date.now()];
    if (input.scheduledTaskId !== undefined) {
      sets.push('scheduled_task_id = ?');
      params.push(input.scheduledTaskId);
    }
    if (input.runId !== undefined) {
      sets.push('run_id = ?');
      params.push(input.runId);
    }
    if (input.outcomeSummary !== undefined) {
      sets.push('outcome_summary = ?');
      params.push(input.outcomeSummary);
    }
    const placeholders = input.from.map(() => '?').join(', ');
    params.push(id, metabotId, ...input.from);
    this.db.run(
      `UPDATE dream_practice_proposals
       SET ${sets.join(', ')}
       WHERE id = ? AND metabot_id = ? AND status IN (${placeholders})`,
      params,
    );
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /** pending → approved (owner UI action, or the auto-approve policy). */
  approveDreamPracticeProposal(input: { id: number; metabotId: number }): boolean {
    // TTL sweep first: a stale pending proposal reads as expired and refuses.
    this.expireStaleDreamPracticeProposals();
    return this.transitionDreamPracticeProposal({ ...input, from: ['pending'], to: 'approved' });
  }

  /** pending|approved → rejected: the owner may reject at any point before scheduled. */
  rejectDreamPracticeProposal(input: { id: number; metabotId: number; outcomeSummary?: string | null }): boolean {
    this.expireStaleDreamPracticeProposals();
    return this.transitionDreamPracticeProposal({ ...input, from: ['pending', 'approved'], to: 'rejected' });
  }

  /** approved → scheduled: the host materialized the proposal into a ScheduledTask. */
  markDreamPracticeProposalScheduled(input: { id: number; metabotId: number; scheduledTaskId: string }): boolean {
    const scheduledTaskId = String(input.scheduledTaskId ?? '').trim();
    if (!scheduledTaskId) return false;
    return this.transitionDreamPracticeProposal({ ...input, scheduledTaskId, from: ['approved'], to: 'scheduled' });
  }

  /** scheduled → completed (from the scheduled_task_runs outcome). */
  markDreamPracticeProposalCompleted(input: { id: number; metabotId: number; runId?: string | null; outcomeSummary?: string | null }): boolean {
    return this.transitionDreamPracticeProposal({ ...input, from: ['scheduled'], to: 'completed' });
  }

  /** scheduled → failed (from the scheduled_task_runs outcome). */
  markDreamPracticeProposalFailed(input: { id: number; metabotId: number; runId?: string | null; outcomeSummary?: string | null }): boolean {
    return this.transitionDreamPracticeProposal({ ...input, from: ['scheduled'], to: 'failed' });
  }

  /**
   * Lazy TTL (design §3.3): 'pending' proposals not acted on within
   * PRACTICE_PROPOSAL_TTL_DAYS become 'expired'. Runs inside every read/
   * transition of this table; also safe to call standalone from a nightly
   * sweep. Returns the number of rows expired.
   */
  expireStaleDreamPracticeProposals(input?: { cutoffMs?: number }): number {
    const cutoff = Number.isFinite(input?.cutoffMs)
      ? Math.floor(Number(input!.cutoffMs))
      : Date.now() - PRACTICE_PROPOSAL_TTL_DAYS * 86_400_000;
    this.db.run(
      `UPDATE dream_practice_proposals
       SET status = 'expired', updated_at = ?
       WHERE status = 'pending' AND created_at < ?`,
      [Date.now(), cutoff],
    );
    const expired = this.db.getRowsModified?.() || 0;
    if (expired > 0) {
      this.saveDb();
    }
    return expired;
  }

  /**
   * Retention cleanup: physically delete 'rejected'/'expired' proposal rows
   * whose last update is older than the cutoff. 'completed'/'failed' rows stay
   * — their outcome_summary is the loop-closure evidence later dreams read.
   */
  purgeDreamPracticeProposals(input: {
    cutoffMs: number;
    excludeMetabotIds?: ReadonlySet<number>;
  }): number {
    const cutoff = Math.floor(Number(input.cutoffMs) || 0);
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const exclusion = excluded.length > 0
      ? ` AND metabot_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    this.db.run(
      `DELETE FROM dream_practice_proposals
       WHERE status IN ('rejected', 'expired') AND updated_at < ?${exclusion}`,
      [cutoff, ...excluded],
    );
    const deleted = this.db.getRowsModified?.() || 0;
    if (deleted > 0) {
      this.saveDb();
    }
    return deleted;
  }

  /**
   * Reverse lookup: the practice proposal a ScheduledTask was materialized
   * from (dream_practice_proposals.scheduled_task_id). The scheduler uses it
   * to activate the practice tool policy and to write the run outcome back.
   */
  getDreamPracticeProposalByScheduledTaskId(scheduledTaskId: string): DreamPracticeProposalRecord | null {
    const id = String(scheduledTaskId ?? '').trim();
    if (!id) return null;
    const row = this.getOne<DreamPracticeProposalRow>(`
      SELECT id, metabot_id, dream_date, title, prompt, rationale, target_refs_json,
             expected_evidence, risk_class, component, status, scheduled_task_id, run_id,
             outcome_summary, created_at, updated_at
      FROM dream_practice_proposals
      WHERE scheduled_task_id = ?
      LIMIT 1
    `, [id]);
    return row ? this.mapDreamPracticeProposalRow(row) : null;
  }

  /**
   * Backfill the outcome summary of a completed/failed proposal from the
   * practice session's final report. First writer wins (outcome_summary IS
   * NULL) so the nightly consumption pass is idempotent.
   */
  updateDreamPracticeProposalOutcome(input: { id: number; metabotId: number; outcomeSummary: string }): boolean {
    const id = Number(input.id);
    const metabotId = Number(input.metabotId);
    const summary = String(input.outcomeSummary ?? '').trim();
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(metabotId) || metabotId <= 0 || !summary) {
      return false;
    }
    this.db.run(
      `UPDATE dream_practice_proposals
       SET outcome_summary = ?, updated_at = ?
       WHERE id = ? AND metabot_id = ?
         AND status IN ('completed', 'failed')
         AND outcome_summary IS NULL`,
      [summary.slice(0, 2000), Date.now(), id, metabotId],
    );
    const updated = (this.db.getRowsModified?.() || 0) > 0;
    if (updated) {
      this.saveDb();
    }
    return updated;
  }

  /**
   * Practice runs that executed during [dayStartMs, dayEndMs): proposals in a
   * terminal run state joined to their scheduled_task_runs row (run_id is
   * written at run completion by the scheduler). Feeds the dream prompt's
   * practice-outcomes section and its outcome_summary backfill.
   */
  listDreamPracticeOutcomesForDay(
    metabotId: number,
    dayStartMs: number,
    dayEndMs: number,
  ): Array<DreamPracticeProposalRecord & { runSessionId: string | null }> {
    if (!Number.isInteger(metabotId) || metabotId <= 0) return [];
    const rows = this.getAll<DreamPracticeProposalRow & { run_session_id: string | null }>(`
      SELECT p.id, p.metabot_id, p.dream_date, p.title, p.prompt, p.rationale, p.target_refs_json,
             p.expected_evidence, p.risk_class, p.component, p.status, p.scheduled_task_id, p.run_id,
             p.outcome_summary, p.created_at, p.updated_at,
             r.session_id AS run_session_id
      FROM dream_practice_proposals p
      JOIN scheduled_task_runs r ON r.id = p.run_id
      WHERE p.metabot_id = ?
        AND p.status IN ('completed', 'failed')
        AND r.started_at >= ? AND r.started_at < ?
      ORDER BY r.started_at ASC, p.id ASC
    `, [metabotId, new Date(dayStartMs).toISOString(), new Date(dayEndMs).toISOString()]);
    return rows.map((row) => ({
      ...this.mapDreamPracticeProposalRow(row),
      runSessionId: row.run_session_id ?? null,
    }));
  }

  updateUserMemory(input: MemoryUpdateUserMemoryInput): CoworkUserMemory | null {
    const scope = this.resolveMemoryScopeSelector(input);
    const current = this.getOne<CoworkUserMemoryRow>(`
      SELECT ${MEMORY_ROW_SELECT_COLUMNS}
      FROM user_memories
      WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
    `, [input.id, input.metabotId, scope.kind, scope.key]);
    if (!current) return null;
    // self_identity entries belong to the dream service; refuse edits from
    // tools, IPC and implicit pipelines unless explicitly allowed internally.
    if (normalizeMemoryUsageClass(current.usage_class) === 'self_identity' && !input.allowProtected) {
      return null;
    }

    const now = Date.now();
    const nextText = input.text !== undefined
      ? applyMemoryDefense(truncate(normalizeMemoryText(input.text), maxMemoryTextChars(input.usageClass ?? current.usage_class)))
      : current.text;
    if (!nextText) {
      throw new Error('Memory text is required');
    }
    const nextConfidence = input.confidence !== undefined
      ? Math.max(0, Math.min(1, Number(input.confidence)))
      : Number(current.confidence);
    const nextStatus = input.status && (input.status === 'created' || input.status === 'stale' || input.status === 'deleted')
      ? input.status
      : current.status;
    const nextExplicit = input.isExplicit !== undefined ? (input.isExplicit ? 1 : 0) : current.is_explicit;
    const nextClassification = this.resolveMemoryClassification(nextText, scope, {
      usageClass: input.usageClass ?? normalizeMemoryUsageClass(current.usage_class),
      visibility: input.visibility ?? normalizeMemoryVisibility(current.visibility),
    });
    // Updates never lower importance, mirroring the revive path's MAX rule.
    const nextImportance = Math.max(
      clampMemoryImportance(current.importance),
      deriveMemoryImportance({
        usageClass: nextClassification.usageClass,
        origin: normalizeMemoryOrigin(current.origin),
        isExplicit: Number(nextExplicit) !== 0,
      }),
    );

    this.recordMemoryRevision({
      memoryId: input.id,
      metabotId: input.metabotId,
      previousText: current.text,
      newText: nextText,
      reason: input.allowProtected ? 'protected_update' : 'user_edit',
      sourceType: input.source?.sourceType ?? null,
    });
    this.db.run(`
      UPDATE user_memories
      SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = ?,
          usage_class = ?, visibility = ?, updated_at = ?, importance = ?
      WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
    `, [
      nextText,
      buildMemoryFingerprint(nextText),
      nextConfidence,
      nextExplicit,
      nextStatus,
      nextClassification.usageClass,
      nextClassification.visibility,
      now,
      nextImportance,
      input.id,
      input.metabotId,
      scope.kind,
      scope.key,
    ]);

    const updated = this.getOne<CoworkUserMemoryRow>(`
      SELECT ${MEMORY_ROW_SELECT_COLUMNS}
      FROM user_memories
      WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
    `, [input.id, input.metabotId, scope.kind, scope.key]);

    if (input.source) {
      this.addMemorySource(input.id, input.metabotId, input.source);
    }

    this.saveDb();
    return updated ? this.mapMemoryRow(updated) : null;
  }

  deleteUserMemory(input: MemoryDeleteUserMemoryInput): boolean;
  deleteUserMemory(id: string, metabotId: number): boolean;
  deleteUserMemory(
    inputOrId: MemoryDeleteUserMemoryInput | string,
    metabotIdArg?: number
  ): boolean {
    const id = typeof inputOrId === 'string' ? inputOrId : inputOrId.id;
    const metabotId = typeof inputOrId === 'string' ? Number(metabotIdArg) : Number(inputOrId.metabotId);
    const scope = typeof inputOrId === 'string'
      ? createOwnerMemoryScope()
      : this.resolveMemoryScopeSelector(inputOrId);
    if (!id || !Number.isFinite(metabotId)) {
      return false;
    }
    // self_identity entries belong to the dream service; refuse deletion from
    // tools, IPC and implicit pipelines unless explicitly allowed internally.
    const allowProtected = typeof inputOrId === 'string' ? false : Boolean(inputOrId.allowProtected);
    if (!allowProtected) {
      const target = this.getOne<{ usage_class?: string | null }>(
        'SELECT usage_class FROM user_memories WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?',
        [id, metabotId, scope.kind, scope.key]
      );
      if (target && normalizeMemoryUsageClass(target.usage_class) === 'self_identity') {
        return false;
      }
    }
    const now = Date.now();
    this.db.run(`
      UPDATE user_memories
      SET status = 'deleted', updated_at = ?
      WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
    `, [now, id, metabotId, scope.kind, scope.key]);
    const memoryRowsModified = this.db.getRowsModified?.() || 0;
    if (memoryRowsModified > 0) {
      this.db.run(`
        UPDATE user_memory_sources
        SET is_active = 0
        WHERE memory_id = ?
      `, [id]);
    }
    this.saveDb();
    return memoryRowsModified > 0;
  }

  /**
   * Hygiene decay stroke: dream-origin memories (never self_identity, never
   * conversation-origin rows that may carry the user's explicit "remember
   * this") untouched for longer than the cutoff get a reversible archived_at
   * mark so they leave injection and default listings. Recency reads
   * COALESCE(last_applied_at, last_used_at, updated_at): a memory the usage
   * audit saw APPLIED stays alive on the applied clock, an injected-but-
   * never-applied one on the injection clock (dream review P1).
   */
  archiveDecayedDreamMemories(input: {
    cutoffMs: number;
    archivedAt: number;
    excludeMetabotIds?: ReadonlySet<number>;
    limit?: number;
  }): number {
    const cutoff = Math.floor(input.cutoffMs);
    const limit = Math.min(20_000, Math.max(1, Math.floor(input.limit ?? 5_000)));
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const metabotExclusion = excluded.length > 0
      ? ` AND metabot_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    const ids = this.getAll<{ id: string }>(
      `SELECT id FROM user_memories
       WHERE archived_at IS NULL
         AND status = 'created'
         AND origin = 'dream'
         AND usage_class != 'self_identity'
         AND COALESCE(last_applied_at, last_used_at, updated_at) < ?${metabotExclusion}
       ORDER BY COALESCE(last_applied_at, last_used_at, updated_at) ASC
       LIMIT ?`,
      [cutoff, ...excluded, limit],
    ).map((row) => row.id);
    if (ids.length === 0) return 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      this.db.run(
        `UPDATE user_memories
         SET archived_at = ?
         WHERE archived_at IS NULL AND id IN (${chunk.map(() => '?').join(', ')})`,
        [Math.floor(input.archivedAt), ...chunk],
      );
    }
    this.saveDb();
    return ids.length;
  }

  /** Reverse the hygiene decay mark on specific memories. */
  unarchiveUserMemories(input: { ids: string[] }): number {
    const ids = input.ids.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return 0;
    let restored = 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      this.db.run(
        `UPDATE user_memories
         SET archived_at = NULL
         WHERE archived_at IS NOT NULL AND id IN (${chunk.map(() => '?').join(', ')})`,
        chunk,
      );
      restored += chunk.length;
    }
    this.saveDb();
    return restored;
  }

  /**
   * Archive specific memories by id (deep-consolidation retire proposals).
   * self_identity is always refused; every other class only gets the
   * reversible archived_at mark. `notUsedSince` guards against the LLM await
   * window: rows edited or injection-touched after that snapshot survive.
   */
  archiveUserMemories(input: { ids: string[]; archivedAt: number; notUsedSince?: number }): number {
    const ids = input.ids.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return 0;
    const usageGuard = input.notUsedSince != null
      ? ' AND COALESCE(last_used_at, updated_at) <= ?'
      : '';
    const guardParams = input.notUsedSince != null ? [Math.floor(input.notUsedSince)] : [];
    let archived = 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      this.db.run(
        `UPDATE user_memories
         SET archived_at = ?
         WHERE archived_at IS NULL
           AND usage_class != 'self_identity'
           AND status = 'created'
           AND id IN (${chunk.map(() => '?').join(', ')})${usageGuard}`,
        [Math.floor(input.archivedAt), ...chunk, ...guardParams],
      );
      archived += this.db.getRowsModified?.() || 0;
    }
    if (archived > 0) {
      this.saveDb();
    }
    return archived;
  }

  /**
   * Evidence ledger read: per memory, how many active provenance rows
   * corroborate it (proof count) and its newest distinct quotes. Feeds the
   * idle-time passes (deep consolidation judges a belief by its evidence) and
   * owner surfaces; the per-turn prompt never reads it. Ids without rows map
   * to an empty summary so callers can index unconditionally.
   */
  listUserMemoryEvidence(
    memoryIds: readonly string[],
    options?: { maxQuotes?: number },
  ): Map<string, MemoryEvidenceSummary> {
    const ids = Array.from(new Set(memoryIds.map((id) => id.trim()).filter(Boolean)));
    const result = new Map<string, MemoryEvidenceSummary>();
    for (const id of ids) result.set(id, { proofCount: 0, quotes: [] });
    if (ids.length === 0) return result;
    const maxQuotes = Math.max(0, Math.min(10, Math.floor(options?.maxQuotes ?? MEMORY_EVIDENCE_QUOTES_PER_MEMORY)));
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const rows = this.getAll<{ memory_id: string; quote: string | null }>(`
        SELECT memory_id, quote
        FROM user_memory_sources
        WHERE is_active = 1 AND memory_id IN (${chunk.map(() => '?').join(', ')})
        ORDER BY created_at DESC, ROWID DESC
      `, chunk);
      for (const row of rows) {
        const entry = result.get(row.memory_id);
        if (!entry) continue;
        entry.proofCount += 1;
        const quote = normalizeMemoryQuote(row.quote);
        if (quote && entry.quotes.length < maxQuotes && !entry.quotes.includes(quote)) {
          entry.quotes.push(quote);
        }
      }
    }
    return result;
  }

  /** Newest-first wording history of one memory (see recordMemoryRevision). */
  listUserMemoryRevisions(memoryId: string, limit: number = MEMORY_REVISIONS_KEEP_PER_MEMORY): MemoryRevision[] {
    const id = memoryId.trim();
    if (!id) return [];
    const rows = this.getAll<{
      id: string;
      memory_id: string;
      previous_text: string;
      new_text: string;
      reason: string;
      source_type: string | null;
      created_at: number;
    }>(`
      SELECT id, memory_id, previous_text, new_text, reason, source_type, created_at
      FROM user_memory_revisions
      WHERE memory_id = ?
      ORDER BY created_at DESC, ROWID DESC
      LIMIT ?
    `, [id, Math.max(1, Math.min(100, Math.floor(limit)))]);
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      previousText: row.previous_text,
      newText: row.new_text,
      reason: row.reason,
      sourceType: row.source_type ?? null,
      createdAt: Number(row.created_at),
    }));
  }

  /**
   * Deep-consolidation evolution rewrite: replace a memory's wording with the
   * narrative that carries a contradiction or state change ("曾…，现在…"),
   * keeping the replaced text as a revision so the rewrite stays reversible.
   * Same protections as archiveUserMemories — active rows only, never
   * self_identity, and the notUsedSince guard skips rows touched during the
   * proposal's LLM window. The write goes through the ordinary text cap, so a
   * rewrite can never grow the injected surface. The new wording is
   * re-screened by memory defense: a redaction applies in place, and a
   * blocking hit skips the rewrite and keeps the stored text. Returns whether
   * a row changed.
   */
  rewriteUserMemoryText(input: {
    id: string;
    metabotId: number;
    text: string;
    reason: MemoryRevisionReason;
    sourceType?: string | null;
    notUsedSince?: number;
  }): boolean {
    const id = input.id.trim();
    if (!id) return false;
    const usageGuard = input.notUsedSince != null
      ? ' AND COALESCE(last_used_at, updated_at) <= ?'
      : '';
    const guardParams = input.notUsedSince != null ? [Math.floor(input.notUsedSince)] : [];
    const current = this.getOne<CoworkUserMemoryRow>(`
      SELECT ${MEMORY_ROW_SELECT_COLUMNS}
      FROM user_memories
      WHERE id = ? AND metabot_id = ?
        AND status = 'created' AND archived_at IS NULL
        AND usage_class != 'self_identity'${usageGuard}
    `, [id, input.metabotId, ...guardParams]);
    if (!current) return false;
    const nextText = truncate(normalizeMemoryText(input.text), maxMemoryTextChars(current.usage_class));
    if (!nextText || nextText === current.text) return false;
    let defendedText: string;
    try {
      defendedText = applyMemoryDefense(nextText);
    } catch (error) {
      if (error instanceof MemoryDefenseError) {
        console.warn('[MemoryDefense] skipped an evolution rewrite (secret in the new wording)');
        return false;
      }
      throw error;
    }
    if (!defendedText || defendedText === current.text) return false;
    this.recordMemoryRevision({
      memoryId: id,
      metabotId: input.metabotId,
      previousText: current.text,
      newText: defendedText,
      reason: input.reason,
      sourceType: input.sourceType ?? null,
    });
    this.db.run(`
      UPDATE user_memories
      SET text = ?, fingerprint = ?, updated_at = ?
      WHERE id = ? AND metabot_id = ?
    `, [defendedText, buildMemoryFingerprint(defendedText), Date.now(), id, input.metabotId]);
    this.saveDb();
    return true;
  }

  // Deep-consolidation cadence: metabot id -> epoch ms of its last run.
  getDeepConsolidationLastRunAt(metabotId: number): number | null {
    const row = this.getOne<{ value: string }>(
      'SELECT value FROM cowork_config WHERE key = ?',
      ['memoryHygieneDeepConsolidation'],
    );
    if (!row?.value) return null;
    try {
      const parsed = JSON.parse(row.value) as Record<string, number>;
      const value = parsed[String(metabotId)];
      return typeof value === 'number' ? value : null;
    } catch {
      return null;
    }
  }

  setDeepConsolidationLastRunAt(metabotId: number, ranAt: number): void {
    let parsed: Record<string, number> = {};
    const row = this.getOne<{ value: string }>(
      'SELECT value FROM cowork_config WHERE key = ?',
      ['memoryHygieneDeepConsolidation'],
    );
    if (row?.value) {
      try {
        parsed = JSON.parse(row.value) as Record<string, number>;
      } catch {
        parsed = {};
      }
    }
    parsed[String(metabotId)] = Math.floor(ranAt);
    this.db.run(`
      INSERT INTO cowork_config (key, value, updated_at)
      VALUES ('memoryHygieneDeepConsolidation', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [JSON.stringify(parsed), Date.now()]);
    this.saveDb();
  }

  // Deep-consolidation attempt ladder: metabot id -> consecutive failing
  // passes. Mirrors a dream run's attempt_count: a failed pass leaves the
  // cadence unstamped, so the next pass is attempt+1 and resolves a wider
  // per-attempt LLM window from it; a clean pass clears the entry.
  getDeepConsolidationAttempts(metabotId: number): number {
    const row = this.getOne<{ value: string }>(
      'SELECT value FROM cowork_config WHERE key = ?',
      ['memoryHygieneDeepConsolidationAttempts'],
    );
    if (!row?.value) return 0;
    try {
      const parsed = JSON.parse(row.value) as Record<string, number>;
      const value = parsed[String(metabotId)];
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  setDeepConsolidationAttempts(metabotId: number, attempts: number): void {
    let parsed: Record<string, number> = {};
    const row = this.getOne<{ value: string }>(
      'SELECT value FROM cowork_config WHERE key = ?',
      ['memoryHygieneDeepConsolidationAttempts'],
    );
    if (row?.value) {
      try {
        parsed = JSON.parse(row.value) as Record<string, number>;
      } catch {
        parsed = {};
      }
    }
    const normalized = Math.max(0, Math.floor(Number(attempts) || 0));
    if (normalized > 0) {
      parsed[String(metabotId)] = normalized;
    } else {
      // Zero is the default: keep the map empty for bots that never failed.
      delete parsed[String(metabotId)];
    }
    this.db.run(`
      INSERT INTO cowork_config (key, value, updated_at)
      VALUES ('memoryHygieneDeepConsolidationAttempts', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [JSON.stringify(parsed), Date.now()]);
    this.saveDb();
  }

  /**
   * The one low-risk physical delete in the memory layer: tombstones
   * (status='deleted') older than the grace period are removed together with
   * their source rows. They were already deleted content; the grace window
   * exists only so recent deletions stay undoable. Each purged id is recorded
   * in the chain-backup tombstone ledger first so the deletion also propagates
   * to future restores.
   */
  purgeDeletedMemoryTombstones(input: {
    cutoffMs: number;
    excludeMetabotIds?: ReadonlySet<number>;
    limit?: number;
  }): number {
    const cutoff = Math.floor(input.cutoffMs);
    const limit = Math.min(20_000, Math.max(1, Math.floor(input.limit ?? 5_000)));
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const metabotExclusion = excluded.length > 0
      ? ` AND metabot_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    const tombstoneRows = this.getAll<{ id: string; metabot_id: number }>(
      `SELECT id, metabot_id FROM user_memories
       WHERE status = 'deleted' AND updated_at < ?${metabotExclusion}
       ORDER BY updated_at ASC
       LIMIT ?`,
      [cutoff, ...excluded, limit],
    );
    const ids = tombstoneRows.map((row) => row.id);
    if (ids.length === 0) return 0;
    this.db.run('BEGIN IMMEDIATE');
    try {
      // Ledger first: a purged row leaves the extraction scan, and only this
      // record stops its last chain-backup snapshot from resurrecting on a
      // restore.
      recordChainBackupTombstones(
        this.db,
        tombstoneRows.map((row) => ({ kind: 'memory' as const, ref: row.id, metabotId: row.metabot_id })),
      );
      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        this.db.run(
          `DELETE FROM user_memory_sources WHERE memory_id IN (${chunk.map(() => '?').join(', ')})`,
          chunk,
        );
        if (this.tableExists('user_memory_revisions')) {
          this.db.run(
            `DELETE FROM user_memory_revisions WHERE memory_id IN (${chunk.map(() => '?').join(', ')})`,
            chunk,
          );
        }
        this.db.run(
          `DELETE FROM user_memories
           WHERE status = 'deleted' AND id IN (${chunk.map(() => '?').join(', ')})`,
          chunk,
        );
      }
      this.db.run('COMMIT');
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
    this.saveDb();
    return ids.length;
  }

  /**
   * Dream pipeline: soft-delete one day's dream-written batch (profile_fact /
   * value_boundary / work_review entries tagged with the dream date) so a
   * re-dream replaces the day's batch instead of piling onto it. self_identity
   * is excluded — it is updated in place, never batch-deleted. Returns the
   * number of memories deleted.
   */
  softDeleteDreamMemoriesForDate(metabotId: number, dreamDate: string): number {
    const date = dreamDate.trim();
    if (!date) return 0;
    const now = Date.now();
    const targets = this.getAll<{ id: string }>(`
      SELECT DISTINCT m.id
      FROM user_memories m
      JOIN user_memory_sources s ON s.memory_id = m.id
      WHERE m.metabot_id = ?
        AND m.origin = 'dream'
        AND m.usage_class IN ('profile_fact', 'value_boundary', 'work_review')
        AND m.status != 'deleted'
        AND s.dream_date = ?
    `, [metabotId, date]);
    if (targets.length === 0) return 0;
    const ids = targets.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    this.db.run(`
      UPDATE user_memories
      SET status = 'deleted', updated_at = ?
      WHERE id IN (${placeholders})
    `, [now, ...ids]);
    this.db.run(`
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE memory_id IN (${placeholders})
    `, [...ids]);
    this.saveDb();
    return ids.length;
  }

  /**
   * RSI P0 retention gate: deterministically roll back one dream night's
   * prompt-layer writes. Two strokes, both following the store's existing
   * tombstone/revision model (nothing is hard-deleted):
   *  1. the rolled-back date's dream batch (profile_fact / value_boundary /
   *     work_review rows tagged with that dream date, self_identity excluded)
   *     is tombstoned exactly like softDeleteDreamMemoriesForDate does;
   *  2. every snapshotted prior row that still exists is restored to its
   *     snapshotted text/fingerprint/status/archived_at — this undoes both the
   *     tombstone and any cross-night dedup text rewrite the rolled-back night
   *     applied — and its source rows are reactivated EXCEPT the rolled-back
   *     date's provenance rows (those stay inactive: the night is disavowed).
   * Rows physically purged meanwhile cannot be resurrected and are counted as
   * skipped. self_identity never appears in snapshots and is never touched.
   */
  rollbackDreamMemoriesForDate(
    metabotId: number,
    dreamDate: string,
    snapshotMemories: Array<{
      id: string;
      text: string;
      fingerprint: string;
      status: string;
      archivedAt: number | null;
    }>,
  ): { removed: number; restored: number; skippedMissing: number } {
    const date = dreamDate.trim();
    if (!date || !Number.isInteger(metabotId) || metabotId <= 0) {
      return { removed: 0, restored: 0, skippedMissing: 0 };
    }
    const now = Date.now();
    // Only ACTIVE provenance rows count as the night's batch — a previously
    // restored row keeps the disavowed night's source inactive and must not be
    // re-tombstoned by a repeat pass.
    const targets = this.getAll<{ id: string }>(`
      SELECT DISTINCT m.id
      FROM user_memories m
      JOIN user_memory_sources s ON s.memory_id = m.id
      WHERE m.metabot_id = ?
        AND m.origin = 'dream'
        AND m.usage_class IN ('profile_fact', 'value_boundary', 'work_review')
        AND m.status != 'deleted'
        AND s.dream_date = ?
        AND s.is_active = 1
    `, [metabotId, date]);
    let removed = 0;
    if (targets.length > 0) {
      const ids = targets.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(', ');
      this.db.run(`
        UPDATE user_memories
        SET status = 'deleted', updated_at = ?
        WHERE id IN (${placeholders})
      `, [now, ...ids]);
      this.db.run(`
        UPDATE user_memory_sources
        SET is_active = 0
        WHERE memory_id IN (${placeholders})
      `, [...ids]);
      removed = ids.length;
    }

    let restored = 0;
    let skippedMissing = 0;
    for (const snap of snapshotMemories) {
      if (!snap?.id) continue;
      const existing = this.getOne<{ id: string }>(
        'SELECT id FROM user_memories WHERE id = ? AND metabot_id = ? LIMIT 1',
        [snap.id, metabotId],
      );
      if (!existing) {
        skippedMissing += 1;
        continue;
      }
      this.db.run(`
        UPDATE user_memories
        SET text = ?, fingerprint = ?, status = ?, archived_at = ?, updated_at = ?
        WHERE id = ? AND metabot_id = ?
      `, [
        snap.text,
        snap.fingerprint || buildMemoryFingerprint(snap.text),
        snap.status === 'stale' ? 'stale' : 'created',
        snap.archivedAt == null ? null : Math.floor(snap.archivedAt),
        now,
        snap.id,
        metabotId,
      ]);
      this.db.run(`
        UPDATE user_memory_sources
        SET is_active = 1
        WHERE memory_id = ? AND (dream_date IS NULL OR dream_date != ?)
      `, [snap.id, date]);
      this.db.run(`
        UPDATE user_memory_sources
        SET is_active = 0
        WHERE memory_id = ? AND dream_date = ?
      `, [snap.id, date]);
      restored += 1;
    }
    if (removed > 0 || restored > 0) {
      this.saveDb();
    }
    return { removed, restored, skippedMissing };
  }

  /**
   * First-run / startup repair: if a bot has no live self-identity but still
   * has a dream-written one that the conversation sweeper soft-deleted, bring
   * the newest deleted copy back. Idempotent — no-op when a live entry exists
   * or the bot has never formed an identity.
   */
  restoreMissingSelfIdentities(): number {
    if (!this.tableExists('user_memories')) {
      return 0;
    }
    const deleted = this.getAll<{ id: string; metabot_id: number | string; created_at: number | string }>(`
      SELECT id, metabot_id, created_at
      FROM user_memories
      WHERE usage_class = 'self_identity'
        AND status = 'deleted'
        AND NOT EXISTS (
          SELECT 1
          FROM user_memories live
          WHERE live.metabot_id = user_memories.metabot_id
            AND live.usage_class = 'self_identity'
            AND live.status != 'deleted'
        )
      ORDER BY created_at DESC
    `);
    if (deleted.length === 0) return 0;

    const seenMetabots = new Set<number>();
    const restoreIds: string[] = [];
    for (const row of deleted) {
      const metabotId = parseIdNumber(row.metabot_id);
      if (metabotId == null || seenMetabots.has(metabotId)) continue;
      seenMetabots.add(metabotId);
      restoreIds.push(row.id);
    }
    if (restoreIds.length === 0) return 0;

    const now = Date.now();
    const placeholders = restoreIds.map(() => '?').join(', ');
    this.db.run(`
      UPDATE user_memories
      SET status = 'created', updated_at = ?
      WHERE id IN (${placeholders})
    `, [now, ...restoreIds]);
    if (this.tableExists('user_memory_sources')) {
      this.db.run(`
        UPDATE user_memory_sources
        SET is_active = 1
        WHERE memory_id IN (${placeholders})
      `, [...restoreIds]);
    }
    this.saveDb();
    console.info(`[CoworkStore] Restored ${restoreIds.length} missing self-identity entr${restoreIds.length === 1 ? 'y' : 'ies'}`);
    return restoreIds.length;
  }

  /**
   * Dream pipeline: the newest dream date that produced the bot's current
   * self-identity entry, or null when it predates dream-date tagging. The
   * dream service only lets identity move forward in time.
   */
  getDreamIdentityLatestDate(metabotId: number): string | null {
    const row = this.getOne<{ dream_date: string | null }>(`
      SELECT s.dream_date
      FROM user_memory_sources s
      JOIN user_memories m ON m.id = s.memory_id
      WHERE m.metabot_id = ?
        AND m.usage_class = 'self_identity'
        AND m.status != 'deleted'
        AND s.dream_date IS NOT NULL
      ORDER BY s.dream_date DESC
      LIMIT 1
    `, [metabotId]);
    return row?.dream_date ?? null;
  }

  getUserMemoryStats(input: { metabotId: number } & MemoryScopeSelectorInput): MemoryUserMemoryStats;
  getUserMemoryStats(metabotId: number): MemoryUserMemoryStats;
  getUserMemoryStats(inputOrMetabotId: ({ metabotId: number } & MemoryScopeSelectorInput) | number): MemoryUserMemoryStats {
    const metabotId = typeof inputOrMetabotId === 'number'
      ? inputOrMetabotId
      : inputOrMetabotId.metabotId;
    const scope = typeof inputOrMetabotId === 'number'
      ? createOwnerMemoryScope()
      : this.resolveMemoryScopeSelector(inputOrMetabotId);
    const rows = this.getAll<{
      status: string;
      is_explicit: number;
      count: number;
    }>(`
      SELECT status, is_explicit, COUNT(*) AS count
      FROM user_memories
      WHERE metabot_id = ? AND scope_kind = ? AND scope_key = ?
      GROUP BY status, is_explicit
    `, [metabotId, scope.kind, scope.key]);

    const stats: MemoryUserMemoryStats = {
      total: 0,
      created: 0,
      stale: 0,
      deleted: 0,
      explicit: 0,
      implicit: 0,
    };

    for (const row of rows) {
      const count = Number(row.count) || 0;
      stats.total += count;
      if (row.status === 'created') stats.created += count;
      if (row.status === 'stale') stats.stale += count;
      if (row.status === 'deleted') stats.deleted += count;
      if (Number(row.is_explicit) !== 0) stats.explicit += count;
      else stats.implicit += count;
    }

    return stats;
  }

  listMemoryScopes(metabotId: number): MemoryScopesOverview {
    const rows = this.getAll<{
      scope_kind: string;
      scope_key: string;
      count: number;
    }>(`
      SELECT scope_kind, scope_key, COUNT(*) AS count
      FROM user_memories
      WHERE metabot_id = ? AND status != 'deleted'
      GROUP BY scope_kind, scope_key
      ORDER BY scope_key ASC
    `, [metabotId]);

    const overview: MemoryScopesOverview = {
      owner: null,
      contacts: [],
      conversations: [],
    };

    for (const row of rows) {
      const kind: MemoryScopeKind = row.scope_kind === 'contact' || row.scope_kind === 'conversation'
        ? row.scope_kind
        : 'owner';
      const key = normalizeScopeIdentity(row.scope_key) || OWNER_SCOPE_KEY;
      const count = Number(row.count) || 0;
      const summary: MemoryScopeSummary = { kind, key, count };

      if (kind === 'contact') {
        const parsed = parseContactScopeKey(key);
        const peerGlobalMetaId = parsed?.peerGlobalMetaId ?? null;
        summary.peerGlobalMetaId = peerGlobalMetaId;
        if (peerGlobalMetaId) {
          const peer = this.getOne<{ peer_name: string | null; peer_avatar: string | null }>(`
            SELECT peer_name, peer_avatar
            FROM cowork_sessions
            WHERE peer_global_metaid = ?
              AND peer_name IS NOT NULL AND peer_name != ''
            ORDER BY updated_at DESC
            LIMIT 1
          `, [peerGlobalMetaId]);
          summary.peerName = peer?.peer_name ?? null;
          summary.peerAvatar = peer?.peer_avatar ?? null;
        }
        overview.contacts.push(summary);
      } else if (kind === 'conversation') {
        overview.conversations.push(summary);
      } else {
        overview.owner = summary;
      }
    }

    // Always present the owner scope even when empty so the UI can default to it.
    if (!overview.owner) {
      overview.owner = { kind: 'owner', key: OWNER_SCOPE_KEY, count: 0 };
    }

    return overview;
  }

  resolveMemoryScopeForSession(sessionId?: string | null): MemorySessionScopeResolution | null {
    const metabotId = this.resolveMetabotIdForMemory(sessionId);
    if (metabotId == null) {
      return null;
    }
    const resolved = resolveMemoryScopes(this.buildResolvedMemoryScopeInput({ metabotId, sessionId }));
    let peerName: string | null = null;
    let peerAvatar: string | null = null;
    if (resolved.writeScope.kind === 'contact' && sessionId) {
      const sessionRow = this.getOne<{ peer_name: string | null; peer_avatar: string | null }>(`
        SELECT peer_name, peer_avatar
        FROM cowork_sessions
        WHERE id = ?
        LIMIT 1
      `, [sessionId]);
      peerName = sessionRow?.peer_name ?? null;
      peerAvatar = sessionRow?.peer_avatar ?? null;
    }
    return {
      metabotId,
      scope: resolved.writeScope,
      peerName,
      peerAvatar,
    };
  }

  markMemorySourcesInactiveBySession(sessionId: string): void {
    this.db.run(`
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE session_id = ? AND is_active = 1
    `, [sessionId]);
  }

  markOrphanImplicitMemoriesStale(metabotId: number, scopeSelector?: MemoryScopeSelectorInput): void {
    const scope = this.resolveMemoryScopeSelector(scopeSelector ?? {});
    const now = Date.now();
    this.db.run(`
      UPDATE user_memories
      SET status = 'stale', updated_at = ?
      WHERE metabot_id = ?
        AND scope_kind = ?
        AND scope_key = ?
        AND is_explicit = 0
        AND status = 'created'
        AND NOT EXISTS (
          SELECT 1
          FROM user_memory_sources s
          WHERE s.memory_id = user_memories.id AND s.is_active = 1
        )
    `, [now, metabotId, scope.kind, scope.key]);
  }

  /**
   * Shared delete flow for memory changes: best fuzzy match against existing
   * memories in the write scope (same semantics as the inlined block it
   * replaced). Returns false for an unusable key or no match.
   */
  private deleteBestMatchingUserMemory(text: string, metabotId: number, writeScope: MemoryScope): boolean {
    const key = normalizeMemoryMatchKey(text);
    if (!key) return false;

    const candidates = this.listUserMemories({
      metabotId,
      scope: writeScope,
      status: 'all',
      includeDeleted: false,
      limit: 100,
    });
    let target: CoworkUserMemory | null = null;
    let bestScore = 0;
    for (const entry of candidates) {
      const currentKey = normalizeMemoryMatchKey(entry.text);
      if (!currentKey) continue;
      const score = scoreDeleteMatch(currentKey, key);
      if (score <= bestScore) continue;
      bestScore = score;
      target = entry;
    }
    if (!target) return false;

    return this.deleteUserMemory({
      id: target.id,
      metabotId,
      scope: writeScope,
    });
  }

  async applyTurnMemoryUpdates(options: ApplyTurnMemoryUpdatesOptions): Promise<ApplyTurnMemoryUpdatesResult> {
    const result: ApplyTurnMemoryUpdatesResult = {
      totalChanges: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      judgeRejected: 0,
      llmReviewed: 0,
      skipped: 0,
      defenseRejected: 0,
    };

    const metabotId = this.resolveMetabotIdForMemory(options.sessionId);
    if (metabotId == null) {
      return result;
    }
    const resolvedScopes = resolveMemoryScopes(this.buildResolvedMemoryScopeInput({
      metabotId,
      sessionId: options.sessionId,
    }));

    const extracted = extractTurnMemoryChanges({
      userText: options.userText,
      assistantText: options.assistantText,
      guardLevel: options.guardLevel,
      maxImplicitAdds: options.implicitEnabled ? 2 : 0,
    });

    // Global-audit de-hardgate: the regex extractor only recognizes zh/en
    // signal phrases, so non-zh/en users' explicit commands and personal
    // facts never even reached the judge — memory silently did not exist for
    // them. One turn-level LLM extraction carries the multilingual coverage
    // (at most once per turn, only when the session's LLM judge is enabled
    // and the text is substantive). Regex candidates keep their existing
    // judged path; entries the extraction duplicates are dropped below.
    let llmExtraction: TurnMemoryExtractionChange[] = [];
    if (options.memoryLlmJudgeEnabled && isSubstantiveMemoryText(options.userText)) {
      try {
        llmExtraction = await judgeTurnMemoryExtraction({
          userText: options.userText,
          assistantText: options.assistantText,
          guardLevel: options.guardLevel,
          implicitEnabled: options.implicitEnabled,
        }) ?? [];
      } catch {
        llmExtraction = [];
      }
    }
    const regexExtractionKeys = new Set(
      extracted.map((change) => `${change.action}|${normalizeMemoryMatchKey(change.text)}`),
    );
    const llmOnlyChanges = llmExtraction.filter((change) => {
      const key = `${change.action}|${normalizeMemoryMatchKey(change.text)}`;
      return normalizeMemoryMatchKey(change.text).length > 0 && !regexExtractionKeys.has(key);
    });
    result.totalChanges = extracted.length + llmOnlyChanges.length;

    for (const change of extracted) {
      if (change.action === 'add') {
        if (!options.implicitEnabled && !change.isExplicit) {
          result.skipped += 1;
          continue;
        }
        // Conversation-memory quality gate (audit P1): deterministic, no LLM —
        // near-verbatim copies of the source message and chitchat/self-intro
        // candidates without a durable-fact predicate are rejected BEFORE the
        // judge (and its possible boundary LLM call). Explicit remember-
        // commands are never gated.
        const quality = evaluateConversationMemoryQuality({
          text: change.text,
          sourceText: options.userText,
          isExplicit: change.isExplicit,
        });
        if (!quality.accepted) {
          result.judgeRejected += 1;
          result.skipped += 1;
          continue;
        }
        const judge = await judgeMemoryCandidate({
          text: change.text,
          isExplicit: change.isExplicit,
          guardLevel: options.guardLevel,
          llmEnabled: options.memoryLlmJudgeEnabled,
        });
        if (judge.source === 'llm') {
          result.llmReviewed += 1;
        }
        if (!judge.accepted) {
          result.judgeRejected += 1;
          result.skipped += 1;
          continue;
        }

        let write;
        try {
          write = this.createOrReviveUserMemory({
          text: change.text,
          confidence: change.confidence,
          isExplicit: change.isExplicit,
          scope: resolvedScopes.writeScope,
          source: {
            role: 'user',
            sessionId: options.sessionId,
            messageId: options.userMessageId,
            sourceType: change.isExplicit ? 'turn_explicit' : 'turn_implicit',
            sourceId: options.userMessageId,
            quote: pickEvidenceQuote(options.userText, change.text) ?? undefined,
          },
          metabotId,
          });
        } catch (error) {
          if (error instanceof MemoryDefenseError) {
            result.defenseRejected += 1;
            result.skipped += 1;
            continue;
          }
          throw error;
        }

        if (!change.isExplicit && options.assistantMessageId) {
          this.addMemorySource(write.memory.id, metabotId, {
            role: 'assistant',
            sessionId: options.sessionId,
            messageId: options.assistantMessageId,
            sourceType: 'turn_assistant',
            sourceId: options.assistantMessageId,
            quote: pickEvidenceQuote(options.assistantText, change.text) ?? undefined,
          });
        }

        if (write.created) result.created += 1;
        else if (write.updated) result.updated += 1;
        else result.skipped += 1;
        continue;
      }

      if (this.deleteBestMatchingUserMemory(change.text, metabotId, resolvedScopes.writeScope)) {
        result.deleted += 1;
      } else {
        result.skipped += 1;
      }
    }

    // LLM-extracted entries are already curated by the extraction pass — no
    // second judge round. Same guard rules apply (explicit-only when implicit
    // updates are off) and the same best-match delete flow. The deterministic
    // conversation-memory quality gate (audit P1) still applies — the
    // extraction pass is exactly where the peer-intro/pleasantry verbatim
    // copies came from.
    for (const change of llmOnlyChanges) {
      if (change.action === 'add') {
        if (!options.implicitEnabled && !change.isExplicit) {
          result.skipped += 1;
          continue;
        }
        const quality = evaluateConversationMemoryQuality({
          text: change.text,
          sourceText: options.userText,
          isExplicit: change.isExplicit,
        });
        if (!quality.accepted) {
          result.skipped += 1;
          continue;
        }
        result.llmReviewed += 1;
        let write;
        try {
          write = this.createOrReviveUserMemory({
          text: change.text,
          confidence: change.isExplicit ? 0.95 : 0.8,
          isExplicit: change.isExplicit,
          scope: resolvedScopes.writeScope,
          source: {
            role: 'user',
            sessionId: options.sessionId,
            messageId: options.userMessageId,
            sourceType: change.isExplicit ? 'turn_explicit' : 'turn_llm',
            sourceId: options.userMessageId,
            quote: pickEvidenceQuote(options.userText, change.text) ?? undefined,
          },
          metabotId,
          occurredAt: resolveOccurredAtEpochMs(change.occurredOn) ?? undefined,
          });
        } catch (error) {
          if (error instanceof MemoryDefenseError) {
            result.defenseRejected += 1;
            result.skipped += 1;
            continue;
          }
          throw error;
        }
        if (write.created) result.created += 1;
        else if (write.updated) result.updated += 1;
        else result.skipped += 1;
        continue;
      }

      if (this.deleteBestMatchingUserMemory(change.text, metabotId, resolvedScopes.writeScope)) {
        result.deleted += 1;
      } else {
        result.skipped += 1;
      }
    }

    this.markOrphanImplicitMemoriesStale(metabotId, { scope: resolvedScopes.writeScope });
    this.saveDb();
    return result;
  }

  private getLatestMessageByType(sessionId: string, type: 'user' | 'assistant'): string {
    const row = this.getOne<{ content: string }>(`
      SELECT content
      FROM cowork_messages
      WHERE session_id = ? AND type = ?
      ORDER BY created_at DESC, ROWID DESC
      LIMIT 1
    `, [sessionId, type]);
    return truncate((row?.content || '').replace(/\s+/g, ' ').trim(), 280);
  }

  conversationSearch(options: {
    query: string;
    maxResults?: number;
    before?: string;
    after?: string;
    metabotId?: number | null;
  }): CoworkConversationSearchRecord[] {
    const terms = extractConversationSearchTerms(options.query);
    if (terms.length === 0) return [];

    const maxResults = Math.max(1, Math.min(10, Math.floor(options.maxResults ?? 5)));
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const useFts = this.canUseMessagesFts(terms);
    const likeClauses = terms.map(() => 'LOWER(m.content) LIKE ?');
    const clauses: string[] = [
      "m.type IN ('user', 'assistant')",
      useFts
        ? 'm.rowid IN (SELECT rowid FROM cowork_messages_fts WHERE cowork_messages_fts MATCH ?)'
        : `(${likeClauses.join(' OR ')})`,
    ];
    const params: Array<string | number> = useFts
      ? [terms.map(escapeFts5Phrase).join(' OR ')]
      : terms.map((term) => `%${term}%`);

    if (beforeMs !== null) {
      clauses.push('m.created_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('m.created_at > ?');
      params.push(afterMs);
    }
    const metabotId = parseIdNumber(options.metabotId);
    if (metabotId != null) {
      clauses.push('s.metabot_id = ?');
      params.push(metabotId);
    }

    const rows = this.getAll<{
      session_id: string;
      title: string;
      updated_at: number;
      type: string;
      content: string;
      created_at: number;
    }>(`
      SELECT m.session_id, s.title, s.updated_at, m.type, m.content, m.created_at
      FROM cowork_messages m
      INNER JOIN cowork_sessions s ON s.id = m.session_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ?
    `, [...params, maxResults * 40]);

    const bySession = new Map<string, CoworkConversationSearchRecord>();
    for (const row of rows) {
      if (!row.session_id) continue;
      let current = bySession.get(row.session_id);
      if (!current) {
        current = {
          sessionId: row.session_id,
          title: row.title || 'Untitled',
          updatedAt: Number(row.updated_at) || 0,
          url: `https://claude.ai/chat/${row.session_id}`,
          human: '',
          assistant: '',
        };
        bySession.set(row.session_id, current);
      }

      const snippet = truncate((row.content || '').replace(/\s+/g, ' ').trim(), 280);
      if (row.type === 'user' && !current.human) {
        current.human = snippet;
      }
      if (row.type === 'assistant' && !current.assistant) {
        current.assistant = snippet;
      }

      if (bySession.size >= maxResults) {
        const complete = Array.from(bySession.values()).every((entry) => entry.human && entry.assistant);
        if (complete) break;
      }
    }

    const records = Array.from(bySession.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxResults)
      .map((entry) => ({
        ...entry,
        human: entry.human || this.getLatestMessageByType(entry.sessionId, 'user'),
        assistant: entry.assistant || this.getLatestMessageByType(entry.sessionId, 'assistant'),
      }));

    return records;
  }

  /**
   * Verbatim message search inside ONE session — the in-conversation recall
   * path. DSH compacts long sessions silently, so early turns survive only
   * in this table; conversation_search deliberately skips the current
   * session. Same LIKE style as conversationSearch (`LOWER(content) LIKE
   * '%term%'`, terms pre-normalized by the caller): a row matches when ANY
   * term hits, then ranks by the number of matched terms, newest first.
   * Thinking drafts, sandbox-excluded rows and delegation internals never
   * surface — the bot should recall what the owner actually saw.
   */
  searchSessionMessages(sessionId: string, options: {
    terms: string[];
    limit?: number;
  }): CoworkSessionMessageSearchHit[] {
    const terms = (options.terms ?? [])
      .map((term) => String(term ?? '').toLowerCase().trim())
      .filter((term) => term.length > 0);
    if (!sessionId || terms.length === 0) return [];
    const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));

    const useFts = this.canUseMessagesFts(terms);
    const likeClauses = terms.map(() => 'LOWER(m.content) LIKE ?');
    const matchClause = useFts
      ? 'm.rowid IN (SELECT rowid FROM cowork_messages_fts WHERE cowork_messages_fts MATCH ?)'
      : `(${likeClauses.join(' OR ')})`;
    const matchParams = useFts
      ? [terms.map(escapeFts5Phrase).join(' OR ')]
      : terms.map((term) => `%${term}%`);
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT m.id, m.type, m.content, m.metadata, m.created_at, m.sequence
      FROM cowork_messages m
      WHERE m.session_id = ?
        AND m.type IN ('user', 'assistant')
        AND m.content IS NOT NULL AND TRIM(m.content) != ''
        AND (m.metadata IS NULL OR m.metadata NOT LIKE '%"isThinking":true%')
        AND (m.metadata IS NULL OR m.metadata NOT LIKE '%"excludeFromSandboxHistory":true%')
        AND (m.metadata IS NULL OR m.metadata NOT LIKE '%"isDelegationInternal":true%')
        AND ${matchClause}
      ORDER BY m.created_at DESC, COALESCE(m.sequence, 0) DESC, ROWID DESC
      LIMIT ?
    `, [sessionId, ...matchParams, limit * 40]);

    const scored = rows
      .map((row) => {
        const content = String(row.content ?? '');
        const lowered = content.toLowerCase();
        const matched = terms.reduce((count, term) => count + (lowered.includes(term) ? 1 : 0), 0);
        if (matched === 0) return null;
        let metadata: Record<string, unknown> | undefined;
        if (row.metadata) {
          try {
            const parsed = JSON.parse(row.metadata);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              metadata = parsed as Record<string, unknown>;
            }
          } catch {
            metadata = undefined;
          }
        }
        return {
          hit: {
            id: row.id,
            type: row.type as 'user' | 'assistant',
            createdAt: Number(row.created_at) || 0,
            content,
            ...(metadata ? { metadata } : {}),
          } satisfies CoworkSessionMessageSearchHit,
          matched,
        };
      })
      .filter((entry): entry is { hit: CoworkSessionMessageSearchHit; matched: number } => entry !== null)
      .sort((a, b) => (b.matched - a.matched) || (b.hit.createdAt - a.hit.createdAt) || (b.hit.id < a.hit.id ? -1 : b.hit.id > a.hit.id ? 1 : 0));

    return scored.slice(0, limit).map((entry) => entry.hit);
  }

  recentChats(options: {
    n?: number;
    sortOrder?: 'asc' | 'desc';
    before?: string;
    after?: string;
    metabotId?: number | null;
  }): CoworkConversationSearchRecord[] {
    const n = Math.max(1, Math.min(20, Math.floor(options.n ?? 3)));
    const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (beforeMs !== null) {
      clauses.push('updated_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('updated_at > ?');
      params.push(afterMs);
    }
    const metabotId = parseIdNumber(options.metabotId);
    if (metabotId != null) {
      clauses.push('metabot_id = ?');
      params.push(metabotId);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.getAll<{
      id: string;
      title: string;
      updated_at: number;
    }>(`
      SELECT id, title, updated_at
      FROM cowork_sessions
      ${whereClause}
      ORDER BY updated_at ${sortOrder.toUpperCase()}
      LIMIT ?
    `, [...params, n]);

    return rows.map((row) => ({
      sessionId: row.id,
      title: row.title || 'Untitled',
      updatedAt: Number(row.updated_at) || 0,
      url: `https://claude.ai/chat/${row.id}`,
      human: this.getLatestMessageByType(row.id, 'user'),
      assistant: this.getLatestMessageByType(row.id, 'assistant'),
    }));
  }

  /**
   * Recent-sessions pulse rows for the per-turn volatile tail: the bot's N
   * most recent OTHER sessions (same metabot scope) with the latest visible
   * exchange. Mirrors the session-list visibility rules — hidden, archived,
   * and superseded A2A episodes stay out — so the pulse never surfaces a
   * conversation the owner has deliberately put away. Read-only and cheap:
   * one indexed list query plus two point lookups per row.
   */
  recentSessionPulse(options: {
    metabotId: number;
    excludeSessionId?: string | null;
    limit?: number;
  }): RecentSessionPulseEntry[] {
    const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));
    const clauses: string[] = [
      's.metabot_id = ?',
      'COALESCE(s.hidden_from_session_list, 0) = 0',
      's.archived_at IS NULL',
      // Same thread-aggregation rule as listSessions: a superseded A2A
      // episode stays out; the thread's latest episode represents it.
      `NOT EXISTS (
        SELECT 1 FROM a2a_conversation_episodes episode
        WHERE episode.session_id = s.id AND episode.next_session_id IS NOT NULL
      )`,
      // IM GROUP conversations are untrusted external content. They stay
      // visible in the owner's local session list (by request), but they must
      // never be quoted into ANOTHER session's prompt — that would let a group
      // message enter a private-chat context.
      `NOT EXISTS (
        SELECT 1 FROM cowork_conversation_mappings group_map
        WHERE group_map.cowork_session_id = s.id
          AND group_map.channel >= 'im:' AND group_map.channel < 'im;'
          AND group_map.channel LIKE 'im:%:group'
      )`,
    ];
    const params: Array<string | number> = [options.metabotId];
    if (options.excludeSessionId) {
      clauses.push('s.id != ?');
      params.push(options.excludeSessionId);
    }
    const rows = this.getAll<{
      id: string;
      title: string;
      activity_at: number | null;
      updated_at: number;
    }>(`
      SELECT s.id, s.title,
        COALESCE(s.activity_at, ${coworkSessionActivityAtSelectSql('s')}) AS activity_at,
        s.updated_at
      FROM cowork_sessions s
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(s.activity_at, s.updated_at) DESC, s.updated_at DESC, s.created_at DESC
      LIMIT ?
    `, [...params, limit]);
    return rows
      .map((row) => ({
        sessionId: row.id,
        title: row.title || 'Untitled',
        activityAt: Number(row.activity_at ?? row.updated_at) || 0,
        human: this.getLatestMessageByType(row.id, 'user'),
        assistant: this.getLatestVisibleAssistantSnippet(row.id),
      }))
      .filter((row) => row.human || row.assistant);
  }

  private getLatestVisibleAssistantSnippet(sessionId: string): string {
    // Same visibility rule as getSessionLatestVisibleMessage: never surface a
    // thinking draft or a half-streamed placeholder as a session's last word.
    const row = this.getOne<{ content: string }>(`
      SELECT content
      FROM cowork_messages
      WHERE session_id = ? AND type = 'assistant'
        AND (metadata IS NULL OR metadata NOT LIKE '%"isThinking":true%')
        AND (metadata IS NULL OR metadata NOT LIKE '%"isStreaming":true%')
      ORDER BY created_at DESC, COALESCE(sequence, 0) DESC, ROWID DESC
      LIMIT 1
    `, [sessionId]);
    return truncate((row?.content || '').replace(/\s+/g, ' ').trim(), 280);
  }
}
