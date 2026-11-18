// Session-log guard (T-C) — quit flush/verify + startup self-check.
//
// Contract under test:
//   a. path encoding mirrors the persistence backend's on-disk contract
//     (projectKey / encodeSegment) — the guard must find the real files;
//   b. the header-frame invariant: frame 1 must decode to exactly one session
//     header line; 0-byte / header-less / multi-line-frame-1 all fail;
//   c. quit layer: the guard fsyncs and then verifies every active session's
//     artifact, and the cleanup sequence calls it BEFORE closeDshRuntime;
//   d. startup layer: a scan reports constructed 0-byte and header-less
//     samples and leaves their bytes untouched (sha256 before == after);
//   e. hard constraint: the guard never deletes or rewrites a log file — the
//     policy constant says so and the filesystem witnesses it.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

import {
  DSH_SESSION_LOG_GUARD_POLICY,
  dshProjectKey,
  dshSessionDirFor,
  dshSessionLogCandidates,
  encodeDshSessionSegment,
  flushSessionLogArtifact,
  formatSessionLogAuditLine,
  guardActiveSessionLogsAtQuit,
  guardSessionLogAtQuit,
  isDshSessionHeaderLine,
  readFirstSessionLogLine,
  readFirstZstdFrame,
  scanSessionLogsForHeaderInvariant,
} from '../src/main/libs/dshSessionLogGuard.ts';
import { runAppCleanup } from '../src/main/services/appCleanup.ts';

const compressZstd = promisify(zstdCompress);
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const HEADER = {
  type: 'session',
  version: 4,
  id: 'cw-abc123',
  createdAt: 1791066035284,
  cwd: '/Users/someone/idbots/project',
  isSeeded: false,
  delegationDepth: 0,
};

/** The backend's container: frame 1 = exactly the header line, frame 2 = rest. */
async function encodeArtifact(headerLine, restLines = []) {
  const headerFrame = await compressZstd(Buffer.from(`${headerLine}\n`));
  const rest = restLines.join('\n');
  if (rest.length === 0) return Buffer.concat([headerFrame]);
  const bodyFrame = await compressZstd(Buffer.from(`${rest}\n`));
  return Buffer.concat([headerFrame, bodyFrame]);
}

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-guard-'));
  return dir;
}

// ── a. path encoding ──────────────────────────────────────────────────────

test('path encoding mirrors the persistence backend (projectKey + encodeSegment)', () => {
  // Real directory names observed in this host's root.
  assert.equal(
    dshProjectKey('/Users/wufeng/idbots/project/bots/7/2026-10-04'),
    '--Users-wufeng-idbots-project-bots-7-2026-10-04--',
  );
  // A trailing separator collapses into ONE trailing dash, which then sits
  // inside the `--` wrapper — the real root carries a dir ending in `go--`
  // because the recorded cwd had no trailing slash. Pinned verbatim so a
  // future "cleanup" of this encoder cannot silently point the guard at the
  // wrong directory.
  assert.equal(
    dshProjectKey('/Users/wufeng/Documents/deepseek-harness/default-workspace/idbots/oc/go'),
    '--Users-wufeng-Documents-deepseek-harness-default-workspace-idbots-oc-go--',
  );
  assert.equal(
    dshProjectKey('/a/b//c'),
    '--a-b-c--',
    'a separator run collapses to a single dash',
  );
  assert.equal(encodeDshSessionSegment('cw-dcfa9eb6-b8e2-4196-ae27-20d4a08425b8'), 'cw-dcfa9eb6-b8e2-4196-ae27-20d4a08425b8');
  assert.equal(encodeDshSessionSegment('a/b'), 'a~002Fb', 'non-safe code units escape as ~XXXX, safe ones stay verbatim');
  assert.equal(encodeDshSessionSegment('..'), '~002E~002E');
  assert.throws(() => dshProjectKey(''), /empty project path/);
  assert.deepEqual(
    dshSessionDirFor('/root', '/p/q', 'cw-1'),
    path.join('/root', '--p-q--', 'cw-1'),
  );
  assert.deepEqual(
    dshSessionDirFor('/root', null, 'cw-1'),
    path.join('/root', '_no-cwd', 'cw-1'),
    'no-cwd sessions live under _no-cwd',
  );
});

// ── b. header-frame invariant ─────────────────────────────────────────────

