/**
 * C2 gateway server — the runnable WebSocket + HTTP front end of the mobile
 * gateway (REQ-A-15..REQ-A-22). Composes the pure core modules (protocol,
 * tokens, restrictions, fileSign, upload, readiness, allowlist) with the ws
 * socket and a node:http server.
 *
 * Every platform dependency is injected through GatewayOptions, so this
 * module never imports electron and is fully testable from plain node
 * (tests/gatewayServer.test.mjs starts it with fake deps on an ephemeral
 * port). Electron-facing assembly lives in wiring.ts.
 *
 * Contract: docs/cloud-mobile/01-interface-contracts.md, C2 (and the C1
 * "HTTP Endpoints" table for /healthz, /readyz, and the HTTP routes).
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_INVOKE_TIMEOUT_MS,
  lookupEventChannel,
  lookupInvokeChannel,
  type AllowlistEntry,
} from './allowlist';
import {
  INBOUND_FRAME_MAX_BYTES,
  INVOKE_RATE_BURST,
  INVOKE_RATE_PER_SEC,
  MAX_IN_FLIGHT_INVOKES,
  OUTBOUND_FRAME_MAX_BYTES,
  encodeFrame,
  makeError,
  makeResultError,
  makeResultOk,
  parseInboundFrame,
  type GatewayError,
  type Result,
} from './protocol';
import {
  mergeAppConfigSet,
  redactAppConfig,
  validateInvokeRestrictions,
  type GatewayPaths,
} from './restrictions';
import { mimeForPath } from './fileSign';
import {
  UPLOAD_MAX_BYTES,
  isBlockedUploadType,
  uploadTargetPath,
} from './upload';
import { buildReadinessResponse, type ReadinessState } from './readiness';
import { NonceStore, verifyFileToken, verifyReverifyToken } from './tokens';
import { sanitizeIpcPayload } from '../ipc/sanitize';

// ---------------------------------------------------------------------------
// Limits (C2 "Limits", "Transport and Authentication", "Keepalive")
// ---------------------------------------------------------------------------

/** C2: "The tenant accepts at most 3 concurrent client sockets." */
const MAX_CLIENT_SOCKETS = 3;
/** C2 keepalive: server ping every 25 s; socket without pong within 60 s dies. */
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
/**
 * ws hard-closes a socket whose frame exceeds `maxPayload`, which conflicts
 * with the C2 rule "larger → PAYLOAD_TOO_LARGE, socket stays open". ws offers
 * no per-frame intercept hook, so the socket-level ceiling is set above the
 * C2 limit and the exact 1 MiB check is enforced on the received message
 * bytes in the message handler instead.
 */
const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Phases in which only the bootstrap-whitelisted channels may run (C2). */
const NOT_READY_PHASES = new Set(['starting', 'migrating', 'bootstrapping']);
/** Channels allowed while the tenant is not ready (C2 readiness gate). */
const NOT_READY_ALLOWED_CHANNELS = new Set(['mobile:bootstrap:status', 'app:getVersion']);

export const GATEWAY_WS_PATH = '/gateway/v1/ws';
export const GATEWAY_FILES_PATH_PREFIX = '/gateway/v1/files';
export const GATEWAY_UPLOAD_PATH = '/gateway/v1/upload';
export const GATEWAY_SENSITIVE_REVEAL_MNEMONIC_PATH = '/gateway/v1/sensitive/reveal-mnemonic';
export const APP_BUNDLE_PATH_PREFIX = '/app';

/** Close code 4012 per C2 "server restarting or upgrading". */
const CLOSE_SERVER_SHUTDOWN = 4012;
/** Close code 4009 per C2 "too many clients". */
const CLOSE_TOO_MANY_CLIENTS = 4009;

// ---------------------------------------------------------------------------
// Options / handle
// ---------------------------------------------------------------------------

