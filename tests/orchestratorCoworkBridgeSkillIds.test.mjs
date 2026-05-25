import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runOrchestratorSkillTurn,
  runSkillTurnInExistingSession,
} = require('../dist-electron/services/orchestratorCoworkBridge.js');

test('runOrchestratorSkillTurn persists active skill ids and disables remote services prompt', async () => {
  const runner = new EventEmitter();
  const calls = [];
  const session = {
    id: 'session-1',
    messages: [],
  };
  const store = {
    createSession(title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) {
      calls.push({ type: 'createSession', title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId });
      return session;
    },
    addMessage(sessionId, message) {
      const record = {
        id: `message-${session.messages.length + 1}`,
        timestamp: Date.now(),
        ...message,
      };
      session.messages.push(record);
      return record;
    },
    getSession(sessionId) {
      assert.equal(sessionId, session.id);
      return session;
    },
    updateSession(sessionId, patch) {
      calls.push({ type: 'updateSession', sessionId, patch });
    },
  };

  runner.startSession = async (sessionId, userMessage, options) => {
    calls.push({ type: 'startSession', sessionId, userMessage, options });
    session.messages.push({
      id: 'assistant-1',
      type: 'assistant',
      content: 'skill reply',
      timestamp: Date.now(),
    });
    queueMicrotask(() => runner.emit('complete', sessionId));
  };

  const result = await runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system\n<available_skills></available_skills>',
    userMessage: 'use a skill',
    cwd: '/tmp/idbots-skills',
    metabotId: 42,
    activeSkillIds: ['allowed-chat-skill'],
  });

  assert.equal(result, 'skill reply');
  assert.deepEqual(calls.find((call) => call.type === 'createSession').activeSkillIds, ['allowed-chat-skill']);
  const userMessage = session.messages.find((message) => message.type === 'user');
  assert.equal(userMessage.metadata.sourceChannel, 'orchestrator');
  assert.deepEqual(userMessage.metadata.skillIds, ['allowed-chat-skill']);
  const startCall = calls.find((call) => call.type === 'startSession');
  assert.deepEqual(startCall.options.skillIds, ['allowed-chat-skill']);
  assert.equal(startCall.options.disableRemoteServicesPrompt, true);
  assert.equal(calls.filter((call) => call.type === 'upsertConversationMapping').length, 0);
});

test('runOrchestratorSkillTurn tags private chat turns with metaweb_private and skips conversation mapping', async () => {
  const runner = new EventEmitter();
  const calls = [];
  const session = {
    id: 'session-2',
    messages: [],
  };
  const store = {
    createSession(title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) {
      calls.push({ type: 'createSession', title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId });
      return session;
    },
    addMessage(sessionId, message) {
      const record = {
        id: `message-${session.messages.length + 1}`,
        timestamp: Date.now(),
        ...message,
      };
      session.messages.push(record);
      return record;
    },
    getSession(sessionId) {
      assert.equal(sessionId, session.id);
      return session;
    },
    updateSession(sessionId, patch) {
      calls.push({ type: 'updateSession', sessionId, patch });
    },
    upsertConversationMapping() {
      calls.push({ type: 'upsertConversationMapping' });
    },
  };

  runner.startSession = async (sessionId, userMessage, options) => {
    calls.push({ type: 'startSession', sessionId, userMessage, options });
    session.messages.push({
      id: 'assistant-1',
      type: 'assistant',
      content: 'private reply',
      timestamp: Date.now(),
    });
    queueMicrotask(() => runner.emit('complete', sessionId));
  };

  const result = await runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'private skill request',
    cwd: '/tmp/idbots-skills',
    metabotId: 42,
    activeSkillIds: ['allowed-chat-skill'],
    sourceChannel: 'metaweb_private',
  });

  assert.equal(result, 'private reply');
  const userMessage = session.messages.find((message) => message.type === 'user');
  assert.equal(userMessage.metadata.sourceChannel, 'metaweb_private');
  assert.equal(userMessage.metadata.externalConversationId.startsWith('orchestrator:'), true);
  assert.deepEqual(userMessage.metadata.skillIds, ['allowed-chat-skill']);
  assert.equal(calls.filter((call) => call.type === 'upsertConversationMapping').length, 0);
  const startCall = calls.find((call) => call.type === 'startSession');
  assert.equal(startCall.options.disableRemoteServicesPrompt, true);
});

test('runSkillTurnInExistingSession reuses the private A2A session without creating a new session', async () => {
  const runner = new EventEmitter();
  const calls = [];
  const session = {
    id: 'private-a2a-session',
    cwd: '/tmp/private-chat-workspace',
    messages: [
      {
        id: 'user-1',
        type: 'user',
        content: '请查天气',
        metadata: {
          sourceChannel: 'metaweb_private',
          externalConversationId: 'peer-global',
          direction: 'incoming',
        },
      },
    ],
  };
  const store = {
    createSession() {
      calls.push({ type: 'createSession' });
      throw new Error('private chat skill turns must not create a new session');
    },
    addMessage(sessionId, message) {
      const record = {
        id: `message-${session.messages.length + 1}`,
        timestamp: Date.now(),
        ...message,
      };
      session.messages.push(record);
      return record;
    },
    getSession(sessionId) {
      assert.equal(sessionId, session.id);
      return session;
    },
    updateSession(sessionId, patch) {
      calls.push({ type: 'updateSession', sessionId, patch });
    },
  };

  runner.startSession = async (sessionId, userMessage, options) => {
    calls.push({ type: 'startSession', sessionId, userMessage, options });
    session.messages.push({
      id: 'assistant-skill-1',
      type: 'assistant',
      content: '天气结果',
      timestamp: Date.now(),
    });
    queueMicrotask(() => runner.emit('complete', sessionId));
  };

  const result = await runSkillTurnInExistingSession(runner, store, {
    sessionId: session.id,
    systemPrompt: 'system\n<available_skills></available_skills>',
    userMessage: '请查天气',
    cwd: '/tmp/private-chat-workspace',
    activeSkillIds: ['weather'],
  });

  assert.equal(result.replyText, '天气结果');
  assert.equal(result.assistantMessageId, 'assistant-skill-1');
  assert.equal(calls.filter((call) => call.type === 'createSession').length, 0);
  const startCall = calls.find((call) => call.type === 'startSession');
  assert.equal(startCall.sessionId, session.id);
  assert.deepEqual(startCall.options.skillIds, ['weather']);
  assert.equal(startCall.options.disableRemoteServicesPrompt, true);
  assert.equal(session.messages.filter((message) => message.type === 'user').length, 1);
});
