import type { CoworkMemoryGuardLevel } from '../libs/coworkMemoryExtractor';
import type {
  MemoryOrigin,
  MemoryScope,
  MemoryScopeKind,
  MemoryUsageClass,
  MemoryVisibility,
} from './memoryScope';

export type MemoryUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface MemoryUserMemory {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: MemoryUserMemoryStatus;
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
  usageClass?: MemoryUsageClass;
  visibility?: MemoryVisibility;
  origin?: MemoryOrigin;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /** Hygiene-archive timestamp; null/undefined means the row is active. */
  archivedAt?: number | null;
}

export interface MemoryUserMemorySourceInput {
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

export interface MemoryUserMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

export interface MemoryScopeSelectorInput {
  // Normalize and validate with `normalizeMemoryScopeSelector` before using these fields.
  scope?: MemoryScope;
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
}

export interface MemoryScopeClassifyInput {
  usageClass?: MemoryUsageClass;
  visibility?: MemoryVisibility;
}

export interface MemoryListUserMemoriesOptions extends MemoryScopeSelectorInput {
  metabotId: number;
  query?: string;
  status?: MemoryUserMemoryStatus | 'all';
  usageClass?: MemoryUsageClass;
  origin?: MemoryOrigin;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
  /** Include hygiene-archived rows (admin/stats surfaces); default hides them. */
  includeArchived?: boolean;
  touchLastUsed?: boolean;
}

export interface MemoryCreateUserMemoryInput extends MemoryScopeSelectorInput, MemoryScopeClassifyInput {
  text: string;
  confidence?: number;
  isExplicit?: boolean;
  origin?: MemoryOrigin;
  source?: MemoryUserMemorySourceInput;
  metabotId: number;
  /**
   * Internal escape hatch for the dream pipeline: skip fingerprint/semantic
   * revive and always insert a new row. Dream writes are authoritative
   * per-date batches — cross-date dedup would let a re-dreamed day resurrect
   * (and later cascade-delete) another day's entries.
   */
  forceNew?: boolean;
}

export interface MemoryUpdateUserMemoryInput extends MemoryScopeSelectorInput, MemoryScopeClassifyInput {
  id: string;
  metabotId: number;
  text?: string;
  confidence?: number;
  status?: MemoryUserMemoryStatus;
  isExplicit?: boolean;
  /** Internal escape hatch: only the dream service may touch protected entries (self_identity). */
  allowProtected?: boolean;
  /** When set, an additional source row is recorded for this memory. */
  source?: MemoryUserMemorySourceInput;
}

export interface MemoryDeleteUserMemoryInput extends MemoryScopeSelectorInput {
  id: string;
  metabotId: number;
  /** Internal escape hatch: only the dream service may touch protected entries (self_identity). */
  allowProtected?: boolean;
}

export interface MemoryPolicy {
  metabotId: number;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  dreamEnabled: boolean;
  hygieneEnabled: boolean;
  updatedAt: number;
}

export interface MemoryEffectivePolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  /** Combined char budget for injected memory blocks (oldest-first eviction; global-only). */
  memoryPromptMaxChars: number;
  dreamEnabled: boolean;
  /** Whether the nightly hygiene (active-forgetting) pass covers this bot. */
  hygieneEnabled: boolean;
  source: 'global' | 'metabot';
}

export type MemoryPolicyUpdates = Partial<Pick<
  MemoryEffectivePolicy,
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'dreamEnabled'
  | 'hygieneEnabled'
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

export interface MemoryScopeSummary {
  kind: MemoryScopeKind;
  key: string;
  /** Number of non-deleted entries in this scope. */
  count: number;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
}

export interface MemoryScopesOverview {
  owner: MemoryScopeSummary | null;
  contacts: MemoryScopeSummary[];
  conversations: MemoryScopeSummary[];
}

export interface MemorySessionScopeResolution {
  metabotId: number;
  scope: MemoryScope;
  peerName?: string | null;
  peerAvatar?: string | null;
}

export interface MemoryBackend {
  resolveMetabotIdForMemory(sessionId?: string | null): number | null;
  getEffectiveMemoryPolicyForMetabot(metabotId?: number | null): MemoryEffectivePolicy;
  getEffectiveMemoryPolicyForSession(sessionId?: string | null): MemoryEffectivePolicy;
  setMemoryPolicyForMetabot(metabotId: number, updates: MemoryPolicyUpdates): MemoryPolicy;
  deleteMemoryPolicyForMetabot(metabotId: number): boolean;
  listUserMemories(options: MemoryListUserMemoriesOptions): MemoryUserMemory[];
  createUserMemory(input: MemoryCreateUserMemoryInput): MemoryUserMemory;
  updateUserMemory(input: MemoryUpdateUserMemoryInput): MemoryUserMemory | null;
  deleteUserMemory(input: MemoryDeleteUserMemoryInput): boolean;
  deleteUserMemory(id: string, metabotId: number): boolean;
  getUserMemoryStats(input: { metabotId: number } & MemoryScopeSelectorInput): MemoryUserMemoryStats;
  getUserMemoryStats(metabotId: number): MemoryUserMemoryStats;
  applyTurnMemoryUpdates(options: ApplyTurnMemoryUpdatesOptions): Promise<ApplyTurnMemoryUpdatesResult>;
  /** Aggregate of all memory scopes under one MetaBot, with peer identity resolved where possible. */
  listMemoryScopes(metabotId: number): MemoryScopesOverview;
  /** Resolve the write scope for a session (owner for local sessions, contact/conversation for external ones). */
  resolveMemoryScopeForSession(sessionId?: string | null): MemorySessionScopeResolution | null;
}