test('header-line predicate accepts the real header and rejects lookalikes', () => {
  assert.equal(isDshSessionHeaderLine(JSON.stringify(HEADER)), true);
  assert.equal(isDshSessionHeaderLine('{"type":"session","version":4,"id":"x","createdAt":1}'), true);
  assert.equal(isDshSessionHeaderLine('{"type":"event","version":4,"id":"x","createdAt":1}'), false, 'type must be session');
  assert.equal(isDshSessionHeaderLine('{"type":"session","version":4,"id":"","createdAt":1}'), false, 'empty id');
  assert.equal(isDshSessionHeaderLine('{"type":"session","version":"4","id":"x","createdAt":1}'), false, 'version must be numeric');
  assert.equal(isDshSessionHeaderLine('{"type":"session","version":4,"id":"x","createdAt":null}'), false, 'createdAt must be numeric');
  assert.equal(isDshSessionHeaderLine('not json'), false);
  assert.equal(isDshSessionHeaderLine(''), false);
});

test('0-byte artifact reads as the empty verdict, never as ok', async () => {
  const { verdict, detail } = await readFirstSessionLogLine('session.v4.jsonl.zstd', Buffer.alloc(0));
  assert.equal(verdict, 'empty');
  assert.match(detail, /0-byte/);
});

test('frame-1-only artifact passes; a frame 1 carrying more than the header does not', async () => {
  const dir = tempRoot();
  const good = path.join(dir, 'session.v4.jsonl.zstd');
  await fsp.writeFile(good, await encodeArtifact(JSON.stringify(HEADER), ['{"type":"event"}']));
  const okRead = await readFirstSessionLogLine(good, await fsp.readFile(good));
  assert.equal(okRead.verdict, 'ok');
  assert.match(okRead.detail, /header frame/);

  const badFrame = path.join(dir, 'bad-frame.v4.jsonl.zstd');
  await fsp.writeFile(badFrame, await compressZstd(Buffer.from(`${JSON.stringify(HEADER)}\n{"type":"event"}\n`)));
  const badRead = await readFirstSessionLogLine(badFrame, await fsp.readFile(badFrame));
  assert.equal(badRead.verdict, 'header_not_isolated');
});

test('a header-less zstd artifact (first frame is an event) fails the invariant', async () => {
  const dir = tempRoot();
  const artifact = path.join(dir, 'session.v4.jsonl.zstd');
  await fsp.writeFile(artifact, await encodeArtifact('{"type":"event","id":"e1"}'));
  const read = await readFirstSessionLogLine(artifact, await fsp.readFile(artifact));
  assert.equal(read.verdict, 'missing_header');
});

test('plaintext artifacts are judged the same way', async () => {
  const dir = tempRoot();
  const good = path.join(dir, 'session.v4.jsonl');
  await fsp.writeFile(good, `${JSON.stringify(HEADER)}\n{"type":"event"}\n`);
  assert.equal((await readFirstSessionLogLine(good, await fsp.readFile(good))).verdict, 'ok');

  const bad = path.join(dir, 'bad.v4.jsonl');
  await fsp.writeFile(bad, '{"type":"event"}\n');
  assert.equal((await readFirstSessionLogLine(bad, await fsp.readFile(bad))).verdict, 'missing_header');
});

test('readFirstZstdFrame locates frame 1 without touching the rest', async () => {
  const dir = tempRoot();
  const artifact = path.join(dir, 'session.v4.jsonl.zstd');
  const buffer = await encodeArtifact(JSON.stringify(HEADER), ['{"type":"event-a"}', '{"type":"event-b"}']);
  await fsp.writeFile(artifact, buffer);
  const frame = readFirstZstdFrame(buffer);
  assert.ok(frame);
  assert.ok(frame.length < buffer.length, 'frame 1 is a strict prefix of the artifact');
  assert.equal(frame.toString('hex').slice(0, 8), buffer.toString('hex').slice(0, 8));
  // Truncated bytes must not be mistaken for a frame.
  assert.equal(readFirstZstdFrame(buffer.subarray(0, 4)), null);
});

// ── c. quit layer ─────────────────────────────────────────────────────────

