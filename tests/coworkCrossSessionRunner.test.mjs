import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadCompiledModule('../dist-electron/main/libs/coworkRunner.js');

class FakeCoworkStore {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.sessions = new Map();
    this.messageSeq = 0;
    this.updateLog = [];
  }

  createSession(id, overrides = {}) {
    const now = 1_700_000_000_000 + this.sessions.size;
    const session = {
      id,
      title: overrides.title ?? id,
      claudeSessionId: overrides.claudeSessionId ?? null,
      status: overrides.status ?? 'idle',
      pinned: overrides.pinned ?? false,
      cwd: overrides.cwd ?? this.cwd,
      systemPrompt: overrides.systemPrompt ?? '',
      executionMode: overrides.executionMode ?? 'local',
      activeSkillIds: overrides.activeSkillIds ?? [],
      messages: [...(overrides.messages ?? [])],
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
      metabotId: overrides.metabotId ?? 1,
      sessionType: overrides.sessionType ?? 'standard',
      peerGlobalMetaId: overrides.peerGlobalMetaId ?? null,
      peerName: overrides.peerName ?? null,
      hiddenFromSessionList: overrides.hiddenFromSessionList ?? false,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  getSessionMetadata(id) {
    const session = this.getSession(id);
    return session ? { ...session, messages: [] } : null;
  }

  getSessionLatestMessage(id) {
    const session = this.getSession(id);
    return session?.messages.at(-1) ?? null;
  }

  // GT#12 N3: readLatest now queries the latest EXTERNALLY VISIBLE message
  // (skipping isThinking/isStreaming drafts). This fake's messages are all
  // visible, so it matches getSessionLatestMessage.
  getSessionLatestVisibleMessage(id) {
    return this.getSessionLatestMessage(id);
  }

  addMessage(id, message) {
    const session = this.getSession(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    const stored = {
      id: `msg-${++this.messageSeq}`,
      type: message.type,
      content: message.content,
      timestamp: 1_700_000_100_000 + this.messageSeq,
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };
    session.messages.push(stored);
    session.updatedAt = stored.timestamp;
    return stored;
  }

  updateSession(id, patch) {
    const session = this.getSession(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    Object.assign(session, patch);
    this.updateLog.push({ id, patch });
  }

  getConfig() {
    return {
      workingDirectory: this.cwd,
      systemPrompt: '',
      executionMode: 'local',
      memoryEnabled: false,
      memoryImplicitUpdateEnabled: false,
      memoryLlmJudgeEnabled: false,
      memoryGuardLevel: 'strict',
      memoryUserMemoriesMaxItems: 12,
    };
  }

  getConversationSourceContextBySession() {
    return {
      sourceChannel: 'cowork_ui',
      externalConversationId: 'local-cowork',
    };
  }

  getMemoryBackend() {
    return {
      getEffectiveMemoryPolicyForSession: () => ({
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'strict',
        memoryUserMemoriesMaxItems: 12,
      }),
      resolveMetabotIdForMemory: () => 1,
      listUserMemories: () => [],
      applyTurnMemoryUpdates: async () => ({ created: [], updated: [] }),
    };
  }
}

function createHarness() {
  const store = new FakeCoworkStore(path.resolve(process.cwd()));
  const runner = new CoworkRunner(store);
  const runCalls = [];
  const emittedMessages = [];
  runner.on('message', (sessionId, message) => {
    emittedMessages.push({ sessionId, message });
  });
  runner.runClaudeCode = async (activeSession, prompt, cwd, systemPrompt) => {
    runCalls.push({
      sessionId: activeSession.sessionId,
      prompt,
      cwd,
      systemPrompt,
    });
  };
  return { store, runner, runCalls, emittedMessages };
}

function parseToolJson(result) {
  return JSON.parse(result.text);
}

async function waitFor(assertion, timeoutMs = 250) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assertion();
  if (lastError) throw lastError;
}

function makeRetainedActiveSession(sessionId, cwd) {
  return {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: cwd,
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    currentStreamingMessageId: null,
    currentStreamingContent: '',
    currentStreamingDisplayContent: '',
    currentStreamingThinkingMessageId: null,
    currentStreamingThinking: '',
    currentStreamingBlockType: null,
    currentStreamingTextSuppressed: false,
    currentStreamingTextTruncated: false,
    currentStreamingThinkingTruncated: false,
    lastStreamingTextUpdateAt: 0,
    lastStreamingThinkingUpdateAt: 0,
    hasAssistantTextOutput: false,
    hasAssistantThinkingOutput: false,
    delegationRequestEmitted: false,
    staleResumeDetected: false,
    staleResumeRetryAllowed: true,
    contextOverflowDetected: false,
    contextOverflowRetryAllowed: false,
    executionMode: 'local',
    disableRemoteServicesPrompt: false,
    autoApprove: false,
    disableMemoryUpdates: false,
  };
}

test('host tools read all and latest session data by raw id or IDBots link as JSON text', async () => {
  const { store, runner } = createHarness();
  const source = store.createSession('source');
  const target = store.createSession('target');
  const first = store.addMessage(target.id, { type: 'user', content: 'first target message' });
  const latest = store.addMessage(target.id, { type: 'assistant', content: 'latest target message' });

  const readAll = await runner.handleHostToolExecution({
    toolName: 'idbots_session_read_all',
    toolInput: { sessionId: target.id },
  }, source.id);
  assert.equal(readAll.success, true);
  const readAllPayload = parseToolJson(readAll);
  assert.equal(readAllPayload.ok, true);
  assert.equal(readAllPayload.session.id, target.id);
  assert.deepEqual(readAllPayload.messages.map((message) => message.id), [first.id, latest.id]);

  const readLatest = await runner.handleHostToolExecution({
    toolName: 'idbots_session_read_latest',
    toolInput: { sessionId: `IDBots://${target.id}` },
  }, source.id);
  assert.equal(readLatest.success, true);
  const latestPayload = parseToolJson(readLatest);
  assert.equal(latestPayload.ok, true);
  assert.equal(latestPayload.session.id, target.id);
  assert.equal(latestPayload.message.id, latest.id);
  assert.equal(latestPayload.message.content, 'latest target message');
});

test('write tool inserts source-prefixed message, ignores spoofed source, emits once, queues run, and skips duplicate user persistence', async () => {
  const { store, runner, runCalls, emittedMessages } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: {
      sourceSessionId: 'spoofed-source',
      targetSessionId: `IDBots://${target.id}`,
      message: '  continue from source  ',
    },
  }, source.id);

  assert.equal(result.success, true);
  const payload = parseToolJson(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.sourceSessionId, source.id);
  assert.equal(payload.targetSessionId, target.id);
  assert.equal(payload.runQueued, true);
  assert.equal(payload.reportBack.enabled, true, 'bot work orders report back by default');
  assert.equal(payload.message.content, `来自${source.id} 的信息：<cross_session_message trust="untrusted">continue from source</cross_session_message>`);
  assert.deepEqual(payload.message.metadata, {
    sourceChannel: 'idbots_cross_session',
    sourceSessionId: source.id,
    crossSessionNotifySource: true,
  });

  assert.deepEqual(emittedMessages.map((event) => [event.sessionId, event.message.id]), [
    [target.id, payload.message.id],
  ]);

  await waitFor(() => assert.equal(runCalls.length, 1));
  assert.equal(runCalls[0].sessionId, target.id);
  assert.equal(runCalls[0].prompt, payload.message.content);
  assert.deepEqual(store.getSession(target.id).messages.map((message) => message.content), [
    payload.message.content,
  ]);
});

