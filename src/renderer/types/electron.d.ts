import type { McpServerConfig, McpServerFormData } from './mcp';
import type { ProjectFormData, ProjectRecord } from './project';
import type { GroupChatTranscriptMessage } from './groupTask';
import type {
  LongTermBoard,
  LongTermResult,
  LongTermSubtask,
  LongTermSubtaskDraft,
  LongTermSubtaskUpdateInput,
  LongTermTaskDetail,
  LongTermTaskUpdateInput,
} from './longTermTask';
import type { OpenTeamCollabSummary, OpenTeamGuestInvite } from './openTeamCollab';
import type {
  BrowserCommandResult as CoreBrowserCommandResult,
  MetaAppGalleryRecord,
} from '@openagentinternet/agent-browser-core';
import type {
  BrowserCacheClearInput,
  BrowserCacheClearResult,
  BrowserCacheSnapshot,
  BrowserCommandResult as HostBrowserCommandResult,
  BrowserResolveInput,
  BrowserResolveResult,
  BrowserSettingsInput,
  BrowserSettingsSnapshot,
  BrowserSettingsUpdateInput,
} from '@openagentinternet/agent-browser-host-contract';
import type {
  CoworkA2AGuidanceRequest,
  CoworkA2AGuidanceResult,
  CoworkA2AOwnerMessageRequest,
  CoworkA2AOwnerMessageResult,
  CoworkKnowledgeEntry,
  CoworkMessageFeedbackRecord,
  CoworkPermissionMode,
  CoworkSessionStatus,
  CoworkWorkspaceSelection,
} from './cowork';
import type {
  CommunityMetaAppInstallResult,
  CommunityMetaAppListParams,
  CommunityMetaAppListResult,
  MetaAppRecord,
  MetaAppUrlResult,
} from './metaApp';
import type {
  GigSquareRefundCollections,
  GigSquareModifyServiceParams,
  GigSquareMyServiceOrderDetail,
  GigSquareMyServiceSummary,
  GigSquarePageResult,
  GigSquareProviderInfo,
  GigSquareService,
  GigSquareServiceMutationResult,
} from './gigSquare';
import type {
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
} from '../features/botBrowser/types';

interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  error?: string;
}

/** Traffic account snapshot (balance/usage are byte counts). */
interface TrafficAccountInfo {
  accountId: string;
  identityAddress: string;
  balanceBytes: number;
  reservedBytes: number;
  grantedBytesTotal: number;
  spentBytesTotal: number;
  status: number;
}

interface TrafficLedgerEntryInfo {
  id: number;
  direction: number;
  amountBytes: number;
  balanceAfter: number;
  sourceType: string;
  sourceId: string;
  remark: string;
  timestamp: number;
  /** Local-journal enrichment (this-device sponsored commits only). */
  txId?: string;
  botAddress?: string;
  kind?: string;
}

interface TrafficDailyUsageRowInfo {
  date: string;
  botAddress: string;
  bytes: number;
  txCount: number;
}

interface TrafficBindSummaryInfo {
  accountId: string;
  results: Array<{ botAddress: string; status: 'bound' | 'conflict' | 'failed'; error?: string }>;
  boundCount: number;
  conflictCount: number;
  failedCount: number;
}

interface TrafficSpendJournalEntryInfo {
  id: number;
  txId: string;
  botAddress: string;
  orderId: string;
  txSize: number;
  sponsoredMinerFee: number;
  savedFee: number;
  billedBy: 'traffic' | 'quota';
  /** Pin protocol path or purpose tag (e.g. /protocols/simplemsg, /file); '' for legacy rows. */
  kind: string;
  createdAt: number;
}

interface TrafficPricingPlanInfo {
  planId: string;
  chain: string;
  payCurrency: string;
  payAmount: number;
  trafficBytes: number;
  status: number;
  remark: string;
}

interface TrafficRechargeOrderInfo {
  orderId: string;
  payAmount: number;
  payCurrency: string;
  trafficBytes: number;
  gatewayParams: unknown;
}

/** status: 1=created, 2=paid, 3=credited, 4=closed. */
interface TrafficRechargeOrderStatusInfo {
  orderId: string;
  status: number;
  paidAt?: number;
  creditedAt?: number;
}

/** Free-grant campaign state for the local traffic account. */
interface TrafficFreeGrantCampaignStatusInfo {
  enabled: boolean;
  grantBytes: number;
  claimed: boolean;
  claimable: boolean;
}

interface TrafficFreeGrantClaimInfo {
  grantId: number;
  grantBytes: number;
  balanceAfter: number;
}

interface TrafficRedeemCodeInfo {
  codeId: number;
  trafficBytes: number;
  balanceAfter: number;
}

interface TrafficSettingsInfo {
  mode: 'traffic' | 'selfpay';
  fallbackPolicy: 'selfpay' | 'strict';
  /** Configured assist-service base URL override; '' = production default. */
  apiBase: string;
  /** Recharge gateway override; '' = automatic (plan currency decides: CNY → Alipay, other → PayPal). */
  rechargeGateway: '' | 'paypal' | 'mock' | 'alipay';
}

interface LlmRelayModelInfo {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface LlmRelayBootstrapInfo {
  /** Raw relay key; returned by bootstrap only (server stores only its hash). */
  apiKey: string;
  keyPrefix: string;
  baseUrl: string;
  models: LlmRelayModelInfo[];
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
}

interface LlmRelayQuotaInfo {
  keyPrefix: string;
  baseUrl: string;
  models: LlmRelayModelInfo[];
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
}

interface ApiStreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  error?: string;
}

/** Local human user identity as exposed to the renderer (mnemonic stripped). */
interface PublicUserIdentity {
  id: number;
  path: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string | null;
  metaid: string;
  globalmetaid: string | null;
  name: string;
  avatar: string | null;
  subsidy_state: 'pending' | 'claimed' | 'failed' | null;
  subsidy_error: string | null;
  name_pin_id: string | null;
  avatar_pin_id: string | null;
  sync_state: 'pending' | 'synced' | 'partial' | 'failed' | null;
  sync_error: string | null;
  created_at: number;
  updated_at: number;
}

interface UserIdentityChainSyncResult {
  success: boolean;
  txids: string[];
  chatPublicKeyPinId?: string;
  namePinId?: string;
  avatarPinId?: string;
  failedSteps: Array<'name' | 'avatar' | 'chatpubkey'>;
  error?: string;
}

interface UserIdentitySubsidyResult {
  success: boolean;
  error?: string;
  step1?: unknown;
  step2?: unknown;
}

interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
  /** True when this download run resumed from a previously saved partial file. */
  resumed?: boolean;
}

// Cowork types for IPC
interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  activeSkillIds: string[];
  messages: CoworkMessage[];
  messageHistory?: {
    hasMoreBefore: boolean;
    beforeSequence: number | null;
    pageSize: number;
    /** Episode index of the A2A cross-episode cursor; null while paging stays in the current episode. */
    beforeEpisodeIndex?: number | null;
    /** Opaque transcript-order cursor for non-A2A sessions; hand it back to getSessionMessagesPage. */
    beforeTranscriptCursor?: string | null;
  };
  createdAt: number;
  updatedAt: number;
  metabotId?: number | null;
  sessionType?: 'standard' | 'a2a' | 'group_task';
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
  metabotName?: string | null;
  metabotAvatar?: string | null;
  /** Auto-created session marker: long-term task run, orchestration run, or scheduled run. */
  autoOrigin?: 'longterm' | 'orchestration' | 'schedule' | null;
  /** Manual "Autonomous Tasks" fold placement; null = follow the auto-origin policy. */
  foldOverride?: 'in' | 'out' | null;
  serviceOrderSummary?: CoworkServiceOrderSummary | null;
}

interface CoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown> & {
    senderGlobalMetaId?: string;
    senderName?: string;
    senderAvatar?: string;
    suppressRunningStatus?: boolean;
  };
}

interface CoworkMessagePage {
  messages: CoworkMessage[];
  hasMoreBefore: boolean;
  beforeSequence: number | null;
  /** Opaque cursor for the next older page of a non-A2A session window. */
  beforeTranscriptCursor?: string | null;
}

interface CoworkA2AHistoryCursor {
  episodeIndex: number | null;
  beforeSequence: number | null;
}

interface CoworkA2AEpisodeInfo {
  sessionId: string;
  threadId: string;
  episodeIndex: number;
  previousSessionId: string | null;
  nextSessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  closeReason: string | null;
  summary: string | null;
}

interface CoworkA2AHistoryPage {
  threadId: string;
  participantPairKey: string;
  messages: Array<{
    sessionId: string;
    episodeIndex: number;
    message: CoworkMessage;
  }>;
  hasMoreBefore: boolean;
  beforeCursor: CoworkA2AHistoryCursor | null;
}

interface CoworkSubmitInput {
  sessionId: string;
  submissionId: string;
  text: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
  /** Set when the text was filled verbatim from a quick action (建议操作) entry. */
  source?: 'quick_action';
}

type CoworkSubmitInputErrorCode =
  | 'invalid_input'
  | 'session_not_found'
  | 'unsupported_session'
  | 'unsupported_execution'
  | 'cancelled'
  | 'delivery_failed';

type CoworkSubmitInputResult =
  | {
      success: true;
      mode: 'steer' | 'continue';
      message: CoworkMessage;
    }
  | {
      success: false;
      code: CoworkSubmitInputErrorCode;
      error: string;
    };

interface CoworkServiceOrderSummary {
  role?: 'buyer' | 'seller';
  status: 'awaiting_first_response' | 'in_progress' | 'rating_pending' | 'completed' | 'failed' | 'refund_pending' | 'refunded';
  servicePinId?: string | null;
  serviceName?: string | null;
  paymentTxid?: string | null;
  outputType?: string | null;
  failureReason?: string | null;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
}

