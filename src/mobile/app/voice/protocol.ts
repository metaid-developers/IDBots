/**
 * Voice input WebSocket protocol layer (mobile voice P0, subtask #10).
 *
 * STATUS: DRAFT v0 — the authoritative protocol document (message format /
 * event sequence / error codes) is produced in parallel by the gateway side
 * (the gateway-side engineer, Builder Ama). Until that document lands, this module is THE single
 * alignment point: everything the frontend knows about the wire format lives
 * here and nowhere else, so aligning after the doc arrives is a one-file
 * change. Every encode/decode site in the frontend imports from this module.
 *
 * DRAFT v0 wire shape (explicit, versioned, ready to be replaced):
 *   client → server, JSON TEXT frames:
 *     {"type":"start","protocol":PROTOCOL_ID,"sampleRate":16000,"pcm":"s16le","channels":1,"locale":..}
 *     {"type":"stop"}
 *   client → server, BINARY frames: raw little-endian Int16 mono PCM chunks.
 *   server → client, JSON TEXT frames:
 *     {"type":"ready","sessionId":..,"quotaRemainingSeconds":..}
 *     {"type":"partial","text":..}        — streaming hypothesis, replaceable
 *     {"type":"final","text":..}          — settled text for the utterance
 *     {"type":"error","code":..,"message":..}
 *     {"type":"end"}                       — session finished server-side
 *
 * Auth note: browser WebSocket cannot carry custom headers, so any token
 * rides the URL (e.g. ?token=…) or a first-message auth frame — that detail
 * belongs to the gateway document; `buildVoiceSocketUrl` keeps the seam.
 */

/** Identifies the draft dialect on the wire so a mismatch fails loudly. */
export const VOICE_PROTOCOL_ID = 'voice-asr-gateway/v0-draft' as const;

/** The only PCM shape the frontend sends in DRAFT v0. */
export const VOICE_PCM_FORMAT = {
  sampleRate: 16000,
  encoding: 's16le',
  channels: 1,
} as const;

/** Server error codes the frontend maps to user-facing copy (DRAFT v0). */
export type VoiceServerErrorCode =
  | 'unauthorized'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'bad_request'
  | 'internal'
  | 'timeout';

const KNOWN_SERVER_ERROR_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'quota_exceeded',
  'rate_limited',
  'upstream_unavailable',
  'bad_request',
  'internal',
  'timeout',
]);

export type VoiceClientMessage =
  | {
      type: 'start';
      protocol: typeof VOICE_PROTOCOL_ID;
      sampleRate: number;
      pcm: string;
      channels: number;
      locale?: string;
    }
  | { type: 'stop' };

export type VoiceServerEvent =
  | { kind: 'ready'; sessionId?: string; quotaRemainingSeconds?: number }
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'error'; code: VoiceServerErrorCode | 'unknown'; message?: string }
  | { kind: 'end' };

/** Encodes a client control message as a JSON text frame payload. */
export function encodeClientMessage(message: VoiceClientMessage): string {
  if (message.type === 'start') {
    return JSON.stringify({
      type: 'start',
      protocol: VOICE_PROTOCOL_ID,
      sampleRate: message.sampleRate,
      pcm: message.pcm,
      channels: message.channels,
      ...(message.locale ? { locale: message.locale } : {}),
    });
  }
  return JSON.stringify({ type: 'stop' });
}

/**
 * Builds the client `start` frame from the negotiated capture format.
 * `actualSampleRate` is what the AudioContext really runs at (iOS may ignore
 * a requested 16 kHz); values other than 16000 mean the client downsamples
 * before sending and still declares 16000 (the wire contract).
 */
export function encodeStartMessage(locale?: string): string {
  const message: VoiceClientMessage = {
    type: 'start',
    protocol: VOICE_PROTOCOL_ID,
    sampleRate: VOICE_PCM_FORMAT.sampleRate,
    pcm: VOICE_PCM_FORMAT.encoding,
    channels: VOICE_PCM_FORMAT.channels,
    ...(locale ? { locale } : {}),
  };
  return encodeClientMessage(message);
}

/**
 * Decodes ONE server text frame into a typed event. Returns null for frames
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
  const type = obj.type;
  if (type === 'ready') {
    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined;
    const quotaRemainingSeconds =
      typeof obj.quotaRemainingSeconds === 'number' && Number.isFinite(obj.quotaRemainingSeconds)
        ? obj.quotaRemainingSeconds
        : undefined;
    return { kind: 'ready', sessionId, quotaRemainingSeconds };
  }
  if (type === 'partial' || type === 'final') {
    if (typeof obj.text !== 'string') return null;
    return { kind: type, text: obj.text };
  }
  if (type === 'error') {
    const code = typeof obj.code === 'string' && KNOWN_SERVER_ERROR_CODES.has(obj.code)
      ? (obj.code as VoiceServerErrorCode)
      : 'unknown';
    const message = typeof obj.message === 'string' ? obj.message : undefined;
    return { kind: 'error', code, message };
  }
  if (type === 'end') {
    return { kind: 'end' };
  }
  return null;
}

/**
 * Maps a server error code to the i18n suffix used by
 * `mobile.chat.voice.error.<map>`. Keep in sync with the i18n dictionaries.
 */
export function mapServerErrorToCopyKey(code: VoiceServerErrorCode | 'unknown'): string {
  switch (code) {
    case 'unauthorized':
      return 'unauthorized';
    case 'quota_exceeded':
      return 'quota';
    case 'rate_limited':
      return 'busy';
    case 'upstream_unavailable':
      return 'upstream';
    case 'timeout':
      return 'timeout';
    case 'bad_request':
    case 'internal':
    case 'unknown':
    default:
      // Defensive: raw codes from a newer gateway dialect degrade to generic.
      return 'generic';
  }
}

/**
 * Socket URL seam (DRAFT v0): explicit override wins (dev/e2e stub gateway),
 * production default is same-origin `/ws/voice` — the tenant server is
 * expected to proxy that path to the ASR gateway (gateway-side deployment
 * detail, noted in the handoff). Token, when the gateway document demands
 * one, rides the query string because browser WebSocket cannot set headers.
 */
export function buildVoiceSocketUrl(overrideUrl: string | undefined): string {
  if (overrideUrl && overrideUrl.trim()) return overrideUrl.trim();
  if (typeof location !== 'undefined' && location.origin) {
    const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${location.host}/ws/voice`;
  }
  // Node/test fallback: relative path is meaningless without a location.
  return '/ws/voice';
}
