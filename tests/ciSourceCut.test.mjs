import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restore, SourceNotApplicable } = require('../scripts/ci-source-restore.cjs');
const { cut, resolveBase, isSha } = require('../scripts/ci-source-cut.mjs');
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/ci-source-cut.mjs');
const NO_BASE = '0'.repeat(40);
const quiet = { log: () => {} };

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * The whole hand-over, end to end: sessions pushing to one repository, the
 * hosted runner's shallow checkout, the cut, and the signing machine holding
 * a snapshot of one commit — made the way the pipeline makes it.
 */
function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-cut-'));
  // Leftover temp dirs are harmless and OS-swept; never let cleanup fail a test.
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  const origin = path.join(dir, 'origin');
  fs.mkdirSync(origin);
  // The identity lives in each repository: a CI runner has none of its own.
  const init = (repo) => {
    git(repo, ['init', '-q', '-b', 'main']);
    for (const [key, value] of [['user.name', 't'], ['user.email', 't@invalid.invalid'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) {
      git(repo, ['config', key, value]);
    }
  };
  init(origin);
  git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(origin, ['config', 'receive.denyCurrentBranch', 'updateInstead']);
  const url = pathToFileURL(origin).href;
  const write = (repo, relative, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), content);
  };
  const commit = (repo, message) => {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  write(origin, 'base.txt', 'one\n');
  commit(origin, 'first');

  /** A development session: a full clone that commits and pushes to main. */
  const session = (name) => {
    const repo = path.join(dir, name);
    git(dir, ['clone', '--quiet', url, repo]);
    for (const [key, value] of [['user.name', 't'], ['user.email', 't@invalid.invalid'], ['core.autocrlf', 'false']]) git(repo, ['config', key, value]);
    return repo;
  };
  const tip = () => git(origin, ['rev-parse', 'main']);

  /** What actions/checkout leaves on the hosted runner for the current tip. */
  const hosted = () => {
    const repo = path.join(dir, `hosted-${fs.readdirSync(dir).filter((name) => name.startsWith('hosted-')).length + 1}`);
    git(dir, ['clone', '--quiet', '--depth', '2', '--branch', 'main', url, repo]);
    return repo;
  };
  /** What the signing machine holds for a commit: its snapshot, restored from a full bundle the way the pipeline does it. */
  const machineAt = (name, commitSha) => {
    const source = path.join(dir, `machine-source-${name}`);
    fs.mkdirSync(source);
    git(source, ['init', '-q']);
    git(source, ['fetch', '--quiet', '--depth', '1', url, commitSha]);
    git(source, ['checkout', '--quiet', '--detach', commitSha]);
    const bundle = path.join(dir, `machine-base-${name}.bundle`);
    git(source, ['bundle', 'create', bundle, 'HEAD']);
    const workspace = path.join(dir, `machine-${name}`);
    restore({ workspace, source: bundle, commit: commitSha, branch: 'main', ...quiet, fresh: true });
    return workspace;
  };
  /** The hosted runner cutting the delta, as build.yml runs it. */
  const cutOnHosted = (repo, base) => {
    const out = path.join(repo, '..', `delta-${path.basename(repo)}.pack`);
    const args = [SCRIPT, '--out', out];
    if (base !== undefined) args.push('--base', base);
    const run = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
    return { run, out };
  };
  let readers = 0;
  /** The objects a pack holds, read the way the restore tool reads one: indexed into an empty repository. */
  const packObjects = (pack) => {
    const repo = path.join(dir, `pack-reader-${(readers += 1)}`);
    fs.mkdirSync(repo);
    git(repo, ['init', '-q']);
    const indexed = spawnSync('git', ['index-pack', '--stdin'], { cwd: repo, input: fs.readFileSync(pack), encoding: 'utf8' });
    assert.equal(indexed.status, 0, indexed.stderr);
    return git(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n');
  };
  /** Every tree and blob of a commit's tree: what a machine holding that commit already has. */
  const treeObjects = (repo, commitSha) =>
    git(repo, ['ls-tree', '-r', '-t', commitSha])
      .split('\n')
      .map((line) => line.split(/\s+/)[2]);
  const read = (workspace, relative) => fs.readFileSync(path.join(workspace, relative), 'utf8');
  return { dir, origin, url, write, commit, session, tip, hosted, machineAt, cutOnHosted, packObjects, treeObjects, read };
}

test('the delta is cut against the tip main had before the push, which is what the machine holds', (t) => {
  const fixture = makeFixture(t);
  // Two sessions on one repository. One commits on its own line; the other
  // pushes first, so main moves on without it.
  const loner = fixture.session('loner');
  const pusher = fixture.session('pusher');
  fixture.write(loner, 'asset-a.txt', 'from the session that merged later\n');
  fixture.commit(loner, 'own line');
  fixture.write(pusher, 'feature-b.txt', 'pushed first\n');
  const before = fixture.commit(pusher, 'pushed first');
  git(pusher, ['push', '--quiet', 'origin', 'main']);
  // The loner brings main in and pushes the merge: its first parent is the commit the machine never saw.
  git(loner, ['fetch', '--quiet', 'origin']);
  git(loner, ['merge', '--quiet', '--no-ff', '--no-edit', 'origin/main']);
  const merge = git(loner, ['rev-parse', 'HEAD']);
  assert.equal(git(loner, ['rev-parse', 'HEAD^1']) === before, false, 'precondition: the first parent is not the previous tip');
  git(loner, ['push', '--quiet', 'origin', 'main']);
  assert.equal(fixture.tip(), merge);

  const repo = fixture.hosted();
  const { run, out } = fixture.cutOnHosted(repo, before);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`beyond ${before.slice(0, 9)} \\(base\\)`));
  // Nothing the machine already has travels again.
  const carried = fixture.packObjects(out);
  assert.deepEqual(fixture.treeObjects(fixture.origin, before).filter((oid) => carried.includes(oid)), []);

  const workspace = fixture.machineAt('at-the-tip', before);
  assert.equal(fixture.read(workspace, 'base.txt'), 'one\n', 'precondition: the machine is on the previous tip');

  const result = restore({ workspace, source: out, commit: merge, branch: 'main', ...quiet });

  assert.equal(result.mode, 'updated');
  assert.equal(result.commit, merge);
  assert.equal(fixture.read(workspace, 'asset-a.txt'), 'from the session that merged later\n');
  assert.equal(fixture.read(workspace, 'feature-b.txt'), 'pushed first\n');

  // Against the first parent, as the delta used to be cut, it does not fit this machine.
  const firstParent = fixture.cutOnHosted(repo);
  assert.equal(firstParent.run.status, 0, firstParent.run.stderr);
  assert.match(firstParent.run.stdout, /\(first parent\)/);
  assert.throws(
    () => restore({ workspace: fixture.machineAt('at-the-tip-again', before), source: firstParent.out, commit: merge, branch: 'main', ...quiet }),
    SourceNotApplicable,
  );
});