interface CoworkSessionSummary {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  metabotId?: number | null;
  archivedAt?: number | null;
  sessionType?: 'standard' | 'a2a' | 'group_task';
  peerName?: string | null;
  peerAvatar?: string | null;
  metabotName?: string | null;
  metabotAvatar?: string | null;
  /** Revision of the owning MetaBot row (metabots.updated_at); the avatar cache's freshness key. */
  metabotAvatarVersion?: number | null;
  /** Auto-created session marker: long-term task run, orchestration run, or scheduled run. */
  autoOrigin?: 'longterm' | 'orchestration' | 'schedule' | null;
  /** Manual "Autonomous Tasks" fold placement; null = follow the auto-origin policy. */
  foldOverride?: 'in' | 'out' | null;
  serviceOrderSummary?: CoworkServiceOrderSummary | null;
}

interface CoworkEnsureA2ASessionInput {
  actorId?: string | null;
  localMetabotId?: number | null;
  peerGlobalMetaId: string;
  peerName?: string | null;
  peerAvatar?: string | null;
}

interface CoworkEnsureA2ASessionResult {
  success: boolean;
  created?: boolean;
  externalConversationId?: string;
  session?: CoworkSession;
  error?: string;
}

interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  /** Combined char budget for injected memory blocks (oldest-first eviction; global-only). */
  memoryPromptMaxChars: number;
  /** Last workspace choice in the New Task composer (null = fall back to bot workspace). */
  lastWorkspaceSelection: CoworkWorkspaceSelection | null;
}

type CoworkConfigUpdate = Partial<Pick<
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

interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: 'created' | 'stale' | 'deleted';
  /** 'self_identity' entries are dream-written and protected from edit/delete. */
  usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'self_identity' | 'work_review';
  origin?: 'conversation' | 'dream';
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

interface CoworkMemoryPolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  memoryPromptMaxChars: number;
  dreamEnabled: boolean;
  hygieneEnabled: boolean;
  source: 'global' | 'metabot';
}

interface MemoryHygieneConfig {
  enabled: boolean;
  observationRetentionDays: number;
  observationAnchorsPerPair: number;
  episodeArchiveDays: number;
  memoryDecayDays: number;
  tombstonePurgeDays: number;
  knowledgeRevisionKeep: number;
  dreamRunRetentionDays: number;
  deepConsolidationEnabled: boolean;
  deepConsolidationIntervalDays: number;
}

interface MemoryHygieneRunStats {
  dateKey: string;
  ranAt: number;
  trigger: 'scheduled' | 'manual';
  counts: Record<string, number>;
  errors: string[];
}

type TeamCultureKind = 'glossary' | 'convention' | 'team_lesson';
type TeamCultureOrigin = 'owner' | 'distillation';
type TeamCultureStatus = 'active' | 'superseded' | 'archived';

interface TeamCultureEntry {
  id: string;
  kind: TeamCultureKind;
  topic: string;
  topicFingerprint: string;
  text: string;
  status: TeamCultureStatus;
  version: number;
  origin: TeamCultureOrigin;
  pendingApproval: boolean;
  timesInjected: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface TeamCultureActiveCounts {
  glossary: number;
  convention: number;
  team_lesson: number;
}

type TeamCultureDistillationOutcome =
  | 'applied'
  | 'empty'
  | 'unparseable'
  | 'llm-error'
  | 'apply-error'
  | 'few-members'
  | 'no-summary'
  | 'disabled';

interface TeamCultureDistillationRecord {
  at: number;
  taskId: number | null;
  taskTitle: string;
  outcome: TeamCultureDistillationOutcome;
  applied: number;
  pendingConventions: number;
  error?: string | null;
}

interface TaskCommTrendRow {
  taskId: number;
  title: string;
  status: string;
  commTotalBytes: number | null;
  commMessageCount: number | null;
  deliverableCount: number;
  updatedAt: string | null;
}

interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
  // AskUserQuestion only: per-question countdown for the wizard; null/undefined = no timeout.
  perQuestionTimeoutMs?: number | null;
}

interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

interface CoworkSandboxStatus {
  supported: boolean;
  runtimeReady: boolean;
  imageReady: boolean;
  downloading: boolean;
  progress?: CoworkSandboxProgress;
  error?: string | null;
}

interface CoworkSandboxProgress {
  stage: 'runtime' | 'image';
  received: number;
  total?: number;
  percent?: number;
  url?: string;
}

interface WindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
}

import type {
  KnowledgeBaseInfo,
  KnowledgeBaseLearnStatusEvent,
  KnowledgeBaseLearnSummary,
} from './knowledgeBase';

import type { MetawebStudyJobInfo } from './metawebStudy';
import type { MetawebSurfRunInfo } from './metawebSurf';

import type { OfficialSkillItem } from './skill';

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
}

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

interface EmailConnectivityCheck {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
}

interface EmailConnectivityTestResult {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
}

type CoworkPermissionResult =
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

// MetaBot types for IPC (matches main types; avatar stored as BLOB in DB, exposed as data URL or URL string)
interface Metabot {
  id: number;
  wallet_id: number;
  mvc_address?: string;
  btc_address?: string;
  doge_address?: string;
  chat_public_key_pin_id?: string | null;
  metabot_info_pinid?: string | null;
  name: string;
  avatar: string | null;
  enabled: boolean;
  globalmetaid: string | null;
  metabot_type: 'twin' | 'worker' | 'welcome';
  role: string;
  soul: string;
  goal: string | null;
  bio: string | null;
  /** Deprecated compatibility field; v3 Bot Info uses `bio`. */
  background: string | null;
  boss_id: number | null;
  boss_global_metaid: string | null;
  /** Pin id of the signed /info/owner binding; null means unsigned legacy claim or no owner. */
  owner_binding_pinid?: string | null;
  /** Primary LLM brain: model id (new) or legacy provider key. */
  llm_id: string | null;
  /** Provider key the brain model was picked from; disambiguates colliding model ids. */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain (off/low/high/max); null = model default. */
  llm_effort?: string | null;
  /** Optional fallback brain; same value semantics as llm_id (model id or legacy provider key). */
  fallback_llm_id?: string | null;
  /** Provider key for the fallback brain model. */
  fallback_llm_provider?: string | null;
  /** Reasoning effort for the fallback brain; null = model default. */
  fallback_llm_effort?: string | null;
  tools: string[];
  skills: string[];
  allow_chat_skills: string[];
  /** Max incoming turns per active A2A private-chat session; null = app default. */
  a2a_max_incoming_turns?: number | null;
  /** Cooldown after an auto-bye before the A2A conversation may reopen; null = app default. */
  a2a_bye_cooldown_ms?: number | null;
  /** Whether this bot auto-replies in A2A private chats; null = default (on). */
  a2a_auto_reply_enabled?: boolean | null;
  created_at: number;
  updated_at: number;
}

interface MetabotCreateInput {
  name: string;
  avatar?: string | null;
  metabot_type: 'twin' | 'worker' | 'welcome';
  role: string;
  soul: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use bio. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
  llm_provider?: string | null;
  llm_effort?: string | null;
  allow_chat_skills?: string[];
}

interface MetabotUpdateInput {
  name?: string;
  avatar?: string | null;
  enabled?: boolean;
  metabot_type?: 'twin' | 'worker' | 'welcome';
  role?: string;
  soul?: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use bio. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
  llm_provider?: string | null;
  llm_effort?: string | null;
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  allow_chat_skills?: string[];
  a2a_max_incoming_turns?: number | null;
  a2a_bye_cooldown_ms?: number | null;
  a2a_auto_reply_enabled?: boolean | null;
  homepage?: string | null;
}

interface AssignGroupChatTaskParams {
  target_metabot_name: string;
  group_id: string;
  reply_on_mention?: boolean;
  random_reply_probability?: number;
  cooldown_seconds?: number;
  context_message_count?: number;
  discussion_background?: string;
  participation_goal?: string;
  /** Boss identity: use globalmetaid for user identification. */
  supervisor_globalmetaid?: string;
  /** Allowed skill names for tool hook, e.g. ["web-search"]. */
  allowed_skills?: string[] | string | null;
  /** Original user instruction for reference. */
  original_prompt?: string | null;
}

interface AssignGroupChatTaskResult {
  success: boolean;
  message: string;
  error?: string;
}

interface ElectronProviderDiscoveryState {
  key: string;
  globalMetaId: string;
  address: string;
  lastSeenSec: number | null;
  lastCheckAt: number | null;
  lastSource: string | null;
  lastError: string | null;
  online: boolean;
  optimisticLocal: boolean;
}

interface ElectronProviderDiscoverySnapshot {
  onlineBots: Record<string, number>;
  availableServices: unknown[];
  providers: Record<string, ElectronProviderDiscoveryState>;
}

