import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '../context.js';
import { isOriginAllowed } from '../origin.js';
import { resolveSession } from '../routes/auth.js';
import { sha256Hex, maskPhone } from '../crypto.js';
import { resolveTenantForUser } from './tenantLookup.js';

/**
 * `GET /ws` — the C2 gateway proxy (REQ-B-13, REQ-B-15).
 *
 * - The tenant comes ONLY from the session cookie (never from client
 *   headers/paths). No/invalid cookie → accept-then-close 4001; wrong or
 *   missing Origin → 4003 (C3's close-code table for /ws); tenant not
 *   ready/degraded → 4013; upstream connect failure → 4013. The contract
 *   defines close codes for /ws auth failures, so the upgrade is accepted
 *   and closed rather than HTTP-rejected — the tenant-level HTTP 401
 *   behavior the conformance kit checks at the tenant socket is unaffected.
 * - Frames pipe unchanged in both directions. The 1 MiB inbound (phone→
 *   proxy) limit is enforced HERE, mirroring C2: an oversized frame that
 *   parses as an invoke answers a `PAYLOAD_TOO_LARGE` result (socket stays
 *   open); an unparseable oversized frame closes with 4008. This matches
 *   the conformance kit's payload-limit check exactly.
 * - Keepalive is hop by hop: the proxy pings the phone every
 *   `pingIntervalMs` (25 s per C2) and terminates both sockets when no pong
 *   arrives within `pongTimeoutMs` (60 s); the ws client answers the
 *   tenant's pings automatically, so pings never cross the proxy.
 * - Tenant close codes pass through to the phone; a phone close closes the
 *   upstream socket.
 */

const INBOUND_LIMIT = 1024 * 1024;
/** Accept oversized frames at the socket layer so we can inspect and answer them. */
const SOCKET_MAX_PAYLOAD = 8 * 1024 * 1024;

export interface WsProxyOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export interface WsProxyStats {
  openSockets: number;
}

export function attachWsProxy(
  app: AppContext,
  server: http.Server,
  opts: WsProxyOptions = {},
): WsProxyStats {
  const pingIntervalMs = opts.pingIntervalMs ?? 25_000;
  const pongTimeoutMs = opts.pongTimeoutMs ?? 60_000;
  const stats: WsProxyStats = { openSockets: 0 };
  const wss = new WebSocketServer({ noServer: true, maxPayload: SOCKET_MAX_PAYLOAD });

  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      // Not ours: the ASR gateway (attached to the same server) owns every
      // other upgrade path and 404s the ones nobody claims. Do not destroy
      // here — both listeners see every 'upgrade' event.
      return;
    }
    handleUpgrade(app, wss, stats, req, socket, head, { pingIntervalMs, pongTimeoutMs }).catch(
      (err) => {
        console.error(
          JSON.stringify({ level: 'error', component: 'ws-proxy', msg: 'upgrade failed', error: String(err) }),
        );
        socket.destroy();
      },
    );
  });

  return stats;
}

