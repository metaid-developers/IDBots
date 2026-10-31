import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppContext } from '../../context.js';
import type { ControlPlaneConfig } from '../../config.js';
import { isOriginAllowed } from '../../origin.js';
import { resolveSession } from '../../routes/auth.js';
import { maskPhone } from '../../crypto.js';
import { DoubaoUpstream } from './upstream-doubao.js';
import { FunAsrUpstream } from './upstream-funasr.js';
import { StubUpstream } from './upstream-stub.js';
import type { AsrUpstreamEvent, AsrUpstreamProvider, AsrUpstreamSession } from './types.js';
import { finalizeUsageRow, insertUsageRow, quotaFor } from './usage.js';

/**
 * `GET /asr/v1/ws` — the ASR voice gateway (voice channel — NEW capability,
 * documented in `docs/cloud-mobile/voice/asr-channel.md`; independent of the
 * frozen C2/C3 contracts and their /ws close codes).
 *
 * Auth reuses the control-plane session cookie exactly like the /ws proxy
 * (`resolveSession` + `isOriginAllowed`); no second token exists. Close
 * codes use a dedicated 41xx block so clients and logs can never confuse
 * them with the C3 /ws table (4001/4003/4008/4012/4013):
 *   4101 unauthorized · 4103 origin not allowed · 4104 daily quota /
 *       session cap · 4105 upstream unavailable · 4106 protocol violation
 *
 * One connection = one asr_usage row (metered as wall-clock streaming
 * seconds against the per-user daily limit; see usage.ts). The upstream is
 * pluggable via UpstreamProvider — stub (default, fault-injectable), doubao
 * (SAUC v3), funasr (reserved).
 *
 * Keepalive is hop by hop like the /ws proxy: ping every 25 s, terminate on
 * a 60 s pong timeout. An unexpected retryable upstream drop emits
 * `asr.error {retryable:true}` to the client, then the gateway silently
 * reopens the upstream (<= reconnectAttempts, 250 ms backoff, audio
 * buffered meanwhile) and re-announces `asr.open` — the client socket
 * survives. After `finish` no reconnect is attempted.
 */

export const ASR_WS_PATH = '/asr/v1/ws';

/** Audio chunks buffered while the upstream is (re)connecting. */
const EARLY_FRAME_CAP = 64;
const RECONNECT_BACKOFF_MS = 250;

export interface AsrGatewayOptions {
  /** Upstream provider; defaults to one built from config (stub/doubao/funasr). */
  upstream?: AsrUpstreamProvider;
  dailyLimitSeconds?: number;
  maxSessionSeconds?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  reconnectAttempts?: number;
}

export interface AsrGatewayStats {
  openSockets: number;
}

export function createUpstreamFromConfig(config: ControlPlaneConfig): AsrUpstreamProvider {
  switch (config.asr.upstream) {
    case 'doubao':
      return new DoubaoUpstream({ credentials: config.asr.doubao });
    case 'funasr':
      return new FunAsrUpstream(config.asr.funasrEndpoint ?? '');
    case 'stub':
      return new StubUpstream({ faults: config.asr.stub });
  }
}

export function attachAsrGateway(
  app: AppContext,
  server: http.Server,
  opts: AsrGatewayOptions = {},
): AsrGatewayStats {
  const pingIntervalMs = opts.pingIntervalMs ?? 25_000;
  const pongTimeoutMs = opts.pongTimeoutMs ?? 60_000;
  const dailyLimitSeconds = opts.dailyLimitSeconds ?? app.config.asr.dailyLimitMinutes * 60;
  const maxSessionSeconds = opts.maxSessionSeconds ?? app.config.asr.maxSessionSeconds;
  const reconnectAttempts = opts.reconnectAttempts ?? 3;
  const provider = opts.upstream ?? createUpstreamFromConfig(app.config);
  const stats: AsrGatewayStats = { openSockets: 0 };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Every 'upgrade' listener on this server sees every event: claim only
    // OUR path, and 404 only paths no sibling claims. `/ws` belongs to the
    // chat proxy (its own listener is passive for other paths since this
    // gateway was attached).
    if (url.pathname !== ASR_WS_PATH && url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== ASR_WS_PATH) {
      return;
    }
    handleUpgrade(app, wss, stats, provider, req, socket, head, {
      pingIntervalMs,
      pongTimeoutMs,
      dailyLimitSeconds,
      maxSessionSeconds,
      reconnectAttempts,
    }).catch((err) => {
      console.error(
        JSON.stringify({ level: 'error', component: 'asr-gateway', msg: 'upgrade failed', error: String(err) }),
      );
      socket.destroy();
    });
  });

  return stats;
}

