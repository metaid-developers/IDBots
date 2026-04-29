// Cowork session status
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';

// Cowork message types
export type CoworkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

// Cowork execution mode
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';

// Session type: standard = human↔MetaBot, a2a = MetaBot↔MetaBot
export type CoworkSessionType = 'standard' | 'a2a';

// Cowork message metadata
export interface CoworkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  isThinking?: boolean;
  isDelegationInternal?: boolean;
  skillIds?: string[];
  /**
   * Prevent renderer stream listeners from treating this message as a new active run.
   * Used for passive A2A follow-up messages that should appear after completion without
   * restarting the session progress state.
   */
  suppressRunningStatus?: boolean;
  /**
   * A2A messages only. Message direction from the local MetaBot's perspective:
   * - 'outgoing': sent by the local MetaBot (displayed on the right)
   * - 'incoming': received from the remote peer (displayed on the left)
   * Only set on A2A sessions; standard sessions use message.type for rendering.
   */
  direction?: 'outgoing' | 'incoming';
  /**
   * A2A incoming messages only. The remote peer's globalmetaid.
   * Do NOT set on outgoing messages — use the session's peerGlobalMetaId instead.
   */
  senderGlobalMetaId?: string;
  /**
   * A2A incoming messages only. The remote peer's display name.
   * Do NOT set on outgoing messages — use the session's peerName instead.
   */
  senderName?: string;
  /**
   * A2A incoming messages only. The remote peer's avatar URL.
   * Do NOT set on outgoing messages — use the session's peerAvatar instead.
   */
  senderAvatar?: string;
  [key: string]: unknown;
}

// Cowork message
export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
}

export interface CoworkServiceOrderSummary {
  role?: 'buyer' | 'seller';
  status:
    | 'awaiting_first_response'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'refund_pending'
    | 'refunded';
  servicePinId?: string | null;
  serviceName?: string | null;
  paymentTxid?: string | null;
  outputType?: string | null;
  failureReason?: string | null;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
}

// Cowork session
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
  /** Session type: 'standard' = human↔MetaBot, 'a2a' = MetaBot↔MetaBot */
  sessionType?: CoworkSessionType;
  /** Remote peer MetaBot's globalmetaid (A2A sessions only) */
  peerGlobalMetaId?: string | null;
  /** Remote peer MetaBot's display name (A2A sessions only) */
  peerName?: string | null;
  /** Remote peer MetaBot's avatar data URL (A2A sessions only) */
  peerAvatar?: string | null;
  /** Local MetaBot's display name */
  metabotName?: string | null;
  /** Local MetaBot's avatar data URL */
  metabotAvatar?: string | null;
  serviceOrderSummary?: CoworkServiceOrderSummary | null;
}

// Cowork configuration
export interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
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

export interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

export type CoworkSandboxStatus = {
  supported: boolean;
  runtimeReady: boolean;
  imageReady: boolean;
  downloading: boolean;
  progress?: CoworkSandboxProgress;
  error?: string | null;
};

export type CoworkSandboxProgress = {
  stage: 'runtime' | 'image';
  received: number;
  total?: number;
  percent?: number;
  url?: string;
};

export type CoworkUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: CoworkUserMemoryStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

export interface CoworkMemoryPolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  source: 'global' | 'metabot';
}

// Cowork pending permission request
export interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

export type CoworkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

// Cowork permission response
export interface CoworkPermissionResponse {
  requestId: string;
  result: CoworkPermissionResult;
}

// Session summary for list display (without full messages)
export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Session type: 'standard' = human↔MetaBot, 'a2a' = MetaBot↔MetaBot */
  sessionType?: CoworkSessionType;
  /** Remote peer MetaBot's display name (A2A sessions only) */
  peerName?: string | null;
  serviceOrderSummary?: CoworkServiceOrderSummary | null;
}

// Start session options
export interface CoworkStartOptions {
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  title?: string;
  activeSkillIds?: string[];
  metabotId?: number | null;
}

// Continue session options
export interface CoworkContinueOptions {
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
}

// IPC result types
export interface CoworkSessionResult {
  success: boolean;
  session?: CoworkSession;
  error?: string;
}

export interface CoworkSessionListResult {
  success: boolean;
  sessions?: CoworkSessionSummary[];
  error?: string;
}

export interface CoworkConfigResult {
  success: boolean;
  config?: CoworkConfig;
  error?: string;
}

// Stream event types for IPC communication
export type CoworkStreamEventType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'complete'
  | 'error';

export interface CoworkStreamEvent {
  type: CoworkStreamEventType;
  sessionId: string;
  data: {
    message?: CoworkMessage;
    permission?: CoworkPermissionRequest;
    error?: string;
    claudeSessionId?: string;
  };
}
