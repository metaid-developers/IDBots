/**
 * Weixin (WeChat) personal-account gateway.
 *
 * Mirrors the shape of TelegramGateway: an EventEmitter exposing
 * start / stop / getStatus / setMessageCallback, emitting
 * `connected` / `disconnected` / `error` / `status` / `message` / `login`.
 *
 * Shape of the channel:
 *   1. QR authorization (`requestQrCode` + `pollQrStatus`, driven by `beginLogin`)
 *      produces a bot token, persisted to weixin/accounts/{accountId}.json.
 *   2. `getupdates` long polling with an opaque cursor persisted to
 *      weixin/accounts/{accountId}.sync.json.
 *   3. `sendmessage` in <= 1800 character chunks, echoing the inbound
 *      `context_token`; `sendtyping` for the typing indicator.
 *
 * SCOPE (v1): text only, direct chats only. Media items are surfaced as a short
 * `[unsupported ...]` placeholder so the agent can answer instead of going silent.
 * No group chats, no media upload/download, no tool-confirmation prompt in WeChat.
 *
 * RISK: `ilinkai.weixin.qq.com` is a NON-PUBLIC interface. It can change or shut
 * down without notice; treat every failure as possible protocol drift.
 *
 * SECRET HANDLING: the bot token lives only in memory/credential files. It is
 * never logged and never placed in a status object or error message.
 */

import { EventEmitter } from 'events';
import {
  DEFAULT_WEIXIN_STATUS,
  type IMMessage,
  type WeixinConfig,
  type WeixinGatewayStatus,
} from './types';
import {
  buildBaseInfo,
  buildSendMessagePayload,
  createWeixinClientId,
  parseQrCodeResponse,
  parseQrStatusResponse,
  parseTypingTicket,
  parseUpdatesResponse,
  splitWeixinText,
  toIMMessage,
  WeixinSessionExpiredError,
  WEIXIN_DEFAULT_BASE_URL,
  WEIXIN_LONG_POLL_TIMEOUT_MS,
  WEIXIN_QR_POLL_TIMEOUT_MS,
  WEIXIN_BOT_TYPE,
  type WeixinInboundMessage,
  type WeixinQrCode,
  type WeixinQrStatus,
} from './weixinProtocol';
import { defaultWeixinTransport, WeixinRequestTimeoutError, type WeixinTransport } from './weixinTransport';
import { normalizeWeixinAccountId, WeixinStore, type WeixinStoredCredentials } from './weixinStore';

/** Backoff ladder for consecutive getupdates failures (last value repeats). */
const DEFAULT_POLL_BACKOFF_MS = [2_000, 4_000, 10_000, 30_000];
/** Dedupe window for inbound message ids (protects against cursor replay). */
const DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 500;
/** Delay between two QR status polls when the server answers immediately. */
const QR_POLL_GAP_MS = 300;