test('write tool rejects A2A target and does not queue or run', async () => {
  const { store, runner, runCalls, emittedMessages } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('a2a-target', {
    sessionType: 'a2a',
    peerGlobalMetaId: 'peer-global',
    peerName: 'Peer',
  });

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: {
      targetSessionId: target.id,
      message: 'hello peer',
    },
  }, source.id);

  assert.equal(result.success, false);
  const payload = parseToolJson(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'WRITE_NOT_ALLOWED_FOR_A2A');
  assert.equal(store.getSession(target.id).messages.length, 0);
  assert.equal(emittedMessages.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCalls.length, 0);
});

test('write tool reports partial success if queue acceptance throws after insert', async () => {
  const { store, runner, runCalls, emittedMessages } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  runner.enqueueCrossSessionContinuation = () => {
    throw new Error('queue unavailable');
  };

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: {
      targetSessionId: target.id,
      message: 'queued later',
    },
  }, source.id);

  assert.equal(result.success, true);
  const payload = parseToolJson(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.runQueued, false);
  assert.equal(payload.warning, 'MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED');
  assert.match(payload.error, /queue unavailable/);
  assert.equal(store.getSession(target.id).messages.length, 1);
  assert.equal(emittedMessages.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCalls.length, 0);
});

test('write tool reports unqueued when target was already stopped before insert', async () => {
  const { store, runner, runCalls, emittedMessages } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('stopped-target');

  runner.stopSession(target.id);

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: {
      targetSessionId: target.id,
      message: 'insert without restart',
    },
  }, source.id);

  assert.equal(result.success, true);
  const payload = parseToolJson(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.sourceSessionId, source.id);
  assert.equal(payload.targetSessionId, target.id);
  assert.equal(payload.runQueued, false);
  assert.equal(payload.warning, 'MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED');
  assert.equal(payload.reason, 'TARGET_SESSION_STOPPED');
  assert.match(payload.error, /TARGET_SESSION_STOPPED/);
  assert.equal(payload.message.content, `来自${source.id} 的信息：<cross_session_message trust="untrusted">insert without restart</cross_session_message>`);

  assert.deepEqual(emittedMessages.map((event) => [event.sessionId, event.message.id]), [
    [target.id, payload.message.id],
  ]);
  assert.deepEqual(store.getSession(target.id).messages.map((message) => message.content), [
    payload.message.content,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runCalls.length, 0);
});

