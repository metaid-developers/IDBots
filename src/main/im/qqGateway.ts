/**
 * QQ official-bot gateway.
 *
 * Transport: the OFFICIAL `@tencent-connect/qqbot-nodejs` SDK (HTTP REST +
 * WebSocket gateway), not a reverse-engineered interface. `start()` /
 * `stop()` / `getStatus()` / `sendText()` / `sendMedia()` mirror the other IM
 * gateways in this folder.
 *
 * DESIGN NOTES
 *   - The SDK is ESM-only. `electron-tsconfig.json` compiles the main process to
 *     CommonJS, and a literal `import()` would be rewritten to `require()`.
 *     We therefore re-import through `new Function(...)` — the same escape hatch
 *     already used by `libs/knowledgeBaseConverters.ts` for pdfjs-dist.
 *   - Reconnect has TWO layers: the SDK's own WebSocket reconnect policy
 *     (`RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]`) and this
 *     gateway's outer supervisor (bot recreation with exponential backoff) for
 *     the case where the SDK gives up (`maxAttempts` exhausted) or a token fetch
 *     fails at startup.
 *   - Concurrency: every conversation id gets a FIFO queue. Two messages from the
 *     same chat never write the same cowork session in parallel (the Weixin
 *     channel hit "session already owned by an active write handle" this way).
 *     Different chats still run in parallel.
 *
 * SECRET HANDLING: `appSecret` lives only in `QQStore` (0600) and in the
 * in-memory copy handed to the SDK. It is never logged, never included in a
 * status object, never emitted in a `login` event, and never returned by an IPC
 * handler.
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';

import type { IMMessage, QQConfig, QQGatewayStatus } from './types';
import { DEFAULT_QQ_STATUS } from './types';
import {
  QQ_DEFAULT_API_BASE_URL,
  QQ_DEFAULT_TOKEN_BASE_URL,
  QQ_INBOUND_MAX_ATTACHMENTS,
  QQ_PASSIVE_REPLY_TTL_MS,
  QQ_TARGET_CACHE_MAX_ENTRIES,
  QQ_TOKEN_PATH,
  QQProtocolError,
  classifyQQOutbound,
  qqConversationId,
  qqMentionDecision,
  qqReplyTarget,
  readQQMediaRefs,
  redactQQSecrets,
  splitQQText,
  toQQIMMessage,
  type QQInboundLike,
  type QQLoginCredentials,
  type QQTarget,
} from './qqProtocol';
import {
  QQMediaError,
  defaultQQMediaNetwork,
  describeQQMediaError,
  downloadQQMedia,
  checkQQOutboundFile,
  type QQMediaNetwork,
} from './qqMedia';
import { QQStore, normalizeQQAccountId, type QQCredentialSource } from './qqStore';
import {
  QQGroupCandidateStore,
  normalizeQQGroupId,
  type QQGroupNameStatus,
} from './qqCandidates';
import { createQQGroupInfoLookup, type QQGroupInfoLookup } from './qqGroupInfo';
import {
  QQ_GROUP_MEDIA_NOTICE,
  QQGroupAuditLog,
  resolveQQMessageGate,
  summarizeForAudit,
} from './qqTrust';

/** Default outer backoff, one step above the SDK's own 60 s ceiling. */
export const DEFAULT_QQ_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 500;
/** At most one "still processing" notice per conversation per window. */
const QUEUE_NOTICE_COOLDOWN_MS = 30_000;

export function resolveDefaultQQMediaDir(): string {
  try {
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (typeof userData === 'string' && userData) {
      return path.join(userData, 'qq-inbound');
    }
  } catch {
    // Electron not available (unit tests / plain node).
  }
  return path.join(os.tmpdir(), 'idbots-qq-inbound');
}

// ---------------------------------------------------------------------------
// SDK boundary (injectable so the whole suite runs offline)
// ---------------------------------------------------------------------------

export interface QQLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface QQBotLike {
  on(event: 'message', handler: (ctx: unknown, msg: QQInboundLike) => void | Promise<void>): QQBotLike;
  on(event: 'ready' | 'resumed', handler: (data?: unknown) => void): QQBotLike;
  on(event: 'error', handler: (error: Error) => void): QQBotLike;
  on(
    event: 'disconnected',
    handler: (event: { code?: number; reason?: string; willReconnect?: boolean }) => void
  ): QQBotLike;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  sendText(target: QQTarget, content: string): Promise<unknown>;
  sendTyping?(target: QQTarget, durationSec?: number): Promise<unknown>;
  sendImage?(target: QQTarget, source: { localPath: string }, opts?: { content?: string }): Promise<unknown>;
  sendVideo?(target: QQTarget, source: { localPath: string }, opts?: { content?: string }): Promise<unknown>;
  sendVoice?(target: QQTarget, source: { localPath: string }): Promise<unknown>;
  sendFile?(
    target: QQTarget,
    source: { localPath: string },
    opts?: { fileName?: string; content?: string }
  ): Promise<unknown>;
}

export interface QQBotFactoryOptions {
  appId: string;
  /** Sensitive. Passed to the SDK only, never logged. */
  appSecret: string;
  accountId: string;
  debug: boolean;
}

export interface QQBotFactory {
  create(options: QQBotFactoryOptions): Promise<QQBotLike> | QQBotLike;
}

/** Hidden from tsc's CommonJS rewrite; see the file header. */
const runtimeImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string
) => Promise<Record<string, unknown>>;

export const defaultQQBotFactory: QQBotFactory = {
  async create(options) {
    const module = await runtimeImport('@tencent-connect/qqbot-nodejs');
    const QQBot = module?.QQBot as (new (config: Record<string, unknown>) => QQBotLike) | undefined;
    if (typeof QQBot !== 'function') {
      throw new Error('@tencent-connect/qqbot-nodejs did not export QQBot');
    }
    const logger: QQLogger = {
      info: (msg) => {
        if (options.debug) console.log('[QQ SDK]', redactQQSecrets(msg));
      },
      warn: (msg) => {
        if (options.debug) console.warn('[QQ SDK]', redactQQSecrets(msg));
      },
      error: (msg) => console.error('[QQ SDK]', redactQQSecrets(msg)),
      debug: () => {
        // Deliberately silent: debug lines can carry request metadata.
      },
    };
    return new QQBot({
      appId: options.appId,
      appSecret: options.appSecret,
      accountId: options.accountId,
      logger,
      tokenPrefetch: 'sync',
      reconnect: { maxAttempts: 8 },
    });
  },
};

