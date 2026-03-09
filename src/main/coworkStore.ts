import { app } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import {
  extractTurnMemoryChanges,
  isQuestionLikeMemoryText,
  type CoworkMemoryGuardLevel,
} from './libs/coworkMemoryExtractor';
import { judgeMemoryCandidate } from './libs/coworkMemoryJudge';

// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  return path.join(os.homedir(), 'idbots', 'project');
};

const TASK_WORKSPACE_CONTAINER_DIR = '.idbots-tasks';

const normalizeRecentWorkspacePath = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}${TASK_WORKSPACE_CONTAINER_DIR}${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex > 0) {
    return resolved.slice(0, markerIndex);
  }
  return resolved;
};

const DEFAULT_MEMORY_ENABLED = true;
const DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED = true;
const DEFAULT_MEMORY_LLM_JUDGE_ENABLED = true;
const DEFAULT_MEMORY_GUARD_LEVEL: CoworkMemoryGuardLevel = 'strict';
const DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS = 12;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const MEMORY_NEAR_DUPLICATE_MIN_SCORE = 0.82;
const MEMORY_PROCEDURAL_TEXT_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const MEMORY_ASSISTANT_STYLE_TEXT_RE = /^(?:使用|use)\s+[A-Za-z0-9._-]+\s*(?:技能|skill)/i;

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

function shouldAutoDeleteMemoryText(text: string): boolean {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return false;
  return MEMORY_ASSISTANT_STYLE_TEXT_RE.test(normalized)
    || MEMORY_PROCEDURAL_TEXT_RE.test(normalized)
    || isQuestionLikeMemoryText(normalized);
}

// Types mirroring src/types/cowork.ts for main process use
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';
export type CoworkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';

export interface CoworkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  skillIds?: string[];
  [key: string]: unknown;
}

export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
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
  createdAt: number;
  updatedAt: number;
  /** FK to metabots.id; which MetaBot persona this session uses */
  metabotId?: number | null;
}

export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CoworkUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface CoworkUserMemory {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: CoworkUserMemoryStatus;
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
}

export interface CoworkMemoryPolicy {
  metabotId: number;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  updatedAt: number;
}

export interface CoworkEffectiveMemoryPolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
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
}

