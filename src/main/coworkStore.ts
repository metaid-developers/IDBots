import { app } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SqliteDatabase as Database } from './sqliteTypes';
import { v4 as uuidv4 } from 'uuid';
import {
  extractTurnMemoryChanges,
  type CoworkMemoryGuardLevel,
} from './libs/coworkMemoryExtractor';
import { judgeMemoryCandidate } from './libs/coworkMemoryJudge';
import {
  parseSessionGoal,
  serializeSessionGoal,
  type CoworkSessionGoal,
} from './libs/coworkSessionGoal';
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
import { BOT_WORKSPACE_DIR_NAME } from './libs/botWorkspace';
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
} from './shared/a2aInternalMessageFilter';

// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  return path.join(os.homedir(), 'idbots', 'project');
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
const DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS = 20;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const MEMORY_NEAR_DUPLICATE_MIN_SCORE = 0.82;
const MEMORY_OPERATIONAL_PREFERENCE_RE = /(默认语言|回复格式|输出风格|回复风格|尽量简洁|保持简短|reply(?:\s+in)?|respond(?:\s+in)?|language|format|style|tone|markdown|concise|brief)/i;
const MEMORY_PREFERENCE_RE = /(偏好|喜欢|prefer|preference|likes?|dislikes?)/i;
const SCOPED_USER_MEMORIES_BACKFILL_KEY = 'userMemories.scopeBackfill.v1.completed';
const METAWEB_ORDER_SESSION_MIGRATION_KEY = 'cowork.metawebOrderSessionsToPeerConversations.v1.completed';
const METAWEB_ORDER_SIMPLEMSG_BACKFILL_KEY = 'cowork.backfillMetawebOrderSimplemsgMetadata.v1.completed';
const METAWEB_PRIVATE_SIMPLEMSG_BACKFILL_KEY = 'cowork.backfillMetawebPrivateSimplemsgMetadata.v1.completed';
const MEMORY_ROW_SELECT_COLUMNS = `
  id, text, fingerprint, confidence, is_explicit, status,
  created_at, updated_at, last_used_at, scope_kind, scope_key, usage_class, visibility, origin
`;
const PRIVATE_CHAT_SIMPLEMSG_BACKFILL_TIME_WINDOW_MS = 10 * 60 * 1000;