interface IElectronAPI {
  platform: string;
  arch: string;
  store: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    remove: (key: string) => Promise<void>;
    onChanged: (callback: (payload: { key: string }) => void) => () => void;
  };
  powerGuard: {
    getStatus: () => Promise<{
      active: boolean;
      sources: string[];
      engaged: boolean;
      engagedBy: 'caffeinate' | 'powerSaveBlocker' | null;
      preventDeviceSleepEnabled: boolean;
    }>;
    getPreventDeviceSleep: () => Promise<{ enabled: boolean }>;
    setPreventDeviceSleep: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    onChanged: (
      callback: (state: {
        active: boolean;
        sources: string[];
        engaged: boolean;
        engagedBy: 'caffeinate' | 'powerSaveBlocker' | null;
        preventDeviceSleepEnabled: boolean;
      }) => void,
    ) => () => void;
  };
  skills: {
    list: () => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    download: (source: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    getRoot: () => Promise<{ success: boolean; path?: string; error?: string }>;
    autoRoutingPrompt: () => Promise<{ success: boolean; prompt?: string | null; error?: string }>;
    getAssignmentInfo: () => Promise<{
      success: boolean;
      info?: Record<string, { scope: 'library' | 'global'; assignedMetabotIds: number[] }>;
      metabots?: Array<{ id: number; name: string; metabotType: string }>;
      error?: string;
    }>;
    listMissing: () => Promise<{
      success: boolean;
      missing?: Array<{
        id: string;
        scope: 'library' | 'global';
        assignedMetabotIds: number[];
        sourceUri: string | null;
      }>;
      error?: string;
    }>;
    forgetMissing: (id: string) => Promise<{ success: boolean; error?: string }>;
    setScope: (options: { id: string; scope: 'library' | 'global' | 'bots'; metabotIds?: number[] }) => Promise<{
      success: boolean;
      info?: Record<string, { scope: 'library' | 'global'; assignedMetabotIds: number[] }>;
      error?: string;
    }>;
    getConfig: (skillId: string) => Promise<{ success: boolean; config?: Record<string, string>; error?: string }>;
    setConfig: (skillId: string, config: Record<string, string>) => Promise<{ success: boolean; error?: string }>;
    testEmailConnectivity: (
      skillId: string,
      config: Record<string, string>
    ) => Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  metaapps: {
    list: () => Promise<{ success: boolean; apps?: MetaAppRecord[]; error?: string }>;
    listCommunity: (input?: CommunityMetaAppListParams) => Promise<CommunityMetaAppListResult>;
    installCommunity: (input: { sourcePinId: string }) => Promise<CommunityMetaAppInstallResult>;
    open: (input: { appId: string; targetPath?: string }) => Promise<MetaAppUrlResult>;
    resolveUrl: (input: { appId: string; targetPath?: string }) => Promise<MetaAppUrlResult>;
    autoRoutingPrompt: () => Promise<{ success: boolean; prompt?: string | null; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  metaappOwner: {
    list: (input: { metabotId: number; cursor?: string; size?: number }) => Promise<{
      success: boolean;
      error?: string;
      records?: import('./metaAppOwner').OwnerMetaAppRecord[];
      nextCursor?: string;
      total?: number;
    }>;
    publish: (input: { metabotId: number; manifest: import('./metaAppOwner').MetaAppManifestInput; confirm?: boolean; network?: string }) => Promise<{
      success: boolean; error?: string;
      pinId?: string; chainWrite?: unknown; metaappUri?: string; shareWebUrl?: string;
    }>;
    update: (input: { metabotId: number; targetPinId: string; firstPinId?: string; manifest: import('./metaAppOwner').MetaAppManifestInput; confirm?: boolean; network?: string }) => Promise<{
      success: boolean; error?: string;
      pinId?: string; targetPinId?: string; chainWrite?: unknown; metaappUri?: string; shareWebUrl?: string;
    }>;
    remove: (input: { metabotId: number; targetPinId: string; firstPinId?: string; confirm?: boolean; network?: string }) => Promise<{
      success: boolean; error?: string;
      revokedPinId?: string; pinId?: string; chainWrite?: unknown;
    }>;
  };
  botBrowser: {
    onOpenUri: (callback: (input: { uri: string; actorId?: string | null }) => void) => () => void;
    onTabCommand: (callback: (input: {
      requestId: string;
      command: BotBrowserTabCommand;
    }) => void) => () => void;
    respondToTabCommand: (response: {
      requestId: string;
      success: boolean;
      result?: BotBrowserTabCommandResult;
      error?: string;
    }) => void;
    onCaptureRequest: (callback: (input: {
      requestId: string;
      tabId?: number;
      fullSurface?: boolean;
    }) => void) => () => void;
    respondToCaptureRequest: (response: {
      requestId: string;
      success: boolean;
      result?: { data: string; mimeType: string; width: number; height: number };
      error?: string;
    }) => void;
    capturePage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      format?: 'png' | 'jpeg';
      quality?: number;
    }) => Promise<{ success: boolean; data?: string; mimeType?: string; width?: number; height?: number; error?: string }>;
    resolveResource: (input: BrowserResolveInput) => Promise<HostBrowserCommandResult<BrowserResolveResult>>;
    getProfile: (input: { actorId?: string; globalMetaId: string }) => Promise<HostBrowserCommandResult<Record<string, unknown>>>;
    getSettings: (input?: BrowserSettingsInput) => Promise<HostBrowserCommandResult<BrowserSettingsSnapshot>>;
    updateSettings: (input: BrowserSettingsUpdateInput) => Promise<HostBrowserCommandResult<BrowserSettingsSnapshot>>;
    resolveMetaAppPin: (input: { pinId: string }) => Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>>;
    getMetaAppCache: () => Promise<HostBrowserCommandResult<BrowserCacheSnapshot>>;
    clearMetaAppCache: (input?: BrowserCacheClearInput) => Promise<HostBrowserCommandResult<BrowserCacheClearResult>>;
    writeMetaIdPin: (input: {
      actorId?: string;
      resourceUri?: string;
      sessionId?: string;
      payload?: unknown;
      network?: string;
    }) => Promise<HostBrowserCommandResult<unknown>>;
    uploadMetaFile: (input: {
      actorId?: string;
      resourceUri?: string;
      sessionId?: string;
      payload?: unknown;
      network?: string;
    }) => Promise<HostBrowserCommandResult<unknown>>;
    completeLlm: (input: {
      actorId?: string;
      resourceUri?: string;
      sessionId?: string;
      payload?: unknown;
    }) => Promise<HostBrowserCommandResult<unknown>>;
    requestPermissions: (input: {
      actorId?: string;
      resourceUri?: string;
      sessionId?: string;
      payload?: unknown;
    }) => Promise<HostBrowserCommandResult<unknown>>;
    sendPrivateChat: (input: {
      actorId?: string;
      peerGlobalMetaId?: string;
      content?: string;
      replyPin?: string;
      network?: string;
    }) => Promise<{
      success: boolean;
      pinId?: string;
      txids?: string[];
      peerGlobalMetaId?: string;
      error?: string;
    }>;
  };
  agentGame: {
    session: (input: { method: string; payload?: unknown; actorId?: string; resourceUri?: string }) => Promise<import('./agentGame').AgentGameSessionResult>;
    respondConsent: (input: { requestId: string; approved: boolean; reason?: string }) => Promise<{ success: boolean; error?: string }>;
    listPendingConsent: () => Promise<{ cards: import('./agentGame').AgentGameConsentCardInfo[] }>;
    listSessions: (input?: { appId?: string; status?: string; groupId?: string }) => Promise<{ sessions: import('./agentGame').AgentGameSessionView[] }>;
    onConsentRequired: (callback: (info: import('./agentGame').AgentGameConsentCardInfo) => void) => () => void;
    onSessionUpdated: (callback: (session: import('./agentGame').AgentGameSessionView) => void) => () => void;
  };
  api: {
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<ApiResponse>;
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => Promise<ApiStreamResponse>;
    cancelStream: (requestId: string) => Promise<boolean>;
    onStreamData: (requestId: string, callback: (chunk: string) => void) => () => void;
    onStreamDone: (requestId: string, callback: () => void) => () => void;
    onStreamError: (requestId: string, callback: (error: string) => void) => () => void;
    onStreamAbort: (requestId: string, callback: () => void) => () => void;
  };
  gigSquare: {
    fetchServices: () => Promise<{ success: boolean; list?: GigSquareService[]; error?: string }>;
    fetchMyServices: (params?: { page?: number; pageSize?: number; refresh?: boolean }) => Promise<{
      success: boolean;
      page?: GigSquarePageResult<GigSquareMyServiceSummary>;
      error?: string;
    }>;
    fetchMyServiceOrders: (params: { serviceId: string; page?: number; pageSize?: number; refresh?: boolean }) => Promise<{
      success: boolean;
      page?: GigSquarePageResult<GigSquareMyServiceOrderDetail>;
      error?: string;
    }>;
    fetchRefunds: () => Promise<{
      success: boolean;
      refunds?: GigSquareRefundCollections;
      error?: string;
    }>;
    processRefundOrder: (params: { orderId: string }) => Promise<{
      success: boolean;
      refundTxid?: string;
      refundFinalizePinId?: string;
      error?: string;
    }>;
    syncFromRemote: () => Promise<{ success: boolean; error?: string }>;
    fetchProviderInfo: (params: { providerMetaId?: string; providerGlobalMetaId?: string; providerAddress?: string }) => Promise<{ success: boolean; error?: string } & GigSquareProviderInfo>;
    preflightOrder: (params: { metabotId: number; toGlobalMetaId: string }) => Promise<{ success: boolean; error?: string; errorCode?: 'open_order_exists' | 'self_order_not_allowed' | string }>;
    publishService: (params: {
      metabotId: number;
      serviceName: string;
      displayName: string;
      description: string;
      executionReminder?: string;
      providerSkills?: string[];
      providerSkill?: string;
      paymentTiming?: 'free' | 'prepaid' | string;
      price: string;
      currency: string;
      protocolSettlementKind?: 'native' | 'fiat' | string;
      metadata?: string;
      mrc20Ticker?: string;
      mrc20Id?: string;
      outputType: string;
      serviceIconDataUrl?: string | null;
    }) => Promise<{ success: boolean; txids?: string[]; pinId?: string; warning?: string; error?: string }>;
    revokeService: (params: { serviceId: string }) => Promise<GigSquareServiceMutationResult>;
    modifyService: (params: GigSquareModifyServiceParams) => Promise<GigSquareServiceMutationResult>;
    createServiceOrderPin: (params: {
      metabotId: number;
      servicePinId?: string | null;
      paymentTxid?: string | null;
      price?: string | null;
      currency?: string | null;
      settlementKind?: string | null;
      metadata?: string | null;
    }) => Promise<{ success: boolean; pinId?: string; txids?: string[]; error?: string }>;
    sendOrder: (params: {
      metabotId: number;
      toGlobalMetaId: string;
      toChatPubkey: string;
      orderPayload: string;
      peerName?: string | null;
      peerAvatar?: string | null;
      serviceId?: string | null;
      servicePrice?: string | null;
      serviceCurrency?: string | null;
      servicePaymentChain?: string | null;
      serviceSettlementKind?: 'native' | 'mrc20' | string | null;
      serviceMrc20Ticker?: string | null;
      serviceMrc20Id?: string | null;
      servicePaymentCommitTxid?: string | null;
      serviceSkill?: string | null;
      serviceOutputType?: string | null;
      serverBotGlobalMetaId?: string | null;
      serviceOrderPinId?: string | null;
      servicePaidTx?: string | null;
    }) => Promise<{ success: boolean; txids?: string[]; error?: string; errorCode?: 'open_order_exists' | 'self_order_not_allowed' | 'order_request_too_long' | string }>;
    pingProvider: (params: { metabotId: number; toGlobalMetaId: string; toChatPubkey: string; timeoutMs?: number }) => Promise<{ success: boolean; error?: string }>;
  };
  getApiConfig: () => Promise<CoworkApiConfig | null>;
  checkApiConfig: () => Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string }>;
  saveApiConfig: (config: CoworkApiConfig) => Promise<{ success: boolean; error?: string }>;
  deepseek: {
    /** Fetch wallet balance + availability from GET /user/balance. */
    getBalance: () => Promise<
      | { success: true; balance: { available: boolean; display: string; infos: Array<{ currency: string; totalBalance: number; grantedBalance: number; toppedUpBalance: number }> } }
      | { success: false; error: string }
    >;
  };
  generateSessionTitle: (userInput: string | null) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;
  getGitBranch: (cwd: string) => Promise<string | null>;
  appEvents: {
    onOpenSettings: (callback: () => void) => () => void;
    onNewTask: (callback: () => void) => () => void;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    moveBy: (dx: number, dy: number) => void;
    showSystemMenu: (position: { x: number; y: number }) => void;
    onStateChanged: (callback: (state: WindowState) => void) => () => void;
  };
  cowork: {
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; title?: string; activeSkillIds?: string[]; metabotId?: number | null; sessionType?: 'standard' | 'browser'; model?: string | null; modelProvider?: string | null; effort?: string | null; source?: 'quick_action'; goal?: string }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[] }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    submitInput: (input: CoworkSubmitInput) => Promise<CoworkSubmitInputResult>;
    setSessionGoal: (sessionId: string, goal: { text: string; status: 'active' | 'paused' } | null) => Promise<{ success: boolean; goal?: { text: string; status: 'active' | 'paused'; updatedAt: number } | null; error?: string }>;
    stopSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    setPermissionMode: (sessionId: string, permissionMode: CoworkPermissionMode) => Promise<{ success: boolean; error?: string }>;
    requestManualCompaction: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    exportTranscript: (sessionId: string) => Promise<{ success: boolean; cancelled?: boolean; path?: string; error?: string }>;
    stopTask: (sessionId: string, taskId: string) => Promise<{ success: boolean; error?: string }>;
    backgroundTask: (sessionId: string, toolUseId?: string) => Promise<{ success: boolean; backgrounded?: boolean; error?: string }>;
    setEffort: (sessionId: string, effort: string | null) => Promise<{ success: boolean; error?: string }>;
    forkSession: (sessionId: string, messageId: string, title?: string) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    rewindSession: (sessionId: string, messageId: string) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    getSubagents: (sessionId: string) => Promise<{ success: boolean; agents?: string[]; error?: string }>;
    getSubagentMessages: (sessionId: string, agentId: string, limit?: number) => Promise<{ success: boolean; messages?: CoworkMessage[]; error?: string }>;
    getAutoApproveTools: (sessionId: string) => Promise<{ success: boolean; tools?: string[]; error?: string }>;
    addAutoApproveTool: (sessionId: string, toolName: string) => Promise<{ success: boolean; error?: string }>;
    removeAutoApproveTool: (sessionId: string, toolName: string) => Promise<{ success: boolean; error?: string }>;
    endA2APrivateChat: (sessionId: string) => Promise<{ success: boolean; noticeSent?: boolean; error?: string }>;
    clearSessionError: (sessionId: string) => Promise<{ success: boolean; status?: CoworkSessionStatus; error?: string }>;
    ensureA2ASession: (input: CoworkEnsureA2ASessionInput) => Promise<CoworkEnsureA2ASessionResult>;
    queueA2AGuidance: (input: CoworkA2AGuidanceRequest) => Promise<CoworkA2AGuidanceResult>;
    sendOwnerA2AMessage: (input: CoworkA2AOwnerMessageRequest) => Promise<CoworkA2AOwnerMessageResult>;
    resendA2ADeliveryArtifact: (input: string | { sessionId: string; orderTxid?: string | null }) => Promise<{ success: boolean; deliveryPinId?: string | null; error?: string }>;
    archiveSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    unarchiveSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    listArchivedSessions: (options?: { metabotId?: number | null; query?: string; searchContent?: boolean; sessionType?: 'standard' | 'a2a' | 'browser' | 'group_task'; limit?: number; offset?: number }) => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; total?: number; error?: string }>;
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) => Promise<{ success: boolean; error?: string }>;
    setSessionFoldOverride: (options: { sessionId: string; override: 'in' | 'out' | null }) => Promise<{ success: boolean; error?: string }>;
    setSessionModel: (options: {
      sessionId: string;
      model: string | null;
      /** Optional per-session effort (off/low/high/max); undefined leaves it unchanged. */
      effort?: string | null;
      /** Provider key the model was picked from; required when model ids collide. */
      modelProvider?: string | null;
    }) => Promise<{ success: boolean; model?: string | null; error?: string }>;
    renameSession: (options: { sessionId: string; title: string }) => Promise<{ success: boolean; error?: string }>;
    setPlanMode: (options: { sessionId: string; active: boolean }) => Promise<{ ok: boolean; result?: string; plan?: { active: boolean; pending?: boolean }; reason?: string }>;
    getPlanMode: (options: { sessionId: string }) => Promise<{ ok: boolean; plan?: { active: boolean; pending?: boolean } | null; reason?: string }>;
    getSession: (sessionId: string, options?: { messageLimit?: number }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    refreshPeerProfile: (input: { sessionId: string; force?: boolean }) => Promise<{ success: boolean; changed?: boolean; error?: string }>;
    getSessionMessagesPage: (input: { sessionId: string; beforeSequence?: number | null; beforeTranscriptCursor?: string | null; limit?: number }) => Promise<{ success: boolean; page?: CoworkMessagePage; error?: string }>;
    setMessageFeedback: (input: { messageId: string; rating: 'up' | 'down' | null; comment?: string | null }) => Promise<{ success: boolean; feedback?: CoworkMessageFeedbackRecord | null; error?: string }>;
    listSessionFeedback: (input: { sessionId: string }) => Promise<{ success: boolean; feedback?: CoworkMessageFeedbackRecord[]; error?: string }>;
    getA2AConversationHistoryPage: (input: { sessionId: string; beforeCursor?: CoworkA2AHistoryCursor | null; limit?: number }) => Promise<{ success: boolean; page?: CoworkA2AHistoryPage; error?: string }>;
    getA2AEpisodes: (sessionId: string) => Promise<{ success: boolean; episodes?: CoworkA2AEpisodeInfo[]; error?: string }>;
    listSessions: (options?: { metabotId?: number | null }) => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; error?: string }>;
    listMetabotAvatars: (metabotIds: number[]) => Promise<{
      success: boolean;
      avatars?: Array<{ metabotId: number; avatar: string | null }>;
      error?: string;
    }>;
    processServiceRefund: (sessionId: string) => Promise<{
      success: boolean;
      refundTxid?: string;
      refundFinalizePinId?: string;
      session?: CoworkSession | null;
      error?: string;
    }>;
    readLocalImage: (options: {
      path: string;
      maxBytes?: number;
    }) => Promise<{ success: boolean; dataUrl?: string; mimeType?: string; size?: number; error?: string }>;
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => Promise<{ success: boolean; width?: number; height?: number; pngBase64?: string; error?: string }>;
    saveResultImage: (options: {
      pngBase64: string;
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    downloadMetafile: (options: {
      url: string;
      fallbackUrl?: string;
      fileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    respondToPermission: (options: { requestId: string; result: CoworkPermissionResult }) => Promise<{ success: boolean; error?: string }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (config: CoworkConfigUpdate) => Promise<{ success: boolean; error?: string }>;
    listMemoryEntries: (input: {
      sessionId?: string;
      metabotId?: number;
      scopeKind?: 'owner' | 'contact' | 'conversation';
      scopeKey?: string;
      usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'self_identity' | 'work_review' | 'value_boundary';
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      includeArchived?: boolean;
      limit?: number;
      offset?: number;
    }) => Promise<{ success: boolean; entries?: CoworkUserMemoryEntry[]; error?: string }>;
    unarchiveMemoryEntry: (input: { id: string }) => Promise<{ success: boolean; error?: string }>;
    onMemoryHygieneStatusChanged: (callback: (stats: MemoryHygieneRunStats) => void) => () => void;
    createMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      scopeKind?: 'owner' | 'contact' | 'conversation';
      scopeKey?: string;
      usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
      visibility?: 'local_only' | 'external_safe';
      text: string;
      confidence?: number;
      isExplicit?: boolean;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    updateMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      scopeKind?: 'owner' | 'contact' | 'conversation';
      scopeKey?: string;
      usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
      visibility?: 'local_only' | 'external_safe';
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    deleteMemoryEntry: (input: { sessionId?: string; metabotId?: number; id: string }) => Promise<{ success: boolean; error?: string }>;
    getMemoryStats: (input?: { sessionId?: string; metabotId?: number; scopeKind?: 'owner' | 'contact' | 'conversation'; scopeKey?: string }) => Promise<{ success: boolean; stats?: CoworkMemoryStats; error?: string }>;
    listMemoryScopes: (input: { metabotId?: number }) => Promise<{ success: boolean; overview?: CoworkMemoryScopesOverview; error?: string }>;
    getSessionMemoryScope: (input: { sessionId?: string }) => Promise<{ success: boolean; sessionScope?: CoworkSessionMemoryScope; error?: string }>;
    getMemoryPolicy: (input?: { sessionId?: string; metabotId?: number }) => Promise<{ success: boolean; policy?: CoworkMemoryPolicy; error?: string }>;
    setMemoryPolicy: (input: {
      metabotId: number;
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
      dreamEnabled?: boolean;
      hygieneEnabled?: boolean;
    }) => Promise<{ success: boolean; policy?: CoworkMemoryPolicy; error?: string }>;
    getMemoryHygiene: () => Promise<{
      success: boolean;
      config?: MemoryHygieneConfig;
      lastRun?: MemoryHygieneRunStats | null;
      error?: string;
    }>;
    setMemoryHygieneConfig: (input: Partial<MemoryHygieneConfig>) => Promise<{
      success: boolean;
      config?: MemoryHygieneConfig;
      error?: string;
    }>;
    runMemoryHygieneNow: () => Promise<{
      success: boolean;
      stats?: MemoryHygieneRunStats;
      error?: string;
    }>;
    listTeamCulture: (input?: {
      kind?: TeamCultureKind | 'all';
      status?: TeamCultureStatus | 'all';
      query?: string;
      limit?: number;
      offset?: number;
    }) => Promise<{
      success: boolean;
      entries?: TeamCultureEntry[];
      activeCounts?: TeamCultureActiveCounts;
      error?: string;
    }>;
    listTeamCultureDistillationLog: () => Promise<{
      success: boolean;
      records?: TeamCultureDistillationRecord[];
      error?: string;
    }>;
    upsertTeamCulture: (input: {
      kind?: TeamCultureKind;
      topic: string;
      text: string;
    }) => Promise<{
      success: boolean;
      entry?: TeamCultureEntry | null;
      displacedTopic?: string | null;
      capacitySkipped?: boolean;
      error?: string;
    }>;
    updateTeamCulture: (input: {
      id: string;
      kind?: TeamCultureKind;
      topic?: string;
      text?: string;
    }) => Promise<{
      success: boolean;
      entry?: TeamCultureEntry;
      error?: string;
    }>;
    archiveTeamCulture: (input: { id: string }) => Promise<{
      success: boolean;
      entry?: TeamCultureEntry;
      error?: string;
    }>;
    restoreTeamCulture: (input: { id: string }) => Promise<{
      success: boolean;
      entry?: TeamCultureEntry;
      error?: string;
    }>;
    deleteTeamCulture: (input: { id: string }) => Promise<{
      success: boolean;
      error?: string;
    }>;
    listTaskCommTrend: () => Promise<{
      success: boolean;
      tasks?: TaskCommTrendRow[];
      error?: string;
    }>;
    getTeamCultureConfig: () => Promise<{
      success: boolean;
      config?: { enabled: boolean };
      error?: string;
    }>;
    setTeamCultureConfig: (input: { enabled: boolean }) => Promise<{
      success: boolean;
      config?: { enabled: boolean };
      error?: string;
    }>;
    approveTeamCulture: (input: { id: string }) => Promise<{
      success: boolean;
      entry?: TeamCultureEntry;
      error?: string;
    }>;
    listKnowledge: (input: {
      metabotId: number;
      kind?: 'know_how' | 'pitfall' | 'principle';
      status?: 'active' | 'superseded' | 'archived' | 'all';
      query?: string;
      limit?: number;
      offset?: number;
    }) => Promise<{ success: boolean; entries?: CoworkKnowledgeEntry[]; error?: string }>;
    archiveKnowledge: (input: { id: string; metabotId: number }) => Promise<{ success: boolean; entry?: CoworkKnowledgeEntry; error?: string }>;
    updateKnowledge: (input: {
      id: string;
      metabotId: number;
      topic?: string;
      summary?: string;
      kind?: 'know_how' | 'pitfall' | 'principle';
    }) => Promise<{ success: boolean; entry?: CoworkKnowledgeEntry; error?: string }>;
    deleteKnowledge: (input: { id: string; metabotId: number }) => Promise<{ success: boolean; deleted?: boolean; error?: string }>;
    deleteMemoryPolicy: (input: { metabotId: number }) => Promise<{ success: boolean; deleted?: boolean; error?: string }>;
    getSandboxStatus: () => Promise<CoworkSandboxStatus>;
    installSandbox: () => Promise<{ success: boolean; status: CoworkSandboxStatus; error?: string }>;
    onSandboxDownloadProgress: (callback: (data: CoworkSandboxProgress) => void) => () => void;
    onStreamMessage: (callback: (data: { sessionId: string; message: CoworkMessage }) => void) => () => void;
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content?: string; delta?: string; baseLength?: number; metadata?: CoworkMessage['metadata'] }) => void) => () => void;
    getStreamLiveContent: (payload: { sessionId: string; messageId: string }) => Promise<{ success: boolean; content?: string }>;
    onStreamPermission: (callback: (data: { sessionId: string; request: CoworkPermissionRequest }) => void) => () => void;
    onStreamPermissionResolved: (callback: (data: { sessionId: string; requestId: string }) => void) => () => void;
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => () => void;
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
    onStreamSessionTitle: (callback: (data: { sessionId: string; title: string }) => void) => () => void;
    isDelegationBlocking: (sessionId: string) => Promise<boolean>;
    getDelegationInfo: (sessionId: string) => Promise<{ orderId: string } | null>;
    onDelegationStateChange: (callback: (data: { sessionId: string; blocking: boolean; orderId?: string; message?: string }) => void) => () => void;
    onSessionProfileRefreshed: (callback: (data: { sessionId: string }) => void) => () => void;
  };
  dialog: {
    selectDirectory: () => Promise<{ success: boolean; path: string | null }>;
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }) => Promise<{ success: boolean; path: string | null; paths?: string[] }>;
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) => Promise<{ success: boolean; path: string | null; error?: string }>;
  };
  shell: {
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
    getOpenWithApps: (filePath: string) => Promise<{ success: boolean; apps: OpenWithAppInfo[]; error?: string }>;
    openWith: (filePath: string, appId: string) => Promise<{ success: boolean; error?: string }>;
    chooseOpenWithApp: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };
  fs: {
    readTextFile: (filePath: string, maxBytes?: number) => Promise<{ success: boolean; content?: string; size?: number; limit?: number; error?: string }>;
  };
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  experimentalAutomation: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  feeRates: {
    getTiers: () => Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>;
    getSelected: () => Promise<Record<string, string>>;
    select: (chain: string, tierTitle: string) => Promise<{ success: boolean }>;
    refresh: () => Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>;
  };
  traffic: {
    ensureAccount: () => Promise<{ success: boolean; account?: TrafficAccountInfo; error?: string }>;
    getAccount: () => Promise<{ success: boolean; account?: TrafficAccountInfo | null; error?: string }>;
    getBalance: (input?: { forceRefresh?: boolean }) => Promise<{ success: boolean; balance?: TrafficAccountInfo; error?: string }>;
    getLedger: (input?: { cursor?: number; limit?: number; direction?: number }) => Promise<{ success: boolean; entries?: TrafficLedgerEntryInfo[]; nextCursor?: number; error?: string }>;
    getDailyUsage: (input?: { from?: number; to?: number; botAddress?: string }) => Promise<{ success: boolean; rows?: TrafficDailyUsageRowInfo[]; error?: string }>;
    getUsageSummary: () => Promise<{ success: boolean; summary?: { todayBytes: number; weekBytes: number; monthBytes: number }; error?: string }>;
    bindAllBots: () => Promise<{ success: boolean; summary?: TrafficBindSummaryInfo; error?: string }>;
    getLocalJournal: (input?: { limit?: number; botAddress?: string }) => Promise<{ success: boolean; entries?: TrafficSpendJournalEntryInfo[]; error?: string }>;
    getPricing: () => Promise<{ success: boolean; plans?: TrafficPricingPlanInfo[]; error?: string }>;
    getRechargeGateway: () => Promise<{ success: boolean; gateway?: 'paypal' | 'mock' | 'alipay'; packaged?: boolean; error?: string }>;
    createRechargeOrder: (input: { planId: string; gateway?: 'paypal' | 'mock' | 'alipay' }) => Promise<{ success: boolean; order?: TrafficRechargeOrderInfo; error?: string }>;
    getRechargeOrder: (input: { orderId: string }) => Promise<{ success: boolean; order?: TrafficRechargeOrderStatusInfo; error?: string }>;
    mockConfirmRechargeOrder: (input: { orderId: string }) => Promise<{ success: boolean; order?: TrafficRechargeOrderStatusInfo; error?: string }>;
    getFreeGrantCampaignStatus: () => Promise<{ success: boolean; campaign?: TrafficFreeGrantCampaignStatusInfo; error?: string; errorCode?: string }>;
    claimFreeGrant: () => Promise<{ success: boolean; claim?: TrafficFreeGrantClaimInfo; error?: string; errorCode?: string }>;
    redeemCode: (input: { code: string }) => Promise<{ success: boolean; result?: TrafficRedeemCodeInfo; error?: string; errorCode?: string }>;
    getSettings: () => Promise<{ success: boolean; settings?: TrafficSettingsInfo; error?: string }>;
    setSettings: (input: { mode?: string; fallbackPolicy?: string; apiBase?: string; rechargeGateway?: string }) => Promise<{ success: boolean; settings?: TrafficSettingsInfo; error?: string }>;
  };
  llmRelay: {
    bootstrap: () => Promise<{ success: boolean; result?: LlmRelayBootstrapInfo; error?: string }>;
    getQuota: (input: { apiKey: string; forceRefresh?: boolean }) => Promise<{ success: boolean; quota?: LlmRelayQuotaInfo; error?: string }>;
    setApiBase: (input: { apiBase: string }) => Promise<{ success: boolean; apiBase?: string; error?: string }>;
  };
  appInfo: {
    getVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
  };
  startup: {
    rendererInitialized: () => Promise<{
      success: boolean;
      elapsedMs: number;
      startedAt: number;
    }>;
  };
  appUpdate: {
    download: (url: string, version: string, sha256?: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    cancelDownload: () => Promise<{ success: boolean }>;
    install: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    applySilent: (filePath: string) => Promise<{ success: boolean; permissionDenied?: boolean; error?: string }>;
    relaunchNow: () => Promise<{ success: boolean }>;
    onDownloadProgress: (callback: (data: AppUpdateDownloadProgress) => void) => () => void;
  };
  im: {
    getConfig: () => Promise<{ success: boolean; config?: IMGatewayConfig; error?: string }>;
    setConfig: (config: Partial<IMGatewayConfig>) => Promise<{ success: boolean; error?: string }>;
    startGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord') => Promise<{ success: boolean; error?: string }>;
    stopGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord') => Promise<{ success: boolean; error?: string }>;
    testGateway: (
      platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord',
      configOverride?: Partial<IMGatewayConfig>
    ) => Promise<{ success: boolean; result?: IMConnectivityTestResult; error?: string }>;
    getStatus: () => Promise<{ success: boolean; status?: IMGatewayStatus; error?: string }>;
    onStatusChange: (callback: (status: IMGatewayStatus) => void) => () => void;
    onMessageReceived: (callback: (message: IMMessage) => void) => () => void;
  };
  scheduledTasks: {
    list: () => Promise<any>;
    get: (id: string) => Promise<any>;
    create: (input: any) => Promise<any>;
    update: (id: string, input: any) => Promise<any>;
    delete: (id: string) => Promise<any>;
    toggle: (id: string, enabled: boolean) => Promise<any>;
    runManually: (id: string) => Promise<any>;
    stop: (id: string) => Promise<any>;
    listRuns: (taskId: string, limit?: number, offset?: number) => Promise<any>;
    countRuns: (taskId: string) => Promise<any>;
    listAllRuns: (limit?: number, offset?: number) => Promise<any>;
    onStatusUpdate: (callback: (data: any) => void) => () => void;
    onRunUpdate: (callback: (data: any) => void) => () => void;
  };
  /**
   * Long-term task board (first-class redesign). Read the board/detail, owner
   * actions (update / pause·resume·cancel / subtask edit / accept·reject /
   * unblock / note). The Twin's channel is the longterm_* agent tools.
   * Main-process implementation: src/main/longTermTaskStore.ts.
   */
  longtermTask: {
    board: () => Promise<{ success: boolean; board?: LongTermBoard; error?: string }>;
    get: (input: { taskId: string }) => Promise<{ success: boolean; detail?: LongTermTaskDetail; error?: string }>;
    update: (input: LongTermTaskUpdateInput) => Promise<LongTermResult<LongTermTaskDetail>>;
    setStage: (input: { taskId: string; action: 'pause' | 'resume' | 'cancel'; note?: string }) => Promise<LongTermResult<LongTermTaskDetail | null>>;
    subtaskAdd: (input: { taskId: string } & LongTermSubtaskDraft) => Promise<LongTermResult<LongTermSubtask>>;
    subtaskUpdate: (input: LongTermSubtaskUpdateInput) => Promise<LongTermResult<LongTermSubtask>>;
    begin: (input: { subtaskId: string; channel?: LongTermSubtask['preferredChannel'] }) => Promise<LongTermResult<LongTermSubtask>>;
    accept: (input: { subtaskId: string; note?: string }) => Promise<LongTermResult<LongTermSubtask>>;
    reject: (input: { subtaskId: string; feedback: string }) => Promise<LongTermResult<LongTermSubtask>>;
    unblock: (input: { subtaskId: string; note?: string }) => Promise<LongTermResult<LongTermSubtask>>;
    note: (input: { taskId: string; subtaskId?: string; text: string }) => Promise<LongTermResult<null>>;
    /** Session-side origin chip: the owning task/sub-project, null = independent session. */
    forSession: (input: { sessionId: string }) => Promise<{
      success: boolean;
      hit?: { taskId: string; taskTitle: string; subtaskId: string | null; subtaskTitle: string | null } | null;
      error?: string;
    }>;
    moveSubtask: (input: { subtaskId: string; direction: 'up' | 'down' }) => Promise<LongTermResult<LongTermSubtask>>;
    /** seq is monotonic per process: drop frames with seq <= lastSeenSeq and refetch. */
    onUpdate: (callback: (data: { seq: number; taskIds: string[]; reason: string }) => void) => () => void;
  };
  /**
   * MetaTask (chain-side multi-bot collaboration, read path P1). Local
   * projection of on-chain tasks; the chain is the source of truth and every
   * payload carries the boundary block it was computed at.
   * Main-process implementation: src/main/services/metatask/.
   */
  metatask: {
    board: () => Promise<{ success: boolean; board?: import('./metatask').MetaTaskBoard; error?: string }>;
    get: (input: { rootPinId: string }) => Promise<{
      success: boolean;
      detail?: import('./metatask').MetaTaskTaskProjection;
      error?: string;
    }>;
    refresh: () => Promise<{ success: boolean; board?: import('./metatask').MetaTaskBoard; error?: string }>;
    /** seq is monotonic per process: drop frames with seq <= lastSeenSeq and refetch. */
    onUpdate: (callback: (data: { seq: number; reason: string }) => void) => () => void;
  };
  groupTask: {
    create: (input: { title: string; goal: string; acceptanceCriteria?: string; memberMetabotIds?: number[] }) => Promise<any>;
    list: (filter?: { status?: string }) => Promise<any>;
    get: (taskId: number) => Promise<any>;
    close: (input: { taskId: number; status: 'done' | 'cancelled'; reason?: string; rating?: number; ratingComment?: string }) => Promise<any>;
    reopen: (input: { taskId: number; reason?: string }) => Promise<any>;
    rework: (input: { taskId: number; reason?: string }) => Promise<any>;
    resume: (input: { taskId: number }) => Promise<any>;
    listMessages: (input: { taskId: number; beforeId?: number; limit?: number }) => Promise<any>;
    sendUserMessage: (input: { taskId: number; content: string }) => Promise<any>;
    kickMember: (input: { taskId: number; metabotId?: number; globalmetaid?: string; reason?: string }) => Promise<any>;
    rename: (input: { taskId: number; title: string }) => Promise<any>;
    pin: (input: { taskId: number; pinned: boolean }) => Promise<any>;
    archive: (input: { taskId: number }) => Promise<any>;
    unarchive: (input: { taskId: number }) => Promise<any>;
    listArchived: (options?: { offset?: number; limit?: number }) => Promise<any>;
    getTurnActivity: () => Promise<any>;
    onStatusChanged: (callback: (data: any) => void) => () => void;
    onOwnerReportDelivery: (callback: (data: any) => void) => () => void;
    onCheckpointChanged: (callback: (data: any) => void) => () => void;
    onTurnActivityChanged: (callback: (data: any) => void) => () => void;
  };
  openTeamCollab: {
    list: () => Promise<{ success: boolean; items?: OpenTeamCollabSummary[]; error?: string }>;
    listMessages: (input: { groupId: string; beforeId?: number; limit?: number }) =>
      Promise<{ success: boolean; messages?: GroupChatTranscriptMessage[]; error?: string }>;
    // P0-1: received-invite history (joined or not), newest first.
    listGuestInvites: () => Promise<{ success: boolean; items?: OpenTeamGuestInvite[]; error?: string }>;
  };
  idbots: {
    getMetaBots: () => Promise<{ success: boolean; list?: Array<{ id: number; name: string; avatar: string | null; metabot_type: string }>; error?: string }>;
    getOfficialSkillsStatus: () => Promise<{ success: boolean; skills?: OfficialSkillItem[]; error?: string }>;
    installOfficialSkill: (skill: { name: string; skillFileUri: string; remoteVersion: string; remoteCreator: string }) =>
      Promise<{ success: boolean; error?: string }>;
    syncAllOfficialSkills: () => Promise<{ success: boolean; error?: string }>;
    getCommunitySkillsStatus: () => Promise<{ success: boolean; skills?: OfficialSkillItem[]; error?: string }>;
    addMetaBot: (input: {
      name: string;
      avatar?: string | null;
      role: string;
      soul: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      llm_provider?: string | null;
      llm_effort?: string | null;
      allow_chat_skills?: string[];
      metabot_type?: 'twin' | 'worker' | 'welcome';
    }) => Promise<{
      success: boolean;
      metabot?: Metabot;
      subsidy?: { success: boolean; error?: string };
      error?: string;
    }>;
    restoreMetaBotFromMnemonic: (input: { mnemonic: string; path?: string; boss_global_metaid?: string | null }) => Promise<{ success: boolean; metabot?: Metabot; error?: string }>;
    getAddressBalance: (options: { metabotId?: number; addresses?: { btc?: string; mvc?: string; doge?: string } }) =>
      Promise<{
        success: boolean;
        balance?: { btc?: { value: number; unit: string }; mvc?: { value: number; unit: string }; doge?: { value: number; unit: string } };
        error?: string;
      }>;
    getMetabotWalletAssets: (input: { metabotId: number }) => Promise<{
      success: boolean;
      assets?: ElectronMetabotWalletAssets;
      error?: string;
    }>;
    getTransferFeeSummary: (chain: 'mvc' | 'doge' | 'btc') => Promise<{
      success: boolean;
      list?: Array<{ title: string; desc: string; feeRate: number }>;
      defaultFeeRate?: number;
      error?: string;
    }>;
    getTokenTransferFeeSummary: (input: { kind: 'mrc20' | 'mvc-ft' }) => Promise<{
      success: boolean;
      list?: Array<{ title: string; desc: string; feeRate: number }>;
      defaultFeeRate?: number;
      error?: string;
    }>;
    buildTransferPreview: (params: {
      metabotId: number;
      chain: 'mvc' | 'doge' | 'btc';
      toAddress: string;
      amountSpaceOrDoge: string;
      feeRate: number;
    }) => Promise<{
      success: boolean;
      preview?: {
        fromAddress: string;
        toAddress: string;
        amount: string;
        amountUnit: string;
        feeEstimated: string;
        feeEstimatedUnit: string;
        total: string;
        totalUnit: string;
        feeRateSatPerVb: number;
      };
      error?: string;
    }>;
    buildTokenTransferPreview: (params: {
      kind: 'mrc20' | 'mvc-ft';
      metabotId: number;
      asset: ElectronTokenTransferAsset;
      toAddress: string;
      amount: string;
      feeRate: number;
    }) => Promise<{
      success: boolean;
      preview?: {
        fromAddress: string;
        toAddress: string;
        amount: string;
        amountUnit: string;
        feeEstimated: string;
        feeEstimatedUnit: string;
        chainSymbol: 'BTC' | 'SPACE';
        feeRate: number;
      };
      error?: string;
    }>;
    executeTransfer: (params: {
      metabotId: number;
      chain: 'mvc' | 'doge' | 'btc';
      toAddress: string;
      amountSpaceOrDoge: string;
      feeRate: number;
    }) => Promise<{ success: boolean; txId?: string; error?: string }>;
    executeTokenTransfer: (params: {
      kind: 'mrc20' | 'mvc-ft';
      metabotId: number;
      asset: ElectronTokenTransferAsset;
      toAddress: string;
      amount: string;
      feeRate: number;
    }) => Promise<{
      success: boolean;
      result?: {
        txId: string;
        commitTxId?: string;
        revealTxId?: string;
        rawTx?: string;
      };
      error?: string;
    }>;
    getMetaBotMnemonic: (metabotId: number) => Promise<{ success: boolean; mnemonic?: string; error?: string }>;
    deleteMetaBot: (metabotId: number) => Promise<{ success: boolean; error?: string }>;
    syncMetaBot: (metabotId: number) => Promise<{
      success: boolean;
      error?: string;
      canSkip?: boolean;
      metabotInfoPinId?: string;
      chatPublicKeyPinId?: string;
      txids?: string[];
    }>;
    syncMetaBotEditChanges: (input: {
      metabotId: number;
      syncName?: boolean;
      syncAvatar?: boolean;
      syncBio?: boolean;
      syncPersona?: boolean;
      syncLlm?: boolean;
      syncChatSkills?: boolean;
      syncHomepage?: boolean;
      syncOwner?: boolean;
    }) => Promise<{
      success: boolean;
      error?: string;
      metabotInfoPinId?: string;
      txids?: string[];
      syncedSteps?: Array<'name' | 'avatar' | 'bio' | 'persona' | 'llm' | 'chatSkills' | 'homepage' | 'owner'>;
    }>;
    /** Create-fallback resume: retry the gas subsidy, or broadcast with the bot's own funds. */
    resumeMetabotSetup: (input: { metabotId: number; mode: 'subsidized' | 'self-funded' }) => Promise<{
      success: boolean;
      metabot?: Metabot;
      mode: 'subsidized' | 'self-funded';
      subsidy?: { success: boolean; error?: string };
      selfFundedBlocked?: { reason: 'no_balance'; mvcAddress: string; spendableSatoshis: number };
      chain?: {
        success: boolean;
        canSkip?: boolean;
        error?: string;
        txids?: string[];
        plannedSteps?: string[];
        syncedSteps?: string[];
      };
      alreadySynced?: boolean;
      error?: string;
    }>;
    createMetaBotOnChain: (input: {
      name: string;
      avatar?: string | null;
      role?: string;
      soul?: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      llm_provider?: string | null;
      llm_effort?: string | null;
      fallback_llm_id?: string | null;
      fallback_llm_provider?: string | null;
      fallback_llm_effort?: string | null;
      allow_chat_skills?: string[];
      a2a_max_incoming_turns?: number | null;
      a2a_bye_cooldown_ms?: number | null;
      a2a_auto_reply_enabled?: boolean | null;
      metabot_type?: 'twin' | 'worker' | 'welcome';
      homepage?: string | null;
    }) => Promise<{
      success: boolean;
      error?: string;
      canSkip?: boolean;
      metabot?: Metabot;
      subsidy?: { success: boolean; error?: string };
      chainPartial?: boolean;
      chainError?: string;
      /** Nothing landed on-chain at creation; the bot exists locally and can be resumed. */
      chainSetupPending?: boolean;
    }>;
    uploadMetabotHomepageFile: (input: {
      metabotId: number;
      fileName: string;
      contentType?: string;
      base64: string;
      network?: string;
    }) => Promise<{
      success: boolean;
      error?: string;
      pinId?: string;
      metafileUri?: string;
      contentType?: string;
    }>;
  };
  userIdentity: {
    get: () => Promise<{ success: boolean; identity?: PublicUserIdentity | null; error?: string }>;
    create: (input: { name: string; avatar?: string | null }) => Promise<{
      success: boolean;
      identity?: PublicUserIdentity | null;
      /** Present only on create, for the one-time backup step. */
      mnemonic?: string;
      subsidy?: UserIdentitySubsidyResult;
      chainSync?: UserIdentityChainSyncResult;
      error?: string;
    }>;
    importFromMnemonic: (input: { mnemonic: string; path?: string }) => Promise<{
      success: boolean;
      identity?: PublicUserIdentity | null;
      profileSource?: 'chain' | 'local';
      subsidy?: UserIdentitySubsidyResult;
      chainSync?: UserIdentityChainSyncResult;
      error?: string;
    }>;
    updateName: (input: { name: string }) => Promise<{
      success: boolean;
      identity?: PublicUserIdentity | null;
      chainSync?: UserIdentityChainSyncResult;
      error?: string;
    }>;
    logout: () => Promise<{ success: boolean; error?: string }>;
    revealMnemonic: () => Promise<{ success: boolean; mnemonic?: string; error?: string }>;
    retrySubsidy: () => Promise<{ success: boolean; identity?: PublicUserIdentity | null; subsidy?: UserIdentitySubsidyResult; error?: string }>;
    retryChainSync: () => Promise<{ success: boolean; identity?: PublicUserIdentity | null; subsidy?: UserIdentitySubsidyResult; chainSync?: UserIdentityChainSyncResult; error?: string }>;
    syncToMobile: () => Promise<{
      success: boolean;
      botCount: number;
      boundCount: number;
      newlyBound: number;
      skippedUnbound: string[];
      pinId?: string;
      txids: string[];
      error?: string;
    }>;
  };
  metaWebListener: {
    getListenerConfig: () => Promise<{ success: boolean; config?: { enabled: boolean; groupChats: boolean; privateChats: boolean; serviceRequests: boolean; respondToStrangerPrivateChats: boolean }; error?: string }>;
    getListenerStatus: () => Promise<{ success: boolean; running?: boolean; error?: string }>;
    toggleListener: (payload: { type: 'enabled' | 'groupChats' | 'privateChats' | 'serviceRequests' | 'respondToStrangerPrivateChats'; enabled: boolean }) => Promise<{ success: boolean; error?: string }>;
    startMetaWebListener: () => Promise<{ success: boolean; error?: string }>;
    onListenerLog: (callback: (log: string) => void) => () => void;
    assignGroupChatTask: (params: AssignGroupChatTaskParams) => Promise<AssignGroupChatTaskResult>;
  };
  metabot: {
    list: () => Promise<{ success: boolean; list?: Metabot[]; error?: string }>;
    get: (id: number) => Promise<{ success: boolean; metabot?: Metabot | null; error?: string }>;
    create: (input: MetabotCreateInput) => Promise<{ success: boolean; metabot?: Metabot; error?: string }>;
    update: (id: number, input: MetabotUpdateInput) => Promise<{
      success: boolean;
      metabot?: Metabot | null;
      /** On-chain sync outcome; absent when nothing was published (local-only change). */
      sync?: {
        skipped: boolean;
        success: boolean;
        canSkip?: boolean;
        error?: string;
        txids?: string[];
        syncedSteps?: string[];
        attemptedStepKeys?: Array<'name' | 'avatar' | 'bio' | 'persona' | 'llm' | 'chatSkills' | 'homepage' | 'owner'>;
        remainingSyncInput?: Record<string, unknown>;
      };
      error?: string;
    }>;
    setEnabled: (id: number, enabled: boolean) => Promise<{ success: boolean; metabot?: Metabot | null; error?: string }>;
    /** Per-metabot kv settings; key must be whitelisted in src/main/services/metabotSettingsService.ts. */
    getSetting: (id: number, key: string) => Promise<{ success: boolean; value?: string | null; error?: string }>;
    setSetting: (id: number, key: string, value: string) => Promise<{ success: boolean; value?: string; error?: string }>;
    checkNameExists: (options: { name: string; excludeId?: number }) => Promise<{ success: boolean; exists?: boolean; error?: string }>;
  };
  dream: {
    getStatus: () => Promise<{ success: boolean; dreamingBotIds?: number[]; error?: string }>;
    listDailySummaries: (options: { metabotId: number; limit?: number; offset?: number }) => Promise<{
      success: boolean;
      summaries?: Array<{
        id: string;
        metabotId: number;
        summaryDate: string;
        summaryText: string;
        sections: Record<string, string>;
        stats: Record<string, number>;
        llmId: string | null;
        createdAt: number;
        updatedAt: number;
      }>;
      error?: string;
    }>;
    listRuns: (options: { metabotId: number; limit?: number }) => Promise<{
      success: boolean;
      runs?: Array<{
        id: string;
        metabotId: number;
        dreamDate: string;
        status: 'running' | 'completed' | 'failed' | 'terminal-failed';
        attemptCount: number;
        llmId: string | null;
        dreamVersion: number;
        error: string | null;
        telemetry: Record<string, unknown> | null;
        startedAt: number;
        completedAt: number | null;
        /** Failed runs only: when the scheduler's backoff makes the date eligible again; null for terminal-failed runs. */
        nextRetryAt: number | null;
      }>;
      error?: string;
    }>;
    listCapabilityDrafts: (options: { metabotId: number; limit?: number }) => Promise<{
      success: boolean;
      drafts?: Array<{
        id: number;
        metabotId: number;
        dreamDate: string;
        title: string;
        description: string;
        capabilityType: string;
        status: 'draft' | 'validated' | 'rejected';
        createdAt: number;
        validationScore: number | null;
        validationNotes: string | null;
        validatedAt: number | null;
        timesInjected: number;
        lastInjectedAt: number | null;
        promotedAt: number | null;
        promotedProcedureId: string | null;
        lastReviewedAt: number | null;
      }>;
      error?: string;
    }>;
    listTelemetryDaily: (options: { metabotId: number; sinceDays?: number }) => Promise<{
      success: boolean;
      days?: Array<{
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
        hasExplicitFeedback: boolean;
        extraJson: Record<string, unknown>;
        updatedAt: number;
      }>;
      error?: string;
    }>;
    runNow: (options: { metabotId: number; date?: string }) => Promise<{
      success: boolean;
      metabotId?: number;
      date?: string;
      run?: {
        id: string;
        metabotId: number;
        dreamDate: string;
        status: 'running' | 'completed' | 'failed' | 'terminal-failed';
        attemptCount: number;
        llmId: string | null;
        dreamVersion: number;
        error: string | null;
        startedAt: number;
        completedAt: number | null;
      } | null;
      error?: string;
    }>;
    onStatusChanged: (callback: (payload: { metabotId: number; dreaming: boolean }) => void) => () => void;
  };
  knowledgeBase: {
    list: (metabotId: number) => Promise<{ success: boolean; knowledgeBases?: KnowledgeBaseInfo[]; error?: string }>;
    create: (metabotId: number, input: { name: string; description?: string; rawDir?: string }) => Promise<{ success: boolean; knowledgeBase?: KnowledgeBaseInfo; error?: string }>;
    update: (metabotId: number, kbId: string, patch: { name?: string; description?: string; autoLearn?: boolean }) => Promise<{ success: boolean; knowledgeBase?: KnowledgeBaseInfo; error?: string }>;
    remove: (metabotId: number, kbId: string) => Promise<{ success: boolean; error?: string }>;
    learn: (metabotId: number, kbId: string, options?: { full?: boolean }) => Promise<{ success: boolean; summary?: KnowledgeBaseLearnSummary; error?: string }>;
    importFiles: (metabotId: number, kbId: string, filePaths: string[]) => Promise<{ success: boolean; imported?: string[]; skipped?: Array<{ filePath: string; reason: string }>; error?: string }>;
    openDir: (metabotId: number, kbId: string) => Promise<{ success: boolean; path?: string; error?: string }>;
    onLearnStatus: (callback: (payload: KnowledgeBaseLearnStatusEvent) => void) => () => void;
  };
  metawebStudy: {
    list: (metabotId: number) => Promise<{ success: boolean; jobs?: MetawebStudyJobInfo[]; error?: string }>;
  };
  surf: {
    listRuns: (metabotId: number, limit?: number) => Promise<{ success: boolean; runs?: MetawebSurfRunInfo[]; error?: string }>;
    runNow: (metabotId: number) => Promise<{ success: boolean; runId?: string; error?: string }>;
    onStatusChanged: (callback: (payload: { metabotId: number; runId: string; trigger: string; status: string; error?: string | null }) => void) => () => void;
  };
  permissions: {
    checkCalendar: () => Promise<{ success: boolean; status?: string; error?: string; autoRequested?: boolean }>;
    requestCalendar: () => Promise<{ success: boolean; granted?: boolean; status?: string; error?: string }>;
  };
  networkStatus: {
    send: (status: 'online' | 'offline') => void;
  };
  mcp: {
    list: () => Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }>;
    create: (data: McpServerFormData) => Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }>;
    update: (id: string, data: Partial<McpServerFormData>) => Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }>;
  };
  projects: {
    list: () => Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }>;
    create: (data: ProjectFormData) => Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }>;
    update: (id: string, data: Partial<ProjectFormData>) => Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; projects?: ProjectRecord[]; error?: string }>;
  };
  // Namespace kept under its legacy `p2p` name; it only bridges the metaid
  // user-info/contacts IPC channels.
  p2p: {
    getUserInfo: (params: { globalMetaId: string }) => Promise<unknown>;
    resolveAvatarSource: (params: { reference: string }) => Promise<unknown>;
    listContacts: (params: { observerGlobalMetaId: string }) => Promise<{ success: boolean; contacts?: CoworkMetaIDContactSummary[]; error?: string }>;
    getContactDetail: (params: { observerGlobalMetaId: string; subjectGlobalMetaId: string }) => Promise<{ success: boolean; detail?: CoworkMetaIDContactDetail; error?: string }>;
  };
  providerDiscovery: {
    getOnlineServices: () => Promise<{ success: boolean; services?: unknown[]; error?: string }>;
    getOnlineBots: () => Promise<{ success: boolean; bots?: Record<string, number>; error?: string }>;
    getSnapshot: () => Promise<{ success: boolean; snapshot?: ElectronProviderDiscoverySnapshot; error?: string }>;
    onChanged: (callback: (snapshot: ElectronProviderDiscoverySnapshot) => void) => () => void;
  };
}

