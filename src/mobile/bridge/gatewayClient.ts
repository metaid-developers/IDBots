/**
 * REQ-E-2 — Gateway client for the C2 gateway protocol (contract version 1).
 *
 * Framework-free WebSocket client usable from the mobile web app (browser
 * WebSocket) and from node tests (injected `WebSocketImpl`). Implements the
 * C2 frame codec, the welcome/version guard, close-code handling, invoke
 * queueing with a 32-in-flight cap, channel-aware client timeouts, ordered
 * event dispatch, keepalive, and exponential-backoff reconnection
 * (1, 2, 4, 8, 16 s, then every 30 s, ±20 % jitter, immediate on network
 * 'online' / foreground).
 *
 * `GatewayConnectionState` is a superset of the UI banner `ConnectionState`
 * in `./types` (owned by the mock-bridge workstream; intentionally not edited
 * here — keep the two compatible by construction). The terminal states
 * (`version-mismatch`, `tenant-unavailable`, `unauthorized`,
 * `too-many-devices`) have no banner of their own: the integration layer maps
 * them to screens (update app / tenant unavailable / navigate to login / too
 * many devices) and to the `offline` banner where a banner is unavoidable.
 *
 * Testability: every time source is injectable — `now`, `random`, `schedule`
 * / `cancel` (timers), `WebSocketImpl`, plus `channelTimeouts`,
 * `timeoutGraceMs`, `offlineTimeoutMs`, `keepaliveIntervalMs` (0 disables the
 * app-level ping), and `maxInFlight`. No DOM globals are touched at module
 * scope; `window`/`document` hooks are registered once in the constructor and
 * only when present, and are removed by `close()`.
 */

/** Contract major version this client speaks (C2 v1). */
export const GATEWAY_CONTRACT_MAJOR = 1;

/** C2 limit: at most this many invokes in flight per socket. */
export const DEFAULT_MAX_IN_FLIGHT = 32;

/** C2 limit: invoke ids are unique per socket and at most 64 chars. */
export const MAX_INVOKE_ID_LENGTH = 64;

/** Invokes made while disconnected wait this long for a connection (C2). */
export const DEFAULT_OFFLINE_TIMEOUT_MS = 15_000;

/** Client-side timeout = channel timeout + this grace window. */
export const DEFAULT_TIMEOUT_GRACE_MS = 10_000;

/** Default app-level ping interval; 0 disables it. */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 25_000;

/** Transport open plus welcome must complete within this window. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** Foreground ping must be answered within this window before reconnecting. */
export const DEFAULT_CONNECTION_PROBE_TIMEOUT_MS = 5_000;

/** C2 default invoke timeout when the channel is not in the map. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 120_000;

/**
 * C2 per-channel timeouts (ms). `default` covers every channel not listed.
 * Merged with (and overridable by) `GatewayClientOptions.channelTimeouts`.
 */
export const DEFAULT_CHANNEL_TIMEOUTS: Readonly<Record<string, number>> = Object.freeze({
  default: DEFAULT_INVOKE_TIMEOUT_MS,
  'idbots:createMetaBotOnChain': 300_000,
  'chainBackup:backup': 900_000,
  'chainBackup:restore': 900_000,
  'gigSquare:sendOrder': 300_000,
});

/** C2 close codes with client-side semantics. */
export const GATEWAY_CLOSE_CODES = {
  UNAUTHORIZED: 4001,
  ORIGIN_NOT_ALLOWED: 4003,
  TOO_MANY_DEVICES: 4009,
  UPGRADING: 4012,
  TENANT_UNAVAILABLE: 4013,
} as const;

