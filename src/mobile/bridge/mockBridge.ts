/**
 * Mobile mock bridge (REQ-E-8).
 *
 * Backs `window.electron` with fixtures and timers so the mobile app and its
 * test suite run without a tenant or gateway. Enabled by VITE_MOBILE_MOCK=1
 * through installMockBridge.ts; tests construct the bridge directly with
 * shrunk delays.
 *
 * The invoke surface mirrors `IElectronAPI` in
 * src/renderer/types/electron.d.ts and the event payloads mirror what the
 * desktop main process sends (consumed by
 * src/renderer/services/cowork.ts and
 * src/renderer/services/coworkStreamReassembly.ts):
 *
 *   - cowork.onStreamMessage        <- 'cowork:stream:message'      { sessionId, message }
 *   - cowork.onStreamMessageUpdate  <- 'cowork:stream:messageUpdate' { sessionId, messageId, content|delta+baseLength, metadata? }
 *   - cowork.onStreamPermission     <- 'cowork:stream:permission'    { sessionId, request: CoworkPermissionRequest }
 *   - cowork.onStreamPermissionResolved <- 'cowork:stream:permissionResolved' { requestId }
 *   - cowork.onStreamComplete       <- 'cowork:stream:complete'      { sessionId, claudeSessionId }
 *   - cowork.onStreamError          <- 'cowork:stream:error'         { sessionId, error, metadata? }
 *   - scheduledTasks.onRunUpdate    <- 'scheduledTask:runUpdate'     { run }
 *   - scheduledTasks.onStatusUpdate <- 'scheduledTask:statusUpdate'  { taskId, state }
 *
 * Payload simplifications vs the desktop main process (documented per REQ-E-8):
 *   - 'cowork:stream:error' carries an optional `metadata.errorCode` for
 *     the LLM_QUOTA_EXHAUSTED scenario (WS-A REQ-A-25): the runner stamps
 *     it on the ERROR frame together with the persisted `Error: …` system
 *     row, so the mobile recharge card keys off it without parsing the text.
 *   - Stream deltas are emitted on a fixed timer instead of model-paced flush
 *     batches; the { delta, baseLength } wire shape is identical, so the real
 *     CoworkStreamReassembler consumes them unchanged.
 *   - The permission request fixture uses toolName 'write_file' with a fixed
 *     /data/workspace path instead of a live tool call.
 */

import type {
  BundleChannelAPI,
  BundleMeters,
  BundlePlan,
  ConnectionState,
  MetabotCreateInput,
  MetabotUpdateInput,
  MetabotFallbackInput,
  MobileMockBridge,
  MobileMockCoworkStreamChannel,
  MobileMetabot,
  MockBridgeOptions,
  MockBundleOrder,
  MockElectronAPI,
  MockSkill,
  OfflineError,
  PendingPermissionRequest,
  Schedule,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskMemoryAccess,
  ScheduledTaskRun,
} from './types';
import { selectFileOnPhone, type PhoneFileSelectionOptions } from './installShim';
import { uploadFile, type UploadTransport } from './upload';
import { getMockArtifact, MOCK_ARTIFACT_PATHS } from './mockArtifacts';
import { applyLongTermStage, createLongTermFixture, longTermBoard } from './backgroundFixtures';

const DEFAULT_STREAM_TOKEN_INTERVAL_MS = 40;
const DEFAULT_ORDER_COMPLETE_DELAY_MS = 10_000;
const DEFAULT_RECONNECT_BLACKOUT_MS = 3_000;
const DEFAULT_SCHEDULED_RUN_DELAY_MS = 15_000;
const DEFAULT_MANUAL_RUN_DELAY_MS = 4_000;

/** Fixture bytes credited by a successful traffic.redeemCode (5 GB). */
const REDEEM_CODE_GRANT_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Valid memory-access opt-ins for scheduled tasks (mirrors the main-process
 * SCHEDULED_TASK_MEMORY_ACCESS_LEVELS; 'none' = legacy full blackout).
 */
const SCHEDULED_TASK_MEMORY_ACCESS_OPTIONS: ScheduledTaskMemoryAccess[] = [
  'none',
  'read-only',
  'read-write',
];

/** Canned assistant replies (mock model output; not UI copy). */
const REPLY_NORMAL =
  '**Mock bridge online.**\n\nEvery reply in this demo is streamed token by token through the same `cowork:stream:*` events the desktop renderer consumes.\n\nTry typing a message containing `permission` or `quota` to exercise the other scenarios.';
const REPLY_PERMISSION_PART1 =
  'Sure — before I can demonstrate the tool call, this session needs your approval.\n\n';
const REPLY_PERMISSION_PART2 =
  '\n\nApproved — the write completed. This is the tail of the reply after the permission resolved.';
const REPLY_PERMISSION_DENIED =
  '\n\nDenied — the tool call was rejected, so I skipped it and continued without changes.';
const REPLY_QUOTA_PREFIX =
  'Let me check your remaining quota first';

const REPLY_ARTIFACT = `**Mock artifacts ready.**\n\n[chart.png](${MOCK_ARTIFACT_PATHS.image})\n[report.pdf](${MOCK_ARTIFACT_PATHS.pdf})\n[notes.md](${MOCK_ARTIFACT_PATHS.markdown})\n[refresh.md](${MOCK_ARTIFACT_PATHS.refresh})\n[result.txt](${MOCK_ARTIFACT_PATHS.text})`;

/** Canned replies, exported for the mock-bridge tests. */
export const MOCK_CANNED_REPLIES = {
  normal: REPLY_NORMAL,
  artifact: REPLY_ARTIFACT,
  permissionPart1: REPLY_PERMISSION_PART1,
  permissionPart2: REPLY_PERMISSION_PART2,
  permissionDenied: REPLY_PERMISSION_DENIED,
  quotaPrefix: REPLY_QUOTA_PREFIX,
} as const;

const MOCK_WORKSPACE = '/data/workspace';

function createMockUploadTransport(): UploadTransport {
  let uploadSequence = 0;
  return {
    async upload(request) {
      const name = new URL(request.url, 'https://mock.invalid').searchParams.get('name') ?? 'file';
      if (name.startsWith('fixture-quota')) return { status: 507, body: 'fixture quota exhausted' };
      if (name.startsWith('fixture-network')) throw new Error('fixture network failure');
      if (/\.(exe|dll|bat|sh)$/i.test(name)) return { status: 415, body: 'fixture blocked type' };
      if (name.startsWith('fixture-slow')) await sleep(2_000);
      request.onProgress?.(request.body.size, request.body.size);
      const basename = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001F\u007F]/g, '').trim() || 'file';
      uploadSequence += 1;
      return {
        status: 200,
        body: JSON.stringify({
          path: `${MOCK_WORKSPACE}/uploads/mock-${uploadSequence}-${basename}`,
          size: request.body.size,
          mime: request.body.type || 'application/octet-stream',
        }),
      };
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeOfflineError(): OfflineError {
  const error = new Error('mock: connection lost (offline), retry when back online') as OfflineError;
  error.code = 'OFFLINE';
  error.retryable = true;
  return error;
}

interface MockCoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface MockCoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  activeSkillIds: string[];
  messages: MockCoworkMessage[];
  createdAt: number;
  updatedAt: number;
  metabotId: number | null;
  model: string | null;
  modelProvider: string | null;
  sessionType: 'standard' | 'longterm';
  autoOrigin: 'schedule' | null;
}

/** Splits text into fixed-size chunks so deltas exercise baseLength accounting. */
function splitChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

class ChannelEmitter {
  private listeners = new Map<string, Set<(...args: never[]) => void>>();

  on(channel: string, callback: (...args: never[]) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(channel);
    };
  }

  emit(channel: string, ...args: unknown[]): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const callback of [...set]) {
      try {
        (callback as (...args: unknown[]) => void)(...args);
      } catch {
        // Listener exceptions must not break the mock's emit loop.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Returns a rejecting stand-in for every method not explicitly implemented. */
function stubNamespace(name: string, impl: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      return (..._args: unknown[]) => Promise.reject(new Error(`mock: ${name}:${prop} not implemented`));
    },
  });
}

function stubFunction(channel: string): (...args: unknown[]) => Promise<never> {
  return (..._args: unknown[]) => Promise.reject(new Error(`mock: ${channel} not implemented`));
}

