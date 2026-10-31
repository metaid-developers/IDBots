/**
 * Voice input channel — protocol layer, ASR channel v1 (mobile voice P0, #10).
 *
 * STATUS: ALIGNED with the gateway's frozen v1 channel document
 * (2026-10-31, branch `feat/asr-gateway`):
 *   repo:   docs/cloud-mobile/voice/asr-channel.md
 *   mirror: bots/15/2026-10-31/asr-gateway/asr-channel-protocol-for-frontend.md
 *   (byte-identical at alignment time; section numbers below refer to it)
 *
 * This module stays THE single alignment point: every wire fact the frontend
 * knows lives here and nowhere else. Every encode/decode site imports from
 * here, so a future protocol revision is still a one-file change.
 *
 * Wire shape (doc sections 3-6), no version handshake — the endpoint path
 * itself pins the protocol version:
 *   endpoint        wss://<same-origin>/asr/v1/ws            (section 1)
 *   auth            same-origin `idb_session` cookie, sent by the browser on
 *                   the WS handshake; NO token, NO first-message auth frame
 *   client -> gw    binary PCM s16le 16 kHz mono, 100-200 ms per chunk
 *                   (3200-6400 bytes), plus JSON control frames
 *                   {"type":"finish"} and {"type":"abort"}      (section 3)
 *   gw -> client    {"type":"asr.open","sessionId","remainingMs"}
 *                   {"type":"asr.partial","text"}
 *                   {"type":"asr.final","text"}
 *                   {"type":"asr.done","usageSeconds","remainingMs","upstreamDurationMs"}
 *                   {"type":"asr.error","code","message","retryable"}  (section 4)
 *   close codes     ASR block 41xx, disjoint from the chat proxy /ws (section 5)
 *
 * Deliberate v1 properties the session layer depends on:
 *  - There is no client `start` frame: audio may be streamed as soon as the
 *    socket opens (the gateway buffers up to 64 chunks until the upstream is
 *    ready), so the first event is always `asr.open`.
 *  - `asr.partial` replaces the trailing interim segment; `asr.final` commits
 *    stable text and drops the interim. VAD endpointing means one session can
 *    produce SEVERAL finals (handled by backfill.ts segments).
 *  - `UPSTREAM_LOST` is self-healing inside the gateway: it reopens the
 *    upstream and re-emits `asr.open` on the SAME client socket, so the
 *    frontend must keep the last partial and keep streaming — never finalize.
 *  - `remainingMs` on `asr.open` is this connection's wall-clock budget (daily
 *    remainder capped by the 600 s per-session cap), not a daily total.
 */

/** Protocol version, pinned by the endpoint path (no wire handshake). */
export const VOICE_PROTOCOL_VERSION = 'v1' as const;

/** Gateway mount point — control-plane sidecar, same origin as the app. */
export const VOICE_WS_PATH = '/asr/v1/ws';

/** Quota preflight read API (doc section 1 / 6). */
export const VOICE_QUOTA_PATH = '/api/v1/asr/quota';

/** Session cookie name the WS handshake reuses (doc section 1). */
export const VOICE_SESSION_COOKIE = 'idb_session';

/** The only PCM shape this channel carries (doc section 1). */
export const VOICE_PCM_FORMAT = {
  sampleRate: 16000,
  encoding: 's16le',
  channels: 1,
  /** Bytes per sample for s16le — chunk math derives from this. */
  bytesPerSample: 2,
} as const;

/** Chunk guidance: 100-200 ms of 16 kHz mono s16le (doc sections 1 / 7). */
export const VOICE_CHUNK_BYTES = { min: 3200, max: 6400 } as const;

/** Gateway-side limits the client should design around (doc sections 1 / 9). */
export const VOICE_CHANNEL_LIMITS = {
  /** CP_ASR_DAILY_LIMIT_MINUTES default. */
  dailyFreeMinutes: 60,
  /** CP_ASR_MAX_SESSION_SECONDS: per-connection hard cap. */
  maxSessionSeconds: 600,
  /** Chunks the gateway buffers while the upstream is not ready yet. */
  bufferedChunks: 64,
} as const;

// ---------------------------------------------------------------------------
// Client -> gateway control frames (doc section 3)
// ---------------------------------------------------------------------------

/**
 * The only two text frames the client may send. Anything else (unknown type,
 * non-JSON text) makes the gateway close 4106.
 */
export type VoiceClientMessage = { type: 'finish' } | { type: 'abort' };

/** End of utterance: triggers `asr.final` + `asr.done` + close 1000. */
export function encodeFinishFrame(): string {
  return '{"type":"finish"}';
}

/** Cancel now: gateway closes 1000, usage is still recorded. */
export function encodeAbortFrame(): string {
  return '{"type":"abort"}';
}

