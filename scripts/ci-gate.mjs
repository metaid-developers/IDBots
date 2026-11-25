#!/usr/bin/env node
/**
 * Redundant-run gate for the Build/Release workflow (`.github/workflows/build.yml`).
 *
 * The failure class this closes: a release pushes `main` and its `v*` tag
 * together (release SOP §3.1.1), which starts TWO runs of this workflow for
 * the same commit one second apart. The main run is a strict subset of the tag
 * run, but both queue a Windows job for the single self-hosted `win-sign`
 * runner — and the main run, created first, takes the runner ahead of the
 * release. On 2026-11-25 (v1.1.3) the tag run's Windows job waited 57 min and
 * then 1 h 43 min behind its own same-commit main runs. The documented
 * workaround, cancelling the redundant run, is what takes the runner down
 * (SOP §11.16): v0.9.0 17 min, v1.1.0 a killed job, v1.1.3 a runner offline
 * for 7.5 h overnight.
 *
 * A run that never starts neither queues ahead of a release nor has to be
 * cancelled. A `main` push is skipped when it is redundant:
 *   1. its commit already carries a `v*` tag — the tag run builds and tests
 *      exactly this commit, plus the release job;
 *   2. it only bumps `version` in package.json — a release bump whose tag run
 *      is about to build the same tree.
 * Tag pushes and workflow_dispatch runs (rehearsals, SOP §5.1 retries) always
 * run, and so does anything the gate cannot prove redundant.
 *
 * The same gate also decides whether a tag run may leave out its test steps
 * (`skip_tests`). A tag run tests nothing new when the tagged commit only
 * bumps the version and its parent already has a main run whose three build
 * jobs — which run the identical test steps — succeeded. On 2026-11-25
 * (v1.1.3) six of the nine failed Windows attempts of the tag run were test
 * failures that main's own Windows job had already shown; the signing machine
 * built, tested and signed the same commit three times in a row. Anything
 * unproven — another change in the tagged commit, no completed main run for
 * the parent, a build job that failed or was skipped — keeps the tests.
 *
 * Usage: the workflow runs it with the runner's GITHUB_* env (GH_TOKEN for the
 * parent-run lookup) and reads `skip=<true|false>` and `skip_tests=<true|false>`
 * from $GITHUB_OUTPUT. Standalone it prints both decisions.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELEASE_BRANCH = 'refs/heads/main';
const RELEASE_TAG_PREFIX = 'v';
// A package.json line that only sets the version, e.g. `  "version": "1.1.3",`.
const VERSION_LINE = /^\s*"version"\s*:\s*"[^"]+",?\s*$/;

/**
 * Parse `git ls-remote --tags`: `<sha>\trefs/tags/<name>` per tag, plus — for
 * an annotated tag only — a peeled line `<commit>\trefs/tags/<name>^{}`.
 */
export function parseLsRemoteTags(output) {
  const tags = new Map();
  for (const line of String(output).split('\n')) {
    const match = line.match(/^([0-9a-f]{40,64})\s+refs\/tags\/(.+?)(\^\{\})?$/);
    if (!match) continue;
    const [, sha, name, peeled] = match;
    const entry = tags.get(name) ?? {};
    if (peeled) entry.commit = sha;
    else entry.ref = sha;
    tags.set(name, entry);
  }
  return tags;
}

/** True when a release tag (`v*`) resolves to `sha`, annotated or lightweight. */
export function isReleaseTagged(tags, sha) {
  const want = String(sha).toLowerCase();
  for (const [name, entry] of tags) {
    if (!name.startsWith(RELEASE_TAG_PREFIX)) continue;
    if ((entry.commit ?? entry.ref)?.toLowerCase() === want) return true;
  }
  return false;
}

/** True when the push changed package.json and nothing but its version line. */
export function isPureVersionBump(changedFiles, packageJsonDiff) {
  if (changedFiles.length !== 1 || changedFiles[0] !== 'package.json') return false;
  const changedLines = String(packageJsonDiff)
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .map((line) => line.slice(1));
  return changedLines.length > 0 && changedLines.every((line) => VERSION_LINE.test(line));
}

export function decide({ eventName, ref, sha, tags, changedFiles, packageJsonDiff }) {
  if (eventName !== 'push') return { skip: false, reason: `${eventName || 'unknown'} event: not a branch push` };
  if (ref !== RELEASE_BRANCH) return { skip: false, reason: `push to ${ref}: not ${RELEASE_BRANCH}` };
  if (isReleaseTagged(tags, sha)) {
    return { skip: true, reason: `commit ${sha.slice(0, 9)} carries a release tag; the tag run covers it` };
  }
  if (isPureVersionBump(changedFiles, packageJsonDiff)) {
    return { skip: true, reason: 'push only bumps the package.json version; the tag run builds it' };
  }
  return { skip: false, reason: `push to main touches ${changedFiles.length} file(s)` };
}

