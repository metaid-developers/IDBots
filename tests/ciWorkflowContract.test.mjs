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
  // The `source` job ships the restore tool right after the gate: it is tested here, before it travels.
  assert.equal(gateTests.includes('tests/ciSourceRestore.test.mjs'), true);
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

test('checkouts are shallow: one commit for builds, two wherever a parent comes into play', () => {
  assert.equal(buildSteps[indexOf('Check out Git repository')].with['fetch-depth'], 1);
  const gateCheckout = workflow.jobs.gate.steps.find((step) => step.uses?.startsWith('actions/checkout'));
  assert.equal(gateCheckout.with['fetch-depth'], 2);
  assert.equal(workflow.jobs.source.steps[0].with['fetch-depth'], 2, 'the delta is cut against the first parent');
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
  const checkouts = buildSteps.filter((step) => step.uses?.startsWith('actions/checkout'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].if, `runner.os != 'Windows'`);

  const DELTA = 'Update the source tree from the delta (Windows)';
  const DELTA_AGAIN = 'Update the source tree from the delta again (Windows)';
  const REBUILD = 'Rebuild the source tree from the full bundle (Windows)';
  const REBUILD_AGAIN = 'Rebuild the source tree from the full bundle again (Windows)';
  const step = (name) => buildSteps[indexOf(name)];
  const delta = step(DELTA);
  const deltaAgain = step(DELTA_AGAIN);
  const rebuild = step(REBUILD);
  const rebuildAgain = step(REBUILD_AGAIN);
  const DAMAGED = "runner.os == 'Windows' && steps.restore_delta.outputs.fitted == 'damaged'";
  const NOT_FIT = "runner.os == 'Windows' && steps.restore_delta.outputs.fitted != 'true' && steps.restore_delta_retry.outputs.fitted != 'true'";

  assert.equal(delta.if, `runner.os == 'Windows'`);
  assert.equal(delta.id, 'restore_delta');
  assert.equal(delta['continue-on-error'], true, 'a delta that does not work out must not stop the job');
  assert.match(delta.run, /ci-source-restore\.cjs/);
  assert.match(delta.run, /--commit "\$env:GITHUB_SHA"/, 'the restored commit is checked against the run');
  assert.doesNotMatch(delta.run, /--fresh/, 'the delta updates the repository the previous run left behind');
  // Exit 3 is the delta saying it does not fit — expected, and no red step.
  assert.match(delta.run, /if \(\$code -eq 3\) \{[\s\S]*AppendAllText\(\$env:GITHUB_OUTPUT, "fitted=false`n"\)[\s\S]*exit 0/);
  assert.match(delta.run, /AppendAllText\(\$env:GITHUB_OUTPUT, "fitted=true`n"\)/);
  // Anything else — exit 4, a pack that arrived cut short, included — is "damaged":
  // said so, the files removed so that the next download starts clean, and no red step.
  assert.match(delta.run, /if \(\$code -ne 0\) \{[\s\S]*AppendAllText\(\$env:GITHUB_OUTPUT, "fitted=damaged`n"\)[\s\S]*Remove-Item[^\n]*source-delta[\s\S]*exit 0/);

  // One second chance: the delta is downloaded and applied once more, by the very same script.
  assert.equal(step('Download the source delta again (Windows)').if, DAMAGED);
  assert.equal(step('Download the source delta again (Windows)').with.name, 'source-delta');
  assert.equal(deltaAgain.id, 'restore_delta_retry');
  assert.equal(deltaAgain.if, DAMAGED);
  assert.equal(deltaAgain['continue-on-error'], true);
  assert.equal(deltaAgain.run, delta.run, 'the retry runs the very same script');

  assert.match(rebuild.run, /--fresh --commit "\$env:GITHUB_SHA"/);
  // Both kinds of step give a branch push its branch and leave a tag checkout detached.
  for (const s of [delta, rebuild]) {
    assert.match(s.run, /--branch "\$env:GITHUB_REF_NAME"/);
  }
  // The full bundle only when the delta did not work out, second chance included
  // (a step that never ran leaves its output unset, which is not 'true' either).
  for (const name of ['Download the full source bundle (Windows)', REBUILD]) {
    assert.equal(step(name).if, NOT_FIT);
  }
  // The rebuild gets one second chance too: its first attempt may fail, its second may not.
  assert.equal(rebuild.id, 'rebuild_full');
  assert.equal(rebuild['continue-on-error'], true);
  for (const name of ['Download the full source bundle again (Windows)', REBUILD_AGAIN]) {
    assert.equal(step(name).if, `runner.os == 'Windows' && steps.rebuild_full.outcome == 'failure'`);
  }
  assert.equal(rebuildAgain['continue-on-error'], undefined, 'the second attempt is the last word');
  assert.equal(rebuildAgain.run, rebuild.run, 'the retry runs the very same script');
  assert.match(rebuild.run, /if \(\$LASTEXITCODE -ne 0\) \{[\s\S]*Remove-Item[^\n]*source-full[\s\S]*exit \$LASTEXITCODE/);
  // Node exists before anything is restored, each download precedes the step that
  // reads it, and the tree is there before anything needs it.
  const order = [
    'Install Node.js',
    'Download the source delta (Windows)', DELTA,
    'Download the source delta again (Windows)', DELTA_AGAIN,
    'Download the full source bundle (Windows)', REBUILD,
    'Download the full source bundle again (Windows)', REBUILD_AGAIN,
    'Enable pnpm',
  ];
  const positions = order.map(indexOf);
  assert.equal(positions.every((position) => position >= 0), true, 'every step exists');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'the steps run in this order');
  // Byte-exact from here on, whatever the machine's global git config says.
  assert.match(buildSteps[indexOf('Enable Git long paths (Windows)')].run, /core\.autocrlf false/);
  // No stale-tree repair is left to do: a rebuild is a fresh clone, and an update checks out anew.
  assert.equal(buildSteps.some((step) => /ci-worktree-eol/.test(String(step.run))), false);

  // A hosted runner cuts both and ships the restore tool next to each.
  const source = workflow.jobs.source;
  assert.equal(source.needs, 'gate');
  assert.equal(source.if, `needs.gate.outputs.skip != 'true'`);
  assert.equal(source['runs-on'], 'ubuntu-latest');
  assert.deepEqual(source.steps.map((step) => step.name), [
    'Check out Git repository',
    'Bundle the commit together with the restore tool',
    'Upload the source delta',
    'Upload the full source bundle',
  ]);
  // The token is what lets the delta's base be fetched by commit; the pack and the bundle carry git objects only.
  assert.notEqual(source.steps[0].with['persist-credentials'], false);
  assert.equal(source.steps[0].with['fetch-depth'], 2, 'the delta needs the first parent as its fallback base');
  const bundling = source.steps[1];
  // The delta is whatever the commit reaches beyond its first parent, as a pack with no prerequisites.
  // Cut by the tool, against the tip main had before the push (empty for a tag), not by a pipe whose failure could ship an empty pack.
  assert.match(bundling.run, /node scripts\/ci-source-cut\.mjs --out "\$RUNNER_TEMP\/source-delta\/source\.pack" --base "\$\{\{ github\.event\.before \}\}"/);
  assert.doesNotMatch(bundling.run, /pack-objects --stdout >"/);
  assert.match(bundling.run, /git bundle create "\$RUNNER_TEMP\/source-full\/source\.bundle" HEAD/);
  for (const artifact of ['source-delta', 'source-full']) {
    assert.match(bundling.run, new RegExp(`cp scripts/ci-source-restore\\.cjs "\\$RUNNER_TEMP/${artifact}/"`), `${artifact} carries the restore tool`);
  }
  assert.match(bundling.run, /rev-parse HEAD\)" = "\$GITHUB_SHA"/, 'both are cut from the commit the run is for');
  assert.deepEqual(source.steps.slice(2).map((step) => step.with.name), ['source-delta', 'source-full']);
  assert.equal(buildSteps[indexOf('Download the source delta (Windows)')].with.name, 'source-delta');
  assert.equal(buildSteps[indexOf('Download the full source bundle (Windows)')].with.name, 'source-full');
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/ci-source-restore.cjs')), true);
});

test('the signing service is asked to sign before the Windows job spends any time on it', () => {
  const smoke = buildSteps[indexOf('Smoke-test the signing service (Windows)')];
  assert.equal(smoke.if, `runner.os == 'Windows'`);
  assert.equal(smoke.shell, 'powershell');
  assert.equal(smoke.env.WIN_CERT_SHA1, '${{ secrets.WIN_CERT_SHA1 }}');
  assert.match(smoke.run, /'sign', '\/sha1', \$env:WIN_CERT_SHA1/, 'it really signs, with the certificate the build signs with');
  assert.match(smoke.run, /Join-Path \$env:RUNNER_TEMP/, 'it signs a throwaway copy in the temp directory, nothing of the machine');
  assert.doesNotMatch(smoke.run, /\/tr\b|WIN_TIMESTAMP_URL/, 'without a timestamp: only the private key is asked for');
  assert.match(smoke.run, /WaitForExit\(90000\)/, 'a hung signer is cut off after 90 seconds, as the build cuts it off');
  assert.match(smoke.run, /The signing service is not usable/, 'the failure says what it is and what to do');
  // Ahead of everything that costs time.
  for (const later of ['Install Node.js', 'Download the source delta (Windows)', 'Build renderer (Vite)', 'Build Electron app package (Windows signed)']) {
    assert.equal(indexOf(smoke.name) < indexOf(later), true, `before ${later}`);
  }
  // Nothing runs ahead of it but the git settings, which it does not even depend on.
  const before = buildSteps.slice(0, indexOf(smoke.name)).filter((step) => step.if !== `runner.os != 'Windows'`).map((step) => step.name);
  assert.deepEqual(before, ['Enable Git long paths (Windows)']);
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
  // The digest list must land where the signing hook of the NEXT step reads it. GITHUB_ENV
  // reaches later steps only, so the process that writes the list needs the variable in
  // its own environment as well. Without that line the first cache hit saved nothing:
  // the list went to the account's temp directory, the hook found nothing under RUNNER_TEMP
  // and signed all 343 PortableGit executables again (run 46037790077, 2026-11-28).
  const reuse = buildSteps[reuseAt].run;
  const forLaterSteps = reuse.indexOf('[System.IO.File]::AppendAllText($env:GITHUB_ENV, "IDBOTS_PRESIGNED_MANIFEST=$presigned`n")');
  const forThisStep = reuse.indexOf('$env:IDBOTS_PRESIGNED_MANIFEST = $presigned');
  const apply = reuse.indexOf('node scripts/mingit-signed-cache.cjs apply');
  assert.equal(forLaterSteps >= 0 && forThisStep > forLaterSteps && apply > forThisStep, true, 'set for later steps, set for this one, then apply');
  assert.match(buildSteps[storeAt].run, /mingit-signed-cache\.cjs store/);
  // Filling the cache is an optimization for the NEXT build: it must never fail this one.
  assert.equal(buildSteps[storeAt]['continue-on-error'], true);
  // Both directions key on the archive the Setup step actually extracted.
  assert.match(buildSteps[indexOf('Setup MinGit (Windows)')].run, /IDBOTS_PORTABLE_GIT_ARCHIVE=\$archivePath/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/mingit-verify-signatures.ps1')), true);
});
