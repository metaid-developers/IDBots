import { IPC_MAX_ITEMS } from '../ipc/sanitize';
import type { CoworkStore } from '../coworkStore';

type SessionViewStore = Pick<CoworkStore, 'getSessionView'>;
type SessionMessagesStore = Pick<CoworkStore, 'getSessionMessagesPage'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transportMessageLimit(context: unknown, requested: unknown): number | undefined {
  const numeric = Number(requested);
  const requestedLimit = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
  if (!isRecord(context) || !('gateway' in context)) return requestedLimit;
  return Math.min(requestedLimit ?? IPC_MAX_ITEMS, IPC_MAX_ITEMS);
}

export function readCoworkSessionViewForTransport(
  context: unknown,
  payload: unknown,
  options: unknown,
  store: SessionViewStore,
): ReturnType<SessionViewStore['getSessionView']> {
  const input = isRecord(payload)
    ? payload
    : { ...(isRecord(options) ? options : {}), sessionId: payload };
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  return store.getSessionView(sessionId, transportMessageLimit(context, input.messageLimit));
}

export function readCoworkSessionMessagesPageForTransport(
  context: unknown,
  input: unknown,
  store: SessionMessagesStore,
): ReturnType<SessionMessagesStore['getSessionMessagesPage']> {
  const page = isRecord(input) ? input : {};
  return store.getSessionMessagesPage(typeof page.sessionId === 'string' ? page.sessionId.trim() : '', {
    beforeSequence: typeof page.beforeSequence === 'number' ? page.beforeSequence : null,
    beforeTranscriptCursor: typeof page.beforeTranscriptCursor === 'string' ? page.beforeTranscriptCursor : null,
    displayWindow: page.displayWindow === true,
    // The generic IPC sanitizer keeps at most IPC_MAX_ITEMS. Bound the source
    // page so its cursor, page size and messages survive that sanitizer intact.
    limit: transportMessageLimit(context, page.limit),
  });
}