test('quit guard flushes and verifies a healthy artifact, leaving its bytes identical', async () => {
  const dir = tempRoot();
  const artifact = path.join(dir, 'session.v4.jsonl.zstd');
  const bytes = await encodeArtifact(JSON.stringify(HEADER), ['{"type":"event"}']);
  await fsp.writeFile(artifact, bytes);
  const before = sha256(await fsp.readFile(artifact));

  const lines = [];
  const verdict = await guardSessionLogAtQuit(dir, (line) => lines.push(line));
  assert.equal(verdict, 'ok');
  const steps = lines.map((line) => line.step);
  assert.deepEqual(steps, ['quit_flush', 'quit_verify'], 'flush runs before verification');
  assert.equal(lines[0].sizeBytes, bytes.length);
  assert.match(lines[0].detail, /fsync ok/);
  assert.match(lines[1].detail, /header frame/);

  const after = sha256(await fsp.readFile(artifact));
  assert.equal(after, before, 'the guard must not rewrite a single byte');
});

test('quit guard reports a 0-byte artifact as empty and still writes nothing', async () => {
  const dir = tempRoot();
  const artifact = path.join(dir, 'session.v4.jsonl.zstd');
  await fsp.writeFile(artifact, '');
  const lines = [];
  const verdict = await guardSessionLogAtQuit(dir, (line) => lines.push(line));
  assert.equal(verdict, 'empty');
  assert.equal(lines.at(-1).verdict, 'empty');
  assert.equal(await fsp.stat(artifact).then((stat) => stat.size), 0, 'still 0 bytes — never repaired');
});

test('quit guard tolerates a session with no artifact at all and audits it', async () => {
  const dir = tempRoot();
  const lines = [];
  const verdict = await guardSessionLogAtQuit(dir, (line) => lines.push(line));
  assert.equal(verdict, 'absent');
  assert.equal(lines.length, 1);
  assert.match(lines[0].detail, /no session log artifact/);
});

test('quit entry point walks every active target and counts outcomes', async () => {
  const root = tempRoot();
  const cwd = '/Users/wufeng/idbots/project/bots/8/2026-11-18';
  const healthyId = 'cw-healthy';
  const emptyId = 'cw-empty';
  const healthyDir = dshSessionDirFor(root, cwd, healthyId);
  const emptyDir = dshSessionDirFor(root, cwd, emptyId);
  await fsp.mkdir(healthyDir, { recursive: true });
  await fsp.mkdir(emptyDir, { recursive: true });
  await fsp.writeFile(path.join(healthyDir, 'session.v4.jsonl.zstd'), await encodeArtifact(JSON.stringify(HEADER)));
  await fsp.writeFile(path.join(emptyDir, 'session.v4.jsonl.zstd'), '');

  const lines = [];
  const result = await guardActiveSessionLogsAtQuit(
    root,
    [
      { dshSessionId: healthyId, cwd },
      { dshSessionId: emptyId, cwd },
    ],
    (line) => lines.push(line),
  );
  assert.deepEqual(result, { checked: 2, ok: 1, warned: 1 });
  assert.ok(lines.some((line) => line.path === path.join(emptyDir, 'session.v4.jsonl.zstd') && line.verdict === 'empty'));
});

test('flushSessionLogArtifact fsyncs a read-only handle and never creates a file', async () => {
  const dir = tempRoot();
  const missing = path.join(dir, 'nope.log');
  const result = await flushSessionLogArtifact(missing);
  assert.deepEqual(result, { sizeBytes: null, mtimeMs: null, flushed: false, error: null });
  assert.equal(fs.existsSync(missing), false, 'the guard never creates artifacts');
});

// ── c2. cleanup sequence ordering ─────────────────────────────────────────

test('cleanup sequence guards session logs BEFORE the DSH runtime closes', async () => {
  const calls = [];
  const noop = () => {};
  await runAppCleanup({
    destroyTray: noop,
    stopSkillWatching: noop,
    closeMetaidRpcServer: noop,
    stopCoworkSessions: noop,
    flushHotLayerExposures: noop,
    guardSessionLogs: async () => { calls.push('guardSessionLogs'); },
    closeDshRuntime: async () => { calls.push('closeDshRuntime'); },
    stopOpenAICompatProxy: async () => {},
    stopSkillServices: async () => {},
    stopIMGateways: async () => {},
    stopScheduler: noop,
    stopCognitiveOrchestrator: noop,
    stopDreamService: noop,
    stopProviderDiscovery: noop,
    deactivateGroupChatTasks: noop,
    log: () => {},
    error: () => {},
  });
  const guardAt = calls.indexOf('guardSessionLogs');
  const closeAt = calls.indexOf('closeDshRuntime');
  assert.ok(guardAt >= 0, 'the guard runs on every quit');
  assert.ok(closeAt > guardAt, 'flush+verify must precede the runtime drain');
});

