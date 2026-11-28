#!/usr/bin/env node
/**
 * Job-level release watchdog for a Build/Release run.
 *
 * The failure class this closes: the release SOP says to watch a tag run at
 * JOB level (§5.1: v0.9.6's Windows job died at 15:39 while the run was only
 * marked failed 39 minutes later), yet everything that watched v1.1.3 on
 * 2026-11-25 waited for the RUN — `gh run watch` in scripts/release-runbook.mjs
 * and the ad-hoc background polls alike. Two failures were noticed 34 and 44
 * minutes late because the macOS jobs were still running. And nothing watched
 * for the most expensive state of all, a job that nobody picks up: the
 * signing machine's runner process had already been gone for two days, and
 * the Windows job of the release sat queued for 7 h 46 min before anyone
 * looked.
 *
 * This watcher exits the moment attention is needed rather than when the run
 * ends, so a background task wrapping it wakes the release operator (or the
 * agent session driving the release) at the right time:
 *   0  run completed successfully
 *   1  run completed failed / cancelled (failing steps named)
 *   2  a job already failed while the run is still going
 *   3  a job has been queued past --queued-alert-seconds (runner offline,
 *      busy elsewhere, or wedged) — runner state and the fix are printed
 *   4  a step has been running past its budget
 *   5  --max-minutes exceeded without a verdict
 *   6  could not read the run from GitHub for --read-failure-limit-seconds
 *      (default 15 min) — a shorter outage is waited out
 *
 * Usage:
 *   node scripts/release-watch.mjs <run-id> [--once] [--poll-seconds 30]
 *        [--queued-alert-seconds 300] [--max-minutes 240]
 *        [--read-failure-limit-seconds 900]
 *        [--budget "<step name substring>=<seconds>" ...]
 *   pnpm run release:watch -- <run-id> [...]   (same; pnpm forwards the `--`)
 * Read-only: GET calls through `gh` only.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO = 'metaid-developers/IDBots';

// Seconds a step may run before it is called stuck. Healthy v1.1.3 steps:
// checkout 0.2–1.2 min, packaging 28 min, notarize ~6 min; its worst checkout
// took 107 min. The signing machine's downloads from GitHub's artifact
// storage are slow: the 36 MB source bundle took 15 min on 2026-11-26.
export const DEFAULT_BUDGETS = [
  ['Check out Git repository', 600],
  ['Run actions/cache', 900],
  // Fragments on purpose: each matches the first try and the "again" one.
  ['Download the source delta', 300],
  ['Download the full source bundle', 1800],
  ['Update the source tree from the delta', 600],
  ['Rebuild the source tree from the full bundle', 900],
  ['Build Electron app package', 3000],
  ['Notarize', 1500],
  ['Codesign + notarize DMG', 1500],
];
export const DEFAULT_STEP_BUDGET_SECONDS = 2700;

const QUEUED_STATUSES = new Set(['queued', 'pending', 'waiting', 'requested']);
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

// The source hand-over gets two tries each, and none of its steps but the
// last is allowed to end the job: the delta steps hand over to a second
// download and, failing that, to the full bundle; the first rebuild hands over
// to the second. The delta only fits a machine that still holds the previous
// run's commit, and a download from the signing machine can arrive cut short
// (2026-11-27: twice in a row), so both happen.
const DELTA_STEPS = ['Update the source tree from the delta (Windows)', 'Update the source tree from the delta again (Windows)'];
const REBUILD_STEPS = ['Rebuild the source tree from the full bundle (Windows)', 'Rebuild the source tree from the full bundle again (Windows)'];
const isTakenOver = (step, steps) =>
  (DELTA_STEPS.includes(step.name) && steps.some((other) => REBUILD_STEPS.includes(other.name)))
  || (step.name === REBUILD_STEPS[0] && steps.some((other) => other.name === REBUILD_STEPS[1]));

const minutes = (seconds) => {
  const value = Math.round(seconds / 60);
  return value >= 60 ? `${Math.floor(value / 60)} h ${value % 60} min` : `${value} min`;
};

const currentStep = (job) => (job.steps || []).find((step) => step.status === 'in_progress');

function describeJob(job, now, runStartedAt) {
  const state = job.status === 'completed' ? job.conclusion : job.status;
  const startedAt = Date.parse(job.started_at || '');
  let timing;
  if (!Number.isNaN(startedAt)) {
    const end = Date.parse(job.completed_at || '');
    timing = `ran ${minutes(((Number.isNaN(end) ? now : end) - startedAt) / 1000)}`;
  } else {
    timing = `queued ${minutes((now - Date.parse(job.created_at || runStartedAt)) / 1000)}`;
  }
  const step = currentStep(job);
  const progress = step ? `, at "${step.name}" (${job.steps.filter((s) => s.status === 'completed').length}/${job.steps.length})` : '';
  return `  ${job.name} — ${state}, ${timing}${progress}`;
}

const describeJobs = (jobs, now, runStartedAt) => jobs.map((job) => describeJob(job, now, runStartedAt));

/** What a failed step most likely is, and the action that follows from it. */
export function classifyFailure(stepName = '') {
  if (/Check out Git repository/i.test(stepName)) {
    return {
      kind: 'infra',
      advice: 'Checkout failed. If the log shows a network error (curl 56 / connection reset / could not connect), rerun only the failed jobs: gh run rerun --failed <run-id> (SOP §5.1).',
    };
  }
  if (/Notarize|staple/i.test(stepName)) {
    return {
      kind: 'infra',
      advice: 'Notary/staple failed. Transient Apple network errors (NSURLError -1005 / -1009) rerun clean: gh run rerun --failed <run-id> (SOP §5.1).',
    };
  }
  if (/Smoke-test the signing service/i.test(stepName)) {
    return {
      kind: 'infra',
      advice: 'The signing service did not sign a test file. On the signing machine that is the SimplySign session running out — it lasts 2 h 27 min from the login, however recently it was used (release SOP 11.54). Re-login SimplySign on the signing machine, do the smoke signature of release SOP 11.18, then rerun the failed jobs: gh run rerun --failed <run-id>.',
    };
  }
  if (/source (delta|bundle)|source tree/i.test(stepName)) {
    return {
      kind: 'infra',
      advice: 'The source hand-over did not get through. A refused delta alone is no failure (the full bundle rebuilds the tree); a failed download or rebuild means the artifact is broken or the workspace is in use. Read the step log, then: gh run rerun --failed <run-id> (SOP §5.1).',
    };
  }
  if (/tests?\b|contract|harness|tooling|test step/i.test(stepName)) {
    return {
      kind: 'test',
      advice: 'A test failed. Treat it as real until the log proves a documented load flake; fix before pushing again (SOP §5).',
    };
  }
  return {
    kind: 'unknown',
    advice: 'Read the step log before rerunning: signer and NSIS errors must be fixed first, rerunning only repeats them (SOP §11.3, §11.34, §11.36).',
  };
}

