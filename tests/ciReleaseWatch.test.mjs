import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, classifyFailure } from '../scripts/release-watch.mjs';

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
});

test('stateKey changes only when a job moves, so polling stays quiet', () => {
  const first = evaluate({ run: running, jobs: [job(windows, { step: 'Install dependencies' })], now: NOW });
  const later = evaluate({ run: running, jobs: [job(windows, { step: 'Install dependencies' })], now: new Date(NOW.getTime() + 30_000) });
  const moved = evaluate({ run: running, jobs: [job(windows, { step: 'Build renderer (Vite)' })], now: new Date(NOW.getTime() + 30_000) });
  assert.equal(first.stateKey, later.stateKey);
  assert.notEqual(first.stateKey, moved.stateKey);
});
