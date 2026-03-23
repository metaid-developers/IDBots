import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { SkillManager } = require('../dist-electron/skillManager.js');
process.env.IDBOTS_SKILLS_ROOT = path.resolve(process.cwd(), 'SKILLs');

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

function createManager(initialStoreValues = {}) {
  const store = new MemoryStore(initialStoreValues);
  const manager = new SkillManager(() => store);
  manager.getBundledSkillsRoot = () => process.env.IDBOTS_SKILLS_ROOT;
  return { store, manager };
}

test('buildCoworkAutoRoutingPrompt injects superpowers bootstrap for Cowork', () => {
  const { manager } = createManager();
  const prompt = manager.buildCoworkAutoRoutingPrompt();

  assert.ok(prompt);
  assert.match(prompt, /## Superpowers Workflow \(Cowork\)/);
  assert.match(prompt, /superpowers-brainstorming/);
  assert.match(prompt, /superpowers-systematic-debugging/);
  assert.match(prompt, /Do not call a `Skill` tool/);
  assert.match(prompt, /<available_skills>/);
});

test('buildAutoRoutingPrompt remains generic outside Cowork bootstrap path', () => {
  const { manager } = createManager();
  const prompt = manager.buildAutoRoutingPrompt();

  assert.ok(prompt);
  assert.doesNotMatch(prompt, /## Superpowers Workflow \(Cowork\)/);
  assert.match(prompt, /<available_skills>/);
});

test('buildCoworkAutoRoutingPrompt skips superpowers bootstrap when all superpowers skills are disabled', () => {
  const { manager } = createManager();
  const superpowersSkillIds = manager
    .listSkills()
    .map((skill) => skill.id)
    .filter((skillId) => skillId.startsWith('superpowers-'));

  const disabledState = Object.fromEntries(
    superpowersSkillIds.map((skillId) => [skillId, { enabled: false }])
  );
  const prompt = createManager({ skills_state: disabledState }).manager.buildCoworkAutoRoutingPrompt();

  assert.ok(prompt);
  assert.doesNotMatch(prompt, /## Superpowers Workflow \(Cowork\)/);
  assert.match(prompt, /<available_skills>/);
});