function describeFailures(jobs, jobLogs = {}) {
  const lines = [];
  for (const job of jobs) {
    const steps = job.steps || [];
    const failedSteps = steps.filter((step) => FAILED_CONCLUSIONS.has(step.conclusion) && !isTakenOver(step, steps));
    if (failedSteps.length === 0 && !FAILED_CONCLUSIONS.has(job.conclusion)) continue;
    lines.push(`  ✗ ${job.name} — ${job.conclusion || 'a step failed'}`);
    for (const step of failedSteps) {
      const { kind, advice } = classifyFailure(step.name);
      lines.push(`      step "${step.name}" [${kind}]`);
      lines.push(`      → ${advice}`);
    }
    // The signing hook says so itself, in the one line that matters
    // (scripts/windows-sign.cjs); the step's name alone cannot.
    if (/windows-sign: the signing service is not answering/.test(jobLogs[job.id] || '')) {
      lines.push(
        '      the job log says the signing service is not answering: the SimplySign session has run out — it lasts 2 h 27 min from the login, however recently it was used (release SOP 11.54). Re-login SimplySign on the signing machine, do the smoke signature of release SOP 11.18, then rerun the failed jobs: gh run rerun --failed <run-id>.'
      );
    }
  }
  return lines;
}

/**
 * Why the delta gave way, read from the job's log. The step's recorded
 * conclusion cannot tell: the step is allowed to fail, so GitHub reports it
 * as "success" whether the tool declined cleanly or crashed (run 45888882259
 * reported a crash as a clean decline until the log was read by hand).
 */