// IM Gateway types
interface IMGatewayConfig {
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  settings: IMSettings;
}

interface DingTalkConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  metabotId?: number | null;
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  messageType: 'markdown' | 'card';
  cardTemplateId?: string;
  debug?: boolean;
}

interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  metabotId?: number | null;
  domain: 'feishu' | 'lark' | string;
  encryptKey?: string;
  verificationToken?: string;
  renderMode: 'text' | 'card';
  debug?: boolean;
}

interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  metabotId?: number | null;
  debug?: boolean;
}

interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  metabotId?: number | null;
  debug?: boolean;
}

interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
}

interface ElectronMrc20Asset {
  kind: 'mrc20';
  chain: 'btc';
  symbol: string;
  tokenName: string;
  mrc20Id: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    pendingIn: string;
    pendingOut: string;
    display: string;
  };
}

interface ElectronMvcFtAsset {
  kind: 'mvc-ft';
  chain: 'mvc';
  symbol: string;
  tokenName: string;
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    display: string;
  };
}

interface ElectronNativeWalletAsset {
  kind: 'native';
  chain: 'btc' | 'doge' | 'mvc';
  symbol: 'BTC' | 'DOGE' | 'SPACE';
  address: string;
  balance: {
    confirmed: string;
    display: string;
  };
}

