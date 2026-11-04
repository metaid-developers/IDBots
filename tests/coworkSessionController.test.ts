import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CoworkMessage,
  CoworkMessagePage,
  CoworkPermissionResult,
  CoworkSession,
  CoworkSessionStatus,
  CoworkStartOptions,
  CoworkSubmitInput,
} from '../src/renderer/types/cowork';
import {
  CoworkSessionController,
  detectSideEffectOutcome,
  MOBILE_DRAFTS_STORAGE_KEY,
  MOBILE_OPEN_SESSION_STORAGE_KEY,
  type CoworkRecoveryStorage,
  type PendingPermissionEntry,
} from '../src/renderer/services/coworkSessionController';
import { MOBILE_DRAFTS_V2_STORAGE_KEY } from '../src/renderer/services/coworkSessionDrafts';

type Listener = (payload: unknown) => void;

function message(
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
): CoworkMessage {
  return { id, type, content, timestamp: 1, ...(metadata ? { metadata } : {}) };
}

function session(
  id: string,
  status: CoworkSessionStatus = 'running',
  messages: CoworkMessage[] = [],
): CoworkSession {
  return {
    id,
    title: id === 'started' ? 'Started session' : 'Existing session',
    claudeSessionId: null,
    status,
    pinned: false,
    cwd: '/data/workspace',
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages,
    createdAt: 1,
    updatedAt: 1,
    metabotId: 1,
  };
}

function makeHarness() {
  const listeners = new Map<string, Listener>();
  let current = session('s1');
  const harness = {
    startOptions: null as CoworkStartOptions | null,
    sessionsEmpty: false,
    submitCalls: [] as CoworkSubmitInput[],
    permissionResults: [] as CoworkPermissionResult[],
    pending: [] as PendingPermissionEntry[],
    submitHandler: null as ((input: CoworkSubmitInput) => Promise<unknown>) | null,
    getSessionHandler: null as (() => Promise<unknown>) | null,
    historyPage: null as CoworkMessagePage | null,
    get session() { return current; },
    set session(value: CoworkSession) { current = value; },
    emit(name: string, payload: unknown) { listeners.get(name)?.(payload); },
  };
  const on = (name: string) => (listener: Listener) => {
    listeners.set(name, listener);
    return () => listeners.delete(name);
  };
  const electron = {
    cowork: {
      onStreamMessage: on('message'),
      onStreamMessageUpdate: on('update'),
      onStreamPermission: on('permission'),
      onStreamPermissionResolved: on('permissionResolved'),
      onStreamComplete: on('complete'),
      onStreamError: on('error'),
      onStreamSessionTitle: on('title'),
      createGreetingSession: async (options: { title: string; fallbackGreeting: string; metabotId: number }) => {
        current = session('greeting', 'completed', [
          message('greeting-message', 'assistant', options.fallbackGreeting, { isFinal: true }),
        ]);
        current.title = options.title;
        current.metabotId = options.metabotId;
        return { success: true, session: structuredClone(current) };
      },
      startSession: async (options: CoworkStartOptions) => {
        harness.startOptions = options;
        current = session('started', 'running', [message('u1', 'user', options.prompt)]);
        const live = message('a1', 'assistant', 'synchronous live', { isStreaming: true });
        current.messages.push(live);
        harness.emit('message', { sessionId: current.id, message: live });
        return { success: true, session: structuredClone(current) };
      },
      submitInput: async (input: CoworkSubmitInput) => {
        harness.submitCalls.push(input);
        if (harness.submitHandler) return harness.submitHandler(input);
        const persisted = message(`server-${harness.submitCalls.length}`, 'user', input.text, {
          submissionId: input.submissionId,
        });
        current.messages.push(persisted);
        return { success: true, mode: 'steer', message: persisted };
      },
      getSession: async () => {
        if (harness.getSessionHandler) return harness.getSessionHandler();
        return { success: true, session: structuredClone(current) };
      },
      listSessions: async () => ({
        success: true,
        sessions: harness.sessionsEmpty ? [] : [structuredClone(current)],
      }),
      getSessionMessagesPage: async () => ({
        success: true,
        page: harness.historyPage ?? { messages: [], hasMoreBefore: false, beforeSequence: null },
      }),
      getStreamLiveContent: async ({ messageId }: { messageId: string }) => ({
        success: true,
        content: current.messages.find((entry) => entry.id === messageId)?.content ?? '',
      }),
      stopSession: async () => {
        current.status = 'idle';
        return { success: true };
      },
      respondToPermission: async ({ result }: { result: CoworkPermissionResult }) => {
        harness.permissionResults.push(result);
        return { success: true };
      },
      getConfig: async () => ({ success: true, config: { workingDirectory: '/data/workspace', systemPrompt: '' } }),
    },
    mobile: {
      listPendingPermissions: async () => harness.pending,
    },
  };
  return { harness, electron };
}

