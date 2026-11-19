/**
 * Session attribution for chain writes — the "请求者维度" minimal change
 * specified in pin://64fbb0ad049ead723c788c26b9495845190fd49d6fd6e7600006a22e9aa487f8i0
 * (Karvis, 2026-10-28) and re-verified against main on 2026-11-19.
 *
 * `metabot_chain_writes` has no session join key and this change deliberately
 * does not add one. Instead the caller session is encoded into `origin` with a
 * fixed, parseable grammar:
 *
 *   rpc#s=<sessionId>#m=<ok|mismatch|unknown>   (RPC create-pin)
 *   tool:omni_cast#s=<sessionId>                (session tool face)
 *
 * No declared session keeps the bare legacy origin ('rpc' / 'tool:omni_cast'),
 * so pre-change rows and degraded callers stay distinguishable. The suffix is
 * additive: the ledger's only exact-match origin consumer is the surf post
 * list, which matches tool:post_* only.
 *
 * `caller_session_id` is a DECLARATION, not authorization — a client can lie.
 * Its value is that "declared session owner != signing metabot" becomes a
 * queryable row (G2), not that it blocks a dishonest caller. The strict switch
 * below exists to turn a recorded mismatch into a refusal once a baseline has
 * shown the gate can be closed safely.
 */

export type CallerSessionMatch = 'ok' | 'mismatch' | 'unknown';

/** Server-side strict mode: mismatch is refused (409) instead of recorded. */
export const RPC_STRICT_CALLER_SESSION_ENV = 'IDBOTS_RPC_STRICT_CALLER_SESSION';

/**
 * Host-generated session ids are UUID-ish. Reject anything that could inject
 * a '#' and break the fixed origin grammar; a declared-but-unusable id is
 * treated as not declared (bare origin), never embedded.
 */
const SESSION_ID_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

export function normalizeCallerSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return SESSION_ID_TOKEN.test(trimmed) ? trimmed : undefined;
}

export function isStrictCallerSessionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[RPC_STRICT_CALLER_SESSION_ENV];
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Minimal sql.js surface, so the lookup stays unit-testable without Electron. */
export interface SqlExecLike {
  exec(sql: string, params?: Array<string | number | null>): Array<{ values: unknown[][] }>;
}

/** cowork_sessions.metabot_id for a declared session, or null when unknown. */
export function lookupCoworkSessionMetabotId(
  db: SqlExecLike,
  sessionId: string,
): number | null {
  const result = db.exec('SELECT metabot_id FROM cowork_sessions WHERE id = ?', [sessionId]);
  const raw = result[0]?.values?.[0]?.[0];
  if (raw == null) {
    return null;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function classifyCallerSession(
  sessionMetabotId: number | null | undefined,
  requestMetabotId: number,
): CallerSessionMatch {
  if (sessionMetabotId == null || !Number.isFinite(sessionMetabotId)) {
    return 'unknown';
  }
  return sessionMetabotId === requestMetabotId ? 'ok' : 'mismatch';
}

/**
 * Strict mode gate. Only a positive mismatch is refused; an unknown session is
 * still recorded (it is a G2 baseline signal, not proof of impersonation), and
 * no declaration keeps the pre-change permissive behavior.
 */
export function shouldRejectCallerSession(
  match: CallerSessionMatch | undefined,
  strictEnabled: boolean,
): boolean {
  return match === 'mismatch' && strictEnabled;
}

export function buildRpcCreatePinOrigin(
  callerSessionId: string | undefined,
  match?: CallerSessionMatch,
): string {
  if (!callerSessionId) {
    return 'rpc';
  }
  return `rpc#s=${callerSessionId}#m=${match ?? 'unknown'}`;
}

export function buildOmniCastOrigin(sessionId: unknown): string {
  const normalized = normalizeCallerSessionId(sessionId);
  return normalized ? `tool:omni_cast#s=${normalized}` : 'tool:omni_cast';
}
