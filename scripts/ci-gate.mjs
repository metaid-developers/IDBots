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
 * Usage: the workflow runs it with the runner's GITHUB_* env and reads
 * `skip=<true|false>` from $GITHUB_OUTPUT. Standalone it prints the decision.
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
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendFileSync(outputFile, `skip=${decision.skip}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
