#!/usr/bin/env node
/**
 * Bring the self-hosted Windows workspace to the commit a run is for, from
 * files a hosted runner hands over.
 *
 * The failure class this closes: the signing machine's route to github.com:443
 * resets connections. Its checkout step failed on v0.9.6, v0.9.7, v0.9.8,
 * v1.0.9, v1.1.0 and three times on v1.1.3 (2026-11-25), where the forced
 * re-clone alone took 107 minutes; the release SOP had carried "prevention
 * pending" since 2026-09-28. So a hosted runner, with a good route, takes the
 * commit and hands it over, and this script is the only thing the Windows job
 * runs to get its source. It travels inside the artifacts because the
 * workspace it restores has no scripts in it at that point.
 *
 * The machine's downloads from GitHub's artifact storage are slow, though its
 * uploads are fast: the first run with a full bundle (2026-11-26) spent 15
 * minutes on 36 MB. So the hosted runner hands over two things and the small
 * one is tried first:
 *   - the delta, a pack of what the commit reaches beyond its first parent:
 *     tens of KB to about a megabyte, measured. It fits a workspace that
 *     already holds that parent,
 *     which is what the previous run left behind. The working files are still
 *     deleted and checked out anew, so no file of an earlier run survives, and
 *     nothing in the workspace is touched before the pack is in and the whole
 *     tree to be checked out is proven to be there.
 *   - the full commit, as a bundle: everything inside the workspace, `.git`
 *     included, is deleted and cloned anew.
 * Either way the result is a snapshot of one commit: the tree is byte-exact
 * whatever the machine's global git config says (Git for Windows defaults to
 * core.autocrlf=true, the root of the stale-CRLF family in SOP §11.22 and
 * §11.43), the restored commit is compared with the commit the run is for, and
 * the object store is pruned to about one tree.
 *
 * Usage: node ci-source-restore.cjs [--workspace <dir>] [--commit <sha>]
 *          [--branch <name>] [--source <file>] [--fresh]
 * Without --fresh the workspace is updated from the delta pack; with --fresh
 * it is rebuilt from the full bundle. The source defaults to source.pack, or
 * with --fresh source.bundle, next to this script. The other defaults are
 * GITHUB_WORKSPACE, GITHUB_SHA and no branch (a tag checkout is detached, as
 * actions/checkout leaves it).
 * Exit codes: 0 = restored and verified;
 *            3 = the delta does not fit the workspace, which was not changed
 *                — the job rebuilds from the full bundle instead;
 *            1 = not restored (the job must stop); 64 = unknown argument.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXIT_NOT_APPLICABLE = 3;

/** The delta does not fit the workspace, which was left as it was. */
class SourceNotApplicable extends Error {}

// What a byte-exact, Windows-safe checkout needs. Written into the repository
// itself, so every later git call in the job sees the same thing instead of
// the machine's global config.
const CHECKOUT_SETTINGS = [
  ['core.autocrlf', 'false'],
  ['core.longpaths', 'true'],
  ['core.symlinks', 'false'],
];

function git(args, { cwd, env, input } = {}) {
  const result = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`could not start git: ${result.error.message}`);
  return result;
}

function describeFailure(args, result) {
  return `git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim().slice(0, 500)}`;
}

function mustGit(args, options) {
  const result = git(args, options);
  if (result.status !== 0) throw new Error(describeFailure(args, result));
  return result.stdout.trim();
}

/**
 * Delete what is inside dir — not dir itself: it is the job's working
 * directory and stays in use. Read-only files (git objects) are removed too.
 */
function emptyDirectory(dir, { keep = [] } = {}) {
  const kept = new Set(keep);
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (kept.has(entry.name)) continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    removed += 1;
  }
  return removed;
}

/** True when the workspace holds a git repository that answers for a HEAD. */
function hasRepository(workspace, env) {
  if (!fs.existsSync(path.join(workspace, '.git'))) return false;
  return git(['rev-parse', '--verify', 'HEAD'], { cwd: workspace, env }).status === 0;
}

/**
 * Move a workspace that already holds the first parent's tree to the commit
 * in `pack`. Nothing outside `.git` is touched until the pack is in and the
 * tree about to be checked out is proven complete, so a refusal leaves the
 * workspace as it was.
 * @returns {number} top-level entries removed
 */
