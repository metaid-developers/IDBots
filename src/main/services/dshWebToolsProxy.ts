/**
 * DshWebToolsProxy — the loopback web-tools seam every DSH runtime slot mounts.
 *
 * Why a host proxy: the DSH web plugin (@deepseek-ai/dsh-web-deepseek-api)
 * speaks one fixed contract — `POST {baseURL}/search` and `POST {baseURL}/fetch`
 * with `Authorization: Bearer <env key>` (baseURL is derived by the runtime
 * config generator from the webSearch block we mount). Changing that block
 * (credential or baseURL) restarts the runtime or boots a successor, so a
 * per-call "DeepSeek out of quota → use the relay" switch can never live in
 * slot config. Instead every slot mounts THIS proxy once, with a stable local
 * descriptor; the proxy routes each call through a credential ladder:
 *
 *   1. the user's own official DeepSeek route (their paid quota) — while it
 *      works;
 *   2. on 401/402/403 (bad or exhausted key) the DeepSeek upstream is marked
 *      unusable for a TTL and the call retries against the ID.Bots relay
 *      (mrk_ relay key, separate free search bucket — free even after the
 *      free LLM token pool is spent);
 *   3. 429/5xx/network failures fall through WITHOUT marking (transient);
 *      other 4xx are returned as-is (the request itself is at fault);
 *   4. the relay's response is final.
 *
 * Because the mounted block is constant for the whole app run (loopback URL +
 * env-carried local token), no slot's config can flap because of it — the
 * property the 2026-10-16 boot-storm fix and PR #100 both chased — and the
 * user's DeepSeek key never enters any runtime env: the child carries only a
 * loopback-local token.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** One upstream able to serve the DeepSeek Search/Fetch API shape. */
export interface DshWebToolsUpstream {
  /** Tool base that `/search` and `/fetch` append to (…/v1/tools). */
  baseURL: string;
  apiKey: string;
  /** Stable id for logs and the exhaustion map ('deepseek' | 'idbots-free'). */
  label: string;
}

/** What the hub mounts into the webSearch block (constant while running). */
export interface DshWebToolsProxyDescriptor {
  /** Messages-root form (`http://127.0.0.1:<port>/anthropic/v1`); the runtime
   *  config generator derives `<root>/v1/tools` from it, mirroring how the
   *  host seeds real DeepSeek bases. */
  baseURL: string;
  /** Loopback-local bearer token the runtime presents as the apiKeyEnv value. */
  token: string;
}

export interface DshWebToolsProxyDeps {
  /** The user's own DeepSeek route, when one is enabled with a key. */
  resolveDeepSeekUpstream: () => DshWebToolsUpstream | null;
  /** The IDBots-Free relay search upstream, when relay credentials resolve. */
  resolveRelayUpstream: () => Promise<DshWebToolsUpstream | null>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a 401/402/403 DeepSeek result suppresses that upstream. */
  exhaustedTtlMs?: number;
  /** Per-upstream request timeout (ms); the plugin gives up at 60s. */
  requestTimeoutMs?: number;
}

export interface DshWebToolsProxy extends DshWebToolsProxyDescriptor {
  port: number;
  stop(): Promise<void>;
}

const DEFAULT_EXHAUSTED_TTL_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 75_000;
const MAX_BODY_BYTES = 1024 * 1024;

/** Scan the provider catalog for the user's enabled official DeepSeek entry. */
export function resolveDeepSeekWebToolsUpstream(
  providers: Record<string, { enabled?: boolean; apiKey?: string | null; baseUrl?: string | null } | undefined>,
  isOfficialDeepSeekRoute: (route: { key?: string; baseUrl?: string }) => boolean,
): DshWebToolsUpstream | null {
  for (const [key, cfg] of Object.entries(providers ?? {})) {
    if (!cfg || cfg.enabled === false) continue;
    const apiKey = String(cfg.apiKey ?? '').trim();
    const baseUrl = String(cfg.baseUrl ?? '').trim();
    if (!apiKey || !baseUrl) continue;
    if (!isOfficialDeepSeekRoute({ key, baseUrl })) continue;
    return { label: 'deepseek', apiKey, baseURL: deepSeekWebToolsRoot(baseUrl) };
  }
  return null;
}

/**
 * Mirror of the runtime config generator's `deepSeekWebToolsBaseURL`: derive
 * `<root>/v1/tools` from whatever base shape the user configured (host root,
 * /v1 chat base, /anthropic messages base, or a /v1/tools base already).
 */
export function deepSeekWebToolsRoot(baseUrl: string): string {
  const root = String(baseUrl ?? '').trim()
    .replace(/\/+$/, '')
    .replace(/\/anthropic(\/v\d+)?$/i, '')
    .replace(/\/tools$/i, '')
    .replace(/\/v\d+$/i, '');
  return `${root}/v1/tools`;
}

/**
 * Derive the ID.Bots relay's tools base (`<llm root>/v1/tools`, the ABS
 * route `/v2/assist/llm/v1/tools/search|fetch`) from the relay base the client
 * stores. That stored base is the chat base and already ends in `/v1`
 * (`…/v2/assist/llm/v1`, the bootstrap PublicBaseURL), so a naive
 * `${base}/v1/tools` would double the version segment — the shape the first
 * production probe caught (2026-10-26). Accepts the bare llm root too.
 */
