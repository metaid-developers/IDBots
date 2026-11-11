import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  CoworkConfig,
  CoworkPermissionRequest,
  CoworkPermissionResult,
  CoworkSession,
} from '@/types/cowork';
import {
  CoworkSessionController,
  type CoworkActionResult,
  type CoworkResyncGuard,
  type CoworkResyncSnapshot,
  type CoworkSessionControllerSnapshot,
} from '@/services/coworkSessionController';
import {
  buildCoworkSessionStartOptions,
  resolveDefaultMetabotId,
} from '@/services/coworkSessionStart';
import { getMobileElectron, hasAppBridge } from '../appBridge';
import type { MockMetabot } from '../../bridge/types';
import { projectChatMessages } from '../chatProjection';
import {
  LLM_QUOTA_EXHAUSTED_CODE,
  quotaKindFromErrorText,
  INSUFFICIENT_ME_CODE,
  insufficientMeFromErrorText,
  type QuotaExhaustedKind,
} from '../quotaCodes';
import { useChatAttachments } from './useChatAttachments';
import type { MobileChatAttachment } from '@/services/coworkSessionDrafts';
import { t } from '../../i18n';

export type { ChatMessageView } from '../chatProjection';

export interface ChatPermissionView {
  request: CoworkPermissionRequest;
  responding: boolean;
}

export interface ChatToolCallView {
  requestId: string;
  toolName: string;
  status: 'pending';
  input: Record<string, unknown>;
}

export type ChatTurnPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'steering'
  | 'stopping'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'offline_unknown';

const EMPTY_SNAPSHOT: CoworkSessionControllerSnapshot = {
  states: new Map(),
  sessions: [],
  currentSessionId: null,
  attempts: [],
  drafts: {},
  actionErrors: {},
  streamErrors: {},
  respondingPermissionIds: new Set(),
  dismissedPermissionIds: new Set(),
  stoppingSessionIds: new Set(),
  uncertainSessionIds: new Set(),
  restoring: false,
  generation: 0,
  epoch: 0,
};

// Structured-first quota detection lives in ../quotaCodes (the single home of
// the machine code and of the one confined string fallback). Re-exported here
// so existing consumers keep their import path.
export { LLM_QUOTA_EXHAUSTED_CODE, quotaKindFromErrorText } from '../quotaCodes';
export type { QuotaExhaustedKind } from '../quotaCodes';

export interface QuotaExhaustedState {
  exhausted: boolean;
  kind: QuotaExhaustedKind | null;
}

/**
 * STRING-FALLBACK pathway (restore/resync only): re-derive the quota card
 * from a session detail whose payloads provably carry no structured code —
 * the persisted terminal `Error:` system row stores `metadata: { error }`
 * text only (coworkRunner.handleError), so the relay-code text match in
 * ../quotaCodes is all a reopened session has. The live path never routes
 * through here for detection; see deriveLiveQuotaExhausted.
 */
export function deriveQuotaExhaustedFromDetail(
  session: Pick<CoworkSession, 'status' | 'messages'> | null | undefined,
): QuotaExhaustedState {
  if (!session || session.status !== 'error') return { exhausted: false, kind: null };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isTerminalErrorRow(message)) {
      if (insufficientMeFromErrorText(message.content)) return { exhausted: true, kind: 'me' };
      const kind = quotaKindFromErrorText(message.content);
      return { exhausted: kind !== null, kind };
    }
  }
  return { exhausted: false, kind: null };
}

/**
 * STRUCTURED-FIRST live detection: a quota death is declared from the
 * machine code on the cowork:stream:error frame. Both the legacy relay codes
 * and the native ME-insufficiency code use the unified ME purchase surface.
 * Payloads without a structured code take the restore/resync fallback result
 * unchanged — live error copy is never parsed to invent a different kind.
 */
export function deriveLiveQuotaExhausted(
  state: Pick<CoworkSession, 'status'> | null | undefined,
  streamError: { code: string | null; text: string } | null | undefined,
  persisted: QuotaExhaustedState,
): QuotaExhaustedState {
  if (state?.status === 'error' && streamError?.code === INSUFFICIENT_ME_CODE) {
    return { exhausted: true, kind: 'me' };
  }
  if (state?.status === 'error' && streamError?.code === LLM_QUOTA_EXHAUSTED_CODE) {
    return {
      exhausted: true,
      kind: quotaKindFromErrorText(streamError.text) ?? persisted.kind ?? 'me',
    };
  }
  return persisted;
}

function isTerminalErrorRow(message: { type?: unknown; content?: unknown } | null | undefined): message is { type: 'system'; content: string } {
  return (
    message !== null
    && typeof message === 'object'
    && message.type === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith('Error:')
  );
}

function createController(): CoworkSessionController | null {
  if (!hasAppBridge()) return null;
  let storage: Storage | null = null;
  try {
    storage = typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    storage = null;
  }
  return new CoworkSessionController({ electron: getMobileElectron(), storage });
}