function controllerFor(
  electron: unknown,
  storage?: CoworkRecoveryStorage,
): CoworkSessionController {
  return new CoworkSessionController({
    electron: electron as never,
    storage,
    now: () => 100,
    createSubmissionId: () => '11111111-1111-4111-8111-111111111111',
  });
}

describe('cowork session controller', () => {
  it('preserves stream events emitted synchronously before start resolves', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());

    const result = await controller.send('start work', { metabotId: 1, title: 'Start work' });
    assert.equal(result.status, 'accepted');
    assert.equal(harness.startOptions?.metabotId, 1);
    const state = controller.getSnapshot().states.get('started');
    assert.ok(state?.messages.some((entry) => entry.id === 'a1' && entry.content === 'synchronous live'));
    assert.equal(controller.getSnapshot().currentSessionId, 'started');
  });

  it('preserves the original start error through automatic reconciliation', async (t) => {
    const { electron } = makeHarness();
    electron.cowork.startSession = async () => { throw new Error('WP0_START_FAILED'); };
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());

    const result = await controller.send('start work', { metabotId: 1, title: 'Start work' });
    assert.equal(result.status, 'uncertain');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(controller.getSnapshot().actionErrors.new, 'WP0_START_FAILED');
  });

  it('keeps background messages, completion, and permissions out of the open session', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    harness.emit('message', { sessionId: 's1', message: message('u1', 'user', 'keep running') });
    harness.emit('message', { sessionId: 'bg', message: message('bg-text', 'assistant', 'BACKGROUND') });
    harness.emit('complete', { sessionId: 'bg' });
    harness.emit('permission', {
      sessionId: 'bg',
      request: { sessionId: 'bg', requestId: 'bg-request', toolName: 'Bash', toolInput: {} },
    });

    const visible = controller.getSnapshot().states.get('s1')!;
    assert.equal(visible.status, 'running');
    assert.equal(visible.pendingPermissions.length, 0);
    assert.ok(!visible.messages.some((entry) => entry.id === 'bg-text'));
    const background = controller.getSnapshot().states.get('bg')!;
    assert.equal(background.status, 'completed');
    assert.equal(background.pendingPermissions.length, 1);
    assert.equal(background.unread, true);
  });

  it('rejects a snapshot that was requested before newer stream content arrived', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    const live = message('a1', 'assistant', 'partial', { isStreaming: true });
    harness.session.messages = [live];
    harness.emit('message', { sessionId: 's1', message: live });

    let release!: () => void;
    harness.getSessionHandler = () => new Promise((resolve) => {
      release = () => resolve({ success: true, session: structuredClone(harness.session) });
    });
    const refreshing = controller.refreshSession('s1');
    harness.emit('update', { sessionId: 's1', messageId: 'a1', content: 'newer text' });
    release();
    await refreshing;
    assert.equal(controller.getSnapshot().states.get('s1')?.messages[0]?.content, 'newer text');
  });

  it('uses the same UUID for an existing-session retry and settles only after acceptance', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    let calls = 0;
    harness.submitHandler = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('connection lost');
      const persisted = message('server-retry', 'user', input.text, { submissionId: input.submissionId });
      harness.session.messages.push(persisted);
      return { success: true, mode: 'steer', message: persisted };
    };

    const first = await controller.send('repeat', { metabotId: 1, title: 'Retry' });
    assert.equal(first.status, 'uncertain');
    const second = await controller.retrySubmission(first.submissionId!);
    assert.equal(second.status, 'accepted');
    assert.equal(harness.submitCalls.length, 2);
    assert.equal(harness.submitCalls[0]?.submissionId, harness.submitCalls[1]?.submissionId);
    assert.equal(controller.getSnapshot().attempts.length, 0);
  });

  it('does not turn an accepted stop into a settled UI when authoritative refresh fails', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    harness.getSessionHandler = async () => { throw new Error('refresh unavailable'); };

    const result = await controller.stop();
    assert.equal(result.status, 'uncertain');
    assert.ok(result.refreshError);
    assert.equal(controller.getSnapshot().states.get('s1')?.status, 'running');
    assert.equal(controller.getSnapshot().stoppingSessionIds.size, 0);
  });

  it('passes the exact permission result and removes remote resolutions without an invented outcome', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    const request = {
      sessionId: 's1', requestId: 'r1', toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
    };
    harness.emit('permission', { sessionId: 's1', request });
    const result: CoworkPermissionResult = {
      behavior: 'allow',
      updatedInput: { ...request.toolInput, answers: { Pick: 'A' } },
    };
    const answered = await controller.respondPermission('r1', result);
    assert.equal(answered.status, 'accepted');
    assert.deepEqual(harness.permissionResults, [result]);
    assert.equal(controller.getSnapshot().states.get('s1')?.pendingPermissions.length, 0);

    harness.emit('permission', { sessionId: 's1', request: { ...request, requestId: 'r2' } });
    harness.emit('permissionResolved', { sessionId: 's1', requestId: 'r2' });
    const state = controller.getSnapshot().states.get('s1')!;
    assert.equal(state.pendingPermissions.length, 0);
    assert.equal('resolved' in state, false);
  });

  it('restores the saved running session and recovers its active stream metadata', async (t) => {
    const { harness, electron } = makeHarness();
    harness.session = session('s1', 'running', [message('a1', 'assistant', 'partial', { isStreaming: true })]);
    const values = new Map<string, string>([[MOBILE_OPEN_SESSION_STORAGE_KEY, 's1']]);
    const storage: CoworkRecoveryStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const controller = controllerFor(electron, storage);
    t.after(() => controller.destroy());

    await controller.restore(1);
    assert.equal(controller.getSnapshot().currentSessionId, 's1');
    assert.equal(controller.getSnapshot().states.get('s1')?.status, 'running');
    assert.deepEqual(controller.getStreamingMessage(), { sessionId: 's1', messageId: 'a1' });
    controller.setDraft('preserved draft');
    assert.equal(controller.getDraft(), 'preserved draft');
  });

  it('keeps a restored session when a newer refresh supersedes the open request', async (t) => {
    const { harness, electron } = makeHarness();
    harness.session = session('s1', 'running', [message('a1', 'assistant', 'partial', { isStreaming: true })]);
    const values = new Map<string, string>([[MOBILE_OPEN_SESSION_STORAGE_KEY, 's1']]);
    const storage: CoworkRecoveryStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const controller = controllerFor(electron, storage);
    t.after(() => controller.destroy());

    let releaseFirst!: () => void;
    let firstRequest = true;
    harness.getSessionHandler = () => {
      if (firstRequest) {
        firstRequest = false;
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ success: true, session: structuredClone(harness.session) });
        });
      }
      return Promise.resolve({ success: true, session: structuredClone(harness.session) });
    };
    const restoring = controller.restore(1, { title: 'Welcome', fallbackGreeting: 'Unexpected greeting' });
    for (let index = 0; index < 20 && !releaseFirst; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(typeof releaseFirst, 'function');
    assert.equal(await controller.refreshSession('s1'), true);
    harness.getSessionHandler = async () => ({ success: false, error: 'Fallback refresh must not be needed' });
    releaseFirst();
    await restoring;

    assert.equal(controller.getSnapshot().currentSessionId, 's1');
    assert.equal(controller.getSnapshot().states.get('s1')?.status, 'running');
    assert.equal(harness.session.id, 's1');
  });

  it('creates a Twin greeting only when no session can be restored', async (t) => {
    const { harness, electron } = makeHarness();
    harness.sessionsEmpty = true;
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());

    controller.setDraft('greeting draft');
    controller.addAttachments(controller.getDraftToken(), [{
      path: '/data/workspace/uploads/greeting.txt', name: 'greeting.txt', size: 4, mime: 'text/plain',
    }]);
    await controller.restore(1, { title: 'Welcome', fallbackGreeting: 'Hello from Twin' });
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.currentSessionId, 'greeting');
    assert.equal(snapshot.states.get('greeting')?.metabotId, 1);
    assert.equal(snapshot.states.get('greeting')?.title, 'Welcome');
    assert.equal(snapshot.states.get('greeting')?.messages[0]?.content, 'Hello from Twin');
    assert.equal(snapshot.restoring, false);
    assert.equal(controller.getDraft(), 'greeting draft');
    assert.deepEqual(controller.getAttachments().map((attachment) => attachment.name), ['greeting.txt']);
    assert.equal(snapshot.drafts.new, undefined);
  });

  it('composes attachment-only starts and running-session steers with the desktop manifest', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    const attachments = [
      { path: '/data/workspace/uploads/a.txt', name: 'a.txt', size: 1, mime: 'text/plain' },
      { path: '/data/workspace/uploads/b.pdf', name: 'b.pdf', size: 2, mime: 'application/pdf' },
    ];

    const started = await controller.send('', { metabotId: 1 }, attachments, 'Input file');
    assert.equal(started.status, 'accepted');
    assert.equal(harness.startOptions?.prompt, 'Input file: /data/workspace/uploads/a.txt\nInput file: /data/workspace/uploads/b.pdf');
    assert.equal(harness.startOptions?.title, 'a.txt');
    assert.equal(harness.startOptions?.title.includes('/data/'), false);
    assert.deepEqual(controller.getAttachments(), []);

    harness.session = session('s1', 'running', [
      message('live', 'assistant', 'working', { isStreaming: true }),
    ]);
    await controller.openSession('s1');
    assert.equal(controller.getSnapshot().states.get('s1')?.status, 'running');
    const steered = await controller.send('inspect', { metabotId: 1 }, attachments, 'Input file');
    assert.equal(steered.status, 'accepted');
    assert.equal(harness.submitCalls[0]?.text, 'inspect\n\nInput file: /data/workspace/uploads/a.txt\nInput file: /data/workspace/uploads/b.pdf');
  });

  it('restores text and attachments on failed or uncertain sends without changing the retry prompt', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    const attachments = [{ path: '/data/workspace/uploads/a.txt', name: 'a.txt', size: 1, mime: 'text/plain' }];
    controller.setDraft('review this');
    controller.addAttachments(controller.getDraftToken(), attachments);
    let calls = 0;
    harness.submitHandler = async (input) => {
      calls += 1;
      if (calls === 1) return { success: false, error: 'refused' };
      if (calls === 2) throw new Error('connection lost');
      const persisted = message('accepted-after-retry', 'user', input.text, { submissionId: input.submissionId });
      harness.session.messages.push(persisted);
      return { success: true, mode: 'steer', message: persisted };
    };

    const first = await controller.send('review this', { metabotId: 1 }, attachments, 'Input file');
    assert.equal(first.status, 'failed');
    assert.equal(controller.getDraft(), 'review this');
    assert.deepEqual(controller.getAttachments(), attachments);
    const second = await controller.retrySubmission(first.submissionId!);
    assert.equal(second.status, 'uncertain');
    assert.equal(controller.getDraft(), 'review this');
    assert.deepEqual(controller.getAttachments(), attachments);
    const third = await controller.retrySubmission(first.submissionId!);
    assert.equal(third.status, 'accepted');
    const prompt = 'review this\n\nInput file: /data/workspace/uploads/a.txt';
    assert.deepEqual(harness.submitCalls.map((call) => call.text), [prompt, prompt, prompt]);
    assert.equal(harness.submitCalls[0]?.text.split('/data/workspace/uploads/a.txt').length, 2);
    assert.equal(controller.getDraft(), '');
    assert.deepEqual(controller.getAttachments(), []);
  });

  it('F-17b: a 120s timeout that actually succeeded reconciles to verified, not unknown (阿燃 case)', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    harness.submitHandler = async () => {
      // Gateway C2 TIMEOUT: "no result within 120000ms" (tenant side kept the
      // handler running; the work actually completed).
      throw new Error('no result within 120000ms');
    };
    const first = await controller.send('帮我创建一个新 bot');
    assert.equal(first.status, 'uncertain');

    // Tenant keeps running while the phone shows the unknown card: the tool
    // finishes on the server with its completion certificate in the
    // transcript. Uses the exact tool_result text the tenant persisted.
    harness.session.messages.push(
      { id: 't-u', type: 'user', content: '帮我创建一个新 bot', timestamp: 90, metadata: {} } as never,
      {
        id: 't-use', type: 'tool_use', content: 'Using tool: metabot_create', timestamp: 95,
        metadata: { toolName: 'metabot_create', toolUseId: 'call_01_sj7v', isError: false },
      } as never,
      {
        id: 't-result', type: 'tool_result', content: 'MetaBot created: 阿燃 (id=2, type=worker)',
        timestamp: 130,
        metadata: {
          toolResult: 'MetaBot created: 阿燃 (id=2, type=worker, llm=deepseek-4.1-flash).\nIdentity registered on-chain (globalMetaID: idq12waww7cx7rwnwyffegdf4zqr2u2gumdcdav40y).',
          toolUseId: 'call_01_sj7v', isError: false,
        },
      } as never,
    );

    // Auto reconcile fires without any user click.
    let verified = false;
    for (let attempt = 0; attempt < 50 && !verified; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      verified = controller.getSnapshot().attempts.some((entry) => entry.status === 'verified');
    }
    assert.ok(verified, 'auto reconcile must surface the verified conclusion');
    const entry = controller.getSnapshot().attempts.find((attempt) => attempt.status === 'verified')!;
    assert.match(entry.error ?? '', /MetaBot created: 阿燃/);
    // Verify is terminal: no manual reconcile click needed, no retry prompt.
    assert.equal(entry.error?.includes('The tenant has not confirmed'), false);
  });

  it('F-17b: reconcile with no server evidence stays uncertain and clears the auto pin', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    harness.submitHandler = async () => {
      throw new Error('no result within 120000ms');
    };
    const first = await controller.send('plain request');
    assert.equal(first.status, 'uncertain');
    let settled = false;
    for (let attempt = 0; attempt < 50 && !settled; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled = controller.getSnapshot().attempts.every(
        (entry) => entry.status === 'uncertain' || entry.status === 'reconciling',
      );
    }
    const statuses = controller.getSnapshot().attempts.map((entry) => entry.status);
    assert.notEqual(statuses.length, 0);
    assert.ok(statuses.every((status) => status === 'uncertain'), `settled back to uncertain, got: ${statuses.join()}`);
    // Draft survives — the user can still decide (retry / discard).
    assert.equal(controller.getDraft().length > 0, true);
  });

  it('detectSideEffectOutcome maps the incident transcript to the completion certificate', () => {
    const attempt = { createdAt: 100 };
    const created = [
      { id: 'u', type: 'user' as const, content: 'hi', timestamp: 1, metadata: {} },
      { id: 'use', type: 'tool_use' as const, content: '', timestamp: 110, metadata: { toolName: 'metabot_create', toolUseId: 'id-a', isError: false } },
      { id: 'res', type: 'tool_result' as const, content: '', timestamp: 120, metadata: { toolResult: 'MetaBot created: 测试号 (id=3).', toolUseId: 'id-a', isError: false } },
    ];
    assert.match(detectSideEffectOutcome(created, attempt) ?? '', /MetaBot created: 测试号/);
    // A failed creation (isError) is NOT a completion certificate.
    const failed = [...created];
    (failed[2].metadata as Record<string, unknown>).isError = true;
    assert.equal(detectSideEffectOutcome(failed, attempt), null);
    // Older off-attempt tool uses cannot fabricate the certificate either.
    const stale = [{ id: 'use2', type: 'tool_use' as const, content: '', timestamp: 1, metadata: { toolName: 'metabot_create', toolUseId: 'id-b', isError: false } },
      { id: 'res2', type: 'tool_result' as const, content: '', timestamp: 2, metadata: { toolResult: 'MetaBot created: 旧的 (id=9).', toolUseId: 'id-b', isError: false } }];
    assert.equal(detectSideEffectOutcome(stale, { createdAt: 100_000_000 }), null);
  });

  it('keeps text and attachments durable until the tenant accepts the submission', async (t) => {
    const { harness, electron } = makeHarness();
    const values = new Map<string, string>();
    const storage: CoworkRecoveryStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const controller = controllerFor(electron, storage);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    const attachments = [{ path: '/data/workspace/uploads/a.txt', name: 'a.txt', size: 1, mime: 'text/plain' }];
    controller.setDraft('preserve while pending');
    controller.addAttachments(controller.getDraftToken(), attachments);
    let accept!: () => void;
    harness.submitHandler = (input) => new Promise((resolve) => {
      accept = () => {
        const persisted = message('accepted-after-reload', 'user', input.text, { submissionId: input.submissionId });
        harness.session.messages.push(persisted);
        resolve({ success: true, mode: 'steer', message: persisted });
      };
    });

    const sending = controller.send('preserve while pending', { metabotId: 1 }, attachments, 'Input file');
    assert.equal(controller.getDraft(), 'preserve while pending');
    assert.deepEqual(controller.getAttachments(), attachments);
    const pendingReload = controllerFor(electron, storage);
    t.after(() => pendingReload.destroy());
    await pendingReload.openSession('s1');
    assert.equal(pendingReload.getDraft(), 'preserve while pending');
    assert.deepEqual(pendingReload.getAttachments(), attachments);

    accept();
    assert.equal((await sending).status, 'accepted');
    assert.equal(controller.getDraft(), '');
    assert.deepEqual(controller.getAttachments(), []);
    const acceptedReload = controllerFor(electron, storage);
    t.after(() => acceptedReload.destroy());
    await acceptedReload.openSession('s1');
    assert.equal(acceptedReload.getDraft(), '');
    assert.deepEqual(acceptedReload.getAttachments(), []);
  });

  it('keeps legacy text and attachment metadata per session through reload and late uploads', async (t) => {
    const { harness, electron } = makeHarness();
    const values = new Map<string, string>([
      [MOBILE_OPEN_SESSION_STORAGE_KEY, 's1'],
      [MOBILE_DRAFTS_STORAGE_KEY, JSON.stringify({ s1: 'legacy text' })],
    ]);
    const storage: CoworkRecoveryStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const controller = controllerFor(electron, storage);
    t.after(() => controller.destroy());
    await controller.restore(1);
    const first = { path: '/data/workspace/uploads/first.txt', name: 'first.txt', size: 1, mime: 'text/plain' };
    const late = { path: '/data/workspace/uploads/late.txt', name: 'late.txt', size: 2, mime: 'text/plain' };
    const other = { path: '/data/workspace/uploads/other.txt', name: 'other.txt', size: 3, mime: 'text/plain' };
    const firstToken = controller.getDraftToken();
    controller.addAttachments(firstToken, [first]);
    harness.session = session('s2');
    await controller.openSession('s2');
    assert.deepEqual(controller.getAttachments(), []);
    controller.addAttachments(firstToken, [late]);
    controller.addAttachments(controller.getDraftToken(), [other]);
    controller.removeAttachment(firstToken, first.path);
    assert.deepEqual(controller.getAttachments(), [other]);
    await controller.openSession('s1');
    assert.deepEqual(controller.getAttachments(), [late]);

    const reloaded = controllerFor(electron, storage);
    t.after(() => reloaded.destroy());
    await reloaded.openSession('s1');
    assert.equal(reloaded.getDraft(), 'legacy text');
    assert.deepEqual(reloaded.getAttachments(), [late]);
    const persisted = JSON.parse(values.get(MOBILE_DRAFTS_V2_STORAGE_KEY)!) as {
      version: number;
      drafts: Record<string, { attachments: Array<Record<string, unknown>> }>;
    };
    assert.equal(persisted.version, 2);
    assert.equal(persisted.drafts.s1?.attachments[0]?.path, late.path);
    assert.equal('bytes' in persisted.drafts.s1!.attachments[0]!, false);
  });

  it('restores an explicit new composer instead of opening an older session', async (t) => {
    const { harness, electron } = makeHarness();
    const values = new Map<string, string>([
      [MOBILE_OPEN_SESSION_STORAGE_KEY, ''],
      [MOBILE_DRAFTS_STORAGE_KEY, JSON.stringify({ new: 'unsent new-chat draft' })],
    ]);
    const storage: CoworkRecoveryStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const controller = controllerFor(electron, storage);
    t.after(() => controller.destroy());

    await controller.restore(1, { title: 'Welcome', fallbackGreeting: 'Hello from Twin' });
    assert.equal(controller.getSnapshot().currentSessionId, null);
    assert.equal(controller.getDraft(), 'unsent new-chat draft');
    assert.equal(controller.getSnapshot().restoring, false);
  });

  it('keeps earlier history pages in order through pagination and later snapshots', async (t) => {
    const { harness, electron } = makeHarness();
    harness.session = session('s1', 'running', [{ ...message('latest', 'assistant', 'latest'), sequence: 5 }]);
    harness.session.messageHistory = {
      hasMoreBefore: true,
      beforeSequence: 5,
      beforeTranscriptCursor: 'cursor-5',
      pageSize: 1,
    };
    harness.historyPage = {
      messages: [{ ...message('older', 'assistant', 'older'), sequence: 4 }],
      hasMoreBefore: false,
      beforeSequence: 4,
      beforeTranscriptCursor: 'cursor-4',
    };
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    assert.equal(await controller.loadEarlierMessages(), true);
    assert.deepEqual(
      controller.getSnapshot().states.get('s1')?.messages.map((entry) => entry.id),
      ['older', 'latest'],
    );

    harness.session.messages = [{ ...message('latest', 'assistant', 'latest'), sequence: 5 }];
    harness.session.messageHistory = {
      hasMoreBefore: false,
      beforeSequence: 4,
      beforeTranscriptCursor: 'cursor-4',
      pageSize: 1,
    };
    await controller.refreshSession('s1');
    assert.deepEqual(
      controller.getSnapshot().states.get('s1')?.messages.map((entry) => entry.id),
      ['older', 'latest'],
    );
    assert.equal(controller.getSnapshot().states.get('s1')?.messageHistory?.hasMoreBefore, false);
  });
});
