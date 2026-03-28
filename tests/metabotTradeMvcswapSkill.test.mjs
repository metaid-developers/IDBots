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

test('listSkills exposes metabot-trade-mvcswap as an enabled built-in skill', () => {
  const { manager } = createManager();
  const skill = manager.listSkills().find((entry) => entry.id === 'metabot-trade-mvcswap');

  assert.ok(skill);
  assert.equal(skill.enabled, true);
  assert.equal(skill.isBuiltIn, true);
  assert.equal(skill.isOfficial, true);
});

test('metabot-trade-mvcswap prompt advertises quote, preview, and execute swap behavior', () => {
  const { manager } = createManager();
  const skill = manager.listSkills().find((entry) => entry.id === 'metabot-trade-mvcswap');

  assert.ok(skill);
  assert.match(skill.prompt, /SPACE/i);
  assert.match(skill.prompt, /swap|报价|预览|交易/i);
  assert.match(skill.prompt, /滑点|slippage/i);
  assert.match(skill.prompt, /确认交易|确定执行|无需询问/i);
});