/** How build.yml names its matrix jobs: `build (windows-signer, --win --x64)`. */
const BUILD_JOB_PREFIX = 'build (';
const BUILD_PLATFORMS = 3;

/**
 * Whether a tag run may skip its test steps. `parentRun` is the parent
 * commit's latest completed main run ({ jobs: [{ name, conclusion }] }) or
 * null; a build job that was skipped counts as not green, so a main run that
 * this gate itself skipped can never vouch for anything.
 */
export function decideTests({ eventName, ref, sha, changedFiles, packageJsonDiff, parentRun }) {
  const keep = (reason) => ({ skip: false, reason });
  if (eventName !== 'push' || !ref.startsWith('refs/tags/')) return keep('not a tag push');
  if (!isPureVersionBump(changedFiles, packageJsonDiff)) {
    return keep(`tagged commit ${sha.slice(0, 9)} changes more than the version`);
  }
  if (!parentRun) return keep('the parent commit has no completed main run to vouch for this tree');
  const builds = (parentRun.jobs ?? []).filter((job) => job.name.startsWith(BUILD_JOB_PREFIX));
  if (builds.length < BUILD_PLATFORMS) {
    return keep(`the parent's main run lists only ${builds.length} build job(s), fewer than ${BUILD_PLATFORMS} platforms`);
  }
  const notGreen = builds.filter((job) => job.conclusion !== 'success');
  if (notGreen.length > 0) {
    return keep(`the parent's main run is not green (${notGreen.map((job) => `${job.name}: ${job.conclusion}`).join('; ')})`);
  }
  return {
    skip: true,
    reason: `tagged commit ${sha.slice(0, 9)} only bumps the version and its parent's main run is green on ${builds.length} platforms`,
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
}

function describePush(sha) {
  // A root commit (or a history-less checkout) has no parent: report "unknown"
  // rather than guessing, so the gate falls back to running.
  try {
    const changedFiles = git(['diff', '--name-only', '-z', `${sha}^1`, sha]).split('\0').filter(Boolean);
    const packageJsonDiff = changedFiles.includes('package.json')
      ? git(['diff', '--unified=0', `${sha}^1`, sha, '--', 'package.json'])
      : '';
    return { changedFiles, packageJsonDiff };
  } catch {
    return { changedFiles: [], packageJsonDiff: '' };
  }
}

function parentOf(sha) {
  try {
    return git(['rev-parse', `${sha}^1`]).trim();
  } catch {
    return null;
  }
}

/** One `gh api` call, reduced with --jq; null when it cannot be made or parsed. */
function ghJson(route, query) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  try {
    const output = execFileSync('gh', ['api', `repos/${repo}/${route}`, '--jq', query], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GH_TOKEN: token },
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/**
 * The latest completed Build/Release run of `commitSha` on main, reduced to
 * its jobs' conclusions — or null when there is none or it cannot be read.
 */
function findMainRunFor(commitSha) {
  if (!commitSha) return null;
  const run = ghJson(
    `actions/runs?head_sha=${commitSha}&event=push&per_page=20`,
    '[.workflow_runs[] | select(.head_branch == "main" and .path == ".github/workflows/build.yml" and .status == "completed")]'
      + ' | sort_by(.run_started_at) | last | {id}',
  );
  if (!run || !run.id) return null;
  return ghJson(`actions/runs/${run.id}/jobs?per_page=50`, '{jobs: [.jobs[] | {name, conclusion}]}');
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const ref = process.env.GITHUB_REF ?? '';
  const sha = process.env.GITHUB_SHA ?? '';
  let tags = new Map();
  let changedFiles = [];
  let packageJsonDiff = '';
  if (eventName === 'push' && ref === RELEASE_BRANCH) {
    tags = parseLsRemoteTags(git(['ls-remote', '--tags', 'origin']));
    ({ changedFiles, packageJsonDiff } = describePush(sha));
  }
  const decision = decide({ eventName, ref, sha, tags, changedFiles, packageJsonDiff });
  console.log(`[ci-gate] ${decision.skip ? 'SKIP' : 'RUN'}: ${decision.reason}`);

  let tests = { skip: false, reason: 'not a tag push' };
  if (eventName === 'push' && ref.startsWith('refs/tags/')) {
    // What main last built is the parent of the tagged commit.
    tests = decideTests({
      eventName,
      ref,
      sha,
      ...describePush(sha),
      parentRun: findMainRunFor(parentOf(sha)),
    });
  }
  console.log(`[ci-gate] tests ${tests.skip ? 'SKIPPED' : 'RUN'}: ${tests.reason}`);

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendFileSync(outputFile, `skip=${decision.skip}\nskip_tests=${tests.skip}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
