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
  assert.match(String(gate.outputs.skip_tests), /steps\.gate\.outputs\.skip_tests/);
  assert.deepEqual(workflow.jobs.build.needs, ['gate', 'source']);
  assert.match(workflow.jobs.build.if, /needs\.gate\.outputs\.skip != 'true'/);
  assert.deepEqual(workflow.jobs.release.needs, ['build']);
  const decideAt = gate.steps.findIndex((step) => step.id === 'gate');
  const guardAt = gate.steps.findIndex((step) => step.name === 'Test the gate and the tools that need no dependencies');
  assert.equal(guardAt >= 0 && decideAt > guardAt, true, 'the gate is tested before it decides');
  // The tests decision reads the parent commit's main run through the API.
  assert.equal(gate.permissions.actions, 'read');
  assert.match(String(gate.steps[decideAt].env.GH_TOKEN), /github\.token/);
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

test("a tag run leaves out its tests only on the gate's say-so, and packaging never does", () => {
  for (const step of testSteps) {
    assert.match(String(step.if), /needs\.gate\.outputs\.skip_tests != 'true'/, `${step.id} must yield to skip_tests`);
  }
  // A platform condition is kept, not replaced.
  assert.equal(
    testSteps.find((step) => step.id === 'test_nsis_harness').if,
    `runner.os == 'Windows' && needs.gate.outputs.skip_tests != 'true'`,
  );
  // Skipped steps pass the verdict, so the verdict itself must always run.
  assert.equal(buildSteps[indexOf(VERDICT)].if, undefined);
  // Building, signing and verifying are the point of a tag run.
  for (const name of [
    'Build renderer (Vite)',
    'Compile Electron main process',
    'Build Electron app package (Windows signed)',
    'Verify Windows signatures',
    'Verify DSH kernel patches in the packaged app',
    'Upload build artifacts',
  ]) {
    assert.doesNotMatch(String(buildSteps[indexOf(name)].if ?? ''), /skip_tests/, `${name} must not depend on skip_tests`);
  }
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

test('the Windows job never fetches its source from github.com', () => {
  // The direct checkout is for hosted runners only.
  assert.equal(buildSteps[indexOf('Check out Git repository')].if, `runner.os != 'Windows'`);
  const restoreAt = indexOf('Restore the source tree from the bundle (Windows)');
  assert.equal(buildSteps[restoreAt].if, `runner.os == 'Windows'`);
  assert.match(buildSteps[restoreAt].run, /ci-source-restore\.cjs/);
  assert.match(buildSteps[restoreAt].run, /--commit "\$env:GITHUB_SHA"/, 'the restored commit is checked against the run');
  // Node exists before the restore runs, and the restore precedes everything that needs the tree.
  assert.equal(indexOf('Install Node.js') < indexOf('Download the source bundle (Windows)'), true);
  assert.equal(restoreAt < indexOf('Enable pnpm'), true);
  // Byte-exact from here on, whatever the machine's global git config says.
  assert.match(buildSteps[indexOf('Enable Git long paths (Windows)')].run, /core\.autocrlf false/);
  // A restore is a fresh clone, so the stale-tree repair has nothing left to do.
  assert.equal(buildSteps.some((step) => /ci-worktree-eol/.test(String(step.run))), false);

  // A hosted runner bundles the commit and ships the restore tool next to it.
  const source = workflow.jobs.source;
  assert.equal(source.needs, 'gate');
  assert.equal(source.if, `needs.gate.outputs.skip != 'true'`);
  assert.equal(source['runs-on'], 'ubuntu-latest');
  assert.deepEqual(source.steps.map((step) => step.name), [
    'Check out Git repository',
    'Bundle the commit together with the restore tool',
    'Upload the source bundle',
  ]);
  assert.equal(source.steps[0].with['persist-credentials'], false, 'the bundle must not carry a token');
  const bundling = source.steps[1].run;
  assert.match(bundling, /git bundle create [^\n]*HEAD/);
  assert.match(bundling, /cp scripts\/ci-source-restore\.cjs/);
  assert.match(bundling, /rev-parse HEAD\)" = "\$GITHUB_SHA"/, 'the bundle is cut from the commit the run is for');
  assert.equal(source.steps[2].with.name, 'source-bundle');
  assert.equal(buildSteps[indexOf('Download the source bundle (Windows)')].with.name, 'source-bundle');
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/ci-source-restore.cjs')), true);
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

test('the signed PortableGit cache is reused before packaging and filled after it, best effort', () => {
  const reuseAt = indexOf('Reuse the signed PortableGit cache (Windows)');
  const storeAt = indexOf('Store the signed PortableGit cache (Windows)');
  assert.equal(reuseAt > indexOf('Setup MinGit (Windows)'), true, 'reuse follows the extraction it substitutes for');
  assert.equal(reuseAt < indexOf('Build Electron app package (Windows signed)'), true);
  assert.equal(storeAt > indexOf('Build Electron app package (Windows signed)'), true);
  assert.equal(storeAt < indexOf('Verify Windows signatures'), true);
  for (const at of [reuseAt, storeAt]) assert.equal(buildSteps[at].if, `runner.os == 'Windows'`);
  assert.match(buildSteps[reuseAt].run, /mingit-signed-cache\.cjs apply/);
  assert.match(buildSteps[storeAt].run, /mingit-signed-cache\.cjs store/);
  // Filling the cache is an optimization for the NEXT build: it must never fail this one.
  assert.equal(buildSteps[storeAt]['continue-on-error'], true);
  // Both directions key on the archive the Setup step actually extracted.
  assert.match(buildSteps[indexOf('Setup MinGit (Windows)')].run, /IDBOTS_PORTABLE_GIT_ARCHIVE=\$archivePath/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/mingit-verify-signatures.ps1')), true);
});
