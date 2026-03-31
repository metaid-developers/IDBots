import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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

  assert.ok(skill);
  assert.match(skill.prompt, /BTC\s*\/\s*SPACE/i);
  assert.match(skill.prompt, /DOGE\s*\/\s*SPACE/i);
  assert.match(skill.prompt, /做市|market/i);
  assert.match(skill.prompt, /exact-in|按市价|询价|退款/i);
});

test('metabot-mm-basic script enforces payload and surfaces runtime config errors', () => {
  const scriptPath = path.resolve(process.cwd(), 'SKILLs', 'metabot-mm-basic', 'scripts', 'index.js');

  const missingPayload = spawnSync('node', [scriptPath], { encoding: 'utf8' });
  assert.notEqual(missingPayload.status, 0);
  assert.match(missingPayload.stderr, /--payload is required/i);

  const payload = JSON.stringify({ mode: 'quote', query: { kind: 'supported_pairs' } });
  const withPayload = spawnSync('node', [scriptPath, '--payload', payload], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IDBOTS_USER_DATA_PATH: '/tmp/idbots-mm-basic-skill-test-missing-config',
      IDBOTS_METABOT_ID: '1',
    },
  });
  assert.notEqual(withPayload.status, 0);
  assert.match(withPayload.stderr, /IDBOTS_USER_DATA_PATH|config|ENOENT/i);
});

test('metabot-mm-basic skill prompt documents trigger conditions, structured payloads, stdout JSON, and reply behavior', () => {
  const skillPath = path.resolve(process.cwd(), 'SKILLs', 'metabot-mm-basic', 'SKILL.md');
  const content = require('fs').readFileSync(skillPath, 'utf8');

  assert.match(content, /何时触发/i);
  assert.match(content, /参数抽取规则|参数抽取/i);
  assert.match(content, /缺参时必须追问|必须追问/i);
  assert.match(content, /精确命令格式|命令格式/i);
  assert.match(content, /stdout JSON 格式|stdout JSON/i);
  assert.match(content, /AI 收到结果后应该怎么回复用户|怎么回复用户/i);
  assert.match(content, /BTC\/SPACE/i);
  assert.match(content, /DOGE\/SPACE/i);
  assert.match(content, /quote_context/i);
  assert.match(content, /refunded|executed|void/i);
});
