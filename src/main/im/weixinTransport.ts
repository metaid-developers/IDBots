/**
 * HTTP transport for the Weixin iLink bot API.
 *
 * Kept behind a tiny interface so the gateway can be unit tested with a fake
 * transport and never touch the network. The default implementation uses the
 * runtime `fetch` (Electron main / Node >= 24) plus an AbortController timeout.
 *
 * SECRET HANDLING: the bearer token is placed in the Authorization header and is
 * never included in thrown error messages or logs.
 */

import { randomWechatUin, WEIXIN_DEFAULT_BASE_URL } from './weixinProtocol';

export interface WeixinHttpRequest {
  method: 'GET' | 'POST';
  /** Base URL; defaults to the official endpoint. */
  baseUrl?: string;
  /** Path below the base, e.g. `ilink/bot/getupdates`. */
  path: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  /** Bot token; omit for the unauthenticated QR endpoints. */
  token?: string | null;
  /** Long-poll client timeout. */
  timeoutMs: number;
  /** Extra headers (e.g. iLink-App-ClientVersion for the QR status poll). */
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

export interface WeixinHttpResponse {
  status: number;
  data: unknown;
}

export interface WeixinTransport {
  request(request: WeixinHttpRequest): Promise<WeixinHttpResponse>;
}

/** Raised when the client-side timeout fires; callers treat it as an empty long poll. */
export class WeixinRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Weixin request timed out after ${timeoutMs}ms`);
    this.name = 'WeixinRequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function buildUrl(request: WeixinHttpRequest): string {
  const base = (request.baseUrl || WEIXIN_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const path = request.path.replace(/^\/+/, '');
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(request.query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function linkAbortSignal(source: AbortSignal, controller: AbortController): void {
  if (source.aborted) {
    controller.abort();
    return;
  }
  source.addEventListener('abort', () => controller.abort(), { once: true });
}

/**
 * Default transport. Sends JSON, parses JSON (tolerating empty bodies) and maps
 * an aborted request to WeixinRequestTimeoutError so the caller can distinguish
 * "server slow / nothing to say" from a real failure.
 */
export const defaultWeixinTransport: WeixinTransport = {
  async request(request: WeixinHttpRequest): Promise<WeixinHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs));
    if (request.signal) linkAbortSignal(request.signal, controller);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': randomWechatUin(),
    };
    if (request.token) {
      headers.AuthorizationType = 'ilink_bot_token';
      headers.Authorization = `Bearer ${request.token}`;
    }
    if (request.extraHeaders) Object.assign(headers, request.extraHeaders);

    try {
      const response = await fetch(buildUrl(request), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
      const rawText = await response.text();
      let data: unknown = null;
      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch {
          // Non-JSON body: keep a short slice for diagnostics, never the token.
          data = { errmsg: rawText.slice(0, 200) };
        }
      }
      return { status: response.status, data };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new WeixinRequestTimeoutError(request.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
};