async function handleUpgrade(
  app: AppContext,
  wss: WebSocketServer,
  stats: AsrGatewayStats,
  provider: AsrUpstreamProvider,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: {
    pingIntervalMs: number;
    pongTimeoutMs: number;
    dailyLimitSeconds: number;
    maxSessionSeconds: number;
    reconnectAttempts: number;
  },
): Promise<void> {
  const requestIdHeader = req.headers['x-request-id'];
  const requestId =
    typeof requestIdHeader === 'string' && requestIdHeader.length > 0 ? requestIdHeader : randomUUID();
  const accept = (): Promise<WebSocket> =>
    new Promise((resolve) => wss.handleUpgrade(req, socket, head, (ws) => resolve(ws)));

  const closeWith = async (code: number, reason: string): Promise<WebSocket> => {
    const ws = await accept();
    console.log(
      JSON.stringify({
        level: 'warn',
        component: 'asr-gateway',
        msg: 'upgrade closed',
        requestId,
        code,
        reason,
      }),
    );
    ws.close(code, reason);
    return ws;
  };

  // Order mirrors the /ws proxy: session, then origin.
  const session = resolveSession(app, req.headers.cookie);
  if (!session) {
    await closeWith(4101, 'unauthorized');
    return;
  }
  const origin = req.headers.origin;
  if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined, app.config.publicOrigin)) {
    await closeWith(4103, 'origin not allowed');
    return;
  }

  const user = session.user;
  const now = Date.now();
  const quota = quotaFor(app.db, {
    userId: user.id,
    now,
    limitSeconds: opts.dailyLimitSeconds,
    maxSessionSeconds: opts.maxSessionSeconds,
  });
  if (quota.remainingSeconds <= 0) {
    await closeWith(4104, 'daily quota exhausted');
    return;
  }

  const phone: WebSocket = await accept();
  stats.openSockets += 1;
  app.metrics.inc('cp_asr_sessions_total', { upstream: provider.name });
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void => {
    console.log(
      JSON.stringify({
        level,
        component: 'asr-gateway',
        requestId,
        user: maskPhone(user.phone_e164),
        upstream: provider.name,
        msg,
        ...(extra ?? {}),
      }),
    );
  };
  log('info', 'socket open', { openSockets: stats.openSockets, remainingSeconds: quota.remainingSeconds });

  const startedAt = Date.now();
  const usageRowId = insertUsageRow(app.db, { userId: user.id, upstream: provider.name, startedAt });
  /** Wall-clock budget for THIS connection (checked by the ticker). */
  const budgetMs = Math.min(quota.remainingSeconds * 1000, opts.maxSessionSeconds * 1000);

  let closed = false;
  let upstream: AsrUpstreamSession | null = null;
  let upstreamReady = false;
  let clientFinished = false;
  let upstreamDone = false;
  let reconnectsLeft = opts.reconnectAttempts;
  let audioBytes = 0;
  const earlyFrames: Buffer[] = [];

  const send = (message: unknown): void => {
    if (phone.readyState === phone.OPEN) {
      phone.send(JSON.stringify(message));
    }
  };

  const cleanup = (code: number, reason: string, direction: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(pingTimer);
    clearInterval(quotaTimer);
    stats.openSockets -= 1;
    app.metrics.inc('cp_asr_close_total', { code: String(code) });
    app.metrics.observe('cp_asr_session_seconds', {}, (Date.now() - startedAt) / 1000);
    app.metrics.inc('cp_asr_audio_bytes_total', { upstream: provider.name }, audioBytes);
    log('info', 'socket closed', {
      code,
      reason: reason.slice(0, 80),
      direction,
      seconds: (Date.now() - startedAt) / 1000,
      audioBytes,
      openSockets: stats.openSockets,
    });
    finalizeUsageRow(app.db, {
      id: usageRowId,
      endedAt: Date.now(),
      startedAt,
      audioBytes,
      finished: upstreamDone,
      closeCode: code,
    });
    try {
      upstream?.abort();
    } catch {
      // upstream already down
    }
    if (phone.readyState === phone.OPEN) {
      if (code === 1006) {
        phone.terminate();
      } else {
        phone.close(code, reason);
      }
    }
  };

  const onUpstreamEvent = (event: AsrUpstreamEvent): void => {
    if (closed) {
      return;
    }
    switch (event.kind) {
      case 'ready': {
        upstreamReady = true;
        send({ type: 'asr.open', sessionId: event.sessionId, remainingMs: Math.max(0, budgetMs - (Date.now() - startedAt)) });
        for (const frame of earlyFrames.splice(0)) {
          upstream?.pushAudio(frame);
        }
        log('info', 'upstream ready', { sessionId: event.sessionId });
        return;
      }
      case 'partial':
        send({ type: 'asr.partial', text: event.text });
        return;
      case 'final':
        send({ type: 'asr.final', text: event.text });
        return;
      case 'done': {
        upstreamDone = true;
        const usageSeconds = (Date.now() - startedAt) / 1000;
        const remainingMs = Math.max(0, budgetMs - (Date.now() - startedAt));
        send({ type: 'asr.done', usageSeconds: Math.round(usageSeconds * 10) / 10, remainingMs, upstreamDurationMs: event.durationMs });
        log('info', 'upstream done', { usageSeconds, upstreamDurationMs: event.durationMs });
        cleanup(1000, 'done', 'upstream');
        return;
      }
      case 'error': {
        log('warn', 'upstream error', { code: event.code, message: event.message.slice(0, 120), retryable: event.retryable });
        if (event.retryable && !clientFinished && reconnectsLeft > 0) {
          reconnectsLeft -= 1;
          upstreamReady = false;
          upstream = null;
          send({ type: 'asr.error', code: event.code, message: event.message, retryable: true });
          setTimeout(() => {
            if (closed) {
              return;
            }
            openUpstream().catch((err) => {
              cleanup(4105, `upstream unavailable: ${err instanceof Error ? err.message : String(err)}`, 'upstream');
            });
          }, RECONNECT_BACKOFF_MS);
          return;
        }
        send({ type: 'asr.error', code: event.code, message: event.message, retryable: false });
        cleanup(4105, `upstream error ${event.code}`, 'upstream');
        return;
      }
    }
  };

  const openUpstream = async (): Promise<void> => {
    upstream = await provider.startSession({ userId: user.id, onEvent: onUpstreamEvent });
  };

  phone.on('message', (data: Buffer, isBinary: boolean) => {
    if (closed) {
      return;
    }
    if (isBinary) {
      if (data.byteLength === 0) {
        return;
      }
      audioBytes += data.byteLength;
      if (upstreamReady && upstream) {
        upstream.pushAudio(data);
      } else {
        earlyFrames.push(data);
        if (earlyFrames.length > EARLY_FRAME_CAP) {
          cleanup(4106, 'too much audio while the upstream is unavailable', 'gateway');
        }
      }
      return;
    }
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(data.toString('utf8')) as { type?: unknown };
    } catch {
      cleanup(4106, 'text frames must be JSON control messages', 'gateway');
      return;
    }
    if (frame.type === 'finish') {
      if (clientFinished) {
        return;
      }
      clientFinished = true;
      for (const buffered of earlyFrames.splice(0)) {
        upstream?.pushAudio(buffered);
      }
      if (upstream) {
        upstream.finish();
      } else {
        // Upstream mid-reconnect: open one, flush, finish immediately.
        openUpstream()
          .then(() => {
            for (const buffered of earlyFrames.splice(0)) {
              upstream?.pushAudio(buffered);
            }
            upstream?.finish();
          })
          .catch((err) => {
            cleanup(4105, `upstream unavailable: ${err instanceof Error ? err.message : String(err)}`, 'upstream');
          });
      }
      return;
    }
    if (frame.type === 'abort') {
      cleanup(1000, 'client abort', 'phone');
      return;
    }
    cleanup(4106, `unknown control message type ${String(frame.type)}`, 'gateway');
  });

  phone.on('pong', () => {
    lastPongAt = Date.now();
  });
  phone.on('close', (code) => cleanup(code || 1000, 'client closed', 'phone'));
  phone.on('error', () => cleanup(1011, 'phone socket error', 'phone'));

  // Daily-quota / session-cap ticker: wall-clock streaming budget.
  const quotaTimer = setInterval(() => {
    if (closed) {
      return;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > budgetMs) {
      send({
        type: 'asr.error',
        code: elapsed >= opts.maxSessionSeconds * 1000 ? 'SESSION_CAP' : 'QUOTA_EXHAUSTED',
        message: 'streaming budget exhausted',
        retryable: false,
      });
      cleanup(4104, elapsed >= opts.maxSessionSeconds * 1000 ? 'session cap' : 'daily quota exhausted', 'gateway');
    }
  }, 1000);

  let lastPongAt = Date.now();
  const pingTimer = setInterval(() => {
    if (closed) {
      return;
    }
    if (Date.now() - lastPongAt > opts.pongTimeoutMs) {
      cleanup(1006, 'pong timeout', 'gateway');
      return;
    }
    try {
      phone.ping();
    } catch {
      cleanup(1011, 'phone socket error', 'gateway');
    }
  }, opts.pingIntervalMs);

  openUpstream().catch((err) => {
    cleanup(4105, `upstream unavailable: ${err instanceof Error ? err.message : String(err)}`, 'upstream');
  });
}