export function useChat(bots: MockMetabot[] = []) {
  const [controller, setController] = useState<CoworkSessionController | null>(null);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [metabotId, setMetabotId] = useState<number | null>(null);
  const [quotaDismissedSession, setQuotaDismissedSession] = useState<string | null>(null);
  const configRef = useRef<Pick<CoworkConfig, 'workingDirectory' | 'systemPrompt'> | null>(null);
  const restoreStartedRef = useRef(false);

  useEffect(() => {
    const instance = createController();
    setController(instance);
    return () => instance?.destroy();
  }, []);

  useEffect(() => {
    if (!controller) return undefined;
    const unsubscribe = controller.subscribe(refresh);
    return () => unsubscribe();
  }, [controller]);

  useEffect(() => {
    if (!controller) return;
    void getMobileElectron().cowork.getConfig().then((result) => {
      if (result?.success && result.config) configRef.current = result.config;
    }).catch(() => undefined);
  }, [controller]);

  useEffect(() => {
    setMetabotId((current) => resolveDefaultMetabotId(bots, current));
  }, [bots]);

  useEffect(() => {
    if (!controller || metabotId === null || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    void controller.restore(metabotId, {
      title: t('mobile.chat.greetingTitle'),
      fallbackGreeting: t('mobile.chat.greetingFallback'),
      cwd: configRef.current?.workingDirectory,
      systemPrompt: configRef.current?.systemPrompt,
    });
  }, [controller, metabotId]);

  const snapshot = controller?.getSnapshot() ?? EMPTY_SNAPSHOT;
  const sessionId = snapshot.currentSessionId;
  const attachmentUploads = useChatAttachments(controller, sessionId);
  const state = sessionId ? snapshot.states.get(sessionId) : undefined;
  const messages = useMemo(() => projectChatMessages(state?.messages ?? []), [state?.messages]);
  const attempts = useMemo(
    () => snapshot.attempts.filter((attempt) => attempt.sessionId === sessionId),
    [snapshot.attempts, sessionId],
  );
  const pendingPermissions = state?.pendingPermissions ?? [];
  const permissionRequest = pendingPermissions.find(
    (request) => !snapshot.dismissedPermissionIds.has(request.requestId),
  );
  const permission: ChatPermissionView | null = permissionRequest
    ? {
        request: permissionRequest,
        responding: snapshot.respondingPermissionIds.has(permissionRequest.requestId),
      }
    : null;
  const toolCalls: ChatToolCallView[] = pendingPermissions.map((request) => ({
    requestId: request.requestId,
    toolName: request.toolName,
    status: 'pending',
    input: request.toolInput,
  }));

  const isStopping = sessionId ? snapshot.stoppingSessionIds.has(sessionId) : false;
  const isSending = attempts.some((attempt) => attempt.status === 'sending');
  const isStreaming = state?.status === 'running' || isStopping;
  const turnPhase: ChatTurnPhase = isStopping
    ? 'stopping'
    : attempts.some((attempt) => attempt.status === 'sending' && attempt.kind === 'start')
      ? 'starting'
      : attempts.some((attempt) => attempt.status === 'sending')
        ? 'steering'
        : sessionId && snapshot.uncertainSessionIds.has(sessionId)
          ? 'offline_unknown'
          : pendingPermissions.length > 0
            ? 'waiting_permission'
            : state?.status === 'running'
              ? 'running'
              : state?.status === 'error'
                ? 'error'
                : state?.status === 'stopped'
                  ? 'cancelled'
                  : state?.status === 'completed' || state?.status === 'idle'
                    ? 'completed'
                    : 'idle';

  const streamError = sessionId ? snapshot.streamErrors[sessionId] : undefined;
  const persistedQuota = deriveQuotaExhaustedFromDetail(state);
  const liveQuota = deriveLiveQuotaExhausted(state, streamError, persistedQuota);
  const quotaExhausted = liveQuota.exhausted && quotaDismissedSession !== sessionId;
  const quotaKind = liveQuota.kind;

  useEffect(() => {
    setQuotaDismissedSession(null);
  }, [sessionId]);
  useEffect(() => {
    if (state?.status === 'running') setQuotaDismissedSession(null);
  }, [state?.status]);

  const send = useCallback(async (
    text: string,
    attachments: MobileChatAttachment[] = [],
  ): Promise<CoworkActionResult> => {
    if (!controller) return { status: 'failed', error: t('mobile.bridge.unavailableBody') };
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return { status: 'failed', error: t('mobile.chat.emptyMessage') };
    }
    if (!sessionId && metabotId === null) {
      return { status: 'failed', error: t('mobile.chat.twinUnavailable') };
    }
    const title = trimmed
      ? trimmed.split('\n')[0]!.slice(0, 50)
      : attachments[0]?.name.slice(0, 50) || t('mobile.chat.attachmentTitle');
    const startOptions = metabotId === null
      ? { title }
      : buildCoworkSessionStartOptions({ metabotId, title, config: configRef.current });
    return controller.send(text, startOptions, attachments, t('mobile.chat.inputFile'));
  }, [controller, metabotId, sessionId]);

  const openSession = useCallback(async (id: string): Promise<boolean> => (
    controller?.openSession(id) ?? false
  ), [controller]);

  // -------------------------------------------------------------------------
  // Session management (drawer rename/delete, 2026-11-02).
  //
  // Both go through the allowlisted cowork channels (ipc-contract.json):
  //   - rename  -> cowork.renameSession({ sessionId, title }) — real,
  //     server-side title change, same channel the desktop sidebar uses;
  //   - "delete" -> cowork.archiveSession(sessionId) — there is NO hard-delete
  //     channel in the allowlist (desktop cowork.ts: "Hard delete is
  //     intentionally not exposed to users"), so the drawer's delete ARCHIVES:
  //     the row leaves the list, the record survives (dream/experience still
  //     see it) and Settings -> Archived Chats can restore it. Documented in
  //     the drawer UI and the tests.
  // The real gateway shim exposes both generically from the contract; the
  // mock bridge implements them with the same semantics.
  // -------------------------------------------------------------------------
  const renameSession = useCallback(async (id: string, title: string): Promise<boolean> => {
    const normalized = title.trim();
    if (!normalized) return false;
    const cowork = hasAppBridge() ? getMobileElectron().cowork : undefined;
    if (!cowork?.renameSession) return false;
    try {
      const result = await cowork.renameSession({ sessionId: id, title: normalized });
      if (!result?.success) return false;
    } catch {
      return false;
    }
    await controller?.reloadSessions();
    if (id === sessionId) await controller?.refreshSession(id);
    return true;
  }, [controller, sessionId]);

  const archiveSession = useCallback(async (id: string): Promise<boolean> => {
    const cowork = hasAppBridge() ? getMobileElectron().cowork : undefined;
    if (!cowork?.archiveSession) return false;
    try {
      const result = await cowork.archiveSession(id);
      if (!result?.success) return false;
    } catch {
      return false;
    }
    // Archiving the open session leaves the chat surface — the mobile
    // equivalent of the desktop "navigate home" after archive.
    if (id === sessionId) controller?.newChat();
    await controller?.reloadSessions();
    return true;
  }, [controller, sessionId]);

  const applyResync = useCallback((resync: CoworkResyncSnapshot): void => {
    controller?.applyResync(resync);
  }, [controller]);

  const beginResync = useCallback((): CoworkResyncGuard => (
    controller?.beginResync() ?? { generation: 0, epoch: 0, messageRevisions: {} }
  ), [controller]);

  const respondPermission = useCallback(async (result: CoworkPermissionResult): Promise<CoworkActionResult> => {
    if (!controller || !permissionRequest) {
      return { status: 'failed', error: t('mobile.chat.permissionUnavailable') };
    }
    return controller.respondPermission(permissionRequest.requestId, result);
  }, [controller, permissionRequest]);

  return {
    messages,
    sessions: snapshot.sessions,
    sessionId,
    sessionTitle: state?.title ?? null,
    metabotId,
    isStreaming,
    isSending,
    turnPhase,
    permission,
    pendingPermissionCount: pendingPermissions.length,
    toolCalls,
    quotaExhausted,
    quotaKind,
    draft: controller?.getDraft() ?? '',
    attachments: controller?.getAttachments() ?? [],
    ...attachmentUploads,
    removeAttachment: (path: string) => {
      if (controller) controller.removeAttachment(controller.getDraftToken(), path);
    },
    attempts,
    actionError: snapshot.actionErrors[sessionId ?? 'new']
      ?? attempts.slice().reverse().find((attempt) => attempt.error)?.error
      ?? null,
    restoring: snapshot.restoring,
    hasMoreHistory: state?.messageHistory?.hasMoreBefore === true,
    setMetabotId,
    setDraft: (text: string) => controller?.setDraft(text),
    reloadSessions: async (): Promise<void> => { await controller?.reloadSessions(); },
    openSession,
    renameSession,
    archiveSession,
    newChat: () => controller?.newChat(),
    send,
    stop: async (): Promise<CoworkActionResult> => (
      controller?.stop() ?? { status: 'failed', error: t('mobile.bridge.unavailableBody') }
    ),
    respondPermission,
    dismissPermission: () => {
      if (permissionRequest) controller?.dismissPermission(permissionRequest.requestId);
    },
    reopenPermissions: () => controller?.reopenPermissions(),
    dismissQuota: () => setQuotaDismissedSession(sessionId),
    retrySubmission: async (submissionId: string) => (
      controller?.retrySubmission(submissionId) ?? { status: 'failed', error: t('mobile.bridge.unavailableBody') }
    ),
    reconcileSubmission: async (submissionId: string) => (
      controller?.reconcileSubmission(submissionId) ?? { status: 'failed', error: t('mobile.bridge.unavailableBody') }
    ),
    discardSubmission: (submissionId: string) => controller?.discardSubmission(submissionId),
    loadEarlierMessages: async (): Promise<boolean> => controller?.loadEarlierMessages() ?? false,
    applyResync,
    beginResync,
    getOpenSessionId: (): string | null => controller?.getOpenSessionId() ?? null,
    getStreamingMessage: (): { sessionId: string; messageId: string } | null => (
      controller?.getStreamingMessage() ?? null
    ),
  };
}
