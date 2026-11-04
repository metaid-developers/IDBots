import type http from 'node:http';
import type { AppContext } from './context.js';

/**
 * Tiny HTTP primitives shared by the router and the route modules: error
 * envelope, per-request context, and the route table types. No framework.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export interface SessionUser {
  id: string;
  phone_e164: string;
  display_name: string;
  locale: string;
  status: string;
  created_at: number;
}

export interface RequestCtx {
  requestId: string;
  method: string;
  path: string;
  ip: string;
  userAgent: string;
  cookieHeader: string | undefined;
  /** The raw request — only for routes marked `raw` (streaming proxies). */
  req?: http.IncomingMessage;
  res: http.ServerResponse;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** Set by the auth middleware for auth routes. */
  user?: SessionUser;
  tokenHash?: string;
}

/**
 * A route path is exact except for `:param` segments and a trailing `/*`
 * (prefix capture into params['*']).
 */
export type RouteHandler = (
  app: AppContext,
  reqCtx: RequestCtx,
  body: unknown,
  params: Record<string, string>,
) => Promise<void>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Requires a valid idb_session cookie; loads the user onto reqCtx state. */
  auth?: boolean;
  /** Skip JSON body parsing — the handler streams reqCtx.req itself. */
  raw?: boolean;
  /**
   * Skip the Origin gate on state-changing requests. Only for server-to-server
   * routes authenticated by an explicit bearer secret (no cookie, so CSRF does
   * not apply) — e.g. /api/v1/tenant/*. Never set this on a session route.
   */
  skipOriginCheck?: boolean;
  handler: RouteHandler;
}

export function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function writeError(res: http.ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { code, message } });
}

export function requireStringField(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'INVALID_BODY', `field "${field}" must be a non-empty string`);
  }
  return value;
}

export function optionalStringField(body: unknown, field: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_BODY', `field "${field}" must be a string`);
  }
  return value;
}