export interface QQConnectHandlers {
  onSuccess: (credentials: QQLoginCredentials[]) => void;
  onFailure: (error: Error) => void;
  onQrDisplayed?: (url: string) => void;
  onQrExpired?: () => void;
}

export interface QQConnectOptions {
  displayQrCodeToConsole?: boolean;
  source?: string;
  signal?: AbortSignal;
}

/** `startQrConnect` wrapper; async because the connector package is ESM. */
export type QQConnectStarter = (
  callbacks: QQConnectHandlers,
  options?: QQConnectOptions
) => Promise<() => void>;

export const defaultQQConnectStarter: QQConnectStarter = async (callbacks, options) => {
  const module = await runtimeImport('@tencent-connect/qqbot-connector');
  const startQrConnect = module?.startQrConnect as
    | ((cb: QQConnectHandlers, opts?: QQConnectOptions) => () => void)
    | undefined;
  if (typeof startQrConnect !== 'function') {
    throw new Error('@tencent-connect/qqbot-connector did not export startQrConnect');
  }
  return startQrConnect(callbacks, options);
};

export interface QQProbeRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface QQProbeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type QQProbeFetch = (request: QQProbeRequest) => Promise<QQProbeResponse>;

const defaultProbeFetch: QQProbeFetch = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};

export interface QQGatewayOptions {
  store?: QQStore;
  botFactory?: QQBotFactory;
  connectStarter?: QQConnectStarter;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  reconnectBackoffMs?: number[];
  mediaRootDir?: string;
  mediaNetwork?: QQMediaNetwork;
  probeFetch?: QQProbeFetch;
  /** Timeout for the QR URL to appear. */
  qrDisplayTimeoutMs?: number;
  /** Overall QR login window before the connector is disposed. */
  qrLoginTimeoutMs?: number;
  /** Typing indicator only exists for C2C (USAGE.md §9.3); default on. */
  typingIndicator?: boolean;
  /**
   * LIVE security config reader. The settings page writes through
   * `imStore.setQQConfig` without restarting the gateway, so a snapshot taken
   * in `start()` would silently keep serving the old allowlist. Returns
   * partial config; `qqTrust` normalizes it (missing/typo => strictest).
   */
  configProvider?: () => Partial<QQConfig> | null | undefined;
  /** Group audit trail writer (tests inject a temp dir). */
  auditLog?: QQGroupAuditLog;
  /**
   * Store for groups that messaged the bot while NOT allowlisted.
   *
   * Recording exists so the owner can allow a group without ever handling the
   * 32-hex group OpenID by hand. It is NOT authorisation: see `qqCandidates.ts`.
   * Tests inject a temp dir; production defaults to `<userData>/qq`.
   */
  groupCandidates?: QQGroupCandidateStore;
  /**
   * Optional group-NAME lookup (`GET /v2/groups/{openid}/info`). Defaults to the
   * real platform call; tests inject a fake so the suite stays offline.
   */
  groupInfoLookup?: QQGroupInfoLookup;
}

export interface QQLoginEvent {
  state: 'wait' | 'scanned' | 'expired' | 'confirmed' | 'error';
  error: string | null;
  appId: string | null;
}

/**
 * One remembered group, shaped for the settings page.
 *
 * `groupId` is the platform's group OpenID and is ALWAYS present — it is the
 * only identifier the platform guarantees. `name` is an optional extra that
 * exists only when the (whitelist-gated) group-info endpoint answered.
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

export interface QQGroupCandidateReport {
  /**
   * Groups to ask the owner about: recorded, not ignored, and not in the
   * allowlist. These are the rows that carry an 「允许」 button.
   */
  pending: QQGroupCandidateView[];
  /** Every remembered group, newest activity first (names included). */
  all: QQGroupCandidateView[];
}

interface CachedTarget {
  target: QQTarget;
  receivedAt: number;
}

interface QrSession {
  abort: AbortController;
  dispose: (() => void) | null;
  qrContent: string;
  credentials: Promise<QQLoginCredentials>;
  resolveQr: (content: string) => void;
  rejectQr: (error: Error) => void;
  rejectCredentials: (error: Error) => void;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  displayTimer: ReturnType<typeof setTimeout> | null;
}

export class QQGateway extends EventEmitter {
  private readonly store: QQStore;
  private readonly botFactory: QQBotFactory;
  private readonly connectStarter: QQConnectStarter;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly reconnectBackoffMs: number[];
  private readonly mediaRootDir: string;
  private readonly mediaNetwork: QQMediaNetwork;
  private readonly probeFetch: QQProbeFetch;
  private readonly qrDisplayTimeoutMs: number;
  private readonly qrLoginTimeoutMs: number;
  private readonly typingIndicator: boolean;
  private readonly configProvider?: () => Partial<QQConfig> | null | undefined;
  private readonly auditLog: QQGroupAuditLog;
  private readonly groupCandidates: QQGroupCandidateStore;
  private readonly groupInfoLookup: QQGroupInfoLookup;

