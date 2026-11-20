import http from 'node:http';
import type { AppContext } from '../context.js';
import { writeError, type RequestCtx, type Route } from '../http.js';
import { resolveSession } from '../routes/auth.js';
import { resolveTenantForUser, type TenantLookupResult } from './tenantLookup.js';

/**
 * HTTP proxy routes (REQ-B-14), all streamed (no full buffering):
 *
 * - `GET /files/{token}` (cookie) → `GET {tenant}/gateway/v1/files/{token}`
 *   with the gateway secret; status/headers/body pipe through and Range
 *   requests work (206). Token validity is the tenant's job: a bad token is
 *   the tenant's 404, passed through unchanged.
 * - `POST /upload?name=` (cookie + Origin) → the tenant upload route with
 *   the secret and the original Content-Type. The 25 MB cap is enforced AT
 *   THE PROXY by counting streamed bytes: over the cap the upstream request
 *   is aborted and the phone gets `413` immediately.
 * - `GET /app/*` (cookie) → the tenant's mobile bundle. No valid cookie, or
 *   the tenant not ready/degraded, → `302 /login` (the client polls /me and
 *   comes back). For /files and /upload a not-ready tenant answers
 *   `503 TENANT_NOT_READY` instead — API clients get JSON they can handle.
 *
 * Upstream connection errors answer `502` with the generic C3 envelope;
 * upstream statuses (404, 415, 507, …) pass through untouched.
 */

export const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-disposition',
  'cache-control',
  'etag',
  'accept-ranges',
  'last-modified',
];

function tenantNotReadyOrError(lookup: TenantLookupResult, reqCtx: RequestCtx): void {
  if (!lookup.ok) {
    if (lookup.code === 'NOT_READY') {
      writeError(reqCtx.res, 503, 'TENANT_NOT_READY', lookup.message);
    } else if (lookup.code === 'NO_TENANT') {
      writeError(reqCtx.res, 404, 'NOT_FOUND', lookup.message);
    } else {
      writeError(reqCtx.res, 502, 'UPSTREAM_ERROR', 'tenant unavailable');
    }
  }
}

/** Stream an upstream response into the client response; resolves when done. */
async function streamToRes(
  reqCtx: RequestCtx,
  target: string,
  method: string,
  headers: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const upstreamReq = http.request(target, { method, headers }, (upstreamRes) => {
      const out: Record<string, string> = {};
      for (const name of PASS_HEADERS) {
        const value = upstreamRes.headers[name];
        if (typeof value === 'string') {
          out[name] = value;
        }
      }
      reqCtx.res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(reqCtx.res);
      upstreamRes.on('end', () => resolve());
      upstreamRes.on('error', reject);
    });
    upstreamReq.on('error', (err) => {
      if (!reqCtx.res.headersSent) {
        writeError(reqCtx.res, 502, 'UPSTREAM_ERROR', 'tenant connection failed');
      } else {
        reqCtx.res.end();
      }
      reject(err);
    });
    upstreamReq.end();
  });
}

async function proxyFile(
  app: AppContext,
  reqCtx: RequestCtx,
  _body: unknown,
  params: Record<string, string>,
): Promise<void> {
  const lookup = await resolveTenantForUser(app, reqCtx.user!.id);
  if (!lookup.ok) {
    tenantNotReadyOrError(lookup, reqCtx);
    return;
  }
  const headers: Record<string, string> = { 'X-IDBots-Gateway-Secret': lookup.resolved.secret };
  const range = reqCtx.req?.headers.range;
  if (typeof range === 'string') {
    headers.Range = range;
  }
  await streamToRes(
    reqCtx,
    `${lookup.resolved.baseUrl}/gateway/v1/files/${params.token}`,
    'GET',
    headers,
  );
}

async function proxyUpload(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  const req = reqCtx.req!;
  const lookup = await resolveTenantForUser(app, reqCtx.user!.id);
  if (!lookup.ok) {
    tenantNotReadyOrError(lookup, reqCtx);
    req.resume();
    return;
  }
  const original = new URL(req.url ?? '/upload', 'http://localhost');
  const target = `${lookup.resolved.baseUrl}/gateway/v1/upload${original.search}`;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const upstreamReq = http.request(
      target,
      {
        method: 'POST',
        headers: {
          'X-IDBots-Gateway-Secret': lookup.resolved.secret,
          ...(typeof req.headers['content-type'] === 'string'
            ? { 'Content-Type': req.headers['content-type'] }
            : {}),
        },
      },
      (upstreamRes) => {
        const out: Record<string, string> = {};
        for (const name of PASS_HEADERS) {
          const value = upstreamRes.headers[name];
          if (typeof value === 'string') {
            out[name] = value;
          }
        }
        reqCtx.res.writeHead(upstreamRes.statusCode ?? 502, out);
        upstreamRes.pipe(reqCtx.res);
        upstreamRes.on('end', done);
        upstreamRes.on('error', done);
      },
    );
    upstreamReq.on('error', () => {
      if (!reqCtx.res.headersSent) {
        writeError(reqCtx.res, 502, 'UPSTREAM_ERROR', 'tenant connection failed');
      } else {
        reqCtx.res.end();
      }
      done();
    });

    let count = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) {
        return;
      }
      count += chunk.length;
      if (count > UPLOAD_LIMIT_BYTES) {
        over = true;
        upstreamReq.destroy();
        if (!reqCtx.res.headersSent) {
          writeError(reqCtx.res, 413, 'PAYLOAD_TOO_LARGE', 'upload over the 25 MB limit');
        }
        req.resume(); // drain the rest without forwarding
        done();
        return;
      }
      upstreamReq.write(chunk);
    });
    req.on('end', () => {
      if (!over) {
        upstreamReq.end();
      }
    });
    req.on('error', () => {
      upstreamReq.destroy();
      if (!reqCtx.res.headersSent) {
        writeError(reqCtx.res, 502, 'UPSTREAM_ERROR', 'client upload interrupted');
      }
      done();
    });
  });
}

function redirectToLogin(reqCtx: RequestCtx): void {
  const original = reqCtx.req?.url ?? '/app/';
  const returnTo = original.startsWith('/app/') ? original : '/app/';
  reqCtx.res.writeHead(302, { Location: `/login?returnTo=${encodeURIComponent(returnTo)}` });
  reqCtx.res.end();
}

async function proxyApp(
  app: AppContext,
  reqCtx: RequestCtx,
  _body: unknown,
  params: Record<string, string>,
): Promise<void> {
  const session = resolveSession(app, reqCtx.cookieHeader);
  if (!session) {
    redirectToLogin(reqCtx);
    return;
  }
  const lookup = await resolveTenantForUser(app, session.user.id);
  if (!lookup.ok) {
    // Not ready/degraded (or anything else): the client polls /me and returns.
    redirectToLogin(reqCtx);
    return;
  }
  const original = new URL(reqCtx.req?.url ?? '/app/', 'http://localhost');
  const rest = params['*'] ?? '';
  const target = `${lookup.resolved.baseUrl}/app/${rest}${original.search}`;
  await streamToRes(reqCtx, target, 'GET', {
    'X-IDBots-Gateway-Secret': lookup.resolved.secret,
  });
}

export const proxyRoutes: Route[] = [
  { method: 'GET', path: '/files/:token', auth: true, handler: proxyFile },
  { method: 'POST', path: '/upload', auth: true, raw: true, handler: proxyUpload },
  { method: 'GET', path: '/app/*', handler: proxyApp },
];
