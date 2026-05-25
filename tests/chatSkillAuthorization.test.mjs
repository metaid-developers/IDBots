import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SkillManager } = require('../dist-electron/skillManager.js');

class MemoryStore {
  constructor(initial = {}) {
    this.values = { ...initial };
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
  }
}

function writeSkill(root, id, name = id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description.\n---\n\nRun ${name}.\n`,
    'utf8'
  );
}

function createManager(initialStoreValues = {}) {
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-chat-skills-'));
  writeSkill(skillRoot, 'allowed-chat-skill', 'Allowed Chat Skill');
  writeSkill(skillRoot, 'display-name-skill', 'Friendly Display Skill');
  writeSkill(skillRoot, 'disabled-chat-skill', 'Disabled Chat Skill');
  writeSkill(skillRoot, 'unlisted-chat-skill', 'Unlisted Chat Skill');

  const store = new MemoryStore({
    skills_state: {
      'disabled-chat-skill': { enabled: false },
    },
    ...initialStoreValues,
  });
  const manager = new SkillManager(() => store);

  manager.getSkillsRoot = () => skillRoot;
  manager.ensureSkillsRoot = () => skillRoot;
  manager.getBundledSkillsRoot = () => skillRoot;
  manager.getSkillRoots = () => [skillRoot];

  return { manager };
}

function extractSkillIds(prompt) {
  return Array.from(prompt.matchAll(/<id>([^<]+)<\/id>/g), (match) => match[1]);
}

test('buildChatSkillsRoutingPrompt resolves allowed chat skill ids and names while filtering disabled skills', () => {
  const { manager } = createManager();

  const result = manager.buildChatSkillsRoutingPrompt({
    allowChatSkills: [
      'allowed-chat-skill',
      'Friendly Display Skill',
      'disabled-chat-skill',
      'missing-chat-skill',
      'allowed-chat-skill',
    ],
  });

  assert.deepEqual(result.activeSkillIds, ['allowed-chat-skill', 'display-name-skill']);
  assert.deepEqual(extractSkillIds(result.prompt), ['allowed-chat-skill', 'display-name-skill']);
  assert.doesNotMatch(result.prompt, /disabled-chat-skill/);
  assert.doesNotMatch(result.prompt, /unlisted-chat-skill/);
});

test('buildChatSkillsRoutingPrompt parses JSON and comma separated chat allowlists', () => {
  const { manager } = createManager();

  const jsonResult = manager.buildChatSkillsRoutingPrompt({
    allowChatSkills: '["allowed_chat_skill", "Friendly Display Skill"]',
  });
  assert.deepEqual(jsonResult.activeSkillIds, ['allowed-chat-skill', 'display-name-skill']);

  const commaResult = manager.buildChatSkillsRoutingPrompt({
    allowChatSkills: 'allowed_chat_skill, Friendly Display Skill',
  });
  assert.deepEqual(commaResult.activeSkillIds, ['allowed-chat-skill', 'display-name-skill']);
});

test('buildChatSkillsRoutingPrompt can authorize all currently enabled skills for Boss chat turns', () => {
  const { manager } = createManager();

  const result = manager.buildChatSkillsRoutingPrompt({
    allowAllEnabled: true,
  });

  assert.deepEqual(result.activeSkillIds, [
    'allowed-chat-skill',
    'display-name-skill',
    'unlisted-chat-skill',
  ]);
  assert.deepEqual(extractSkillIds(result.prompt), result.activeSkillIds);
  assert.doesNotMatch(result.prompt, /disabled-chat-skill/);
});

test('resolveChatSkillIds returns all enabled skills for owner chat turns', () => {
  const { manager } = createManager();

  const result = manager.resolveChatSkillIds({
    isOwner: true,
  });

  assert.deepEqual(result, [
    'allowed-chat-skill',
    'display-name-skill',
    'unlisted-chat-skill',
  ]);
});

test('buildAutoRoutingPromptForSkillIds excludes disabled skills from chat routing prompts', () => {
  const { manager } = createManager();

  const prompt = manager.buildAutoRoutingPromptForSkillIds([
    'allowed-chat-skill',
    'disabled-chat-skill',
  ]);

  assert.ok(prompt);
  assert.deepEqual(extractSkillIds(prompt), ['allowed-chat-skill']);
  assert.doesNotMatch(prompt, /disabled-chat-skill/);
});
