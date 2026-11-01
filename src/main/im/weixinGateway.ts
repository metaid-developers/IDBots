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
 *   4. Media (v2): inbound image/file/video items are downloaded from the CDN,
 *      AES-128-ECB decrypted and persisted under <userData>/weixin-inbound;
 *      outbound media goes getuploadurl → AES encrypt → CDN POST → sendmessage.
 *
 * SCOPE (v2): text + image/file in direct chats. Voice audio and group chats stay
 * out (the platform disables group messaging for these accounts). Video is
 * uploaded only when a reply explicitly references a video path; inbound video is
 * stored like a file.
 *
 * RISK: `ilinkai.weixin.qq.com` is a NON-PUBLIC interface. It can change or shut
 * down without notice; treat every failure as possible protocol drift.
 *
 * SECRET HANDLING: the bot token lives only in memory/credential files. It is
 * never logged and never placed in a status object or error message. Media
 * credentials (aes_key / encrypt_query_param / upload_param) are never logged;
 * media error strings pass through `redactMediaSecrets` first.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_WEIXIN_STATUS,
  type IMMediaAttachment,
  type IMMessage,
  type WeixinConfig,
  type WeixinGatewayStatus,
} from './types';
import {
  buildBaseInfo,
  buildSendItemsPayload,
  buildSendMessagePayload,
  createWeixinClientId,
  parseQrCodeResponse,
  parseQrStatusResponse,
  parseTypingTicket,
  parseUpdatesResponse,
  parseUploadUrlResponse,
  splitWeixinText,
  toIMMessage,
  WeixinSessionExpiredError,
  WEIXIN_DEFAULT_BASE_URL,
  WEIXIN_LONG_POLL_TIMEOUT_MS,
  WEIXIN_QR_POLL_TIMEOUT_MS,
  WEIXIN_BOT_TYPE,
  WEIXIN_MESSAGE_TYPE_BOT,
  type WeixinInboundMessage,
  type WeixinQrCode,
  type WeixinQrStatus,
} from './weixinProtocol';
import {
  assertWeixinCdnUrl,
  buildWeixinCdnUploadUrl,
  buildWeixinMediaItem,
  defaultWeixinMediaNetwork,
  downloadWeixinMedia,
  prepareWeixinUpload,
  readWeixinMediaRefs,
  redactMediaSecrets,
  sanitizeWeixinFileName,
  uploadKindForFile,
  WeixinMediaError,
  WEIXIN_CDN_BASE_URL,
  WEIXIN_INBOUND_MAX_ATTACHMENTS,
  WEIXIN_OUTBOUND_MAX_BYTES,
  type WeixinMediaNetwork,
  type WeixinMediaRef,
} from './weixinMedia';
import { compressWeixinImage, type CompressedWeixinImage } from './weixinImage';
import { parseMediaMarkers, stripMediaMarkers } from './dingtalkMediaParser';
import { defaultWeixinTransport, WeixinRequestTimeoutError, type WeixinTransport } from './weixinTransport';
import { normalizeWeixinAccountId, WeixinStore, type WeixinStoredCredentials } from './weixinStore';

/** Backoff ladder for consecutive getupdates failures (last value repeats). */
const DEFAULT_POLL_BACKOFF_MS = [2_000, 4_000, 10_000, 30_000];
/** Dedupe window for inbound message ids (protects against cursor replay). */
const DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 500;
/** Delay between two QR status polls when the server answers immediately. */
const QR_POLL_GAP_MS = 300;

/**
 * Resolve the default inbound-media directory lazily, so this module stays
 * importable outside Electron (unit tests pass an explicit directory instead).
 */
export function resolveDefaultWeixinMediaDir(): string {
  try {
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (typeof userData === 'string' && userData) {
      return path.join(userData, 'weixin-inbound');
    }
  } catch {
    // Electron not available (unit tests / plain node).
  }
  return path.join(os.tmpdir(), 'idbots-weixin-inbound');
}

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
  /** Where inbound media is written; defaults to <userData>/weixin-inbound. */
  mediaRootDir?: string;
  /** CDN network surface; defaults to the real fetch implementation. */
  mediaNetwork?: WeixinMediaNetwork;
  /** CDN base URL for uploads/downloads; defaults to the documented novac2c host. */
  cdnBaseUrl?: string;
  /** Image re-encoder; defaults to Electron nativeImage (absent outside Electron). */
  imageCompressor?: (filePath: string) => CompressedWeixinImage | null;
}

