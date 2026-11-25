import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsRemoteTags, isReleaseTagged, isPureVersionBump, decide } from '../scripts/ci-gate.mjs';

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
