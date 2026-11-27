import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restore, SourceNotApplicable, SourceDamaged, EXIT_NOT_APPLICABLE, EXIT_DAMAGED } = require('../scripts/ci-source-restore.cjs');
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/ci-source-restore.cjs');
const canSymlink = process.platform !== 'win32';

// git's own words travel with a failure: a test that dies on a CI runner has
// to say why, where nobody can rerun it by hand.
const git = (cwd, args, env = process.env) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed:\n${error.stderr}`);
  }
};
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/**
 * A small repository with the history the pipeline deals with, and the two
 * artifacts a hosted runner hands over for a commit of it.
 *
 *   first ── second ── third ── merge
 *              \ side ──────────/
 *
 * Every commit has a tag, so a clone can be made with any of them as HEAD.
 */
function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-restore-'));
  // Leftover temp dirs are harmless and OS-swept; never let cleanup fail a test.
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  git(source, ['init', '-q', '-b', 'main']);
  // The identity belongs to the repository, not to the machine running the
  // test: `git merge` insists on one even with --no-commit, and a CI runner
  // has none. Carried only on `git commit`, this passed wherever the
  // developer had a global identity and failed the gate job of main
  // (2026-11-27), taking every build of the push with it.
  git(source, ['config', 'user.name', 't']);
  git(source, ['config', 'user.email', 't@invalid']);
  const commit = (message) => git(source, ['commit', '-q', '-m', message]);
  const remove = (file) => {
    git(source, ['rm', '-q', '--cached', file]);
    fs.rmSync(path.join(source, file));
  };

  write(path.join(source, 'base.txt'), 'a\nb\n');
  write(path.join(source, 'keep.txt'), 'deleted in the second commit\n');
  // Its blob is in the first commit, goes away in the second and comes back in the third.
  write(path.join(source, 'x.txt'), 'the same blob comes back\n');
  if (canSymlink) fs.symlinkSync('dist-electron/main/libs', path.join(source, 'libs'), 'file');
  git(source, ['add', '-A']);
  commit('first');
  git(source, ['tag', 'first']);

  write(path.join(source, 'base.txt'), 'a\nB\nc\n');
  remove('keep.txt');
  remove('x.txt');
  write(path.join(source, 'new.txt'), 'new\n');
  write(path.join(source, 'a', 'b', 'c', 'deep.txt'), 'deep\n');
  git(source, ['add', '-A']);
  commit('second');
  git(source, ['tag', 'second']);

  git(source, ['checkout', '-q', '-b', 'side']);
  write(path.join(source, 'side.txt'), 'from the other parent\n');
  git(source, ['add', '-A']);
  commit('side');
  git(source, ['tag', 'side']);

  git(source, ['checkout', '-q', 'main']);
  write(path.join(source, 'base.txt'), 'a\nB\nc\nd\n');
  write(path.join(source, 'x.txt'), 'the same blob comes back\n');
  remove('new.txt');
  write(path.join(source, 'a', 'b', 'c', 'd', 'e', 'deeper.txt'), 'deeper\n');
  git(source, ['add', '-A']);
  commit('third');
  git(source, ['tag', 'third']);

  // The merge commit itself resolves base.txt its own way, so its tree differs from both parents.
  git(source, ['merge', '-q', '--no-ff', '--no-commit', 'side']);
  write(path.join(source, 'base.txt'), 'a\nB\nc\nd\nresolved in the merge\n');
  git(source, ['add', '-A']);
  commit('merge');
  git(source, ['tag', 'merge']);

  const head = (tag) => git(source, ['rev-parse', `${tag}^{commit}`]);

  let serial = 0;
  /**
   * What the hosted job sends for the commit a tag points to: the full commit
   * as a bundle, and the delta since its first parent as a pack — cut from a
   * clone `depth` commits deep, as actions/checkout leaves it. The delta is
   * only there when the clone is deep enough to hold that parent.
   */
  const bundles = (tag, depth = 2) => {
    serial += 1;
    const hosted = path.join(dir, `hosted-${serial}`);
    const shallow = depth > 0 ? ['--depth', String(depth)] : [];
    git(dir, ['clone', '--quiet', ...shallow, '--branch', tag, pathToFileURL(source).href, hosted]);
    const artifact = (name, produce) => {
      const out = path.join(dir, `artifact-${serial}-${name}`);
      fs.mkdirSync(out);
      produce(out);
      fs.copyFileSync(SCRIPT, path.join(out, 'ci-source-restore.cjs'));
      return out;
    };
    return {
      full: artifact('full', (out) => git(hosted, ['bundle', 'create', path.join(out, 'source.bundle'), 'HEAD'])),
      delta:
        depth !== 1 &&
        artifact('delta', (out) => {
          const objects = git(hosted, ['rev-list', '--objects', 'HEAD', '^HEAD^1']);
          fs.writeFileSync(
            path.join(out, 'source.pack'),
            execFileSync('git', ['pack-objects', '--stdout'], { cwd: hosted, input: `${objects}\n`, stdio: ['pipe', 'pipe', 'ignore'] }),
          );
        }),
    };
  };

  // A machine whose global git config rewrites line endings, like the signing machine.
  const hostileConfig = path.join(dir, 'gitconfig');
  write(hostileConfig, '[core]\n\tautocrlf = true\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: hostileConfig, GIT_CONFIG_NOSYSTEM: '1' };

  /** The workspace as the previous run left it: build output and dependencies everywhere. */
  const leftovers = (workspace) => {
    write(path.join(workspace, 'dist-electron', 'main.js'), 'stale build output\n');
    write(path.join(workspace, '.worktrees', 'x', 'y', 'z.txt'), 'stale\n');
    const readOnly = path.join(workspace, 'node_modules', 'pkg', 'lib', 'a', 'b', 'c.js');
    write(readOnly, 'read-only, like a git object\n');
    fs.chmodSync(readOnly, 0o444);
  };
  const nothingLeft = (workspace) => {
    for (const stale of ['dist-electron', '.worktrees', 'node_modules']) {
      assert.equal(fs.existsSync(path.join(workspace, stale)), false, `${stale} must be gone`);
    }
  };
  /** What the Windows job runs for a commit of the fixture. */
  const restoreCommit = (workspace, artifact, tag, options = {}) =>
    restore({
      workspace,
      source: path.join(artifact, fs.existsSync(path.join(artifact, 'source.pack')) ? 'source.pack' : 'source.bundle'),
      commit: tag ? head(tag) : undefined,
      env,
      log: () => {},
      ...options,
    });

  return { dir, source, head, bundles, env, leftovers, nothingLeft, restoreCommit };
}

test('a workspace without a repository is rebuilt from the full bundle, byte for byte', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  write(path.join(workspace, 'stale-tracked.txt'), 'from an earlier run\n');
  fixture.leftovers(workspace);

  const result = fixture.restoreCommit(workspace, fixture.bundles('third').full, 'third', { fresh: true });

  assert.equal(result.mode, 'rebuilt');
  assert.equal(result.commit, fixture.head('third'));
  // Nothing of the previous run survives: tracked, ignored or nested.
  fixture.nothingLeft(workspace);
  assert.equal(fs.existsSync(path.join(workspace, 'stale-tracked.txt')), false);
  // The tree is exactly the commit: LF stays LF although the global config says otherwise.
  assert.equal(fs.readFileSync(path.join(workspace, 'base.txt'), 'utf8'), 'a\nB\nc\nd\n');
  assert.equal(fs.existsSync(path.join(workspace, 'keep.txt')), false, 'a file an earlier commit deleted is not resurrected');
  assert.equal(fs.existsSync(path.join(workspace, 'new.txt')), false, 'a file the commit deleted is not resurrected');
  assert.equal(fs.readFileSync(path.join(workspace, 'a', 'b', 'c', 'd', 'e', 'deeper.txt'), 'utf8'), 'deeper\n');
  assert.equal(result.files, canSymlink ? 5 : 4);
  // git sees a consistent, clean, shallow repository.
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
  assert.equal(git(workspace, ['fsck', '--no-dangling'], fixture.env), '');
  // The repository carries its own checkout settings, so later git calls do
  // not fall back to the machine's global config.
  assert.equal(git(workspace, ['config', 'core.autocrlf'], fixture.env), 'false');
  assert.equal(git(workspace, ['config', 'core.symlinks'], fixture.env), 'false');
  if (canSymlink) {
    // The repo's one symlink lands as a plain file holding the link text, as on any Windows checkout.
    const libs = path.join(workspace, 'libs');
    assert.equal(fs.lstatSync(libs).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(libs, 'utf8'), 'dist-electron/main/libs');
  }
});

test('the repository is a snapshot of the one commit, whatever the bundle carried along', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  // A checkout two commits deep hands the first parent over along with the commit.
  fixture.restoreCommit(workspace, fixture.bundles('third').full, 'third', { fresh: true });

  assert.equal(git(workspace, ['rev-list', '--count', 'HEAD'], fixture.env), '1');
  assert.equal(fs.readFileSync(path.join(workspace, '.git', 'shallow'), 'utf8').trim(), fixture.head('third'));
  // What only the earlier commits reached is not kept around.
  const gone = (spec) =>
    spawnSync('git', ['cat-file', '-e', git(fixture.source, ['rev-parse', spec])], { cwd: workspace, env: fixture.env }).status !== 0;
  assert.equal(gone('second:new.txt'), true, 'a file only the previous commit had');
  assert.equal(gone('first:keep.txt'), true, 'a file only an ancestor had');
});

test('the delta carries a workspace on the previous commit to the new one, and no file of the earlier run survives', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  fixture.restoreCommit(workspace, fixture.bundles('second').full, 'second', { fresh: true });
  fixture.leftovers(workspace);

  const { full, delta } = fixture.bundles('third');
  assert.ok(fs.statSync(path.join(delta, 'source.pack')).size < fs.statSync(path.join(full, 'source.bundle')).size, 'the delta is the smaller one');
  const result = fixture.restoreCommit(workspace, delta, 'third', { branch: 'main' });

  assert.equal(result.mode, 'updated');
  assert.equal(result.commit, fixture.head('third'));
  assert.ok(result.removed >= 4, `removed ${result.removed} top-level entries`);
  fixture.nothingLeft(workspace);
  // The tree is exactly the new commit, including what changed against the first parent.
  assert.equal(fs.readFileSync(path.join(workspace, 'base.txt'), 'utf8'), 'a\nB\nc\nd\n');
  assert.equal(fs.readFileSync(path.join(workspace, 'x.txt'), 'utf8'), 'the same blob comes back\n');
  assert.equal(fs.existsSync(path.join(workspace, 'new.txt')), false, 'a file the commit deleted is not resurrected');
  assert.equal(fs.existsSync(path.join(workspace, 'keep.txt')), false, 'a file an earlier commit deleted is not resurrected');
  assert.equal(fs.readFileSync(path.join(workspace, 'a', 'b', 'c', 'deep.txt'), 'utf8'), 'deep\n');
  assert.equal(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], fixture.env), 'main');
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
  assert.equal(git(workspace, ['fsck', '--no-dangling'], fixture.env), '');
  assert.equal(git(workspace, ['config', 'core.autocrlf'], fixture.env), 'false');
  // One commit, and about one tree: what only the previous commit reached is gone.
  assert.equal(git(workspace, ['rev-list', '--count', 'HEAD'], fixture.env), '1');
  assert.equal(fs.readFileSync(path.join(workspace, '.git', 'shallow'), 'utf8').trim(), fixture.head('third'));
  const secondOnly = git(fixture.source, ['rev-parse', 'second:new.txt']);
  assert.equal(spawnSync('git', ['cat-file', '-e', secondOnly], { cwd: workspace, env: fixture.env }).status !== 0, true);
});

test('a merge commit arrives by delta too', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  fixture.restoreCommit(workspace, fixture.bundles('third').full, 'third', { branch: 'main', fresh: true });

  const result = fixture.restoreCommit(workspace, fixture.bundles('merge').delta, 'merge', { branch: 'main' });

  assert.equal(result.mode, 'updated');
  assert.equal(result.commit, fixture.head('merge'));
  // The tree carries both parents: the merge resolution and the other parent's file.
  assert.equal(fs.readFileSync(path.join(workspace, 'base.txt'), 'utf8'), 'a\nB\nc\nd\nresolved in the merge\n');
  assert.equal(fs.readFileSync(path.join(workspace, 'side.txt'), 'utf8'), 'from the other parent\n');
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
  assert.equal(git(workspace, ['fsck', '--no-dangling'], fixture.env), '');
  assert.equal(git(workspace, ['rev-list', '--count', 'HEAD'], fixture.env), '1');
});

test('the update pins the checkout settings even where the clone left one of them with two values', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  fixture.restoreCommit(workspace, fixture.bundles('second').full, 'second', { branch: 'main', fresh: true });
  const values = () => git(workspace, ['config', '--get-all', 'core.symlinks'], fixture.env).split('\n').length;
  // Git for Windows writes core.symlinks=false by itself where the machine
  // cannot create symlinks, and the clone's own --config adds the same setting
  // again. A plain `git config` then refuses to overwrite the key: on the
  // signing machine every delta gave way to the full bundle (run 45888882259).
  git(workspace, ['config', '--add', 'core.symlinks', 'false'], fixture.env);
  assert.ok(values() >= 2, `core.symlinks holds ${values()} values`);

  const result = fixture.restoreCommit(workspace, fixture.bundles('third').delta, 'third', { branch: 'main' });

  assert.equal(result.mode, 'updated');
  assert.equal(values(), 1);
  assert.equal(git(workspace, ['config', 'core.symlinks'], fixture.env), 'false');
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
});

test('a workspace that is already on the commit takes the delta again', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  fixture.restoreCommit(workspace, fixture.bundles('third').full, 'third', { fresh: true });
  write(path.join(workspace, 'stale-tracked.txt'), 'from an earlier run\n');

  // What a re-run of the job is up against.
  const result = fixture.restoreCommit(workspace, fixture.bundles('third').delta, 'third');
  assert.equal(result.mode, 'updated');
  assert.equal(fs.existsSync(path.join(workspace, 'stale-tracked.txt')), false);
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
  assert.equal(git(workspace, ['fsck', '--no-dangling'], fixture.env), '');
});

test('a workspace that is not on the previous commit refuses the delta untouched; the full bundle then rebuilds it', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  fixture.restoreCommit(workspace, fixture.bundles('second').full, 'second', { branch: 'main', fresh: true });
  const marker = path.join(workspace, 'left-by-the-earlier-run.txt');
  write(marker, 'still here\n');

  // The delta for the merge commit counts on its first parent, the third commit, which this workspace never saw.
  // The pack itself is sound, so only the check on the tree can tell: that is what refuses.
  assert.throws(
    () => fixture.restoreCommit(workspace, fixture.bundles('merge').delta, 'merge'),
    (error) => error instanceof SourceNotApplicable && /rev-list --objects --missing=error/.test(error.message),
  );
  assert.equal(git(workspace, ['rev-parse', 'HEAD'], fixture.env), fixture.head('second'));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'still here\n');
  assert.equal(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], fixture.env), 'main');
  // The objects it did bring along are no reason to go on: nothing of the tree was replaced.
  assert.equal(fs.existsSync(path.join(workspace, 'base.txt')), true);

  const result = fixture.restoreCommit(workspace, fixture.bundles('merge').full, 'merge', { fresh: true });
  assert.equal(result.mode, 'rebuilt');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
});

test('a delta that arrived cut short is reported as damaged, not as "does not fit", and the workspace is untouched', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  fixture.restoreCommit(workspace, fixture.bundles('second').full, 'second', { branch: 'main', fresh: true });
  const marker = path.join(workspace, 'left-by-the-earlier-run.txt');
  write(marker, 'still here\n');
  const { delta } = fixture.bundles('third');
  const pack = path.join(delta, 'source.pack');
  // What a download that ended early leaves behind (run 46015445714, 2026-11-27).
  fs.writeFileSync(pack, fs.readFileSync(pack).subarray(0, 40));

  // A different answer from a clean decline: the job should fetch the delta again, not give up on it.
  assert.throws(() => fixture.restoreCommit(workspace, delta, 'third', { branch: 'main' }), (error) => error instanceof SourceDamaged && /index-pack/.test(error.message));
  assert.equal(git(workspace, ['rev-parse', 'HEAD'], fixture.env), fixture.head('second'));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'still here\n');
  const run = spawnSync(process.execPath, [path.join(delta, 'ci-source-restore.cjs'), '--workspace', workspace, '--commit', fixture.head('third'), '--branch', 'main'], {
    cwd: fixture.dir,
    env: { ...fixture.env, GITHUB_WORKSPACE: '', GITHUB_SHA: '' },
    encoding: 'utf8',
  });
  assert.equal(run.status, EXIT_DAMAGED, run.stderr);
  // And what is left of the workspace still takes an intact delta afterwards.
  const { delta: intact } = fixture.bundles('third');
  assert.equal(fixture.restoreCommit(workspace, intact, 'third', { branch: 'main' }).mode, 'updated');
});

test('a workspace without a repository refuses the delta and stays as it was', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  write(path.join(workspace, 'stale-tracked.txt'), 'from an earlier run\n');

  assert.throws(
    () => fixture.restoreCommit(workspace, fixture.bundles('third').delta, 'third'),
    (error) => error instanceof SourceNotApplicable && /no repository to update/.test(error.message),
  );
  assert.equal(fs.readFileSync(path.join(workspace, 'stale-tracked.txt'), 'utf8'), 'from an earlier run\n');
});

test('a workspace whose repository lost its objects refuses the delta; the full bundle rebuilds from nothing', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  fixture.restoreCommit(workspace, fixture.bundles('second').full, 'second', { fresh: true });
  write(path.join(workspace, 'left-by-the-earlier-run.txt'), 'still here\n');
  fs.rmSync(path.join(workspace, '.git', 'objects'), { recursive: true, force: true });

  assert.throws(() => fixture.restoreCommit(workspace, fixture.bundles('third').delta, 'third'), SourceNotApplicable);
  assert.equal(fs.existsSync(path.join(workspace, 'left-by-the-earlier-run.txt')), true);

  const result = fixture.restoreCommit(workspace, fixture.bundles('third').full, 'third', { fresh: true });
  assert.equal(result.mode, 'rebuilt');
  assert.equal(fs.existsSync(path.join(workspace, 'left-by-the-earlier-run.txt')), false);
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
  assert.equal(git(workspace, ['fsck', '--no-dangling'], fixture.env), '');
});

test('a commit other than the one the run is for is refused', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');

  assert.throws(() => fixture.restoreCommit(workspace, fixture.bundles('second').full, undefined, { commit: '0'.repeat(40), fresh: true }), /is not the commit this run is for/);
  assert.throws(() => restore({ workspace, source: 'x', log: () => {} }), /no commit/);
});

test('a missing source file is refused before the workspace is touched', (t) => {
  const fixture = makeFixture(t);
  const workspace = path.join(fixture.dir, 'workspace');
  write(path.join(workspace, 'stale-tracked.txt'), 'from an earlier run\n');

  assert.throws(
    () => restore({ workspace, source: path.join(fixture.dir, 'missing.pack'), commit: fixture.head('third'), env: fixture.env, log: () => {} }),
    /source not found/,
  );
  assert.equal(fs.readFileSync(path.join(workspace, 'stale-tracked.txt'), 'utf8'), 'from an earlier run\n');
});

test('--branch puts the restored tree on that branch in either mode; without it the checkout is detached', (t) => {
  const fixture = makeFixture(t);
  const branch = (workspace) => git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], fixture.env);
  const rebuilt = path.join(fixture.dir, 'rebuilt');
  const third = fixture.bundles('third');
  fixture.restoreCommit(rebuilt, third.full, 'third', { branch: 'main', fresh: true });
  assert.equal(branch(rebuilt), 'main');

  const detached = path.join(fixture.dir, 'detached');
  fixture.restoreCommit(detached, third.full, 'third', { fresh: true });
  assert.equal(branch(detached), 'HEAD');

  // An update switches too: a tag checkout (detached) after a branch push, and the other way round.
  const switched = path.join(fixture.dir, 'switched');
  const merge = fixture.bundles('merge');
  fixture.restoreCommit(switched, third.full, 'third', { branch: 'main', fresh: true });
  fixture.restoreCommit(switched, merge.delta, 'merge');
  assert.equal(branch(switched), 'HEAD');
  assert.equal(git(switched, ['status', '--porcelain'], fixture.env), '');
});

test('the command line finds its source next to the script and reports what happened in its exit code', (t) => {
  const fixture = makeFixture(t);
  const second = fixture.bundles('second');
  const third = fixture.bundles('third');
  const run = (artifact, workspace, extra) =>
    spawnSync(process.execPath, [path.join(artifact, 'ci-source-restore.cjs'), '--workspace', workspace, ...extra], {
      cwd: fixture.dir,
      env: { ...fixture.env, GITHUB_WORKSPACE: '', GITHUB_SHA: '' },
      encoding: 'utf8',
    });

  const workspace = path.join(fixture.dir, 'workspace');
  write(path.join(workspace, 'stale-tracked.txt'), 'from an earlier run\n');

  // No repository to update: exit 3 says so, and nothing was touched.
  const notApplicable = run(third.delta, workspace, ['--commit', fixture.head('third')]);
  assert.equal(notApplicable.status, EXIT_NOT_APPLICABLE, notApplicable.stderr);
  assert.match(notApplicable.stderr, /no repository to update/);
  assert.equal(fs.existsSync(path.join(workspace, 'stale-tracked.txt')), true);

  // The full bundle, with --fresh, rebuilds; the delta then updates.
  const rebuilt = run(second.full, workspace, ['--commit', fixture.head('second'), '--fresh']);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(rebuilt.stdout, /rebuilt to [0-9a-f]{9}/);
  assert.equal(fs.existsSync(path.join(workspace, 'stale-tracked.txt')), false);
  const updated = run(third.delta, workspace, ['--commit', fixture.head('third')]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /updated in place to [0-9a-f]{9}/);
  assert.equal(git(workspace, ['rev-parse', 'HEAD'], fixture.env), fixture.head('third'));

  // A commit other than the one the run is for.
  const refused = run(third.full, workspace, ['--commit', 'f'.repeat(40), '--fresh']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not the commit this run is for/);

  const unknown = run(third.full, workspace, ['--force']);
  assert.equal(unknown.status, 64);
});

test('it refuses to guess a workspace or a source', () => {
  assert.throws(() => restore({ workspace: undefined, source: 'x', log: () => {} }), /no workspace/);
  assert.throws(() => restore({ workspace: os.tmpdir(), source: undefined, log: () => {} }), /no source/);
});
