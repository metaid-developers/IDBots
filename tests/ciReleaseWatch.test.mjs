import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { evaluate, classifyFailure, parseArgs, readFailureVerdict, DEFAULT_BUDGETS } from '../scripts/release-watch.mjs';
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/release-watch.mjs');

const NOW = new Date('2026-11-25T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function job(name, { status = 'in_progress', conclusion = null, startedAt = minutesAgo(20), step, labels = [] } = {}) {
  const current = step ? { name: step, status: 'in_progress', conclusion: null, started_at: minutesAgo(2) } : null;
  return {
    name,
    status,
    conclusion,
    created_at: minutesAgo(20),
    started_at: status === 'queued' ? null : startedAt,
    completed_at: status === 'completed' ? minutesAgo(1) : null,
    labels,
    steps: current ? [current] : [],
  };
}

const running = { status: 'in_progress', conclusion: null, startedAt: minutesAgo(20) };
const windows = 'build (windows-signer, --win --x64)';

test('a healthy run keeps the watcher waiting', () => {
  const result = evaluate({
    run: running,
    jobs: [job('build (macos-latest)', { step: 'Run agent-game tests' }), job(windows, { step: 'Install dependencies' })],
    now: NOW,
  });
  assert.equal(result.verdict, 'wait');
  assert.equal(result.exitCode, null);
});