test('a failing quit guard never blocks the rest of the cleanup', async () => {
  const calls = [];
  const noop = () => {};
  await runAppCleanup({
    destroyTray: noop,
    stopSkillWatching: noop,
    closeMetaidRpcServer: noop,
    stopCoworkSessions: noop,
    guardSessionLogs: async () => { throw new Error('fsync exploded'); },
    closeDshRuntime: async () => { calls.push('closeDshRuntime'); },
    stopOpenAICompatProxy: async () => {},
    stopSkillServices: async () => {},
    stopIMGateways: async () => {},
    stopScheduler: noop,
    stopCognitiveOrchestrator: noop,
    stopDreamService: noop,
    stopProviderDiscovery: noop,
    deactivateGroupChatTasks: noop,
    log: () => {},
    error: () => { calls.push('error-logged'); },
  });
  assert.ok(calls.includes('error-logged'), 'a guard failure is logged, not thrown');
  assert.ok(calls.includes('closeDshRuntime'), 'the quit sequence continues');
});

// ── d. startup self-check ─────────────────────────────────────────────────

test('startup scan reports 0-byte and header-less samples and leaves their bytes identical', async () => {
  const root = tempRoot();
  const cwd = '/Users/wufeng/idbots/project/bots/9/2026-10-19';
  const projectDir = path.join(root, dshProjectKey(cwd));
  const healthyDir = path.join(projectDir, encodeDshSessionSegment('cw-good'));
  const zeroDir = path.join(projectDir, encodeDshSessionSegment('cw-zero'));
  const noHeaderDir = path.join(projectDir, encodeDshSessionSegment('cw-noheader'));
  for (const dir of [healthyDir, zeroDir, noHeaderDir]) await fsp.mkdir(dir, { recursive: true });

  const healthyBytes = await encodeArtifact(JSON.stringify(HEADER), ['{"type":"event"}']);
  await fsp.writeFile(path.join(healthyDir, 'session.v4.jsonl.zstd'), healthyBytes);
  await fsp.writeFile(path.join(zeroDir, 'session.v4.jsonl.zstd'), '');
  const noHeaderBytes = await encodeArtifact('{"type":"event","id":"orphan"}');
  await fsp.writeFile(path.join(noHeaderDir, 'session.v4.jsonl.zstd'), noHeaderBytes);

  // sha256 snapshots of every constructed sample BEFORE the scan.
  const samplePaths = [
    path.join(healthyDir, 'session.v4.jsonl.zstd'),
    path.join(zeroDir, 'session.v4.jsonl.zstd'),
    path.join(noHeaderDir, 'session.v4.jsonl.zstd'),
  ];
  const before = new Map();
  for (const sample of samplePaths) before.set(sample, sha256(await fsp.readFile(sample)));

  const result = await scanSessionLogsForHeaderInvariant({ sessionRoot: root });
  assert.equal(result.scanned, 3);
  assert.equal(result.ok, 1, 'only the healthy artifact passes');
  assert.equal(result.problems.length, 2, 'the 0-byte and the header-less sample are reported');
  const verdicts = result.problems.map((p) => p.verdict).sort();
  assert.deepEqual(verdicts, ['empty', 'missing_header']);
  for (const problem of result.problems) {
    assert.equal(typeof problem.sizeBytes, 'number', 'size is reported');
    assert.equal(typeof problem.mtimeMs, 'number', 'mtime is reported');
  }
  const zeroProblem = result.problems.find((p) => p.verdict === 'empty');
  assert.equal(zeroProblem.sizeBytes, 0);

  // Hard constraint: the scan changed nothing.
  for (const sample of samplePaths) {
    assert.equal(sha256(await fsp.readFile(sample)), before.get(sample), `bytes unchanged: ${path.basename(path.dirname(sample))}`);
    assert.equal(fs.existsSync(sample), true, 'no sample was deleted');
  }
});

test('startup scan of a missing root is a silent no-op', async () => {
  const result = await scanSessionLogsForHeaderInvariant({ sessionRoot: path.join(tempRoot(), 'does-not-exist') });
  assert.deepEqual(result, { scanned: 0, ok: 0, problems: [], truncated: false });
});