export function fallbackReason(log = '') {
  // Every try that could not use the delta prints this with the exit code in
  // it. The echoed step script has "$code" there, so the echo never counts.
  const said = (log.match(/The source delta could not be used \(exit \d+\)/g) || []).length;
  // One try leaves two lines, the tool's and the step's; before the step said so in words, only the tool's line did.
  const tries = said || (log.match(/ci-source-restore: git index-pack /g) || []).length;
  if (tries > 1) return 'was unusable twice (a download cut short, most likely)';
  if (tries === 1) return 'was unusable once, and after a second download did not fit';
  // The "does not fit" sentence counts only as a line of its own: the log
  // echoes the step's script, which contains it whether or not it ever ran
  // (reading the echo first once reported a crash as a clean decline).
  if (/(?:^|[\t]|Z )The source delta does not fit this workspace/.test(log)) return 'did not fit';
  // Any other line in which the tool itself gave up. A clone from the bundle is the rebuild's own story, which the caller tells.
  const failure = log.match(/ci-source-restore: (?!git clone )([^\r\n]*)/);
  if (failure) return `failed outright: ${failure[1].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 160)}`;
  return 'gave way, for a reason the log does not state';
}

/** Where a fallback had to step in, for the record: it cost time, not the run. */
function describeFallbacks(jobs, jobLogs = {}) {
  const lines = [];
  for (const job of jobs) {
    const steps = job.steps || [];
    if (!REBUILD_STEPS.some((name) => steps.find((step) => step.name === name)?.conclusion === 'success')) continue;
    const log = jobLogs[job.id] || '';
    // The tool failing to clone from the bundle is what made a second download of it necessary.
    const bundleTwice = /ci-source-restore: git clone /.test(log) ? ', and the full bundle had to be downloaded twice' : '';
    // 1–15 min more: the full bundle took a minute on 2026-11-27 and a quarter of an hour the night before.
    lines.push(`  ℹ ${job.name} — the source delta ${fallbackReason(log)}; the tree was rebuilt from the full bundle instead (1–15 min more${bundleTwice}; the hand-over steps' logs have the details).`);
  }
  return lines;
}

function diagnoseRunner(job, runners, repo) {
  const labels = job.labels || [];
  const candidates = runners.filter((runner) => labels.every((label) => (runner.labels || []).includes(label)));
  if (candidates.length === 0) {
    return [`      no runner is registered with labels [${labels.join(', ')}] — Settings → Actions → Runners`];
  }
  return candidates.map((runner) => {
    if (runner.status !== 'online') {
      return `      runner ${runner.name} is ${runner.status}: nothing can take the job until it is back (SOP §11.16).`;
    }
    if (runner.busy) {
      return `      runner ${runner.name} is busy with another job — see which: gh run list --repo ${repo} --status in_progress`;
    }
    return `      runner ${runner.name} is online and idle but not taking the job: its message listener is wedged (SOP §11.16). `
      + 'With no job assigned to it, restart it: schtasks /end /tn \\GitHubActionsRunner-IDBots, then schtasks /run /tn \\GitHubActionsRunner-IDBots.';
  });
}

function budgetFor(stepName, budgets, fallback) {
  // Most specific match wins: the longest matching substring.
  let best = fallback;
  let bestLength = 0;
  for (const [fragment, seconds] of budgets) {
    if (stepName.includes(fragment) && fragment.length > bestLength) {
      best = seconds;
      bestLength = fragment.length;
    }
  }
  return best;
}

/**
 * Decide what the watcher should do from one snapshot of the run.
 *
 * @returns {{ verdict: string, exitCode: number | null, lines: string[], stateKey: string }}
 */