test('running target drains queued cross-session continuations in order after the current turn while active session remains retained', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  runner.activeSessions.set(target.id, makeRetainedActiveSession(target.id, store.cwd));
  runner.markCrossSessionTurnRunning(target.id);

  for (const message of ['first queued prompt', 'second queued prompt']) {
    const result = await runner.handleHostToolExecution({
      toolName: 'idbots_session_insert_user_message',
      toolInput: {
        targetSessionId: target.id,
        message,
      },
    }, source.id);
    assert.equal(result.success, true);
    assert.equal(parseToolJson(result).runQueued, true);
  }

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCalls.length, 0);
  assert.equal(runner.activeSessions.has(target.id), true);

  runner.markCrossSessionTurnSettled(target.id);

  await waitFor(() => assert.equal(runCalls.length, 2), 500);
  assert.deepEqual(runCalls.map((call) => call.sessionId), [target.id, target.id]);
  assert.deepEqual(runCalls.map((call) => call.prompt), [
    `来自${source.id} 的信息：<cross_session_message trust="untrusted">first queued prompt</cross_session_message>`,
    `来自${source.id} 的信息：<cross_session_message trust="untrusted">second queued prompt</cross_session_message>`,
  ]);
  assert.deepEqual(store.getSession(target.id).messages.map((message) => message.content), [
    `来自${source.id} 的信息：<cross_session_message trust="untrusted">first queued prompt</cross_session_message>`,
    `来自${source.id} 的信息：<cross_session_message trust="untrusted">second queued prompt</cross_session_message>`,
  ]);
  assert.equal(runner.activeSessions.has(target.id), true);
});

test('stopped target drops queued cross-session continuation and does not restart after current turn settles', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  runner.activeSessions.set(target.id, makeRetainedActiveSession(target.id, store.cwd));
  runner.markCrossSessionTurnRunning(target.id);

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: {
      targetSessionId: target.id,
      message: 'do not auto-run after stop',
    },
  }, source.id);

  assert.equal(result.success, true);
  assert.equal(parseToolJson(result).runQueued, true);
  assert.equal(store.getSession(target.id).messages.length, 1);

  runner.stopSession(target.id);
  runner.markCrossSessionTurnSettled(target.id);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runCalls.length, 0);
  assert.equal(store.getSession(target.id).messages[0].content, `来自${source.id} 的信息：<cross_session_message trust="untrusted">do not auto-run after stop</cross_session_message>`);
});