test('a failed job is reported at once, while the other jobs are still running', () => {
  const result = evaluate({
    run: running,
    jobs: [
      job('build (macos-latest)', { step: 'Notarize app (macOS)' }),
      {
        ...job(windows),
        steps: [{ name: 'Check out Git repository', status: 'completed', conclusion: 'failure', started_at: minutesAgo(18) }],
      },
    ],
    now: NOW,
  });
  assert.equal(result.verdict, 'job-failed');
  assert.equal(result.exitCode, 2);
  const text = result.lines.join('\n');
  assert.match(text, /Check out Git repository" \[infra\]/);
  assert.match(text, /gh run rerun --failed/);
  assert.match(text, /do not wait for its other jobs|act on this now/);
});

test('a test failure is never presented as rerunnable', () => {
  const result = evaluate({
    run: running,
    jobs: [{
      ...job(windows),
      steps: [{ name: 'Fail the job if any test step failed (aggregated verdict)', status: 'completed', conclusion: 'failure', started_at: minutesAgo(18) }],
    }],
    now: NOW,
  });
  assert.equal(result.verdict, 'job-failed');
  assert.match(result.lines.join('\n'), /\[test\][\s\S]*Treat it as real/);
});

test('a job queued past the alert names the runner state and the fix', () => {
  const queued = job(windows, { status: 'queued', labels: ['self-hosted', 'windows-signer'] });
  const base = { run: running, jobs: [queued], now: NOW, queuedAlertSeconds: 300 };

  const offline = evaluate({ ...base, runners: [{ name: 'win-sign', status: 'offline', busy: false, labels: ['self-hosted', 'windows-signer'] }] });
  assert.equal(offline.verdict, 'queued-too-long');
  assert.equal(offline.exitCode, 3);
  assert.match(offline.lines.join('\n'), /queued for 20 min[\s\S]*win-sign is offline/);

  const wedged = evaluate({ ...base, runners: [{ name: 'win-sign', status: 'online', busy: false, labels: ['self-hosted', 'windows-signer'] }] });
  assert.match(wedged.lines.join('\n'), /online and idle[\s\S]*schtasks \/run/);

  const busy = evaluate({ ...base, runners: [{ name: 'win-sign', status: 'online', busy: true, labels: ['self-hosted', 'windows-signer'] }] });
  assert.match(busy.lines.join('\n'), /busy with another job/);

  const unregistered = evaluate({ ...base, runners: [] });
  assert.match(unregistered.lines.join('\n'), /no runner is registered/);
});

test('a job still inside the queued grace period does not alert', () => {
  const result = evaluate({
    run: running,
    jobs: [job(windows, { status: 'queued' })],
    // The job was created 20 min before NOW; 16 min before that it had been
    // queued for only 4 min.
    now: new Date(NOW.getTime() - 16 * 60_000),
    queuedAlertSeconds: 300,
    runners: [{ name: 'win-sign', status: 'offline', busy: false, labels: [] }],
  });
  assert.equal(result.verdict, 'wait');
});

test('a step running past its budget alerts instead of waiting for the job', () => {
  const stuck = {
    ...job(windows),
    steps: [{ name: 'Check out Git repository', status: 'in_progress', conclusion: null, started_at: minutesAgo(11) }],
  };
  const result = evaluate({ run: running, jobs: [stuck], now: NOW });
  assert.equal(result.verdict, 'step-over-budget');
  assert.equal(result.exitCode, 4);
  assert.match(result.lines.join('\n'), /Check out Git repository" has been running for 11 min \(budget 10 min\)/);
});

test('the source downloads on the signing machine have budgets of their own', () => {
  const downloading = (name, minutes) => ({ ...job(windows), steps: [{ name, status: 'in_progress', conclusion: null, started_at: minutesAgo(minutes) }] });
  // The full bundle took 15 min; twice that means the download is hung.
  assert.equal(evaluate({ run: running, jobs: [downloading('Download the full source bundle (Windows)', 14)], now: NOW }).verdict, 'wait');
  assert.equal(evaluate({ run: running, jobs: [downloading('Download the full source bundle (Windows)', 31)], now: NOW }).exitCode, 4);
  // The delta is tens of KB: minutes, not tens of them.
  assert.equal(evaluate({ run: running, jobs: [downloading('Download the source delta (Windows)', 6)], now: NOW }).exitCode, 4);
});

test('a run that cannot be read is waited out for a while, then given up', () => {
  // 2026-11-27: one rough minute at GitHub ended the watch of a healthy run.
  assert.equal(readFailureVerdict({ unreadableSeconds: 40, limitSeconds: 900 }), 'wait');
  assert.equal(readFailureVerdict({ unreadableSeconds: 899, limitSeconds: 900 }), 'wait');
  assert.equal(readFailureVerdict({ unreadableSeconds: 900, limitSeconds: 900 }), 'give-up');
  assert.equal(readFailureVerdict({ unreadableSeconds: 5000, limitSeconds: 900 }), 'give-up');
  // One snapshot was asked for: there is nothing to wait for.
  assert.equal(readFailureVerdict({ unreadableSeconds: 1, limitSeconds: 900, once: true }), 'give-up');
  // The default gives it a quarter of an hour, and the option can change that.
  assert.equal(parseArgs(['123']).readFailureLimitSeconds, 900);
  assert.equal(parseArgs(['123', '--read-failure-limit-seconds', '60']).readFailureLimitSeconds, 60);
});

test('a signing service that fails its smoke test is an infrastructure failure with the way back', () => {
  const { kind, advice } = classifyFailure('Smoke-test the signing service (Windows)');
  assert.equal(kind, 'infra');
  assert.match(advice, /Re-login SimplySign on the signing machine/);
  assert.match(advice, /rerun --failed/);
});

test('the smoke test before packaging is the same failure, with the same way back', () => {
  const { kind, advice } = classifyFailure('Smoke-test the signing service before packaging (Windows)');
  assert.equal(kind, 'infra');
  assert.match(advice, /SimplySign session running out — it lasts 2 h 27 min from the login/);
  assert.match(advice, /rerun --failed/);
});

test('a signing service the hook found silent is named from the job log once the run is over', () => {
  const packaging = { name: 'Build Electron app package (Windows signed)', status: 'completed', conclusion: 'failure', started_at: minutesAgo(21) };
  const failedWindows = { ...job(windows, { status: 'completed', conclusion: 'failure' }), id: 4242, steps: [packaging] };
  const done = { status: 'completed', conclusion: 'failure', startedAt: minutesAgo(61) };
  // What scripts/windows-sign.cjs prints in that case.
  const silent = '⨯ windows-sign: the signing service is not answering.\nsigntool timed out after 90000ms on a signature asked without a timestamp';

  const named = evaluate({ run: done, jobs: [failedWindows], now: NOW, jobLogs: { 4242: silent } });
  assert.equal(named.verdict, 'completed-failed');
  const text = named.lines.join('\n');
  assert.match(text, /the job log says the signing service is not answering/);
  assert.match(text, /Re-login SimplySign on the signing machine/);
  assert.match(text, /rerun --failed/);

  // Without that line the step keeps its generic advice: read the log before rerunning.
  const unnamed = evaluate({ run: done, jobs: [failedWindows], now: NOW, jobLogs: { 4242: '⨯ windows-sign: all timestamp attempts failed' } });
  const plain = unnamed.lines.join('\n');
  assert.equal(plain.includes('the job log says the signing service'), false);
  assert.match(plain, /Read the step log before rerunning/);
});

test('a source delta that does not fit, or breaks, is a fallback and not a failure', () => {
  const done = (name, conclusion, minutes) => ({ name, status: 'completed', conclusion, started_at: minutesAgo(minutes) });
  // GitHub lists a job's steps from the start, the ones still ahead as "queued".
  const handingOver = (deltaConclusion) => ({
    ...job(windows, { step: 'Download the full source bundle (Windows)' }),
    steps: [
      done('Update the source tree from the delta (Windows)', deltaConclusion, 12),
      { name: 'Download the full source bundle (Windows)', status: 'in_progress', conclusion: null, started_at: minutesAgo(2) },
      { name: 'Rebuild the source tree from the full bundle (Windows)', status: 'queued', conclusion: null },
    ],
  });
  // The usual case: the machine holds another commit. The step ends clean, and the full bundle takes over.
  assert.equal(evaluate({ run: running, jobs: [handingOver('success')], now: NOW }).verdict, 'wait');
  // A broken delta shows red, and hands over all the same: nothing to act on while the rebuild is pending.
  assert.equal(evaluate({ run: running, jobs: [handingOver('failure')], now: NOW }).verdict, 'wait');

  // It is the rebuild's failure that counts, and it is reported as what it is.
  const broken = {
    ...job(windows),
    steps: [
      done('Update the source tree from the delta (Windows)', 'failure', 40),
      done('Download the full source bundle (Windows)', 'success', 30),
      done('Rebuild the source tree from the full bundle (Windows)', 'failure', 20),
    ],
  };
  const failed = evaluate({ run: running, jobs: [broken], now: NOW });
  assert.deepEqual([failed.verdict, failed.exitCode], ['job-failed', 2]);
  const text = failed.lines.join('\n');
  assert.doesNotMatch(text, /step "Update the source tree from the delta/);
  assert.match(text, /step "Rebuild the source tree from the full bundle \(Windows\)" \[infra\]/);
});

test('a finished run says why the source delta gave way to the full bundle, read from the job log', () => {
  const done = (name, conclusion) => ({ name, status: 'completed', conclusion, started_at: minutesAgo(40) });
  const DELTA = 'Update the source tree from the delta (Windows)';
  const REBUILD = 'Rebuild the source tree from the full bundle (Windows)';
  const REBUILD_AGAIN = 'Rebuild the source tree from the full bundle again (Windows)';
  const rebuilt = [done(REBUILD, 'success')];
  const finished = (steps, jobLogs = {}) => evaluate({
    run: { status: 'completed', conclusion: 'success' },
    jobs: [{ id: 7, ...job(windows, { status: 'completed', conclusion: 'success' }), steps }],
    now: NOW,
    jobLogs,
  });
  const text = (result) => result.lines.join('\n');
  // GitHub records the step as "success" either way, because it is allowed to fail.
  const gaveWay = [done(DELTA, 'success'), ...rebuilt];
  // Every job log echoes the step's script first, sentences included (with "$code" where a run has a number).
  const echoedScript = '2026-11-26T20:09:58.1000000Z   Write-Host "The source delta does not fit this workspace: the tree is rebuilt from the full bundle."\r\n2026-11-26T20:09:58.1000001Z   Write-Host "The source delta could not be used (exit $code): it is downloaded once more."\r\n';
  const at = (time, line) => `2026-11-27T15:${time}.0000000Z ${line}\r\n`;

  // The usual case: the machine holds another commit, and the tool says so.
  const declined = finished(gaveWay, { 7: echoedScript + at('43:36', 'The source delta does not fit this workspace: the tree is rebuilt from the full bundle.') });
  assert.equal(declined.verdict, 'completed-ok');
  assert.match(text(declined), /the source delta did not fit; the tree was rebuilt from the full bundle instead \(1–15 min more;/);

  // A download that ended early (run 46015445714): named, and the second download counted.
  const cutShort = finished([done(DELTA, 'success'), done('Update the source tree from the delta again (Windows)', 'success'), ...rebuilt], {
    7: echoedScript
      + at('43:37', '\x1b[31m✗ ci-source-restore: git index-pack --stdin exited 128: fatal: early EOF\x1b[0m')
      + at('43:37', 'The source delta could not be used (exit 4): it is downloaded once more.')
      + at('43:53', 'The source delta does not fit this workspace: the tree is rebuilt from the full bundle.'),
  });
  assert.match(text(cutShort), /the source delta was unusable once, and after a second download did not fit; the tree was rebuilt/);
  assert.doesNotMatch(text(cutShort), /\x1b/);

  // The full bundle, too, arrived cut short and had to be fetched twice.
  const both = finished([done(DELTA, 'success'), done(REBUILD, 'failure'), done(REBUILD_AGAIN, 'success')], {
    7: echoedScript
      + at('49:31', '✗ ci-source-restore: git clone --quiet source.bundle C:\\actions-runner\\_work\\IDBots\\IDBots exited 128: fatal: early EOF')
      + echoedScript,
  });
  assert.match(text(both), /had to be downloaded twice/);

  // The tool failing in a way that printed nothing else: its own line, with git's words.
  const crashed = finished(gaveWay, { 7: echoedScript + at('59:58', '\x1b[31m✗ ci-source-restore: git config core.symlinks false exited 5: warning: core.symlinks has multiple values\x1b[0m') });
  assert.match(text(crashed), /the source delta failed outright: git config core.symlinks false exited 5: warning: core.symlinks has multiple values; the tree was rebuilt/);
  assert.doesNotMatch(text(crashed), /\x1b|did not fit/);

  // Nothing but the echoed script: that is no outcome at all.
  assert.match(text(finished(gaveWay, { 7: echoedScript })), /the source delta gave way, for a reason the log does not state/);
  // No log to read: it says that, rather than guessing a clean decline.
  assert.match(text(finished(gaveWay)), /the source delta gave way, for a reason the log does not state/);

  const byDelta = finished([
    done(DELTA, 'success'),
    done('Download the full source bundle (Windows)', 'skipped'),
    done(REBUILD, 'skipped'),
  ]);
  assert.equal(byDelta.verdict, 'completed-ok');
  assert.doesNotMatch(text(byDelta), /gave way|did not fit|failed outright|was unusable/);
});

test('a first try that failed is no job failure while its second try is still ahead', () => {
  const done = (name, conclusion, minutes) => ({ name, status: 'completed', conclusion, started_at: minutesAgo(minutes) });
  const tries = (last) => ({
    ...job(windows, last ? { status: 'completed', conclusion: 'failure' } : { step: 'Rebuild the source tree from the full bundle again (Windows)' }),
    steps: [
      done('Update the source tree from the delta (Windows)', 'failure', 12),
      done('Update the source tree from the delta again (Windows)', 'failure', 10),
      done('Download the full source bundle (Windows)', 'success', 9),
      done('Rebuild the source tree from the full bundle (Windows)', 'failure', 8),
      done('Download the full source bundle again (Windows)', 'success', 6),
      last
        ? done('Rebuild the source tree from the full bundle again (Windows)', 'failure', 3)
        : { name: 'Rebuild the source tree from the full bundle again (Windows)', status: 'in_progress', conclusion: null, started_at: minutesAgo(2) },
    ],
  });
  assert.equal(evaluate({ run: running, jobs: [tries(false)], now: NOW }).verdict, 'wait');
  const failed = evaluate({ run: running, jobs: [tries(true)], now: NOW });
  assert.equal(failed.exitCode, 2);
  assert.match(failed.lines.join('\n'), /step "Rebuild the source tree from the full bundle again \(Windows\)" \[infra\]/);
});

test('the most specific budget wins for a step name', () => {
  const notarizeDmg = {
    ...job('build (macos-latest)'),
    steps: [{ name: 'Codesign + notarize DMG (macOS)', status: 'in_progress', conclusion: null, started_at: minutesAgo(20) }],
  };
  // 'Notarize' (1500 s) and 'Codesign + notarize DMG' (1500 s) both match; a longer
  // custom budget for the DMG step must beat the generic one.
  const result = evaluate({
    run: running,
    jobs: [notarizeDmg],
    now: NOW,
    budgets: [['Notarize', 600], ['Codesign + notarize DMG', 1500]],
  });
  assert.equal(result.verdict, 'wait');
});

test('a completed run reports its conclusion and failing steps', () => {
  const ok = evaluate({ run: { status: 'completed', conclusion: 'success' }, jobs: [], now: NOW });
  assert.deepEqual([ok.verdict, ok.exitCode], ['completed-ok', 0]);

  const failed = evaluate({
    run: { status: 'completed', conclusion: 'failure' },
    jobs: [{
      ...job(windows, { status: 'completed', conclusion: 'failure' }),
      steps: [{ name: 'Run agent-game tests', status: 'completed', conclusion: 'failure', started_at: minutesAgo(18) }],
    }],
    now: NOW,
  });
  assert.deepEqual([failed.verdict, failed.exitCode], ['completed-failed', 1]);
  assert.match(failed.lines.join('\n'), /Run agent-game tests/);
});

test('classifyFailure maps each failure family to its follow-up action', () => {
  assert.equal(classifyFailure('Check out Git repository').kind, 'infra');
  assert.equal(classifyFailure('Notarize app (macOS)').kind, 'infra');
  assert.equal(classifyFailure('Run commerce, goods-trade, FT-commerce, PayBuzz, and wallet-security tests').kind, 'test');
  assert.equal(classifyFailure('Validate runtime dependency contracts').kind, 'test');
  assert.equal(classifyFailure('Build Electron app package (Windows signed)').kind, 'unknown');
  assert.doesNotMatch(classifyFailure('Build Electron app package (Windows signed)').advice, /rerun --failed/);
  // The source hand-over is infrastructure, and never "a test".
  for (const step of ['Download the source delta (Windows)', 'Rebuild the source tree from the full bundle (Windows)']) {
    assert.equal(classifyFailure(step).kind, 'infra', step);
    assert.match(classifyFailure(step).advice, /A refused delta alone is no failure/);
  }
});

test('stateKey changes only when a job moves, so polling stays quiet', () => {
  const first = evaluate({ run: running, jobs: [job(windows, { step: 'Install dependencies' })], now: NOW });
  const later = evaluate({ run: running, jobs: [job(windows, { step: 'Install dependencies' })], now: new Date(NOW.getTime() + 30_000) });
  const moved = evaluate({ run: running, jobs: [job(windows, { step: 'Build renderer (Vite)' })], now: new Date(NOW.getTime() + 30_000) });
  assert.equal(first.stateKey, later.stateKey);
  assert.notEqual(first.stateKey, moved.stateKey);
});

/* ---- command line ---- */

test('parseArgs: the `--` that pnpm forwards is ignored', () => {
  // `pnpm run release:watch -- 45842016787` hands the script `-- 45842016787`.
  // On 2026-11-26 that documented form died with "unknown argument --" (exit 64)
  // the first time it was used on a real run.
  const viaPnpm = parseArgs(['--', '45842016787']);
  assert.deepEqual(viaPnpm._, ['45842016787']);
  assert.equal(viaPnpm.once, undefined);
  assert.equal(viaPnpm.pollSeconds, 30);
  assert.deepEqual(viaPnpm.budgets, DEFAULT_BUDGETS);
});

test('parseArgs: options work on either side of a `--`', () => {
  const parsed = parseArgs(['45842016787', '--', '--once', '--poll-seconds', '5', '--budget', 'Check out Git repository=60']);
  assert.deepEqual(parsed._, ['45842016787']);
  assert.equal(parsed.once, true);
  assert.equal(parsed.pollSeconds, 5);
  assert.equal(parsed.budgets[parsed.budgets.length - 1][0], 'Check out Git repository');
  assert.equal(parsed.budgets[parsed.budgets.length - 1][1], 60);
});

test('an unknown argument is still refused before anything is read from GitHub', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /unknown argument --bogus/);
});
