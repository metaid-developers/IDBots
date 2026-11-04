/**
 * IM Gateway Type Definitions
 * Types for DingTalk, Feishu and Telegram IM bot integration
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

export interface DingTalkInboundMessage {
  msgId: string;
  msgtype: 'text' | 'richText' | 'audio' | string;
  createAt: number;
  text?: { content: string };
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    richText?: Array<{ text?: string }>;
  };
  conversationType: '1' | '2'; // 1: DM, 2: Group
  conversationId: string;
  senderId: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId: string;
  sessionWebhook: string;
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

export interface FeishuMessageContext {
  chatId: string;
  messageId: string;
  senderId: string;
  senderOpenId: string;
  chatType: 'p2p' | 'group';
  mentionedBot: boolean;
  rootId?: string;
  parentId?: string;
  content: string;
  contentType: string;
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

// ==================== NIM (NetEase IM) Types ====================

export interface NimConfig {
  enabled: boolean;
  appKey: string;
  account: string;
  token: string;
  debug?: boolean;
  /** Comma-separated account IDs to accept messages from (optional filter) */
  accountWhitelist?: string;
}

export interface NimGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Xiaomifeng Types ====================

export interface XiaomifengConfig {
  enabled: boolean;
  clientId: string;
  secret: string;
  debug?: boolean;
}

export interface XiaomifengGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Weixin (WeChat) Types ====================

/**
 * Weixin personal-account bot channel.
 *
 * The token is obtained exclusively through QR authorization (`get_bot_qrcode` ->
 * `get_qrcode_status` -> `confirmed`). There is no account/password login here by
 * design: see the compliance note in weixinProtocol.ts.
 */
export interface WeixinConfig {
  enabled: boolean;
  /** Local account slot; also the credential file name under weixin/accounts. */
  accountId: string;
  /** Bot token from the QR authorization. Sensitive: never logged. */
  token?: string;
  /** Business API base returned by the login; falls back to the official host. */
  baseUrl?: string;
  metabotId?: number | null;
  debug?: boolean;
}

export interface WeixinGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  /** Account slot currently bound (never the token). */
  accountId: string | null;
  /** True while a QR login is being polled. */
  loginPending: boolean;
  /** Coarse QR login progress for the settings UI. */
  loginState: 'idle' | 'wait' | 'scanned';
  /** QR payload (usually a URL) to render for scanning; null when no login is pending. */
  qrContent: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== QQ (QQ Open Platform) Types ====================

/**
 * QQ official-bot channel (QQ Open Platform, official `@tencent-connect/qqbot-nodejs`).
 *
 * Credential split, on purpose:
 *   - `appId` / `botId` / `ownerUserOpenid` are identifiers and may live in the
 *     renderer-visible config;
 *   - `appSecret` is a bearer credential. It is persisted by `qqStore.ts` in a
 *     0600 file under `<userData>/qq/accounts` and is NEVER written to the
 *     config table, a log line, a buzz, or a status object. The `appSecret`
 *     field exists only so the settings page can hand a value to the dedicated
 *     `im:qq:credentials:set` IPC; `imStore.getConfig()` strips it.
 */
export interface QQConfig {
  enabled: boolean;
  /** QQ Open Platform AppID (public identifier). */
  appId: string;
  /** Bot id / robot account label, when the platform returns one. */
  botId?: string | null;
  /** OpenID of the user who scanned the QR code (binding owner). */
  ownerUserOpenid?: string | null;
  /** Write-only field: accepted by setConfig, never read back. */
  appSecret?: string;
  metabotId?: number | null;
  debug?: boolean;
  /**
   * Group policy. DEFAULT `allowlist` with an EMPTY list — i.e. no group is
   * served until the owner adds one. `open` lets any group talk to the bot
   * (layer-1 Q&A only, still no tools); `disabled` refuses every group.
   */
  groupPolicy?: QQGroupPolicy;
  /** Group OpenIDs served when `groupPolicy === 'allowlist'`. */
  groupAllowlist?: string[];
  /**
   * Layer 3 (local machine operations: files, shell, attachments, wallet,
   * chain writes). DEFAULT OFF. Turning this on does NOT widen groups — their
   * tool surface stays structurally empty.
   */
  localToolsEnabled?: boolean;
  /** Stable ids (OpenIDs) allowed to use layer 3 after the switch is on. */
  localToolsAllowFrom?: string[];
  /**
   * Daily budget for admitted GROUP messages (all groups combined).
   *
   * DEFAULT 500. The two per-minute limits (3 per sender per group, 10 per
   * group) are deliberately NOT configurable — they are flood guards, not
   * preferences. Invalid values degrade to the default, never to unlimited.
   * DM is out of scope: direct messages are owner-only and already isolated.
   */
  dailyReplyLimit?: number;
}

