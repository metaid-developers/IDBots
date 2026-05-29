import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SkillManager } = require('../dist-electron/skillManager.js');

const BUILTIN_SKILLS_ROOT = path.resolve(process.cwd(), 'SKILLs');

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

function createManager(skillRoot = BUILTIN_SKILLS_ROOT, initialStoreValues = {}) {
  const store = new MemoryStore(initialStoreValues);
  const manager = new SkillManager(() => store);

  manager.getSkillsRoot = () => skillRoot;
  manager.ensureSkillsRoot = () => skillRoot;
  manager.getBundledSkillsRoot = () => skillRoot;
  manager.getSkillRoots = () => [skillRoot];

  return { store, manager };
}

function extractSkillIds(prompt) {
  return Array.from(prompt.matchAll(/<id>([^<]+)<\/id>/g), (match) => match[1]);
}

test('buildAutoRoutingPromptForOrderSkill narrows seller execution to the ordered local skill id', () => {
  const { manager } = createManager();

  const prompt = manager.buildAutoRoutingPromptForOrderSkill({
    skillName: 'weather',
  });

  assert.ok(prompt);
  assert.deepEqual(extractSkillIds(prompt), ['weather']);
  assert.doesNotMatch(prompt, /<id>imap-smtp-email<\/id>/);
});

test('buildAutoRoutingPromptForOrderSkill can resolve an ordered skill by exact display name', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-order-prompt-'));
  const skillDir = path.join(tempRoot, 'seller-friendly-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: Friendly Seller Skill
description: Custom skill used to verify seller order prompt narrowing.
---

Execute the custom seller order workflow.
`,
    'utf8'
  );

  const { manager } = createManager(tempRoot);
  const prompt = manager.buildAutoRoutingPromptForOrderSkill({
    skillName: 'Friendly Seller Skill',
  });

  assert.ok(prompt);
  assert.deepEqual(extractSkillIds(prompt), ['seller-friendly-skill']);
});

test('buildAutoRoutingPromptForOrderSkill falls back to the full seller skill list when the order skill cannot be resolved', () => {
  const { manager } = createManager();

  const fullPrompt = manager.buildAutoRoutingPrompt();
  const prompt = manager.buildAutoRoutingPromptForOrderSkill({
    skillId: 'service-pin-123',
    skillName: 'missing-seller-skill',
  });

  assert.ok(fullPrompt);
  assert.equal(prompt, fullPrompt);
});

test('buildAutoRoutingPromptForOrderSkillScope resolves multiple ids and names without order semantics', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-order-scope-'));
  const alphaDir = path.join(tempRoot, 'alpha-skill');
  const betaDir = path.join(tempRoot, 'beta-skill');
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.mkdirSync(betaDir, { recursive: true });
  fs.writeFileSync(
    path.join(alphaDir, 'SKILL.md'),
    `---\nname: Alpha Skill\ndescription: Alpha scope skill.\n---\n\nRun alpha.\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(betaDir, 'SKILL.md'),
    `---\nname: Friendly Beta\ndescription: Beta scope skill.\n---\n\nRun beta.\n`,
    'utf8'
  );
  const { manager } = createManager(tempRoot);

  const result = manager.buildAutoRoutingPromptForOrderSkillScope({
    skillIds: ['alpha-skill', 'missing-by-id'],
    skillNames: ['Friendly Beta', 'missing-by-name', 'alpha-skill'],
    strictScope: true,
  });

  assert.ok(result.prompt);
  assert.deepEqual(result.activeSkillIds, ['alpha-skill', 'beta-skill']);
  assert.deepEqual(result.missingSkillNames, ['missing-by-id', 'missing-by-name']);
  assert.deepEqual(extractSkillIds(result.prompt), ['alpha-skill', 'beta-skill']);
  assert.doesNotMatch(result.prompt, /missing-by-id/);
});

test('buildAutoRoutingPromptForOrderSkillScope refuses unrestricted fallback for unresolved strict allow-lists', () => {
  const { manager } = createManager();

  const result = manager.buildAutoRoutingPromptForOrderSkillScope({
    skillNames: ['missing-seller-skill'],
    strictScope: true,
  });

  assert.equal(result.prompt, null);
  assert.deepEqual(result.activeSkillIds, []);
  assert.deepEqual(result.missingSkillNames, ['missing-seller-skill']);
});

test('buildAutoRoutingPromptForOrderSkillScope keeps legacy full routing fallback when no allow-list is supplied', () => {
  const { manager } = createManager();

  const fullPrompt = manager.buildAutoRoutingPrompt();
  const result = manager.buildAutoRoutingPromptForOrderSkillScope({
    strictScope: false,
  });

  assert.ok(fullPrompt);
  assert.equal(result.prompt, fullPrompt);
  assert.deepEqual(result.activeSkillIds, extractSkillIds(fullPrompt));
  assert.deepEqual(result.missingSkillNames, []);
});

test('buildRemoteServicesPrompt prefers currentPinId for delegated service identity', () => {
  const { manager } = createManager();

  const prompt = manager.buildRemoteServicesPrompt([
    {
      pinId: 'historical-pin',
      currentPinId: 'current-pin',
      sourceServicePinId: 'source-pin',
      displayName: 'Current Service',
      serviceName: 'Current Service',
      description: 'A current service snapshot',
      price: '0.01',
      currency: 'SPACE',
      providerMetaBot: 'Provider',
      providerGlobalMetaId: 'idq1provider',
      ratingAvg: 5,
      ratingCount: 1,
    },
  ]);

  assert.ok(prompt);
  assert.match(prompt, /<service_pin_id>current-pin<\/service_pin_id>/);
  assert.doesNotMatch(prompt, /<service_pin_id>historical-pin<\/service_pin_id>/);
});
