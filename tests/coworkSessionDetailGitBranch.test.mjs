import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx'
);

test('CoworkSessionDetail refreshes the header git branch when it changes', () => {
  // Windows checkouts are CRLF; the multi-line regexes below are anchored on
  // LF — normalize once at read time (§11.9).
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

  // While a session is actively running, the branch chip re-reads the working
  // directory on a streaming poll. perf-p2 (0bde55b02) replaced the idle 3s
  // poll with a 15s active-session-only interval so an idle app never churns
  // child-process probes; focus/visibility still cover the idle flows.
  assert.match(source, /const GIT_BRANCH_STREAMING_POLL_MS = 15_000;/);
  assert.match(
    source,
    /if \(!sessionActivelyRunning\) return;\s*\n\s*const interval = window\.setInterval\(\(\) => \{\s*\n\s*void refreshGitBranchRef\.current\?\.\(\);\s*\n\s*\}, GIT_BRANCH_STREAMING_POLL_MS\);/,
  );

  // One immediate probe when the gated effect runs, before the interval —
  // entering a session refreshes the chip even when nothing is streaming.
  assert.match(source, /void refreshGitBranchRef\.current\?\.\(\);\s*\n\s*if \(!sessionActivelyRunning\) return;/);

  // Immediate refreshes on window focus and tab re-visibility cover the
  // common "switched branch in a terminal, came back" flow.
  assert.match(source, /window\.addEventListener\('focus', onFocus\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', onVisibility\)/);

  // Hidden tabs skip the git probe entirely (no idle child-process churn).
  assert.match(source, /document\.visibilityState !== 'visible'/);

  // An unchanged branch must not re-render the header.
  assert.match(source, /setGitBranch\(\(prev\) => \(prev === branch \? prev : branch\)\)/);

  // In-flight guard: a probe that outlives the poll interval must not pile
  // up overlapping probes.
  assert.match(source, /probeInFlight/);
  assert.match(source, /if \(!active \|\| probeInFlight \|\| document\.visibilityState !== 'visible'\) return;/);

  // Failure counting survives the streaming-poll rework (0bde55b02 removed
  // the three-strike auto-stop): a failed probe reports null and the
  // active-session interval keeps trying; focus/visibility still re-probe so
  // a later `git init` is picked up.
  assert.match(source, /consecutiveFailures = branch === null \? consecutiveFailures \+ 1 : 0/);

  // The poll must be torn down with the effect (no leaks across sessions).
  assert.match(source, /window\.clearInterval\(interval\)/);
  assert.match(source, /window\.removeEventListener\('focus', onFocus\)/);
  assert.match(source, /document\.removeEventListener\('visibilitychange', onVisibility\)/);

  // Scope the effect to the session id + cwd: switching sessions or
  // workspaces resets and re-probes immediately.
  assert.match(source, /\}, \[currentSession\?\.id, currentSession\?\.cwd\]\)/);
});
