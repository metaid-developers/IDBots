/**
 * IPC payload sanitizer — limits strings, depth, key count, and item count of
 * every value the main process forwards to renderers (or back over the mobile
 * gateway), so a runaway agent payload can never blow up the IPC channel.
 *
 * Pure module: no electron imports, loadable from plain node (tests import the
 * compiled dist-electron/main/ipc/sanitize.js). Extracted from main.ts so the
 * gateway server layer can apply the exact same limits to outbound frames.
 */

export const IPC_STRING_MAX_CHARS = 4_000;
export const IPC_IMAGE_DATA_URL_MAX_CHARS = 300_000;
// Depth budget notes (2026-10-28 F-17a): the gateway re-sanitizes payloads that
// main handlers have already sanitized, and the extra wrapper levels (event
// {sessionId, request/message} + the parent object) shift every nested value
// down. The ask_user_question permission payload needs the deepest budget of
// the known families — options[].label/description sit 8–9 levels below the
// gateway's root — so the cap is 10: still a hard bound against runaway
// payloads (strings/keys/items stay capped), but no longer short enough to
// crush option objects into the string '[truncated-depth]', which made the
// mobile permission panel render an answerable ask as "Request unavailable".
export const IPC_MAX_DEPTH = 10;
export const IPC_MAX_KEYS = 80;
export const IPC_MAX_ITEMS = 40;
export const IPC_UPDATE_CONTENT_MAX_CHARS = 120_000;

export const truncateIpcString = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated in main IPC forwarding]`;
};

export const sanitizeIpcPayload = (value: unknown, depth = 0, seen?: WeakSet<object>): unknown => {
  const localSeen = seen ?? new WeakSet<object>();
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    const maxChars = value.startsWith('data:image/') ? IPC_IMAGE_DATA_URL_MAX_CHARS : IPC_STRING_MAX_CHARS;
    return truncateIpcString(value, maxChars);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[function]';
  }
  if (depth >= IPC_MAX_DEPTH) {
    return '[truncated-depth]';
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, IPC_MAX_ITEMS).map((entry) => sanitizeIpcPayload(entry, depth + 1, localSeen));
    if (value.length > IPC_MAX_ITEMS) {
      result.push(`[truncated-items:${value.length - IPC_MAX_ITEMS}]`);
    }
    return result;
  }
  if (typeof value === 'object') {
    if (localSeen.has(value as object)) {
      return '[circular]';
    }
    localSeen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, IPC_MAX_KEYS)) {
      result[key] = sanitizeIpcPayload(entry, depth + 1, localSeen);
    }
    if (entries.length > IPC_MAX_KEYS) {
      result.__truncated_keys__ = entries.length - IPC_MAX_KEYS;
    }
    return result;
  }
  return String(value);
};
