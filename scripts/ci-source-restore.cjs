#!/usr/bin/env node
/**
 * Rebuild the self-hosted Windows workspace from a git bundle.
 *
 * The failure class this closes: the signing machine's route to github.com:443
 * resets connections. Its checkout step failed on v0.9.6, v0.9.7, v0.9.8,
 * v1.0.9, v1.1.0 and three times on v1.1.3 (2026-11-25), where the forced
 * re-clone alone took 107 minutes; the release SOP had carried "prevention
 * pending" since 2026-09-28. The machine reaches GitHub's artifact storage
 * without trouble — it uploads every build there — so a hosted runner with a
 * good route now takes the commit and hands it over as a bundle, and this
 * script is the only thing the Windows job runs to get its source. It travels
 * next to the bundle, because the workspace it rebuilds is empty at that point.
 *
 * A restore is always a fresh clone: everything inside the workspace is
 * deleted first. That also ends the stale-tree family for good (SOP §11.22
 * and §11.43: a reused checkout kept CRLF copies that no .gitattributes rule
 * could reach).
 *
 * The clone is told the settings that make a checkout byte-exact instead of
 * trusting the machine's global git config; the restored commit is compared
 * with the commit the run is for; and a bundle made from a shallow clone is
 * marked shallow so git sees a consistent repository.
 *
 * Usage: node ci-source-restore.cjs [--workspace <dir>] [--bundle <file>]
 *          [--commit <sha>] [--branch <name>]
 * Defaults: GITHUB_WORKSPACE, source.bundle next to this script, GITHUB_SHA,
 * no branch (a tag checkout is detached, as actions/checkout leaves it).
 * Exit codes: 0 = restored and verified, 1 = not restored (the job must stop),
 * 64 = unknown argument.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// What a byte-exact, Windows-safe checkout needs. Passed as `clone --config`
// so the new repository keeps them: they take effect before anything is
// checked out, and every later git call in the job sees the same repository
// the signing machine's global config (core.autocrlf=true) would otherwise
// describe differently.
const CHECKOUT_SETTINGS = [
  '--config', 'core.autocrlf=false',
  '--config', 'core.longpaths=true',
  '--config', 'core.symlinks=false',
];

function git(args, { cwd, env } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`could not start git: ${result.error.message}`);
  return result;
}

function mustGit(args, options) {
  const result = git(args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim().slice(0, 500)}`);
  }
  return result.stdout.trim();
}

/**
 * Delete everything inside dir — not dir itself: it is the job's working
 * directory and stays in use. Read-only files (git objects) are removed too.
 */
function emptyDirectory(dir) {
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    removed += 1;
  }
  return removed;
}

const hasParent = (cwd, env) => git(['cat-file', '-e', 'HEAD^'], { cwd, env }).status === 0;

/**
 * Replace the content of `workspace` with the commit stored in `bundle`.
 * @returns {{ commit: string, files: number, removed: number }}
 */
function restore({ workspace, bundle, commit, branch, env = process.env, log = console.log }) {
  if (!workspace) throw new Error('no workspace: pass --workspace or run under GITHUB_WORKSPACE');

  // Clear first: whatever is there is from an earlier run, and a restore
  // that fails below must leave nothing a later step could build from — not
  // even when the bundle never arrived.
  fs.mkdirSync(workspace, { recursive: true });
  const removed = emptyDirectory(workspace);
  log(`[ci-source-restore] cleared ${removed} top-level entry/entries from ${workspace}`);
  if (!fs.existsSync(bundle)) throw new Error(`source bundle not found: ${bundle}`);

  const options = { cwd: workspace, env };
  mustGit(['clone', '--quiet', ...CHECKOUT_SETTINGS, bundle, workspace], options);
  const head = mustGit(['rev-parse', 'HEAD'], options);
  if (commit && head !== commit) {
    throw new Error(`restored commit ${head} is not the commit this run is for (${commit})`);
  }
  // The bundle is cut from a shallow clone: without this git would see a
  // commit whose parent is missing.
  if (!hasParent(workspace, env)) fs.writeFileSync(path.join(workspace, '.git', 'shallow'), `${head}\n`);
  if (branch) mustGit(['checkout', '--quiet', '-b', branch], options);

  const dirty = mustGit(['status', '--porcelain'], options);
  if (dirty) throw new Error(`the restored tree is not clean:\n${dirty.slice(0, 500)}`);
  const files = mustGit(['ls-files'], options).split('\n').length;
  log(`[ci-source-restore] restored ${head.slice(0, 9)} (${files} files, ${branch || 'detached HEAD'}) from ${bundle}`);
  return { commit: head, files, removed };
}

const OPTIONS = { '--workspace': 'workspace', '--bundle': 'bundle', '--commit': 'commit', '--branch': 'branch' };

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = OPTIONS[argv[index]];
    if (!key || argv[index + 1] === undefined) {
      console.error(`ci-source-restore: unknown or incomplete argument ${argv[index]}`);
      process.exit(64);
    }
    options[key] = argv[++index];
  }
  return options;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  try {
    restore({
      workspace: args.workspace ?? process.env.GITHUB_WORKSPACE,
      bundle: args.bundle ?? path.join(__dirname, 'source.bundle'),
      commit: args.commit ?? process.env.GITHUB_SHA,
      branch: args.branch,
    });
  } catch (error) {
    console.error(`✗ ci-source-restore: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

module.exports = { restore, emptyDirectory };