interface CoworkMemoryPolicyRow {
  metabot_id: number | string;
  memory_enabled: number | string | null;
  memory_implicit_update_enabled: number | string | null;
  memory_llm_judge_enabled: number | string | null;
  memory_guard_level: string | null;
  memory_user_memories_max_items: number | string | null;
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

export class CoworkStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureSchemaCompatibility();
  }

  private ensureSchemaCompatibility(): void {
    this.ensureMemorySchemaCompatibility();
    this.ensureMemoryPolicySchemaCompatibility();
    this.ensureConversationMappingSchemaCompatibility();
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
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify cowork_sessions metabot_id column:', error);
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
    } catch (error) {
      console.warn('[CoworkStore] Failed to verify user_memories metabot_id column:', error);
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

  /** Resolve metabot_id from sessionId or use default twin. Returns null only if no default. */
  resolveMetabotIdForMemory(sessionId?: string | null): number | null {
    if (sessionId) {
      const fromSession = this.getMetabotIdForSession(sessionId);
      if (fromSession != null) return fromSession;
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
        source: 'global',
      };
    }

    const row = this.getOne<CoworkMemoryPolicyRow>(`
      SELECT metabot_id, memory_enabled, memory_implicit_update_enabled, memory_llm_judge_enabled,
             memory_guard_level, memory_user_memories_max_items, updated_at
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
    const now = Date.now();

    this.db.run(`
      INSERT INTO metabot_memory_policies (
        metabot_id, memory_enabled, memory_implicit_update_enabled, memory_llm_judge_enabled,
        memory_guard_level, memory_user_memories_max_items, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metabot_id) DO UPDATE SET
        memory_enabled = excluded.memory_enabled,
        memory_implicit_update_enabled = excluded.memory_implicit_update_enabled,
        memory_llm_judge_enabled = excluded.memory_llm_judge_enabled,
        memory_guard_level = excluded.memory_guard_level,
        memory_user_memories_max_items = excluded.memory_user_memories_max_items,
        updated_at = excluded.updated_at
    `, [
      resolvedMetabotId,
      nextMemoryEnabled ? 1 : 0,
      nextImplicit ? 1 : 0,
      nextJudge ? 1 : 0,
      nextGuard,
      nextMaxItems,
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
      updatedAt: now,
    };
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

    let row = this.getOne<CoworkConversationMappingRow>(`
      SELECT channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      FROM cowork_conversation_mappings
      WHERE channel = ? AND external_conversation_id = ? AND metabot_id = ?
      LIMIT 1
    `, [normalizedChannel, normalizedConversationId, normalizedMetabotId]);

    if (!row && normalizedMetabotId !== 0) {
      row = this.getOne<CoworkConversationMappingRow>(`
        SELECT channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
        FROM cowork_conversation_mappings
        WHERE channel = ? AND external_conversation_id = ? AND metabot_id = 0
        LIMIT 1
      `, [normalizedChannel, normalizedConversationId]);
    }

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
    if (!sessionId) {
      return {
        sourceChannel: 'cowork_ui',
        externalConversationId: null,
      };
    }
    const row = this.getOne<{ channel: string; external_conversation_id: string | null }>(`
      SELECT channel, external_conversation_id
      FROM cowork_conversation_mappings
      WHERE cowork_session_id = ?
      ORDER BY
        CASE WHEN channel = 'cowork_ui' THEN 1 ELSE 0 END ASC,
        last_active_at DESC
      LIMIT 1
    `, [sessionId]);
    if (!row) {
      return {
        sourceChannel: 'cowork_ui',
        externalConversationId: sessionId,
      };
    }
    return {
      sourceChannel: row.channel || 'cowork_ui',
      externalConversationId: row.external_conversation_id ?? sessionId,
    };
  }

  createSession(
    title: string,
    cwd: string,
    systemPrompt: string = '',
    executionMode: CoworkExecutionMode = 'local',
    activeSkillIds: string[] = [],
    metabotId: number | null = null
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db.run(`
      INSERT INTO cowork_sessions (id, title, claude_session_id, status, cwd, system_prompt, execution_mode, active_skill_ids, metabot_id, pinned, created_at, updated_at)
      VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, 0, ?, ?)
    `, [id, title, cwd, systemPrompt, executionMode, JSON.stringify(activeSkillIds), metabotId, now, now]);

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
      executionMode,
      activeSkillIds,
      messages: [],
      createdAt: now,
      updatedAt: now,
      metabotId: metabotId ?? undefined,
    };
  }

  getSession(id: string): CoworkSession | null {
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
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SessionRow>(`
      SELECT id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids, metabot_id, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
    `, [id]);

    if (!row) return null;

    const messages = this.getSessionMessages(id);

    let activeSkillIds: string[] = [];
    if (row.active_skill_ids) {
      try {
        activeSkillIds = JSON.parse(row.active_skill_ids);
      } catch {
        activeSkillIds = [];
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
      executionMode: (row.execution_mode as CoworkExecutionMode) || 'local',
      activeSkillIds,
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metabotId: parseIdNumber(row.metabot_id) ?? undefined,
    };
  }

  updateSession(
    id: string,
    updates: Partial<Pick<CoworkSession, 'title' | 'claudeSessionId' | 'status' | 'cwd' | 'systemPrompt' | 'executionMode'>>
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
      values.push(updates.executionMode);
    }

    values.push(id);
    this.db.run(`
      UPDATE cowork_sessions
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `, values);

    this.saveDb();
  }

  deleteSession(id: string): void {
    const metabotId = this.getMetabotIdForSession(id) ?? this.getDefaultMetabotId();
    this.markMemorySourcesInactiveBySession(id);
    this.db.run('DELETE FROM cowork_conversation_mappings WHERE cowork_session_id = ?', [id]);
    this.db.run('DELETE FROM cowork_sessions WHERE id = ?', [id]);
    if (metabotId != null) {
      this.markOrphanImplicitMemoriesStale(metabotId);
    }
    this.saveDb();
  }

  setSessionPinned(id: string, pinned: boolean): void {
    this.db.run('UPDATE cowork_sessions SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
    this.saveDb();
  }

  listSessions(): CoworkSessionSummary[] {
    interface SessionSummaryRow {
      id: string;
      title: string;
      status: string;
      pinned: number | null;
      created_at: number;
      updated_at: number;
    }

    const rows = this.getAll<SessionSummaryRow>(`
      SELECT id, title, status, pinned, created_at, updated_at
      FROM cowork_sessions
      ORDER BY pinned DESC, updated_at DESC
    `);

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  resetRunningSessions(): number {
    const now = Date.now();
    this.db.run(`
      UPDATE cowork_sessions
      SET status = 'idle', updated_at = ?
      WHERE status = 'running'
    `, [now]);
    this.saveDb();

    const changes = this.db.getRowsModified?.();
    return typeof changes === 'number' ? changes : 0;
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
        COALESCE(sequence, created_at) ASC,
        created_at ASC,
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

  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage {
    const id = uuidv4();
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

    this.saveDb();

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      metadata: message.metadata,
    };
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

    const normalizedExecutionMode =
      executionModeRow?.value === 'container' ? 'sandbox' : (executionModeRow?.value as CoworkExecutionMode);

    return {
      workingDirectory: workingDirRow?.value || getDefaultWorkingDirectory(),
      systemPrompt: getDefaultSystemPrompt(),
      executionMode: normalizedExecutionMode || 'local',
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
      `, [config.executionMode, now]);
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
      isExplicit: Boolean(row.is_explicit),
      status: (row.status === 'stale' || row.status === 'deleted' ? row.status : 'created') as CoworkUserMemoryStatus,
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
        message_id, role, is_active, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
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
    ]);
  }

  private createOrReviveUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: CoworkUserMemorySourceInput;
    metabotId: number;
  }): { memory: CoworkUserMemory; created: boolean; updated: boolean } {
    const normalizedText = truncate(normalizeMemoryText(input.text), 360);
    if (!normalizedText) {
      throw new Error('Memory text is required');
    }

    const now = Date.now();
    const fingerprint = buildMemoryFingerprint(normalizedText);
    const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 0.75));
    const explicitFlag = input.isExplicit ? 1 : 0;
    const metabotId = input.metabotId;

    let existing = this.getOne<CoworkUserMemoryRow>(`
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE fingerprint = ? AND status != 'deleted' AND metabot_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `, [fingerprint, metabotId]);

    if (!existing) {
      const incomingSemanticKey = normalizeMemorySemanticKey(normalizedText);
      if (incomingSemanticKey) {
        const candidates = this.getAll<CoworkUserMemoryRow>(`
          SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
          FROM user_memories
          WHERE status != 'deleted' AND metabot_id = ?
          ORDER BY updated_at DESC
          LIMIT 200
        `, [metabotId]);
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

    if (existing) {
      const mergedText = choosePreferredMemoryText(existing.text, normalizedText);
      const mergedExplicit = existing.is_explicit ? 1 : explicitFlag;
      const mergedConfidence = Math.max(Number(existing.confidence) || 0, confidence);
      this.db.run(`
        UPDATE user_memories
        SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = 'created', updated_at = ?
        WHERE id = ?
      `, [mergedText, buildMemoryFingerprint(mergedText), mergedConfidence, mergedExplicit, now, existing.id]);
      this.addMemorySource(existing.id, metabotId, input.source);
      const memory = this.getOne<CoworkUserMemoryRow>(`
        SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
        FROM user_memories
        WHERE id = ?
      `, [existing.id]);
      if (!memory) {
        throw new Error('Failed to reload updated memory');
      }
      return { memory: this.mapMemoryRow(memory), created: false, updated: true };
    }

    const id = uuidv4();
    this.db.run(`
      INSERT INTO user_memories (
        id, metabot_id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, NULL)
    `, [id, metabotId, normalizedText, fingerprint, confidence, explicitFlag, now, now]);
    this.addMemorySource(id, metabotId, input.source);

    const memory = this.getOne<CoworkUserMemoryRow>(`
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ?
    `, [id]);
    if (!memory) {
      throw new Error('Failed to load created memory');
    }

    return { memory: this.mapMemoryRow(memory), created: true, updated: false };
  }

  listUserMemories(options: {
    metabotId: number;
    query?: string;
    status?: CoworkUserMemoryStatus | 'all';
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
    touchLastUsed?: boolean;
  }): CoworkUserMemory[] {
    const metabotId = options.metabotId;
    const query = normalizeMemoryText(options.query || '');
    const includeDeleted = Boolean(options.includeDeleted);
    const status = options.status || 'all';
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));

    const clauses: string[] = ['metabot_id = ?'];
    const params: Array<string | number> = [metabotId];

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

    const whereClause = `WHERE ${clauses.join(' AND ')}`;

    const rows = this.getAll<CoworkUserMemoryRow>(`
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
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

  createUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: CoworkUserMemorySourceInput;
    metabotId: number;
  }): CoworkUserMemory {
    const result = this.createOrReviveUserMemory(input);
    this.saveDb();
    return result.memory;
  }

  updateUserMemory(input: {
    id: string;
    metabotId: number;
    text?: string;
    confidence?: number;
    status?: CoworkUserMemoryStatus;
    isExplicit?: boolean;
  }): CoworkUserMemory | null {
    const current = this.getOne<CoworkUserMemoryRow>(`
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ? AND metabot_id = ?
    `, [input.id, input.metabotId]);
    if (!current) return null;

    const now = Date.now();
    const nextText = input.text !== undefined ? truncate(normalizeMemoryText(input.text), 360) : current.text;
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

    this.db.run(`
      UPDATE user_memories
      SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = ?, updated_at = ?
      WHERE id = ? AND metabot_id = ?
    `, [nextText, buildMemoryFingerprint(nextText), nextConfidence, nextExplicit, nextStatus, now, input.id, input.metabotId]);

    const updated = this.getOne<CoworkUserMemoryRow>(`
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ? AND metabot_id = ?
    `, [input.id, input.metabotId]);

    this.saveDb();
    return updated ? this.mapMemoryRow(updated) : null;
  }

  deleteUserMemory(id: string, metabotId: number): boolean {
    const now = Date.now();
    this.db.run(`
      UPDATE user_memories
      SET status = 'deleted', updated_at = ?
      WHERE id = ? AND metabot_id = ?
    `, [now, id, metabotId]);
    this.db.run(`
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE memory_id = ?
    `, [id]);
    this.saveDb();
    return (this.db.getRowsModified?.() || 0) > 0;
  }

  getUserMemoryStats(metabotId: number): CoworkUserMemoryStats {
    const rows = this.getAll<{
      status: string;
      is_explicit: number;
      count: number;
    }>(`
      SELECT status, is_explicit, COUNT(*) AS count
      FROM user_memories
      WHERE metabot_id = ?
      GROUP BY status, is_explicit
    `, [metabotId]);

    const stats: CoworkUserMemoryStats = {
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
      if (row.is_explicit) stats.explicit += count;
      else stats.implicit += count;
    }

    return stats;
  }

  autoDeleteNonPersonalMemories(metabotId?: number): number {
    const rows = metabotId == null
      ? this.getAll<Pick<CoworkUserMemoryRow, 'id' | 'text'>>(
          `SELECT id, text FROM user_memories WHERE status = 'created'`
        )
      : this.getAll<Pick<CoworkUserMemoryRow, 'id' | 'text'>>(
          `SELECT id, text FROM user_memories WHERE status = 'created' AND metabot_id = ?`,
          [metabotId]
        );
    if (rows.length === 0) return 0;

    const now = Date.now();
    let deleted = 0;
    for (const row of rows) {
      if (!shouldAutoDeleteMemoryText(row.text)) {
        continue;
      }
      this.db.run(`
        UPDATE user_memories
        SET status = 'deleted', updated_at = ?
        WHERE id = ?
      `, [now, row.id]);
      this.db.run(`
        UPDATE user_memory_sources
        SET is_active = 0
        WHERE memory_id = ?
      `, [row.id]);
      deleted += 1;
    }

    if (deleted > 0) {
      this.saveDb();
    }
    return deleted;
  }

  markMemorySourcesInactiveBySession(sessionId: string): void {
    this.db.run(`
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE session_id = ? AND is_active = 1
    `, [sessionId]);
  }

  markOrphanImplicitMemoriesStale(metabotId: number): void {
    const now = Date.now();
    this.db.run(`
      UPDATE user_memories
      SET status = 'stale', updated_at = ?
      WHERE metabot_id = ?
        AND is_explicit = 0
        AND status = 'created'
        AND NOT EXISTS (
          SELECT 1
          FROM user_memory_sources s
          WHERE s.memory_id = user_memories.id AND s.is_active = 1
        )
    `, [now, metabotId]);
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

      const candidates = this.listUserMemories({ metabotId, status: 'all', includeDeleted: false, limit: 100 });
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

      const deleted = this.deleteUserMemory(target.id, metabotId);
      if (deleted) result.deleted += 1;
      else result.skipped += 1;
    }

    this.markOrphanImplicitMemoriesStale(metabotId);
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
