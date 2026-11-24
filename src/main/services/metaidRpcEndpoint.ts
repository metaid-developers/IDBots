import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_METAID_RPC_HOST = '127.0.0.1';
export const DEFAULT_METAID_RPC_PORT = 31200;
export const METAID_RPC_PORT_ENV = 'IDBOTS_METAID_RPC_PORT';
export const METAID_RPC_TOKEN_ENV = 'IDBOTS_RPC_TOKEN';
export const METAID_RPC_AUTHFILE_ENV = 'IDBOTS_RPC_AUTHFILE';
export const METAID_RPC_TOKEN_FILENAME = 'metaid-rpc-token';
export const METAID_RPC_PORT_FILENAME = 'metaid-rpc-port';

let cachedMetaidRpcToken: string | null = null;

/**
 * Port this process's gateway actually bound.
 *
 * The default port is shared by every app instance on the machine, so a
 * second instance with its own userData (dev-fresh profile, e2e) cannot
 * bind it while the first instance is running. The bind fallback then
 * moves this instance to a spare port, and EVERY session env this process
 * injects must point at that port — pointing at the default would send
 * this instance's skill RPC into whatever app owns the default port
 * (observed 2026-10-27: a dev-fresh OpenTeam test drove the production
 * app's gateway, database and session notifications). Null until the
 * server binds; consumers then fall back to the configured port.
 */
let activeMetaidRpcPort: number | null = null;

export function setActiveMetaidRpcPort(port: number): void {
  activeMetaidRpcPort = port;
}

export function getActiveMetaidRpcPort(): number | null {
  return activeMetaidRpcPort;
}

/** Shape of a host-generated token: randomBytes(24) hex. */
const METAID_RPC_GENERATED_TOKEN_RE = /^[0-9a-f]{48}$/;

/**
 * Local-gateway bearer token for the MetaID RPC server.
 *
 * S1 hardening: every RPC endpoint requires `Authorization: Bearer <token>`.
 * The token comes from IDBOTS_RPC_TOKEN when pinned (external integrations/
 * tests), otherwise it is stable per userData dir: the first launch generates
 * it, later launches and sibling instances sharing the userData dir ADOPT the
 * mirrored token file (see writeMetaidRpcTokenFile) instead of rotating it.
 * Stability matters because every instance binds the same fixed gateway port —
 * whichever instance owns the port at a given moment must accept the tokens
 * its siblings already handed to their SKILL scripts, and a second instance
 * must never clobber the mirror file out from under the port owner's clients.
 * The token is handed to host-spawned subprocesses via the IDBOTS_RPC_TOKEN
 * env var next to IDBOTS_RPC_URL. Browsers cannot set this header cross-origin
 * (nor read the 0600 mirror file), which closes the localhost CSRF/SSRF window
 * on 127.0.0.1:31200 without changing the RPC protocol shape.
 */
