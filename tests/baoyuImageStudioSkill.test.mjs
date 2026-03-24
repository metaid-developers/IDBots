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

test('listSkills exposes baoyu-image-studio as an enabled built-in skill', () => {
  const { manager } = createManager();
  const skill = manager.listSkills().find((entry) => entry.id === 'baoyu-image-studio');

  assert.ok(skill);
  assert.equal(skill.enabled, true);
  assert.equal(skill.isBuiltIn, true);
});

test('baoyu-image-studio prompt advertises the four supported image modes', () => {
  const { manager } = createManager();
  const skill = manager.listSkills().find((entry) => entry.id === 'baoyu-image-studio');

  assert.ok(skill);
  assert.match(skill.prompt, /generate/i);
  assert.match(skill.prompt, /cover/i);
  assert.match(skill.prompt, /infographic/i);
  assert.match(skill.prompt, /comic/i);
});
