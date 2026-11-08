import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkSession,
  CoworkSessionMetadata as CoworkStoreSessionMetadata,
  CoworkSessionType,
} from '../coworkStore';
import { wrapCrossSessionMessage } from '../libs/groupTaskCopy';

export const CROSS_SESSION_INSERT_MAX_CHARS = 12000;

export type CoworkCrossSessionErrorCode =
  | 'INVALID_SESSION_ID'
  | 'SESSION_NOT_FOUND'
  | 'WRITE_NOT_ALLOWED_FOR_A2A'
  | 'SOURCE_TARGET_SAME_SESSION'
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'DELIVERY_CONFLICT';

export interface CoworkCrossSessionError {
  ok: false;
  code: CoworkCrossSessionErrorCode;
  message: string;
}

export interface CoworkCrossSessionNormalizeSuccess {
  ok: true;
  sessionId: string;
}

export type CoworkCrossSessionNormalizeResult =
  | CoworkCrossSessionNormalizeSuccess
  | CoworkCrossSessionError;

export interface CoworkCrossSessionMessage {
  id: string;
  type: CoworkMessage['type'];
  content: string;
  timestamp: number;
  metadata: CoworkMessageMetadata | null;
}

export interface CoworkCrossSessionMetadata {
  id: string;
  title: string;
  status: CoworkSession['status'];
  pinned: boolean;
  sessionType: CoworkSessionType;
  hiddenFromSessionList: boolean;
  createdAt: number;
  updatedAt: number;
  metabotId: number | null;
  peerGlobalMetaId: string | null;
  peerName: string | null;
}

export interface CoworkCrossSessionReadAllSuccess {
  ok: true;
  session: CoworkCrossSessionMetadata;
  messages: CoworkCrossSessionMessage[];
}

export interface CoworkCrossSessionReadLatestSuccess {
  ok: true;
  session: CoworkCrossSessionMetadata;
  message: CoworkCrossSessionMessage | null;
}

export interface CoworkCrossSessionInsertSuccess {
  ok: true;
  sourceSessionId: string;
  targetSessionId: string;
  message: CoworkCrossSessionMessage;
  reused?: boolean;
}

export type CoworkCrossSessionReadAllResult =
  | CoworkCrossSessionReadAllSuccess
  | CoworkCrossSessionError;

export type CoworkCrossSessionReadLatestResult =
  | CoworkCrossSessionReadLatestSuccess
  | CoworkCrossSessionError;

export type CoworkCrossSessionInsertResult =
  | CoworkCrossSessionInsertSuccess
  | CoworkCrossSessionError;

export interface CoworkCrossSessionStore {
  getSession(sessionId: string): CoworkSession | null;
  getSessionMetadata(sessionId: string): CoworkStoreSessionMetadata | null;
  getSessionLatestMessage(sessionId: string): CoworkMessage | null;
  getSessionLatestVisibleMessage(sessionId: string): CoworkMessage | null;
  getMessageById?(sessionId: string, messageId: string): CoworkMessage | null;
  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage;
  addMessageWithId?(sessionId: string, id: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage;
}

const IDBOTS_SESSION_SCHEME = /^idbots:\/\//i;
const VALID_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function error(code: CoworkCrossSessionErrorCode, message: string): CoworkCrossSessionError {
  return { ok: false, code, message };
}

export function normalizeIdbotsSessionId(input: unknown): CoworkCrossSessionNormalizeResult {
  if (typeof input !== 'string') {
    return error('INVALID_SESSION_ID', 'Invalid IDBots session id.');
  }

  const trimmed = input.trim();
  const sessionId = trimmed.replace(IDBOTS_SESSION_SCHEME, '');
  if (!sessionId) {
    return error('INVALID_SESSION_ID', 'Invalid IDBots session id.');
  }
  if (sessionId.includes('/') || /\s/.test(sessionId) || !VALID_SESSION_ID_PATTERN.test(sessionId)) {
    return error('INVALID_SESSION_ID', 'Invalid IDBots session id.');
  }

  return { ok: true, sessionId };
}

export function formatIdbotsSessionLink(sessionId: string): string {
  const normalized = normalizeIdbotsSessionId(sessionId);
  if (normalized.ok) {
    return `IDBots://${normalized.sessionId}`;
  }
  return `IDBots://${String(sessionId ?? '').trim()}`;
}

function toSessionMetadata(session: CoworkSession | CoworkStoreSessionMetadata): CoworkCrossSessionMetadata {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    pinned: Boolean(session.pinned),
    sessionType: session.sessionType || 'standard',
    hiddenFromSessionList: Boolean(session.hiddenFromSessionList),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metabotId: session.metabotId ?? null,
    peerGlobalMetaId: session.peerGlobalMetaId ?? null,
    peerName: session.peerName ?? null,
  };
}

