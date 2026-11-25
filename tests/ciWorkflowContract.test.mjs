import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const repoRoot = path.resolve(import.meta.dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows/build.yml'), 'utf8'));
const buildSteps = workflow.jobs.build.steps;
const indexOf = (name) => buildSteps.findIndex((step) => step.name === name);
const testSteps = buildSteps.filter((step) => typeof step.id === 'string' && step.id.startsWith('test_'));
const VERDICT = 'Fail the job if any test step failed (aggregated verdict)';
const outcomeEnvName = (id) => `TEST_${id.slice('test_'.length).toUpperCase()}_OUTCOME`;

test('the gate decides before any build job starts, and the build jobs honour it', () => {
  const gate = workflow.jobs.gate;
  assert.equal(buildSteps.length > 0, true);
  assert.match(String(gate.outputs.skip), /steps\.gate\.outputs\.skip/);
  assert.deepEqual(workflow.jobs.build.needs, 'gate');
  assert.match(workflow.jobs.build.if, /needs\.gate\.outputs\.skip != 'true'/);
  assert.deepEqual(workflow.jobs.release.needs, ['build']);
  const decideAt = gate.steps.findIndex((step) => step.id === 'gate');
  const guardAt = gate.steps.findIndex((step) => step.name === 'Test the gate and the tools that need no dependencies');
  assert.equal(guardAt >= 0 && decideAt > guardAt, true, 'the gate is tested before it decides');
  // The gate job has no node_modules: everything it runs must stay dependency-free.
  const gateTests = gate.steps[guardAt].run.match(/tests\/[\w.]+\.test\.mjs/g) ?? [];
  assert.equal(gateTests.includes('tests/ciGate.test.mjs'), true);
  const toolingTests = readJson('package.json').scripts['test:ci-tooling'].match(/tests\/[\w.]+\.test\.mjs/g) ?? [];
  for (const relative of gateTests) {
    assert.equal(toolingTests.includes(relative), true, `${relative} runs in the gate but not in test:ci-tooling`);
    assert.equal(fs.existsSync(path.join(repoRoot, relative)), true);
  }
  // ...and the full set runs inside the build jobs, where node_modules exists.
  assert.equal(
    buildSteps.some((step) => step.id === 'test_ci_tooling' && step.run === 'pnpm run test:ci-tooling'),
    true,
  );
});

test('every test step runs to completion instead of failing fast', () => {
  // One red suite must not hide the next (v1.1.3 peeled failures one round at a time).
  assert.equal(testSteps.length >= 15, true, `only ${testSteps.length} test steps carry an id`);
  for (const step of testSteps) {
    assert.equal(step['continue-on-error'], true, `${step.id} must not stop the job`);
  }
  assert.equal(new Set(testSteps.map((step) => step.id)).size, testSteps.length, 'step ids are unique');
});

test('the verdict step sees the outcome of every test step, and nothing else', () => {
  const verdict = buildSteps[indexOf(VERDICT)];
  const envNames = Object.keys(verdict.env).sort();
  assert.deepEqual(envNames, testSteps.map((step) => outcomeEnvName(step.id)).sort());
  for (const step of testSteps) {
    assert.equal(verdict.env[outcomeEnvName(step.id)], `\${{ steps.${step.id}.outcome }}`);
  }
  assert.match(verdict.run, /ci-test-verdict\.mjs/);
});

test('nothing is packaged before the verdict, and every suite runs before it', () => {
  const verdictAt = indexOf(VERDICT);
  assert.equal(verdictAt > indexOf('Install dependencies'), true);
  for (const step of testSteps) assert.equal(indexOf(step.name) < verdictAt, true, `${step.name} runs after the verdict`);
  for (const name of [
    'Install web-search skill dependencies',
    'Build Electron app package (macOS)',
    'Build Electron app package (Windows signed)',
    'Upload build artifacts',
  ]) {
    assert.equal(indexOf(name) > verdictAt, true, `${name} must follow the verdict`);
  }
});

test('checkouts are shallow: one commit for builds, two for the gate diff', () => {
  assert.equal(buildSteps[indexOf('Check out Git repository')].with['fetch-depth'], 1);
  const gateCheckout = workflow.jobs.gate.steps.find((step) => step.uses?.startsWith('actions/checkout'));
  assert.equal(gateCheckout.with['fetch-depth'], 2);
});

test('the pnpm-store cache is for hosted runners only', () => {
  // 24 min of archive-and-upload per successful job on the persistent signing runner.
  const cacheSteps = buildSteps.filter((step) => step.uses?.startsWith('actions/cache'));
  assert.equal(cacheSteps.length, 1);
  assert.match(cacheSteps[0].if, /runner\.os != 'Windows'/);
  assert.doesNotMatch(cacheSteps[0].with.path, /pnpm-store-win/);
  assert.equal(buildSteps.some((step) => step.id === 'pnpm-store-win'), false);
});

test('the Windows checkout is byte-exact: configured before checkout, repaired right after Node exists', () => {
  const configureAt = indexOf('Enable Git long paths (Windows)');
  const checkoutAt = indexOf('Check out Git repository');
  const normalizeAt = indexOf('Normalize working tree line endings (Windows)');
  assert.match(buildSteps[configureAt].run, /core\.autocrlf false/);
  assert.equal(configureAt < checkoutAt, true, 'autocrlf must be off before the checkout writes files');
  assert.equal(normalizeAt > indexOf('Install Node.js'), true, 'the repair step runs under node');
  assert.equal(normalizeAt < buildSteps.findIndex((step) => step.id?.startsWith('test_')), true);
  assert.equal(buildSteps[normalizeAt].if, `runner.os == 'Windows'`);
  assert.match(buildSteps[normalizeAt].run, /ci-worktree-eol\.mjs/);
});

test('package.json and electron-builder.json carry the matching wiring', () => {
  const scripts = readJson('package.json').scripts;
  assert.match(scripts['compile:electron'], /^node scripts\/compile-electron\.cjs && node scripts\/copy-electron-js\.cjs$/);
  assert.equal(scripts['release:watch'], 'node scripts/release-watch.mjs');
  assert.match(scripts.test, /pnpm run test:ci-tooling/);
  const toolingTests = scripts['test:ci-tooling'].match(/tests\/[\w.]+\.test\.mjs/g) ?? [];
  assert.equal(toolingTests.length >= 7, true);
  for (const relative of toolingTests) {
    assert.equal(fs.existsSync(path.join(repoRoot, relative)), true, `${relative} is listed but missing`);
  }
  // The incremental state lives in the output directory, so it must not ship.
  assert.equal(readJson('electron-builder.json').files.includes('!dist-electron/.tsbuildinfo*'), true);
});