export function encodeClientMessage(message: VoiceClientMessage): string {
  return message.type === 'finish' ? encodeFinishFrame() : encodeAbortFrame();
}

// ---------------------------------------------------------------------------
// Gateway -> client events (doc section 4)
// ---------------------------------------------------------------------------

/**
 * Normalized error class the UI branches on. The raw provider code stays
 * available on the event for logs/evidence; copy and behaviour key off this.
 *  - unauthorized  no/invalid session cookie (close 4101, no asr.error)
 *  - quota         daily free minutes exhausted (QUOTA_EXHAUSTED / close 4104)
 *  - session_cap   per-connection cap reached, quota remains (SESSION_CAP)
 *  - upstream      upstream unavailable / fatal (close 4105, UPSTREAM_LOST)
 *  - provider      DOUBAO_<code> provider error (not retryable)
 *  - stub          STUB_* fault injection from the stub upstream
 *  - protocol      4103 origin rejected / 4106 protocol violation
 *  - unknown       anything the doc does not define
 */
export type VoiceServerErrorClass =
  | 'unauthorized'
  | 'quota'
  | 'session_cap'
  | 'upstream'
  | 'provider'
  | 'stub'
  | 'protocol'
  | 'unknown';

export type VoiceServerEvent =
  | { kind: 'open'; sessionId?: string; remainingMs?: number }
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'done'; usageSeconds?: number; remainingMs?: number; upstreamDurationMs?: number }
  /** Self-healing upstream loss: gateway reconnects upstream, socket stays up. */
  | { kind: 'upstream_lost'; message?: string }
  | { kind: 'error'; rawCode: string; class: VoiceServerErrorClass; message?: string; retryable: boolean };

