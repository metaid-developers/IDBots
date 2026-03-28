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

test('listSkills exposes metabot-mm-basic as an enabled built-in skill', () => {
  const { manager } = createManager();
  const skill = manager.listSkills().find((entry) => entry.id === 'metabot-mm-basic');

  assert.ok(skill);
  assert.equal(skill.enabled, true);
  assert.equal(skill.isBuiltIn, true);
  assert.equal(skill.isOfficial, true);
});

test('metabot-mm-basic prompt advertises market making, exact-in, and BTC/SPACE + DOGE/SPACE coverage', () => {
  const { manager } = createManager();
  const skill = manager.listSkills().find((entry) => entry.id === 'metabot-mm-basic');

  assert.match(skill.prompt, /BTC\s*\/\s*SPACE/i);
  assert.match(skill.prompt, /DOGE\s*\/\s*SPACE/i);
  assert.match(skill.prompt, /做市|market/i);
  assert.match(skill.prompt, /exact-in|按市价|询价|退款/i);
});
