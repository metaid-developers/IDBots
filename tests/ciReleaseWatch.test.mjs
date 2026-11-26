import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { evaluate, classifyFailure, parseArgs, DEFAULT_BUDGETS } from '../scripts/release-watch.mjs';
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
  // The delta is a few KB: minutes, not tens of them.
  assert.equal(evaluate({ run: running, jobs: [downloading('Download the source delta (Windows)', 6)], now: NOW }).exitCode, 4);
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

test('a finished run says when the source delta gave way to the full bundle, and why', () => {
  const done = (name, conclusion) => ({ name, status: 'completed', conclusion, started_at: minutesAgo(40) });
  const finished = (steps) => evaluate({
    run: { status: 'completed', conclusion: 'success' },
    jobs: [{ ...job(windows, { status: 'completed', conclusion: 'success' }), steps }],
    now: NOW,
  });
  const rebuilt = [done('Rebuild the source tree from the full bundle (Windows)', 'success')];
  const didNotFit = finished([done('Update the source tree from the delta (Windows)', 'success'), ...rebuilt]);
  assert.equal(didNotFit.verdict, 'completed-ok');
  assert.match(didNotFit.lines.join('\n'), /the source delta did not fit; the tree was rebuilt from the full bundle/);

  const failedOutright = finished([done('Update the source tree from the delta (Windows)', 'failure'), ...rebuilt]);
  assert.match(failedOutright.lines.join('\n'), /the source delta failed outright; the tree was rebuilt from the full bundle/);

  const byDelta = finished([
    done('Update the source tree from the delta (Windows)', 'success'),
    done('Download the full source bundle (Windows)', 'skipped'),
    done('Rebuild the source tree from the full bundle (Windows)', 'skipped'),
  ]);
  assert.equal(byDelta.verdict, 'completed-ok');
  assert.doesNotMatch(byDelta.lines.join('\n'), /gave way|did not fit|failed outright/);
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
