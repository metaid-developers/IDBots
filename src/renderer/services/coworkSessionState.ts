import type {
  CoworkMessage,
  CoworkMessageHistoryState,
  CoworkPermissionRequest,
  CoworkSession,
  CoworkSessionStatus,
} from '../types/cowork';

export interface CoworkSessionEventState {
  id: string;
  title: string | null;
  status: CoworkSessionStatus;
  metabotId: number | null;
  messages: CoworkMessage[];
  messageHistory?: CoworkMessageHistoryState;
  pendingPermissions: CoworkPermissionRequest[];
  messageRevisions: Record<string, number>;
  revision: number;
  lastSequence: number | null;
  unread: boolean;
  updatedAt: number;
}

export type CoworkSessionEvent =
  | { type: 'message'; sessionId: string; message: CoworkMessage }
  | {
      type: 'content';
      sessionId: string;
      messageId: string;
      content?: string;
      metadata?: CoworkMessage['metadata'];
    }
  | { type: 'permission'; sessionId: string; request: CoworkPermissionRequest }
  | { type: 'permissionResolved'; sessionId: string; requestId: string }
  | { type: 'complete'; sessionId: string }
  | { type: 'error'; sessionId: string }
  | { type: 'title'; sessionId: string; title: string };

export interface CoworkSessionEventResult {
  state: CoworkSessionEventState;
  sequenceGap: boolean;
  missingMessage: boolean;
}

export interface CoworkSnapshotMergeOptions {
  baseMessageRevisions?: Readonly<Record<string, number>>;
  preserveMissingMessages?: boolean;
}

const messageSequence = (message: CoworkMessage): number | null => (
  typeof message.sequence === 'number' && Number.isFinite(message.sequence) && message.sequence > 0
    ? message.sequence
    : null
);

const tailSequence = (messages: CoworkMessage[]): number | null => {
  let tail: number | null = null;
  for (const message of messages) {
    const sequence = messageSequence(message);
    if (sequence !== null && (tail === null || sequence > tail)) tail = sequence;
  }
  return tail;
};

const settleStreamingMessages = (messages: CoworkMessage[]): CoworkMessage[] => {
  let changed = false;
  const next = messages.map((message) => {
    if (!message.metadata?.isStreaming) return message;
    changed = true;
    return {
      ...message,
      metadata: { ...message.metadata, isStreaming: false },
    };
  });
  return changed ? next : messages;
};

function isAcknowledgedOptimisticMessage(message: CoworkMessage, incoming: CoworkMessage): boolean {
  const submissionId = incoming.metadata?.submissionId;
  return typeof submissionId === 'string' && submissionId.length > 0
    && message.id === `local-${submissionId}`
    && message.metadata?.optimistic === true
    && message.metadata.submissionId === submissionId;
}

export function upsertCoworkMessage(
  messages: CoworkMessage[],
  incoming: CoworkMessage,
): { messages: CoworkMessage[]; added: boolean } {
  const index = messages.findIndex((message) => (
    message.id === incoming.id || isAcknowledgedOptimisticMessage(message, incoming)
  ));
  if (index < 0) return { messages: [...messages, incoming], added: true };
  if (messages[index] === incoming) return { messages, added: false };
  const next = [...messages];
  next[index] = incoming;
  return { messages: next, added: false };
}

export function updateCoworkMessage(
  messages: CoworkMessage[],
  messageId: string,
  update: { content?: string; metadata?: CoworkMessage['metadata'] },
): CoworkMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return messages;
  const message = messages[index]!;
  if (update.content === undefined && update.metadata === undefined) return messages;
  const next = [...messages];
  next[index] = {
    ...message,
    ...(update.content !== undefined ? { content: update.content } : {}),
    ...(update.metadata !== undefined
      ? { metadata: { ...(message.metadata ?? {}), ...update.metadata } }
      : {}),
  };
  return next;
}

export function mergeCoworkSnapshotMessages(
  existing: CoworkMessage[],
  incoming: CoworkMessage[],
  messageRevisions: Readonly<Record<string, number>> = {},
  options: CoworkSnapshotMergeOptions = {},
): CoworkMessage[] {
  const existingById = new Map(existing.map((message) => [message.id, message]));
  const incomingIds = new Set(incoming.map((message) => message.id));
  let firstIncomingSequence: number | null = null;
  for (const message of incoming) {
    const sequence = messageSequence(message);
    if (sequence !== null && (firstIncomingSequence === null || sequence < firstIncomingSequence)) {
      firstIncomingSequence = sequence;
    }
  }
  const baseRevisions = options.baseMessageRevisions ?? {};
  const isNewerLiveMessage = (id: string): boolean => (
    (messageRevisions[id] ?? 0) > (baseRevisions[id] ?? 0)
  );

  const merged = incoming.map((message) => {
    const prior = existingById.get(message.id);
    if (!prior) return message;
    const liveChanged = isNewerLiveMessage(message.id)
      || (options.baseMessageRevisions === undefined && prior.metadata?.isStreaming === true);
    return liveChanged ? prior : message;
  });

  const retainedEarlier: CoworkMessage[] = [];
  const retainedTail: CoworkMessage[] = [];
  for (const message of existing) {
    if (incomingIds.has(message.id)) continue;
    if (incoming.some((incomingMessage) => isAcknowledgedOptimisticMessage(message, incomingMessage))) continue;
    const isLocal = message.id.startsWith('local-');
    const isLive = isNewerLiveMessage(message.id)
      || (options.baseMessageRevisions === undefined && message.metadata?.isStreaming === true);
    const sequence = messageSequence(message);
    const isEarlierHistory = sequence !== null && firstIncomingSequence !== null && sequence < firstIncomingSequence;
    if ((options.preserveMissingMessages || isEarlierHistory) && !isLocal && !isLive) retainedEarlier.push(message);
    else if (isLocal || isLive) retainedTail.push(message);
  }
  return [...retainedEarlier, ...merged, ...retainedTail];
}