export type QQGroupPolicy = 'open' | 'allowlist' | 'disabled';

/**
 * Trust level frozen at the IM message entry point (`qqTrust.ts`).
 *
 * Carried on the `IMMessage` and then on the runner's per-turn session marker.
 * Downstream code may READ it; it must never recompute or widen it mid-turn.
 */
export type IMTrustLevel = 'group' | 'owner-dm' | 'stranger-dm' | 'bot-sender';

export interface IMTrustContext {
  level: IMTrustLevel;
  /**
   * `none` = the session's tool surface is EMPTY (no host tools registered and
   * every built-in tool call is denied). `local` = layer 3 granted to the
   * bound owner.
   */
  toolScope: 'none' | 'local';
  /** Long-term memory + knowledge-base READS. */
  memoryRead: boolean;
  /** Long-term memory + knowledge-base WRITES (turn-end update included). */
  memoryWrite: boolean;
  /** Group messages never download inbound media. */
  attachmentPolicy: 'allow' | 'reject';
  groupId?: string | null;
  decidedAt: number;
  reason: string;
}

export interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  /** AppID currently bound (an identifier, not a secret). */
  appId: string | null;
  /** True while a QR login is being polled. */
  loginPending: boolean;
  /** Coarse QR login progress for the settings UI. */
  loginState: 'idle' | 'wait' | 'scanned' | 'confirmed' | 'expired' | 'error';
  /** QR payload (a URL) to render for scanning; null when no login is pending. */
  qrContent: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Common IM Types ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'nim' | 'xiaomifeng' | 'weixin' | 'qq';

/**
 * A gateway that can send into an existing conversation WITHOUT an inbound
 * message closure to reply through.
 *
 * This is the capability seam behind out-of-turn delivery (a turn triggered by
 * an [ORCH-NOTIFY] cross-session injection, a scheduled wake, ...): the
 * handler only knows the conversation id it already holds, never a platform
 * SDK object. Gateways whose outbound API needs a live message/channel handle
 * (DingTalk session webhook, Discord channel object) simply do not implement
 * this interface, and their out-of-turn replies degrade to desktop-only with
 * an explicit log instead of throwing.
 */
export interface IMConversationSender {
  sendToConversation(conversationId: string, text: string): Promise<void>;
  /**
   * Optional media counterpart, used by desktop-initiated sends
   * (`im_send_message`). Gateways that can deliver a file into an existing
   * conversation implement it by delegating to their own native media path;
   * the desktop layer then reports an explicit error instead of dropping the
   * attachment when it is absent.
   */
  sendMediaToConversation?(conversationId: string, filePath: string): Promise<void>;
}

export interface IMGatewayConfig {
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  weixin: WeixinConfig;
  qq: QQConfig;
  settings: IMSettings;
}

/**
 * Per-channel permission mode. The DEFAULT is `inherit`: an IM session uses the
 * same persisted global permission mode as the desktop app (see
 * getPersistedCoworkPermissionMode), so "完全信任 / bypassPermissions" chosen on
 * the desktop is also in force in chat — no separate channel policy.
 *
 * A channel MAY override the mode (e.g. force `default` in a group chat, or
 * `bypassPermissions` for one channel only). `inherit` / absent / unknown all
 * fall back to the global value.
 */
export type IMChannelPermissionMode =
  | 'inherit'
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions';

export interface IMChannelPermissionSettings {
  weixinPermissionMode?: IMChannelPermissionMode;
}

export interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
  channelPermissions?: IMChannelPermissionSettings;
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

/** Unified media type for DingTalk, Discord, NIM, etc. */
export type IMMediaType = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface IMMediaAttachment {
  type: IMMediaType;
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
  /**
   * Entry-point trust decision for channels that enforce one (currently QQ).
   * Absent means "legacy channel, no trust gate"; a QQ message without this
   * field is dropped by the manager (fail-closed).
   */
  trust?: IMTrustContext;
}

export interface IMReplyContext {
  platform: IMPlatform;
  conversationId: string;
  messageId?: string;
  // DingTalk specific
  sessionWebhook?: string;
  // Feishu specific
  chatId?: string;
}

// ==================== IM Session Mapping ====================

export interface IMSessionMapping {
  imConversationId: string;
  platform: IMPlatform;
  coworkSessionId: string;
  metabotId: number | null;
  createdAt: number;
  lastActiveAt: number;
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
  renderMode: 'card',
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

export const DEFAULT_WEIXIN_CONFIG: WeixinConfig = {
  enabled: false,
  accountId: 'default',
  token: '',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  metabotId: null,
  debug: true,
};

export const DEFAULT_IM_SETTINGS: IMSettings = {
  systemPrompt: '',
  skillsEnabled: true,
};

export const DEFAULT_QQ_CONFIG: QQConfig = {
  enabled: false,
  appId: '',
  botId: null,
  ownerUserOpenid: null,
  metabotId: null,
  debug: true,
  // Security defaults: no group is served until the owner adds one, and
  // layer 3 (local machine operations) is off for everybody.
  groupPolicy: 'allowlist',
  groupAllowlist: [],
  localToolsEnabled: false,
  localToolsAllowFrom: [],
  // Group model turns per local day, across all groups. See qqRateLimit.ts.
  dailyReplyLimit: 500,
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

export const DEFAULT_DINGTALK_STATUS: DingTalkGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_FEISHU_STATUS: FeishuGatewayStatus = {
  connected: false,
  startedAt: null,
  botOpenId: null,
  error: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_TELEGRAM_STATUS: TelegramGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  botUsername: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_DISCORD_STATUS: DiscordGatewayStatus = {
  connected: false,
  starting: false,
  startedAt: null,
  lastError: null,
  botUsername: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_NIM_STATUS: NimGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  botAccount: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_XIAOMIFENG_STATUS: XiaomifengGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  botAccount: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_WEIXIN_STATUS: WeixinGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  accountId: null,
  loginPending: false,
  loginState: 'idle',
  qrContent: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_QQ_STATUS: QQGatewayStatus = {
  connected: false,
  startedAt: null,
  lastError: null,
  appId: null,
  loginPending: false,
  loginState: 'idle',
  qrContent: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: DEFAULT_DINGTALK_STATUS,
  feishu: DEFAULT_FEISHU_STATUS,
  telegram: DEFAULT_TELEGRAM_STATUS,
  discord: DEFAULT_DISCORD_STATUS,
  weixin: DEFAULT_WEIXIN_STATUS,
  qq: DEFAULT_QQ_STATUS,
};

// ==================== DingTalk Media Types ====================

// Session Webhook 使用 msgKey + msgParam 格式
export interface DingTalkImageMessage {
  msgKey: 'sampleImageMsg';
  sampleImageMsg: { photoURL: string };
}

export interface DingTalkVoiceMessage {
  msgKey: 'sampleAudio';
  sampleAudio: { mediaId: string; duration?: string };
}

export interface DingTalkVideoMessage {
  msgKey: 'sampleVideo';
  sampleVideo: { mediaId: string; duration?: string; videoType?: string };
}

export interface DingTalkFileMessage {
  msgKey: 'sampleFile';
  sampleFile: { mediaId: string; fileName?: string };
}

export type DingTalkMediaMessage =
  | DingTalkImageMessage
  | DingTalkVoiceMessage
  | DingTalkVideoMessage
  | DingTalkFileMessage;

export interface MediaMarker {
  type: 'image' | 'video' | 'audio' | 'file';
  path: string;
  name?: string;
  originalMarker: string;
}