export function evaluate({
  run,
  jobs,
  runners = [],
  now = new Date(),
  queuedAlertSeconds = 300,
  budgets = DEFAULT_BUDGETS,
  defaultStepBudgetSeconds = DEFAULT_STEP_BUDGET_SECONDS,
  repo = DEFAULT_REPO,
  jobLogs = {},
}) {
  const runStartedAt = run.startedAt || run.created_at || now.toISOString();
  const overview = describeJobs(jobs, now, runStartedAt);
  const stateKey = jobs
    .map((job) => `${job.name}|${job.status}|${job.conclusion}|${currentStep(job)?.name ?? ''}`)
    .join(';');

  if (run.status === 'completed') {
    const fallbacks = describeFallbacks(jobs, jobLogs);
    if (run.conclusion === 'success') {
      return { verdict: 'completed-ok', exitCode: 0, lines: [...overview, ...fallbacks, 'run succeeded'], stateKey };
    }
    return { verdict: 'completed-failed', exitCode: 1, lines: [...overview, ...fallbacks, ...describeFailures(jobs, jobLogs)], stateKey };
  }

  // A failed step is reported the moment it is recorded, even while the job is
  // still running its remaining (or post) steps.
  const failures = describeFailures(jobs);
  if (failures.length > 0) {
    return {
      verdict: 'job-failed',
      exitCode: 2,
      lines: [
        ...overview,
        ...failures,
        'The run is still going: act on this now instead of waiting for its other jobs. Later suites may add failures of their own.',
      ],
      stateKey,
    };
  }

  for (const job of jobs.filter((candidate) => QUEUED_STATUSES.has(candidate.status))) {
    const queuedSeconds = (now - Date.parse(job.created_at || runStartedAt)) / 1000;
    if (queuedSeconds >= queuedAlertSeconds) {
      return {
        verdict: 'queued-too-long',
        exitCode: 3,
        lines: [
          ...overview,
          `  job "${job.name}" has been queued for ${minutes(queuedSeconds)} (alert at ${minutes(queuedAlertSeconds)}).`,
          ...diagnoseRunner(job, runners, repo),
        ],
        stateKey,
      };
    }
  }

  for (const job of jobs.filter((candidate) => candidate.status === 'in_progress')) {
    const step = currentStep(job);
    if (!step?.started_at) continue;
    const elapsed = (now - Date.parse(step.started_at)) / 1000;
    const budget = budgetFor(step.name, budgets, defaultStepBudgetSeconds);
    if (elapsed >= budget) {
      return {
        verdict: 'step-over-budget',
        exitCode: 4,
        lines: [
          ...overview,
          `  step "${step.name}" has been running for ${minutes(elapsed)} (budget ${minutes(budget)}).`,
          '  Read the live log before deciding: a hung download or a signer waiting on a prompt needs a fix, not more waiting.',
        ],
        stateKey,
      };
    }
  }

  return { verdict: 'wait', exitCode: null, lines: overview, stateKey };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function fetchSnapshot(runId, repo) {
  const run = JSON.parse(gh(['run', 'view', runId, '--repo', repo, '--json', 'status,conclusion,startedAt,url']));
  const jobs = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=50`])).jobs;
  return { run, jobs };
}

function fetchRunners(repo) {
  const runners = JSON.parse(gh(['api', `repos/${repo}/actions/runners`])).runners;
  return runners.map((runner) => ({ name: runner.name, status: runner.status, busy: runner.busy, labels: (runner.labels || []).map((label) => label.name) }));
}

/** A job's log, for when a fallback needs explaining. Best effort: the verdict never depends on it. */
function fetchJobLog(jobId, repo) {
  try {
    return gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`]);
  } catch {
    return '';
  }
}

const hasRebuiltFromFallback = (job) =>
  REBUILD_STEPS.some((name) => (job.steps || []).some((step) => step.name === name && step.conclusion === 'success'));