function normalizeMemoryGuardLevel(value: string | undefined): CoworkMemoryGuardLevel {
  if (value === 'strict' || value === 'standard' || value === 'relaxed') return value;
  return DEFAULT_MEMORY_GUARD_LEVEL;
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

function normalizeMemoryMatchKey(value: string): string {
  return normalizeMemoryText(value)
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMemorySemanticKey(value: string): string {
  const key = normalizeMemoryMatchKey(value);
  if (!key) return '';
  return key
    .replace(/^(?:the user|user|i am|i m|i|my|me)\s+/i, '')
    .replace(/^(?:该用户|这个用户|用户|本人|我的|我们|咱们|咱|我|你的|你)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTokenFrequencyMap(value: string): Map<string, number> {
  const tokens = value
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}

function scoreTokenOverlap(left: string, right: string): number {
  const leftMap = buildTokenFrequencyMap(left);
  const rightMap = buildTokenFrequencyMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [token, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(token) || 0);
  }

  const denominator = Math.min(leftCount, rightCount);
  if (denominator <= 0) return 0;
  return intersection / denominator;
}

function buildCharacterBigramMap(value: string): Map<string, number> {
  const compact = value.replace(/\s+/g, '').trim();
  if (!compact) return new Map<string, number>();
  if (compact.length <= 1) return new Map<string, number>([[compact, 1]]);

  const map = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function scoreCharacterBigramDice(left: string, right: string): number {
  const leftMap = buildCharacterBigramMap(left);
  const rightMap = buildCharacterBigramMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [gram, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(gram) || 0);
  }

  const denominator = leftCount + rightCount;
  if (denominator <= 0) return 0;
  return (2 * intersection) / denominator;
}

function scoreMemorySimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const compactLeft = left.replace(/\s+/g, '');
  const compactRight = right.replace(/\s+/g, '');
  if (compactLeft && compactLeft === compactRight) {
    return 1;
  }

  let phraseScore = 0;
  if (compactLeft && compactRight && (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) {
    phraseScore = Math.min(compactLeft.length, compactRight.length) / Math.max(compactLeft.length, compactRight.length);
  }

  return Math.max(
    phraseScore,
    scoreTokenOverlap(left, right),
    scoreCharacterBigramDice(left, right)
  );
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
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
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
export type CoworkSessionType = 'standard' | 'a2a' | 'browser' | 'group_task';
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
  suppressRunningStatus?: boolean;
  [key: string]: unknown;
}

export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
}

export interface CoworkMessagePage {
  messages: CoworkMessage[];
  hasMoreBefore: boolean;
  beforeSequence: number | null;
}

export interface CoworkA2AHistoryCursor {
  episodeIndex: number;
  beforeSequence: number;
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
  hiddenFromSessionList?: boolean;
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
  /** Per-session reasoning effort (off/low/high/max; null = follow the model default chain). */
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
  /** Owning MetaBot's display name, when attributed */
  metabotName?: string | null;
  /** Owning MetaBot's avatar (data URL or remote URL), when attributed */
  metabotAvatar?: string | null;
  /** Bot Browser context: URI of the tab this session is about (browser sessions only) */
  browserUri?: string | null;
  /** Bot Browser context: title of the tab this session is about (browser sessions only) */
  browserTitle?: string | null;
  /** Per-session model override (null = inherit the global default model). */
  model?: string | null;
  /** Provider key for the session model override (see CoworkSession.modelProvider). */
  modelProvider?: string | null;
  /** Per-session reasoning effort (off/low/high/max; null = follow the model default chain). */
  effort?: string | null;
  hiddenFromSessionList?: boolean;
  /** FK to projects.id; the Settings > Projects project this conversation is bound to. */
  projectId?: string | null;
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
  metabot_id?: number | null;
  scope_kind?: string | null;
  scope_key?: string | null;
  usage_class?: string | null;
  visibility?: string | null;
  origin?: string | null;
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

  // In-memory tracking of delegation-blocked sessions
  private delegationBlockedSessions: Map<string, { orderId: string }> = new Map();

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
    this.ensureMemorySchemaCompatibility();
    this.ensureMemoryPolicySchemaCompatibility();
    this.ensureConversationMappingSchemaCompatibility();
    this.ensureA2AConversationSchemaCompatibility();
    this.ensureCoworkMessageIndexes();
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
  } {
    return {
      migratedMetawebOrderSessions: this.migrateMetawebOrderSessionsToPeerConversations(),
      backfilledMetawebOrderMessages: this.backfillMetawebOrderSimplemsgMetadata(),
      backfilledMetawebPrivateMessages: this.backfillMetawebPrivateSimplemsgMetadata(),
    };
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

  private ensureCoworkSessionIndexes(): void {
    if (!this.tableExists('cowork_sessions')) {
      return;
    }
    try {
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_cowork_sessions_metabot_updated
        ON cowork_sessions(metabot_id, updated_at DESC)
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
      if (!sessionColumns.includes('effort')) {
        // Per-session reasoning effort (off/low/high/max; NULL = model default chain).
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
      this.backfillA2AConversationEpisodes();
      this.consolidateA2AConversationEpisodes();
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

  /**
   * Collapse sessions created by the retired A2A episode-rotation policy back
   * into the original session. The logical thread tables remain as compatibility
   * metadata, but each local-Bot/peer conversation now has one physical session.
   */
  private consolidateA2AConversationEpisodes(): void {
    const threadRows = this.getAll<{ thread_id: string }>(`
      SELECT thread_id
      FROM a2a_conversation_episodes
      GROUP BY thread_id
      HAVING COUNT(*) > 1
    `);
    if (threadRows.length === 0) return;

    this.db.run('BEGIN TRANSACTION');
    try {
      for (const { thread_id: threadId } of threadRows) {
        const episodes = this.getAll<{
          session_id: string;
          episode_index: number | string;
          started_at: number | string;
          status: string;
          pinned: number | string;
          peer_name: string | null;
          peer_avatar: string | null;
          updated_at: number | string;
        }>(`
          SELECT
            e.session_id,
            e.episode_index,
            e.started_at,
            s.status,
            s.pinned,
            s.peer_name,
            s.peer_avatar,
            s.updated_at
          FROM a2a_conversation_episodes e
          JOIN cowork_sessions s ON s.id = e.session_id
          WHERE e.thread_id = ?
          ORDER BY e.episode_index ASC, e.started_at ASC, e.session_id ASC
        `, [threadId]);
        if (episodes.length < 2) continue;

        const canonical = episodes[0];
        const latest = episodes[episodes.length - 1];
        const sessionIds = episodes.map((episode) => episode.session_id);
        const retiredSessionIds = sessionIds.slice(1);
        const placeholders = sessionIds.map(() => '?').join(', ');
        const retiredPlaceholders = retiredSessionIds.map(() => '?').join(', ');
        const messages = this.getAll<{ id: string }>(`
          SELECT m.id
          FROM cowork_messages m
          JOIN a2a_conversation_episodes e ON e.session_id = m.session_id
          WHERE m.session_id IN (${placeholders})
          ORDER BY e.episode_index ASC, COALESCE(m.sequence, 0) ASC, m.created_at ASC, m.id ASC
        `, sessionIds);

        messages.forEach((message, index) => {
          this.db.run(`
            UPDATE cowork_messages
            SET session_id = ?, sequence = ?
            WHERE id = ?
          `, [canonical.session_id, index + 1, message.id]);
        });

        this.db.run(`
          DELETE FROM cowork_conversation_mappings
          WHERE channel = 'cowork_ui'
            AND cowork_session_id IN (${retiredPlaceholders})
        `, retiredSessionIds);
        this.db.run(`
          UPDATE cowork_conversation_mappings
          SET cowork_session_id = ?
          WHERE cowork_session_id IN (${retiredPlaceholders})
        `, [canonical.session_id, ...retiredSessionIds]);

        const referenceColumns = [
          ['service_orders', 'cowork_session_id'],
          ['scheduled_tasks', 'cowork_session_id'],
          ['scheduled_task_runs', 'session_id'],
          ['user_memory_sources', 'session_id'],
          ['metabot_dream_fragments', 'session_id'],
          ['im_session_mappings', 'cowork_session_id'],
        ] as const;
        for (const [table, column] of referenceColumns) {
          if (!this.tableExists(table)) continue;
          this.db.run(`
            UPDATE ${table}
            SET ${column} = ?
            WHERE ${column} IN (${retiredPlaceholders})
          `, [canonical.session_id, ...retiredSessionIds]);
        }
        this.db.run(`
          UPDATE cowork_sessions
          SET parent_session_id = ?
          WHERE parent_session_id IN (${retiredPlaceholders})
        `, [canonical.session_id, ...retiredSessionIds]);

        const mappings = this.getAll<{
          channel: string;
          external_conversation_id: string;
          metabot_id: number | string;
          metadata_json: string | null;
        }>(`
          SELECT channel, external_conversation_id, metabot_id, metadata_json
          FROM cowork_conversation_mappings
          WHERE cowork_session_id = ?
            AND channel IN ('metaweb_private', 'cowork_ui')
        `, [canonical.session_id]);
        for (const mapping of mappings) {
          let metadata: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(mapping.metadata_json || '{}') as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              metadata = { ...parsed as Record<string, unknown> };
            }
          } catch {
            // Preserve the mapping even when legacy metadata is malformed.
          }
          for (const key of [
            'previousEpisodeSessionId',
            'nextEpisodeSessionId',
            'episodeReason',
            'episodeRestartRequestedAt',
            'episodeClosedAt',
            'episodeCloseReason',
          ]) {
            delete metadata[key];
          }
          metadata.a2aThreadId = threadId;
          metadata.episodeIndex = 1;
          metadata.episodeStartedAt = Number(canonical.started_at);
          this.db.run(`
            UPDATE cowork_conversation_mappings
            SET metadata_json = ?
            WHERE channel = ? AND external_conversation_id = ? AND metabot_id = ?
          `, [
            JSON.stringify(metadata),
            mapping.channel,
            mapping.external_conversation_id,
            Number(mapping.metabot_id),
          ]);
        }

        const latestUpdatedAt = Math.max(...episodes.map((episode) => Number(episode.updated_at) || 0));
        const pinned = episodes.some((episode) => Number(episode.pinned) === 1) ? 1 : 0;
        this.db.run(`
          UPDATE cowork_sessions
          SET status = ?,
              pinned = ?,
              peer_name = COALESCE(?, peer_name),
              peer_avatar = COALESCE(?, peer_avatar),
              archived_at = NULL,
              updated_at = ?
          WHERE id = ?
        `, [
          latest.status,
          pinned,
          latest.peer_name,
          latest.peer_avatar,
          latestUpdatedAt,
          canonical.session_id,
        ]);
        this.db.run(`
          DELETE FROM a2a_conversation_episodes
          WHERE session_id IN (${retiredPlaceholders})
        `, retiredSessionIds);
        this.db.run(`
          UPDATE a2a_conversation_episodes
          SET episode_index = 1,
              previous_session_id = NULL,
              next_session_id = NULL,
              ended_at = NULL,
              close_reason = NULL
          WHERE session_id = ?
        `, [canonical.session_id]);
        this.db.run(`
          DELETE FROM cowork_sessions
          WHERE id IN (${retiredPlaceholders})
        `, retiredSessionIds);
        this.db.run(`
          UPDATE a2a_conversation_threads
          SET updated_at = ?
          WHERE id = ?
        `, [latestUpdatedAt, threadId]);
      }

      this.db.run('COMMIT');
      this.saveDb();
    } catch (error) {
      this.db.run('ROLLBACK');
      console.warn('[CoworkStore] Failed to consolidate A2A conversation episodes:', error);
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
    };
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
        source: 'global',
      };
    }

    const row = this.getOne<CoworkMemoryPolicyRow>(`
      SELECT metabot_id, memory_enabled, memory_implicit_update_enabled, memory_llm_judge_enabled,
             memory_guard_level, memory_user_memories_max_items, dream_enabled, updated_at
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
    const now = Date.now();

    this.db.run(`
      INSERT INTO metabot_memory_policies (
        metabot_id, memory_enabled, memory_implicit_update_enabled, memory_llm_judge_enabled,
        memory_guard_level, memory_user_memories_max_items, dream_enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id) DO UPDATE SET
        memory_enabled = excluded.memory_enabled,
        memory_implicit_update_enabled = excluded.memory_implicit_update_enabled,
        memory_llm_judge_enabled = excluded.memory_llm_judge_enabled,
        memory_guard_level = excluded.memory_guard_level,
        memory_user_memories_max_items = excluded.memory_user_memories_max_items,
        dream_enabled = excluded.dream_enabled,
        updated_at = excluded.updated_at
    `, [
      resolvedMetabotId,
      nextMemoryEnabled ? 1 : 0,
      nextImplicit ? 1 : 0,
      nextJudge ? 1 : 0,
      nextGuard,
      nextMaxItems,
      nextDreamEnabled ? 1 : 0,
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
    goal: CoworkSessionGoal | null = null
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db.run(`
      INSERT INTO cowork_sessions (id, title, claude_session_id, status, cwd, system_prompt, execution_mode, active_skill_ids, metabot_id, pinned, session_type, peer_global_metaid, peer_name, peer_avatar, permission_mode, model, effort, model_provider, project_id, goal, created_at, updated_at)
      VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, title, cwd, systemPrompt, resolveCoworkExecutionMode(executionMode), JSON.stringify(activeSkillIds), metabotId, sessionType, peerGlobalMetaId, peerName, peerAvatar, permissionMode, model, effort, modelProvider, projectId, goal ? serializeSessionGoal(goal) : null, now, now]);

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
      permissionMode,
      model,
      effort,
      modelProvider,
      projectId,
      goal,
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

  getSessionView(id: string, messageLimit: number = 100): CoworkSession | null {
    const session = this.getSessionWithoutMessages(id);
    if (!session) return null;
    if (session.sessionType !== 'a2a') {
      return {
        ...session,
        messages: this.getSessionMessages(id),
      };
    }
    const page = this.getSessionMessagesPage(id, { limit: messageLimit, displayWindow: true });
    return {
      ...session,
      messages: page.messages,
      messageHistory: {
        hasMoreBefore: page.hasMoreBefore,
        beforeSequence: page.beforeSequence,
        pageSize: Math.max(1, Math.min(200, Math.floor(messageLimit))),
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
      hidden_from_session_list?: number | null;
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

    const row = this.getOne<SessionRow>(`
      SELECT id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids, metabot_id,
             session_type, peer_global_metaid, peer_name, peer_avatar, browser_uri, browser_title, hidden_from_session_list, permission_mode, parent_session_id, fork_point_message_id, model, model_provider, effort, project_id, goal, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
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
      browserUri: row.browser_uri ?? null,
      browserTitle: row.browser_title ?? null,
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
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
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
    if (updates.parentSessionId !== undefined) {
      setClauses.push('parent_session_id = ?');
      values.push(updates.parentSessionId);
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

  listSessions(options?: { metabotId?: number | null }): CoworkSessionSummary[] {
    interface SessionSummaryRow {
      id: string;
      title: string;
      status: string;
      pinned: number | null;
      metabot_id?: number | null;
      session_type?: string | null;
      peer_name?: string | null;
      peer_avatar?: string | null;
      metabot_name?: string | null;
      metabot_avatar?: string | Uint8Array | null;
      browser_uri?: string | null;
      browser_title?: string | null;
      hidden_from_session_list?: number | null;
      model?: string | null;
      model_provider?: string | null;
      effort?: string | null;
      project_id?: string | null;
      created_at: number;
      updated_at: number;
      activity_at?: number | null;
    }

    const metabotId = options?.metabotId;
    const filterByMetabot = typeof metabotId === 'number' && Number.isInteger(metabotId) && metabotId > 0;
    const rows = this.getAll<SessionSummaryRow>(`
      SELECT
        s.id,
        s.title,
        s.status,
        s.pinned,
        s.metabot_id,
        s.session_type,
        s.peer_name,
        s.peer_avatar,
        mb.name AS metabot_name,
        mb.avatar AS metabot_avatar,
        s.browser_uri,
        s.browser_title,
        s.hidden_from_session_list,
        s.model,
        s.model_provider,
        s.effort,
        s.project_id,
        s.created_at,
        s.updated_at,
        -- Sort by the LAST USER MESSAGE time (fixed once a turn is sent), not
        -- the newest assistant stream message: while tasks run, stream updates
        -- no longer reshuffle the session list top (no more flickering).
        -- Sessions without a user message fall back to newest message, then
        -- updated_at. Stable tie-breakers keep the order deterministic.
        COALESCE((
          SELECT m.created_at
          FROM cowork_messages m INDEXED BY idx_cowork_messages_session_created_at
          WHERE m.session_id = s.id AND m.type = 'user'
          ORDER BY m.created_at DESC
          LIMIT 1
        ), (
          SELECT m.created_at
          FROM cowork_messages m INDEXED BY idx_cowork_messages_session_created_at
          WHERE m.session_id = s.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ), s.updated_at) AS activity_at
      FROM cowork_sessions s
      LEFT JOIN metabots mb ON mb.id = s.metabot_id
      WHERE COALESCE(s.hidden_from_session_list, 0) = 0
      AND s.archived_at IS NULL
      ${filterByMetabot ? 'AND s.metabot_id = ?' : ''}
      ORDER BY s.pinned DESC, activity_at DESC, s.updated_at DESC, s.created_at DESC, s.id DESC
    `, filterByMetabot ? [metabotId] : []);

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
      metabotName: row.metabot_name ?? null,
      metabotAvatar: normalizeMetabotAvatarForDisplay(row.metabot_avatar),
      browserUri: row.browser_uri ?? null,
      browserTitle: row.browser_title ?? null,
      hiddenFromSessionList: Boolean(row.hidden_from_session_list),
      model: row.model ?? null,
      modelProvider: row.model_provider ?? null,
      effort: row.effort ?? null,
      projectId: row.project_id ?? null,
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
        titleClauses.push(`EXISTS (
          SELECT 1 FROM cowork_messages m
          WHERE m.session_id = s.id AND LOWER(m.content) LIKE ? ESCAPE '\\'
        )`);
        params.push(`%${escaped}%`);
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
   * Archived conversations for the Settings "Archived Chats" panel: sessions
   * put away by the user (records preserved), newest archive first. Separate
   * from listSessions, which deliberately excludes archived rows.
   */
  listArchivedSessions(options?: {
    metabotId?: number | null;
    query?: string;
    searchContent?: boolean;
    sessionType?: CoworkSessionType;
    limit?: number;
    offset?: number;
  }): CoworkSessionSummary[] {
    interface ArchivedSessionRow {
      id: string;
      title: string;
      status: string;
      pinned: number | null;
      metabot_id?: number | null;
      session_type?: string | null;
      peer_name?: string | null;
      browser_uri?: string | null;
      browser_title?: string | null;
      hidden_from_session_list?: number | null;
      model?: string | null;
      model_provider?: string | null;
      effort?: string | null;
      project_id?: string | null;
      archived_at: number;
      created_at: number;
      updated_at: number;
    }

    const { clauses, params } = this.buildArchivedSessionFilter(options);
    const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));

    const rows = this.getAll<ArchivedSessionRow>(`
      SELECT
        s.id, s.title, s.status, s.pinned, s.metabot_id, s.session_type, s.peer_name,
        s.browser_uri, s.browser_title, s.hidden_from_session_list, s.model, s.model_provider, s.effort, s.project_id,
        s.archived_at, s.created_at, s.updated_at
      FROM cowork_sessions s
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.archived_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return rows.map(row => ({
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
      hiddenFromSessionList: Boolean(row.hidden_from_session_list),
      model: row.model ?? null,
      modelProvider: row.model_provider ?? null,
      effort: row.effort ?? null,
      projectId: row.project_id ?? null,
    }));
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

  markInterruptedSteersAfterRestart(now: number = Date.now()): number {
    if (!this.tableExists('cowork_messages')) {
      return 0;
    }

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

  private getSessionMessages(sessionId: string): CoworkMessage[] {
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY
        created_at ASC,
        COALESCE(sequence, 0) ASC,
        ROWID ASC
    `, [sessionId]);

    return rows.map(row => ({
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
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

  getSessionMessagesPage(
    sessionId: string,
    options?: { beforeSequence?: number | null; limit?: number; displayWindow?: boolean },
  ): CoworkMessagePage {
    const requestedLimit = Number(options?.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, Math.floor(requestedLimit)))
      : 100;
    const requestedBeforeSequence = Number(options?.beforeSequence);
    const beforeSequence = Number.isFinite(requestedBeforeSequence) && requestedBeforeSequence > 0
      ? Math.floor(requestedBeforeSequence)
      : null;
    if (options?.displayWindow === true) {
      return this.getA2ADisplayMessagesPage(sessionId, { beforeSequence, limit });
    }
    return this.getRawSessionMessagesPage(sessionId, { beforeSequence, limit });
  }

  private mapCoworkMessageRow(row: CoworkMessageRow): CoworkMessage {
    return {
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Newest-first SQL page. `hasMoreBefore` means older rows exist beyond this chunk.
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
      FROM cowork_messages INDEXED BY idx_cowork_messages_session_sequence
      WHERE session_id = ?
      ${beforeClause}
      ORDER BY
        COALESCE(sequence, 0) DESC,
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

  private getRawSessionMessagesPage(
    sessionId: string,
    options: { beforeSequence: number | null; limit: number },
  ): CoworkMessagePage {
    const { rows, hasMoreBefore } = this.querySessionMessageRows(sessionId, options);
    const oldestSequence = rows.length > 0
      ? Number(rows[rows.length - 1]?.sequence)
      : null;

    return {
      messages: rows.slice().reverse().map((row) => this.mapCoworkMessageRow(row)),
      hasMoreBefore,
      beforeSequence: hasMoreBefore && Number.isFinite(oldestSequence) && Number(oldestSequence) > 0
        ? Number(oldestSequence)
        : null,
    };
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
        if (!shouldHideA2AInternalMessage(message)) {
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
    let cursor: number | null = beforeSequence;
    const chunkSize = 100;
    for (let chunkIndex = 0; chunkIndex < 40 && cursor != null; chunkIndex += 1) {
      const { rows, hasMoreBefore } = this.querySessionMessageRows(sessionId, {
        beforeSequence: cursor,
        limit: chunkSize,
      });
      if (rows.some((row) => !shouldHideA2AInternalMessage(this.mapCoworkMessageRow(row)))) {
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
    const params: Array<string | number> = [anchor.thread_id];
    let cursorClause = 'AND episode.episode_index <= ?';
    if (cursorEpisodeIndex != null && cursorBeforeSequence != null) {
      cursorClause = `
        AND (
          episode.episode_index < ?
          OR (episode.episode_index = ? AND COALESCE(message.sequence, 0) < ?)
        )
      `;
      params.push(cursorEpisodeIndex, cursorEpisodeIndex, cursorBeforeSequence);
    } else {
      params.push(anchorEpisodeIndex);
    }
    params.push(limit + 1);

    const rows = this.getAll<CoworkA2AHistoryRow>(`
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
    const hasMoreBefore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const oldest = pageRows[pageRows.length - 1];

    return {
      threadId: thread.id,
      participantPairKey: thread.participant_pair_key,
      messages: pageRows.reverse().map((row) => ({
        sessionId: row.session_id,
        episodeIndex: parseIdNumber(row.episode_index) ?? 1,
        message: {
          id: row.id,
          type: row.type as CoworkMessageType,
          content: row.content,
          timestamp: row.created_at,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        },
      })),
      hasMoreBefore,
      beforeCursor: hasMoreBefore && oldest
        ? {
            episodeIndex: parseIdNumber(oldest.episode_index) ?? 1,
            beforeSequence: parseIdNumber(oldest.sequence) ?? 1,
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

    this.db.run(`
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      sessionId,
      message.type,
      message.content,
      message.metadata ? JSON.stringify(message.metadata) : null,
      now,
      sequence,
    ]);

    this.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);
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

    const rows = this.getAll<OrderMappingRow>(`
      SELECT
        m.channel,
        m.external_conversation_id,
        m.metabot_id,
        m.cowork_session_id,
        m.metadata_json,
        s.title,
        s.cwd,
        s.system_prompt,
        s.execution_mode,
        s.session_type,
        s.peer_global_metaid,
        s.peer_name,
        s.peer_avatar,
        s.created_at,
        s.updated_at
      FROM cowork_conversation_mappings m
      LEFT JOIN cowork_sessions s ON s.id = m.cowork_session_id
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
      source.modelProvider ?? null
    );

    // Batch-copy messages preserving ids/timestamps/sequences with one flush.
    for (const message of forkMessages) {
      const sequenceRow = this.db.exec(`
        SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
        FROM cowork_messages
        WHERE session_id = ?
      `, [forked.id]);
      const sequence = sequenceRow[0]?.values[0]?.[0] as number || 1;
      this.db.run(`
        INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        message.id,
        forked.id,
        message.type,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.timestamp,
        sequence,
      ]);
    }
    this.db.run(`
      UPDATE cowork_sessions
      SET parent_session_id = ?, fork_point_message_id = ?, updated_at = ?
      WHERE id = ?
    `, [sourceSessionId, forkPointMessageId, Date.now(), forked.id]);
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
    this.db.run(`
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      sessionId,
      message.type,
      message.content,
      message.metadata ? JSON.stringify(message.metadata) : null,
      timestamp,
      sequence,
    ]);
    this.db.run('UPDATE cowork_sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?', [timestamp, sessionId]);
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
      text: row.text,
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
        message_id, role, is_active, created_at, dream_date
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
    ]);
  }

  private createOrReviveUserMemory(input: MemoryCreateUserMemoryInput): { memory: CoworkUserMemory; created: boolean; updated: boolean } {
    const normalizedText = truncate(normalizeMemoryText(input.text), maxMemoryTextChars(input.usageClass));
    if (!normalizedText) {
      throw new Error('Memory text is required');
    }

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
      this.db.run(`
        UPDATE user_memories
        SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = 'created',
            usage_class = ?, visibility = ?, updated_at = ?
        WHERE id = ? AND metabot_id = ? AND scope_kind = ? AND scope_key = ?
      `, [
        mergedText,
        buildMemoryFingerprint(mergedText),
        mergedConfidence,
        mergedExplicit,
        mergedClassification.usageClass,
        mergedClassification.visibility,
        now,
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
    this.db.run(`
      INSERT INTO user_memories (
        id, metabot_id, text, fingerprint, confidence, is_explicit, status,
        scope_kind, scope_key, usage_class, visibility, origin, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, NULL)
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

    const rows = this.getAll<CoworkUserMemoryRow>(`
      SELECT ${MEMORY_ROW_SELECT_COLUMNS}
      FROM user_memories
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const entries = rows.map((row) => this.mapMemoryRow(row));
    if (options.touchLastUsed) {
      this.touchUserMemoriesLastUsed(metabotId, entries.map((entry) => entry.id));
    }
    return entries;
  }

  private touchUserMemoriesLastUsed(metabotId: number, memoryIds: string[]): void {
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
      this.saveDb();
    }
  }

  createUserMemory(input: MemoryCreateUserMemoryInput): CoworkUserMemory {
    const result = this.createOrReviveUserMemory(input);
    this.saveDb();
    return result.memory;
  }

  /**
   * Insert capability-learning candidates from a dream run into
   * `capability_drafts` (L3b procedural-memory drafts, SDD §4.1). Every row is
   * written with status 'draft'; promotion into real skills is a later phase
   * and this method never touches the skill tables (R4.3 — no pollution).
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

  /** Read capability drafts, newest first; scoped to one MetaBot when `metabotId` is given. */
  listCapabilityDrafts(metabotId?: number): CapabilityDraft[] {
    const rows = metabotId !== undefined && Number.isInteger(metabotId)
      ? this.getAll<CapabilityDraftRow>(`
          SELECT id, metabot_id, dream_date, title, description, capability_type, status, created_at
          FROM capability_drafts
          WHERE metabot_id = ?
          ORDER BY created_at DESC, id DESC
        `, [metabotId])
      : this.getAll<CapabilityDraftRow>(`
          SELECT id, metabot_id, dream_date, title, description, capability_type, status, created_at
          FROM capability_drafts
          ORDER BY created_at DESC, id DESC
        `);
    return rows.map((row) => ({
      id: Number(row.id),
      metabotId: Number(row.metabot_id),
      dreamDate: String(row.dream_date),
      title: String(row.title),
      description: String(row.description),
      capabilityType: String(row.capability_type),
      status: String(row.status),
      createdAt: Number(row.created_at),
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
      ? truncate(normalizeMemoryText(input.text), maxMemoryTextChars(input.usageClass ?? current.usage_class))
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

    this.db.run(`
      UPDATE user_memories
      SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = ?,
          usage_class = ?, visibility = ?, updated_at = ?
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

  async applyTurnMemoryUpdates(options: ApplyTurnMemoryUpdatesOptions): Promise<ApplyTurnMemoryUpdatesResult> {
    const result: ApplyTurnMemoryUpdatesResult = {
      totalChanges: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      judgeRejected: 0,
      llmReviewed: 0,
      skipped: 0,
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
    result.totalChanges = extracted.length;

    for (const change of extracted) {
      if (change.action === 'add') {
        if (!options.implicitEnabled && !change.isExplicit) {
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

        const write = this.createOrReviveUserMemory({
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
          },
          metabotId,
        });

        if (!change.isExplicit && options.assistantMessageId) {
          this.addMemorySource(write.memory.id, metabotId, {
            role: 'assistant',
            sessionId: options.sessionId,
            messageId: options.assistantMessageId,
            sourceType: 'turn_assistant',
            sourceId: options.assistantMessageId,
          });
        }

        if (write.created) result.created += 1;
        else if (write.updated) result.updated += 1;
        else result.skipped += 1;
        continue;
      }

      const key = normalizeMemoryMatchKey(change.text);
      if (!key) {
        result.skipped += 1;
        continue;
      }

      const candidates = this.listUserMemories({
        metabotId,
        scope: resolvedScopes.writeScope,
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

      if (!target) {
        result.skipped += 1;
        continue;
      }

      const deleted = this.deleteUserMemory({
        id: target.id,
        metabotId,
        scope: resolvedScopes.writeScope,
      });
      if (deleted) result.deleted += 1;
      else result.skipped += 1;
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

    const likeClauses = terms.map(() => 'LOWER(m.content) LIKE ?');
    const clauses: string[] = [
      "m.type IN ('user', 'assistant')",
      `(${likeClauses.join(' OR ')})`,
    ];
    const params: Array<string | number> = terms.map((term) => `%${term}%`);

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
}