function updateInPlace({ workspace, pack, commit, branch, env }) {
  const options = { cwd: workspace, env };
  const step = (args, input) => {
    const result = git(args, { ...options, input });
    if (result.status !== 0) throw new SourceNotApplicable(describeFailure(args, result));
    return result.stdout.trim();
  };

  // --replace-all, because the key may already hold more than one value: on
  // Windows git writes core.symlinks=false itself where the machine cannot
  // create symlinks, and the clone adds the same setting again. A plain
  // `git config key value` refuses to overwrite that and exits 5 — which is
  // how the update failed on its first time on the signing machine (run
  // 45888882259): every delta would have given way to the full bundle.
  for (const [key, value] of CHECKOUT_SETTINGS) mustGit(['config', '--replace-all', key, value], options);
  // 1. Add the pack's objects; this only ever adds. The pack is cut without
  //    --thin, so it carries every delta base of its own and declares no
  //    prerequisites: it counts on the rest of the tree being here from the
  //    previous run, which only the next step can tell.
  step(['index-pack', '--stdin'], fs.readFileSync(pack));
  // 2. Every object of the tree about to be checked out is here.
  step(['rev-list', '--objects', '--missing=error', `${commit}^{tree}`]);

  // From here on the tree is replaced.
  const removed = emptyDirectory(workspace, { keep: ['.git'] });
  mustGit(['checkout', '--quiet', '--force', ...(branch ? ['-B', branch] : ['--detach']), commit], options);
  return removed;
}

/** Delete the workspace content, `.git` included, and clone `bundle` into it. */
function rebuildFromNothing({ workspace, bundle, branch, env }) {
  const removed = emptyDirectory(workspace);
  const options = { cwd: workspace, env };
  mustGit(['clone', '--quiet', ...CHECKOUT_SETTINGS.flatMap(([key, value]) => ['--config', `${key}=${value}`]), bundle, workspace], options);
  if (branch) mustGit(['checkout', '--quiet', '-b', branch], options);
  return { removed };
}

/**
 * Make the repository a snapshot of one commit, whatever came along: with HEAD
 * as the shallow boundary nothing behind it is reachable — by git here or by
 * the prune — however many parents it has, and what only earlier commits
 * reached is dropped, so the store stays about one tree large.
 */
function snapshot(workspace, env, log) {
  const options = { cwd: workspace, env };
  fs.writeFileSync(path.join(workspace, '.git', 'shallow'), `${mustGit(['rev-parse', 'HEAD'], options)}\n`);
  // Best effort: a prune that fails costs disk, never correctness.
  git(['reflog', 'expire', '--expire=now', '--all'], options);
  const result = git(['gc', '--prune=now', '--quiet'], options);
  if (result.status !== 0) log(`[ci-source-restore] could not prune the object store (ignored): ${(result.stderr || '').trim().slice(0, 200)}`);
}

/**
 * @returns {{ commit: string, files: number, removed: number, mode: 'updated' | 'rebuilt' }}
 */
function restore({ workspace, source, commit, branch, fresh = false, env = process.env, log = console.log }) {
  if (!workspace) throw new Error('no workspace: pass --workspace or run under GITHUB_WORKSPACE');
  fs.mkdirSync(workspace, { recursive: true });
  if (!source) throw new Error('no source: pass --source, or put it next to this script');
  if (!fresh && !commit) throw new Error('no commit: pass --commit or run under GITHUB_SHA');
  if (!fs.existsSync(source)) throw new Error(`source not found: ${source}`);

  let mode;
  let removed;
  if (fresh) {
    mode = 'rebuilt';
    ({ removed } = rebuildFromNothing({ workspace, bundle: source, branch, env }));
  } else if (hasRepository(workspace, env)) {
    mode = 'updated';
    removed = updateInPlace({ workspace, pack: source, commit, branch, env });
  } else {
    throw new SourceNotApplicable('the workspace holds no repository to update; it has to be rebuilt from the full bundle');
  }
  snapshot(workspace, env, log);

  const options = { cwd: workspace, env };
  const head = mustGit(['rev-parse', 'HEAD'], options);
  if (commit && head !== commit) {
    throw new Error(`restored commit ${head} is not the commit this run is for (${commit})`);
  }
  const dirty = mustGit(['status', '--porcelain'], options);
  if (dirty) throw new Error(`the restored tree is not clean:\n${dirty.slice(0, 500)}`);
  const files = mustGit(['ls-files'], options).split('\n').length;
  log(`[ci-source-restore] ${mode === 'updated' ? 'updated in place' : 'rebuilt'} to ${head.slice(0, 9)} (${files} files, ${branch || 'detached HEAD'}) from ${source}; removed ${removed} top-level entry/entries`);
  return { commit: head, files, removed, mode };
}

const OPTIONS = { '--workspace': 'workspace', '--source': 'source', '--commit': 'commit', '--branch': 'branch' };

function parseArgs(argv) {
  const options = { fresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--fresh') {
      options.fresh = true;
      continue;
    }
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
      source: args.source ?? path.join(__dirname, args.fresh ? 'source.bundle' : 'source.pack'),
      commit: args.commit ?? process.env.GITHUB_SHA,
      branch: args.branch,
      fresh: args.fresh,
    });
  } catch (error) {
    console.error(`✗ ci-source-restore: ${error instanceof Error ? error.message : error}`);
    process.exit(error instanceof SourceNotApplicable ? EXIT_NOT_APPLICABLE : 1);
  }
}

module.exports = { restore, emptyDirectory, SourceNotApplicable, EXIT_NOT_APPLICABLE };
