import type { McpServerConfig, McpServerFormData } from './mcp';
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

interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  error?: string;
}

interface ApiStreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  error?: string;
}

interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
}

interface ElectronP2PStatus {
  running: boolean;
  peerCount?: number;
  storageLimitReached?: boolean;
  storageUsedBytes?: number;
  dataSource?: string;
  syncMode?: 'self' | 'selective' | 'full' | string;
  runtimeMode?: 'p2p-only' | 'chain-enabled' | string;
  peerId?: string;
  listenAddrs?: string[];
  error?: string;
}

interface ElectronP2PConfig {
  p2p_sync_mode: 'self' | 'selective' | 'full';
  p2p_selective_addresses?: string[];
  p2p_selective_paths?: string[];
  p2p_block_addresses?: string[];
  p2p_block_paths?: string[];
  p2p_max_content_size_kb?: number;
  p2p_bootstrap_nodes: string[];
  p2p_enable_relay: boolean;
  p2p_storage_limit_gb: number;
  p2p_enable_chain_source: boolean;
  p2p_own_addresses: string[];
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
  createdAt: number;
  updatedAt: number;
  metabotId?: number | null;
  sessionType?: 'standard' | 'a2a';
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
  metabotName?: string | null;
  metabotAvatar?: string | null;
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

interface CoworkServiceOrderSummary {
  role?: 'buyer' | 'seller';
  status: 'awaiting_first_response' | 'in_progress' | 'completed' | 'failed' | 'refund_pending' | 'refunded';
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
  sessionType?: 'standard' | 'a2a';
  peerName?: string | null;
  serviceOrderSummary?: CoworkServiceOrderSummary | null;
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
>>;

interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: 'created' | 'stale' | 'deleted';
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
  source: 'global' | 'metabot';
}

interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
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
  metabot_type: 'twin' | 'worker';
  role: string;
  soul: string;
  goal: string | null;
  background: string | null;
  boss_id: number | null;
  boss_global_metaid: string | null;
  llm_id: string | null;
  tools: string[];
  skills: string[];
  created_at: number;
  updated_at: number;
}

interface MetabotCreateInput {
  name: string;
  avatar?: string | null;
  metabot_type: 'twin' | 'worker';
  role: string;
  soul: string;
  goal?: string | null;
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
}

