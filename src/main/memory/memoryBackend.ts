import type { CoworkMemoryGuardLevel } from '../libs/coworkMemoryExtractor';
import type {
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
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface MemoryUserMemorySourceInput {
  sessionId?: string;
  messageId?: string;
  role?: 'user' | 'assistant' | 'tool' | 'system';
  sourceChannel?: string;
  sourceType?: string;
  externalConversationId?: string;
  sourceId?: string;
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
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
  touchLastUsed?: boolean;
}

export interface MemoryCreateUserMemoryInput extends MemoryScopeSelectorInput, MemoryScopeClassifyInput {
  text: string;
  confidence?: number;
  isExplicit?: boolean;
  source?: MemoryUserMemorySourceInput;
  metabotId: number;
}

export interface MemoryUpdateUserMemoryInput extends MemoryScopeSelectorInput, MemoryScopeClassifyInput {
  id: string;
  metabotId: number;
  text?: string;
  confidence?: number;
  status?: MemoryUserMemoryStatus;
  isExplicit?: boolean;
}

export interface MemoryDeleteUserMemoryInput extends MemoryScopeSelectorInput {
  id: string;
  metabotId: number;
}

export interface MemoryPolicy {
  metabotId: number;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  updatedAt: number;
}

export interface MemoryEffectivePolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  source: 'global' | 'metabot';
}

export type MemoryPolicyUpdates = Partial<Pick<
  MemoryEffectivePolicy,
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

export interface MemoryBackend {
  resolveMetabotIdForMemory(sessionId?: string | null): number | null;
  getEffectiveMemoryPolicyForMetabot(metabotId?: number | null): MemoryEffectivePolicy;
  getEffectiveMemoryPolicyForSession(sessionId?: string | null): MemoryEffectivePolicy;
  setMemoryPolicyForMetabot(metabotId: number, updates: MemoryPolicyUpdates): MemoryPolicy;
  listUserMemories(options: MemoryListUserMemoriesOptions): MemoryUserMemory[];
  createUserMemory(input: MemoryCreateUserMemoryInput): MemoryUserMemory;
  updateUserMemory(input: MemoryUpdateUserMemoryInput): MemoryUserMemory | null;
  deleteUserMemory(input: MemoryDeleteUserMemoryInput): boolean;
  deleteUserMemory(id: string, metabotId: number): boolean;
  getUserMemoryStats(metabotId: number): MemoryUserMemoryStats;
  applyTurnMemoryUpdates(options: ApplyTurnMemoryUpdatesOptions): Promise<ApplyTurnMemoryUpdatesResult>;
}
