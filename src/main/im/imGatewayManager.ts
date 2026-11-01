/**
 * IM Gateway Manager
 * Unified manager for DingTalk, Feishu and Telegram gateways
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import { DingTalkGateway } from './dingtalkGateway';
import { FeishuGateway } from './feishuGateway';
import { TelegramGateway } from './telegramGateway';
import { DiscordGateway } from './discordGateway';
import { WeixinGateway } from './weixinGateway';
import { IMChatHandler } from './imChatHandler';
import { IMCoworkHandler } from './imCoworkHandler';
import { IMStore } from './imStore';
import { getOapiAccessToken } from './dingtalkMedia';
import { probeTelegramAuth } from './telegramProbe';
import {
  IMGatewayConfig,
  IMGatewayStatus,
  IMPlatform,
  IMMessage,
  IMConnectivityCheck,
  IMConnectivityTestResult,
  IMConnectivityVerdict,
} from './types';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { CoworkRunner } from '../libs/coworkRunner';
import type { CoworkStore } from '../coworkStore';
import { tApp } from '../libs/appLanguage';

const CONNECTIVITY_TIMEOUT_MS = 10_000;
const INBOUND_ACTIVITY_WARN_AFTER_MS = 2 * 60 * 1000;
const MANAGED_IM_PLATFORMS = ['dingtalk', 'feishu', 'telegram', 'discord', 'weixin'] as const;
type ManagedIMPlatform = typeof MANAGED_IM_PLATFORMS[number];

export interface IMGatewayManagerOptions {
  coworkRunner?: CoworkRunner;
  coworkStore?: CoworkStore;
}

export class IMGatewayManager extends EventEmitter {
  private dingtalkGateway: DingTalkGateway;
  private feishuGateway: FeishuGateway;
  private telegramGateway: TelegramGateway;
  private discordGateway: DiscordGateway;
  private weixinGateway: WeixinGateway;
  private imStore: IMStore;
  private chatHandler: IMChatHandler | null = null;
  private coworkHandler: IMCoworkHandler | null = null;
  private getLLMConfig: (() => Promise<any>) | null = null;
  private getSkillsPrompt: (() => Promise<string | null>) | null = null;

  // Cowork dependencies
  private coworkRunner: CoworkRunner | null = null;
  private coworkStore: CoworkStore | null = null;

  constructor(db: Database, saveDb: () => void, options?: IMGatewayManagerOptions) {
    super();

    this.imStore = new IMStore(db, saveDb);
    this.dingtalkGateway = new DingTalkGateway();
    this.feishuGateway = new FeishuGateway();
    this.telegramGateway = new TelegramGateway();
    this.discordGateway = new DiscordGateway();
    this.weixinGateway = new WeixinGateway();

    // Store Cowork dependencies if provided
    if (options?.coworkRunner && options?.coworkStore) {
      this.coworkRunner = options.coworkRunner;
      this.coworkStore = options.coworkStore;
    }

    // Forward gateway events
    this.setupGatewayEventForwarding();
  }

  /**
   * Set up event forwarding from gateways
   */
  private setupGatewayEventForwarding(): void {
    // DingTalk events
    this.dingtalkGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.dingtalkGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.dingtalkGateway.on('error', (error) => {
      this.emit('error', { platform: 'dingtalk', error });
      this.emit('statusChange', this.getStatus());
    });
    this.dingtalkGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Feishu events
    this.feishuGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.feishuGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.feishuGateway.on('error', (error) => {
      this.emit('error', { platform: 'feishu', error });
      this.emit('statusChange', this.getStatus());
    });
    this.feishuGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Telegram events
    this.telegramGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.telegramGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.telegramGateway.on('error', (error) => {
      this.emit('error', { platform: 'telegram', error });
      this.emit('statusChange', this.getStatus());
    });
    this.telegramGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Discord events
    this.discordGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('error', (error) => {
      this.emit('error', { platform: 'discord', error });
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Weixin events
    this.weixinGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.weixinGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.weixinGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.weixinGateway.on('error', (error) => {
      this.emit('error', { platform: 'weixin', error });
      this.emit('statusChange', this.getStatus());
    });
    this.weixinGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });
    this.weixinGateway.on('login', (result: { state: string }) => {
      // QR authorization reached a terminal state; surface it so the settings UI
      // and any listener can react (a confirmed login is persisted by the gateway).
      this.emit('statusChange', this.getStatus());
      this.emit('weixinLogin', result);
    });
  }

  /**
   * Reconnect all disconnected gateways
   * Called when network is restored via IPC event
   */
  reconnectAllDisconnected(): void {
    console.log('[IMGatewayManager] Reconnecting all disconnected gateways...');

    if (this.dingtalkGateway && !this.dingtalkGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting DingTalk...');
      this.dingtalkGateway.reconnectIfNeeded();
    }

    if (this.feishuGateway && !this.feishuGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Feishu...');
      this.feishuGateway.reconnectIfNeeded();
    }

    if (this.telegramGateway && !this.telegramGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Telegram...');
      this.telegramGateway.reconnectIfNeeded();
    }

    if (this.discordGateway && !this.discordGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Discord...');
      this.discordGateway.reconnectIfNeeded();
    }

    if (this.weixinGateway && !this.weixinGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Weixin...');
      this.weixinGateway.reconnectIfNeeded();
    }
  }

  /**
   * Initialize the manager with LLM and skills providers
   */
  initialize(options: {
    getLLMConfig: () => Promise<any>;
    getSkillsPrompt?: () => Promise<string | null>;
  }): void {
    this.getLLMConfig = options.getLLMConfig;
    this.getSkillsPrompt = options.getSkillsPrompt ?? null;

    // Set up message handlers for gateways
    this.setupMessageHandlers();
  }

  /**
   * Set up message handlers for both gateways
   */
  private setupMessageHandlers(): void {
    const messageHandler = async (
      message: IMMessage,
      replyFn: (text: string) => Promise<void>
    ): Promise<void> => {
      try {
        let response: string;
        const targetMetabotId = this.getRouteMetabotIdForPlatform(message.platform);

        // Always use Cowork mode if handler is available
        if (this.coworkHandler) {
          console.log('[IMGatewayManager] Using Cowork mode for message processing');
          response = await this.coworkHandler.processMessage(message, targetMetabotId);
        } else {
          // Fallback to regular chat handler
          if (!this.chatHandler) {
            this.updateChatHandler();
          }

          if (!this.chatHandler) {
            throw new Error('Chat handler not available');
          }

          response = await this.chatHandler.processMessage(message);
        }

        await replyFn(response);
      } catch (error: any) {
        console.error(`[IMGatewayManager] Error processing message: ${error.message}`);
        // Send error message to user
        try {
          await replyFn(tApp(`处理消息时出错: ${error.message}`, `Error while processing the message: ${error.message}`));
        } catch (replyError) {
          console.error(`[IMGatewayManager] Failed to send error reply: ${replyError}`);
        }
      }
    };

    this.dingtalkGateway.setMessageCallback(messageHandler);
    this.feishuGateway.setMessageCallback(messageHandler);
    this.telegramGateway.setMessageCallback(messageHandler);
    this.discordGateway.setMessageCallback(messageHandler);
    this.weixinGateway.setMessageCallback(messageHandler);
  }

  /**
   * Update chat handler with current settings
   */
  private updateChatHandler(): void {
    if (!this.getLLMConfig) {
      console.warn('[IMGatewayManager] LLM config provider not set');
      return;
    }

    const imSettings = this.imStore.getIMSettings();

    this.chatHandler = new IMChatHandler({
      getLLMConfig: this.getLLMConfig,
      getSkillsPrompt: this.getSkillsPrompt || undefined,
      imSettings,
    });

    // Update or create Cowork handler if dependencies are available
    this.updateCoworkHandler();
  }

  /**
   * Update or create Cowork handler
   * Always creates handler if dependencies are available (Cowork mode is always enabled for IM)
   */
  private updateCoworkHandler(): void {
    // Always create Cowork handler if we have the required dependencies
    if (this.coworkRunner && this.coworkStore && !this.coworkHandler) {
      this.coworkHandler = new IMCoworkHandler({
        coworkRunner: this.coworkRunner,
        coworkStore: this.coworkStore,
        imStore: this.imStore,
        getSkillsPrompt: this.getSkillsPrompt || undefined,
      });
      console.log('[IMGatewayManager] Cowork handler created');
    }
  }

  // ==================== Configuration ====================

  /**
   * Get current configuration
   */
  getConfig(): IMGatewayConfig {
    return this.imStore.getConfig();
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<IMGatewayConfig>): void {
    const prevConfig = this.imStore.getConfig();
    this.imStore.setConfig(config);
    const nextConfig = this.imStore.getConfig();
    this.handleMetabotRouteChange(prevConfig, nextConfig);

    // Update chat handler if settings changed
    if (config.settings) {
      this.updateChatHandler();
    }
  }

  // ==================== Status ====================

  /**
   * Get current status of all gateways
   */
  getStatus(): IMGatewayStatus {
    return {
      dingtalk: this.dingtalkGateway.getStatus(),
      feishu: this.feishuGateway.getStatus(),
      telegram: this.telegramGateway.getStatus(),
      discord: this.discordGateway.getStatus(),
      weixin: this.weixinGateway.getStatus(),
    };
  }

  /**
   * Test platform connectivity and readiness for conversation.
   */
  async testGateway(
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const config = this.buildMergedConfig(configOverride);
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();

    const addCheck = (check: IMConnectivityCheck) => {
      checks.push(check);
    };

    const missingCredentials = this.getMissingCredentials(platform, config);
    if (missingCredentials.length > 0) {
      addCheck({
        code: 'missing_credentials',
        level: 'fail',
        message: tApp(`缺少必要配置项: ${missingCredentials.join(', ')}`, `Missing required fields: ${missingCredentials.join(', ')}`),
        suggestion: tApp('请补全配置后重新测试连通性。', 'Fill in the required fields and test connectivity again.'),
      });

      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    try {
      const authMessage = await this.withTimeout(
        this.runAuthProbe(platform, config),
        CONNECTIVITY_TIMEOUT_MS,
        tApp('鉴权探测超时', 'Authentication probe timed out')
      );
      addCheck({
        code: 'auth_check',
        level: 'pass',
        message: authMessage,
      });
    } catch (error: any) {
      addCheck({
        code: 'auth_check',
        level: 'fail',
        message: tApp(`鉴权失败: ${error.message}`, `Authentication failed: ${error.message}`),
        suggestion: tApp('请检查 ID/Secret/Token 是否正确，且机器人权限已开通。', 'Check that the ID/Secret/Token is correct and the bot has the required permissions.'),
      });
      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    const status = this.getStatus();
    const enabled = Boolean(config[platform]?.enabled);
    const connected = this.isConnected(platform);

    if (enabled && !connected) {
      const discordStarting = platform === 'discord' && status.discord.starting;
      addCheck({
        code: 'gateway_running',
        level: discordStarting ? 'info' : 'warn',
        message: discordStarting
          ? tApp('IM 渠道正在启动，请稍后重试。', 'The IM channel is starting. Please retry shortly.')
          : tApp('IM 渠道已启用但当前未连接。', 'The IM channel is enabled but not connected.'),
        suggestion: discordStarting
          ? tApp('等待启动完成后重新测试。', 'Wait until startup finishes, then test again.')
          : tApp('请检查网络、机器人配置和平台侧事件开关。', 'Check the network, bot credentials, and platform event subscriptions.'),
      });
    } else {
      addCheck({
        code: 'gateway_running',
        level: connected ? 'pass' : 'info',
        message: connected
          ? tApp('IM 渠道已启用且运行正常。', 'The IM channel is enabled and running.')
          : tApp('IM 渠道当前未启用。', 'The IM channel is currently disabled.'),
        suggestion: connected ? undefined : tApp('请点击对应 IM 渠道胶囊按钮启用该渠道。', 'Click the IM channel toggle to enable it.'),
      });
    }

    const startedAt = this.getStartedAtMs(platform, status);
    const lastInboundAt = this.getLastInboundAt(platform, status);
    const lastOutboundAt = this.getLastOutboundAt(platform, status);

    if (connected && startedAt && testedAt - startedAt >= INBOUND_ACTIVITY_WARN_AFTER_MS) {
      if (!lastInboundAt) {
        addCheck({
          code: 'inbound_activity',
          level: 'warn',
          message: tApp('已连接超过 2 分钟，但尚未收到任何入站消息。', 'Connected for more than 2 minutes, but no inbound messages yet.'),
          suggestion: tApp('请确认机器人已在目标会话中，或按平台规则 @机器人 触发消息。', 'Make sure the bot is in the target chat, or @mention it according to the platform rules.'),
        });
      } else {
        addCheck({
          code: 'inbound_activity',
          level: 'pass',
          message: tApp('已检测到入站消息。', 'Inbound messages have been detected.'),
        });
      }
    } else if (connected) {
      addCheck({
        code: 'inbound_activity',
        level: 'info',
        message: tApp('网关刚启动，入站活动检查将在 2 分钟后更准确。', 'The gateway just started. Inbound activity checks are more accurate after 2 minutes.'),
      });
    }

    if (connected && lastInboundAt) {
      if (!lastOutboundAt) {
        addCheck({
          code: 'outbound_activity',
          level: 'warn',
          message: tApp('已收到消息，但尚未观察到成功回发。', 'Inbound messages were received, but no successful reply has been observed yet.'),
          suggestion: tApp('请检查消息发送权限、机器人可见范围和会话回包权限。', 'Check send permissions, bot visibility, and reply rights for the conversation.'),
        });
      } else {
        addCheck({
          code: 'outbound_activity',
          level: 'pass',
          message: tApp('已检测到成功回发消息。', 'Successful outbound replies have been detected.'),
        });
      }
    } else if (connected) {
      addCheck({
        code: 'outbound_activity',
        level: 'info',
        message: tApp('尚未收到可用于评估回发能力的入站消息。', 'No inbound message is available yet to evaluate reply capability.'),
      });
    }

    const lastError = this.getLastError(platform, status);
    if (lastError) {
      addCheck({
        code: 'platform_last_error',
        level: connected ? 'warn' : 'fail',
        message: tApp(`最近错误: ${lastError}`, `Latest error: ${lastError}`),
        suggestion: connected
          ? tApp('当前已连接，但建议修复该错误避免后续中断。', 'The channel is connected, but fix this error to avoid later interruptions.')
          : tApp('该错误可能阻断对话，请优先修复后重试。', 'This error may block conversations. Fix it first, then retry.'),
      });
    }

    if (platform === 'feishu') {
      addCheck({
        code: 'feishu_group_requires_mention',
        level: 'info',
        message: tApp('飞书群聊中仅响应 @机器人的消息。', 'In Feishu group chats the bot only replies to @mentions.'),
        suggestion: tApp('请在群聊中使用 @机器人 + 内容触发对话。', 'In group chats, @mention the bot plus your message.'),
      });
      addCheck({
        code: 'feishu_event_subscription_required',
        level: 'info',
        message: tApp('飞书需要开启消息事件订阅（im.message.receive_v1）才能收消息。', 'Feishu needs the im.message.receive_v1 event subscription to receive messages.'),
        suggestion: tApp('请在飞书开发者后台确认事件订阅、权限和发布状态。', 'Confirm event subscriptions, permissions, and the published version in the Feishu developer console.'),
      });
    } else if (platform === 'discord') {
      addCheck({
        code: 'discord_group_requires_mention',
        level: 'info',
        message: tApp('Discord 群聊中仅响应 @机器人的消息。', 'In Discord servers the bot only replies to @mentions.'),
        suggestion: tApp('请在频道中使用 @机器人 + 内容触发对话。', 'In channels, @mention the bot plus your message.'),
      });
    } else if (platform === 'telegram') {
      addCheck({
        code: 'telegram_privacy_mode_hint',
        level: 'info',
        message: tApp('Telegram 可能受 Bot Privacy Mode 影响。', 'Telegram may be affected by Bot Privacy Mode.'),
        suggestion: tApp('若群聊中不响应，请在 @BotFather 检查 Privacy Mode 配置。', 'If the bot ignores group messages, check Privacy Mode in @BotFather.'),
      });
    } else if (platform === 'dingtalk') {
      addCheck({
        code: 'dingtalk_bot_membership_hint',
        level: 'info',
        message: tApp('钉钉机器人需被加入目标会话并具备发言权限。', 'The DingTalk bot must be added to the target chat and allowed to send messages.'),
        suggestion: tApp('请确认机器人在目标会话中，且企业权限配置允许收发消息。', 'Confirm the bot is in the target chat and org permissions allow sending and receiving.'),
      });
    }

    return {
      platform,
      testedAt,
      verdict: this.calculateVerdict(checks),
      checks,
    };
  }

  // ==================== Gateway Control ====================

  /**
   * Start a specific gateway
   */
  async startGateway(platform: IMPlatform): Promise<void> {
    const config = this.getConfig();

    // Ensure chat handler is ready
    this.updateChatHandler();

    if (platform === 'dingtalk') {
      await this.dingtalkGateway.start(config.dingtalk);
    } else if (platform === 'feishu') {
      await this.feishuGateway.start(config.feishu);
    } else if (platform === 'telegram') {
      await this.telegramGateway.start(config.telegram);
    } else if (platform === 'discord') {
      await this.discordGateway.start(config.discord);
    } else if (platform === 'weixin') {
      await this.weixinGateway.start(config.weixin);
    }
  }

  /**
   * Stop a specific gateway
   */
  async stopGateway(platform: IMPlatform): Promise<void> {
    if (platform === 'dingtalk') {
      await this.dingtalkGateway.stop();
    } else if (platform === 'feishu') {
      await this.feishuGateway.stop();
    } else if (platform === 'telegram') {
      await this.telegramGateway.stop();
    } else if (platform === 'discord') {
      await this.discordGateway.stop();
    } else if (platform === 'weixin') {
      await this.weixinGateway.stop();
    }
  }

  // ==================== Weixin QR authorization ====================

  /**
   * Start a Weixin QR authorization: request a QR payload and keep polling in the
   * background. The token returned by `confirmed` is written to the credential
   * file (mode 0600) by the gateway — never into the renderer-visible config.
   * On success the channel is enabled and started.
   */
  async startWeixinLogin(): Promise<{ qrcode: string; content: string }> {
    this.updateChatHandler();

    const onLogin = async (result: { state: string; error?: string | null }): Promise<void> => {
      this.weixinGateway.off('login', onLogin);
      if (result.state !== 'confirmed') {
        this.emit('statusChange', this.getStatus());
        return;
      }
      this.imStore.setWeixinConfig({ enabled: true });
      try {
        await this.startGateway('weixin');
        console.log('[IMGatewayManager] Weixin channel authorized and started');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Weixin authorized but failed to start: ${error.message}`);
      }
      this.emit('statusChange', this.getStatus());
    };

    const qr = await this.weixinGateway.beginLogin();
    this.weixinGateway.on('login', onLogin);
    return { qrcode: qr.qrcode, content: qr.content };
  }

  /** Abort a pending Weixin QR authorization. */
  async cancelWeixinLogin(): Promise<void> {
    await this.weixinGateway.cancelLogin();
  }

  /** Whether the Weixin channel has a stored token (drives the settings UI state). */
  hasWeixinCredentials(): boolean {
    return this.weixinGateway.hasCredentials(this.imStore.getWeixinConfig());
  }

  /**
   * Start all enabled gateways
   */
  async startAllEnabled(): Promise<void> {
    const config = this.getConfig();

    if (config.dingtalk.enabled && config.dingtalk.clientId && config.dingtalk.clientSecret) {
      try {
        await this.startGateway('dingtalk');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start DingTalk: ${error.message}`);
      }
    }

    if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
      try {
        await this.startGateway('feishu');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Feishu: ${error.message}`);
      }
    }

    if (config.telegram.enabled && config.telegram.botToken) {
      try {
        await this.startGateway('telegram');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Telegram: ${error.message}`);
      }
    }

    if (config.discord.enabled && config.discord.botToken) {
      try {
        await this.startGateway('discord');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Discord: ${error.message}`);
      }
    }

    if (config.weixin.enabled && this.weixinGateway.hasCredentials(config.weixin)) {
      try {
        await this.startGateway('weixin');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Weixin: ${error.message}`);
      }
    }
  }

  /**
   * Stop all gateways
   */
  async stopAll(): Promise<void> {
    await Promise.all([
      this.dingtalkGateway.stop(),
      this.feishuGateway.stop(),
      this.telegramGateway.stop(),
      this.discordGateway.stop(),
      this.weixinGateway.stop(),
    ]);
  }

  /**
   * Check if any gateway is connected
   */
  isAnyConnected(): boolean {
    return this.dingtalkGateway.isConnected() || this.feishuGateway.isConnected() || this.telegramGateway.isConnected() || this.discordGateway.isConnected() || this.weixinGateway.isConnected();
  }

  /**
   * Check if a specific gateway is connected
   */
  isConnected(platform: IMPlatform): boolean {
    if (platform === 'dingtalk') {
      return this.dingtalkGateway.isConnected();
    }
    if (platform === 'telegram') {
      return this.telegramGateway.isConnected();
    }
    if (platform === 'discord') {
      return this.discordGateway.isConnected();
    }
    if (platform === 'weixin') {
      return this.weixinGateway.isConnected();
    }
    return this.feishuGateway.isConnected();
  }

  /**
   * Send a notification message through a specific platform.
   * Uses platform-specific broadcast mechanisms.
   * Returns true if successfully sent, false if platform not connected.
   */
  async sendNotification(platform: IMPlatform, text: string): Promise<boolean> {
    if (!this.isConnected(platform)) {
      console.warn(`[IMGatewayManager] Cannot send notification: ${platform} is not connected`);
      return false;
    }

    try {
      if (platform === 'dingtalk') {
        await this.dingtalkGateway.sendNotification(text);
      } else if (platform === 'feishu') {
        await this.feishuGateway.sendNotification(text);
      } else if (platform === 'telegram') {
        await this.telegramGateway.sendNotification(text);
      } else if (platform === 'discord') {
        await this.discordGateway.sendNotification(text);
      } else if (platform === 'weixin') {
        await this.weixinGateway.sendNotification(text);
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification via ${platform}:`, error.message);
      return false;
    }
  }

  private buildMergedConfig(configOverride?: Partial<IMGatewayConfig>): IMGatewayConfig {
    const current = this.getConfig();
    if (!configOverride) {
      return current;
    }
    return {
      ...current,
      ...configOverride,
      dingtalk: { ...current.dingtalk, ...(configOverride.dingtalk || {}) },
      feishu: { ...current.feishu, ...(configOverride.feishu || {}) },
      telegram: { ...current.telegram, ...(configOverride.telegram || {}) },
      discord: { ...current.discord, ...(configOverride.discord || {}) },
      weixin: { ...current.weixin, ...(configOverride.weixin || {}) },
      settings: { ...current.settings, ...(configOverride.settings || {}) },
    };
  }

  private getMissingCredentials(platform: IMPlatform, config: IMGatewayConfig): string[] {
    if (platform === 'dingtalk') {
      const fields: string[] = [];
      if (!(config.dingtalk.clientId || '').trim()) fields.push('clientId');
      if (!(config.dingtalk.clientSecret || '').trim()) fields.push('clientSecret');
      return fields;
    }
    if (platform === 'feishu') {
      const fields: string[] = [];
      if (!(config.feishu.appId || '').trim()) fields.push('appId');
      if (!(config.feishu.appSecret || '').trim()) fields.push('appSecret');
      return fields;
    }
    if (platform === 'telegram') {
      return (config.telegram.botToken || '').trim() ? [] : ['botToken'];
    }
    if (platform === 'weixin') {
      return this.weixinGateway.hasCredentials(config.weixin)
        ? []
        : ['WeChat authorization (scan the QR code first)'];
    }
    return (config.discord.botToken || '').trim() ? [] : ['botToken'];
  }

  private async runAuthProbe(platform: IMPlatform, config: IMGatewayConfig): Promise<string> {
    if (platform === 'dingtalk') {
      await getOapiAccessToken(config.dingtalk.clientId, config.dingtalk.clientSecret);
      return '钉钉鉴权通过。';
    }

    if (platform === 'feishu') {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.resolveFeishuDomain(config.feishu.domain, Lark);
      const client = new Lark.Client({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });
      const response: any = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      const botName = response.data?.app_name ?? response.data?.bot?.app_name ?? 'unknown';
      return `飞书鉴权通过（Bot: ${botName}）。`;
    }

    if (platform === 'telegram') {
      const token = (config.telegram.botToken || '').trim();
      return probeTelegramAuth(token, {
        timeoutMs: CONNECTIVITY_TIMEOUT_MS,
        retries: 3,
        proxyUrl: config.telegram.proxyUrl,
      });
    }

    if (platform === 'weixin') {
      return this.weixinGateway.probeAuth(CONNECTIVITY_TIMEOUT_MS);
    }

    const discordToken = (config.discord.botToken || '').trim();
    const response = await axios.get('https://discord.com/api/v10/users/@me', {
      timeout: CONNECTIVITY_TIMEOUT_MS,
      headers: {
        Authorization: `Bot ${discordToken}`,
      },
    });
    const username = response.data?.username ? `${response.data.username}#${response.data.discriminator || '0000'}` : 'unknown';
    return `Discord 鉴权通过（Bot: ${username}）。`;
  }

  private resolveFeishuDomain(domain: string, Lark: any): any {
    if (domain === 'lark') return Lark.Domain.Lark;
    if (domain === 'feishu') return Lark.Domain.Feishu;
    return domain.replace(/\/+$/, '');
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  private getStartedAtMs(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'feishu') {
      return status.feishu.startedAt ? Date.parse(status.feishu.startedAt) : null;
    }
    if (platform === 'dingtalk') return status.dingtalk.startedAt;
    if (platform === 'telegram') return status.telegram.startedAt;
    if (platform === 'weixin') return status.weixin.startedAt;
    return status.discord.startedAt;
  }

  private getLastInboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastInboundAt;
    if (platform === 'feishu') return status.feishu.lastInboundAt;
    if (platform === 'telegram') return status.telegram.lastInboundAt;
    if (platform === 'weixin') return status.weixin.lastInboundAt;
    return status.discord.lastInboundAt;
  }

  private getLastOutboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastOutboundAt;
    if (platform === 'feishu') return status.feishu.lastOutboundAt;
    if (platform === 'telegram') return status.telegram.lastOutboundAt;
    if (platform === 'weixin') return status.weixin.lastOutboundAt;
    return status.discord.lastOutboundAt;
  }

  private getLastError(platform: IMPlatform, status: IMGatewayStatus): string | null {
    if (platform === 'dingtalk') return status.dingtalk.lastError;
    if (platform === 'feishu') return status.feishu.error;
    if (platform === 'telegram') return status.telegram.lastError;
    if (platform === 'weixin') return status.weixin.lastError;
    return status.discord.lastError;
  }

  private isManagedPlatform(platform: IMPlatform): platform is ManagedIMPlatform {
    return MANAGED_IM_PLATFORMS.includes(platform as ManagedIMPlatform);
  }

  private normalizeMetabotId(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  private resolveRouteMetabotId(
    platform: ManagedIMPlatform,
    config: IMGatewayConfig
  ): number | null {
    const candidate = this.normalizeMetabotId(config[platform].metabotId);
    return this.imStore.resolvePlatformMetabotId(candidate);
  }

  private getRouteMetabotIdForPlatform(platform: IMPlatform): number | null {
    if (!this.isManagedPlatform(platform)) return null;
    return this.resolveRouteMetabotId(platform, this.getConfig());
  }

  /**
   * Stage a teardown of the IM ↔ cowork conversation mapping for a session.
   * Returns false when no cowork handler is bound or the session is not IM-managed.
   *
   * Exposed for CoworkRunner's `start_new_im_session` inline tool so MetaBots
   * can rotate the IM session window on user request.
   */
  requestSessionReset(coworkSessionId: string): boolean {
    return this.coworkHandler?.requestSessionReset(coworkSessionId) ?? false;
  }

  /** Whether the cowork session is IM-managed; false when no handler is bound. */
  isIMSession(coworkSessionId: string): boolean {
    return this.coworkHandler?.isIMSession(coworkSessionId) ?? false;
  }

  private handleMetabotRouteChange(prevConfig: IMGatewayConfig, nextConfig: IMGatewayConfig): void {
    for (const platform of MANAGED_IM_PLATFORMS) {
      const prevResolved = this.resolveRouteMetabotId(platform, prevConfig);
      const nextResolved = this.resolveRouteMetabotId(platform, nextConfig);
      const prevConfigured = this.normalizeMetabotId(prevConfig[platform].metabotId);
      const nextConfigured = this.normalizeMetabotId(nextConfig[platform].metabotId);
      const resolvedChanged = prevResolved !== nextResolved;
      const configuredChanged = prevConfigured !== nextConfigured;
      if (!resolvedChanged && !configuredChanged) continue;

      console.log('[IMGatewayManager] Route metabot changed, clearing mappings', {
        platform,
        from: prevResolved,
        to: nextResolved,
        configuredChange: configuredChanged,
      });

      const removedSessionIds = this.imStore.deleteSessionMappingsByPlatform(platform);
      this.coworkStore?.deleteConversationMappingsByChannel(`im:${platform}`);
      this.coworkHandler?.clearPlatformSessions(removedSessionIds);
      if (!this.coworkRunner || removedSessionIds.length === 0) continue;
      for (const sessionId of removedSessionIds) {
        try {
          this.coworkRunner.stopSession(sessionId, { reason: 'IM platform disconnected; session mappings cleared' });
        } catch (error: any) {
          console.warn('[IMGatewayManager] Failed to stop stale IM session', {
            platform,
            sessionId,
            error: error?.message ?? String(error),
          });
        }
      }
    }
  }

  private calculateVerdict(checks: IMConnectivityCheck[]): IMConnectivityVerdict {
    if (checks.some((check) => check.level === 'fail')) {
      return 'fail';
    }
    if (checks.some((check) => check.level === 'warn')) {
      return 'warn';
    }
    return 'pass';
  }
}