// A watcher must not die on one dropped response; it also must not spin forever.
function withRetry(label, read) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return read();
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000 * attempt);
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message.split('\n')[0] : lastError}`);
}

export function parseArgs(argv) {
  const options = { _: [], pollSeconds: 30, queuedAlertSeconds: 300, maxMinutes: 240, readFailureLimitSeconds: 900, budgets: [...DEFAULT_BUDGETS], repo: process.env.IDBOTS_RELEASE_REPO || DEFAULT_REPO };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // `pnpm run release:watch -- <run-id>` hands the `--` on to the script.
    if (arg === '--') continue;
    if (arg === '--once') options.once = true;
    else if (arg === '--poll-seconds') options.pollSeconds = Number(argv[++index]);
    else if (arg === '--queued-alert-seconds') options.queuedAlertSeconds = Number(argv[++index]);
    else if (arg === '--max-minutes') options.maxMinutes = Number(argv[++index]);
    else if (arg === '--read-failure-limit-seconds') options.readFailureLimitSeconds = Number(argv[++index]);
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--budget') {
      const [fragment, seconds] = String(argv[++index]).split('=');
      options.budgets.push([fragment, Number(seconds)]);
    } else if (/^\d+$/.test(arg)) options._.push(arg);
    else {
      console.error(`release-watch: unknown argument ${arg}`);
      process.exit(64);
    }
  }
  return options;
}

/**
 * What to do when the run cannot be read: keep waiting, or give up (exit 6).
 * A watcher that dies on a dropped response wakes nobody — on 2026-11-27 one
 * rough minute at GitHub ended the watch of a healthy run — so it waits, but
 * not forever.
 */
export function readFailureVerdict({ unreadableSeconds, limitSeconds, once = false }) {
  if (once || unreadableSeconds >= limitSeconds) return 'give-up';
  return 'wait';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = options._[0];
  if (!runId) {
    console.error('Usage: node scripts/release-watch.mjs <run-id> [--once] [--poll-seconds 30] [--queued-alert-seconds 300] [--max-minutes 240] [--read-failure-limit-seconds 900] [--budget "<step substring>=<seconds>"');
    process.exit(64);
  }

  const startedAt = Date.now();
  let lastStateKey = '';
  // Since when the run has been unreadable; null as soon as it can be read again.
  let unreadableSince = null;
  for (;;) {
    let snapshot;
    let runners = [];
    try {
      snapshot = withRetry('reading run', () => fetchSnapshot(runId, options.repo));
      // Only a queued job needs runner state; the runners endpoint needs admin scope that not every token has.
      if (snapshot.jobs.some((job) => QUEUED_STATUSES.has(job.status))) {
        try {
          runners = fetchRunners(options.repo);
        } catch {
          runners = [];
        }
      }
      unreadableSince = null;
    } catch (error) {
      unreadableSince ??= Date.now();
      const unreadableSeconds = (Date.now() - unreadableSince) / 1000;
      const message = error instanceof Error ? error.message : error;
      if (readFailureVerdict({ unreadableSeconds, limitSeconds: options.readFailureLimitSeconds, once: options.once }) === 'give-up') {
        console.error(`\n[release-watch] could not read the run for ${minutes(unreadableSeconds)}: ${message}`);
        process.exit(6);
      }
      console.error(`[release-watch] could not read the run: ${message}\n[release-watch] trying again in ${options.pollSeconds} s; gives up after ${minutes(options.readFailureLimitSeconds)} of this.`);
      await new Promise((resolve) => setTimeout(resolve, options.pollSeconds * 1000));
      continue;
    }

    // Why a fallback stepped in, and why a job failed in its packaging, are only
    // in the log, and the log is only worth reading once the run is over.
    const jobLogs = {};
    if (snapshot.run.status === 'completed') {
      const worthReading = (job) => hasRebuiltFromFallback(job) || FAILED_CONCLUSIONS.has(job.conclusion);
      for (const job of snapshot.jobs.filter(worthReading)) jobLogs[job.id] = fetchJobLog(job.id, options.repo);
    }

    const result = evaluate({
      ...snapshot,
      runners,
      now: new Date(),
      queuedAlertSeconds: options.queuedAlertSeconds,
      budgets: options.budgets,
      repo: options.repo,
      jobLogs,
    });

    if (options.once) {
      console.log(result.lines.join('\n'));
      return 0;
    }
    if (result.stateKey !== lastStateKey) {
      console.log(`\n[release-watch] run ${runId} (attempt snapshot at ${new Date().toISOString().slice(11, 16)} UTC)`);
      console.log(result.lines.join('\n'));
      lastStateKey = result.stateKey;
    }
    if (result.verdict !== 'wait') {
      console.log(`\n[release-watch] verdict: ${result.verdict} (exit ${result.exitCode}) — run ${snapshot.run.url}`);
      process.exit(result.exitCode);
    }
    if ((Date.now() - startedAt) / 60_000 >= options.maxMinutes) {
      console.log(`\n[release-watch] no verdict after ${options.maxMinutes} min (--max-minutes) — run ${snapshot.run.url}`);
      process.exit(5);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollSeconds * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
