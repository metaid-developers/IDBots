import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsRemoteTags, isReleaseTagged, isPureVersionBump, decide, decideTests } from '../scripts/ci-gate.mjs';

const sha = (char) => char.repeat(40);
const HEAD = sha('a');
const TAG_OBJECT = sha('b');
const OTHER = sha('c');
const UNTAGGED = sha('d');

// Shape of `git ls-remote --tags`: an annotated tag has a peeled `^{}` line
// carrying the commit, a lightweight tag has only its own line.
const LS_REMOTE = [
  `${TAG_OBJECT}\trefs/tags/v1.1.3`,
  `${HEAD}\trefs/tags/v1.1.3^{}`,
  `${OTHER}\trefs/tags/v1.0.21`,
  `${OTHER}\trefs/tags/v1.0.21^{}`,
  `${HEAD}\trefs/tags/backup-lightweight`,
  `\trefs/tags/ignored-malformed`,
].join('\n');

test('parseLsRemoteTags: an annotated tag resolves to its peeled commit, a lightweight one to its ref', () => {
  const tags = parseLsRemoteTags(LS_REMOTE);
  assert.equal(tags.get('v1.1.3').commit, HEAD);
  assert.equal(tags.get('v1.1.3').ref, TAG_OBJECT);
  assert.equal(tags.get('backup-lightweight').ref, HEAD);
  assert.equal(tags.get('backup-lightweight').commit, undefined);
  assert.equal(tags.has('ignored-malformed'), false);
});

test('isReleaseTagged: true for a v* tag on the commit, annotated or lightweight', () => {
  const tags = parseLsRemoteTags(LS_REMOTE);
  assert.equal(isReleaseTagged(tags, HEAD.toUpperCase()), true);
  assert.equal(isReleaseTagged(tags, UNTAGGED), false, 'a commit without a v* tag');
  assert.equal(isReleaseTagged(tags, OTHER), true, 'v1.0.21 is annotated: its peeled commit counts');
  assert.equal(isReleaseTagged(tags, TAG_OBJECT), false, "an annotated tag's own object sha is not its commit");
  assert.equal(isReleaseTagged(new Map(), HEAD), false);
});

test('isReleaseTagged ignores tags outside the release prefix', () => {
  const tags = parseLsRemoteTags(`${HEAD}\trefs/tags/cloud-v1.2.0\n${HEAD}\trefs/tags/cloud-v1.2.0^{}`);
  assert.equal(isReleaseTagged(tags, HEAD), false);
});

test('isPureVersionBump: only the package.json version line may change', () => {
  const bump = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -3 +3 @@',
    '-  "version": "1.1.2",',
    '+  "version": "1.1.3",',
  ].join('\n');
  assert.equal(isPureVersionBump(['package.json'], bump), true);
  assert.equal(isPureVersionBump(['package.json'], ''), false, 'no diff is not proof of a bump');
  assert.equal(isPureVersionBump([], bump), false, 'a shallow checkout without the parent');
  assert.equal(
    isPureVersionBump(['package.json'], `${bump}\n+  "electron-updater": "^6.6.2",`),
    false,
    'a dependency change in the same file',
  );
  assert.equal(isPureVersionBump(['package.json', 'update-notifications.json'], bump), false);
});

test('decide: tag pushes and dispatch runs always run — they are the release itself', () => {
  const tags = parseLsRemoteTags(LS_REMOTE);
  assert.equal(decide({ eventName: 'push', ref: 'refs/tags/v1.1.3', sha: HEAD, tags, changedFiles: [], packageJsonDiff: '' }).skip, false);
  assert.equal(decide({ eventName: 'workflow_dispatch', ref: 'refs/tags/v1.1.3', sha: HEAD, tags, changedFiles: [], packageJsonDiff: '' }).skip, false);
  assert.equal(decide({ eventName: 'pull_request', ref: 'refs/pull/1/merge', sha: HEAD, tags, changedFiles: [], packageJsonDiff: '' }).skip, false);
});

