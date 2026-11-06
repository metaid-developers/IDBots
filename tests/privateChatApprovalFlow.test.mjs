import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'private-chat-approval-flow-test-user-data'),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
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
const SESSION_ID = 'sess-a2a-approval-flow';
const MEMORY_POLICY = {
  memoryEnabled: true,
  memoryImplicitUpdateEnabled: true,
  memoryLlmJudgeEnabled: true,
  memoryGuardLevel: 'strict',
  memoryUserMemoriesMaxItems: 20,
  memoryPromptMaxChars: 12000,
};

function makeHarness(options = {}) {
  const session = {
    id: SESSION_ID,
    title: 'Peer Bot',
    sessionType: options.sessionType ?? 'a2a',
    hiddenFromSessionList: options.hiddenFromSessionList === true,
    messages: [],
  };
  const memoryBackend = {
    getEffectiveMemoryPolicyForSession: () => MEMORY_POLICY,
    resolveMetabotIdForMemory: () => 7,
  };
  const store = {
    getSession: () => session,
    getSessionWithoutMessages: () => session,
    getConversationSourceContextBySession: () => ({
      sourceChannel: options.sourceChannel ?? 'metaweb_private',
      externalConversationId: 'metaweb-private:idq1peer',
    }),
    getMemoryBackend: () => memoryBackend,
    getSessionUsageStats: () => null,
    updateSession: () => {},
    addMessage: (_sessionId, message) => ({ id: `msg-${session.messages.length + 1}`, timestamp: Date.now(), ...message }),
  };
  const runner = new CoworkRunner(store, {
    localTurnStallTimeoutMs: 0,
    getMetabotById: () => ({ id: 7, name: 'Local Bot' }),
  });
  if (options.memoryReadOnly === true) {
    runner.activeSessions.set(SESSION_ID, { memoryReadOnly: true });
  }
  return { runner, session };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail('timed out waiting for the owner approval request');
}

test('real DSH catalog mounts owner approval only for ordinary visible private chats', () => {
  const ordinary = makeHarness();
  const ordinaryTools = ordinary.runner.buildDshHostTools(SESSION_ID).map((tool) => tool.name);
  assert.ok(ordinaryTools.includes('request_user_permission'));

  for (const options of [
    { sourceChannel: 'metaweb_order' },
    { memoryReadOnly: true },
    { hiddenFromSessionList: true },
    { sessionType: 'standard' },
  ]) {
    const harness = makeHarness(options);
    const names = harness.runner.buildDshHostTools(SESSION_ID).map((tool) => tool.name);
    assert.ok(!names.includes('request_user_permission'), `unexpected tool for ${JSON.stringify(options)}`);
  }
});

test('real tool call surfaces a suspended card and returns the owner allow and deny verdicts', async () => {
  const { runner } = makeHarness();
  const tool = runner.buildDshHostTools(SESSION_ID).find((entry) => entry.name === 'request_user_permission');
  assert.ok(tool);
  const requests = [];
  runner.on('permissionRequest', (sessionId, request) => {
    if (sessionId === SESSION_ID) requests.push(request);
  });

  const allowCall = tool.execute({
    title: 'Transfer 10 SPACE',
    description: 'Send exactly 10 SPACE to Peer Bot. Public and irreversible.',
    category: 'payment',
  });
  await waitFor(() => requests.length === 1);
  const allowRequest = requests[0];
  assert.equal(allowRequest.toolName, 'AskUserQuestion');
  assert.equal(allowRequest.toolInput.context.a2aApproval, true);
  assert.equal(allowRequest.toolInput.context.category, 'payment');
  assert.match(allowRequest.toolInput.questions[0].question, /Local Bot/);
  assert.equal(runner.isPermissionSuspended(allowRequest.requestId), true);
  const allowQuestion = allowRequest.toolInput.questions[0];
  runner.respondToPermission(allowRequest.requestId, {
    behavior: 'allow',
    updatedInput: {
      ...allowRequest.toolInput,
      answers: { [allowQuestion.question]: allowQuestion.options[0].label },
    },
  });
  const allowed = await allowCall;
  assert.match(allowed.content[0].text, /OWNER_APPROVED/);
  assert.equal(allowed.isError, undefined);

  const denyCall = tool.execute({
    title: 'Publish a large file',
    description: 'Publish the 200 MB archive on-chain and pay the fee.',
    category: 'file_upload',
    file_size_bytes: 200 * 1024 * 1024,
  });
  await waitFor(() => requests.length === 2);
  runner.respondToPermission(requests[1].requestId, { behavior: 'deny', message: 'Permission denied' });
  const denied = await denyCall;
  assert.match(denied.content[0].text, /OWNER_DENIED/);
  assert.equal(denied.isError, undefined);

  const smallUpload = await tool.execute({
    title: 'Publish a small file',
    description: 'Publish an ordinary 1 MiB file on-chain.',
    category: 'file_upload',
    file_size_bytes: 1024 * 1024,
  });
  assert.match(smallUpload.content[0].text, /OWNER_APPROVAL_NOT_REQUIRED/);
  assert.equal(requests.length, 2, 'small uploads do not create an owner card');
});
