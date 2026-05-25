import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runOrchestratorSkillTurn } = require('../dist-electron/services/orchestratorCoworkBridge.js');

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