function toMessage(message: CoworkMessage): CoworkCrossSessionMessage {
  return {
    id: message.id,
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    metadata: message.metadata ?? null,
  };
}

/**
 * GT#12 N3: thinking drafts (metadata.isThinking=true) and unfinished
 * streaming placeholders (metadata.isStreaming=true) must never surface as
 * formal replies through session-history outputs. Storage stays untouched —
 * this filter lives on the external output layer only (the same layer the
 * IM push and UI rendering already filter on).
 */
function isExternallyVisibleMessage(message: CoworkMessage): boolean {
  if (message.metadata?.isThinking === true) {
    return false;
  }
  if (message.metadata?.isStreaming === true) {
    return false;
  }
  return true;
}

export class CoworkCrossSessionService {
  constructor(private readonly store: CoworkCrossSessionStore) {}

  readAll(input: { sessionId: string }): CoworkCrossSessionReadAllResult {
    const resolved = this.getExistingSession(input.sessionId);
    if (resolved.ok === false) {
      return resolved;
    }

    return {
      ok: true,
      session: toSessionMetadata(resolved.session),
      messages: resolved.session.messages.filter(isExternallyVisibleMessage).map(toMessage),
    };
  }

  readLatest(input: { sessionId: string }): CoworkCrossSessionReadLatestResult {
    const resolved = this.getExistingSessionMetadata(input.sessionId);
    if (resolved.ok === false) {
      return resolved;
    }

    const latestMessage = this.store.getSessionLatestVisibleMessage(resolved.sessionId);
    return {
      ok: true,
      session: toSessionMetadata(resolved.session),
      message: latestMessage ? toMessage(latestMessage) : null,
    };
  }