interface MetabotUpdateInput {
  name?: string;
  avatar?: string | null;
  enabled?: boolean;
  metabot_type?: 'twin' | 'worker';
  role?: string;
  soul?: string;
  goal?: string | null;
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
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
  /** Allowed skill names for tool hook, e.g. ["metabot-omni-caster"]. */
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
  };
  skills: {
    list: () => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    download: (source: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    getRoot: () => Promise<{ success: boolean; path?: string; error?: string }>;
    autoRoutingPrompt: () => Promise<{ success: boolean; prompt?: string | null; error?: string }>;
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
      providerSkill: string;
      price: string;
      currency: string;
      mrc20Ticker?: string;
      mrc20Id?: string;
      outputType: string;
      serviceIconDataUrl?: string | null;
    }) => Promise<{ success: boolean; txids?: string[]; pinId?: string; warning?: string; error?: string }>;
    revokeService: (params: { serviceId: string }) => Promise<GigSquareServiceMutationResult>;
    modifyService: (params: GigSquareModifyServiceParams) => Promise<GigSquareServiceMutationResult>;
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
      servicePaidTx?: string | null;
    }) => Promise<{ success: boolean; txids?: string[]; error?: string; errorCode?: 'open_order_exists' | 'self_order_not_allowed' | 'order_request_too_long' | string }>;
    pingProvider: (params: { metabotId: number; toGlobalMetaId: string; toChatPubkey: string; timeoutMs?: number }) => Promise<{ success: boolean; error?: string }>;
  };
  getApiConfig: () => Promise<CoworkApiConfig | null>;
  checkApiConfig: () => Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string }>;
  saveApiConfig: (config: CoworkApiConfig) => Promise<{ success: boolean; error?: string }>;
  generateSessionTitle: (userInput: string | null) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;
  appEvents: {
    onOpenSettings: (callback: () => void) => () => void;
    onNewTask: (callback: () => void) => () => void;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    showSystemMenu: (position: { x: number; y: number }) => void;
    onStateChanged: (callback: (state: WindowState) => void) => () => void;
  };
  cowork: {
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; title?: string; activeSkillIds?: string[]; metabotId?: number | null }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[] }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    stopSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    endA2APrivateChat: (sessionId: string) => Promise<{ success: boolean; noticeSent?: boolean; error?: string }>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) => Promise<{ success: boolean; error?: string }>;
    renameSession: (options: { sessionId: string; title: string }) => Promise<{ success: boolean; error?: string }>;
    getSession: (sessionId: string) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    listSessions: () => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; error?: string }>;
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
    respondToPermission: (options: { requestId: string; result: CoworkPermissionResult }) => Promise<{ success: boolean; error?: string }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (config: CoworkConfigUpdate) => Promise<{ success: boolean; error?: string }>;
    listMemoryEntries: (input: {
      sessionId?: string;
      metabotId?: number;
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      limit?: number;
      offset?: number;
    }) => Promise<{ success: boolean; entries?: CoworkUserMemoryEntry[]; error?: string }>;
    createMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      text: string;
      confidence?: number;
      isExplicit?: boolean;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    updateMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    deleteMemoryEntry: (input: { sessionId?: string; metabotId?: number; id: string }) => Promise<{ success: boolean; error?: string }>;
    getMemoryStats: (input?: { sessionId?: string; metabotId?: number }) => Promise<{ success: boolean; stats?: CoworkMemoryStats; error?: string }>;
    getMemoryPolicy: (input?: { sessionId?: string; metabotId?: number }) => Promise<{ success: boolean; policy?: CoworkMemoryPolicy; error?: string }>;
    setMemoryPolicy: (input: {
      metabotId: number;
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
    }) => Promise<{ success: boolean; policy?: CoworkMemoryPolicy; error?: string }>;
    getSandboxStatus: () => Promise<CoworkSandboxStatus>;
    installSandbox: () => Promise<{ success: boolean; status: CoworkSandboxStatus; error?: string }>;
    onSandboxDownloadProgress: (callback: (data: CoworkSandboxProgress) => void) => () => void;
    onStreamMessage: (callback: (data: { sessionId: string; message: CoworkMessage }) => void) => () => void;
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content: string }) => void) => () => void;
    onStreamPermission: (callback: (data: { sessionId: string; request: CoworkPermissionRequest }) => void) => () => void;
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => () => void;
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
    isDelegationBlocking: (sessionId: string) => Promise<boolean>;
    getDelegationInfo: (sessionId: string) => Promise<{ orderId: string } | null>;
    onDelegationStateChange: (callback: (data: { sessionId: string; blocking: boolean; orderId?: string; message?: string }) => void) => () => void;
  };
  dialog: {
    selectDirectory: () => Promise<{ success: boolean; path: string | null }>;
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; path: string | null }>;
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) => Promise<{ success: boolean; path: string | null; error?: string }>;
  };
  shell: {
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  };
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  feeRates: {
    getTiers: () => Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>;
    getSelected: () => Promise<Record<string, string>>;
    select: (chain: string, tierTitle: string) => Promise<{ success: boolean }>;
    refresh: () => Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>;
  };
  appInfo: {
    getVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
  };
  appUpdate: {
    download: (url: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    cancelDownload: () => Promise<{ success: boolean }>;
    install: (filePath: string) => Promise<{ success: boolean; error?: string }>;
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
  idbots: {
    getMetaBots: () => Promise<{ success: boolean; list?: Array<{ id: number; name: string; avatar: string | null; metabot_type: string }>; error?: string }>;
    getOfficialSkillsStatus: () => Promise<{ success: boolean; skills?: OfficialSkillItem[]; error?: string }>;
    installOfficialSkill: (skill: { name: string; skillFileUri: string; remoteVersion: string; remoteCreator: string }) =>
      Promise<{ success: boolean; error?: string }>;
    syncAllOfficialSkills: () => Promise<{ success: boolean; error?: string }>;
    addMetaBot: (input: {
      name: string;
      avatar?: string | null;
      role: string;
      soul: string;
      goal?: string | null;
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      metabot_type?: 'twin' | 'worker';
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
    }) => Promise<{
      success: boolean;
      error?: string;
      metabotInfoPinId?: string;
      txids?: string[];
      syncedSteps?: Array<'name' | 'avatar' | 'bio'>;
    }>;
    createMetaBotOnChain: (input: {
      name: string;
      avatar?: string | null;
      role: string;
      soul: string;
      goal?: string | null;
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      metabot_type?: 'twin' | 'worker';
    }) => Promise<{
      success: boolean;
      error?: string;
      canSkip?: boolean;
      metabot?: Metabot;
      subsidy?: { success: boolean; error?: string };
      chainPartial?: boolean;
      chainError?: string;
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
    update: (id: number, input: MetabotUpdateInput) => Promise<{ success: boolean; metabot?: Metabot | null; error?: string }>;
    setEnabled: (id: number, enabled: boolean) => Promise<{ success: boolean; metabot?: Metabot | null; error?: string }>;
    checkNameExists: (options: { name: string; excludeId?: number }) => Promise<{ success: boolean; exists?: boolean; error?: string }>;
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
  p2p: {
    getStatus: () => Promise<ElectronP2PStatus>;
    getConfig: () => Promise<ElectronP2PConfig>;
    setConfig: (config: Partial<ElectronP2PConfig>) => Promise<ElectronP2PConfig>;
    getPeers: () => Promise<string[]>;
    getUserInfo: (params: { globalMetaId: string }) => Promise<unknown>;
    onStatusUpdate: (callback: (status: ElectronP2PStatus) => void) => () => void;
    onSyncProgress: (callback: (data: unknown) => void) => () => void;
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
}

export {}; 
