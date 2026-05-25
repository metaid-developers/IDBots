import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildPrivateChatA2ASystemPrompt,
} = require('../dist-electron/services/privateChatDaemon.js');

function baseAnalysis(overrides = {}) {
  return {
    contextMessages: [
      {
        speaker: 'Peer Bot',
        content: '请查一下天气',
        direction: 'incoming',
        timestamp: 1_770_000_000_000,
      },
    ],
    incomingTurnCount: 1,
    shouldForceBye: false,
    ...overrides,
  };
}

function baseMetabot() {
  return {
    name: 'Local Bot',
    role: 'Technical partner',
    soul: 'direct',
    goal: 'useful discussion',
    background: 'MetaID',
  };
}

test('private chat prompt injects allowed local chat skills without the no-tools rule', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis(),
    skillsPrompt: '<available_skills><skill><id>weather-skill</id></skill></available_skills>',
  });

  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /weather-skill/);
  assert.match(prompt, /only the local skills listed/i);
  assert.doesNotMatch(prompt, /Do not claim local tool access or execute local skills/i);
});

test('private chat prompt without skills keeps the no-tools rule', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis(),
  });

  assert.doesNotMatch(prompt, /<available_skills>/);
  assert.match(prompt, /Do not claim local tool access or execute local skills/i);
});

test('private chat force-bye prompt does not inject chat skills', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis({
      incomingTurnCount: 30,
      shouldForceBye: true,
    }),
    skillsPrompt: '<available_skills><skill><id>weather-skill</id></skill></available_skills>',
  });

  assert.match(prompt, /Reply exactly "bye" now/);
  assert.doesNotMatch(prompt, /<available_skills>/);
  assert.doesNotMatch(prompt, /weather-skill/);
});