  insertUserMessage(input: {
    sourceSessionId: string;
    targetSessionId: string;
    message: string;
    deliveryId?: string;
    /**
     * Ask the host to report the dispatched turn's outcome back into the
     * SOURCE session when it settles (the [DISPATCH-REPORT] return path).
     * Stamped on the inserted message metadata; the durable delivery row
     * carries the same flag so drain replays keep it. Internal relays
     * (ORCH-NOTIFY, group-task acceptance) leave it unset — they have their
     * own terminal-state notification and must not be double-woken.
     */
    notifySource?: boolean;
  }): CoworkCrossSessionInsertResult {
    // P4 (v1.2): the host pseudo-source `group-task:<id>` (group-task
    // acceptance/review relay attribution, "哪里发起哪里结束") contains a
    // colon and has NO cowork_sessions row BY DESIGN — it failed BOTH the
    // strict id pattern and the source-row check, so the R2 seam rejected
    // every acceptance insert and the origin session never received the
    // close/review notices (task #23: notified_session empty, no kv guard).
    // `scheduled-task:<id>` (scheduler run reports, same attribution need)
    // joins the namespace: a run that failed before its session opened has no
    // worker session to attribute the report to. Recognize the synthetic
    // namespaces up front; every other source id keeps the strict
    // normalization + existence checks.
    const rawSource = String(input.sourceSessionId ?? '').trim().replace(IDBOTS_SESSION_SCHEME, '');
    const isHostPseudoSource = /^group-task:\d+$/.test(rawSource) || /^scheduled-task:[A-Za-z0-9._-]+$/.test(rawSource);
    const sourceId = isHostPseudoSource
      ? { ok: true as const, sessionId: rawSource }
      : normalizeIdbotsSessionId(input.sourceSessionId);
    if (sourceId.ok === false) {
      return sourceId;
    }
    const targetId = normalizeIdbotsSessionId(input.targetSessionId);
    if (targetId.ok === false) {
      return targetId;
    }

    if (sourceId.sessionId === targetId.sessionId) {
      return error('SOURCE_TARGET_SAME_SESSION', 'Source and target session ids must be different.');
    }

    if (!isHostPseudoSource) {
      const sourceSession = this.store.getSession(sourceId.sessionId);
      if (!sourceSession) {
        return error('SESSION_NOT_FOUND', `Source session not found: ${sourceId.sessionId}`);
      }
    }

    const targetSession = this.store.getSession(targetId.sessionId);
    if (!targetSession) {
      return error('SESSION_NOT_FOUND', `Target session not found: ${targetId.sessionId}`);
    }
    if (targetSession.sessionType === 'a2a') {
      return error('WRITE_NOT_ALLOWED_FOR_A2A', 'Cross-session user message insert is not allowed for A2A target sessions.');
    }

    const trimmedMessage = input.message.trim();
    if (!trimmedMessage) {
      return error('EMPTY_MESSAGE', 'Message must not be empty.');
    }
    if (trimmedMessage.length > CROSS_SESSION_INSERT_MAX_CHARS) {
      return error('MESSAGE_TOO_LONG', `Message must be ${CROSS_SESSION_INSERT_MAX_CHARS} characters or fewer.`);
    }

    const content = wrapCrossSessionMessage(sourceId.sessionId, trimmedMessage);
    const deliveryId = input.deliveryId?.trim() || null;
    const existing = deliveryId
      ? this.store.getMessageById?.(targetId.sessionId, deliveryId) ?? null
      : null;
    if (existing && existing.content !== content) {
      return error('DELIVERY_CONFLICT', `Delivery ${deliveryId} already names a different message.`);
    }
    if (existing) {
      return {
        ok: true,
        sourceSessionId: sourceId.sessionId,
        targetSessionId: targetId.sessionId,
        message: toMessage(existing),
        reused: true,
      };
    }

    const messageInput = {
      type: 'user' as const,
      content,
      metadata: {
        sourceChannel: 'idbots_cross_session',
        sourceSessionId: sourceId.sessionId,
        ...(deliveryId ? { crossSessionDeliveryId: deliveryId } : {}),
        ...(input.notifySource ? { crossSessionNotifySource: true } : {}),
      },
    };
    const message = deliveryId && this.store.addMessageWithId
      ? this.store.addMessageWithId(targetId.sessionId, deliveryId, messageInput)
      : this.store.addMessage(targetId.sessionId, messageInput);

    return {
      ok: true,
      sourceSessionId: sourceId.sessionId,
      targetSessionId: targetId.sessionId,
      message: toMessage(message),
      reused: false,
    };
  }

  private getExistingSession(rawSessionId: string): (
    | { ok: true; sessionId: string; session: CoworkSession }
    | CoworkCrossSessionError
  ) {
    const parsed = normalizeIdbotsSessionId(rawSessionId);
    if (parsed.ok === false) {
      return parsed;
    }

    const session = this.store.getSession(parsed.sessionId);
    if (!session) {
      return error('SESSION_NOT_FOUND', `Session not found: ${parsed.sessionId}`);
    }

    return {
      ok: true,
      sessionId: parsed.sessionId,
      session,
    };
  }

  private getExistingSessionMetadata(rawSessionId: string): (
    | { ok: true; sessionId: string; session: CoworkStoreSessionMetadata }
    | CoworkCrossSessionError
  ) {
    const parsed = normalizeIdbotsSessionId(rawSessionId);
    if (parsed.ok === false) {
      return parsed;
    }

    const session = this.store.getSessionMetadata(parsed.sessionId);
    if (!session) {
      return error('SESSION_NOT_FOUND', `Session not found: ${parsed.sessionId}`);
    }

    return {
      ok: true,
      sessionId: parsed.sessionId,
      session,
    };
  }
}