export function createMobileMockBridge(options: MockBridgeOptions = {}): MobileMockBridge {
  const streamTokenIntervalMs = options.streamTokenIntervalMs ?? DEFAULT_STREAM_TOKEN_INTERVAL_MS;
  const orderCompleteDelayMs = options.orderCompleteDelayMs ?? DEFAULT_ORDER_COMPLETE_DELAY_MS;
  const reconnectBlackoutMs = options.reconnectBlackoutMs ?? DEFAULT_RECONNECT_BLACKOUT_MS;
  const scheduledRunDelayMs = options.scheduledRunDelayMs ?? DEFAULT_SCHEDULED_RUN_DELAY_MS;
  const manualRunDelayMs = options.manualRunDelayMs ?? DEFAULT_MANUAL_RUN_DELAY_MS;

  const emitter = new ChannelEmitter();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  let destroyed = false;
  let connectionState: ConnectionState = 'online';
  const openedUrls: string[] = [];
  const mockUploadTransport = createMockUploadTransport();

  /** Invokes made while "disconnected" reject with an offline error (REQ-E-2 semantics). */
  const guardOnline = <T>(fn: () => Promise<T>): Promise<T> =>
    connectionState === 'online' ? fn() : Promise.reject(makeOfflineError());

  const waitWhileOffline = async (): Promise<void> => {
    while (connectionState !== 'online' && !destroyed) {
      await sleep(5);
    }
  };

  // ---------------------------------------------------------------- sessions
  const sessions = new Map<string, MockCoworkSession>();
  // Archived rows (archiveSession): hidden from the active list, restorable
  // via unarchiveSession — mirrors the main-process reversibility contract
  // ("hard delete is intentionally not exposed").
  const archivedSessions = new Map<string, MockCoworkSession>();
  const liveMessages = new Map<string, MockCoworkMessage>(); // key: sessionId + messageId
  let sessionSeq = 0;
  let messageSeq = 0;
  const now = () => Date.now();
  const nextSessionId = () => `mock-session-${++sessionSeq}`;
  const nextMessageId = () => `mock-msg-${++messageSeq}`;
  const streamKey = (sessionId: string, messageId: string) => `${sessionId}${messageId}`;

  function summaryOf(session: MockCoworkSession) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      pinned: session.pinned,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      metabotId: session.metabotId,
      sessionType: session.sessionType,
      autoOrigin: session.autoOrigin,
    };
  }

  function mockBotBrain(metabotId: number | null | undefined): { model: string | null; modelProvider: string | null } {
    const bot = metabotFixtures.find((entry) => entry.id === metabotId);
    return { model: bot?.llm_id ?? null, modelProvider: bot?.llm_provider ?? null };
  }

  function createSession(input: {
    title: string;
    prompt: string;
    metabotId?: number | null;
    model?: string | null;
    modelProvider?: string | null;
    autoOrigin?: MockCoworkSession['autoOrigin'];
    sessionType?: MockCoworkSession['sessionType'];
  }): MockCoworkSession {
    const ts = now();
    const session: MockCoworkSession = {
      id: nextSessionId(),
      title: input.title,
      claudeSessionId: `claude-${input.title}`,
      status: 'idle',
      pinned: false,
      cwd: MOCK_WORKSPACE,
      systemPrompt: '',
      executionMode: 'auto',
      activeSkillIds: [],
      messages: [],
      createdAt: ts,
      updatedAt: ts,
      metabotId: input.metabotId ?? null,
      model: input.model ?? null,
      modelProvider: input.modelProvider ?? null,
      sessionType: input.sessionType ?? 'standard',
      autoOrigin: input.autoOrigin ?? null,
    };
    sessions.set(session.id, session);
    return session;
  }

  function pushUserMessage(session: MockCoworkSession, text: string): MockCoworkMessage {
    const message: MockCoworkMessage = {
      id: nextMessageId(),
      type: 'user',
      content: text,
      timestamp: now(),
    };
    session.messages.push(message);
    session.updatedAt = now();
    return message;
  }

  function completeArtifactSession(session: MockCoworkSession, prompt: string): void {
    pushUserMessage(session, prompt);
    session.messages.push({
      id: nextMessageId(),
      type: 'assistant',
      content: REPLY_ARTIFACT,
      timestamp: now(),
      metadata: { isFinal: true },
    });
    session.status = 'completed';
    session.updatedAt = now();
  }

  // ------------------------------------------------------------- permissions
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const permissionWaiters = new Map<string, (decision: 'allow' | 'deny' | 'destroyed') => void>();
  let requestSeq = 0;

  // ----------------------------------------------------------- chat scenario
  const QUOTA_ERROR_CODE = 'LLM_QUOTA_EXHAUSTED';

  async function streamChunks(
    session: MockCoworkSession,
    message: MockCoworkMessage,
    text: string,
  ): Promise<void> {
    const chunks = splitChunks(text, 4);
    const key = streamKey(session.id, message.id);
    for (let i = 0; i < chunks.length; i += 1) {
      await waitWhileOffline();
      if (destroyed) return;
      await sleep(streamTokenIntervalMs);
      if (destroyed) return;
      // stopSession flips the session back to idle; honor it like a real
      // kernel abort and stop emitting for this turn.
      if (session.status !== 'running') return;
      const accumulated = (liveMessages.get(key)?.content ?? '');
      if (i === 0) {
        message.content = chunks[0];
        liveMessages.set(key, message);
        emitter.emit('cowork:stream:messageUpdate', {
          sessionId: session.id,
          messageId: message.id,
          content: chunks[0],
        });
      } else {
        message.content = accumulated + chunks[i];
        emitter.emit('cowork:stream:messageUpdate', {
          sessionId: session.id,
          messageId: message.id,
          delta: chunks[i],
          baseLength: accumulated.length,
        });
      }
    }
  }

  async function runAssistantTurn(session: MockCoworkSession, userText: string): Promise<void> {
    const assistantMessage: MockCoworkMessage = {
      id: nextMessageId(),
      type: 'assistant',
      content: '',
      timestamp: now(),
    };
    session.messages.push(assistantMessage);
    session.status = 'running';
    session.updatedAt = now();
    emitter.emit('cowork:stream:message', { sessionId: session.id, message: { ...assistantMessage } });

    const wantsQuota = /quota/i.test(userText);
    const wantsPermission = !wantsQuota && /permission/i.test(userText);
    const wantsArtifacts = !wantsQuota && !wantsPermission && /artifact|preview/i.test(userText);

    if (wantsQuota) {
      await streamChunks(session, assistantMessage, REPLY_QUOTA_PREFIX);
    } else if (wantsPermission) {
      await streamChunks(session, assistantMessage, REPLY_PERMISSION_PART1);
    } else if (wantsArtifacts) {
      await streamChunks(session, assistantMessage, REPLY_ARTIFACT);
    } else {
      await streamChunks(session, assistantMessage, REPLY_NORMAL);
    }
    if (destroyed) return;

    if (wantsPermission) {
      const request = {
        sessionId: session.id,
        toolName: 'write_file',
        toolInput: { path: `${MOCK_WORKSPACE}/mock-demo.txt`, content: 'hello from the mock bridge' },
        requestId: `mock-req-${++requestSeq}`,
        toolUseId: null,
      };
      pendingPermissions.set(request.requestId, {
        sessionId: session.id,
        request,
        createdAt: now(),
      });
      emitter.emit('cowork:stream:permission', { sessionId: session.id, request });
      const decision = await new Promise<'allow' | 'deny' | 'destroyed'>((resolve) => {
        permissionWaiters.set(request.requestId, resolve);
      });
      permissionWaiters.delete(request.requestId);
      pendingPermissions.delete(request.requestId);
      emitter.emit('cowork:stream:permissionResolved', { requestId: request.requestId });
      if (destroyed) return;
      await streamChunks(
        session,
        assistantMessage,
        decision === 'deny' ? REPLY_PERMISSION_DENIED : REPLY_PERMISSION_PART2,
      );
    }

    if (destroyed) return;
    if (wantsQuota) {
      session.status = 'error';
      session.updatedAt = now();
      // Real contract (main.ts runner wiring, REQ-A-25): a quota death
      // settles like every terminal turn failure — a persisted `Error: …`
      // system row broadcast on cowork:stream:message, then the
      // cowork:stream:error frame carrying metadata.errorCode. The
      // completion frame never carries quota metadata; the assistant
      // bubble keeps only the partial text streamed before the death.
      const errorText = 'DSH turn failed: LLM quota exhausted (free_quota_exhausted)';
      const systemError: MockCoworkMessage = {
        id: nextMessageId(),
        type: 'system',
        content: `Error: ${errorText}`,
        timestamp: now(),
      };
      session.messages.push(systemError);
      emitter.emit('cowork:stream:message', { sessionId: session.id, message: { ...systemError } });
      emitter.emit('cowork:stream:error', {
        sessionId: session.id,
        error: errorText,
        metadata: { errorCode: QUOTA_ERROR_CODE },
      });
      return;
    }
    if (session.status !== 'running') {
      // The turn was aborted via stopSession after the last chunk was cut.
      emitter.emit('cowork:stream:complete', { sessionId: session.id, claudeSessionId: session.claudeSessionId });
      return;
    }
    session.status = 'completed';
    session.updatedAt = now();
    emitter.emit('cowork:stream:complete', { sessionId: session.id, claudeSessionId: session.claudeSessionId });
  }

  const coworkConfig = {
    workingDirectory: MOCK_WORKSPACE,
    systemPrompt: '',
    executionMode: 'auto' as const,
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: false,
    memoryGuardLevel: 'standard' as const,
    memoryUserMemoriesMaxItems: 50,
    memoryPromptMaxChars: 4000,
    lastWorkspaceSelection: null,
  };

  const coworkImpl: Record<string, unknown> = {
    createGreetingSession: (input: {
      title?: string;
      fallbackGreeting: string;
      metabotId?: number | null;
    }) =>
      guardOnline(async () => {
        const session = createSession({
          title: input.title || 'Welcome',
          prompt: '',
          metabotId: input.metabotId,
          ...mockBotBrain(input.metabotId),
        });
        session.status = 'completed';
        session.messages.push({
          id: nextMessageId(),
          type: 'assistant',
          content: input.fallbackGreeting,
          timestamp: now(),
          metadata: { isFinal: true },
        });
        return { success: true, session: { ...session, messages: [...session.messages] } };
      }),
    startSession: (input: { prompt?: string; title?: string; metabotId?: number | null; model?: string | null; modelProvider?: string | null }) =>
      guardOnline(async () => {
        const brain = mockBotBrain(input?.metabotId);
        const session = createSession({
          title: input?.title || 'Mock chat',
          prompt: input?.prompt || '',
          metabotId: input?.metabotId ?? null,
          model: input?.model === undefined ? brain.model : input.model,
          modelProvider: input?.modelProvider === undefined ? brain.modelProvider : input.modelProvider,
        });
        const text = input?.prompt || '';
        if (text) pushUserMessage(session, text);
        void runAssistantTurn(session, text);
        return { success: true, session: { ...session, messages: [...session.messages] } };
      }),
    continueSession: (input: { sessionId: string; prompt: string }) =>
      guardOnline(async () => {
        const session = sessions.get(input.sessionId);
        if (!session) return { success: false, error: 'session_not_found' };
        pushUserMessage(session, input.prompt || '');
        void runAssistantTurn(session, input.prompt || '');
        return { success: true, session: { ...session, messages: [...session.messages] } };
      }),
    submitInput: (input: { sessionId: string; text: string }) =>
      guardOnline(async () => {
        const session = sessions.get(input.sessionId);
        if (!session) {
          return { success: false, code: 'session_not_found', error: 'session not found' };
        }
        const message = pushUserMessage(session, input.text || '');
        void runAssistantTurn(session, input.text || '');
        return { success: true, mode: 'steer', message };
      }),
    getSession: (sessionId: string, options?: { messageLimit?: number }) =>
      guardOnline(async () => {
        const session = sessions.get(sessionId);
        if (!session) return { success: false, error: 'session not found' };
        const limit = options?.messageLimit ?? 200;
        return {
          success: true,
          session: { ...session, messages: session.messages.slice(-limit) },
        };
      }),
    getSessionMessagesPage: (input: { sessionId: string; limit?: number }) =>
      guardOnline(async () => {
        const session = sessions.get(input.sessionId);
        if (!session) return { success: false, error: 'session not found' };
        const limit = input.limit ?? 50;
        return {
          success: true,
          page: {
            messages: session.messages.slice(-limit),
            hasMoreBefore: session.messages.length > limit,
            beforeSequence: null,
          },
        };
      }),
    listSessions: (_options?: { metabotId?: number | null }) =>
      guardOnline(async () => ({
        success: true,
        sessions: [...sessions.values()].map(summaryOf),
      })),
    // Session management (drawer rename/delete, 2026-11-02). These mirror
    // the real allowlisted channels (cowork:session:rename / :archive /
    // :unarchive / :listArchived) so the mobile drawer exercises the same
    // semantics against the mock: rename trims and must be non-empty; the
    // drawer's "delete" is ARCHIVE — the row leaves the active list but the
    // record survives and unarchiveSession restores it.
    renameSession: (options: { sessionId: string; title: string }) =>
      guardOnline(async () => {
        const session = sessions.get(options.sessionId);
        if (!session) return { success: false, error: 'session not found' };
        const normalized = options.title.trim();
        if (!normalized) return { success: false, error: 'title must be non-empty' };
        session.title = normalized;
        session.updatedAt = now();
        emitter.emit('cowork:stream:sessionTitle', { sessionId: session.id, title: normalized });
        return { success: true };
      }),
    archiveSession: (sessionId: string) =>
      guardOnline(async () => {
        const session = sessions.get(sessionId);
        if (!session) return { success: false, error: 'session not found' };
        sessions.delete(sessionId);
        archivedSessions.set(sessionId, session);
        return { success: true };
      }),
    unarchiveSession: (sessionId: string) =>
      guardOnline(async () => {
        const session = archivedSessions.get(sessionId);
        if (!session) return { success: false, error: 'session not found' };
        archivedSessions.delete(sessionId);
        sessions.set(sessionId, session);
        return { success: true };
      }),
    listArchivedSessions: (_options?: unknown) =>
      guardOnline(async () => ({
        success: true,
        sessions: [...archivedSessions.values()].map(summaryOf),
      })),
    stopSession: (sessionId: string) =>
      guardOnline(async () => {
        const session = sessions.get(sessionId);
        if (session) session.status = 'idle';
        // Release a turn blocked on a pending permission for this session.
        for (const [requestId, waiter] of [...permissionWaiters]) {
          const pending = pendingPermissions.get(requestId);
          if (pending?.sessionId === sessionId) waiter('destroyed');
        }
        return { success: true };
      }),
    respondToPermission: (input: { requestId: string; result: { behavior?: string } }) =>
      guardOnline(async () => {
        const waiter = permissionWaiters.get(input.requestId);
        if (!waiter || !pendingPermissions.has(input.requestId)) {
          return { success: false, error: 'unknown or already resolved requestId' };
        }
        waiter(input.result?.behavior === 'deny' ? 'deny' : 'allow');
        return { success: true };
      }),
    getStreamLiveContent: (input: { sessionId: string; messageId: string }) =>
      guardOnline(async () => {
        const message = liveMessages.get(streamKey(input.sessionId, input.messageId));
        return { success: true, content: message?.content ?? '' };
      }),
    onStreamMessage: (callback: (data: unknown) => void) => emitter.on('cowork:stream:message', callback as never),
    onStreamMessageUpdate: (callback: (data: unknown) => void) => emitter.on('cowork:stream:messageUpdate', callback as never),
    onStreamPermission: (callback: (data: unknown) => void) => emitter.on('cowork:stream:permission', callback as never),
    onStreamPermissionResolved: (callback: (data: unknown) => void) => emitter.on('cowork:stream:permissionResolved', callback as never),
    onStreamComplete: (callback: (data: unknown) => void) => emitter.on('cowork:stream:complete', callback as never),
    onStreamError: (callback: (data: unknown) => void) => emitter.on('cowork:stream:error', callback as never),
    onStreamSessionTitle: (callback: (data: unknown) => void) => emitter.on('cowork:stream:sessionTitle', callback as never),
    onSessionProfileRefreshed: (callback: (data: unknown) => void) => emitter.on('cowork:session:profileRefreshed', callback as never),
    onDelegationStateChange: (callback: (data: unknown) => void) => emitter.on('cowork:delegation:stateChange', callback as never),
    getConfig: () =>
      guardOnline(async () => ({
        success: true,
        config: { ...coworkConfig },
      })),
    setConfig: (input: Partial<typeof coworkConfig>) =>
      guardOnline(async () => {
        Object.assign(coworkConfig, input);
        return { success: true };
      }),
  };

  // -------------------------------------------------------- scheduled tasks
  const bootAt = now();
  const longTermSession = createSession({
    title: 'Long-term document result',
    prompt: 'Produce a document',
    metabotId: 1,
    sessionType: 'longterm',
  });
  completeArtifactSession(longTermSession, 'Produce a document');
  let longTermDetail = createLongTermFixture(longTermSession.id);
  let longTermSeq = 0;
  const emitLongTermUpdate = (reason: string) => {
    longTermSeq += 1;
    emitter.emit('longtermTask:update', {
      seq: longTermSeq,
      taskIds: [longTermDetail.id],
      reason,
    });
  };

  const scheduledTasks: ScheduledTask[] = [
    {
      id: 'mock-task-1',
      name: 'Daily digest',
      description: 'Summarizes activity once a day',
      enabled: true,
      schedule: { type: 'interval', intervalMs: 86_400_000, unit: 'days', value: 1 },
      prompt: 'Write a short digest of the last 24 hours',
      workingDirectory: MOCK_WORKSPACE,
      systemPrompt: '',
      executionMode: 'auto',
      metabotId: 1,
      coworkSessionId: null,
      targetSessionId: null,
      sessionMode: 'series',
      seriesSessionId: null,
      memoryAccess: 'none',
      expiresAt: null,
      notifyPlatforms: [],
      origin: 'human',
      originSessionId: null,
      originContext: 'ui',
      exitCondition: null,
      maxFires: null,
      fireCount: 0,
      state: {
        nextRunAtMs: bootAt + 86_400_000,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: new Date(bootAt).toISOString(),
      updatedAt: new Date(bootAt).toISOString(),
    },
    {
      id: 'mock-task-2',
      name: 'Weekly wallet report',
      description: 'Drafts a balance report every Monday',
      enabled: false,
      schedule: { type: 'cron', expression: '0 9 * * 1' },
      prompt: 'Draft the weekly wallet report',
      workingDirectory: MOCK_WORKSPACE,
      systemPrompt: '',
      executionMode: 'auto',
      metabotId: 2,
      coworkSessionId: null,
      targetSessionId: null,
      sessionMode: 'series',
      seriesSessionId: null,
      memoryAccess: 'none',
      expiresAt: null,
      notifyPlatforms: [],
      origin: 'human',
      originSessionId: null,
      originContext: 'ui',
      exitCondition: null,
      maxFires: null,
      fireCount: 0,
      state: {
        nextRunAtMs: null,
        lastRunAtMs: bootAt - 604_800_000,
        lastStatus: 'success',
        lastError: null,
        lastDurationMs: 12_000,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: new Date(bootAt).toISOString(),
      updatedAt: new Date(bootAt).toISOString(),
    },
  ];
  const scheduledRuns = new Map<string, ScheduledTaskRun[]>();
  let runSeq = 0;
  let taskSeq = 2;

  function taskById(id: string): ScheduledTask | undefined {
    return scheduledTasks.find((task) => task.id === id);
  }

  /** Next fire time for a schedule from `now`, used by create/toggle. */
  function nextRunAtMsFor(schedule: Schedule, fromMs: number): number | null {
    if (schedule.type === 'interval') {
      return fromMs + schedule.intervalMs;
    }
    if (schedule.type === 'cron') {
      // Mobile mock only produces daily-time cron strings ("m h * * *");
      // other expressions fall back to the next midnight tick.
      const parts = schedule.expression.split(/\s+/);
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      const next = new Date(fromMs);
      next.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
      if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    const at = Date.parse(schedule.datetime);
    return Number.isFinite(at) && at > fromMs ? at : null;
  }

  function validateTaskInput(input: ScheduledTaskInput): string | null {
    if (!input || typeof input !== 'object') return 'input must be an object';
    if (typeof input.name !== 'string' || !input.name.trim()) return 'name is required';
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return 'prompt is required';
    const schedule: Schedule = input.schedule;
    if (!schedule || typeof schedule !== 'object') return 'schedule is required';
    if (schedule.type === 'interval') {
      if (!(schedule.intervalMs > 0)) return 'interval schedule needs intervalMs > 0';
    } else if (schedule.type === 'cron') {
      if (typeof schedule.expression !== 'string' || !schedule.expression.trim()) {
        return 'cron schedule needs an expression';
      }
    } else if (schedule.type === 'at') {
      if (!Number.isFinite(Date.parse(schedule.datetime))) return 'at schedule needs a valid datetime';
    } else {
      return 'unknown schedule type';
    }
    if (
      input.memoryAccess !== undefined &&
      !SCHEDULED_TASK_MEMORY_ACCESS_OPTIONS.includes(input.memoryAccess)
    ) {
      return 'unknown memory access';
    }
    if (input.sessionMode !== undefined && input.sessionMode !== 'series' && input.sessionMode !== 'fresh') {
      return 'unknown session mode';
    }
    return null;
  }

  /**
   * Runs a task once: emits the running status, then the completed run (and a
   * matching runUpdate/statusUpdate pair) after the delay. The completed run
   * lands in `listRuns` history and creates an auto-origin cowork session,
   * like a real scheduled run. The scheduled demo tick (mock-task-1) finishes
   * quickly; manual runs run for `manualRunDelayMs` so the UI can show the
   * running state.
   */
  const activeRuns = new Map<string, { taskId: string; cancel: () => void }>();

  function startTaskRun(task: ScheduledTask, trigger: 'scheduled' | 'manual', finishDelayMs: number): ScheduledTaskRun {
    const runSession = createSession({
      title: `Scheduled run: ${task.name}`,
      prompt: task.prompt,
      metabotId: task.metabotId,
      autoOrigin: 'schedule',
    });
    const startedMs = now();
    runSession.status = 'running';
    task.state = {
      ...task.state,
      lastStatus: 'running',
      runningAtMs: startedMs,
    };
    task.updatedAt = new Date(startedMs).toISOString();
    emitter.emit('scheduledTask:statusUpdate', { taskId: task.id, state: { ...task.state } });
    const run: ScheduledTaskRun = {
      id: `mock-run-${++runSeq}`,
      taskId: task.id,
      sessionId: runSession.id,
      status: 'running',
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: null,
      durationMs: null,
      error: null,
      trigger,
      skipReason: null,
    };
    const runs = scheduledRuns.get(task.id) ?? [];
    runs.unshift(run);
    scheduledRuns.set(task.id, runs);
    if (trigger === 'manual') emitter.emit('scheduledTask:runUpdate', { run: { ...run } });
    let cancelled = false;
    activeRuns.set(run.id, { taskId: task.id, cancel: () => { cancelled = true; } });
    const finishRun = () => {
      if (destroyed || cancelled || !taskById(task.id)) return;
      activeRuns.delete(run.id);
      const finishedMs = now();
      run.status = 'success';
      run.finishedAt = new Date(finishedMs).toISOString();
      run.durationMs = finishedMs - startedMs;
      task.fireCount += 1;
      task.state = {
        nextRunAtMs: task.enabled ? nextRunAtMsFor(task.schedule, finishedMs) : null,
        lastRunAtMs: finishedMs,
        lastStatus: 'success',
        lastError: null,
        lastDurationMs: run.durationMs,
        runningAtMs: null,
        consecutiveErrors: 0,
      };
      task.updatedAt = new Date(finishedMs).toISOString();
      completeArtifactSession(runSession, task.prompt);
      emitter.emit('scheduledTask:runUpdate', { run: { ...run } });
      emitter.emit('scheduledTask:statusUpdate', { taskId: task.id, state: { ...task.state } });
    };
    later(finishRun, finishDelayMs);
    return run;
  }

  function stopActiveTaskRuns(taskId: string): boolean {
    const active = [...activeRuns.entries()].filter(([, entry]) => entry.taskId === taskId);
    if (active.length === 0) return false;
    const task = taskById(taskId);
    const finishedMs = now();
    for (const [runId, entry] of active) {
      entry.cancel();
      activeRuns.delete(runId);
      const run = (scheduledRuns.get(taskId) ?? []).find((candidate) => candidate.id === runId);
      if (!run || run.status !== 'running') continue;
      run.status = 'error';
      run.error = 'Stopped by user';
      run.finishedAt = new Date(finishedMs).toISOString();
      run.durationMs = finishedMs - Date.parse(run.startedAt);
      const runSession = run.sessionId ? sessions.get(run.sessionId) : undefined;
      if (runSession) runSession.status = 'idle';
      emitter.emit('scheduledTask:runUpdate', { run: { ...run } });
    }
    if (task) {
      task.state = {
        ...task.state,
        lastRunAtMs: finishedMs,
        lastStatus: 'error',
        lastError: 'Stopped by user',
        runningAtMs: null,
      };
      task.updatedAt = new Date(finishedMs).toISOString();
      emitter.emit('scheduledTask:statusUpdate', { taskId, state: { ...task.state } });
    }
    return true;
  }

  later(() => {
    const task = taskById('mock-task-1');
    if (task?.enabled && !destroyed) startTaskRun(task, 'scheduled', Math.min(200, scheduledRunDelayMs));
  }, scheduledRunDelayMs);

  const scheduledTasksImpl: Record<string, unknown> = {
    list: () => guardOnline(async () => ({ success: true, tasks: scheduledTasks.map((t) => ({ ...t })) })),
    get: (id: string) =>
      guardOnline(async () => {
        const task = taskById(id);
        return task ? { success: true, task: { ...task } } : { success: false, error: 'task not found' };
      }),
    create: (input: ScheduledTaskInput) =>
      guardOnline(async () => {
        const invalid = validateTaskInput(input);
        if (invalid) return { success: false, error: `invalid task: ${invalid}` };
        const ts = now();
        const task: ScheduledTask = {
          id: `mock-task-${++taskSeq}`,
          name: input.name.trim(),
          description: typeof input.description === 'string' ? input.description : '',
          enabled: input.enabled !== false,
          schedule: input.schedule,
          prompt: input.prompt,
          workingDirectory: input.workingDirectory || MOCK_WORKSPACE,
          systemPrompt: input.systemPrompt || '',
          executionMode: input.executionMode === 'local' || input.executionMode === 'sandbox' ? input.executionMode : 'auto',
          metabotId: typeof input.metabotId === 'number' ? input.metabotId : null,
          coworkSessionId: null,
          targetSessionId: typeof input.targetSessionId === 'string' ? input.targetSessionId : null,
          sessionMode: input.sessionMode === 'fresh' ? 'fresh' : 'series',
          seriesSessionId: null,
          memoryAccess: SCHEDULED_TASK_MEMORY_ACCESS_OPTIONS.includes(input.memoryAccess as ScheduledTaskMemoryAccess)
            ? (input.memoryAccess as ScheduledTaskMemoryAccess)
            : 'none',
          expiresAt: typeof input.expiresAt === 'string' ? input.expiresAt : null,
          notifyPlatforms: Array.isArray(input.notifyPlatforms) ? [...input.notifyPlatforms] : [],
          origin: 'human',
          originSessionId: null,
          originContext: 'ui',
          exitCondition: typeof input.exitCondition === 'string' ? input.exitCondition : null,
          maxFires: typeof input.maxFires === 'number' ? input.maxFires : null,
          fireCount: 0,
          state: {
            nextRunAtMs: input.enabled === false ? null : nextRunAtMsFor(input.schedule, ts),
            lastRunAtMs: null,
            lastStatus: null,
            lastError: null,
            lastDurationMs: null,
            runningAtMs: null,
            consecutiveErrors: 0,
          },
          createdAt: new Date(ts).toISOString(),
          updatedAt: new Date(ts).toISOString(),
        };
        scheduledTasks.push(task);
        emitter.emit('scheduledTask:statusUpdate', { taskId: task.id, state: { ...task.state } });
        return { success: true, task: { ...task } };
      }),
    update: (id: string, input: Partial<ScheduledTaskInput>) =>
      guardOnline(async () => {
        const task = taskById(id);
        if (!task) return { success: false, error: `Task not found: ${id}` };
        if (!input || typeof input !== 'object') return { success: false, error: 'input must be an object' };
        const editableFields = [
          'name', 'description', 'schedule', 'prompt', 'workingDirectory', 'systemPrompt',
          'executionMode', 'metabotId', 'targetSessionId', 'sessionMode', 'memoryAccess', 'expiresAt',
          'notifyPlatforms', 'enabled', 'exitCondition', 'maxFires',
        ] as const;
        const changes: Partial<ScheduledTaskInput> = {};
        for (const key of editableFields) {
          if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
            Object.assign(changes, { [key]: input[key] });
          }
        }
        const candidate = { ...task, ...changes } as ScheduledTaskInput;
        const invalid = validateTaskInput(candidate);
        if (invalid) return { success: false, error: `invalid task: ${invalid}` };
        const previousMetabotId = task.metabotId;
        Object.assign(task, changes, {
          name: candidate.name.trim(),
          workingDirectory: candidate.workingDirectory.trim() || task.workingDirectory,
          updatedAt: new Date(now()).toISOString(),
        });
        if (input.metabotId !== undefined && input.metabotId !== previousMetabotId) {
          task.coworkSessionId = null;
          task.targetSessionId = null;
          task.seriesSessionId = null;
        }
        task.state = {
          ...task.state,
          nextRunAtMs: task.enabled ? nextRunAtMsFor(task.schedule, now()) : null,
        };
        emitter.emit('scheduledTask:statusUpdate', { taskId: task.id, state: { ...task.state } });
        return { success: true, task: { ...task } };
      }),
    toggle: (id: string, enabled: boolean) =>
      guardOnline(async () => {
        const task = taskById(id);
        if (!task) return { success: false, error: 'task not found' };
        const ts = now();
        task.enabled = Boolean(enabled);
        task.state = {
          ...task.state,
          nextRunAtMs: task.enabled ? (task.state.nextRunAtMs ?? nextRunAtMsFor(task.schedule, ts)) : null,
        };
        task.updatedAt = new Date(ts).toISOString();
        emitter.emit('scheduledTask:statusUpdate', { taskId: task.id, state: { ...task.state } });
        return { success: true, task: { ...task } };
      }),
    runManually: (id: string) =>
      guardOnline(async () => {
        const task = taskById(id);
        if (!task) return { success: false, error: 'task not found' };
        const run = startTaskRun(task, 'manual', manualRunDelayMs);
        return { success: true, run: { ...run } };
      }),
    listRuns: (taskId: string, limit = 50, offset = 0) =>
      guardOnline(async () => {
        const runs = scheduledRuns.get(taskId) ?? [];
        return { success: true, runs: runs.slice(offset, offset + limit) };
      }),
    countRuns: (taskId: string) =>
      guardOnline(async () => ({ success: true, count: (scheduledRuns.get(taskId) ?? []).length })),
    listAllRuns: (limit = 50, offset = 0) =>
      guardOnline(async () => {
        const all = [...scheduledRuns.values()].flat();
        return { success: true, runs: all.slice(offset, offset + limit) };
      }),
    stop: (id: string) => guardOnline(async () => ({ success: true, result: stopActiveTaskRuns(id) })),
    delete: (id: string) =>
      guardOnline(async () => {
        stopActiveTaskRuns(id);
        const index = scheduledTasks.findIndex((task) => task.id === id);
        if (index < 0) return { success: true, result: false };
        scheduledTasks.splice(index, 1);
        scheduledRuns.delete(id);
        return { success: true, result: true };
      }),
    onRunUpdate: (callback: (data: unknown) => void) => emitter.on('scheduledTask:runUpdate', callback as never),
    onStatusUpdate: (callback: (data: unknown) => void) => emitter.on('scheduledTask:statusUpdate', callback as never),
  };

  const longtermTaskImpl: Record<string, unknown> = {
    board: () => guardOnline(async () => ({
      success: true,
      board: longTermBoard(structuredClone(longTermDetail)),
    })),
    get: (input: { taskId: string }) =>
      guardOnline(async () => (
        input?.taskId === longTermDetail.id
          ? { success: true, detail: structuredClone(longTermDetail) }
          : { success: false, error: 'Task not found' }
      )),
    setStage: (input: { taskId: string; action: 'pause' | 'resume' | 'cancel' }) =>
      guardOnline(async () => {
        if (input?.taskId !== longTermDetail.id) {
          return { ok: false, code: 'NOT_FOUND', error: 'Task not found' };
        }
        const validTransition = input.action === 'pause'
          ? longTermDetail.stage === 'active'
          : input.action === 'resume'
            ? longTermDetail.stage === 'paused' || longTermDetail.stage === 'defining'
            : input.action === 'cancel' && longTermDetail.stage !== 'done' && longTermDetail.stage !== 'cancelled';
        if (!validTransition) {
          return { ok: false, code: 'VALIDATION', error: 'Invalid task stage transition' };
        }
        longTermDetail = applyLongTermStage(longTermDetail, input.action, new Date(now()).toISOString());
        emitLongTermUpdate(`stage_${input.action}`);
        return { ok: true, value: input.action === 'cancel' ? null : structuredClone(longTermDetail) };
      }),
    onUpdate: (callback: (data: unknown) => void) => emitter.on('longtermTask:update', callback as never),
  };

  // ----------------------------------------------------- plans and payment
  const plans: BundlePlan[] = [
    {
      planId: 'bundle_basic_cny',
      name: 'Basic bundle',
      nameEn: 'Basic',
      payCurrency: 'CNY',
      payAmount: '129.00',
      trafficBytes: 10 * 1024 * 1024 * 1024,
      llmQuota: 50_000_000,
      llmQuotaUnit: 'tokens',
      status: 1,
      sort: 10,
      remark: '',
    },
    {
      planId: 'bundle_pro_cny',
      name: 'Pro bundle',
      nameEn: 'Pro',
      payCurrency: 'CNY',
      payAmount: '179.00',
      trafficBytes: 50 * 1024 * 1024 * 1024,
      llmQuota: 200_000_000,
      llmQuotaUnit: 'tokens',
      status: 1,
      sort: 20,
      remark: '',
    },
  ];
  const orders = new Map<string, MockBundleOrder>();
  let orderSeq = 0;

  const meters: BundleMeters = {
    traffic: {
      accountId: 'mock-traffic-account',
      identityAddress: 'mock-identity-address',
      balanceBytes: 500 * 1024 * 1024,
      reservedBytes: 0,
      grantedBytesTotal: 1024 * 1024 * 1024,
      spentBytesTotal: 524 * 1024 * 1024,
      status: 1,
    },    llm: {
      quotaTotal: 2_000_000,
      quotaUsed: 350_000,
      quotaRemaining: 1_650_000,
      quotaFree: 2_000_000,
      quotaPurchased: 0,
      unit: 'tokens',
    },
  };

  /**
   * A6 mock identity row (IA-PLAN §5): mutable so the profile page's
   * updateName round-trips through get() like the real channel does.
   */
  const mockIdentity = {
    id: 1,
    path: "m/44'/10001'/0'/0/0",
    mvc_address: 'mock-mvc-address',
    btc_address: 'mock-btc-address',
    doge_address: 'mock-doge-address',
    public_key: 'mock-public-key',
    chat_public_key: 'mock-chat-public-key',
    chat_public_key_pin_id: null,
    metaid: 'mock-metaid',
    globalmetaid: 'idq1mock0user0meta0id000000000000000000',
    name: 'Mock User',
    avatar: null,
    subsidy_state: 'claimed',
    subsidy_error: null,
    name_pin_id: null,
    avatar_pin_id: null,
    sync_state: 'synced',
    sync_error: null,
    created_at: bootAt,
    updated_at: bootAt,
  };

  // Traffic page fixtures (A6, IA-PLAN §4.4): ledger pages, usage summary,
  // daily usage rows, and a once-only free grant. Amounts mirror the meter
  // fixture scale so the pages read plausibly in e2e.
  const FREE_GRANT_BYTES = 10 * 1_000_000; // desktop DEFAULT_FREE_GRANT_BYTES parity
  let freeGrantClaimed = false;
  const ledgerPageBytes = (page: number): number[] =>
    Array.from({ length: page === 0 ? 20 : 6 }, (_, index) => (index + 1) * (1024 * 1024) + page);
  const makeLedgerEntries = (page: number, baseId: number) =>
    ledgerPageBytes(page).map((amountBytes, index) => ({
      id: baseId + index,
      direction: index % 2 === 0 ? 1 : -1,
      amountBytes,
      balanceAfter: meters.traffic.balanceBytes,
      sourceType: index % 2 === 0 ? 'grant' : 'usage',
      sourceId: `mock-ledger-${baseId + index}`,
      remark: index % 2 === 0 ? 'Mock grant' : 'Mock usage',
      timestamp: bootAt - (baseId + index) * 60_000,
    }));
  const ledgerEntries: ReturnType<typeof makeLedgerEntries> = [
    ...makeLedgerEntries(0, 100),
    ...makeLedgerEntries(1, 200),
  ];

  const bundleImpl: BundleChannelAPI = {
    getPlans: () =>
      guardOnline(async () => ({
        success: true,
        plans: [...plans].sort((a, b) => a.sort - b.sort),
      })),
    createOrder: (input: { planId: string }) =>
      guardOnline(async () => {
        const plan = plans.find((p) => p.planId === input?.planId && p.status === 1);
        if (!plan) return { success: false, error: 'plan not found or off sale', errorCode: 'BUNDLE_ORDER_REJECTED' };
        const createdAt = now();
        const order: MockBundleOrder = {
          orderId: `bo_mock_${++orderSeq}`,
          planId: plan.planId,
          payAmount: plan.payAmount,
          payCurrency: plan.payCurrency,
          trafficBytes: plan.trafficBytes,
          llmQuota: plan.llmQuota,
          status: 1,
          gatewayParams: {
            qrCode: `https://qr.alipay.com/mock?id=${plan.planId}&n=${orderSeq}`,
            alipayOutTradeNo: `mock-out-${orderSeq}`,
          },
          expiresAt: Math.floor(createdAt / 1000) + 15 * 60,
          createdAt,
        };
        orders.set(order.orderId, order);
        // Deterministic payment: the order credits after orderCompleteDelayMs
        // (10 s by default) and the meters rise at that point.
        later(() => {
          if (destroyed) return;
          order.status = 3;
          order.paidAt = Math.floor((order.createdAt + orderCompleteDelayMs) / 1000);
          order.creditedAt = Math.floor(now() / 1000);
          meters.traffic.balanceBytes += order.trafficBytes;
          meters.traffic.grantedBytesTotal += order.trafficBytes;
          meters.llm.quotaTotal += order.llmQuota;
          meters.llm.quotaPurchased += order.llmQuota;
          meters.llm.quotaRemaining = meters.llm.quotaTotal - meters.llm.quotaUsed;
        }, orderCompleteDelayMs);
        return { success: true, order: { ...order } };
      }),
    getOrder: (input: { orderId: string }) =>
      guardOnline(async () => {
        const order = orders.get(input?.orderId);
        if (!order) return { success: false, error: 'order not found' };
        const { gatewayParams: _gatewayParams, expiresAt: _expiresAt, createdAt: _createdAt, ...status } = order;
        return { success: true, order: status };
      }),
    getMeters: () =>
      guardOnline(async () => ({
        success: true,
        meters: {
          traffic: { ...meters.traffic },
          llm: { ...meters.llm },
        },
      })),
  };

  // ------------------------------------------------------------ local tiers
  const appConfigStore = new Map<string, unknown>([
    [
      'app_config',
      {
        language: 'en',
        theme: 'system',
        providers: {
          'metaid-free': {
            enabled: true,
            apiKey: '__redacted__',
            baseUrl: 'https://mock.invalid/relay',
            apiFormat: 'openai',
            name: 'IDBots-Free',
            models: [
              { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1000000, maxOutputTokens: 100000 },
              { id: 'glm-flash', name: 'GLM Flash', contextWindow: 128000, maxOutputTokens: 32768 },
            ],
          },
        },
        model: { defaultProvider: 'metaid-free', defaultModel: 'deepseek-flash' },
        memoryEnabled: true,
      },
    ],
  ]);
  const storeListeners = new Set<(payload: { key: string }) => void>();
  const storeGuard = (op: string, key: string): string | null =>
    key === 'app_config' ? null : `mock: store:${op} key '${key}' rejected by R-store (only 'app_config' is allowed)`;

  const storeImpl: Record<string, unknown> = {
    get: (key: string) =>
      guardOnline(async () => {
        const denied = storeGuard('get', key);
        if (denied) throw new Error(denied);
        return appConfigStore.get(key) ?? null;
      }),
    getStrict: (key: string) =>
      guardOnline(async () => {
        const denied = storeGuard('get', key);
        if (denied) throw new Error(denied);
        return appConfigStore.get(key) ?? null;
      }),
    set: (key: string, value: unknown) =>
      guardOnline(async () => {
        const denied = storeGuard('set', key);
        if (denied) throw new Error(denied);
        const current = appConfigStore.get(key);
        const currentRecord = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
        const patch = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        appConfigStore.set(key, { ...currentRecord, ...patch });
        for (const listener of [...storeListeners]) listener({ key });
      }),
    remove: (_key: string) =>
      guardOnline(async () => {
        // R-store: remove is rejected outright, even for app_config.
        throw new Error('mock: store:remove rejected by R-store (remove is not allowed)');
      }),
    onChanged: (callback: (payload: { key: string }) => void) => {
      storeListeners.add(callback);
      return () => {
        storeListeners.delete(callback);
      };
    },
  };

  const detectedLocale = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language) {
      return navigator.language;
    }
    return 'en';
  };

  const metabotFixtures: MobileMetabot[] = [
    {
      id: 1,
      wallet_id: 1,
      name: 'Twin Bot',
      avatar: null,
      enabled: true,
      globalmetaid: 'mock-globalmetaid-twin',
      metabot_type: 'twin',
      role: 'Your twin',
      soul: 'Mock twin soul',
      goal: null,
      bio: 'The mock Twin Bot',
      background: null,
      boss_id: null,
      boss_global_metaid: null,
      llm_id: 'deepseek-flash',
      llm_provider: 'metaid-free',
      llm_effort: null,
      mvc_address: 'mock-mvc-twin',
      metabot_info_pinid: 'mock-info-twin',
      chain_sync_state: 'synced',
      chain_sync_pending_steps: [],
      subsidy_state: 'claimed',
      tools: [],
      skills: ['web-search'],
      allow_chat_skills: ['web-search'],
      created_at: bootAt,
      updated_at: bootAt,
    },
    {
      id: 2,
      wallet_id: 2,
      name: 'Researcher',
      avatar: null,
      enabled: true,
      globalmetaid: 'mock-globalmetaid-worker',
      metabot_type: 'worker',
      role: 'Researches the MetaWeb',
      soul: 'Mock worker soul',
      goal: null,
      bio: 'A mock worker Bot',
      background: null,
      boss_id: null,
      boss_global_metaid: null,
      llm_id: 'deepseek-flash',
      llm_provider: 'metaid-free',
      llm_effort: null,
      mvc_address: 'mock-mvc-worker',
      metabot_info_pinid: 'mock-info-worker',
      chain_sync_state: 'synced',
      chain_sync_pending_steps: [],
      subsidy_state: 'claimed',
      tools: [],
      skills: [],
      allow_chat_skills: ['web-search'],
      created_at: bootAt,
      updated_at: bootAt,
    },
  ];
  let metabotSeq = 2;

  const metabotImpl: Record<string, unknown> = {
    list: () =>
      guardOnline(async () => ({
        success: true,
        list: metabotFixtures.map((bot) => ({ ...bot })),
      })),
    get: (id: number) =>
      guardOnline(async () => {
        const bot = metabotFixtures.find((entry) => entry.id === id);
        return bot ? { success: true, metabot: { ...bot } } : { success: false, error: 'metabot not found' };
      }),
    create: (input: MetabotCreateInput & MetabotFallbackInput) =>
      guardOnline(async () => {
        if (!input || typeof input.name !== 'string' || !input.name.trim()) {
          return { success: false, error: 'name is required' };
        }
        const ts = now();
        const bot: MobileMetabot = {
          id: ++metabotSeq,
          wallet_id: metabotSeq,
          name: input.name.trim(),
          avatar: input.avatar ?? null,
          enabled: true,
          globalmetaid: `mock-globalmetaid-${metabotSeq}`,
          metabot_type: input.metabot_type === 'twin' || input.metabot_type === 'welcome' ? input.metabot_type : 'worker',
          role: typeof input.role === 'string' ? input.role : '',
          soul: typeof input.soul === 'string' ? input.soul : '',
          goal: input.goal ?? null,
          bio: input.bio ?? null,
          background: input.background ?? null,
          boss_id: input.boss_id ?? null,
          boss_global_metaid: input.boss_global_metaid ?? null,
          llm_id: input.llm_id ?? null,
          llm_provider: input.llm_provider ?? null,
          llm_effort: input.llm_effort ?? null,
          fallback_llm_id: input.fallback_llm_id ?? null,
          fallback_llm_provider: input.fallback_llm_provider ?? null,
          fallback_llm_effort: input.fallback_llm_effort ?? null,
          mvc_address: `mock-mvc-${metabotSeq}`,
          metabot_info_pinid: null,
          chain_sync_state: 'partial',
          chain_sync_pending_steps: ['name', 'chatpubkey', 'llm'],
          subsidy_state: 'unknown',
          tools: [],
          skills: [],
          allow_chat_skills: input.allow_chat_skills ?? [],
          created_at: ts,
          updated_at: ts,
        };
        metabotFixtures.push(bot);
        return { success: true, metabot: { ...bot } };
      }),
    update: (id: number, input: MetabotUpdateInput & MetabotFallbackInput) =>
      guardOnline(async () => {
        const bot = metabotFixtures.find((entry) => entry.id === id);
        if (!bot) return { success: false, error: 'metabot not found' };
        if (input && typeof input.name === 'string') {
          if (!input.name.trim()) return { success: false, error: 'name must not be empty' };
          bot.name = input.name.trim();
        }
        if (input) {
          if (typeof input.role === 'string') bot.role = input.role;
          if (typeof input.soul === 'string') bot.soul = input.soul;
          if (input.bio !== undefined) bot.bio = input.bio;
          if (input.goal !== undefined) bot.goal = input.goal;
          if (input.llm_id !== undefined) bot.llm_id = input.llm_id;
          if (input.llm_provider !== undefined) bot.llm_provider = input.llm_provider;
          if (input.llm_effort !== undefined) bot.llm_effort = input.llm_effort;
          if (input.fallback_llm_id !== undefined) bot.fallback_llm_id = input.fallback_llm_id ?? null;
          if (input.fallback_llm_provider !== undefined) bot.fallback_llm_provider = input.fallback_llm_provider ?? null;
          if (input.fallback_llm_effort !== undefined) bot.fallback_llm_effort = input.fallback_llm_effort ?? null;
          if (input.allow_chat_skills !== undefined) bot.allow_chat_skills = [...input.allow_chat_skills];
          // A2A chat settings — the real metabot:update handler persists
          // these; keep mock parity (UE rework 2026-10-29, A5).
          if (input.a2a_auto_reply_enabled !== undefined) bot.a2a_auto_reply_enabled = input.a2a_auto_reply_enabled;
          if (input.a2a_max_incoming_turns !== undefined) bot.a2a_max_incoming_turns = input.a2a_max_incoming_turns;
          if (input.a2a_bye_cooldown_ms !== undefined) bot.a2a_bye_cooldown_ms = input.a2a_bye_cooldown_ms;
          if (typeof input.enabled === 'boolean') bot.enabled = input.enabled;
        }
        bot.metabot_info_pinid = bot.metabot_info_pinid ?? `mock-info-${bot.id}`;
        bot.chain_sync_state = 'synced';
        bot.chain_sync_pending_steps = [];
        bot.updated_at = now();
        return { success: true, metabot: { ...bot }, sync: { skipped: false, success: true, syncedSteps: ['persona', 'llm', 'chatSkills'] } };
      }),
    setEnabled: (id: number, enabled: boolean) =>
      guardOnline(async () => {
        const bot = metabotFixtures.find((entry) => entry.id === id);
        if (!bot) return { success: false, error: 'metabot not found' };
        bot.enabled = Boolean(enabled);
        bot.updated_at = now();
        return { success: true, metabot: { ...bot } };
      }),
  };

  const skillFixtures: MockSkill[] = [
    {
      id: 'web-search',
      name: 'web-search',
      description: 'Searches the web',
      enabled: true,
      isOfficial: true,
      isBuiltIn: false,
      updatedAt: bootAt,
      prompt: '',
      skillPath: '/data/appdata/SKILLs/web-search',
    },
    {
      id: 'memory',
      name: 'memory',
      description: 'Long-term memory',
      enabled: true,
      isOfficial: true,
      isBuiltIn: true,
      updatedAt: bootAt,
      prompt: '',
      skillPath: '/data/appdata/SKILLs/memory',
    },
  ];
  let redeemSeq = 0;

  // ------------------------------------------------------------ ME points (S9)
  // Contract-shaped fixtures for the points home / purchase flow / usage page.
  // Prices and weekly amounts mirror /v1/me/* (mobile priceCny) so the mock
  // still proves "everything renders from the API shape".
  let mockMeSubscribed = false;
  let mockTopupSeq = 0;
  const mockMeNow = () => Math.floor(Date.now() / 1000);
  const mockMePlans = [
    { planId: 'me_free', tier: 'free', name: 'Free', priceCny: 0, desktopPriceCny: 0, annualPriceCny: 0, quarterlyDiscountPct: 0, periodDays: 30, weeklyAmountMilli: 2_000_000, saleStatus: 1 },
    { planId: 'me_standard', tier: 'standard', name: 'ID.Pupil', priceCny: 99, desktopPriceCny: 49, annualPriceCny: 899, quarterlyDiscountPct: 90, periodDays: 30, weeklyAmountMilli: 10_000_000, saleStatus: 1 },
    { planId: 'me_pro', tier: 'pro', name: 'ID.Student', priceCny: 199, desktopPriceCny: 149, annualPriceCny: 1799, quarterlyDiscountPct: 90, periodDays: 30, weeklyAmountMilli: 35_000_000, saleStatus: 1 },
    { planId: 'me_max', tier: 'max', name: 'ID.Scholar', priceCny: 499, desktopPriceCny: 449, annualPriceCny: 4499, quarterlyDiscountPct: 90, periodDays: 30, weeklyAmountMilli: 125_000_000, saleStatus: 1 },
  ];
  const mockMeTopupPackages = [
    { packageId: 'me_topup_a', name: 'Top-up Pack A', meMilli: 30_000_000, priceCny: 90, saleStatus: 1 },
    { packageId: 'me_topup_b', name: 'Top-up Pack B', meMilli: 100_000_000, priceCny: 249, saleStatus: 1 },
  ];
  const mockMeRates = [
    { key: 'deepseek-chat', multiplier: 1 },
    { key: 'glm-5.3', multiplier: 3 },
    { key: 'mvc-traffic', multiplier: 1 },
  ];
  const mockMeOrders: Array<Record<string, unknown>> = [
    { orderId: 'me_topup_demo_0001', packageId: 'me_topup_a', status: 'confirmed', createdAt: mockMeNow() - 86_400, confirmedAt: mockMeNow() - 82_800, meMilli: 30_000_000, priceCny: 90 },
    { orderId: 'me_topup_demo_0002', packageId: 'me_topup_b', status: 'submitted', createdAt: mockMeNow() - 3_600, meMilli: 100_000_000, priceCny: 249 },
  ];
  const mockMeHistory = (() => {
    const rows = [
      { type: 'grant', amountMilli: 10_000_000, reason: 'weekly grant', refType: 'weekly' },
      { type: 'spend', amountMilli: -420_000, reason: 'deepseek-chat · 1x', refType: 'llm' },
      { type: 'topup', amountMilli: 30_000_000, reason: 'me_topup_a', refType: 'topup' },
      { type: 'earned', amountMilli: 1_250_000, reason: 'skill service sale', refType: 'earned' },
      { type: 'bonus', amountMilli: 2_000_000, reason: 'welcome bonus', refType: 'bonus' },
      { type: 'spend', amountMilli: -1_260_000, reason: 'glm-5.3 · 3x', refType: 'llm' },
      { type: 'spend', amountMilli: -80_000, reason: 'mvc traffic · 1x', refType: 'traffic' },
    ];
    return rows.map((row, index) => ({
      id: `mock_me_h_${index + 1}`,
      ...row,
      balanceAfterMilli: 40_000_000 - index * 250_000,
      createdAt: mockMeNow() - index * 5_400,
      raw: {},
    }));
  })();
  const mockMeBalance = () => {
    const weeklyAmount = mockMeSubscribed ? 10_000_000 : 2_000_000;
    const weeklyRemaining = mockMeSubscribed ? 6_240_000 : 1_480_000;
    const topup = 30_000_000;
    const bonus = 2_000_000;
    const earned = 1_250_000;
    return {
      identityAddress: 'mock-mvc-address',
      weeklyGrant: {
        amountMilli: weeklyAmount,
        remainingMilli: weeklyRemaining,
        cycleStart: mockMeNow() - 3 * 86_400,
        cycleEnd: mockMeNow() + 4 * 86_400,
        isResidual: false,
        nextResetAt: (mockMeNow() + 3 * 86_400 + 5_400) * 1000,
      },
      persistent: { topupMilli: topup, earnedMilli: earned, bonusMilli: bonus },
      frozenMilli: 0,
      totalAvailable: weeklyRemaining + topup + bonus + earned,
    };
  };
  const mePointsImpl = {
    getPlans: () => guardOnline(async () => ({ success: true, plans: mockMePlans })),
    getRates: () => guardOnline(async () => ({ success: true, rates: mockMeRates })),
    getTopupPackages: () => guardOnline(async () => ({ success: true, topupPackages: mockMeTopupPackages })),
    getBalance: () => guardOnline(async () => ({ success: true, balance: mockMeBalance() })),
    getSubscription: () =>
      guardOnline(async () => ({
        success: true,
        subscription: {
          statusText: mockMeSubscribed ? 'active' : 'free',
          raw: mockMeSubscribed ? { planId: 'me_standard', planName: 'ID.Pupil' } : { planId: 'me_free' },
        },
      })),
    getHistory: (input?: { type?: string }) =>
      guardOnline(async () => {
        const rows = input?.type ? mockMeHistory.filter((row) => row.type === input.type) : mockMeHistory;
        return { success: true, history: { entries: rows, nextCursor: '' } };
      }),
    submitTopupOrder: (input: { packageId?: string }) =>
      guardOnline(async () => {
        const isTopup = String(input?.packageId ?? '').startsWith('me_topup_');
        // PRD 2.2: top-up requires an active paid plan; subscription orders are
        // exactly how a free account becomes paid, so they pass.
        if (isTopup && !mockMeSubscribed) {
          return { success: false, error: 'an active paid plan is required before top-up', errorCode: 'SUBSCRIPTION_REQUIRED', featureUnavailable: false };
        }
        const pkg = isTopup
          ? mockMeTopupPackages.find((entry) => entry.packageId === input?.packageId)
          : mockMePlans.find((entry) => entry.planId === input?.packageId);
        if (!pkg) return { success: false, error: 'package not found' };
        mockTopupSeq += 1;
        const order = {
          orderId: `me_topup_demo_${String(1000 + mockTopupSeq)}`,
          packageId: 'packageId' in pkg ? pkg.packageId : pkg.planId,
          status: 'submitted',
          createdAt: mockMeNow(),
          meMilli: 'meMilli' in pkg ? pkg.meMilli : pkg.weeklyAmountMilli,
          priceCny: pkg.priceCny,
          raw: {},
        };
        mockMeOrders.unshift(order);
        return { success: true, submission: { order, applied: false } };
      }),
    getTopupOrders: () => guardOnline(async () => ({ success: true, orders: mockMeOrders })),
    getPaymentInfo: () => ({ success: true, payment: { qrContent: 'https://example.com/me-pay/demo', payeeHint: 'Demo payee · ME top-up' } }),
    pickVoucher: () => Promise.resolve({ success: false }),
  };

  const electron: Record<string, unknown> = {
    // REQ-E-3: the server is linux/x64; keep the same values so desktop
    // renderer services that branch on platform never take a desktop path.
    platform: 'linux',
    arch: 'x64',
    getRecentCwds: () => Promise.resolve([]),
    getApiConfig: () => Promise.resolve(null),
    checkApiConfig: () => Promise.resolve({ hasConfig: false, config: null }),
    saveApiConfig: stubFunction('save-api-config'),
    generateSessionTitle: () => Promise.resolve('Mock chat'),
    startup: {
      rendererInitialized: () =>
        guardOnline(async () => ({ success: true, elapsedMs: 15, startedAt: bootAt })),
    },
    window: {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      moveBy: () => undefined,
      showSystemMenu: () => undefined,
      isMaximized: () => Promise.resolve(false),
      onStateChanged: () => () => undefined,
    },
    dialog: {
      selectDirectory: () => Promise.resolve({ success: true, path: null }),
      selectFile: (options?: PhoneFileSelectionOptions) => selectFileOnPhone({
        uploadFile: (file, uploadOptions) => uploadFile(file, {
          ...uploadOptions,
          fetchImpl: mockUploadTransport,
        }),
      }, options),
      saveInlineFile: () => Promise.resolve({ success: true, path: null }),
    },
    shell: {
      openExternal: (url: string) =>
        guardOnline(async () => {
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
            openedUrls.push(url);
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(url, '_blank', 'noopener,noreferrer');
            }
            return { success: true };
          }
          return { success: false };
        }),
      openPath: () => Promise.resolve({ success: false }),
      showItemInFolder: () => Promise.resolve({ success: false }),
      openWith: () => Promise.resolve({ success: false }),
      getOpenWithApps: () => Promise.resolve({ success: true, apps: [] }),
      chooseOpenWithApp: () => Promise.resolve({ success: false }),
    },
    appInfo: {
      getVersion: () => Promise.resolve('1.0.2-mobile.mock'),
      getSystemLocale: () => Promise.resolve(options.systemLocale ?? detectedLocale()),
    },
    store: storeImpl,
    cowork: coworkImpl,
    scheduledTasks: scheduledTasksImpl,
    longtermTask: longtermTaskImpl,
    bundle: bundleImpl,
    mePoints: mePointsImpl,
    mobile: {
      // Channel names aligned with the generated IPC contract / real preload
      // (mobile.listPendingPermissions, mobile.getBootstrapStatus) so screens
      // work against both bridges unchanged.
      listPendingPermissions: () =>
        guardOnline(async () =>
          [...pendingPermissions.values()].map((p) => ({
            sessionId: p.sessionId,
            request: { ...p.request },
            createdAt: p.createdAt,
          })),
        ),
      getBootstrapStatus: () =>
        guardOnline(async () => ({
          identity: 'done',
          llmProvider: 'done',
          twinMetabot: 'done',
          workspace: 'done',
          trafficAccount: 'done',
          redeemCode: 'skipped',
          globalMetaId: 'mock-globalmetaid',
          twinMetabotId: 1,
        })),
    },
    gateway: {
      // Real shape per src/renderer/types/electron.d.ts: the success variant
      // carries {url, expiresAt, size, mime} directly (no success envelope).
      fileSign: (input: { path: string; disposition?: 'inline' | 'attachment' }) =>
        guardOnline(async () => {
          const filePath = String(input?.path ?? '');
          const artifact = getMockArtifact(filePath);
          const disposition = input?.disposition === 'inline' ? 'inline' : 'attachment';
          const expiresAt = now() + (filePath === MOCK_ARTIFACT_PATHS.refresh ? 61_500 : 10 * 60 * 1000);
          return {
            url: `/files/mock/${encodeURIComponent(filePath)}?disposition=${disposition}&expires=${expiresAt}`,
            expiresAt,
            size: artifact?.bytes().byteLength ?? 0,
            mime: artifact?.mime ?? 'application/octet-stream',
          };
        }),
    },
    idbots: {
      createMetaBotOnChain: (input: MetabotCreateInput) =>
        guardOnline(async () => {
          if (!input.llm_id) return { success: false, error: 'LLM Brain is required when creating a MetaBot' };
          const createLocal = metabotImpl.create as (value: MetabotCreateInput) => Promise<{
            success: boolean;
            metabot?: MobileMetabot;
            error?: string;
          }>;
          const created = await createLocal(input);
          if (!created.success || !created.metabot) return created;
          const createdBot = created.metabot;
          const bot = metabotFixtures.find((entry) => entry.id === createdBot.id) ?? createdBot;
          bot.metabot_info_pinid = `mock-info-${bot.id}`;
          bot.chain_sync_state = 'synced';
          bot.chain_sync_pending_steps = [];
          bot.subsidy_state = 'claimed';
          return { success: true, metabot: { ...bot }, subsidy: { success: true } };
        }),
      resumeMetabotSetup: (input: { metabotId: number; mode: 'subsidized' | 'self-funded' }) =>
        guardOnline(async () => {
          const bot = metabotFixtures.find((entry) => entry.id === input.metabotId);
          if (!bot) return { success: false, mode: input.mode, error: 'metabot not found' };
          bot.metabot_info_pinid = bot.metabot_info_pinid ?? `mock-info-${bot.id}`;
          bot.chain_sync_state = 'synced';
          bot.chain_sync_pending_steps = [];
          bot.subsidy_state = 'claimed';
          return {
            success: true,
            mode: input.mode,
            metabot: { ...bot },
            subsidy: { success: true },
            chain: { success: true, txids: [`mock-resume-${bot.id}`] },
          };
        }),
      syncMetaBot: (metabotId: number) =>
        guardOnline(async () => {
          const bot = metabotFixtures.find((entry) => entry.id === metabotId);
          if (!bot) return { success: false, error: 'metabot not found' };
          bot.metabot_info_pinid = bot.metabot_info_pinid ?? `mock-info-${bot.id}`;
          bot.chain_sync_state = 'synced';
          bot.chain_sync_pending_steps = [];
          return { success: true, metabotInfoPinId: bot.metabot_info_pinid, txids: [`mock-sync-${bot.id}`] };
        }),
      getAddressBalance: (options?: { metabotId?: number }) =>
        guardOnline(async () => ({
          success: true,
          balance: {
            mvc: {
              value: options?.metabotId ? 0.0002 : 0.001,
              unit: 'MVC',
            },
          },
        })),
    },
    metabot: metabotImpl,
    userIdentity: {
      get: () =>
        guardOnline(async () => ({
          success: true,
          identity: { ...mockIdentity },
        })),
      // A6 mock parity (IA-PLAN §5): the profile page drives updateName and
      // the two retry channels; all three are in the real IPC contract.
      updateName: (input: { name: string }) =>
        guardOnline(async () => {
          const name = typeof input?.name === 'string' ? input.name.trim() : '';
          if (!name) return { success: false, error: 'name is required' };
          mockIdentity.name = name;
          mockIdentity.updated_at = now();
          return { success: true, identity: { ...mockIdentity }, chainSync: { success: true, txids: [`mock-name-${now()}`] } };
        }),
      retrySubsidy: () =>
        guardOnline(async () => ({
          success: true,
          identity: { ...mockIdentity },
          subsidy: { success: true },
        })),
      retryChainSync: () =>
        guardOnline(async () => ({
          success: true,
          identity: { ...mockIdentity },
          subsidy: { success: true },
          chainSync: { success: true, txids: [`mock-sync-${now()}`] },
        })),
    },
    skills: {
      list: () =>
        guardOnline(async () => ({
          success: true,
          skills: skillFixtures.map((skill) => ({ ...skill })),
        })),
      setEnabled: (options: { id: string; enabled: boolean }) =>
        guardOnline(async () => {
          const skill = skillFixtures.find((entry) => entry.id === options?.id);
          if (!skill) return { success: false, error: 'skill not found' };
          skill.enabled = Boolean(options.enabled);
          skill.updatedAt = now();
          emitter.emit('skills:changed', { id: skill.id, enabled: skill.enabled });
          return { success: true, skills: skillFixtures.map((entry) => ({ ...entry })) };
        }),
      onChanged: (callback: () => void) => emitter.on('skills:changed', callback as never),
    },
    traffic: {
      getBalance: () =>
        guardOnline(async () => ({ success: true, balance: { ...meters.traffic } })),
      // A6 mock parity (IA-PLAN §4.4): ledger / usage / free-grant channels
      // for the traffic secondary page; all in the real IPC contract.
      getLedger: (input?: { cursor?: number; limit?: number; direction?: number }) =>
        guardOnline(async () => {
          const cursor = typeof input?.cursor === 'number' && input.cursor >= 0 ? input.cursor : 0;
          const limit = typeof input?.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 100) : 20;
          const slice = ledgerEntries.slice(cursor, cursor + limit);
          const next = cursor + slice.length;
          return {
            success: true,
            entries: slice.map((entry) => ({ ...entry })),
            nextCursor: next < ledgerEntries.length ? next : undefined,
          };
        }),
      getUsageSummary: () =>
        guardOnline(async () => ({
          success: true,
          summary: {
            todayBytes: 3 * 1024 * 1024,
            weekBytes: 21 * 1024 * 1024,
            monthBytes: 66 * 1024 * 1024,
          },
        })),
      getDailyUsage: () =>
        guardOnline(async () => ({
          success: true,
          rows: [
            { date: '2026-10-29', botAddress: 'mock-twin-address', bytes: 2 * 1024 * 1024, txCount: 12 },
            { date: '2026-10-28', botAddress: 'mock-worker-address', bytes: 1024 * 1024, txCount: 5 },
          ],
        })),
      claimFreeGrant: () =>
        guardOnline(async () => {
          if (freeGrantClaimed) {
            return { success: false, error: 'free grant already claimed', errorCode: 'FREE_GRANT_ALREADY_CLAIMED' };
          }
          freeGrantClaimed = true;
          meters.traffic.balanceBytes += FREE_GRANT_BYTES;
          meters.traffic.grantedBytesTotal += FREE_GRANT_BYTES;
          return {
            success: true,
            claim: { grantId: 1, grantBytes: FREE_GRANT_BYTES, balanceAfter: meters.traffic.balanceBytes },
          };
        }),
      redeemCode: (input: { code: string }) =>
        guardOnline(async () => {
          const code = typeof input?.code === 'string' ? input.code.trim() : '';
          if (!code) return { success: false, error: 'code is required' };
          if (code === 'BAD') {
            return { success: false, error: 'redeem code is invalid', errorCode: 'INVALID_CODE' };
          }
          meters.traffic.balanceBytes += REDEEM_CODE_GRANT_BYTES;
          meters.traffic.grantedBytesTotal += REDEEM_CODE_GRANT_BYTES;
          redeemSeq += 1;
          const result = {
            codeId: redeemSeq,
            trafficBytes: REDEEM_CODE_GRANT_BYTES,
            balanceAfter: meters.traffic.balanceBytes,
          };
          return { success: true, result };
        }),
    },
    llmRelay: {
      getQuota: () =>
        guardOnline(async () => ({
          success: true,
          quota: {
            keyPrefix: 'mock',
            baseUrl: 'https://mock.invalid/relay',
            models: [],
            ...meters.llm,
            quotaCycleResetAt: 0,
            jevQuotaTotal: 0,
            jevQuotaUsed: 0,
            jevQuotaRemaining: 0,
          },
        })),
    },
  };

  // Every remaining namespace from IElectronAPI exists but rejects, so a
  // renderer service touching an unimplemented channel gets a named Error
  // instead of a TypeError on undefined.
  const namespaceNames = [
    'powerGuard', 'metaapps', 'metaappOwner', 'botBrowser', 'agentGame', 'api', 'gigSquare',
    'deepseek', 'appEvents', 'fs', 'autoLaunch', 'experimentalAutomation', 'feeRates',
    'appUpdate', 'im', 'longtermTask', 'metatask', 'preference', 'groupTask', 'openTeamCollab',
    'idbots', 'chainBackup', 'metaWebListener', 'dream', 'knowledgeBase', 'metawebStudy',
    'surf', 'permissions', 'networkStatus', 'mcp', 'projects', 'p2p', 'providerDiscovery',
    'jevRelay',
  ] as const;
  for (const name of namespaceNames) {
    const existing = electron[name];
    electron[name] = stubNamespace(name, (existing as Record<string, unknown>) ?? {});
  }
  // Wrap the implemented namespaces too, so even they reject (never TypeError)
  // on methods the mock did not implement.
  for (const name of ['store', 'cowork', 'scheduledTasks', 'bundle', 'mobile', 'gateway', 'metabot', 'skills', 'traffic', 'llmRelay', 'startup', 'window', 'dialog', 'shell', 'appInfo', 'userIdentity'] as const) {
    electron[name] = stubNamespace(name, (electron[name] as Record<string, unknown>) ?? {});
  }

  const api = new Proxy(electron, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop in target) return (target as Record<string, unknown>)[prop];
      // Flat IElectronAPI members that the mock did not implement still
      // reject with a named error instead of being undefined.
      return stubFunction(prop);
    },
  }) as unknown as MockElectronAPI;

  // --------------------------------------------------------- connection bus
  const setConnectionState = (state: ConnectionState) => {
    if (connectionState === state || destroyed) return;
    connectionState = state;
    emitter.emit('connection:change', state);
  };

  const control = {
    simulateReconnect: () => {
      if (connectionState !== 'online') return;
      setConnectionState('reconnecting');
      later(() => setConnectionState('online'), reconnectBlackoutMs);
    },
    getConnectionState: () => connectionState,
    getOpenedUrls: () => [...openedUrls],
    setMeSubscribed: (value: boolean) => {
      mockMeSubscribed = value;
    },
    emitCoworkStream: (channel: MobileMockCoworkStreamChannel, payload: unknown) => {
      if (channel === 'permission') {
        const event = payload as {
          sessionId: string;
          request: PendingPermissionRequest['request'];
        };
        pendingPermissions.set(event.request.requestId, {
          sessionId: event.sessionId,
          request: event.request,
          createdAt: now(),
        });
        permissionWaiters.set(event.request.requestId, () => {
          pendingPermissions.delete(event.request.requestId);
          emitter.emit('cowork:stream:permissionResolved', {
            sessionId: event.sessionId,
            requestId: event.request.requestId,
          });
        });
      } else if (channel === 'permissionResolved') {
        const event = payload as { requestId: string };
        pendingPermissions.delete(event.requestId);
        permissionWaiters.delete(event.requestId);
      }
      emitter.emit(`cowork:stream:${channel}`, payload);
    },
  };

  return {
    electron: api,
    connection: {
      getState: () => connectionState,
      onChange: (callback: (state: ConnectionState) => void) => emitter.on('connection:change', callback as never),
    },
    control,
    destroy: () => {
      destroyed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const resolve of permissionWaiters.values()) resolve('destroyed');
      permissionWaiters.clear();
      emitter.clear();
    },
  };
}