  private config: QQConfig | null = null;
  private status: QQGatewayStatus = { ...DEFAULT_QQ_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;

  private running = false;
  private bot: QQBotLike | null = null;
  private runAbort: AbortController | null = null;
  private supervisorPromise: Promise<void> | null = null;
  private failureCount = 0;

  private accountId = 'default';
  private credentials: QQLoginCredentials | null = null;
  private credentialSource: QQCredentialSource | null = null;

  private qrSession: QrSession | null = null;
  /**
   * The most recent QR login's credential promise. Kept after the session is
   * cleared so `pollLogin()` still resolves for a caller that awaited the QR URL
   * first (the QR session itself is gone the moment the scan is confirmed).
   */
  private lastLoginCredentials: Promise<QQLoginCredentials> | null = null;

  private readonly targets = new Map<string, CachedTarget>();
  private readonly processedMessages = new Map<string, number>();
  private readonly conversationQueues = new Map<string, Promise<void>>();
  private readonly conversationDepth = new Map<string, number>();
  private readonly queueNoticeAt = new Map<string, number>();
  private lastConversationId: string | null = null;

  constructor(options: QQGatewayOptions = {}) {
    super();
    this.store = options.store ?? new QQStore();
    this.botFactory = options.botFactory ?? defaultQQBotFactory;
    this.connectStarter = options.connectStarter ?? defaultQQConnectStarter;
    this.now = options.now ?? (() => Date.now());
    this.sleepImpl = options.sleep ?? ((ms, signal) => defaultSleep(ms, signal));
    this.reconnectBackoffMs = options.reconnectBackoffMs && options.reconnectBackoffMs.length > 0
      ? options.reconnectBackoffMs
      : DEFAULT_QQ_RECONNECT_BACKOFF_MS;
    this.mediaRootDir = options.mediaRootDir && options.mediaRootDir.trim()
      ? options.mediaRootDir
      : resolveDefaultQQMediaDir();
    this.mediaNetwork = options.mediaNetwork ?? defaultQQMediaNetwork;
    this.probeFetch = options.probeFetch ?? defaultProbeFetch;
    this.qrDisplayTimeoutMs = options.qrDisplayTimeoutMs ?? 60_000;
    this.qrLoginTimeoutMs = options.qrLoginTimeoutMs ?? 5 * 60_000;
    this.typingIndicator = options.typingIndicator ?? true;
    this.configProvider = options.configProvider;
    this.auditLog = options.auditLog ?? new QQGroupAuditLog(undefined, this.now);
    this.groupCandidates = options.groupCandidates ?? new QQGroupCandidateStore();
    this.groupInfoLookup =
      options.groupInfoLookup
      ?? createQQGroupInfoLookup({
        // Read the LIVE credential pair. Never logs it, never returns it.
        getCredentials: () => {
          const resolved = this.resolveCredentials(this.liveConfig());
          if (!resolved) return null;
          return {
            appId: resolved.credentials.appId,
            appSecret: resolved.credentials.appSecret,
          };
        },
        now: this.now,
      });
  }

  /**
   * The config the gate must judge with. Live provider first (settings can
   * change mid-run), snapshot second (unit tests / start-only callers).
   * Fail-closed: a throwing provider returns null, which the gate treats as
   * "no allowlist, no owner" => every message is a silent drop.
   */
  private liveConfig(): Partial<QQConfig> | null {
    if (this.configProvider) {
      try {
        const live = this.configProvider();
        if (live && typeof live === 'object') return live;
      } catch {
        return null;
      }
    }
    return this.config;
  }

  getMediaRootDir(): string {
    return this.mediaRootDir;
  }

  getStatus(): QQGatewayStatus {
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

  // ==================== Group candidates ====================
  //
  // Read/act on groups that messaged the bot while not allowlisted. The whole
  // point is that the owner never types a 32-hex group OpenID: it arrives from
  // the platform, the settings page lists it, one click allows it.

  /**
   * The allowlist the GATE would use right now (trim + drop empties), so the
   * "pending" list can never disagree with the decision on the message path.
   */
  private currentAllowlist(): string[] {
    const live = this.liveConfig();
    const raw = Array.isArray(live?.groupAllowlist) ? live?.groupAllowlist : [];
    return (raw ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
  }

  /** Remembered groups + the ones that still need a decision. */
  getGroupCandidates(): QQGroupCandidateReport {
    const allowlist = new Set(this.currentAllowlist());
    const all: QQGroupCandidateView[] = this.groupCandidates
      .list()
      .map((entry) => ({
        groupId: entry.groupId,
        name: entry.name,
        nameStatus: entry.nameStatus,
        nameCheckedAt: entry.nameCheckedAt,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        messageCount: entry.messageCount,
        ignored: entry.ignored,
        allowed: allowlist.has(entry.groupId),
      }));
    return {
      pending: all.filter((entry) => !entry.ignored && !entry.allowed),
      all,
    };
  }

  /** Owner pressed 拒绝/忽略: hide it from the pending list, still not allowed. */
  dismissGroupCandidate(groupId: string): QQGroupCandidateReport {
    this.groupCandidates.setIgnored(groupId, true);
    return this.getGroupCandidates();
  }

  /** Undo an ignore. */
  restoreGroupCandidate(groupId: string): QQGroupCandidateReport {
    this.groupCandidates.setIgnored(groupId, false);
    return this.getGroupCandidates();
  }

  /**
   * Ask the platform for this group's name.
   *
   * Optional and non-load-bearing: the official endpoint is whitelist-gated
   * (error 11253), so a normal bot gets `forbidden` and the UI shows the id
   * alone. Never throws; a failure only records that no name is available.
   */
  async refreshGroupCandidateName(groupId: string): Promise<QQGroupCandidateView | null> {
    const id = normalizeQQGroupId(groupId);
    if (!id) return null;
    let result: { name: string | null; status: QQGroupNameStatus };
    try {
      const lookup = await this.groupInfoLookup(id);
      result = { name: lookup.name, status: lookup.status };
    } catch (error) {
      result = { name: null, status: 'error' };
      this.debugLog('group name lookup threw', { error: this.describeError(error) });
    }
    const stored = this.groupCandidates.setName(id, result, this.now());
    if (!stored) return null;
    const allowlist = new Set(this.currentAllowlist());
    return {
      groupId: stored.groupId,
      name: stored.name,
      nameStatus: stored.nameStatus,
      nameCheckedAt: stored.nameCheckedAt,
      firstSeenAt: stored.firstSeenAt,
      lastSeenAt: stored.lastSeenAt,
      messageCount: stored.messageCount,
      ignored: stored.ignored,
      allowed: allowlist.has(stored.groupId),
    };
  }

  /** Where the candidate list lives (diagnostics; no secrets). */
  getGroupCandidateFile(): string {
    return this.groupCandidates.filePath();
  }

  hasCredentials(config?: QQConfig | null): boolean {
    const candidate = config ?? this.config;
    if (candidate && candidate.appId && candidate.appSecret && candidate.appSecret.trim()) {
      return true;
    }
    const appId = (candidate?.appId || '').trim();
    return Boolean(
      (appId ? this.store.loadCredentials(normalizeQQAccountId(appId)) : null)
      ?? this.store.loadCredentials()
    );
  }

  /** External reconnect trigger (network restored). */
  reconnectIfNeeded(): void {
    if (this.running || !this.config) return;
    if (!this.hasCredentials(this.config)) return;
    console.log('[QQ Gateway] External reconnection trigger');
    this.start(this.config).catch((error: Error) => {
      console.error('[QQ Gateway] Reconnection failed:', this.describeError(error));
    });
  }

  // ==================== Lifecycle ====================

  async start(config: QQConfig): Promise<void> {
    if (this.running) {
      await this.stop();
    }
    await this.cancelLogin();

    this.config = config ? { ...config } : null;
    this.accountId = normalizeQQAccountId(config?.appId);

    if (!config || !config.enabled) {
      console.log('[QQ Gateway] QQ is disabled in config');
      return;
    }

    const resolved = this.resolveCredentials(config);
    if (!resolved) {
      throw new Error('QQ credentials are missing — scan the QR code or enter AppID + AppSecret first.');
    }
    this.credentials = resolved.credentials;
    this.credentialSource = resolved.source;

    this.failureCount = 0;
    this.running = true;
    this.status = {
      ...this.status,
      connected: true,
      startedAt: this.now(),
      lastError: null,
      appId: resolved.credentials.appId,
      loginPending: false,
      loginState: 'idle',
      qrContent: null,
    };
    this.emitStatus();

    if (config.debug) {
      console.log('[QQ Gateway] Starting', {
        appId: resolved.credentials.appId,
        source: resolved.source,
        apiBase: QQ_DEFAULT_API_BASE_URL,
        mediaRoot: this.mediaRootDir,
      });
    }

    this.runAbort = new AbortController();
    this.supervisorPromise = this.runSupervisor(this.runAbort.signal);
  }

  async stop(): Promise<void> {
    await this.cancelLogin();
    const wasRunning = this.running;
    this.running = false;

    const abort = this.runAbort;
    this.runAbort = null;
    const supervisor = this.supervisorPromise;
    this.supervisorPromise = null;

    const bot = this.bot;
    this.bot = null;
    try {
      bot?.stop();
    } catch {
      // stop() must never throw.
    }
    abort?.abort();

    if (supervisor) {
      try {
        await supervisor;
      } catch {
        // The supervisor reports its own failures.
      }
    }

    // Queued work belongs to the old connection. Drop the chains so a restart
    // starts clean; in-flight handlers keep their own promise references.
    this.conversationQueues.clear();
    this.conversationDepth.clear();
    this.targets.clear();

    if (wasRunning) {
      this.status = { ...this.status, connected: false };
      this.emitStatus();
      this.emit('disconnected');
    }
  }

  /**
   * Outer supervisor. The SDK reconnects internally; this loop only runs when
   * the SDK gives up or a fresh bot instance is needed (token failure, fatal
   * close). Backoff is exponential and bounded by `reconnectBackoffMs`.
   */
  private async runSupervisor(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        const credentials = this.credentials;
        if (!credentials) throw new Error('QQ credentials disappeared');
        const bot = await this.botFactory.create({
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          accountId: this.accountId,
          debug: Boolean(this.config?.debug),
        });
        this.bot = bot;
        this.attachHandlers(bot);

        await bot.start(signal);
        if (!this.running || signal.aborted) break;
        throw new Error('QQ gateway closed the connection');
      } catch (error) {
        if (!this.running || signal.aborted) break;
        this.failureCount += 1;
        const delay = this.reconnectBackoffMs[
          Math.min(this.failureCount, this.reconnectBackoffMs.length) - 1
        ];
        const message = this.describeError(error);
        this.status = { ...this.status, connected: false, lastError: message };
        this.emitStatus();
        this.emitError(error instanceof Error ? error : new Error(message));
        console.warn(`[QQ Gateway] Connection failed (attempt ${this.failureCount}), retrying in ${delay}ms:`, message);
        await this.sleep(delay, signal);
      }
    }
  }

  private attachHandlers(bot: QQBotLike): void {
    bot.on('message', (_ctx, msg) => {
      void this.handleInbound(msg).catch((error: Error) => {
        this.status = { ...this.status, lastError: this.describeError(error) };
        this.emitStatus();
        this.emitError(error);
      });
    });
    bot.on('ready', () => {
      this.failureCount = 0;
      this.status = {
        ...this.status,
        connected: true,
        lastError: null,
        startedAt: this.status.startedAt ?? this.now(),
      };
      this.emitStatus();
      this.emit('connected');
    });
    bot.on('resumed', () => {
      this.status = { ...this.status, connected: true, lastError: null };
      this.emitStatus();
    });
    bot.on('error', (error) => {
      if (!error) return;
      this.status = { ...this.status, lastError: this.describeError(error) };
      this.emitStatus();
      this.emitError(error);
    });
    bot.on('disconnected', (event) => {
      const willReconnect = event?.willReconnect !== false;
      const reason = event?.reason ? `disconnected: ${event.reason}` : 'disconnected';
      this.status = {
        ...this.status,
        connected: willReconnect,
        lastError: willReconnect ? null : reason,
      };
      this.emitStatus();
      if (willReconnect) this.emit('disconnected');
    });
  }

  // ==================== QR authorization ====================

  /**
   * Start a QR session and resolve once the connector has produced a QR URL.
   * Secrets never leave this object: `pollLogin()` returns them to the manager,
   * which writes them to the 0600 store and then forgets them.
   */
  async requestQrCode(): Promise<{ content: string }> {
    await this.cancelLogin();

    const abort = new AbortController();
    let resolveQr!: (content: string) => void;
    let rejectQr!: (error: Error) => void;
    const qrPromise = new Promise<string>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });

