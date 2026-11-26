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
 *   6  could not read the run from GitHub
 *
 * Usage:
 *   node scripts/release-watch.mjs <run-id> [--once] [--poll-seconds 30]
 *        [--queued-alert-seconds 300] [--max-minutes 240]
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
  ['Download the source delta (Windows)', 300],
  ['Download the full source bundle (Windows)', 1800],
  ['Update the source tree from the delta (Windows)', 600],
  ['Rebuild the source tree from the full bundle (Windows)', 900],
  ['Build Electron app package', 3000],
  ['Notarize', 1500],
  ['Codesign + notarize DMG', 1500],
];
export const DEFAULT_STEP_BUDGET_SECONDS = 2700;

const QUEUED_STATUSES = new Set(['queued', 'pending', 'waiting', 'requested']);
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

// A step that may fail because the step behind it takes over: the source
// delta only fits a machine that still holds the previous run's commit (it
// says so with a clean exit 3; a broken delta fails, and is covered the same way).
const FALLBACKS = [
  ['Update the source tree from the delta (Windows)', 'Rebuild the source tree from the full bundle (Windows)'],
];
const isTakenOver = (step, steps) =>
  FALLBACKS.some(([failed, fallback]) => step.name === failed && steps.some((other) => other.name === fallback));

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

function describeFailures(jobs) {
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
  }
  return lines;
}

/** Where a fallback had to step in, for the record: it cost time, not the run. */
function describeFallbacks(jobs) {
  const lines = [];
  for (const job of jobs) {
    const steps = job.steps || [];
    for (const [failed, fallback] of FALLBACKS) {
      const gave = steps.find((step) => step.name === failed);
      if (steps.find((step) => step.name === fallback)?.conclusion !== 'success') continue;
      // The usual case is a clean "does not fit" (the machine holds another
      // commit); a failed step means the delta itself is broken.
      const why = gave && FAILED_CONCLUSIONS.has(gave.conclusion) ? 'failed outright' : 'did not fit';
      lines.push(`  ℹ ${job.name} — the source delta ${why}; the tree was rebuilt from the full bundle instead (about 15 min more; the "${failed}" step log has the details).`);
    }
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
}) {
  const runStartedAt = run.startedAt || run.created_at || now.toISOString();
  const overview = describeJobs(jobs, now, runStartedAt);
  const stateKey = jobs
    .map((job) => `${job.name}|${job.status}|${job.conclusion}|${currentStep(job)?.name ?? ''}`)
    .join(';');

  if (run.status === 'completed') {
    const fallbacks = describeFallbacks(jobs);
    if (run.conclusion === 'success') {
      return { verdict: 'completed-ok', exitCode: 0, lines: [...overview, ...fallbacks, 'run succeeded'], stateKey };
    }
    return { verdict: 'completed-failed', exitCode: 1, lines: [...overview, ...fallbacks, ...describeFailures(jobs)], stateKey };
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
  const options = { _: [], pollSeconds: 30, queuedAlertSeconds: 300, maxMinutes: 240, budgets: [...DEFAULT_BUDGETS], repo: process.env.IDBOTS_RELEASE_REPO || DEFAULT_REPO };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // `pnpm run release:watch -- <run-id>` hands the `--` on to the script.
    if (arg === '--') continue;
    if (arg === '--once') options.once = true;
    else if (arg === '--poll-seconds') options.pollSeconds = Number(argv[++index]);
    else if (arg === '--queued-alert-seconds') options.queuedAlertSeconds = Number(argv[++index]);
    else if (arg === '--max-minutes') options.maxMinutes = Number(argv[++index]);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = options._[0];
  if (!runId) {
    console.error('Usage: node scripts/release-watch.mjs <run-id> [--once] [--poll-seconds 30] [--queued-alert-seconds 300] [--max-minutes 240] [--budget "<step substring>=<seconds>"]');
    process.exit(64);
  }

  const startedAt = Date.now();
  let lastStateKey = '';
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
    } catch (error) {
      console.error(`[release-watch] ${error instanceof Error ? error.message : error}`);
      process.exit(6);
    }

    const result = evaluate({
      ...snapshot,
      runners,
      now: new Date(),
      queuedAlertSeconds: options.queuedAlertSeconds,
      budgets: options.budgets,
      repo: options.repo,
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