/** Reconnection delay for the given 1-based attempt, ±20 % jitter. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = safeAttempt <= 5 ? 1_000 * 2 ** (safeAttempt - 1) : 30_000;
  const factor = 0.8 + random() * 0.4;
  return Math.round(base * factor);
}

function parseContractMajor(version: string): number | null {
  const match = /^(\d+)/.exec(version ?? '');
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Frames (C2 §Frames)
// ---------------------------------------------------------------------------

export interface GatewayErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WelcomeFrame {
  v: 1;
  type: 'welcome';
  contractVersion: string;
  appVersion: string;
  tenantId: string;
  serverTime: number;
  ready: boolean;
  phase: string;
}

export interface InvokeFrame {
  v: 1;
  type: 'invoke';
  id: string;
  channel: string;
  args: unknown[];
}

export type ResultFrame =
  | { v: 1; type: 'result'; id: string; ok: true; value: unknown }
  | { v: 1; type: 'result'; id: string; ok: false; error: GatewayErrorShape };

export interface EventFrame {
  v: 1;
  type: 'event';
  channel: string;
  args: unknown[];
}

export interface PingFrame {
  v: 1;
  type: 'ping';
  ts: number;
}

export interface PongFrame {
  v: 1;
  type: 'pong';
  ts: number;
}

// ---------------------------------------------------------------------------
// Transport abstraction (browser WebSocket and test fakes both satisfy it)
// ---------------------------------------------------------------------------

export interface WebSocketCloseEvent {
  code: number;
  reason: string;
}

export interface WebSocketMessageEvent {
  data: unknown;
}

/** Structural subset of the browser WebSocket this client relies on. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: (() => void) | null;
}

export type WebSocketLikeConstructor = new (url: string) => WebSocketLike;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

function defaultWebSocketConstructor(): WebSocketLikeConstructor {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof candidate !== 'function') {
    throw new Error('GatewayClient: no global WebSocket available; pass WebSocketImpl');
  }
  return candidate as WebSocketLikeConstructor;
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Connection lifecycle states. The first five mirror the UI banner's
 * `ConnectionState` in `./types`; the rest are terminal states with their own
 * screens. See the file docblock for the mapping contract.
 */
export type GatewayConnectionState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'upgrading'
  | 'version-mismatch'
  | 'tenant-unavailable'
  | 'unauthorized'
  | 'too-many-devices';

const TERMINAL_STATES: ReadonlyArray<GatewayConnectionState> = [
  'version-mismatch',
  'tenant-unavailable',
  'unauthorized',
  'too-many-devices',
];

/** Payload of the first-frame `welcome`, exposed to the UI (REQ-E-2). */
export interface GatewayServerInfo {
  contractVersion: string;
  appVersion: string;
  tenantId: string;
  serverTime: number;
  ready: boolean;
  phase: string;
}

/** Populated when the server's contract major differs from the client's. */
export interface GatewayVersionMismatch {
  expected: number;
  actual: string;
}

/** Last socket close, for UI messages ("your Bot is not available" …). */
export interface GatewayCloseInfo {
  code: number;
  reason: string;
}

/** Rejection produced by `invoke` for gateway/client level failures. */
export interface GatewayInvokeError extends Error {
  code: string;
  retryable: boolean;
}

