#!/usr/bin/env node
/**
 * Cut the source delta a hosted runner hands to the signing machine.
 *
 *   node scripts/ci-source-cut.mjs --out <file> [--base <sha>] [--ref <sha>]
 *
 * The delta is what one commit reaches beyond another, as a pack that
 * declares no prerequisites. scripts/ci-source-restore.cjs adds it to the
 * snapshot of that other commit which the signing machine holds, and proves
 * the whole tree of the new commit present before it touches a working file.
 * So a delta cut against the wrong commit costs a download of the full
 * bundle (36 MB on a link that has taken a quarter of an hour over it, and
 * cut it short twice on 2026-11-27); a delta cut against the right one costs
 * a few seconds.
 *
 * Which other commit: the one the machine is most likely to hold. It holds
 * the last commit a Windows job restored, which for a push to main is almost
 * always `github.event.before`, the tip of main before this push:
 *   - a merge made on a checkout that had commits of its own has a first
 *     parent the machine never saw (two sessions merging on one checkout
 *     produce these daily), while `before` is exactly what it holds;
 *   - a push of several commits at once leaves the first of them as the
 *     first parent, which the machine never saw either.
 * So the base is `before` whenever it can be had; the first parent is the
 * fallback — for a tag push, whose "before" is the tag's own (all zeros for
 * a new tag), and whenever the commit cannot be fetched.
 *
 * The checkout this runs in is shallow. The base is brought in at depth one,
 * which is exactly the machine's view of it — its tree, and nothing behind —
 * so "beyond the base" is computed against what the machine really has.
 * A push that stacks two commits or more puts the base a third level back or
 * further, outside the checkout's own two levels, where it is nobody's parent
 * in the walk — and git excludes the base's objects through parentage alone
 * (see cut). So the listing asks for more than `--not`. Without that, the
 * delta of run 46051725913 was the whole tree — 5132 objects, 36.3 MB, where
 * 804 KB would have done.
 *
 * Prints one line for the log: which base it used and how big the pack is.
 * Exit codes: 0 = pack written; 1 = could not cut (named); 64 = bad arguments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const isSha = (value) => /^[0-9a-f]{40}$/.test(String(value || '').trim());

function git(args, { cwd, input } = {}) {
  const result = spawnSync('git', args, { cwd, input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`could not start git: ${result.error.message}`);
  return result;
}

function must(args, options) {
  const result = git(args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').toString().trim().slice(0, 500)}`);
  }
  return result.stdout.toString().trim();
}

/**
 * The commit the delta is cut against: the wanted one if the machine can be
 * expected to hold it, else the first parent of `ref`.
 * @returns {{ base: string, used: 'base' | 'first parent', note?: string }}
 */
export function resolveBase({ cwd, ref, wanted }) {
  const head = must(['rev-parse', `${ref}^{commit}`], { cwd });
  const firstParent = () => must(['rev-parse', `${ref}^1`], { cwd });
  // A new tag has no "before": GitHub reports forty zeros.
  if (!isSha(wanted) || /^0+$/.test(wanted)) return { base: firstParent(), used: 'first parent' };
  if (wanted === head) return { base: firstParent(), used: 'first parent', note: 'the base is the commit itself' };
  if (git(['cat-file', '-e', `${wanted}^{commit}`], { cwd }).status !== 0) {
    const fetched = git(['fetch', '--quiet', '--depth=1', 'origin', wanted], { cwd });
    if (fetched.status !== 0) {
      return { base: firstParent(), used: 'first parent', note: `could not fetch the base: ${(fetched.stderr || '').toString().trim().slice(0, 120)}` };
    }
  }
  return { base: wanted, used: 'base' };
}

/**
 * Objects `ref` reaches beyond `base`, as a pack with no prerequisites.
 *
 * `--not <base>` alone does not keep the base's objects out of the list. git
 * marks the tree of an excluded commit only when that commit is the parent of
 * a commit being listed (list-objects.c, mark_edges_uninteresting); a base
 * fetched on its own beside a two-level checkout is no one's parent, so the
 * walk listed the whole tree — a "delta" the size of the full bundle.
 * `--objects-edge-aggressive` has git mark the excluded commits named on the
 * command line as well, whoever their children are. It also prints each
 * excluded commit once, as a line starting with a dash; those are edges, not
 * objects, and are left out of what goes to pack-objects.
 */
export function cut({ cwd = process.cwd(), out, base, ref = 'HEAD' }) {
  const head = must(['rev-parse', `${ref}^{commit}`], { cwd });
  const listed = must(['rev-list', '--objects', '--objects-edge-aggressive', head, '--not', base], { cwd });
  const objects = listed.split('\n').filter((line) => !line.startsWith('-'));
  if (objects.length === 0) throw new Error(`the commit reaches nothing beyond ${base.slice(0, 9)}`);
  const pack = git(['pack-objects', '--stdout'], { cwd, input: `${objects.join('\n')}\n` });
  if (pack.status !== 0) throw new Error(`git pack-objects exited ${pack.status}: ${(pack.stderr || '').toString().trim().slice(0, 500)}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pack.stdout);
  return { head, base, objects: objects.length, bytes: pack.stdout.length };
}

const OPTIONS = { '--out': 'out', '--base': 'base', '--ref': 'ref' };

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = OPTIONS[argv[index]];
    if (!key || argv[index + 1] === undefined) {
      console.error(`ci-source-cut: unknown or incomplete argument ${argv[index]}`);
      process.exit(64);
    }
    options[key] = argv[++index];
  }
  if (!options.out) {
    console.error('Usage: node scripts/ci-source-cut.mjs --out <file> [--base <sha>] [--ref <sha>]');
    process.exit(64);
  }
  return options;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const { base, used, note } = resolveBase({ wanted: args.base, ref: args.ref || 'HEAD' });
    const result = cut({ out: args.out, base, ref: args.ref || 'HEAD' });
    console.log(`[ci-source-cut] ${result.objects} objects, ${result.bytes} bytes, beyond ${base.slice(0, 9)} (${used}${note ? `; ${note}` : ''})`);
  } catch (error) {
    console.error(`✗ ci-source-cut: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

// The script runs only when started from the command line, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
