/**
 * IM Gateway Types for Renderer Process
 * Mirrors src/main/im/types.ts for use in React components
 */

// ==================== DingTalk Types ====================

export interface DingTalkConfig {
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

export interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Feishu Types ====================

export interface FeishuConfig {
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

export interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Telegram Types ====================

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  metabotId?: number | null;
  debug?: boolean;
  /** Optional HTTP(S) proxy URL for connectivity (e.g. in restricted networks) */
  proxyUrl?: string;
}

export interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Discord Types ====================

export interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  metabotId?: number | null;
  debug?: boolean;
}

export interface DiscordGatewayStatus {
  connected: boolean;
  starting: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Weixin Types ====================

export interface WeixinConfig {
  enabled: boolean;
  accountId: string;
  /** Bot token from QR authorization; kept in the main-process credential file. */
  token?: string;
  baseUrl?: string;
  metabotId?: number | null;
  debug?: boolean;
}

export interface WeixinGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  accountId: string | null;
  loginPending: boolean;
  loginState: 'idle' | 'wait' | 'scanned';
  qrContent: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== QQ Types ====================

export interface QQConfig {
  enabled: boolean;
  /** QQ Open Platform AppID (public identifier). */
  appId: string;
  botId?: string | null;
  ownerUserOpenid?: string | null;
  /**
   * Write-only: the renderer may send an AppSecret to `im:qq:credentials:set`,
   * but `im:config:get` never returns one. Do not render or persist this value.
   */
  appSecret?: string;
  metabotId?: number | null;
  debug?: boolean;
  /** Group policy: open | allowlist | disabled. Missing => strictest. */
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  /** Group OpenIDs served when groupPolicy === 'allowlist'. */
  groupAllowlist?: string[];
  /** Layer 3 (local machine operations). Default OFF. */
  localToolsEnabled?: boolean;
  /** Stable ids allowed to use layer 3 after the switch is on. */
  localToolsAllowFrom?: string[];
  /**
   * Daily budget for admitted group messages, across all groups. Default 500.
   * The per-minute limits are hard-coded, not configurable.
   */
  dailyReplyLimit?: number;
}

export interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  appId: string | null;
  loginPending: boolean;
  loginState: 'idle' | 'wait' | 'scanned' | 'confirmed' | 'expired' | 'error';
  qrContent: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

/**
 * Result of the optional platform group-name lookup.
 *
 *   ok          a name is available
 *   forbidden   the endpoint exists but is whitelist-only (code 11253) — the UI
 *               must say "only the group ID is available" instead of guessing
 *   unavailable no credentials, or the lookup was never run
 *   error       network / unexpected failure
 */
export type QQGroupNameStatus = 'ok' | 'forbidden' | 'unavailable' | 'error';

/**
 * A group that messaged the bot while NOT allowlisted.
 *
 * The 32-hex `groupId` is the only identifier the platform guarantees and is
 * always present; `name` is an optional extra. Authorising happens by adding
 * `groupId` to `groupAllowlist` — never by typing it.
 */
export interface QQGroupCandidateView {
  groupId: string;
  name: string | null;
  nameStatus: QQGroupNameStatus;
  nameCheckedAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
  ignored: boolean;
  allowed: boolean;
}

// ==================== Common IM Types ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'weixin' | 'qq';

export interface IMGatewayConfig {
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  weixin: WeixinConfig;
  qq: QQConfig;
  settings: IMSettings;
}

export interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
}

export interface IMGatewayStatus {
  dingtalk: DingTalkGatewayStatus;
  feishu: FeishuGatewayStatus;
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
  weixin: WeixinGatewayStatus;
  qq: QQGatewayStatus;
}

// ==================== Media Attachment Types ====================

export type TelegramMediaType = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface IMMediaAttachment {
  type: TelegramMediaType;
  localPath: string;          // 下载后的本地路径
  mimeType: string;           // MIME 类型
  fileName?: string;          // 原始文件名
  fileSize?: number;          // 文件大小（字节）
  width?: number;             // 图片/视频宽度
  height?: number;            // 图片/视频高度
  duration?: number;          // 音视频时长（秒）
}

export interface IMMessage {
  platform: IMPlatform;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
  // 媒体附件（Telegram 支持）
  attachments?: IMMediaAttachment[];
  mediaGroupId?: string;      // 媒体组 ID（用于合并多张图片）
}

// ==================== IPC Result Types ====================

export interface IMConfigResult {
  success: boolean;
  config?: IMGatewayConfig;
  error?: string;
}

export interface IMStatusResult {
  success: boolean;
  status?: IMGatewayStatus;
  error?: string;
}

export interface IMGatewayResult {
  success: boolean;
  error?: string;
}

// ==================== Connectivity Test Types ====================

export type IMConnectivityVerdict = 'pass' | 'warn' | 'fail';

export type IMConnectivityCheckLevel = 'pass' | 'info' | 'warn' | 'fail';

export type IMConnectivityCheckCode =
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

export interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

export interface IMConnectivityTestResult {
  platform: IMPlatform;
  testedAt: number;
  verdict: IMConnectivityVerdict;
  checks: IMConnectivityCheck[];
}

export interface IMConnectivityTestResponse {
  success: boolean;
  result?: IMConnectivityTestResult;
  error?: string;
}

// ==================== Default Configurations ====================

export const DEFAULT_DINGTALK_CONFIG: DingTalkConfig = {
  enabled: false,
  clientId: '',
  clientSecret: '',
  metabotId: null,
  messageType: 'markdown',
  debug: true,
};

export const DEFAULT_FEISHU_CONFIG: FeishuConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  metabotId: null,
  domain: 'feishu',
  renderMode: 'text',
  debug: true,
};

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  botToken: '',
  metabotId: null,
  debug: true,
};

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  botToken: '',
  metabotId: null,
  debug: true,
};

export const DEFAULT_IM_SETTINGS: IMSettings = {
  systemPrompt: '',
  skillsEnabled: true,
};

export const DEFAULT_WEIXIN_CONFIG: WeixinConfig = {
  enabled: false,
  accountId: 'default',
  token: '',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  metabotId: null,
  debug: true,
};

export const DEFAULT_QQ_CONFIG: QQConfig = {
  enabled: false,
  appId: '',
  botId: null,
  ownerUserOpenid: null,
  metabotId: null,
  debug: true,
};

export const DEFAULT_IM_CONFIG: IMGatewayConfig = {
  dingtalk: DEFAULT_DINGTALK_CONFIG,
  feishu: DEFAULT_FEISHU_CONFIG,
  telegram: DEFAULT_TELEGRAM_CONFIG,
  discord: DEFAULT_DISCORD_CONFIG,
  weixin: DEFAULT_WEIXIN_CONFIG,
  qq: DEFAULT_QQ_CONFIG,
  settings: DEFAULT_IM_SETTINGS,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: {
    connected: false,
    startedAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  feishu: {
    connected: false,
    startedAt: null,
    botOpenId: null,
    error: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  telegram: {
    connected: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  discord: {
    connected: false,
    starting: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  weixin: {
    connected: false,
    startedAt: null,
    lastError: null,
    accountId: null,
    loginPending: false,
    loginState: 'idle',
    qrContent: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  qq: {
    connected: false,
    startedAt: null,
    lastError: null,
    appId: null,
    loginPending: false,
    loginState: 'idle',
    qrContent: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
};