function codedError(code: string, message: string, retryable: boolean): GatewayInvokeError {
  const error = new Error(message) as GatewayInvokeError;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export interface GatewayLogger {
  warn(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export interface GatewayClientOptions {
  /** WebSocket URL, e.g. wss://app.example.com/ws (C2 over /ws). */
  url: string;
  /** Defaults to the global `WebSocket`, resolved lazily at connect time. */
  WebSocketImpl?: WebSocketLikeConstructor;
  /** Clock for timestamps. Defaults to Date.now. */
  now?: () => number;
  /** [0, 1) random source for jitter and invoke ids. Defaults to Math.random. */
  random?: () => number;
  /** Timer scheduler. Defaults to setTimeout. */
  schedule?: (fn: () => void, delayMs: number) => unknown;
  /** Cancels a handle returned by `schedule`. Defaults to clearTimeout. */
  cancel?: (handle: unknown) => void;
  logger?: GatewayLogger;
  /** Overrides/extends DEFAULT_CHANNEL_TIMEOUTS (channel → ms). */
  channelTimeouts?: Record<string, number>;
  /** Added to the channel timeout for the client-side deadline. Default 10 s. */
  timeoutGraceMs?: number;
  /** How long queued invokes wait for a connection. Default 15 s. */
  offlineTimeoutMs?: number;
  /** App-level ping interval. Default 25 s; 0 disables. */
  keepaliveIntervalMs?: number;
  /** Transport open plus welcome deadline. Default 10 s. */
  connectionTimeoutMs?: number;
  /** Foreground health probe deadline. Default 5 s. */
  connectionProbeTimeoutMs?: number;
  /** In-flight cap. Default 32 (C2). */
  maxInFlight?: number;
  /** Expected contract major. Default 1. */
  expectedContractMajor?: number;
}

interface PendingInvoke {
  id: string;
  channel: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: unknown;
  offlineHandle: unknown;
}

// ---------------------------------------------------------------------------
// GatewayClient
// ---------------------------------------------------------------------------

export class GatewayClient {
  private readonly url: string;
  private readonly WS: WebSocketLikeConstructor;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly scheduleFn: (fn: () => void, delayMs: number) => unknown;
  private readonly cancelFn: (handle: unknown) => void;
  private readonly logger: GatewayLogger | undefined;
  private readonly channelTimeouts: Record<string, number>;
  private readonly timeoutGraceMs: number;
  private readonly offlineTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly connectionProbeTimeoutMs: number;
  private readonly maxInFlight: number;
  private readonly expectedMajor: number;

  private ws: WebSocketLike | null = null;
  private state: GatewayConnectionState = 'connecting';
  private serverInfo: GatewayServerInfo | null = null;
  private versionMismatch: GatewayVersionMismatch | null = null;
  private lastClose: GatewayCloseInfo | null = null;
  private hasConnected = false;
  private reconnectAttempts = 0;
  private reconnectHandle: unknown;
  private keepaliveHandle: unknown;
  private connectionHandle: unknown;
  private connectionProbeHandle: unknown;
  private closed = false;
  private invokeCounter = 0;

  private readonly inFlight = new Map<string, PendingInvoke>();
  private readonly queue: PendingInvoke[] = [];
  private readonly stateListeners = new Set<(state: GatewayConnectionState) => void>();
  private readonly reconnectedListeners = new Set<(info: GatewayServerInfo) => void>();
  private readonly eventListeners = new Map<string, Set<(args: unknown[]) => void>>();
  private readonly anyEventListeners = new Set<(channel: string, args: unknown[]) => void>();
  private readonly domUnsubscribers: Array<() => void> = [];

  constructor(options: GatewayClientOptions) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0) {
      throw new Error('GatewayClient: url is required');
    }
    this.url = options.url;
    this.WS = options.WebSocketImpl ?? defaultWebSocketConstructor();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.scheduleFn = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelFn = options.cancel ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
    this.logger = options.logger;
    this.channelTimeouts = { ...DEFAULT_CHANNEL_TIMEOUTS, ...(options.channelTimeouts ?? {}) };
    this.timeoutGraceMs = options.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;
    this.offlineTimeoutMs = options.offlineTimeoutMs ?? DEFAULT_OFFLINE_TIMEOUT_MS;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.connectionProbeTimeoutMs = options.connectionProbeTimeoutMs ?? DEFAULT_CONNECTION_PROBE_TIMEOUT_MS;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.expectedMajor = options.expectedContractMajor ?? GATEWAY_CONTRACT_MAJOR;
    this.registerDomHooks();
    this.openSocket();
  }

  // -- queries --------------------------------------------------------------

  getState(): GatewayConnectionState {
    return this.state;
  }

  isOnline(): boolean {
    return this.state === 'online';
  }

  getServerInfo(): GatewayServerInfo | null {
    return this.serverInfo ? { ...this.serverInfo } : null;
  }

  getVersionMismatch(): GatewayVersionMismatch | null {
    return this.versionMismatch ? { ...this.versionMismatch } : null;
  }

  getLastClose(): GatewayCloseInfo | null {
    return this.lastClose ? { ...this.lastClose } : null;
  }

  /** Number of invokes currently sent and awaiting a result. */
  getInFlightCount(): number {
    return this.inFlight.size;
  }

  /** Number of invokes queued but not yet sent. */
  getQueuedCount(): number {
    return this.queue.length;
  }

  // -- subscriptions ----------------------------------------------------------

  /** Fires on every state transition; returns an unsubscribe function. */
  onStateChange(callback: (state: GatewayConnectionState) => void): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * Fires after EVERY successful (re)connect, the first connect included;
   * the callback receives the `welcome` server info. Callers that only want
   * reconnects (REQ-E-5 resync) must track "first fire happened" themselves
   * or compare `serverInfo` — this hook deliberately does not skip the first
   * connect so a unified "connection ready" path exists.
   */
  onReconnected(callback: (info: GatewayServerInfo) => void): () => void {
    this.reconnectedListeners.add(callback);
    return () => {
      this.reconnectedListeners.delete(callback);
    };
  }

  /** Subscribes to C2 event frames for one channel; returns unsubscribe. */
  onEvent(channel: string, callback: (args: unknown[]) => void): () => void {
    let listeners = this.eventListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(channel, listeners);
    }
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) {
        this.eventListeners.delete(channel);
      }
    };
  }

  /** Subscribes to every C2 event frame; returns unsubscribe. */
  onAnyEvent(callback: (channel: string, args: unknown[]) => void): () => void {
    this.anyEventListeners.add(callback);
    return () => {
      this.anyEventListeners.delete(callback);
    };
  }

  // -- invokes ----------------------------------------------------------------

  /**
   * Invokes a C2 channel. Resolves with the raw handler value — `{ success:
   * false }` envelopes pass through unchanged (they are successful Results).
   * Rejects with a plain `Error` for `HANDLER_ERROR` (ipcRenderer parity, no
   * `code` property), otherwise with a `GatewayInvokeError` carrying the C2
   * code and `retryable`.
   */
  invoke<TValue = unknown>(channel: string, ...args: unknown[]): Promise<TValue> {
    return new Promise<TValue>((resolve, reject) => {
      const pending: PendingInvoke = {
        id: this.nextInvokeId(),
        channel,
        args,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutHandle: undefined,
        offlineHandle: undefined,
      };
      if (this.closed || this.isTerminalState(this.state)) {
        reject(
          codedError('OFFLINE', `gateway client is "${this.state}"; invoke "${channel}" is not possible`, false),
        );
        return;
      }
      this.queue.push(pending);
      if (this.state !== 'online') {
        // Wait for a connection (up to offlineTimeoutMs), then reject OFFLINE.
        pending.offlineHandle = this.scheduleFn(() => {
          pending.offlineHandle = undefined;
          this.removeFromQueue(pending);
          reject(
            codedError('OFFLINE', `no connection within ${this.offlineTimeoutMs} ms for invoke "${channel}"`, true),
          );
        }, this.offlineTimeoutMs);
      }
      this.flushQueue();
    });
  }

  /** Client-side deadline for a channel: channel timeout + grace. */
  timeoutForChannel(channel: string): number {
    return (this.channelTimeouts[channel] ?? this.channelTimeouts.default ?? DEFAULT_INVOKE_TIMEOUT_MS) + this.timeoutGraceMs;
  }

  // -- connection control -------------------------------------------------------

  /**
   * Immediate foreground recovery: coalesces an in-flight attempt, probes an
   * apparently online socket and replaces it only when unanswered. Otherwise
   * cancels pending backoff and opens a fresh socket. No-op when closed or in
   * a terminal state. Called by DOM and native lifecycle hooks.
   */
  reconnectNow(): void {
    if (this.closed || this.isTerminalState(this.state)) {
      return;
    }
    if (this.state === 'online') {
      if (this.connectionProbeHandle !== undefined) return;
      if (this.ws?.readyState === WS_OPEN && this.sendJson({ v: 1, type: 'ping', ts: this.now() } satisfies PingFrame)) {
        this.connectionProbeHandle = this.scheduleFn(() => {
          this.connectionProbeHandle = undefined;
          this.replaceSocket('foreground health probe timed out');
        }, this.connectionProbeTimeoutMs);
        return;
      }
    }
    if (this.ws?.readyState === WS_CONNECTING) {
      return;
    }
    this.replaceSocket('reconnectNow');
  }

  /** Tears down timers, listeners, and the socket. Terminal: state 'offline'. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelReconnect();
    this.cancelConnectionTimeout();
    this.cancelConnectionProbe();
    this.stopKeepalive();
    for (const unsubscribe of this.domUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Listener teardown must never throw.
      }
    }
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close(1000, 'client closed');
      } catch {
        // Ignore transport errors during teardown.
      }
    }
    this.rejectInFlight('CONNECTION_LOST', true, 'gateway client closed');
    this.rejectQueued('OFFLINE', false, 'gateway client closed');
    this.setState('offline');
  }

  // -- internals ----------------------------------------------------------------

  private replaceSocket(reason: string): void {
    this.cancelReconnect();
    this.cancelConnectionTimeout();
    this.cancelConnectionProbe();
    this.stopKeepalive();
    const previous = this.ws;
    this.ws = null;
    this.setState(this.hasConnected ? 'reconnecting' : 'connecting');
    if (previous) {
      this.rejectInFlight('CONNECTION_LOST', true, reason);
      if (previous.readyState !== WS_CLOSED) {
        try {
          previous.close(1000, reason);
        } catch {
          // Ignore transport errors while replacing the socket.
        }
      }
    }
    this.openSocket();
  }

  private isTerminalState(state: GatewayConnectionState): boolean {
    return TERMINAL_STATES.includes(state);
  }

  private setState(state: GatewayConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch (err) {
        this.logWarn('onStateChange listener failed', err);
      }
    }
  }

  private nextInvokeId(): string {
    this.invokeCounter += 1;
    const suffix = Math.floor(this.random() * 0xffffffff).toString(16);
    const id = `${this.invokeCounter.toString(36)}-${suffix}`;
    return id.length <= MAX_INVOKE_ID_LENGTH ? id : id.slice(0, MAX_INVOKE_ID_LENGTH);
  }

  private removeFromQueue(pending: PendingInvoke): void {
    const index = this.queue.indexOf(pending);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private timeoutFor(channel: string): number {
    return this.channelTimeouts[channel] ?? this.channelTimeouts.default ?? DEFAULT_INVOKE_TIMEOUT_MS;
  }

  private flushQueue(): void {
    while (this.state === 'online' && this.inFlight.size < this.maxInFlight && this.queue.length > 0) {
      const pending = this.queue.shift();
      if (!pending) {
        break;
      }
      if (pending.offlineHandle !== undefined) {
        this.cancelFn(pending.offlineHandle);
        pending.offlineHandle = undefined;
      }
      // An unusable socket requeues the invoke; stop draining so this loop
      // cannot spin while the client is still marked online.
      if (!this.sendPending(pending)) break;
    }
  }

  private sendPending(pending: PendingInvoke): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      // Socket not usable (e.g. racing a close): keep it queued for the
      // next connection. Queued-not-yet-sent invokes carry over this way.
      this.queue.unshift(pending);
      return false;
    }
    let payload: string;
    try {
      payload = JSON.stringify({ v: 1, type: 'invoke', id: pending.id, channel: pending.channel, args: pending.args });
    } catch (err) {
      pending.reject(new Error(`invoke "${pending.channel}" args are not JSON-serializable: ${String(err)}`));
      return true;
    }
    try {
      ws.send(payload);
    } catch (err) {
      this.queue.unshift(pending);
      this.logWarn('gateway send failed', err);
      return false;
    }
    this.inFlight.set(pending.id, pending);
    const timeoutMs = this.timeoutFor(pending.channel) + this.timeoutGraceMs;
    pending.timeoutHandle = this.scheduleFn(() => {
      pending.timeoutHandle = undefined;
      if (this.inFlight.delete(pending.id)) {
        pending.reject(
          codedError('TIMEOUT', `invoke "${pending.channel}" timed out after ${timeoutMs} ms`, true),
        );
      }
      this.flushQueue();
    }, timeoutMs);
    return true;
  }

  private rejectInFlight(code: string, retryable: boolean, reason: string): void {
    for (const pending of this.inFlight.values()) {
      if (pending.timeoutHandle !== undefined) {
        this.cancelFn(pending.timeoutHandle);
        pending.timeoutHandle = undefined;
      }
      // In-flight invokes are NEVER auto-retried: non-idempotent channels
      // (orders, posts, payments) exist, so the caller decides what to retry.
      pending.reject(codedError(code, `${reason}; invoke "${pending.channel}" (${pending.id})`, retryable));
    }
    this.inFlight.clear();
  }

  private rejectQueued(code: string, retryable: boolean, reason: string): void {
    for (const pending of this.queue.splice(0)) {
      if (pending.offlineHandle !== undefined) {
        this.cancelFn(pending.offlineHandle);
        pending.offlineHandle = undefined;
      }
      pending.reject(codedError(code, `${reason}; invoke "${pending.channel}"`, retryable));
    }
  }

  private sendJson(frame: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      return false;
    }
    let payload: string;
    try {
      payload = JSON.stringify(frame);
    } catch {
      return false;
    }
    try {
      ws.send(payload);
      return true;
    } catch (err) {
      this.logWarn('gateway send failed', err);
      return false;
    }
  }

  // -- socket lifecycle ---------------------------------------------------------

  private openSocket(): void {
    if (this.closed || this.isTerminalState(this.state) || (this.ws && this.ws.readyState !== WS_CLOSED)) {
      return;
    }
    this.cancelReconnect();
    this.cancelConnectionTimeout();
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.logWarn('gateway socket construction failed', err);
      this.setState(this.hasConnected ? 'reconnecting' : 'connecting');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      // Nothing to send yet: the server opens with a `welcome` frame and the
      // version guard gates everything until then.
    };
    ws.onmessage = (event) => {
      this.handleRawMessage(ws, event ? event.data : undefined);
    };
    ws.onclose = (event) => {
      const code = event && typeof event.code === 'number' ? event.code : 1001;
      const reason = event && typeof event.reason === 'string' ? event.reason : '';
      this.handleClose(ws, code, reason);
    };
    ws.onerror = () => {
      // The close event that follows drives the reconnect path.
    };
    if (this.connectionTimeoutMs > 0) {
      this.connectionHandle = this.scheduleFn(() => {
        this.connectionHandle = undefined;
        if (this.ws !== ws) return;
        try {
          ws.close(1000, 'connection timeout');
        } catch {
          // The explicit close below still drives recovery.
        }
        this.handleClose(ws, 1006, 'connection timeout');
      }, this.connectionTimeoutMs);
    }
  }

  private handleClose(ws: WebSocketLike, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.cancelConnectionTimeout();
    this.cancelConnectionProbe();
    this.stopKeepalive();
    if (this.closed) {
      return;
    }
    this.lastClose = { code, reason };
    this.rejectInFlight('CONNECTION_LOST', true, `connection closed with code ${code}`);
    if (code === GATEWAY_CLOSE_CODES.UNAUTHORIZED || code === GATEWAY_CLOSE_CODES.ORIGIN_NOT_ALLOWED) {
      // 4003 (origin not allowed) behaves like 4001 for the UI: re-login.
      this.enterTerminal('unauthorized');
    } else if (code === GATEWAY_CLOSE_CODES.TOO_MANY_DEVICES) {
      this.enterTerminal('too-many-devices');
    } else if (code === GATEWAY_CLOSE_CODES.TENANT_UNAVAILABLE) {
      this.enterTerminal('tenant-unavailable');
    } else if (code === GATEWAY_CLOSE_CODES.UPGRADING) {
      // Banner state; keep reconnecting below and stay 'upgrading' (not
      // 'reconnecting') so the UI keeps showing "updating" until 'online'.
      this.setState('upgrading');
      this.scheduleReconnect();
    } else {
      // 1000/1001 and network drops: normal reconnect flow. The state stays
      // 'connecting' until the first successful connect so the UI can tell a
      // first connect from a reconnect.
      this.setState(this.hasConnected ? 'reconnecting' : 'connecting');
      this.scheduleReconnect();
    }
  }

  private enterTerminal(state: GatewayConnectionState): void {
    this.setState(state);
    this.rejectQueued('OFFLINE', false, `gateway client entered "${state}"`);
    this.cancelReconnect();
    this.cancelConnectionTimeout();
    this.cancelConnectionProbe();
    this.stopKeepalive();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.isTerminalState(this.state) || this.ws) {
      return;
    }
    this.cancelReconnect();
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = reconnectDelayMs(attempt, this.random);
    this.reconnectHandle = this.scheduleFn(() => {
      this.reconnectHandle = undefined;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle !== undefined) {
      this.cancelFn(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
  }

  private cancelConnectionTimeout(): void {
    if (this.connectionHandle !== undefined) {
      this.cancelFn(this.connectionHandle);
      this.connectionHandle = undefined;
    }
  }

  private cancelConnectionProbe(): void {
    if (this.connectionProbeHandle !== undefined) {
      this.cancelFn(this.connectionProbeHandle);
      this.connectionProbeHandle = undefined;
    }
  }

  // -- inbound frames -------------------------------------------------------------

  private handleRawMessage(ws: WebSocketLike, data: unknown): void {
    if (this.ws !== ws) return;
    const text = typeof data === 'string' ? data : String(data);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      // The server only sends INVALID_FRAME for client frames; inbound junk
      // is ignored (C2).
      return;
    }
    if (!frame || typeof frame !== 'object') {
      return;
    }
    const record = frame as Record<string, unknown>;
    switch (record.type) {
      case 'welcome':
        this.handleWelcome(record);
        break;
      case 'result':
        this.handleResult(record);
        break;
      case 'event':
        this.handleEventFrame(record);
        break;
      case 'ping':
        this.handlePing(record);
        break;
      case 'pong':
        this.cancelConnectionProbe();
        break;
      default:
        break;
    }
  }

  private handleWelcome(frame: Record<string, unknown>): void {
    if (
      typeof frame.contractVersion !== 'string' ||
      typeof frame.appVersion !== 'string' ||
      typeof frame.tenantId !== 'string' ||
      typeof frame.ready !== 'boolean' ||
      typeof frame.phase !== 'string'
    ) {
      return; // Missing required fields: ignore (C2).
    }
    const major = parseContractMajor(frame.contractVersion);
    if (major === null || major !== this.expectedMajor) {
      this.versionMismatch = { expected: this.expectedMajor, actual: frame.contractVersion };
      this.setState('version-mismatch');
      this.rejectQueued('OFFLINE', false, 'gateway contract version mismatch');
      const socket = this.ws;
      this.ws = null;
      this.cancelConnectionTimeout();
      this.cancelConnectionProbe();
      this.stopKeepalive();
      try {
        socket?.close(1000, 'version mismatch');
      } catch {
        // Ignore transport errors during teardown.
      }
      return;
    }
    this.serverInfo = {
      contractVersion: frame.contractVersion,
      appVersion: frame.appVersion,
      tenantId: frame.tenantId,
      serverTime: typeof frame.serverTime === 'number' ? frame.serverTime : this.now(),
      ready: frame.ready,
      phase: frame.phase,
    };
    this.hasConnected = true;
    this.reconnectAttempts = 0;
    this.cancelReconnect();
    this.cancelConnectionTimeout();
    this.cancelConnectionProbe();
    this.setState('online');
    this.startKeepalive();
    const info = this.getServerInfo() as GatewayServerInfo;
    for (const listener of [...this.reconnectedListeners]) {
      try {
        listener(info);
      } catch (err) {
        this.logWarn('onReconnected listener failed', err);
      }
    }
    this.flushQueue();
  }

  private handleResult(frame: Record<string, unknown>): void {
    if (typeof frame.id !== 'string' || typeof frame.ok !== 'boolean') {
      return;
    }
    const pending = this.inFlight.get(frame.id);
    if (!pending) {
      return;
    }
    this.inFlight.delete(frame.id);
    if (pending.timeoutHandle !== undefined) {
      this.cancelFn(pending.timeoutHandle);
      pending.timeoutHandle = undefined;
    }
    if (frame.ok) {
      pending.resolve(frame.value); // Raw passthrough, incl. { success: false }.
    } else {
      const error = frame.error;
      const code = error && typeof error === 'object' ? (error as GatewayErrorShape).code : undefined;
      const message =
        error && typeof error === 'object' && typeof (error as GatewayErrorShape).message === 'string'
          ? (error as GatewayErrorShape).message
          : 'gateway invoke failed';
      const retryable = error && typeof error === 'object' ? (error as GatewayErrorShape).retryable === true : false;
      if (code === 'HANDLER_ERROR') {
        // ipcRenderer.invoke parity: a plain Error with the handler message and
        // NO code property, so renderer code that checks `err.code` behaves the
        // same on mobile.
        pending.reject(new Error(message));
      } else {
        pending.reject(codedError(typeof code === 'string' ? code : 'HANDLER_ERROR', message, retryable));
      }
    }
    this.flushQueue();
  }

  private handleEventFrame(frame: Record<string, unknown>): void {
    if (typeof frame.channel !== 'string' || !Array.isArray(frame.args)) {
      return;
    }
    const listeners = this.eventListeners.get(frame.channel);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(frame.args);
        } catch (err) {
          this.logWarn('onEvent listener failed', err);
        }
      }
    }
    for (const listener of [...this.anyEventListeners]) {
      try {
        listener(frame.channel, frame.args);
      } catch (err) {
        this.logWarn('onAnyEvent listener failed', err);
      }
    }
  }

  private handlePing(frame: Record<string, unknown>): void {
    const ts = typeof frame.ts === 'number' ? frame.ts : this.now();
    this.sendJson({ v: 1, type: 'pong', ts } satisfies PongFrame);
  }

  // -- keepalive --------------------------------------------------------------------

  private startKeepalive(): void {
    this.stopKeepalive();
    if (this.closed || this.keepaliveIntervalMs <= 0) {
      return;
    }
    const tick = (): void => {
      this.sendJson({ v: 1, type: 'ping', ts: this.now() } satisfies PingFrame);
      this.keepaliveHandle = this.scheduleFn(tick, this.keepaliveIntervalMs);
    };
    this.keepaliveHandle = this.scheduleFn(tick, this.keepaliveIntervalMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveHandle !== undefined) {
      this.cancelFn(this.keepaliveHandle);
      this.keepaliveHandle = undefined;
    }
  }

  // -- DOM hooks -----------------------------------------------------------------------

  private readonly handleWindowOnline = (): void => {
    this.reconnectNow();
  };

  private readonly handleWindowOffline = (): void => {
    if (!this.closed && !this.isTerminalState(this.state)) {
      this.setState('offline');
    }
  };

  private readonly handleVisibilityChange = (): void => {
    const doc = (globalThis as { document?: { visibilityState?: string } }).document;
    if (!doc || doc.visibilityState === undefined || doc.visibilityState === 'visible') {
      this.reconnectNow();
    }
  };

  private registerDomHooks(): void {
    const g = globalThis as {
      window?: {
        addEventListener?: (type: string, callback: () => void) => void;
        removeEventListener?: (type: string, callback: () => void) => void;
      };
      document?: {
        addEventListener?: (type: string, callback: () => void) => void;
        removeEventListener?: (type: string, callback: () => void) => void;
      };
    };
    if (g.window?.addEventListener && g.window.removeEventListener) {
      g.window.addEventListener('online', this.handleWindowOnline);
      g.window.addEventListener('offline', this.handleWindowOffline);
      this.domUnsubscribers.push(() => {
        g.window?.removeEventListener?.('online', this.handleWindowOnline);
        g.window?.removeEventListener?.('offline', this.handleWindowOffline);
      });
    }
    if (g.document?.addEventListener && g.document.removeEventListener) {
      g.document.addEventListener('visibilitychange', this.handleVisibilityChange);
      this.domUnsubscribers.push(() => {
        g.document?.removeEventListener?.('visibilitychange', this.handleVisibilityChange);
      });
    }
  }

  private logWarn(...args: unknown[]): void {
    try {
      this.logger?.warn('[gatewayClient]', ...args);
    } catch {
      // Logging must never break the client.
    }
  }
}