export interface GatewayOptions {
  host: string;
  port: number;
  /** IDBOTS_GATEWAY_SECRET — never logged. */
  secret: string;
  /** Logged with every line. */
  tenantId: string;
  /** Highest enabled allowlist tier (02). */
  tier: 'P1' | 'P2';
  contractVersion: string;
  appVersion: string;
  commit: string;
  paths: GatewayPaths;
  /** dist-mobile directory; absent → /app/* answers 404. */
  staticBundleDir?: string;
  readiness: () => ReadinessState;
  invokeHandler: (channel: string, clientId: string, args: unknown[]) => Promise<unknown>;
  hasHandler: (channel: string) => boolean;
  addBroadcastListener: (listener: (channel: string, args: unknown[]) => void) => () => void;
  /** store:get accessor for the R-store set-merge; without it store:set is dispatched unmerged. */
  storeGet?: (key: string) => unknown;
  revealMnemonic: (target: { target: 'user' } | { target: 'metabot'; metabotId: number }) => Promise<string>;
  logger?: (level: 'info' | 'warn' | 'error', component: string, msg: string, extra?: Record<string, unknown>) => void;
  /** Test hook: overrides the default 120 s invoke timeout for channels without an entry. */
  defaultTimeoutMs?: number;
  /**
   * Conformance-only (IDBOTS_GATEWAY_TEST_HOOKS=1): registers the virtual
   * `__test:sleep` channel so the conformance kit can force a real invoke
   * timeout. Never enabled in production; not part of the frozen allowlist.
   */
  enableTestHooks?: boolean;
  /** Timeout applied to `__test:sleep` (default 1500 ms) to keep the kit fast. */
  testSleepTimeoutMs?: number;
}