// ---------------------------------------------------------------------------
// P1-5b: insertCrossSessionMessageAndQueue is the shared host seam for the
// MCP write tool AND internal orchestrators (TwinOrchestrationService
// ORCH-NOTIFY). Inserting a message must also queue (and drain → continue)
// the target session, i.e. activate it — verified here by observing
// runClaudeCode on the target session, the same activation the MCP tool path
// performs.
// ---------------------------------------------------------------------------
test('insertCrossSessionMessageAndQueue inserts, emits once, and drains to activate the target session (runClaudeCode)', async () => {
  const { store, runner, runCalls, emittedMessages } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');

  const combined = runner.insertCrossSessionMessageAndQueue({
    sourceSessionId: source.id,
    targetSessionId: target.id,
    message: 'wake up twin session',
  });

  assert.equal(combined.insert.ok, true);
  assert.equal(combined.runQueued, true);
  assert.equal(combined.queueDepth, 1);
  assert.equal(combined.insert.targetSessionId, target.id);
  assert.deepEqual(emittedMessages.map((event) => event.sessionId), [target.id]);
  assert.equal(emittedMessages[0].message.id, combined.insert.message.id);

  // The queued continuation drains and calls continueSession → runClaudeCode
  // on the TARGET session: this is the activation the MCP channel provides.
  await waitFor(() => assert.equal(runCalls.length, 1));
  assert.equal(runCalls[0].sessionId, target.id);
  assert.match(runCalls[0].prompt, /wake up twin session/);
  assert.deepEqual(store.getSession(target.id).messages.map((message) => message.content), [
    `来自${source.id} 的信息：<cross_session_message trust="untrusted">wake up twin session</cross_session_message>`,
  ]);
});

test('insertCrossSessionMessageAndQueue reports unqueued when target was already stopped, message still inserted', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('stopped-target');

  runner.stopSession(target.id);

  const combined = runner.insertCrossSessionMessageAndQueue({
    sourceSessionId: source.id,
    targetSessionId: target.id,
    message: 'insert without restart',
  });

  assert.equal(combined.insert.ok, true);
  assert.equal(combined.runQueued, false);
  assert.equal(combined.warning, 'MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED');
  assert.equal(combined.reason, 'TARGET_SESSION_STOPPED');
  assert.match(combined.error, /TARGET_SESSION_STOPPED/);
  assert.equal(store.getSession(target.id).messages.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCalls.length, 0, 'stopped target must not be restarted');
});

test('insertCrossSessionMessageAndQueue rejects A2A targets without inserting or queueing', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('a2a-target', {
    sessionType: 'a2a',
    peerGlobalMetaId: 'peer-global',
    peerName: 'Peer',
  });

  const combined = runner.insertCrossSessionMessageAndQueue({
    sourceSessionId: source.id,
    targetSessionId: target.id,
    message: 'hello peer',
  });

  assert.equal(combined.insert.ok, false);
  assert.equal(combined.insert.code, 'WRITE_NOT_ALLOWED_FOR_A2A');
  assert.equal(combined.runQueued, false);
  assert.equal(store.getSession(target.id).messages.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCalls.length, 0);
});

test('insertCrossSessionMessageAndQueue reports partial success if queue acceptance throws after insert', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  runner.enqueueCrossSessionContinuation = () => {
    throw new Error('queue unavailable');
  };

  const combined = runner.insertCrossSessionMessageAndQueue({
    sourceSessionId: source.id,
    targetSessionId: target.id,
    message: 'queued later',
  });

  assert.equal(combined.insert.ok, true);
  assert.equal(combined.runQueued, false);
  assert.equal(combined.warning, 'MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED');
  assert.match(combined.error, /queue unavailable/);
  assert.equal(store.getSession(target.id).messages.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Kernel-busy gate (2026-09-29 incident, twinbot session df7d89d3): a
// kernel-initiated turn (subagent-finished wake, scheduled nudge) runs with
// NO host turn controller, so neither crossSessionRunningTurns nor
// activeSessions sees it — an ORCH-NOTIFY drained mid-turn and sealed the
// still-streaming reply. The gate now also consults the kernel's own
// session.status signal via dshTurnHub.isKernelSessionBusy.
// ---------------------------------------------------------------------------

test('kernel-busy target holds queued cross-session continuations until the kernel reports idle', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  // No activeSessions entry, no markCrossSessionTurnRunning: the turn in
  // flight is kernel-initiated, visible only through the hub's kernel status.
  let kernelBusy = true;
  runner.dshTurnHub = { isKernelSessionBusy: (sessionId) => sessionId === target.id && kernelBusy };

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: {
      targetSessionId: target.id,
      message: 'orch notify during a kernel turn',
    },
  }, source.id);
  assert.equal(result.success, true);
  assert.equal(parseToolJson(result).runQueued, true);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runCalls.length, 0);
  // The same kernel-busy signal widens the shared busy guards (heartbeat
  // escalate, A2A defer, group-task daemon) that ride isSessionActive.
  assert.equal(runner.isSessionActive(target.id), true);

  // Kernel settles: the hub's onSessionStatusChange('idle') wiring schedules
  // the drain — the callback body is exactly this schedule call.
  kernelBusy = false;
  runner.scheduleCrossSessionContinuationDrain(target.id);

  await waitFor(() => assert.equal(runCalls.length, 1), 500);
  assert.equal(runCalls[0].sessionId, target.id);
  assert.equal(runCalls[0].prompt, `来自${source.id} 的信息：<cross_session_message trust="untrusted">orch notify during a kernel turn</cross_session_message>`);
});