    let resolveCredentials!: (credentials: QQLoginCredentials) => void;
    let rejectCredentials!: (error: Error) => void;
    const credentials = new Promise<QQLoginCredentials>((resolve, reject) => {
      resolveCredentials = resolve;
      rejectCredentials = reject;
    });
    // `requestQrCode()` callers may never touch `credentials`; without this
    // no-op catch a cancelled scan would surface as an unhandled rejection.
    void credentials.catch(() => undefined);
    this.lastLoginCredentials = credentials;

    const session: QrSession = {
      abort,
      dispose: null,
      qrContent: '',
      credentials,
      resolveQr,
      rejectQr,
      rejectCredentials,
      timedOut: false,
      timer: null,
      displayTimer: null,
    };
    this.qrSession = session;
    session.displayTimer = setTimeout(() => {
      if (this.qrSession !== session || session.qrContent) return;
      session.rejectQr(new Error('QQ QR code was not received in time'));
    }, this.qrDisplayTimeoutMs);
    // One timer bounds the WHOLE login (including human scan time), while the
    // connector itself keeps rotating expired QR codes inside that window.
    session.timer = setTimeout(() => {
      if (this.qrSession !== session) return;
      session.timedOut = true;
      this.failQrSession(session, 'timed out waiting for the QR scan');
    }, this.qrLoginTimeoutMs);

