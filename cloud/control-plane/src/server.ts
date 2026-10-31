import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AppContext } from './context.js';
import { HttpError, writeError, writeJson, type RequestCtx, type Route } from './http.js';
import { isOriginAllowed } from './origin.js';
import { accountRoutes } from './routes/account.js';
import { asrRoutes } from './routes/asr.js';
import { authRoutes } from './routes/auth.js';
import { sensitiveRoutes } from './routes/sensitive.js';
import { requireUser } from './routes/auth.js';
import { maskPhone } from './crypto.js';
import { proxyRoutes } from './services/httpProxy.js';
import { loginRoutes } from './services/loginBundle.js';
import { attachAsrGateway, type AsrGatewayOptions } from './services/asr/gateway.js';
import { attachWsProxy, type WsProxyOptions } from './services/wsProxy.js';

/**
 * Minimal node:http server (no web framework, per REQ-B-2): a tiny
 * method+path router (`:param` segments and a trailing `/*` prefix), JSON
 * bodies (64 KiB cap) unless a route is marked `raw`, the C3 error envelope,
 * a per-request id (echoed in x-request-id), REQ-B-8 Origin checks on every
 * state-changing request, cookie auth for routes that ask for it, the C2/C3
 * proxy routes (REQ-B-13/14/15), and the /ws upgrade (REQ-B-13).
 */

const BODY_LIMIT = 64 * 1024;

/** Match a route path against a pathname; `:param` captures, trailing `/*` prefixes. */
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // keep the trailing slash
    if (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) {
      return { '*': pathname.slice(prefix.length) };
    }
    return null;
  }
  const pSeg = pattern.split('/');
  const uSeg = pathname.split('/');
  if (pSeg.length !== uSeg.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pSeg.length; i += 1) {
    if (pSeg[i].startsWith(':')) {
      params[pSeg[i].slice(1)] = decodeURIComponent(uSeg[i]);
    } else if (pSeg[i] !== uSeg[i]) {
      return null;
    }
  }
  return params;
}

function readBodyLimited(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const remote = req.socket.remoteAddress ?? 'unknown';
  return remote === '::1' ? '127.0.0.1' : remote.replace(/^::ffff:/, '');
}

async function handleHealth(app: AppContext, res: http.ServerResponse): Promise<void> {
  let dbOk = false;
  try {
    app.db.prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  let dockerOk = false;
  try {
    dockerOk = await app.docker.ping();
  } catch {
    dockerOk = false;
  }
  const ok = dbOk && dockerOk;
  writeJson(res, ok ? 200 : 503, { ok, db: dbOk, docker: dockerOk });
}

async function handle(
  app: AppContext,
  routes: Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const incomingId = req.headers['x-request-id'];
  const requestId = typeof incomingId === 'string' && incomingId.length > 0 ? incomingId : randomUUID();
  res.setHeader('x-request-id', requestId);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const reqCtx: RequestCtx = {
    requestId,
    method,
    path: url.pathname,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? ''),
    cookieHeader: req.headers.cookie,
    req,
    res,
    log: (level, msg, extra) =>
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          requestId,
          method,
          path: url.pathname,
          msg,
          ...(extra ?? {}),
        }),
      ),
  };

  const startedAtMs = Date.now();
  let routePattern = '(unmatched)';
  try {
    if (method === 'GET' && url.pathname === '/health') {
      routePattern = '/health';
      await handleHealth(app, res);
      return;
    }

    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined, app.config.publicOrigin)) {
        reqCtx.log('warn', 'origin not allowed');
        throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'the Origin header does not match the deployment origin');
      }
    }

    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const route of routes) {
      if (route.method !== method) {
        continue;
      }
      const matchedParams = matchPath(route.path, url.pathname);
      if (matchedParams) {
        matched = route;
        params = matchedParams;
        break;
      }
    }
    if (!matched) {
      throw new HttpError(404, 'NOT_FOUND', `no route for ${method} ${url.pathname}`);
    }
    const route = matched;
    routePattern = route.path;

    let body: unknown = null;
    if (!route.raw && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      const raw = await readBodyLimited(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'INVALID_BODY', 'the request body is not valid JSON');
        }
      }
    }

    if (route.auth) {
      requireUser(app, reqCtx);
    }
    await route.handler(app, reqCtx, body, params);
  } catch (err) {
    if (err instanceof HttpError) {
      writeError(res, err.status, err.code, err.message);
    } else {
      reqCtx.log('error', 'unhandled error', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        writeError(res, 500, 'INTERNAL', `internal error (request ${requestId})`);
      } else {
        res.end();
      }
    }
  } finally {
    // REQ-B-20: one access line per request; bodies (codes, tokens,
    // mnemonics) are never logged — only route, status, timing, identity.
    const status = res.statusCode || 500;
    app.metrics.httpRequest(routePattern, status);
    reqCtx.log('info', 'request', {
      route: routePattern,
      status,
      durationMs: Date.now() - startedAtMs,
      user: reqCtx.user ? maskPhone(reqCtx.user.phone_e164) : undefined,
    });
  }
}

export function createRequestHandler(app: AppContext): http.RequestListener {
  // Login bundle routes come last: their `/*` catch-all serves bundle
// assets and 404s anything unmatched above.
const routes: Route[] = [
  ...authRoutes,
  ...sensitiveRoutes,
  ...accountRoutes,
  ...asrRoutes,
  ...proxyRoutes,
  ...loginRoutes,
];
  return (req, res) => {
    handle(app, routes, req, res).catch((err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'request handler crashed', error: String(err) }));
      if (!res.headersSent) {
        writeError(res, 500, 'INTERNAL', 'internal error');
      } else {
        res.end();
      }
    });
  };
}

export interface PublicServerOptions {
  /** Overrides for the /ws proxy keepalive (tests inject short intervals). */
  wsProxy?: WsProxyOptions;
  /** Overrides for the ASR voice gateway (tests inject the stub upstream). */
  asr?: AsrGatewayOptions;
}

export function createPublicServer(app: AppContext, opts: PublicServerOptions = {}): http.Server {
  const server = http.createServer(createRequestHandler(app));
  const stats = attachWsProxy(app, server, opts.wsProxy);
  app.metrics.gaugeFn('cp_open_sockets', () => stats.openSockets);
  // Attached after the chat proxy: the ASR gateway owns the 404 for upgrade
  // paths nobody claims (voice channel — new capability).
  const asrStats = attachAsrGateway(app, server, opts.asr);
  app.metrics.gaugeFn('cp_asr_open_sockets', () => asrStats.openSockets);
  return server;
}

/** REQ-B-20: Prometheus text on the internal port. */
export function createMetricsServer(app: AppContext): http.Server {
  return http.createServer((_req, res) => {
    const tenantRows = app.db.prepare('SELECT status, COUNT(*) AS n FROM tenants GROUP BY status').all() as Array<{
      status: string;
      n: number;
    }>;
    const lines: string[] = [];
    for (const row of tenantRows) {
      lines.push(`cp_tenants{status="${row.status}"} ${row.n}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(`${app.metrics.render()}${lines.join('\n')}\n`);
  });
}