/** Maps a raw `asr.error` code to its behaviour class (doc section 5). */
export function classifyVoiceErrorCode(rawCode: string): VoiceServerErrorClass {
  if (rawCode === 'UPSTREAM_LOST') return 'upstream';
  if (rawCode === 'QUOTA_EXHAUSTED') return 'quota';
  if (rawCode === 'SESSION_CAP') return 'session_cap';
  if (rawCode.startsWith('DOUBAO_')) return 'provider';
  if (rawCode.startsWith('STUB_')) return 'stub';
  return 'unknown';
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Decodes ONE gateway text frame into a typed event. Returns null for frames
 * that are not valid voice-protocol JSON — a foreign/garbage frame must never
 * crash the UI, it is dropped (and counted by the caller if it cares).
 */
export function decodeServerEvent(raw: string): VoiceServerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case 'asr.open':
      return {
        kind: 'open',
        sessionId: stringOrUndefined(obj.sessionId),
        remainingMs: finiteNumberOrUndefined(obj.remainingMs),
      };
    case 'asr.partial':
    case 'asr.final': {
      if (typeof obj.text !== 'string') return null;
      return { kind: obj.type === 'asr.partial' ? 'partial' : 'final', text: obj.text };
    }
    case 'asr.done':
      return {
        kind: 'done',
        usageSeconds: finiteNumberOrUndefined(obj.usageSeconds),
        remainingMs: finiteNumberOrUndefined(obj.remainingMs),
        upstreamDurationMs: finiteNumberOrUndefined(obj.upstreamDurationMs),
      };
    case 'asr.error': {
      if (typeof obj.code !== 'string' || obj.code.length === 0) return null;
      const errorClass = classifyVoiceErrorCode(obj.code);
      const message = stringOrUndefined(obj.message);
      // UPSTREAM_LOST is handled inside the gateway (upstream reopen + a
      // fresh asr.open on this socket): surface it as its own non-terminal
      // kind so the session layer cannot accidentally end the session.
      if (errorClass === 'upstream' && obj.code === 'UPSTREAM_LOST') {
        return { kind: 'upstream_lost', message };
      }
      const retryable = typeof obj.retryable === 'boolean' ? obj.retryable : false;
      return { kind: 'error', rawCode: obj.code, class: errorClass, message, retryable };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Close codes (doc section 5) — ASR block 41xx
// ---------------------------------------------------------------------------

export type VoiceCloseAction =
  /** Clean end: server sent done (or the client aborted). */
  | 'none'
  /** Transient fault: the doc allows a fresh connection while quota remains. */
  | 'reconnect'
  /** Terminal for this attempt: surface copy to the user. */
  | 'fail';

export interface VoiceCloseClassification {
  action: VoiceCloseAction;
  /** Set when action is 'fail' (and on 4104 session-cap reconnects). */
  class?: VoiceServerErrorClass;
}

/**
 * Classifies a socket close code per the doc's "Frontend action" column.
 *
 * `lastErrorClass` disambiguates 4104, which the gateway uses for BOTH
 * "daily quota exhausted" and "per-session cap reached" — the `asr.error`
 * frame right before it says which. Without that context we must assume the
 * quota is gone (the conservative reading: do not silently re-dial).
 */
export function classifyVoiceClose(
  code: number,
  lastErrorClass?: VoiceServerErrorClass,
): VoiceCloseClassification {
  switch (code) {
    case 1000:
      return { action: 'none' };
    case 4101:
      return { action: 'fail', class: 'unauthorized' };
    case 4103:
      return { action: 'fail', class: 'protocol' };
    case 4104:
      return lastErrorClass === 'session_cap'
        ? { action: 'reconnect', class: 'session_cap' }
        : { action: 'fail', class: 'quota' };
    case 4105:
      return { action: 'fail', class: 'upstream' };
    case 4106:
      return { action: 'fail', class: 'protocol' };
    // Gateway fault / keepalive timeout: the doc permits one auto-retry.
    case 1011:
    case 1006:
      return { action: 'reconnect', class: 'upstream' };
    default:
      return { action: 'fail', class: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// Copy mapping (i18n suffixes under mobile.chat.voice.errorServer.*)
// ---------------------------------------------------------------------------

export type VoiceCopyCode = 'unauthorized' | 'quota' | 'sessionCap' | 'upstream' | 'generic';

const VOICE_COPY_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'quota',
  'sessionCap',
  'upstream',
  'generic',
]);

/** Maps an error class to the i18n suffix the banner renders. */
export function errorClassToCopyCode(errorClass: VoiceServerErrorClass): VoiceCopyCode {
  switch (errorClass) {
    case 'unauthorized':
      return 'unauthorized';
    case 'quota':
      return 'quota';
    case 'session_cap':
      return 'sessionCap';
    case 'upstream':
    case 'provider':
    case 'stub':
      return 'upstream';
    case 'protocol':
    case 'unknown':
    default:
      return 'generic';
  }
}

/** Guard for the `server:<class>` codes carried through the UI state. */
export function isVoiceCopyCode(value: string): value is VoiceCopyCode {
  return VOICE_COPY_CODES.has(value);
}

// ---------------------------------------------------------------------------
// Quota preflight (doc sections 1 / 6)
// ---------------------------------------------------------------------------

/** Response shape of `GET /api/v1/asr/quota` (cookie-authenticated). */
export interface VoiceQuota {
  limitMinutes?: number;
  limitSeconds?: number;
  usedSeconds?: number;
  remainingSeconds?: number;
  dayStartMs?: number;
  timezone?: string;
  upstream?: string;
}

/** Lenient decode: unknown fields are ignored, missing numeric fields stay undefined. */
export function decodeVoiceQuota(raw: unknown): VoiceQuota | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const quota: VoiceQuota = {
    limitMinutes: finiteNumberOrUndefined(obj.limitMinutes),
    limitSeconds: finiteNumberOrUndefined(obj.limitSeconds),
    usedSeconds: finiteNumberOrUndefined(obj.usedSeconds),
    remainingSeconds: finiteNumberOrUndefined(obj.remainingSeconds),
    dayStartMs: finiteNumberOrUndefined(obj.dayStartMs),
    timezone: stringOrUndefined(obj.timezone),
    upstream: stringOrUndefined(obj.upstream),
  };
  // An object with none of the known numeric fields is not a quota payload.
  const hasAny = [
    quota.limitMinutes,
    quota.limitSeconds,
    quota.usedSeconds,
    quota.remainingSeconds,
    quota.dayStartMs,
  ].some((value) => value !== undefined);
  return hasAny ? quota : null;
}

/** True when the daily free minutes are gone (mic button should be greyed). */
export function isVoiceQuotaExhausted(quota: VoiceQuota): boolean {
  return typeof quota.remainingSeconds === 'number' && quota.remainingSeconds <= 0;
}

/** Remaining daily budget in ms (for display), undefined when unknown. */
export function voiceQuotaRemainingMs(quota: VoiceQuota): number | undefined {
  return typeof quota.remainingSeconds === 'number'
    ? Math.max(0, Math.round(quota.remainingSeconds * 1000))
    : undefined;
}

// ---------------------------------------------------------------------------
// Socket URL
// ---------------------------------------------------------------------------

/**
 * Same-origin `wss://<host>/asr/v1/ws` by default. The override exists only
 * for dev/e2e stub gateways (VITE_VOICE_WS_URL) — production must never set it.
 * No token is appended: auth rides the same-origin `idb_session` cookie.
 */
export function buildVoiceSocketUrl(overrideUrl?: string): string {
  if (overrideUrl && overrideUrl.trim()) return overrideUrl.trim();
  if (typeof location !== 'undefined' && location.origin) {
    const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${location.host}${VOICE_WS_PATH}`;
  }
  // Node/test fallback: a relative path is meaningless without a location.
  return VOICE_WS_PATH;
}