    this.status = {
      ...this.status,
      loginPending: true,
      loginState: 'wait',
      qrContent: null,
      lastError: null,
    };
    this.emitStatus();

    const callbacks: QQConnectHandlers = {
      onQrDisplayed: (url) => {
        if (this.qrSession !== session) return;
        session.qrContent = url;
        this.status = { ...this.status, loginPending: true, loginState: 'wait', qrContent: url };
        this.emitStatus();
        session.resolveQr(url);
      },
      onQrExpired: () => {
        if (this.qrSession !== session) return;
        this.status = { ...this.status, loginState: 'expired', qrContent: null };
        this.emitStatus();
        this.emit('login', { state: 'expired', error: null, appId: null } satisfies QQLoginEvent);
      },
      onSuccess: (list) => {
        if (this.qrSession !== session) return;
        const first = Array.isArray(list) ? list[0] : null;
        if (!first || !first.appId || !first.appSecret) {
          this.failQrSession(session, 'QR connector returned no credentials');
          return;
        }
        // Persist immediately: `pollLogin()` is a public path of its own, and a
        // caller that never calls beginLogin() must still get a durable bind.
        this.credentials = first;
        this.credentialSource = 'qr';
        const stored = this.store.saveCredentials(first, {
          accountId: normalizeQQAccountId(first.appId),
          source: 'qr',
          now: this.now(),
        });
        this.config = {
          ...(this.config ?? { enabled: false, appId: '' }),
          enabled: true,
          appId: stored.appId,
          botId: stored.botId,
          ownerUserOpenid: stored.ownerUserOpenid,
        };
        this.clearQrSession(session);
        this.status = {
          ...this.status,
          appId: stored.appId,
          loginPending: false,
          loginState: 'confirmed',
          qrContent: null,
          lastError: null,
        };
        this.emitStatus();
        session.resolveQr(session.qrContent);
        resolveCredentials(first);
      },
      onFailure: (error) => {
        if (this.qrSession !== session) return;
        this.failQrSession(session, this.describeError(error));
      },
    };

    try {
      // `displayQrCodeToConsole: false` — the settings page renders the QR; we do
      // not want the connector printing it into a terminal or a log file.
      session.dispose = await this.connectStarter(callbacks, {
        displayQrCodeToConsole: false,
        source: 'idbots',
        signal: abort.signal,
      });
    } catch (error) {
      const message = this.describeError(error);
      this.clearQrSession(session);
      this.status = { ...this.status, loginPending: false, loginState: 'error', lastError: message };
      this.emitStatus();
      throw new Error(message);
    }

    if (abort.signal.aborted) {
      throw new Error('QQ QR session was cancelled');
    }