test('several commits pushed at once fit a machine that holds the tip from before them, and carry nothing it already has', (t) => {
  const fixture = makeFixture(t);
  const dev = fixture.session('dev');
  // A directory the push leaves alone: the delta has no business carrying it.
  fixture.write(dev, 'docs/untouched-a.txt', 'a file the push does not touch\n');
  fixture.write(dev, 'docs/untouched-b.txt', 'another one\n');
  const before = fixture.commit(dev, 'a directory the push will leave alone');
  git(dev, ['push', '--quiet', 'origin', 'main']);
  fixture.write(dev, 'only-in-the-first.txt', 'added by the first of two commits, untouched by the second\n');
  fixture.commit(dev, 'first');
  fixture.write(dev, 'added-by-the-second.txt', 'second\n');
  const head = fixture.commit(dev, 'second');
  git(dev, ['push', '--quiet', 'origin', 'main']);
  assert.equal(fixture.tip(), head);

  // The base is three levels back from here, out of the hosted checkout's reach: the cut has to fetch it.
  const repo = fixture.hosted();
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${before}^{commit}`], { cwd: repo }).status, 0, 'precondition: the checkout does not hold the base');
  const { run, out } = fixture.cutOnHosted(repo, before);
  assert.equal(run.status, 0, run.stderr);
  // Fetched at depth one, the base stands beside the history, not in it.
  assert.equal(spawnSync('git', ['merge-base', 'HEAD', before], { cwd: repo }).status, 1, "precondition: the base is nobody's ancestor in the checkout");
  // Two commits, their two root trees, the two new files: nothing else.
  assert.match(run.stdout, /^\[ci-source-cut\] 6 objects, \d+ bytes, beyond [0-9a-f]{9} \(base\)/m);
  const carried = fixture.packObjects(out);
  assert.deepEqual(fixture.treeObjects(fixture.origin, before).filter((oid) => carried.includes(oid)), []);
  for (const relative of ['only-in-the-first.txt', 'added-by-the-second.txt']) {
    assert.ok(carried.includes(git(fixture.origin, ['rev-parse', `HEAD:${relative}`])), `${relative} travels in the delta`);
  }

  const result = restore({ workspace: fixture.machineAt('before-both', before), source: out, commit: head, branch: 'main', ...quiet });

  assert.equal(result.mode, 'updated');
  const workspace = path.join(fixture.dir, 'machine-before-both');
  assert.equal(fixture.read(workspace, 'only-in-the-first.txt'), 'added by the first of two commits, untouched by the second\n');
  assert.equal(fixture.read(workspace, 'added-by-the-second.txt'), 'second\n');
});

test('a tag has no "before": the first parent is the base', (t) => {
  const fixture = makeFixture(t);
  const dev = fixture.session('dev');
  fixture.write(dev, 'before-the-release.txt', 'on main before the release\n');
  const main = fixture.commit(dev, 'last commit before the release');
  git(dev, ['push', '--quiet', 'origin', 'main']);
  fixture.write(dev, 'version.txt', 'v2\n');
  const release = fixture.commit(dev, 'bump');
  git(dev, ['push', '--quiet', 'origin', 'main']);

  const repo = fixture.hosted();
  const { run, out } = fixture.cutOnHosted(repo, NO_BASE);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`beyond ${main.slice(0, 9)} \\(first parent\\)`));
  // The bump's own main run is skipped, so the machine still holds the commit before it.
  const result = restore({ workspace: fixture.machineAt('before-the-bump', main), source: out, commit: release, branch: 'main', ...quiet });
  assert.equal(result.mode, 'updated');
  assert.equal(fixture.read(path.join(fixture.dir, 'machine-before-the-bump'), 'version.txt'), 'v2\n');
});

test('a base that cannot be had is no reason to fail: the first parent is used and the log says so', (t) => {
  const fixture = makeFixture(t);
  const dev = fixture.session('dev');
  fixture.write(dev, 'tip.txt', 'tip\n');
  const main = fixture.commit(dev, 'main tip');
  git(dev, ['push', '--quiet', 'origin', 'main']);
  fixture.write(dev, 'next.txt', 'after\n');
  const head = fixture.commit(dev, 'next');
  git(dev, ['push', '--quiet', 'origin', 'main']);
  const repo = fixture.hosted();

  // A commit that exists nowhere on the remote.
  const nowhere = fixture.cutOnHosted(repo, 'f'.repeat(40));
  assert.equal(nowhere.run.status, 0, nowhere.run.stderr);
  assert.match(nowhere.run.stdout, new RegExp(`beyond ${main.slice(0, 9)} \\(first parent; could not fetch the base`));

  // The commit itself is no base: there is nothing beyond it.
  const itself = fixture.cutOnHosted(repo, head);
  assert.equal(itself.run.status, 0, itself.run.stderr);
  assert.match(itself.run.stdout, /the base is the commit itself/);
  assert.equal(itself.run.status, 0);
  assert.equal(
    restore({ workspace: fixture.machineAt('at-the-tip', main), source: itself.out, commit: head, branch: 'main', ...quiet }).mode,
    'updated',
  );
});

test('the cut is a plain function too, and refuses an empty delta', (t) => {
  const fixture = makeFixture(t);
  const dev = fixture.session('dev');
  fixture.write(dev, 'first.txt', 'first\n');
  const first = fixture.commit(dev, 'first');
  fixture.write(dev, 'second.txt', 'second\n');
  const second = fixture.commit(dev, 'second');
  const out = path.join(fixture.dir, 'hand-cut.pack');
  const result = cut({ cwd: dev, out, base: first, ref: second });
  assert.equal(result.base, first);
  assert.ok(result.objects >= 2 && result.bytes > 0);
  assert.equal(fs.statSync(out).size, result.bytes);
  assert.throws(() => cut({ cwd: dev, out, base: second, ref: second }), /reaches nothing beyond/);
  assert.deepEqual(resolveBase({ cwd: dev, ref: second, wanted: first }), { base: first, used: 'base' });
  assert.equal(resolveBase({ cwd: dev, ref: second, wanted: '' }).used, 'first parent');
  assert.equal(isSha(NO_BASE), true);
  assert.equal(isSha('main'), false);
  // Bad arguments are refused before anything is cut.
  const usage = spawnSync(process.execPath, [SCRIPT, '--out'], { encoding: 'utf8' });
  assert.equal(usage.status, 64);
});