export function relayWebToolsBase(relayBaseUrl: string): string {
  const root = String(relayBaseUrl ?? '').trim()
    .replace(/\/+$/, '')
    .replace(/\/tools$/i, '')
    .replace(/\/v\d+$/i, '');
  return `${root}/v1/tools`;
}

let activeProxy: DshWebToolsProxy | null = null;

/** Descriptor for the running proxy, or null before startup / after stop. */
export function getDshWebToolsProxyDescriptor(): DshWebToolsProxyDescriptor | null {
  return activeProxy;
}

/** Test seam: forget the module-level proxy without touching the server. */
export function resetDshWebToolsProxyForTests(): void {
  activeProxy = null;
}

/** App-lifetime singleton: start once, then every hub reads the descriptor. */
export async function startDshWebToolsProxy(deps: DshWebToolsProxyDeps): Promise<DshWebToolsProxy> {
  if (activeProxy) return activeProxy;
  const proxy = await createDshWebToolsProxy(deps);
  activeProxy = proxy;
  return proxy;
}

/** Stop the singleton (app quit); no-op when it never started. */
export async function stopDshWebToolsProxy(): Promise<void> {
  const proxy = activeProxy;
  activeProxy = null;
  if (proxy) await proxy.stop();
}

/** Independent instance (tests start several with different ladders). */
export async function createDshWebToolsProxy(deps: DshWebToolsProxyDeps): Promise<DshWebToolsProxy> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const exhaustedTtlMs = Math.max(1_000, deps.exhaustedTtlMs ?? DEFAULT_EXHAUSTED_TTL_MS);
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const token = randomBytes(24).toString('hex');
  /** A 401/402/403 from DeepSeek suppresses that upstream until this time. */
  let deepSeekUnusableUntil: number | null = null;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log(`[DshWebToolsProxy] handler error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: 'web tools proxy internal error' } }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'web tools proxy: unauthorized' } }));
      return;
    }
    const kind = /^\/v1\/tools\/(search|fetch)$/.exec(url.pathname)?.[1] as 'search' | 'fetch' | undefined;
    if (req.method !== 'POST' || !kind) {
      // The legacy Messages-turn search provider would land here; the ladder
      // design never selects it (searchProvider stays 'deepseek-search-api').
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `web tools proxy: unsupported route ${req.method} ${url.pathname}` } }));
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'web tools proxy: request body too large' } }));
      return;
    }

    const candidates: DshWebToolsUpstream[] = [];
    const deepSeek = deps.resolveDeepSeekUpstream();
    if (deepSeek) {
      if (deepSeekUnusableUntil !== null && now() < deepSeekUnusableUntil) {
        // Suppressed this call; the expiry probe below logs when it re-arms.
      } else {
        if (deepSeekUnusableUntil !== null) {
          log('[DshWebToolsProxy] deepseek upstream suppression elapsed — probing it again');
        }
        deepSeekUnusableUntil = null;
        candidates.push(deepSeek);
      }
    }
    const relay = await deps.resolveRelayUpstream().catch(() => null);
    if (relay) candidates.push(relay);

    if (candidates.length === 0) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'web search is unavailable: no DeepSeek API key is configured and the ID.Bots relay credentials did not resolve. Add a DeepSeek key in Settings > Models, or re-run the free-relay bootstrap.',
        },
      }));
      return;
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const upstream = candidates[i];
      const isLast = i === candidates.length - 1;
      let response: Response;
      try {
        response = await fetchImpl(`${upstream.baseURL}/${kind}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${upstream.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[DshWebToolsProxy] ${upstream.label} ${kind} transport error: ${message}`);
        if (!isLast) continue;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `web search upstream unreachable (${upstream.label}): ${message}` } }));
        return;
      }
      const payload = Buffer.from(await response.arrayBuffer());
      const credentialProblem = response.status === 401 || response.status === 402 || response.status === 403;
      if (credentialProblem && upstream.label === 'deepseek') {
        deepSeekUnusableUntil = now() + exhaustedTtlMs;
        log(
          `[DshWebToolsProxy] deepseek upstream marked unusable (HTTP ${response.status}) for ` +
          `${Math.round(exhaustedTtlMs / 60_000)}m — falling back to the ID.Bots relay`,
        );
        if (!isLast) continue;
      }
      if (response.status >= 500 && upstream.label === 'deepseek' && !isLast) {
        log(`[DshWebToolsProxy] deepseek upstream returned HTTP ${response.status} — trying the relay (not marked)`);
        continue;
      }
      if (response.status === 429 && upstream.label === 'deepseek' && !isLast) {
        log(`[DshWebToolsProxy] deepseek upstream rate-limited this call — trying the relay (not marked)`);
        continue;
      }
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      res.end(payload);
      return;
    }
  }

  function isAuthorized(req: IncomingMessage): boolean {
    const header = String(req.headers.authorization ?? '');
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const presented = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('web tools proxy failed to bind a loopback port');
  }
  const proxy: DshWebToolsProxy = {
    port: address.port,
    token,
    get baseURL() {
      return `http://127.0.0.1:${address.port}/anthropic/v1`;
    },
    async stop() {
      if (activeProxy === proxy) activeProxy = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  server.unref();
  log(`[DshWebToolsProxy] listening on 127.0.0.1:${address.port} — slots mount the web seam through this proxy (deepseek-first, ID.Bots relay fallback)`);
  return proxy;
}