    try {
      const content = await Promise.race([qrPromise, credentials.then(() => session.qrContent)]);
      return { content };
    } catch (error) {
      throw new Error(this.describeError(error));
    }
  }

  /** Await the credentials of the pending (or just-finished) QR session. */
  async pollLogin(): Promise<QQLoginCredentials> {
    const pending = this.qrSession?.credentials ?? this.lastLoginCredentials;
    if (!pending) {
      throw new Error('No pending QQ QR login; call requestQrCode() first.');
    }
    return pending;
  }

  /**
   * Settings-page convenience: request the QR, then keep polling in the
   * background and emit `login` events. The AppSecret is written straight into
   * the 0600 store and never crosses the manager boundary.
   */
  async beginLogin(): Promise<{ content: string }> {
    const qr = await this.requestQrCode();
    const session = this.qrSession;
    if (!session) return qr;

    session.credentials
      .then((credentials) => {
        // requestQrCode() already persisted the credential and updated `config`.
        this.emit('login', {
          state: 'confirmed',
          error: null,
          appId: credentials.appId,
        } satisfies QQLoginEvent);
        if (!this.config) return;
        void this.start(this.config).catch((error: Error) => {
          this.status = { ...this.status, connected: false, lastError: this.describeError(error) };
          this.emitStatus();
          this.emitError(error instanceof Error ? error : new Error(this.describeError(error)));
        });
      })
      .catch((error: Error) => {
        if (session.abort.signal.aborted) return;
        this.status = { ...this.status, loginPending: false, loginState: 'error', lastError: this.describeError(error) };
        this.emitStatus();
        this.emit('login', { state: 'error', error: this.describeError(error), appId: null } satisfies QQLoginEvent);
      });

    return qr;
  }

  async cancelLogin(): Promise<void> {
    const session = this.qrSession;
    if (!session) return;
    session.rejectQr(new Error('QQ QR login was cancelled'));
    session.rejectCredentials(new Error('QQ QR login was cancelled'));
    this.clearQrSession(session);
    this.status = { ...this.status, loginPending: false, loginState: 'idle', qrContent: null };
    this.emitStatus();
  }

  /** True while a QR login is still being polled. */
  isLoginPending(): boolean {
    return Boolean(this.qrSession);
  }

  private failQrSession(session: QrSession, reason: string): void {
    session.rejectQr(new Error(reason));
    session.rejectCredentials(new Error(reason));
    this.clearQrSession(session);
    this.status = { ...this.status, loginPending: false, loginState: 'error', lastError: reason };
    this.emitStatus();
    this.emit('login', { state: 'error', error: reason, appId: null } satisfies QQLoginEvent);
  }

  private clearQrSession(session: QrSession): void {
    if (this.qrSession === session) {
      this.qrSession = null;
    }
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (session.displayTimer) clearTimeout(session.displayTimer);
    session.displayTimer = null;
    try {
      session.abort.abort();
    } catch {
      // ignore
    }
    try {
      session.dispose?.();
    } catch {
      // ignore
    }
    session.dispose = null;
  }

  // ==================== Inbound ====================

  private async handleInbound(msg: QQInboundLike): Promise<void> {
    if (!msg) return;

    // ── ONE decision at the entry point ──────────────────────────────────
    // Trust is computed here and only here. Everything downstream (dedupe,
    // media, model turn, tools, memory) reads the frozen context. A gate that
    // throws has already resolved to a silent drop inside qqTrust.
    const decidedAt = this.now();
    const gate = resolveQQMessageGate(msg, this.liveConfig(), decidedAt);
    const isGroup = msg.kind === 'group';
    const groupAudit = isGroup
      ? {
          groupId: gate.groupId ?? (msg.groupOpenid || '').trim(),
          senderId: gate.senderId,
          question: summarizeForAudit(msg.content),
        }
      : null;

    if (gate.action === 'silent-drop') {
      // Strangers in DMs, non-allowlisted groups, other bots: NO reply text.
      // Silence is the security property, not a courtesy.
      //
      // The ONE side effect allowed here: remember the group id so the owner can
      // allow it from the settings page without ever handling the 32-hex id.
      // This is a local list write and nothing else — no model call, no tool,
      // no memory write, no attachment download, and no widening of `gate`.
      // A recorded group stays refused on its next message until the owner
      // actually adds it to `groupAllowlist`.
      if (gate.pendingGroupId) {
        try {
          this.groupCandidates.record(gate.pendingGroupId, decidedAt);
        } catch {
          // Recording is best effort; it must never influence the decision.
        }
      }
      if (groupAudit) {
        this.auditLog.record({
          at: new Date(decidedAt).toISOString(),
          ...groupAudit,
          reply: '',
          outcome: 'dropped',
          trustLevel: gate.trust.level,
          reason: gate.reason,
        });
      }
      this.debugLog('inbound dropped by trust gate', {
        messageId: (msg.messageId || '').trim(),
        level: gate.trust.level,
        reason: gate.reason,
      });
      return;
    }

    const messageId = (msg.messageId || '').trim();
    if (messageId) {
      if (this.isDuplicate(messageId)) return;
      this.markProcessed(messageId);
    }

    const appId = this.credentials?.appId ?? '';
    const decision = qqMentionDecision(msg, appId);
    if (msg.kind === 'group' && !decision.mentioned) {
      this.debugLog('group message ignored (no @mention)', { messageId });
      return;
    }
    if (!decision.mentioned) return;

    const target = qqReplyTarget(msg);
    if (!target) return;
    const conversationId = qqConversationId(target.scope, target.targetId);
    // Cache the reply target BEFORE any outbound send: the refusal notice (and
    // every later reply) resolves its target from this cache.
    this.rememberTarget(conversationId, target);
    this.lastConversationId = conversationId;
    this.status = { ...this.status, lastInboundAt: this.now(), lastError: null };
    this.emitStatus();

    // ── Layer 1 attachment policy (groups: never download) ───────────────
    if (gate.trust.attachmentPolicy === 'reject' && this.hasInboundMedia(msg)) {
      const notice = gate.notice ?? QQ_GROUP_MEDIA_NOTICE;
      try {
        await this.sendText(conversationId, notice);
      } catch (error) {
        this.debugLog('group media refusal could not be delivered', {
          error: this.describeError(error),
        });
      }
      if (groupAudit) {
        this.auditLog.record({
          at: new Date(this.now()).toISOString(),
          ...groupAudit,
          reply: summarizeForAudit(notice),
          outcome: 'static-reply',
          trustLevel: gate.trust.level,
          reason: 'group-media-refused',
        });
      }
      return;
    }

    const collected = await this.collectInboundMedia(msg, conversationId);
    const asr = collected.asrTexts.join(' ').trim();
    const withAsr: QQInboundLike = asr && !(msg.content || '').trim()
      ? { ...msg, content: `[voice] ${asr}` }
      : msg;

    const message = toQQIMMessage(withAsr, {
      appId,
      now: this.now(),
      attachments: collected.attachments,
      failedAttachments: collected.failed,
      mentionedVia: decision.via,
      // Frozen by qqTrust and re-frozen by toQQIMMessage.
      trust: gate.trust,
    });
    if (!message) return;

    this.emit('message', message);

    if (!this.onMessageCallback) return;

    const alreadyBusy = (this.conversationDepth.get(conversationId) ?? 0) > 0;
    if (alreadyBusy) {
      void this.notifyQueue(conversationId);
    }

    await this.enqueueConversation(conversationId, async () => {
      let replySummary = '';
      let outcome: 'answered' | 'error' = 'answered';
      const replyFn = async (text: string): Promise<void> => {
        replySummary = summarizeForAudit(text) || replySummary;
        await this.sendText(conversationId, text);
      };
      await this.withTyping(target, async () => {
        try {
          await this.onMessageCallback!(message, replyFn);
        } catch (error) {
          outcome = 'error';
          this.status = { ...this.status, lastError: this.describeError(error) };
          this.emitStatus();
          this.emitError(error instanceof Error ? error : new Error(this.describeError(error)));
        }
      });
      if (groupAudit) {
        this.auditLog.record({
          at: new Date(this.now()).toISOString(),
          ...groupAudit,
          reply: replySummary,
          outcome,
          trustLevel: gate.trust.level,
          reason: gate.reason,
        });
      }
    });
  }

  /** True when the inbound payload carries at least one media reference. */
  private hasInboundMedia(msg: QQInboundLike): boolean {
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) return true;
    return false;
  }

  private debugLog(message: string, meta?: Record<string, unknown>): void {
    const live = this.liveConfig();
    if (live?.debug) {
      console.log(`[QQ Gateway] ${message}`, meta ?? {});
    }
  }

  private async collectInboundMedia(
    msg: QQInboundLike,
    conversationId: string
  ): Promise<{ attachments: import('./types').IMMediaAttachment[]; failed: number; asrTexts: string[] }> {
    const { refs, skipped, asrTexts } = readQQMediaRefs(msg.attachments);
    if (skipped > 0) {
      console.warn('[QQ Gateway] inbound attachments without a usable https url:', skipped);
    }
    if (refs.length === 0) {
      return { attachments: [], failed: 0, asrTexts };
    }

    const kept = refs.slice(0, QQ_INBOUND_MAX_ATTACHMENTS);
    const overflow = refs.length - kept.length;
    if (overflow > 0) {
      console.warn(`[QQ Gateway] inbound media capped at ${QQ_INBOUND_MAX_ATTACHMENTS}; dropped ${overflow}`);
    }

    const attachments: import('./types').IMMediaAttachment[] = [];
    // `skipped` items had no usable https URL; count them as failures so the
    // message body tells the model something was attached but lost.
    let failed = overflow + skipped;

    for (const ref of kept) {
      try {
        const attachment = await downloadQQMedia(ref, {
          mediaRootDir: this.mediaRootDir,
          conversationId,
          network: this.mediaNetwork,
          now: this.now,
        });
        attachments.push(attachment);
        if (this.config?.debug) {
          console.log('[QQ Gateway] inbound media saved', {
            kind: attachment.type,
            mimeType: attachment.mimeType,
            fileSize: attachment.fileSize,
            fileName: attachment.fileName,
            localPath: attachment.localPath,
          });
        }
      } catch (error) {
        failed += 1;
        console.warn('[QQ Gateway] inbound media failed:', describeQQMediaError(error));
      }
    }

    return { attachments, failed, asrTexts };
  }

  private rememberTarget(conversationId: string, target: QQTarget): void {
    this.targets.set(conversationId, { target: { ...target }, receivedAt: this.now() });
    while (this.targets.size > QQ_TARGET_CACHE_MAX_ENTRIES) {
      const oldest = this.targets.keys().next();
      if (oldest.done) break;
      this.targets.delete(oldest.value);
    }
  }

  /** Resolve the reply target for a conversation, dropping an expired msgId. */
  private resolveTarget(conversationId: string): QQTarget {
    const cached = this.targets.get(conversationId);
    if (!cached) {
      throw new QQProtocolError(`no QQ reply target for conversation ${conversationId}`);
    }
    const age = this.now() - cached.receivedAt;
    if (cached.target.msgId && age > QQ_PASSIVE_REPLY_TTL_MS) {
      // Outside the passive window: degrade to an active push (quota-limited).
      return { scope: cached.target.scope, targetId: cached.target.targetId };
    }
    return { ...cached.target };
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

  // ==================== Per-conversation queue ====================

  private enqueueConversation(conversationId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.conversationQueues.get(conversationId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.conversationQueues.set(conversationId, settled);
    this.conversationDepth.set(conversationId, (this.conversationDepth.get(conversationId) ?? 0) + 1);

    void settled.then(() => {
      const remaining = (this.conversationDepth.get(conversationId) ?? 1) - 1;
      if (remaining <= 0) {
        this.conversationDepth.delete(conversationId);
        if (this.conversationQueues.get(conversationId) === settled) {
          this.conversationQueues.delete(conversationId);
        }
      } else {
        this.conversationDepth.set(conversationId, remaining);
      }
    });

    return next;
  }

  /** Queue depth for one conversation (exposed for tests/diagnostics). */
  getQueueDepth(conversationId: string): number {
    return this.conversationDepth.get(conversationId) ?? 0;
  }

  private async notifyQueue(conversationId: string): Promise<void> {
    const now = this.now();
    const last = this.queueNoticeAt.get(conversationId) ?? 0;
    if (now - last < QUEUE_NOTICE_COOLDOWN_MS) return;
    this.queueNoticeAt.set(conversationId, now);
    try {
      await this.sendText(conversationId, '上一条消息还在处理中，这条已排队，请稍候。');
    } catch {
      // A notice failure must never affect the real reply.
    }
  }

  private async withTyping(target: QQTarget, task: () => Promise<void>): Promise<void> {
    const bot = this.bot;
    if (this.typingIndicator && target.scope === 'c2c' && bot?.sendTyping) {
      try {
        await bot.sendTyping(target, 30);
      } catch {
        // Typing is cosmetic (C2C only per USAGE.md §9.3).
      }
    }
    await task();
  }

  // ==================== Outbound ====================

  async sendText(conversationId: string, text: string): Promise<void> {
    const bot = this.requireBot();
    const chunks = splitQQText(text);
    if (chunks.length === 0) return;

    const target = this.resolveTarget(conversationId);
    for (const chunk of chunks) {
      await bot.sendText(target, chunk);
    }

    this.lastConversationId = conversationId;
    this.status = { ...this.status, lastOutboundAt: this.now(), lastError: null };
    this.emitStatus();
  }

  /**
   * Send one local file. `kind` defaults to an extension-based classification.
   * Images / videos / files go through the SDK's convenience helpers, which
   * switch to the chunked upload path automatically above 5 MB (USAGE.md §10.2).
   */
  async sendMedia(
    conversationId: string,
    filePath: string,
    caption?: string,
    kind?: 'image' | 'video' | 'voice' | 'file'
  ): Promise<void> {
    const bot = this.requireBot();
    const mediaKind = kind ?? classifyQQOutbound(filePath);
    checkQQOutboundFile(filePath, mediaKind);

    const target = this.resolveTarget(conversationId);
    const trimmedCaption = (caption || '').trim() || undefined;

    if (mediaKind === 'image') {
      if (!bot.sendImage) throw new QQMediaError('the QQ SDK client does not implement sendImage');
      await bot.sendImage(target, { localPath: filePath }, trimmedCaption ? { content: trimmedCaption } : undefined);
    } else if (mediaKind === 'video') {
      if (!bot.sendVideo) throw new QQMediaError('the QQ SDK client does not implement sendVideo');
      await bot.sendVideo(target, { localPath: filePath }, trimmedCaption ? { content: trimmedCaption } : undefined);
    } else if (mediaKind === 'voice') {
      if (!bot.sendVoice) throw new QQMediaError('the QQ SDK client does not implement sendVoice');
      await bot.sendVoice(target, { localPath: filePath });
    } else {
      if (!bot.sendFile) throw new QQMediaError('the QQ SDK client does not implement sendFile');
      await bot.sendFile(target, { localPath: filePath }, {
        fileName: path.basename(filePath),
        ...(trimmedCaption ? { content: trimmedCaption } : {}),
      });
    }

    this.lastConversationId = conversationId;
    this.status = { ...this.status, lastOutboundAt: this.now(), lastError: null };
    this.emitStatus();
  }

  /** Push a notification to the most recent conversation. */
  async sendNotification(text: string): Promise<void> {
    const conversationId = this.lastConversationId;
    if (!conversationId) {
      throw new QQProtocolError('no QQ conversation has been seen yet');
    }
    await this.sendText(conversationId, text);
  }

  private requireBot(): QQBotLike {
    if (!this.bot || !this.credentials) {
      throw new QQProtocolError('QQ gateway is not started');
    }
    return this.bot;
  }

  // ==================== Probe ====================

  /**
   * Validate credentials against the official token endpoint
   * (`POST https://bots.qq.com/app/getAppAccessToken`). Returns a message safe
   * to show in the settings UI; never returns or logs the token/secret.
   */
  async probeAuth(timeoutMs = 10_000, configOverride?: Partial<QQConfig>): Promise<string> {
    const config = configOverride ? { ...(this.config ?? { enabled: false, appId: '' }), ...configOverride } : this.config;
    const resolved = this.resolveCredentials(config);
    if (!resolved) throw new Error('QQ credentials are missing');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await this.probeFetch({
        url: `${QQ_DEFAULT_TOKEN_BASE_URL}${QQ_TOKEN_PATH}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: resolved.credentials.appId, clientSecret: resolved.credentials.appSecret }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`QQ token endpoint returned HTTP ${response.status}`);
      }
      const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      if (!data || typeof data.access_token !== 'string' || !data.access_token) {
        throw new Error('QQ token endpoint did not return an access_token');
      }
      return `QQ 鉴权通过（AppID: ${resolved.credentials.appId}）。`;
    } catch (error) {
      throw new Error(redactQQSecrets(this.describeError(error)));
    } finally {
      clearTimeout(timer);
    }
  }

  // ==================== Credentials ====================

  private resolveCredentials(
    config: Partial<QQConfig> | null
  ): { credentials: QQLoginCredentials; source: QQCredentialSource } | null {
    const explicitSecret = (config?.appSecret || '').trim();
    const explicitAppId = (config?.appId || '').trim();
    if (explicitAppId && explicitSecret) {
      return {
        credentials: { appId: explicitAppId, appSecret: explicitSecret, userOpenid: config?.ownerUserOpenid ?? null },
        source: 'manual',
      };
    }

    const slots = [explicitAppId, normalizeQQAccountId(explicitAppId)].filter(Boolean);
    for (const slot of slots) {
      const stored = this.store.loadCredentials(slot);
      if (stored) {
        return {
          credentials: { appId: stored.appId, appSecret: stored.appSecret, userOpenid: stored.ownerUserOpenid },
          source: stored.source,
        };
      }
    }
    return null;
  }

  /** Save manually entered credentials into the 0600 store (never the config table). */
  saveManualCredentials(params: {
    appId: string;
    appSecret: string;
    botId?: string | null;
    ownerUserOpenid?: string | null;
  }): { appId: string; botId: string | null; source: QQCredentialSource } {
    const appId = (params.appId || '').trim();
    const appSecret = (params.appSecret || '').trim();
    if (!appId) throw new Error('AppID is required');
    if (!appSecret) throw new Error('AppSecret is required');
    const stored = this.store.saveCredentials(
      { appId, appSecret, userOpenid: params.ownerUserOpenid ?? null },
      {
        accountId: normalizeQQAccountId(appId),
        botId: params.botId ?? null,
        source: 'manual',
        now: this.now(),
      }
    );
    this.credentials = { appId: stored.appId, appSecret: stored.appSecret, userOpenid: stored.ownerUserOpenid };
    this.credentialSource = 'manual';
    return { appId: stored.appId, botId: stored.botId, source: 'manual' };
  }

  /** Credential-free status for the settings page. */
  credentialSummary(): { hasCredentials: boolean; appId: string | null; source: QQCredentialSource | null } {
    const appId = (this.config?.appId || this.credentials?.appId || '').trim();
    const stored = (appId ? this.store.loadCredentials(normalizeQQAccountId(appId)) : null)
      ?? this.store.loadCredentials();
    return {
      hasCredentials: Boolean(stored || this.credentials),
      appId: stored?.appId ?? this.credentials?.appId ?? null,
      source: stored?.source ?? this.credentialSource,
    };
  }

  // ==================== Diagnostics ====================

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }

  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactQQSecrets(message.slice(0, 300));
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleepImpl(ms, signal);
  }
}

/** Abort-aware sleep used by the supervisor when no test hook is supplied. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exposed for the docs/tests: the resolved account slot name. */
export function qqAccountSlot(appId: string | undefined): string {
  return normalizeQQAccountId(appId);
}