async function handleUpgrade(
  app: AppContext,
  wss: WebSocketServer,
  stats: WsProxyStats,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: { pingIntervalMs: number; pongTimeoutMs: number },
): Promise<void> {
  const requestIdHeader = req.headers['x-request-id'];
  const requestId =
    typeof requestIdHeader === 'string' && requestIdHeader.length > 0 ? requestIdHeader : randomUUID();
  const accept = (): Promise<WebSocket> =>
    new Promise((resolve) => wss.handleUpgrade(req, socket, head, (ws) => resolve(ws)));

  const closeWith = async (code: number, reason: string, logExtra?: Record<string, unknown>): Promise<void> => {
    const ws = await accept();
    console.log(
      JSON.stringify({
        level: 'warn',
        component: 'ws-proxy',
        msg: 'upgrade closed',
        requestId,
        code,
        reason,
        ...(logExtra ?? {}),
      }),
    );
    ws.close(code, reason);
  };

  // 1. Session (4001). 2. Origin (4003). C3 close-code order.
  const session = resolveSession(app, req.headers.cookie);
  if (!session) {
    await closeWith(4001, 'unauthorized', { requestId: req.headers['x-request-id'] });
    return;
  }
  const origin = req.headers.origin;
  if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined, app.config.publicOrigin)) {
    await closeWith(4003, 'origin not allowed', { user: maskPhone(session.user.phone_e164) });
    return;
  }

  // 3. Tenant from the session only (REQ-B-15).
  const lookup = await resolveTenantForUser(app, session.user.id);
  if (!lookup.ok) {
    await closeWith(4013, 'tenant not available', {
      user: maskPhone(session.user.phone_e164),
      detail: lookup.message,
    });
    return;
  }
  const { baseUrl, secret } = lookup.resolved;
  const clientId = `c_${sha256Hex(session.token).slice(0, 16)}`;

  const phone = await accept();
  stats.openSockets += 1;
  console.log(
    JSON.stringify({
      level: 'info',
      component: 'ws-proxy',
      msg: 'socket open',
      requestId,
      user: maskPhone(session.user.phone_e164),
      tenant: lookup.resolved.tenant.id,
      clientId,
      openSockets: stats.openSockets,
    }),
  );

  const upstreamUrl = `${baseUrl.replace(/^http/, 'ws')}/gateway/v1/ws`;
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      'X-IDBots-Gateway-Secret': secret,
      'X-IDBots-Client-Id': clientId,
      'X-Forwarded-For': clientIpOf(req),
    },
    maxPayload: SOCKET_MAX_PAYLOAD,
  });

  let upstreamOpen = false;
  let closed = false;
  const earlyFrames: Array<{ data: Buffer; isBinary: boolean }> = [];

  const cleanup = (code: number, reason: string, direction: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(pingTimer);
    stats.openSockets -= 1;
    console.log(
      JSON.stringify({
        level: 'info',
        component: 'ws-proxy',
        msg: 'socket closed',
        requestId,
        user: maskPhone(session.user.phone_e164),
        tenant: lookup.resolved.tenant.id,
        code,
        reason: reason.slice(0, 80),
        direction,
        openSockets: stats.openSockets,
      }),
    );
    for (const ws of [phone, upstream]) {
      try {
        if (ws.readyState === ws.OPEN) {
          if (code === 1006) {
            // 1006 must never appear on the wire: drop the connection so the
            // peer reports the abnormal close locally.
            ws.terminate();
          } else {
            ws.close(code, reason);
          }
        } else if (ws.readyState === ws.CONNECTING) {
          ws.terminate();
        }
      } catch {
        // already closing
      }
    }
  };

  const forwardToUpstream = (data: Buffer, isBinary: boolean): void => {
    if (data.byteLength > INBOUND_LIMIT) {
      let frame: { type?: string; id?: unknown } | null = null;
      try {
        frame = JSON.parse(data.toString('utf8'));
      } catch {
        frame = null;
      }
      if (frame && frame.type === 'invoke' && typeof frame.id === 'string') {
        phone.send(
          JSON.stringify({
            v: 1,
            type: 'result',
            id: frame.id,
            ok: false,
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'inbound frame over the 1 MiB limit',
              retryable: false,
            },
          }),
        );
      } else {
        cleanup(4008, 'frame over the 1 MiB inbound limit', 'proxy');
      }
      return;
    }
    try {
      upstream.send(data, { binary: isBinary });
    } catch {
      cleanup(4013, 'upstream unavailable', 'proxy');
    }
  };

  phone.on('message', (data: Buffer, isBinary: boolean) => {
    if (upstreamOpen) {
      forwardToUpstream(data, isBinary);
    } else {
      earlyFrames.push({ data, isBinary });
      if (earlyFrames.length > 64) {
        cleanup(1013, 'upstream slow to open', 'proxy');
      }
    }
  });
  phone.on('pong', () => {
    lastPongAt = Date.now();
  });
  phone.on('close', (code, reason) => cleanup(code, reason.toString('utf8'), 'phone'));
  phone.on('error', () => cleanup(1011, 'phone socket error', 'phone'));

  upstream.on('open', () => {
    upstreamOpen = true;
    for (const frame of earlyFrames.splice(0)) {
      forwardToUpstream(frame.data, frame.isBinary);
    }
  });
  upstream.on('message', (data: Buffer, isBinary: boolean) => {
    try {
      phone.send(data, { binary: isBinary });
    } catch {
      cleanup(1011, 'phone socket error', 'upstream');
    }
  });
  upstream.on('close', (code, reason) => cleanup(code, reason.toString('utf8'), 'tenant'));
  upstream.on('error', () => {
    if (!upstreamOpen) {
      cleanup(4013, 'tenant not available', 'tenant');
    }
  });

  let lastPongAt = Date.now();
  const pingTimer = setInterval(() => {
    if (closed) {
      return;
    }
    if (Date.now() - lastPongAt > opts.pongTimeoutMs) {
      cleanup(1006, 'pong timeout', 'proxy');
      return;
    }
    try {
      phone.ping();
    } catch {
      cleanup(1011, 'phone socket error', 'proxy');
    }
  }, opts.pingIntervalMs);
}

function clientIpOf(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const remote = req.socket.remoteAddress ?? 'unknown';
  return remote === '::1' ? '127.0.0.1' : remote.replace(/^::ffff:/, '');
}