export interface WeixinGatewayOptions {
  /** Credential/cursor store; defaults to <userData>/weixin. */
  store?: WeixinStore;
  /** HTTP transport; defaults to the real fetch-based client. */
  transport?: WeixinTransport;
  now?: () => number;
  /** Sleep hook so tests can run without real delays. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollBackoffMs?: number[];
  pollTimeoutMs?: number;
  qrPollTimeoutMs?: number;
}

export class WeixinGateway extends EventEmitter {
  private readonly store: WeixinStore;
  private readonly transport: WeixinTransport;
  private readonly now: () => number;
  private readonly sleepImpl: ((ms: number, signal?: AbortSignal) => Promise<void>) | null;
  private readonly pollBackoffMs: number[];
  private readonly pollTimeoutMs: number;
  private readonly qrPollTimeoutMs: number;

  private config: WeixinConfig | null = null;
  private status: WeixinGatewayStatus = { ...DEFAULT_WEIXIN_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;

  private running = false;
  private pollAbort: AbortController | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  private failureCount = 0;

  private accountId = 'default';
  private token: string | null = null;
  private baseUrl: string = WEIXIN_DEFAULT_BASE_URL;
  private syncBuf = '';

  private pendingQr: { qrcode: string; content: string; createdAt: number } | null = null;
  private loginAbort: AbortController | null = null;
  private loginLoopPromise: Promise<void> | null = null;

  private readonly contextTokens = new Map<string, string>();
  private readonly typingTickets = new Map<string, string>();
  private readonly processedMessages = new Map<string, number>();
  private lastConversationId: string | null = null;

  constructor(options: WeixinGatewayOptions = {}) {
    super();
    this.store = options.store ?? new WeixinStore();
    this.transport = options.transport ?? defaultWeixinTransport;
    this.now = options.now ?? (() => Date.now());
    this.sleepImpl = options.sleep ?? null;
    this.pollBackoffMs = options.pollBackoffMs && options.pollBackoffMs.length > 0
      ? options.pollBackoffMs
      : DEFAULT_POLL_BACKOFF_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? WEIXIN_LONG_POLL_TIMEOUT_MS;
    this.qrPollTimeoutMs = options.qrPollTimeoutMs ?? WEIXIN_QR_POLL_TIMEOUT_MS;
  }

  // ==================== Lifecycle ====================

  getStatus(): WeixinGatewayStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.connected;
  }

  setMessageCallback(
    callback: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>
  ): void {
    this.onMessageCallback = callback;
  }

  /** True when a token exists in config or on disk (used to enable the channel toggle). */
  hasCredentials(config?: WeixinConfig | null): boolean {
    const candidate = config ?? this.config;
    const accountId = normalizeWeixinAccountId(candidate?.accountId);
    const configured = (candidate?.token || '').trim();
    return Boolean(configured) || Boolean(this.store.loadCredentials(accountId));
  }

  /** External reconnect trigger (network restored). */
  reconnectIfNeeded(): void {
    if (this.running || !this.config) return;
    if (!this.hasCredentials(this.config)) return;
    console.log('[Weixin Gateway] External reconnection trigger');
    this.start(this.config).catch((error: Error) => {
      console.error('[Weixin Gateway] Reconnection failed:', this.describeError(error));
    });
  }