export interface GatewayHandle {
  /** The actual bound port (differs from options.port when port 0 was given). */
  port: number;
  close: (opts?: { code?: number; reason?: string }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type LogLevel = 'info' | 'warn' | 'error';

function makeLogger(options: GatewayOptions): NonNullable<GatewayOptions['logger']> {
  if (options.logger) return options.logger;
  return (level, component, msg, extra) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tenant: options.tenantId, component, msg, ...extra });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/** Constant-time header comparison; never throws on malformed input. */
function secretMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readRequestSecret(req: http.IncomingMessage): string | undefined {
  const value = req.headers['x-idbots-gateway-secret'];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendEmpty(res: http.ServerResponse, status: number, headers?: Record<string, string>): void {
  res.writeHead(status, headers);
  res.end();
}

// ---------------------------------------------------------------------------
// Per-socket state
// ---------------------------------------------------------------------------

interface ClientSocketState {
  ws: WebSocket;
  clientId: string;
  inFlight: number;
  bucketTokens: number;
  bucketRefillAt: number;
  lastPongAt: number;
  pingTimer: NodeJS.Timeout | null;
}

/** Token bucket (C2 "Limits": 50 per second, burst 100). */
function bucketAllow(state: ClientSocketState, now: number): boolean {
  const elapsedMs = now - state.bucketRefillAt;
  if (elapsedMs > 0) {
    state.bucketTokens = Math.min(INVOKE_RATE_BURST, state.bucketTokens + (elapsedMs * INVOKE_RATE_PER_SEC) / 1000);
    state.bucketRefillAt = now;
  }
  if (state.bucketTokens < 1) return false;
  state.bucketTokens -= 1;
  return true;
}

/**
 * Best-effort id extraction so malformed (or oversized) frames can still be
 * answered with a result error the client can match; null when no id exists.
 */
function errorResultForRawFrame(rawText: string, error: GatewayError): Result | null {
  try {
    const raw: unknown = JSON.parse(rawText);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const id = (raw as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) {
        return makeResultError(id, error);
      }
    }
  } catch {
    // Not parseable — nothing answerable on this socket.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const log = makeLogger(options);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  const nonceStore = new NonceStore();
  const sockets = new Set<ClientSocketState>();
  let closing = false;

  const isTierAllowed = (entry: AllowlistEntry): boolean =>
    entry.tier === 'P1' || (entry.tier === 'P2' && options.tier === 'P2');

  // -- HTTP routes -----------------------------------------------------------

  const handleFileRoute = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    const rawToken = decodeURIComponent(url.pathname.slice(GATEWAY_FILES_PATH_PREFIX.length + 1));
    const payload = verifyFileToken(options.secret, options.tenantId, rawToken);
    if (!payload) {
      sendEmpty(res, 404);
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(payload.p);
    } catch {
      sendEmpty(res, 404);
      return;
    }
    if (!stat.isFile()) {
      sendEmpty(res, 404);
      return;
    }
    const size = stat.size;
    const headers: Record<string, string> = {
      'Content-Type': mimeForPath(payload.p),
      'Content-Disposition': contentDisposition(payload.d, path.basename(payload.p)),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, size);
      if (!range) {
        sendEmpty(res, 416, { 'Content-Range': `bytes */${size}` });
        return;
      }
      const stream = fs.createReadStream(payload.p, { start: range.start, end: range.end });
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': range.end - range.start + 1,
      });
      stream.pipe(res);
      stream.on('error', () => {
        res.destroy();
      });
      return;
    }

    const stream = fs.createReadStream(payload.p);
    res.writeHead(200, { ...headers, 'Content-Length': size });
    stream.pipe(res);
    stream.on('error', () => {
      res.destroy();
    });
  };

  const handleUploadRoute = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    const name = url.searchParams.get('name') ?? '';
    const mime = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    if (isBlockedUploadType(name, mime)) {
      sendEmpty(res, 415);
      return;
    }
    const targetPath = uploadTargetPath(options.paths.uploadsRoot, name, new Date(), randomUUID());
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    let received = 0;
    let settled = false;
    const fileStream = fs.createWriteStream(targetPath);
    const fail = (status: number): void => {
      if (settled) return;
      settled = true;
      req.unpipe(fileStream);
      req.resume(); // drain whatever is left so the connection stays clean
      // Respond only after the fd is closed and the partial file removed, so
      // a completed error response guarantees no partial file remains.
      let responded = false;
      const respond = (): void => {
        if (responded) return;
        responded = true;
        fs.rm(targetPath, { force: true }, () => sendEmpty(res, status));
      };
      if (fileStream.closed) respond();
      else fileStream.once('close', respond);
      if (!fileStream.destroyed) fileStream.destroy();
    };
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > UPLOAD_MAX_BYTES) {
        fail(413);
      }
    });
    req.on('error', () => fail(500));
    fileStream.on('error', (error: NodeJS.ErrnoException) => {
      fail(error.code === 'ENOSPC' ? 507 : 500);
    });
    fileStream.on('finish', () => {
      if (settled) return;
      settled = true;
      sendJson(res, 200, {
        path: targetPath,
        size: received,
        mime: mime || 'application/octet-stream',
      });
    });
    req.pipe(fileStream);
  };

  const handleSensitiveRoute = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const bodyChunks: Buffer[] = [];
    let bodySize = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > 64 * 1024) {
        if (!settled) {
          settled = true;
          sendEmpty(res, 400);
        }
        req.destroy();
        return;
      }
      bodyChunks.push(chunk);
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        sendEmpty(res, 400);
      }
    });
    req.on('end', async () => {
      if (settled) return;
      const reverifyHeader = req.headers['x-idbots-reverify'];
      const reverifyToken = Array.isArray(reverifyHeader) ? reverifyHeader[0] : (reverifyHeader ?? '');
      const payload = verifyReverifyToken(options.secret, options.tenantId, reverifyToken, {
        nonceStore,
        expectedPurpose: 'reveal-mnemonic',
      });
      if (!payload) {
        settled = true;
        sendEmpty(res, 403);
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
      } catch {
        settled = true;
        sendEmpty(res, 400);
        return;
      }
      const target = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      let mnemonic: string;
      if (target.target === 'user') {
        try {
          mnemonic = await options.revealMnemonic({ target: 'user' });
        } catch (error) {
          log('error', 'gateway.sensitive', 'reveal-mnemonic handler failed', {
            clientId: clientIdOf(req),
            error: error instanceof Error ? error.message : String(error),
          });
          if (!settled) {
            settled = true;
            sendEmpty(res, 500);
          }
          return;
        }
      } else if (target.target === 'metabot' && Number.isInteger(target.metabotId)) {
        try {
          mnemonic = await options.revealMnemonic({ target: 'metabot', metabotId: Number(target.metabotId) });
        } catch (error) {
          log('error', 'gateway.sensitive', 'reveal-mnemonic handler failed', {
            clientId: clientIdOf(req),
            error: error instanceof Error ? error.message : String(error),
          });
          if (!settled) {
            settled = true;
            sendEmpty(res, 500);
          }
          return;
        }
      } else {
        settled = true;
        sendEmpty(res, 400);
        return;
      }
      if (settled) return;
      // Audit line: tenant/target/clientId/time only — never the mnemonic.
      log('info', 'gateway.sensitive', 'mnemonic revealed via sensitive route', {
        target: target.target === 'metabot' ? `metabot:${Number(target.metabotId)}` : 'user',
        clientId: clientIdOf(req),
        ts: Date.now(),
      });
      settled = true;
      sendJson(res, 200, { mnemonic }, { 'Cache-Control': 'no-store' });
    });
  };

  const handleStaticBundleRoute = (res: http.ServerResponse, url: URL): void => {
    if (!options.staticBundleDir) {
      sendEmpty(res, 404);
      return;
    }
    const routePath = url.pathname.slice(APP_BUNDLE_PATH_PREFIX.length);
    const bundleRoot = fs.realpathSync(options.staticBundleDir);
    const decoded = decodeURIComponent(routePath);
    const relative = decoded === '' || decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const resolved = path.normalize(path.join(bundleRoot, relative));
    if (!isInsideRoot(resolved, bundleRoot)) {
      sendEmpty(res, 404);
      return;
    }
    let filePath = resolved;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch {
      sendEmpty(res, 404);
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      sendEmpty(res, 404);
      return;
    }
    if (!stat.isFile()) {
      sendEmpty(res, 404);
      return;
    }
    const isIndex = path.basename(filePath) === 'index.html';
    const cacheControl = isIndex
      ? 'no-cache'
      : isHashedAsset(filePath)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
    res.writeHead(200, {
      // Bundle route serves browser-executable assets; the fileSign download
      // map (mimeForPath) must NOT be used here — its octet-stream default
      // makes browsers refuse module scripts (white screen).
      'Content-Type': bundleContentType(filePath),
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  };

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendEmpty(res, 404);
      return;
    }

    // Liveness: never blocks, no auth.
    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Everything else requires the gateway secret (constant time, no detail).
    if (!secretMatches(options.secret, readRequestSecret(req))) {
      sendEmpty(res, 401);
      return;
    }

    if (method === 'GET' && url.pathname === '/readyz') {
      const readiness = buildReadinessResponse(options.readiness());
      sendJson(res, readiness.status, readiness.body);
      return;
    }
    if (method === 'GET' && url.pathname.startsWith(`${GATEWAY_FILES_PATH_PREFIX}/`)) {
      handleFileRoute(req, res, url);
      return;
    }
    if (method === 'POST' && url.pathname === GATEWAY_UPLOAD_PATH) {
      handleUploadRoute(req, res, url);
      return;
    }
    if (method === 'POST' && url.pathname === GATEWAY_SENSITIVE_REVEAL_MNEMONIC_PATH) {
      handleSensitiveRoute(req, res);
      return;
    }
    if (method === 'GET' && (url.pathname === APP_BUNDLE_PATH_PREFIX || url.pathname.startsWith(`${APP_BUNDLE_PATH_PREFIX}/`))) {
      handleStaticBundleRoute(res, url);
      return;
    }
    sendEmpty(res, 404);
  };

  const httpServer = http.createServer(handleRequest);

  // -- WebSocket --------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  const clientIdOf = (req: http.IncomingMessage): string => {
    const value = req.headers['x-idbots-client-id'];
    const id = Array.isArray(value) ? value[0] : value;
    return typeof id === 'string' && id.trim().length > 0 ? id : 'unknown';
  };

  httpServer.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== GATEWAY_WS_PATH) {
      socket.destroy();
      return;
    }
    if (!secretMatches(options.secret, readRequestSecret(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (closing) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    if (closing || sockets.size >= MAX_CLIENT_SOCKETS) {
      ws.close(CLOSE_TOO_MANY_CLIENTS);
      return;
    }
    const state: ClientSocketState = {
      ws,
      clientId: clientIdOf(req),
      inFlight: 0,
      bucketTokens: INVOKE_RATE_BURST,
      bucketRefillAt: Date.now(),
      lastPongAt: Date.now(),
      pingTimer: null,
    };
    sockets.add(state);

    // C2: first frame after the socket opens.
    const readinessState = options.readiness();
    const ready = readinessState.phase === 'ready' || readinessState.phase === 'degraded';
    ws.send(encodeFrame({
      v: 1,
      type: 'welcome',
      contractVersion: options.contractVersion,
      appVersion: options.appVersion,
      tenantId: options.tenantId,
      serverTime: Date.now(),
      ready,
      phase: readinessState.phase,
    }));

    state.pingTimer = setInterval(() => {
      if (Date.now() - state.lastPongAt > PONG_TIMEOUT_MS) {
        log('warn', 'gateway.ws', 'socket missed pong deadline, terminating', { clientId: state.clientId });
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch {
        // Socket already closing; the close handler cleans up.
      }
    }, PING_INTERVAL_MS);
    state.pingTimer.unref?.();

    ws.on('pong', () => {
      state.lastPongAt = Date.now();
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      onSocketMessage(state, data, isBinary);
    });

    ws.on('close', () => {
      if (state.pingTimer) clearInterval(state.pingTimer);
      sockets.delete(state);
    });
    ws.on('error', () => {
      // The close event follows; cleanup happens there.
    });
  });

  const sendResult = (state: ClientSocketState, result: Result): void => {
    try {
      state.ws.send(encodeFrame(result));
    } catch (error) {
      log('warn', 'gateway.ws', 'failed to send result frame', {
        clientId: state.clientId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onSocketMessage = (state: ClientSocketState, data: Buffer, isBinary: boolean): void => {
    if (isBinary) {
      log('warn', 'gateway.ws', 'binary frame dropped (text frames only)', { clientId: state.clientId });
      return;
    }
    if (Buffer.byteLength(data) > INBOUND_FRAME_MAX_BYTES) {
      // C2: oversized inbound frame → PAYLOAD_TOO_LARGE, socket stays open.
      const reply = errorResultForRawFrame(data.toString('utf8'), makeError('PAYLOAD_TOO_LARGE', 'inbound frame exceeds the 1 MiB limit'));
      if (reply) sendResult(state, reply);
      else log('warn', 'gateway.ws', 'oversized frame without answerable id dropped', { clientId: state.clientId });
      return;
    }
    const text = data.toString('utf8');
    const parsed = parseInboundFrame(text);
    if (parsed.ok === false) {
      const reply = errorResultForRawFrame(text, parsed.error);
      if (reply) sendResult(state, reply);
      else log('warn', 'gateway.ws', 'invalid frame dropped', { clientId: state.clientId, error: parsed.error.message });
      return;
    }
    const frame = parsed.frame;
    if (frame.type === 'ping') {
      try {
        state.ws.send(encodeFrame({ v: 1, type: 'pong', ts: frame.ts }));
      } catch {
        // Socket is closing.
      }
      return;
    }
    onInvoke(state, frame.id, frame.channel, frame.args);
  };

  let storeSetQueue: Promise<void> = Promise.resolve();
  const enqueueStoreSet = (clientId: string, incoming: unknown): Promise<unknown> => {
    const run = storeSetQueue.then(() => {
      const merged = mergeAppConfigSet(options.storeGet?.('app_config'), incoming);
      if (merged === null) {
        throw new Error('app_config providers cannot be added, removed, or re-shaped');
      }
      return options.invokeHandler('store:set', clientId, ['app_config', merged]);
    });
    storeSetQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const onInvoke = (state: ClientSocketState, id: string, channel: string, args: unknown[]): void => {
    // Token bucket (C2: 50/s, burst 100).
    if (!bucketAllow(state, Date.now())) {
      sendResult(state, makeResultError(id, makeError('RATE_LIMITED', 'invoke rate limit exceeded (50/s, burst 100)')));
      return;
    }
    // In-flight cap (C2: 32 per socket).
    if (state.inFlight >= MAX_IN_FLIGHT_INVOKES) {
      sendResult(state, makeResultError(id, makeError('RATE_LIMITED', 'too many in-flight invokes (max 32)')));
      return;
    }
    // Conformance-only virtual channel: a guaranteed-slow invoke with a short
    // timeout, so `invoke-timeout` is verified against a real gateway. Only
    // reachable when the test hooks were explicitly enabled via env.
    const isTestSleep = options.enableTestHooks === true && channel === '__test:sleep';
    // Allowlist + tier gate (02 + C2).
    const entry = isTestSleep
      ? { tier: 'P1' as const, timeoutMs: options.testSleepTimeoutMs ?? 1500 }
      : lookupInvokeChannel(channel);
    if (!isTestSleep && !isTierAllowed(entry)) {
      sendResult(state, makeResultError(id, makeError('CHANNEL_NOT_ALLOWED', `channel '${channel}' is not allowed at tier ${options.tier}`)));
      return;
    }
    // Readiness gate: while the tenant boots only the two whitelisted channels run.
    const phase = options.readiness().phase;
    if (NOT_READY_PHASES.has(phase) && !NOT_READY_ALLOWED_CHANNELS.has(channel)) {
      sendResult(state, makeResultError(id, makeError('TENANT_NOT_READY', `tenant is not ready (phase: ${phase})`)));
      return;
    }
    if (!isTestSleep && !options.hasHandler(channel)) {
      sendResult(state, makeResultError(id, makeError('CHANNEL_NOT_FOUND', `no handler registered for '${channel}'`)));
      return;
    }
    // R-rule restrictions (02).
    const restrictionError = validateInvokeRestrictions(channel, args, entry, options.paths);
    if (restrictionError) {
      sendResult(state, makeResultError(id, restrictionError));
      return;
    }

    if (channel === 'store:set' && options.storeGet) {
      const merged = mergeAppConfigSet(options.storeGet('app_config'), args[1]);
      if (merged === null) {
        sendResult(state, makeResultError(id, makeError('INVALID_ARGS', 'app_config providers cannot be added, removed, or re-shaped')));
        return;
      }
    }

    state.inFlight += 1;
    const timeoutMs = entry.timeoutMs ?? defaultTimeoutMs;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.inFlight -= 1;
      // C2: the handler keeps running in the background after a timeout.
      sendResult(state, makeResultError(id, makeError('TIMEOUT', `no result within ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    let invokePromise: Promise<unknown>;
    if (isTestSleep) {
      const rawMs = (args[0] as { ms?: unknown } | undefined)?.ms;
      const sleepMs = typeof rawMs === 'number' && Number.isFinite(rawMs) && rawMs >= 0 && rawMs <= 10000
        ? rawMs
        : 5000;
      invokePromise = new Promise((resolve) => {
        const sleeper = setTimeout(() => resolve({ sleptMs: sleepMs }), sleepMs);
        sleeper.unref?.();
      });
    } else if (channel === 'store:set' && options.storeGet) {
      invokePromise = enqueueStoreSet(state.clientId, args[1]);
    } else {
      invokePromise = options.invokeHandler(channel, state.clientId, args);
    }

    invokePromise
      .then((rawValue) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.inFlight -= 1;
        let value = sanitizeIpcPayload(rawValue);
        // R-store: the app_config value never exposes provider apiKeys.
        if (channel === 'store:get' && args[0] === 'app_config') {
          value = redactAppConfig(value);
        }
        sendResult(state, makeResultOk(id, value));
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.inFlight -= 1;
        sendResult(state, makeResultError(id, makeError('HANDLER_ERROR', error instanceof Error ? error.message : String(error))));
      });
  };

  // -- Event fan-out (02 Events table; every connected socket gets every allowed event)

  const unsubscribeBroadcast = options.addBroadcastListener((channel, args) => {
    if (closing) return;
    const entry = lookupEventChannel(channel);
    if (!isTierAllowed(entry)) return;
    let outArgs = args;
    if (channel === 'store:changed') {
      // 02: forwarded only for key app_config, redacted like R-store.
      const payload = args[0];
      if (!payload || typeof payload !== 'object' || (payload as Record<string, unknown>).key !== 'app_config') {
        return;
      }
      if ('value' in (payload as Record<string, unknown>)) {
        outArgs = [{ ...(payload as Record<string, unknown>), value: redactAppConfig((payload as Record<string, unknown>).value) }];
      }
    }
    const sanitized = outArgs.map((arg) => sanitizeIpcPayload(arg));
    const frameText = encodeFrame({ v: 1, type: 'event', channel, args: sanitized });
    if (Buffer.byteLength(frameText) > OUTBOUND_FRAME_MAX_BYTES) {
      log('warn', 'gateway.events', 'event frame exceeds 8 MiB after sanitization, dropped', { channel });
      return;
    }
    for (const state of sockets) {
      try {
        state.ws.send(frameText);
      } catch {
        // Socket is closing; the close handler cleans up.
      }
    }
  });

  // -- Listen / close ---------------------------------------------------------

  const handle = await new Promise<GatewayHandle>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(options.port, options.host, () => {
      httpServer.removeListener('error', onError);
      const address = httpServer.address();
      const boundPort = typeof address === 'object' && address ? address.port : options.port;
      log('info', 'gateway.server', 'gateway listening', {
        host: options.host,
        port: boundPort,
        tier: options.tier,
        contractVersion: options.contractVersion,
        appVersion: options.appVersion,
      });
      resolve({
        port: boundPort,
        close: (closeOpts?: { code?: number; reason?: string }) =>
          shutdown(closeOpts?.code ?? CLOSE_SERVER_SHUTDOWN, closeOpts?.reason),
      });
    });
  });

  const shutdown = (code: number, reason?: string): Promise<void> =>
    new Promise<void>((resolve) => {
      if (closing) {
        resolve();
        return;
      }
      closing = true;
      unsubscribeBroadcast();
      for (const state of sockets) {
        if (state.pingTimer) clearInterval(state.pingTimer);
        try {
          state.ws.close(code, reason ?? '');
        } catch {
          // Already closed.
        }
      }
      // Give the close handshake a moment, then force-terminate stragglers so
      // close() reliably resolves even with unresponsive clients.
      const terminateTimer = setTimeout(() => {
        for (const state of sockets) {
          try {
            if (state.ws.readyState === state.ws.OPEN || state.ws.readyState === state.ws.CLOSING) {
              state.ws.terminate();
            }
          } catch {
            // Already gone.
          }
        }
      }, 250);
      terminateTimer.unref?.();
      httpServer.close(() => {
        clearTimeout(terminateTimer);
        resolve();
      });
    });

  return handle;
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function isInsideRoot(resolvedPath: string, root: string): boolean {
  const normalizedRoot = path.normalize(root);
  const normalizedPath = path.normalize(resolvedPath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + path.sep);
}

/** Content-Disposition from the token's disposition plus an ASCII/UTF-8 filename. */
function contentDisposition(disposition: 'inline' | 'attachment', basename: string): string {
  const safe = basename.replace(/["\\\r\n]/g, '_');
  if (/^[\x20-\x7E]+$/.test(safe)) {
    return `${disposition}; filename="${safe}"`;
  }
  return `${disposition}; filename="download"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

interface ByteRange {
  start: number;
  end: number;
}

/** Parse a single `bytes=a-b` / `bytes=a-` / `bytes=-suffix` Range header. */
function parseRangeHeader(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;
  let start: number;
  let end: number;
  if (startText === '') {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (!Number.isInteger(start) || start < 0 || start >= size || end < start) return null;
  return { start, end };
}

/** Vite-style fingerprinted asset names (`index-DiWRgTda.js`, `app.a1b2c3d4.css`). */
function isHashedAsset(filePath: string): boolean {
  return /[.-][0-9a-zA-Z_-]{8,}\.[a-z0-9]+$/i.test(path.basename(filePath));
}

/**
 * Content types for the static PWA bundle route (`/app/*`). These files are
 * executed or rendered by a browser, so the extension → type mapping must
 * match what the bundler emits — most importantly `text/javascript` for
 * `.js`/`.mjs`: browsers refuse module scripts served as
 * `application/octet-stream` (hard white screen, zero WS traffic).
 *
 * Deliberately separate from the fileSign download map (fileSign.ts): that
 * table serves signed file downloads whose octet-stream default is intended.
 * Extensions not listed here fall back to the download map, which keeps
 * media/document assets (.pdf, .mp4, …) behaving as before.
 */
const BUNDLE_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function bundleContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return BUNDLE_CONTENT_TYPE_BY_EXTENSION[extension] ?? mimeForPath(filePath);
}