export class WeixinGateway extends EventEmitter {
  private readonly store: WeixinStore;
  private readonly transport: WeixinTransport;
  private readonly now: () => number;
  private readonly sleepImpl: ((ms: number, signal?: AbortSignal) => Promise<void>) | null;
  private readonly pollBackoffMs: number[];
  private readonly pollTimeoutMs: number;
  private readonly qrPollTimeoutMs: number;
  private readonly mediaRootDir: string;
  private readonly mediaNetwork: WeixinMediaNetwork;
  private readonly cdnBaseUrl: string;
  private readonly imageCompressor: (filePath: string) => CompressedWeixinImage | null;

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
    this.mediaRootDir = options.mediaRootDir && options.mediaRootDir.trim()
      ? options.mediaRootDir
      : resolveDefaultWeixinMediaDir();
    this.mediaNetwork = options.mediaNetwork ?? defaultWeixinMediaNetwork;
    this.cdnBaseUrl = (options.cdnBaseUrl || WEIXIN_CDN_BASE_URL).replace(/\/+$/, '');
    this.imageCompressor = options.imageCompressor ?? ((filePath) => compressWeixinImage(filePath));
  }

  /** Directory inbound media is written to (exposed for diagnostics/tests). */
  getMediaRootDir(): string {
    return this.mediaRootDir;
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
    await this.cancelLogin();

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
    await this.cancelLogin();
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
  async pollQrStatus(signal?: AbortSignal): Promise<WeixinQrStatus> {
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
        signal,
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

    const controller = new AbortController();
    this.loginAbort = controller;
    this.loginLoopPromise = this.runLoginLoop(controller.signal).finally(() => {
      this.loginLoopPromise = null;
      if (this.loginAbort === controller) this.loginAbort = null;
    });
    return qr;
  }

  /**
   * Abort a pending QR authorization.
   *
   * Deliberately does NOT await the background loop: that loop may be parked in a
   * 35 s long poll, and the settings UI needs the state cleared immediately. The
   * abort signal makes the in-flight request settle on its own.
   */
  async cancelLogin(): Promise<void> {
    const controller = this.loginAbort;
    this.loginAbort = null;
    this.loginLoopPromise = null;
    if (controller) controller.abort();

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
        result = await this.pollQrStatus(signal);
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
    // Our own outbound echo: never download its media or answer it.
    if (raw?.message_type === WEIXIN_MESSAGE_TYPE_BOT) return;

    const rawId = raw && raw.message_id != null ? String(raw.message_id) : null;
    if (rawId && this.isDuplicate(rawId)) return;
    if (rawId) this.markProcessed(rawId);

    const contextToken = typeof raw?.context_token === 'string' ? raw.context_token : '';
    const media = await this.collectInboundMedia(raw);
    const message = toIMMessage(raw, this.now(), {
      attachments: media.attachments,
      failed: media.failed,
    });
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
      await this.sendReplyWithMedia(message.conversationId, text);
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

  /**
   * Download every inbound media item worth keeping.
   *
   * Failures are counted, never thrown: one broken attachment must not cost the
   * whole message. The count is surfaced in the message body ("附件下载失败") by
   * `toIMMessage`.
   */
  private async collectInboundMedia(
    raw: WeixinInboundMessage
  ): Promise<{ attachments: IMMediaAttachment[]; failed: number }> {
    const { refs, droppedKinds, unusable } = readWeixinMediaRefs(raw?.item_list);
    if (droppedKinds.length > 0) {
      console.warn(
        '[Weixin Gateway] inbound media priority (image > video > file): dropped',
        droppedKinds.join(', ')
      );
    }
    if (unusable > 0) {
      console.warn('[Weixin Gateway] inbound media items without usable CDN credentials:', unusable);
    }
    if (refs.length === 0) {
      return { attachments: [], failed: 0 };
    }

    const kept: WeixinMediaRef[] = refs.slice(0, WEIXIN_INBOUND_MAX_ATTACHMENTS);
    const overflow = refs.length - kept.length;
    if (overflow > 0) {
      console.warn(
        `[Weixin Gateway] inbound media capped at ${WEIXIN_INBOUND_MAX_ATTACHMENTS} attachments; dropped ${overflow}`
      );
    }

    const attachments: IMMediaAttachment[] = [];
    let failed = overflow;

    for (const ref of kept) {
      try {
        const attachment = await downloadWeixinMedia(ref, {
          dir: this.mediaRootDir,
          network: this.mediaNetwork,
          now: this.now,
        });
        attachments.push(attachment);
        if (this.config?.debug) {
          console.log('[Weixin Gateway] inbound media saved', {
            kind: ref.kind,
            mimeType: attachment.mimeType,
            fileSize: attachment.fileSize,
            fileName: attachment.fileName,
            duration: attachment.duration,
            // Raw vendor field, kept so the unit can be settled from a real sample.
            playLength: ref.playLength,
            localPath: attachment.localPath,
          });
        }
      } catch (error) {
        failed += 1;
        console.warn(
          '[Weixin Gateway] inbound media failed:',
          ref.kind,
          redactMediaSecrets(this.describeError(error))
        );
      }
    }

    return { attachments, failed };
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

  /**
   * Send one local file as a Weixin media message.
   *
   * Flow (protocol verified against the official plugin):
   *   getuploadurl(rawsize, padded filesize, md5, filekey, aeskey hex)
   *   → AES-128-ECB encrypt → POST ciphertext to the CDN
   *   → `x-encrypted-param` becomes media.encrypt_query_param
   *   → sendmessage with one image/file/video item.
   *
   * Images above our own size/pixel guard are re-encoded first; when no encoder is
   * available (plain node) the original is sent unchanged.
   *
   * `opts.text` is delivered as a separate text message BEFORE the media, matching
   * the official plugin's one-item-per-message behaviour.
   */
  async sendMedia(
    conversationId: string,
    filePath: string,
    opts: { text?: string; fileName?: string } = {}
  ): Promise<void> {
    if (!this.token) {
      throw new Error('Weixin gateway is not authorized');
    }
    if (!filePath || typeof filePath !== 'string') {
      throw new WeixinMediaError('media path is required');
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      throw new WeixinMediaError(`media file not found: ${filePath}`);
    }
    if (!stats.isFile()) {
      throw new WeixinMediaError(`media path is not a regular file: ${filePath}`);
    }
    if (stats.size === 0) {
      throw new WeixinMediaError(`refusing to send an empty file: ${filePath}`);
    }
    if (stats.size > WEIXIN_OUTBOUND_MAX_BYTES) {
      throw new WeixinMediaError(
        `media file is ${stats.size} bytes, above the ${WEIXIN_OUTBOUND_MAX_BYTES} byte client ceiling`
      );
    }

    const displayName = sanitizeWeixinFileName(opts.fileName || path.basename(filePath));
    const { kind, mediaType } = uploadKindForFile(displayName || filePath);

    let sendPath = filePath;
    let temporaryPath: string | null = null;
    if (kind === 'image') {
      let compressed: CompressedWeixinImage | null = null;
      try {
        compressed = this.imageCompressor(filePath);
      } catch (error) {
        console.warn('[Weixin Gateway] image re-encode skipped:', this.describeError(error));
      }
      if (compressed && compressed.bytes > 0) {
        sendPath = compressed.path;
        if (compressed.temporary) temporaryPath = compressed.path;
        console.log('[Weixin Gateway] image re-encoded before upload', {
          bytesBefore: stats.size,
          bytesAfter: compressed.bytes,
          width: compressed.width,
          height: compressed.height,
        });
      }
    }

    try {
      const plaintext = fs.readFileSync(sendPath);
      const prepared = prepareWeixinUpload(plaintext);
      const uploadUrl = await this.requestMediaUploadUrl(conversationId, mediaType, prepared);
      const uploaded = await this.mediaNetwork.postBytes(uploadUrl, prepared.ciphertext, {
        timeoutMs: 120_000,
      });
      if (!uploaded.encryptedParam) {
        const detail = uploaded.errorText ? `: ${uploaded.errorText}` : '';
        throw new WeixinMediaError(`CDN upload failed (HTTP ${uploaded.status})${detail}`);
      }

      if (opts.text && opts.text.trim()) {
        await this.sendText(conversationId, opts.text);
      }

      const item = buildWeixinMediaItem({
        kind,
        downloadEncryptedQueryParam: uploaded.encryptedParam,
        prepared,
        fileName: displayName,
      });
      await this.post('ilink/bot/sendmessage', buildSendItemsPayload({
        toUserId: conversationId,
        items: [item],
        contextToken: this.contextTokens.get(conversationId) || null,
        clientId: createWeixinClientId(this.now()),
      }));

      this.lastConversationId = conversationId;
      this.status = { ...this.status, lastOutboundAt: this.now(), lastError: null };
      this.emitStatus();
      console.log('[Weixin Gateway] media sent', { kind, bytes: prepared.rawsize, fileName: displayName });
    } finally {
      if (temporaryPath) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // Temp cleanup is best effort.
        }
      }
    }
  }

  /** Ask the server for a pre-signed upload URL and return the CDN URL to POST to. */
  private async requestMediaUploadUrl(
    conversationId: string,
    mediaType: number,
    prepared: ReturnType<typeof prepareWeixinUpload>
  ): Promise<string> {
    const response = await this.transport.request({
      method: 'POST',
      baseUrl: this.baseUrl,
      path: 'ilink/bot/getuploadurl',
      body: {
        filekey: prepared.filekey,
        media_type: mediaType,
        to_user_id: conversationId,
        rawsize: prepared.rawsize,
        rawfilemd5: prepared.rawfilemd5,
        filesize: prepared.filesize,
        no_need_thumb: true,
        aeskey: prepared.aesKeyHex,
      },
      token: this.token,
      timeoutMs: 20_000,
    });

    const parsed = parseUploadUrlResponse(response.data);
    if (parsed.uploadFullUrl) {
      return assertWeixinCdnUrl(parsed.uploadFullUrl).toString();
    }
    if (parsed.uploadParam) {
      return buildWeixinCdnUploadUrl({
        uploadParam: parsed.uploadParam,
        filekey: prepared.filekey,
        cdnBaseUrl: this.cdnBaseUrl,
      });
    }
    throw new WeixinMediaError('getuploadurl returned neither upload_full_url nor upload_param');
  }

  /**
   * Reply path: text plus any media markers the agent embedded
   * (`![alt](/abs/path.png)`, `[name](/abs/file.pdf)`, or a bare absolute path).
   * Text is sent first, then each existing file; a missing/failing file becomes a
   * short text notice so the user is never left wondering.
   */
  private async sendReplyWithMedia(conversationId: string, text: string): Promise<void> {
    const markers = parseMediaMarkers(text || '');
    if (markers.length === 0) {
      await this.sendText(conversationId, text);
      return;
    }

    const stripped = stripMediaMarkers(text, markers);
    if (stripped.trim()) {
      await this.sendText(conversationId, stripped);
    }

    for (const marker of markers) {
      const rawPath = marker.path || '';
      const filePath = rawPath.startsWith('~/')
        ? path.join(process.env.HOME || '', rawPath.slice(2))
        : rawPath;
      try {
        if (!filePath || !fs.existsSync(filePath)) {
          console.warn('[Weixin Gateway] reply media missing:', path.basename(filePath || '(empty)'));
          await this.notifyReplyFailure(conversationId, `（附件未找到：${path.basename(filePath || '?')}）`);
          continue;
        }
        // `marker.name` is the alt text / link label, not a filename: using it
        // would hide the real extension (and could turn an image into a file).
        await this.sendMedia(conversationId, filePath);
      } catch (error) {
        console.warn('[Weixin Gateway] reply media failed:', redactMediaSecrets(this.describeError(error)));
        await this.notifyReplyFailure(
          conversationId,
          `（附件发送失败：${sanitizeWeixinFileName(path.basename(filePath || '?'))}）`
        );
      }
    }
  }

  /** Best-effort user-facing notice; never throws. */
  private async notifyReplyFailure(conversationId: string, notice: string): Promise<void> {
    try {
      await this.sendText(conversationId, notice);
    } catch (error) {
      console.warn('[Weixin Gateway] failure notice could not be sent:', this.describeError(error));
    }
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