test('decide: a main push whose commit carries the release tag is redundant', () => {
  const tags = parseLsRemoteTags(LS_REMOTE);
  const decision = decide({ eventName: 'push', ref: 'refs/heads/main', sha: HEAD, tags, changedFiles: ['src/main/main.ts'], packageJsonDiff: '' });
  assert.equal(decision.skip, true);
});

test('decide: a standalone version bump is redundant — its tag run builds the same tree', () => {
  const packageJsonDiff = '-  "version": "1.1.2",\n+  "version": "1.1.3",';
  const decision = decide({ eventName: 'push', ref: 'refs/heads/main', sha: HEAD, tags: new Map(), changedFiles: ['package.json'], packageJsonDiff });
  assert.equal(decision.skip, true);
});

test('decide: an ordinary main push runs even when it touches package.json', () => {
  const decision = decide({
    eventName: 'push',
    ref: 'refs/heads/main',
    sha: HEAD,
    tags: new Map(),
    changedFiles: ['package.json'],
    packageJsonDiff: '+  "electron-updater": "^6.6.2",',
  });
  assert.equal(decision.skip, false);
});

/* ---- tests on the tag run (skip_tests) ---- */

// What the gate reads back for the tagged commit's parent: the jobs of its
// latest completed main run.
const PARENT_GREEN = {
  jobs: [
    { name: 'build (macos-latest, --mac --arm64 --dir, arm64, mac-arm64)', conclusion: 'success' },
    { name: 'build (macos-15-intel, --mac --x64 --dir, x64, mac)', conclusion: 'success' },
    { name: 'build (windows-signer, --win --x64)', conclusion: 'success' },
    { name: 'gate', conclusion: 'success' },
  ],
};
const TAG_PUSH = {
  eventName: 'push',
  ref: 'refs/tags/v1.1.3',
  sha: HEAD,
  changedFiles: ['package.json'],
  packageJsonDiff: '-  "version": "1.1.2",\n+  "version": "1.1.3",',
};

test('decideTests: a pure version bump whose parent is green on all three platforms skips the tests', () => {
  assert.equal(decideTests({ ...TAG_PUSH, parentRun: PARENT_GREEN }).skip, true);
});

test('decideTests: nothing but a tag push ever skips', () => {
  const mainPush = decideTests({ ...TAG_PUSH, ref: 'refs/heads/main', parentRun: PARENT_GREEN });
  const dispatch = decideTests({ ...TAG_PUSH, eventName: 'workflow_dispatch', parentRun: PARENT_GREEN });
  assert.equal(mainPush.skip, false);
  assert.equal(dispatch.skip, false);
});

test('decideTests: a tagged commit that changes anything but the version keeps the tests', () => {
  const withFix = decideTests({
    ...TAG_PUSH,
    changedFiles: ['package.json', 'src/main/agentGame/runtime.ts'],
    parentRun: PARENT_GREEN,
  });
  assert.equal(withFix.skip, false);
});

test('decideTests: without a completed, green main run for the parent the tests run', () => {
  // No run at all: the API was unreadable, or main never saw that commit.
  assert.match(decideTests({ ...TAG_PUSH, parentRun: null }).reason, /no completed main run/);

  // A main run this gate itself skipped has every build job "skipped", never "success".
  const skippedRun = { jobs: PARENT_GREEN.jobs.map((job) => ({ ...job, conclusion: 'skipped' })) };
  assert.equal(decideTests({ ...TAG_PUSH, parentRun: skippedRun }).skip, false);

  // One platform failed.
  const windowsFailed = {
    jobs: PARENT_GREEN.jobs.map((job) => (job.name.includes('windows') ? { ...job, conclusion: 'failure' } : job)),
  };
  const failed = decideTests({ ...TAG_PUSH, parentRun: windowsFailed });
  assert.equal(failed.skip, false);
  assert.match(failed.reason, /windows-signer[^\n]*: failure/, 'the reason names the platform that was not green');

  // Fewer than three build jobs is not the whole matrix.
  assert.equal(decideTests({ ...TAG_PUSH, parentRun: { jobs: PARENT_GREEN.jobs.slice(0, 2) } }).skip, false);
});