interface ElectronMetabotWalletAssets {
  metabotId: number;
  nativeAssets: ElectronNativeWalletAsset[];
  mrc20Assets: ElectronMrc20Asset[];
  mvcFtAssets: ElectronMvcFtAsset[];
}

type ElectronTokenTransferAsset = ElectronMrc20Asset | ElectronMvcFtAsset;

interface IMGatewayStatus {
  dingtalk: DingTalkGatewayStatus;
  feishu: FeishuGatewayStatus;
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
}

type IMConnectivityVerdict = 'pass' | 'warn' | 'fail';

type IMConnectivityCheckLevel = 'pass' | 'info' | 'warn' | 'fail';

type IMConnectivityCheckCode =
  | 'missing_credentials'
  | 'auth_check'
  | 'gateway_running'
  | 'inbound_activity'
  | 'outbound_activity'
  | 'platform_last_error'
  | 'feishu_group_requires_mention'
  | 'feishu_event_subscription_required'
  | 'discord_group_requires_mention'
  | 'telegram_privacy_mode_hint'
  | 'dingtalk_bot_membership_hint';

interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

interface IMConnectivityTestResult {
  platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord';
  testedAt: number;
  verdict: IMConnectivityVerdict;
  checks: IMConnectivityCheck[];
}

interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface DiscordGatewayStatus {
  connected: boolean;
  starting: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface IMMessage {
  platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord';
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }

  /** An application detected on the current OS that can open a file (used by the file right-click menu). */
  interface OpenWithAppInfo {
    id: string;
    name: string;
  }
}

export {}; 
