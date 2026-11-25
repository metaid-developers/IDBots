import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restore } = require('../scripts/ci-source-restore.cjs');
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/ci-source-restore.cjs');
const canSymlink = process.platform !== 'win32';

const git = (cwd, args, env = process.env) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/**
 * The workspace as the hosted job hands it over and as a previous run left
 * it: a bundle cut from a shallow clone (next to a copy of the restore tool,
 * like the artifact), and a workspace full of stale files.
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
  const commit = (message) => git(source, ['-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '-q', '-m', message]);
  write(path.join(source, 'base.txt'), 'a\nb\n');
  write(path.join(source, 'keep.txt'), 'deleted in the second commit\n');
  if (canSymlink) fs.symlinkSync('dist-electron/main/libs', path.join(source, 'libs'), 'file');
  git(source, ['add', '-A']);
  commit('first');
  write(path.join(source, 'base.txt'), 'a\nB\nc\n');
  git(source, ['rm', '-q', '--cached', 'keep.txt']);
  fs.rmSync(path.join(source, 'keep.txt'));
  write(path.join(source, 'new.txt'), 'new\n');
  write(path.join(source, 'a', 'b', 'c', 'deep.txt'), 'deep\n');
  git(source, ['add', '-A']);
  commit('second');
  const head = git(source, ['rev-parse', 'HEAD']);

  const artifact = path.join(dir, 'artifact');
  fs.mkdirSync(artifact);
  const shallow = path.join(dir, 'shallow');
  git(dir, ['clone', '--depth', '1', '-q', pathToFileURL(source).href, shallow]);
  git(shallow, ['bundle', 'create', path.join(artifact, 'source.bundle'), 'HEAD']);
  const fullBundle = path.join(dir, 'full.bundle');
  git(source, ['bundle', 'create', fullBundle, 'HEAD']);
  fs.copyFileSync(SCRIPT, path.join(artifact, 'ci-source-restore.cjs'));

  // A machine whose global git config rewrites line endings, like the signing machine.
  const hostileConfig = path.join(dir, 'gitconfig');
  write(hostileConfig, '[core]\n\tautocrlf = true\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: hostileConfig, GIT_CONFIG_NOSYSTEM: '1' };

  const staleWorkspace = () => {
    const workspace = path.join(dir, 'workspace');
    write(path.join(workspace, 'stale-tracked.txt'), 'from an earlier run\n');
    write(path.join(workspace, 'dist-electron', 'main.js'), 'stale build output\n');
    write(path.join(workspace, '.worktrees', 'x', 'y', 'z.txt'), 'stale\n');
    const readOnly = path.join(workspace, 'node_modules', 'pkg', 'lib', 'a', 'b', 'c.js');
    write(readOnly, 'read-only, like a git object\n');
    fs.chmodSync(readOnly, 0o444);
    return workspace;
  };
  return { dir, artifact, bundle: path.join(artifact, 'source.bundle'), fullBundle, head, env, staleWorkspace };
}

test('the workspace becomes the bundled commit, byte for byte, whatever was in it before', (t) => {
  const fixture = makeFixture(t);
  const workspace = fixture.staleWorkspace();

  const result = restore({ workspace, bundle: fixture.bundle, commit: fixture.head, env: fixture.env, log: () => {} });

  assert.equal(result.commit, fixture.head);
  // Nothing of the previous run survives: tracked, ignored or nested.
  for (const stale of ['stale-tracked.txt', 'dist-electron', '.worktrees', 'node_modules']) {
    assert.equal(fs.existsSync(path.join(workspace, stale)), false, `${stale} must be gone`);
  }
  // The tree is exactly the commit: LF stays LF although the global config says otherwise.
  assert.equal(fs.readFileSync(path.join(workspace, 'base.txt'), 'utf8'), 'a\nB\nc\n');
  assert.equal(fs.existsSync(path.join(workspace, 'keep.txt')), false, 'a file the commit deleted is not resurrected');
  assert.equal(fs.readFileSync(path.join(workspace, 'a', 'b', 'c', 'deep.txt'), 'utf8'), 'deep\n');
  assert.equal(result.files, canSymlink ? 4 : 3);
  // git sees a consistent, clean, shallow repository.
  assert.equal(git(workspace, ['status', '--porcelain'], fixture.env), '');
  assert.equal(git(workspace, ['fsck', '--no-dangling'], fixture.env), '');
  // The repository carries its own checkout settings, so later git calls do
  // not fall back to the machine's global config.
  assert.equal(git(workspace, ['config', 'core.autocrlf'], fixture.env), 'false');
  assert.equal(git(workspace, ['config', 'core.symlinks'], fixture.env), 'false');
  assert.equal(fs.readFileSync(path.join(workspace, '.git', 'shallow'), 'utf8').trim(), fixture.head);
  if (canSymlink) {
    // The repo's one symlink lands as a plain file holding the link text, as on any Windows checkout.
    const libs = path.join(workspace, 'libs');
    assert.equal(fs.lstatSync(libs).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(libs, 'utf8'), 'dist-electron/main/libs');
  }
});

test('a bundle with full history is not marked shallow', (t) => {
  const fixture = makeFixture(t);
  const workspace = fixture.staleWorkspace();

  restore({ workspace, bundle: fixture.fullBundle, commit: fixture.head, env: fixture.env, log: () => {} });

  assert.equal(fs.existsSync(path.join(workspace, '.git', 'shallow')), false);
  assert.equal(git(workspace, ['rev-list', '--count', 'HEAD'], fixture.env), '2');
});

test('a commit other than the one the run is for is refused', (t) => {
  const fixture = makeFixture(t);
  const workspace = fixture.staleWorkspace();

  assert.throws(
    () => restore({ workspace, bundle: fixture.bundle, commit: '0'.repeat(40), env: fixture.env, log: () => {} }),
    /is not the commit this run is for/,
  );
});

test('without a bundle the workspace is left empty rather than stale', (t) => {
  const fixture = makeFixture(t);
  const workspace = fixture.staleWorkspace();

  assert.throws(
    () => restore({ workspace, bundle: path.join(fixture.dir, 'missing.bundle'), commit: fixture.head, env: fixture.env, log: () => {} }),
    /source bundle not found/,
  );
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test('--branch puts the restored tree on that branch; without it the checkout is detached', (t) => {
  const fixture = makeFixture(t);
  const onBranch = fixture.staleWorkspace();
  restore({ workspace: onBranch, bundle: fixture.bundle, commit: fixture.head, branch: 'main', env: fixture.env, log: () => {} });
  assert.equal(git(onBranch, ['rev-parse', '--abbrev-ref', 'HEAD'], fixture.env), 'main');

  const detached = fixture.staleWorkspace();
  restore({ workspace: detached, bundle: fixture.bundle, commit: fixture.head, env: fixture.env, log: () => {} });
  assert.equal(git(detached, ['rev-parse', '--abbrev-ref', 'HEAD'], fixture.env), 'HEAD');
});

test('the command line finds the bundle next to the script and reports failure in its exit code', (t) => {
  const fixture = makeFixture(t);
  const tool = path.join(fixture.artifact, 'ci-source-restore.cjs');
  const run = (workspace, extra) =>
    spawnSync(process.execPath, [tool, '--workspace', workspace, ...extra], {
      cwd: fixture.dir,
      env: { ...fixture.env, GITHUB_WORKSPACE: '', GITHUB_SHA: '' },
      encoding: 'utf8',
    });

  const workspace = fixture.staleWorkspace();
  const ok = run(workspace, ['--commit', fixture.head]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(git(workspace, ['rev-parse', 'HEAD'], fixture.env), fixture.head);
  assert.match(ok.stdout, /restored [0-9a-f]{9}/);

  const refused = run(workspace, ['--commit', 'f'.repeat(40)]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not the commit this run is for/);

  const unknown = run(workspace, ['--force']);
  assert.equal(unknown.status, 64);
});

test('it refuses to guess a workspace', () => {
  assert.throws(() => restore({ workspace: undefined, bundle: 'x', log: () => {} }), /no workspace/);
  assert.ok(fileURLToPath(import.meta.url).length > 0);
});
