import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('resolveContinueSystemPrompt preserves the persisted prompt when no new skill is selected', () => {
  const { resolveContinueSystemPrompt } = require('../dist-electron/libs/coworkPromptStrategy.js');

  const result = resolveContinueSystemPrompt({
    persistedSystemPrompt: 'persisted prompt',
    requestedSystemPrompt: 'persisted prompt\n\nfresh auto-routing block',
    activeSkillIds: [],
  });

  assert.equal(result, undefined);
});

test('resolveContinueSystemPrompt forwards the requested prompt when a new skill is explicitly selected', () => {
  const { resolveContinueSystemPrompt } = require('../dist-electron/libs/coworkPromptStrategy.js');

  const result = resolveContinueSystemPrompt({
    persistedSystemPrompt: 'persisted prompt',
    requestedSystemPrompt: 'persisted prompt\n\nmanual skill block',
    activeSkillIds: ['metabot-chat-groupchat'],
  });

  assert.equal(result, 'persisted prompt\n\nmanual skill block');
});