export function getMetaidRpcToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[METAID_RPC_TOKEN_ENV]?.trim();
  if (fromEnv) {
    cachedMetaidRpcToken = fromEnv;
    return fromEnv;
  }
  if (cachedMetaidRpcToken) {
    return cachedMetaidRpcToken;
  }
  cachedMetaidRpcToken = randomBytes(24).toString('hex');
  return cachedMetaidRpcToken;
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function isMetaidRpcTokenAuthorized(
  providedAuthHeader: string | undefined,
  expectedToken: string,
): boolean {
  const header = (providedAuthHeader ?? '').trim();
  if (!header.startsWith('Bearer ')) {
    return false;
  }
  const provided = header.slice('Bearer '.length).trim();
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export type MetaidRpcSessionType = 'standard' | 'a2a';

export type MetaidRpcAuthContext =
  | { authorized: false }
  | { authorized: true; scope: 'master' }
  | {
      authorized: true;
      scope: 'session';
      sessionId: string;
      metabotId: number | null;
      sessionType: MetaidRpcSessionType;
    };

interface ScopedMetaidRpcTokenRecord {
  token: string;
  sessionId: string;
  metabotId: number | null;
  sessionType: MetaidRpcSessionType;
  issuedAt: number;
  expiresAt: number;
}

const SCOPED_RPC_TOKEN_PREFIX = 'idbots_sess_';
const DEFAULT_SCOPED_RPC_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SCOPED_RPC_TOKENS = 512;

const scopedTokensByValue = new Map<string, ScopedMetaidRpcTokenRecord>();
const scopedTokenBySessionKey = new Map<string, string>();

function normalizeSessionType(sessionType: string | undefined | null): MetaidRpcSessionType {
  return sessionType === 'a2a' ? 'a2a' : 'standard';
}

function normalizeOptionalMetabotId(metabotId: number | null | undefined): number | null {
  return typeof metabotId === 'number' && Number.isInteger(metabotId) && metabotId > 0
    ? metabotId
    : null;
}

function pruneExpiredScopedTokens(nowMs: number = Date.now()): void {
  for (const [token, record] of scopedTokensByValue.entries()) {
    if (record.expiresAt <= nowMs) {
      scopedTokensByValue.delete(token);
      if (scopedTokenBySessionKey.get(record.sessionId) === token) {
        scopedTokenBySessionKey.delete(record.sessionId);
      }
    }
  }
  if (scopedTokensByValue.size <= MAX_SCOPED_RPC_TOKENS) return;
  const ordered = Array.from(scopedTokensByValue.values()).sort((a, b) => a.issuedAt - b.issuedAt);
  const excess = ordered.length - MAX_SCOPED_RPC_TOKENS;
  for (let i = 0; i < excess; i += 1) {
    const victim = ordered[i];
    scopedTokensByValue.delete(victim.token);
    if (scopedTokenBySessionKey.get(victim.sessionId) === victim.token) {
      scopedTokenBySessionKey.delete(victim.sessionId);
    }
  }
}

export function isScopedMetaidRpcToken(token: string | undefined | null): boolean {
  return typeof token === 'string' && token.trim().startsWith(SCOPED_RPC_TOKEN_PREFIX);
}

/**
 * Issue (or refresh) a session-scoped MetaID RPC bearer token bound to a
 * specific cowork session, metabot_id, and sessionType ('standard' | 'a2a').
 *
 * Scoped tokens prevent a compromised or prompt-injected bash/skill subprocess
 * from impersonating another MetaBot (e.g. Twin) or calling high-risk
 * financial/admin routes from an A2A session.
 */
export function issueScopedMetaidRpcToken(params: {
  sessionId: string;
  metabotId?: number | null;
  sessionType?: string | null;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredScopedTokens(nowMs);
  const sessionId = String(params.sessionId || '').trim() || `anon-${randomBytes(8).toString('hex')}`;
  const metabotId = normalizeOptionalMetabotId(params.metabotId);
  const sessionType = normalizeSessionType(params.sessionType);
  const ttlMs = Math.max(60_000, params.ttlMs ?? DEFAULT_SCOPED_RPC_TOKEN_TTL_MS);

  const existingToken = scopedTokenBySessionKey.get(sessionId);
  if (existingToken) {
    const existing = scopedTokensByValue.get(existingToken);
    if (
      existing
      && existing.expiresAt > nowMs
      && existing.metabotId === metabotId
      && existing.sessionType === sessionType
    ) {
      existing.expiresAt = nowMs + ttlMs;
      return existing.token;
    }
    if (existing) {
      scopedTokensByValue.delete(existingToken);
    }
    scopedTokenBySessionKey.delete(sessionId);
  }

  const token = `${SCOPED_RPC_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  const record: ScopedMetaidRpcTokenRecord = {
    token,
    sessionId,
    metabotId,
    sessionType,
    issuedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };
  scopedTokensByValue.set(token, record);
  scopedTokenBySessionKey.set(sessionId, token);
  return token;
}

export function revokeScopedMetaidRpcTokensForSession(sessionId: string): void {
  const key = String(sessionId || '').trim();
  if (!key) return;
  const token = scopedTokenBySessionKey.get(key);
  if (token) {
    scopedTokensByValue.delete(token);
    scopedTokenBySessionKey.delete(key);
  }
}

export function clearScopedMetaidRpcTokensForTests(): void {
  scopedTokensByValue.clear();
  scopedTokenBySessionKey.clear();
}

/** Return active scoped tokens for outbound DLP fingerprinting (never logged). */
export function listActiveScopedMetaidRpcTokens(nowMs: number = Date.now()): string[] {
  pruneExpiredScopedTokens(nowMs);
  return Array.from(scopedTokensByValue.keys());
}

/**
 * Authorize an incoming `Authorization: Bearer <token>` header against both
 * the host master token and the in-memory scoped session token registry.
 */
export function authorizeMetaidRpcRequest(
  providedAuthHeader: string | undefined,
  expectedMasterToken: string,
  nowMs: number = Date.now(),
): MetaidRpcAuthContext {
  const header = (providedAuthHeader ?? '').trim();
  if (!header.startsWith('Bearer ')) {
    return { authorized: false };
  }
  const provided = header.slice('Bearer '.length).trim();
  if (!provided) {
    return { authorized: false };
  }

  // 1. Check host master token (used by trusted internal host callers & legacy tests).
  const expectedBuffer = Buffer.from(expectedMasterToken);
  const providedBuffer = Buffer.from(provided);
  if (
    expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return { authorized: true, scope: 'master' };
  }

  // 2. Check session-scoped token registry.
  if (!provided.startsWith(SCOPED_RPC_TOKEN_PREFIX)) {
    return { authorized: false };
  }
  const record = scopedTokensByValue.get(provided);
  if (!record) {
    return { authorized: false };
  }
  if (record.expiresAt <= nowMs) {
    scopedTokensByValue.delete(provided);
    if (scopedTokenBySessionKey.get(record.sessionId) === provided) {
      scopedTokenBySessionKey.delete(record.sessionId);
    }
    return { authorized: false };
  }
  const storedBuffer = Buffer.from(record.token);
  if (
    storedBuffer.length !== providedBuffer.length
    || !timingSafeEqual(storedBuffer, providedBuffer)
  ) {
    return { authorized: false };
  }
  return {
    authorized: true,
    scope: 'session',
    sessionId: record.sessionId,
    metabotId: record.metabotId,
    sessionType: record.sessionType,
  };
}

/** Path of the per-launch token mirror file inside the Electron userData dir. */
export function getMetaidRpcTokenFilePath(userDataPath: string): string {
  return join(userDataPath, METAID_RPC_TOKEN_FILENAME);
}

/**
 * Mirror the bearer token into a 0600 file under userData.
 *
 * Layer 2 fallback for DSH sessions: the DSH bash tool erases env names
 * matching /KEY|PASSWORD|SECRET|TOKEN/i from model-visible subprocesses, so
 * IDBOTS_RPC_TOKEN never reaches SKILL scripts executed via bash there. The
 * file's path rides the scrub-proof IDBOTS_RPC_AUTHFILE env name and skill
 * RPC clients fall back to reading it when the env-borne token is absent.
 *
 * Adopt-before-write: when the env does not pin a token and a valid mirrored
 * token already exists (previous launch, or a sibling instance currently
 * owning the gateway port), reuse it verbatim instead of rotating — rotating
 * would break every client of the instance that still owns the port. An
 * env-pinned token always wins and is re-mirrored. Best-effort: on write
 * failure the env injection remains the only channel.
 */
export function writeMetaidRpcTokenFile(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const filePath = getMetaidRpcTokenFilePath(userDataPath);
  if (!env[METAID_RPC_TOKEN_ENV]?.trim()) {
    try {
      const existing = readFileSync(filePath, 'utf8').trim();
      if (METAID_RPC_GENERATED_TOKEN_RE.test(existing)) {
        cachedMetaidRpcToken = existing;
        try {
          chmodSync(filePath, 0o600);
        } catch {
          // Windows and some network FS ignore POSIX modes.
        }
        return filePath;
      }
    } catch {
      // Missing or unreadable mirror: generate a fresh token below.
    }
  }
  try {
    writeFileSync(filePath, `${getMetaidRpcToken(env)}\n`, 'utf8');
    chmodSync(filePath, 0o600);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Origins allowed to talk to the local RPC server.
 *
 * Browser-originated requests (the localhost-CSRF attack class) must carry an
 * app-owned origin. Native host-spawned clients (SKILL scripts, cowork
 * sessions) send no Origin header and are admitted by the bearer token instead.
 * `file://` covers the packaged renderer should it ever call the RPC directly
 * (today it does not; it uses IPC).
 */
const ALLOWED_METAID_RPC_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/;
const ALLOWED_METAID_RPC_FILE_ORIGIN_RE = /^file:\/\//;

export function isAllowedMetaidRpcOrigin(origin: string | undefined | null): boolean {
  const trimmed = (origin ?? '').trim();
  if (!trimmed || trimmed === 'null') {
    return false;
  }
  return (
    ALLOWED_METAID_RPC_ORIGIN_RE.test(trimmed) ||
    ALLOWED_METAID_RPC_FILE_ORIGIN_RE.test(trimmed)
  );
}

export function resolveMetaidRpcPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[METAID_RPC_PORT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_METAID_RPC_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_METAID_RPC_PORT;
  }

  return parsed;
}

export function getMetaidRpcBase(env: NodeJS.ProcessEnv = process.env): string {
  const port = activeMetaidRpcPort ?? resolveMetaidRpcPort(env);
  return `http://${DEFAULT_METAID_RPC_HOST}:${port}`;
}

/** Path of the per-launch port mirror file inside the Electron userData dir. */
export function getMetaidRpcPortFilePath(userDataPath: string): string {
  return join(userDataPath, METAID_RPC_PORT_FILENAME);
}

/**
 * Mirror the gateway's actually-bound port into a plain file under userData.
 *
 * Purely observational (session env injection reads the in-process value via
 * getMetaidRpcBase), but it makes "which app instance owns which port"
 * answerable from the filesystem — the exact question that took a forensic
 * session to settle in the cross-instance data-blend incident.
 */
export function writeMetaidRpcPortFile(userDataPath: string, port: number): void {
  try {
    writeFileSync(getMetaidRpcPortFilePath(userDataPath), `${port}\n`, 'utf8');
  } catch {
    // Observability only; never fail startup over it.
  }
}