  async start(config: WeixinConfig): Promise<void> {
    if (this.running) {
      await this.stop();
    }

    this.config = config ? { ...config } : null;
    this.accountId = normalizeWeixinAccountId(config?.accountId);

    if (!config || !config.enabled) {
      console.log('[Weixin Gateway] Weixin is disabled in config');
      return;
    }

    const stored = this.store.loadCredentials(this.accountId);
    const token = (config.token || '').trim() || stored?.token || '';
    if (!token) {
      throw new Error('Weixin bot token is missing — scan the QR code to authorize this account first.');
    }

    this.token = token;
    this.baseUrl = (config.baseUrl || stored?.baseUrl || WEIXIN_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const sync = this.store.loadSync(this.accountId);
    this.syncBuf = sync?.getUpdatesBuf ?? '';
    this.failureCount = 0;
    this.running = true;

    this.status = {
      connected: true,
      startedAt: this.now(),
      lastError: null,
      accountId: this.accountId,
      loginPending: false,
      loginState: 'idle',
      qrContent: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };

    if (config.debug) {
      console.log('[Weixin Gateway] Started', {
        accountId: this.accountId,
        baseUrl: this.baseUrl,
        hasCursor: Boolean(this.syncBuf),
      });
    }

    this.emitStatus();
    this.emit('connected');
    this.startPollLoop();
  }

  async stop(): Promise<void> {
    const wasRunning = this.running || Boolean(this.pollLoopPromise);
    this.running = false;

    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
    const loop = this.pollLoopPromise;
    this.pollLoopPromise = null;
    if (loop) {
      try {
        await loop;
      } catch {
        // Poll loop already reported its error; stop() must not throw.
      }
    }

    this.token = null;
    this.contextTokens.clear();
    this.typingTickets.clear();
    this.status = { ...DEFAULT_WEIXIN_STATUS };

    if (wasRunning) {
      console.log('[Weixin Gateway] Stopped');
      this.emitStatus();
      this.emit('disconnected');
    }
  }

  // ==================== QR login ====================

  /** Ask the server for a fresh login QR; also marks the status as login-pending. */
  async requestQrCode(): Promise<WeixinQrCode> {
    const stored = this.store.loadCredentials(this.accountId);
    const localTokens = Array.from(new Set(
      [this.token, this.config?.token, stored?.token]
        .map((value) => (value || '').trim())
        .filter((value) => value.length > 0)
    ));

    const response = await this.transport.request({
      method: 'POST',
      baseUrl: this.baseUrl || WEIXIN_DEFAULT_BASE_URL,
      path: 'ilink/bot/get_bot_qrcode',
      query: { bot_type: WEIXIN_BOT_TYPE },
      body: { local_token_list: localTokens },
      timeoutMs: 20_000,
    });

    const qr = parseQrCodeResponse(response.data);
    this.pendingQr = { qrcode: qr.qrcode, content: qr.content, createdAt: this.now() };
    this.status = {
      ...this.status,
      loginPending: true,
      loginState: 'wait',
      qrContent: qr.content,
      lastError: null,
    };
    this.emitStatus();
    return qr;
  }

  /**
   * Poll the QR status once. Long-polls server side; a client-side timeout is
   * reported as `wait` (that is the documented meaning of the timeout).
   */
  async pollQrStatus(): Promise<WeixinQrStatus> {
    const pending = this.pendingQr;
    if (!pending) {
      throw new Error('No pending Weixin QR login; call requestQrCode() first.');
    }

    let data: unknown;
    try {
      const response = await this.transport.request({
        method: 'GET',
        baseUrl: this.baseUrl || WEIXIN_DEFAULT_BASE_URL,
        path: 'ilink/bot/get_qrcode_status',
        query: { qrcode: pending.qrcode },
        extraHeaders: { 'iLink-App-ClientVersion': '1' },
        timeoutMs: this.qrPollTimeoutMs,
      });
      data = response.data;
    } catch (error) {
      if (error instanceof WeixinRequestTimeoutError) {
        return { state: 'wait', credentials: null, error: null };
      }
      throw error;
    }

    const parsed = parseQrStatusResponse(data);

    if (parsed.state === 'confirmed' && parsed.credentials) {
      const stored = this.store.saveCredentials(parsed.credentials, this.accountId, this.now());
      this.token = stored.token;
      this.baseUrl = stored.baseUrl.replace(/\/+$/, '');
      this.pendingQr = null;
      this.status = {
        ...this.status,
        loginPending: false,
        loginState: 'idle',
        qrContent: null,
        accountId: this.accountId,
        lastError: null,
      };
      this.emitStatus();
      return parsed;
    }

    if (parsed.state === 'expired' || parsed.state === 'error') {
      this.pendingQr = null;
      this.status = {
        ...this.status,
        loginPending: false,
        loginState: 'idle',
        qrContent: null,
        lastError: parsed.error,
      };
      this.emitStatus();
    } else {
      // wait/scaned are progress signals, not failures.
      this.status = {
        ...this.status,
        loginState: parsed.state === 'scanned' ? 'scanned' : 'wait',
      };
      this.emitStatus();
    }

    return parsed;
  }

  /**
   * Convenience flow used by the settings UI: fetch a QR, then keep polling in
   * the background. Emits `login` with the terminal status (confirmed/expired/error).
   */
  async beginLogin(): Promise<WeixinQrCode> {
    await this.cancelLogin();
    const qr = await this.requestQrCode();
    if (this.loginLoopPromise) return qr;

    const controller = new AbortController();
    this.loginAbort = controller;
    this.loginLoopPromise = this.runLoginLoop(controller.signal).finally(() => {
      this.loginLoopPromise = null;
      if (this.loginAbort === controller) this.loginAbort = null;
    });
    return qr;
  }

  async cancelLogin(): Promise<void> {
    if (this.loginAbort) {
      this.loginAbort.abort();
      this.loginAbort = null;
    }
    const loop = this.loginLoopPromise;
    if (loop) {
      try {
        await loop;
      } catch {
        // ignore
      }
      this.loginLoopPromise = null;
    }
    if (this.pendingQr || this.status.loginPending) {
      this.pendingQr = null;
      this.status = { ...this.status, loginPending: false, loginState: 'idle', qrContent: null };
      this.emitStatus();
    }
  }

  private async runLoginLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.status.loginPending) {
      let result: WeixinQrStatus;
      try {
        result = await this.pollQrStatus();
      } catch (error) {
        if (signal.aborted) return;
        const message = this.describeError(error);
        this.status = {
          ...this.status,
          lastError: message,
          loginPending: false,
          loginState: 'idle',
          qrContent: null,
        };
        this.pendingQr = null;
        this.emitStatus();
        this.emit('login', { state: 'error', credentials: null, error: message } satisfies WeixinQrStatus);
        this.emitError(error instanceof Error ? error : new Error(message));
        return;
      }

      if (result.state === 'confirmed' || result.state === 'expired' || result.state === 'error') {
        this.emit('login', result);
        return;
      }

      await this.sleep(QR_POLL_GAP_MS, signal);
    }
  }

  // ==================== Inbound polling ====================

  private startPollLoop(): void {
    if (this.pollLoopPromise) return;
    const controller = new AbortController();
    this.pollAbort = controller;
    this.pollLoopPromise = this.runPollLoop(controller.signal)
      .catch((error) => {
        console.error('[Weixin Gateway] Poll loop crashed:', this.describeError(error));
      })
      .finally(() => {
        this.pollLoopPromise = null;
        if (this.pollAbort === controller) this.pollAbort = null;
      });
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        const response = await this.transport.request({
          method: 'POST',
          baseUrl: this.baseUrl,
          path: 'ilink/bot/getupdates',
          body: { get_updates_buf: this.syncBuf, base_info: buildBaseInfo() },
          token: this.token,
          timeoutMs: this.pollTimeoutMs,
          signal,
        });

        const updates = parseUpdatesResponse(response.data);
        this.failureCount = 0;

        if (updates.nextBuf && updates.nextBuf !== this.syncBuf) {
          this.syncBuf = updates.nextBuf;
          try {
            this.store.saveSync(this.syncBuf, this.accountId, this.now());
          } catch (error) {
            console.warn('[Weixin Gateway] Failed to persist cursor:', this.describeError(error as Error));
          }
        }

        for (const raw of updates.messages) {
          if (!this.running || signal.aborted) break;
          await this.handleInbound(raw);
        }
      } catch (error) {
        if (signal.aborted || !this.running) return;

        if (error instanceof WeixinRequestTimeoutError) {
          // A local long-poll timeout is an empty poll, not a failure.
          continue;
        }

        if (error instanceof WeixinSessionExpiredError) {
          await this.handleSessionExpired(this.describeError(error));
          return;
        }

        this.failureCount += 1;
        const backoff = this.pollBackoffMs[Math.min(this.failureCount, this.pollBackoffMs.length) - 1];
        const message = this.describeError(error);
        this.status = { ...this.status, lastError: message };
        this.emitStatus();
        this.emitError(error instanceof Error ? error : new Error(message));
        console.warn(`[Weixin Gateway] getupdates failed (attempt ${this.failureCount}), retrying in ${backoff}ms`);
        await this.sleep(backoff, signal);
      }
    }
  }

  private async handleInbound(raw: WeixinInboundMessage): Promise<void> {
    const rawId = raw && raw.message_id != null ? String(raw.message_id) : null;
    if (rawId && this.isDuplicate(rawId)) return;
    if (rawId) this.markProcessed(rawId);

    const contextToken = typeof raw?.context_token === 'string' ? raw.context_token : '';
    const message = toIMMessage(raw, this.now());
    if (!message) return;

    if (contextToken) {
      this.contextTokens.set(message.conversationId, contextToken);
      this.typingTickets.delete(message.conversationId);
    }
    this.lastConversationId = message.conversationId;
    this.status = { ...this.status, lastInboundAt: this.now(), lastError: null };
    this.emitStatus();
    this.emit('message', message);

    if (!this.onMessageCallback) return;

    const replyFn = async (text: string): Promise<void> => {
      await this.sendText(message.conversationId, text);
    };

    await this.sendTyping(message.conversationId, true);
    try {
      await this.onMessageCallback(message, replyFn);
    } catch (error) {
      this.status = { ...this.status, lastError: this.describeError(error) };
      this.emitStatus();
      this.emitError(error instanceof Error ? error : new Error(this.describeError(error)));
    } finally {
      await this.sendTyping(message.conversationId, false);
    }
  }

  private isDuplicate(messageId: string): boolean {
    this.pruneProcessed();
    return this.processedMessages.has(messageId);
  }

  private markProcessed(messageId: string): void {
    this.processedMessages.set(messageId, this.now());
    this.pruneProcessed();
  }

  private pruneProcessed(): void {
    const cutoff = this.now() - DEDUPE_TTL_MS;
    for (const [id, at] of this.processedMessages) {
      if (at < cutoff) this.processedMessages.delete(id);
    }
    while (this.processedMessages.size > DEDUPE_MAX_ENTRIES) {
      const oldest = this.processedMessages.keys().next();
      if (oldest.done) break;
      this.processedMessages.delete(oldest.value);
    }
  }

  // ==================== Outbound ====================

  /** Send text, split into <= 1800 character chunks. */
  async sendText(conversationId: string, text: string): Promise<void> {
    if (!this.token) {
      throw new Error('Weixin gateway is not authorized');
    }
    const chunks = splitWeixinText(text);
    if (chunks.length === 0) return;

    const contextToken = this.contextTokens.get(conversationId) || null;
    for (const chunk of chunks) {
      await this.post('ilink/bot/sendmessage', buildSendMessagePayload({
        toUserId: conversationId,
        text: chunk,
        contextToken,
        clientId: createWeixinClientId(this.now()),
      }));
    }

    this.lastConversationId = conversationId;
    this.status = { ...this.status, lastOutboundAt: this.now(), lastError: null };
    this.emitStatus();
  }

  /** Show or clear the typing indicator. Best effort: never throws. */
  async sendTyping(conversationId: string, typing: boolean): Promise<void> {
    if (!this.token) return;
    try {
      const ticket = await this.ensureTypingTicket(conversationId);
      if (!ticket) return;
      await this.post('ilink/bot/sendtyping', {
        ilink_user_id: conversationId,
        typing_ticket: ticket,
        status: typing ? 1 : 2,
        base_info: buildBaseInfo(),
      });
    } catch (error) {
      if (this.config?.debug) {
        console.warn('[Weixin Gateway] sendtyping failed (ignored):', this.describeError(error));
      }
    }
  }

  /** Send a notification to the most recent conversation (used by scheduler hooks). */
  async sendNotification(text: string): Promise<boolean> {
    if (!this.status.connected || !this.lastConversationId) return false;
    try {
      await this.sendText(this.lastConversationId, text);
      return true;
    } catch (error) {
      console.warn('[Weixin Gateway] sendNotification failed:', this.describeError(error));
      return false;
    }
  }

  /**
   * Auth probe for the connectivity test: one getupdates round with a short
   * timeout. `ret=0` proves the token is accepted; a local timeout still proves
   * the endpoint is reachable and the request was not rejected.
   */
  async probeAuth(timeoutMs = 10_000): Promise<string> {
    const stored = this.token ? null : this.store.loadCredentials(this.accountId);
    const token = this.token || (this.config?.token || '').trim() || stored?.token || '';
    if (!token) {
      throw new Error('Weixin bot token is missing — scan the QR code first.');
    }
    const baseUrl = (this.baseUrl || this.config?.baseUrl || stored?.baseUrl || WEIXIN_DEFAULT_BASE_URL)
      .replace(/\/+$/, '');
    try {
      const response = await this.transport.request({
        method: 'POST',
        baseUrl,
        path: 'ilink/bot/getupdates',
        body: { get_updates_buf: this.syncBuf, base_info: buildBaseInfo() },
        token,
        timeoutMs,
      });
      parseUpdatesResponse(response.data);
      return 'Weixin bot token accepted (getupdates returned ret=0).';
    } catch (error) {
      if (error instanceof WeixinRequestTimeoutError) {
        return 'Weixin endpoint reachable; the long poll returned no update during the probe window.';
      }
      throw error;
    }
  }

  private async ensureTypingTicket(userId: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached) return cached;

    const contextToken = this.contextTokens.get(userId);
    const body: Record<string, unknown> = { ilink_user_id: userId, base_info: buildBaseInfo() };
    if (contextToken) body.context_token = contextToken;

    const response = await this.transport.request({
      method: 'POST',
      baseUrl: this.baseUrl,
      path: 'ilink/bot/getconfig',
      body,
      token: this.token,
      timeoutMs: 15_000,
    });
    const ticket = parseTypingTicket(response.data);
    if (ticket) this.typingTickets.set(userId, ticket);
    return ticket;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.transport.request({
      method: 'POST',
      baseUrl: this.baseUrl,
      path,
      body,
      token: this.token,
      timeoutMs: 20_000,
    });
    if (response.status >= 400) {
      throw new Error(`Weixin ${path} failed with HTTP ${response.status}`);
    }
    // Business errors are reported with HTTP 200 + ret/errcode.
    const code = (response.data && typeof response.data === 'object')
      ? Number((response.data as Record<string, unknown>).ret ?? (response.data as Record<string, unknown>).errcode ?? 0)
      : 0;
    if (Number.isFinite(code) && code !== 0) {
      if (code === -14) {
        throw new WeixinSessionExpiredError(`Weixin session expired while calling ${path}`);
      }
      const errmsg = (response.data as Record<string, unknown>)?.errmsg;
      throw new Error(`Weixin ${path} failed (ret ${code})${typeof errmsg === 'string' ? `: ${errmsg}` : ''}`);
    }
    return response.data;
  }

  // ==================== Session handling ====================

  /**
   * `ret/errcode = -14`: the token and cursor are no longer trustworthy.
   * Drop both, stop polling, and require a fresh QR scan (no silent retry loop).
   */
  private async handleSessionExpired(message: string): Promise<void> {
    this.running = false;
    this.token = null;
    this.syncBuf = '';
    this.contextTokens.clear();
    this.typingTickets.clear();
    try {
      this.store.clearCredentials(this.accountId);
      this.store.clearSync(this.accountId);
    } catch (error) {
      console.warn('[Weixin Gateway] Failed to clear expired credentials:', this.describeError(error as Error));
    }

    this.status = { ...DEFAULT_WEIXIN_STATUS, lastError: message };
    console.error('[Weixin Gateway] Session expired; QR authorization is required again.');
    this.emitStatus();
    this.emitError(new WeixinSessionExpiredError(message));
    this.emit('disconnected');
  }

  // ==================== Utilities ====================

  /** Credentials currently persisted for this account (token excluded from logs). */
  getStoredCredentials(): WeixinStoredCredentials | null {
    return this.store.loadCredentials(this.accountId);
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }

  /**
   * Emit `error` only when somebody listens. Node throws on an unhandled 'error'
   * event, and an unhandled emit inside the poll loop would silently kill the
   * gateway; logging is the safe fallback.
   */
  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
      return;
    }
    console.warn('[Weixin Gateway] Error (no listener attached):', this.describeError(error));
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.sleepImpl) return this.sleepImpl(ms, signal);
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
