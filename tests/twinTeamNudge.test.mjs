/**
 * First-Worker nudge + explainer projections (owner ruling 2026-11-14).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTwinFirstWorkerNudge, hasNoLocalWorkers } = require('../dist-electron/main/libs/twinTeamNudge.js');
const { buildProjectorModePrompt } = require('../dist-electron/main/libs/assistantModePrompt.js');

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

test('the nudge rides only while the Twin is the only bot', () => {
  const twinOnly = { workers: [{ id: 1, type: 'twin' }] };
  assert.equal(hasNoLocalWorkers(twinOnly), true);
  assert.equal(hasNoLocalWorkers({ workers: [] }), true);
  const nudge = buildTwinFirstWorkerNudge(twinOnly);
  assert.match(nudge, /^<team_status>/);
  assert.match(nudge, /ONLY bot on this machine/);
  assert.match(nudge, /team-builder/);
  assert.match(nudge, /never every turn/);
  assert.match(nudge, /declines/);
  const withWorker = { workers: [{ id: 1, type: 'twin' }, { id: 2, type: 'worker' }] };
  assert.equal(buildTwinFirstWorkerNudge(withWorker), '', 'gone once a Worker exists (disabled ones count too)');
});

test('runner: Twin owner chats only, per-turn volatile tail', () => {
  const runner = read('src/main/libs/coworkRunner.ts');
  const method = runner.slice(runner.indexOf('private async buildTwinTeamNudgePrompt('));
  const body = method.slice(0, method.indexOf('\n  }\n'));
  assert.ok(body.includes("if (!this.isTwinSession(sessionId) || !this.listLocalWorkers) return '';"));
  assert.ok(body.includes('session.autoOrigin'), 'never automation runs');
  assert.ok(body.includes("sourceChannel !== 'cowork_ui'"), 'never A2A / IM / group conversations');
  assert.match(runner, /key: 'team-nudge',\n\s+text: await this\.buildTwinTeamNudgePrompt\(sessionId\),/);
});

test('the first-run greeting prompt carries the first-Worker guidance', () => {
  const i18n = read('src/renderer/services/i18n.ts');
  assert.ok(i18n.includes('只要这台设备上还只有你一个 Bot，就要持续引导他创建第一个 Worker Bot'));
  assert.ok(i18n.includes('As long as you are the only bot on this machine, keep guiding them to create their first Worker Bot'));
});

test('projector: complex explanations go to an explainer page on the right', () => {
  const prompt = buildProjectorModePrompt();
  assert.ok(/Exactly four cases deserve a page/.test(prompt) || /只有四种情况值得投影/.test(prompt));
  const source = read('src/main/libs/assistantModePrompt.ts');
  assert.ok(source.includes('(4) you need to EXPLAIN something complex to the owner'));
  assert.ok(source.includes('④ 需要向主人讲清一件复杂的事'));
  assert.ok(source.includes('"Explainer"') && source.includes('「讲解」'));
});