test('startup scan honours the artifact cap instead of walking an unbounded root', async () => {
  const root = tempRoot();
  const projectDir = path.join(root, '--cap--');
  for (let i = 0; i < 5; i += 1) {
    const dir = path.join(projectDir, `cw-${i}`);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), '');
  }
  const capped = await scanSessionLogsForHeaderInvariant({ sessionRoot: root, maxArtifacts: 2, maxReported: 1 });
  assert.equal(capped.scanned, 2);
  assert.equal(capped.truncated, true);
  assert.equal(capped.problems.length, 1, 'report is capped separately from the walk');
});

// ── e. policy ─────────────────────────────────────────────────────────────

test('startup scan walks newest-first so the capped walk reaches recent artifacts', async () => {
  const root = tempRoot();
  // Three project dirs; the OLDEST alphabetically is the one holding the
  // broken artifacts, so an alphabetical cap would miss them. Recency order
  // must surface the broken one first.
  const brokenProject = path.join(root, '--aaa-oldest--');
  const healthyProject = path.join(root, '--zzz-newest--');
  await fsp.mkdir(path.join(brokenProject, 'cw-broken'), { recursive: true });
  await fsp.mkdir(path.join(healthyProject, 'cw-healthy'), { recursive: true });
  await fsp.writeFile(path.join(brokenProject, 'cw-broken', 'session.v4.jsonl.zstd'), '');
  await fsp.writeFile(path.join(healthyProject, 'cw-healthy', 'session.v4.jsonl.zstd'), await encodeArtifact(JSON.stringify(HEADER)));

  const old = new Date('2026-10-19T04:34:00Z');
  const recent = new Date('2026-11-18T22:00:00Z');
  await fsp.utimes(path.join(healthyProject, 'cw-healthy'), recent, recent);
  await fsp.utimes(healthyProject, recent, recent);
  await fsp.utimes(path.join(brokenProject, 'cw-broken'), old, old);
  await fsp.utimes(brokenProject, old, old);

  // Cap of 1 artifact covers exactly the newest project's log; the older
  // broken one is correctly out of that window.
  const recentWindow = await scanSessionLogsForHeaderInvariant({ sessionRoot: root, maxArtifacts: 1 });
  assert.equal(recentWindow.scanned, 1);
  assert.equal(recentWindow.problems.length, 0, 'the recent window is clean here');

  // Pin the ordering itself: with the timestamps flipped, the broken artifact
  // becomes the most recent and MUST be the one the capped scan reports.
  await fsp.utimes(path.join(brokenProject, 'cw-broken'), recent, recent);
  await fsp.utimes(brokenProject, recent, recent);
  await fsp.utimes(path.join(healthyProject, 'cw-healthy'), old, old);
  await fsp.utimes(healthyProject, old, old);
  const flipped = await scanSessionLogsForHeaderInvariant({ sessionRoot: root, maxArtifacts: 1 });
  assert.equal(flipped.problems.length, 1, 'the newest artifact is the one the cap reaches');
  assert.match(flipped.problems[0].path, /--aaa-oldest--/, 'recency, not alphabetical order, decides the window');
});

test('the guard policy forbids deleting and rewriting by declaration', () => {
  assert.equal(DSH_SESSION_LOG_GUARD_POLICY.mayFlush, true);
  assert.equal(DSH_SESSION_LOG_GUARD_POLICY.mayDelete, false);
  assert.equal(DSH_SESSION_LOG_GUARD_POLICY.mayRewrite, false);
});

test('audit lines carry path, verdict, size and mtime', () => {
  const line = formatSessionLogAuditLine({
    step: 'startup_scan',
    path: '/root/x/session.v4.jsonl.zstd',
    verdict: 'empty',
    sizeBytes: 0,
    mtimeMs: Date.parse('2026-10-19T04:34:00Z'),
    detail: '0-byte artifact',
  });
  assert.match(line, /\[SessionLogGuard\] startup_scan \/root\/x\/session.v4.jsonl.zstd/);
  assert.match(line, /verdict=empty/);
  assert.match(line, /size=0/);
  assert.match(line, /mtime=2026-10-19T04:34:00\.000Z/);
  assert.match(line, /0-byte artifact/);
});

test('candidate artifacts prefer the zstd generation over the plaintext one', () => {
  assert.deepEqual(
    dshSessionLogCandidates('/root/--p--/cw-1'),
    ['/root/--p--/cw-1/session.v4.jsonl.zstd', '/root/--p--/cw-1/session.v4.jsonl'],
  );
});