export function createCoworkSessionEventState(
  sessionId: string,
  session?: CoworkSession | null,
): CoworkSessionEventState {
  const messages = session?.messages ? [...session.messages] : [];
  return {
    id: sessionId,
    title: session?.title ?? null,
    status: session?.status ?? 'idle',
    metabotId: session?.metabotId ?? null,
    messages,
    ...(session?.messageHistory ? { messageHistory: session.messageHistory } : {}),
    pendingPermissions: [],
    messageRevisions: {},
    revision: 0,
    lastSequence: tailSequence(messages),
    unread: false,
    updatedAt: session?.updatedAt ?? 0,
  };
}

export function applyCoworkSessionSnapshot(
  state: CoworkSessionEventState,
  session: CoworkSession,
  options: CoworkSnapshotMergeOptions = {},
): CoworkSessionEventState {
  const messages = mergeCoworkSnapshotMessages(
    state.messages,
    session.messages ?? [],
    state.messageRevisions,
    options,
  );
  return {
    ...state,
    title: session.title ?? state.title,
    status: session.status,
    metabotId: session.metabotId ?? state.metabotId,
    messages,
    ...(session.messageHistory ? { messageHistory: session.messageHistory } : {}),
    lastSequence: tailSequence(messages),
    updatedAt: session.updatedAt ?? state.updatedAt,
  };
}

export function applyCoworkSessionEvent(
  state: CoworkSessionEventState,
  event: CoworkSessionEvent,
): CoworkSessionEventResult {
  if (event.sessionId !== state.id) {
    return { state, sequenceGap: false, missingMessage: false };
  }

  if (event.type === 'message') {
    const incoming = event.message;
    const upserted = upsertCoworkMessage(state.messages, incoming);
    const exists = !upserted.added;
    const sequence = messageSequence(incoming);
    const sequenceGap = sequence !== null && state.lastSequence !== null && sequence > state.lastSequence + 1;
    const messages = upserted.messages;
    const revision = exists ? state.revision : state.revision + 1;
    const messageRevisions = exists
      ? state.messageRevisions
      : { ...state.messageRevisions, [incoming.id]: revision };
    const isUserTurn = incoming.type === 'user';
    return {
      state: {
        ...state,
        status: isUserTurn && incoming.metadata?.suppressRunningStatus !== true ? 'running' : state.status,
        messages,
        messageRevisions,
        revision,
        lastSequence: sequence !== null && (state.lastSequence === null || sequence > state.lastSequence)
          ? sequence
          : state.lastSequence,
        unread: true,
        updatedAt: isUserTurn ? incoming.timestamp : state.updatedAt,
      },
      sequenceGap,
      missingMessage: false,
    };
  }

  if (event.type === 'content') {
    const exists = state.messages.some((message) => message.id === event.messageId);
    if (!exists) {
      return { state, sequenceGap: false, missingMessage: true };
    }
    const revision = state.revision + 1;
    return {
      state: {
        ...state,
        messages: updateCoworkMessage(state.messages, event.messageId, {
          ...(event.content !== undefined ? { content: event.content } : {}),
          ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
        }),
        messageRevisions: { ...state.messageRevisions, [event.messageId]: revision },
        revision,
        unread: true,
      },
      sequenceGap: false,
      missingMessage: false,
    };
  }

  if (event.type === 'permission') {
    const exists = state.pendingPermissions.some((request) => request.requestId === event.request.requestId);
    return {
      state: {
        ...state,
        pendingPermissions: exists
          ? state.pendingPermissions
          : [...state.pendingPermissions, event.request],
        unread: true,
      },
      sequenceGap: false,
      missingMessage: false,
    };
  }

  if (event.type === 'permissionResolved') {
    return {
      state: {
        ...state,
        pendingPermissions: state.pendingPermissions.filter(
          (request) => request.requestId !== event.requestId,
        ),
      },
      sequenceGap: false,
      missingMessage: false,
    };
  }

  if (event.type === 'title') {
    return {
      state: { ...state, title: event.title },
      sequenceGap: false,
      missingMessage: false,
    };
  }

  const status: CoworkSessionStatus = event.type === 'complete' ? 'completed' : 'error';
  return {
    state: {
      ...state,
      status,
      messages: settleStreamingMessages(state.messages),
      unread: true,
    },
    sequenceGap: false,
    missingMessage: false,
  };
}

export function markCoworkSessionRead(
  state: CoworkSessionEventState,
): CoworkSessionEventState {
  return state.unread ? { ...state, unread: false } : state;
}