// ---------------------------------------------------------------------------
// Human interjection during a kernel-initiated turn: the kernel turn has no
// host controller, so the submission controller interrupts at the kernel
// (interruptKernelTurnForHumanInput) and holds the cross-session gate until
// the human's own turn owns it — machine messages queued meanwhile must not
// jump ahead of the human.
// ---------------------------------------------------------------------------

test('interruptKernelTurnForHumanInput aborts the kernel turn and holds the drain gate until released', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  let kernelBusy = true;
  const cancelCalls = [];
  runner.dshTurnHub = {
    isKernelSessionBusy: (sessionId) => sessionId === target.id && kernelBusy,
    cancelKernelTurn: async (sessionId, cause) => {
      cancelCalls.push([sessionId, cause]);
      kernelBusy = false;
      return true;
    },
  };

  const interrupted = await runner.interruptKernelTurnForHumanInput(target.id);
  assert.equal(interrupted, true);
  assert.deepEqual(cancelCalls, [[target.id, 'steer']]);

  // A machine-originated message queued now must NOT drain even though the
  // kernel is already idle — the gate is held for the human's follow-up turn.
  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: target.id, message: 'queued behind the human turn' },
  }, source.id);
  assert.equal(result.success, true);
  assert.equal(parseToolJson(result).runQueued, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runCalls.length, 0);

  // Failure path: the follow-up Continue never started its turn, so the
  // submission controller releases the gate explicitly and the queued
  // machine message drains.
  runner.releaseKernelTurnInterrupt(target.id);
  await waitFor(() => assert.equal(runCalls.length, 1), 500);
  assert.equal(runCalls[0].sessionId, target.id);
  assert.equal(runCalls[0].prompt, `来自${source.id} 的信息：<cross_session_message trust="untrusted">queued behind the human turn</cross_session_message>`);
});

test('interruptKernelTurnForHumanInput releases the gate immediately when the kernel turn ended in the race', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  let kernelBusy = true;
  runner.dshTurnHub = {
    isKernelSessionBusy: (sessionId) => sessionId === target.id && kernelBusy,
    // The turn ended between the busy check and the cancel: nothing was
    // interrupted, nothing to hold the gate for.
    cancelKernelTurn: async () => {
      kernelBusy = false;
      return false;
    },
  };

  const interrupted = await runner.interruptKernelTurnForHumanInput(target.id);
  assert.equal(interrupted, false);

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: target.id, message: 'drains right away' },
  }, source.id);
  assert.equal(result.success, true);
  await waitFor(() => assert.equal(runCalls.length, 1), 500);
  assert.equal(runCalls[0].sessionId, target.id);
});

test('interruptKernelTurnForHumanInput swallows a failed abort and releases the gate', async () => {
  const { store, runner, runCalls } = createHarness();
  const source = store.createSession('source-session');
  const target = store.createSession('target-session');
  let kernelBusy = true;
  runner.dshTurnHub = {
    isKernelSessionBusy: (sessionId) => sessionId === target.id && kernelBusy,
    cancelKernelTurn: async () => {
      kernelBusy = false;
      throw new Error('runtime gone');
    },
  };

  const interrupted = await runner.interruptKernelTurnForHumanInput(target.id);
  assert.equal(interrupted, false);
  assert.equal(runner.isCrossSessionTurnRunning(target.id), false);

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: target.id, message: 'still drains after the failed abort' },
  }, source.id);
  assert.equal(result.success, true);
  await waitFor(() => assert.equal(runCalls.length, 1), 500);
});

test('interruptKernelTurnForHumanInput is a no-op while a hosted turn is active', async () => {
  const { store, runner } = createHarness();
  const target = store.createSession('target-session');
  runner.activeSessions.set(target.id, makeRetainedActiveSession(target.id, store.cwd));
  let cancelCalled = false;
  runner.dshTurnHub = {
    isKernelSessionBusy: () => true,
    cancelKernelTurn: async () => {
      cancelCalled = true;
      return true;
    },
  };

  assert.equal(await runner.interruptKernelTurnForHumanInput(target.id), false);
  assert.equal(cancelCalled, false);
});
