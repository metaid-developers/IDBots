#!/usr/bin/env node
/**
 * Byte-exact CI working tree for the self-hosted Windows runner.
 *
 * The failure class this closes: Git for Windows defaults to
 * `core.autocrlf=true`, so every LF-committed text file is checked out with
 * CRLF there (~4,300 files in this repo), and any test that reads repository
 * content byte-sensitively fails on Windows only. Each victim has so far been
 * patched one path at a time with a `-text` rule: the kernel patches (v0.9.3),
 * the xiangqi fixture (v0.9.5), the METAAPPs / docs commerce payloads (v1.1.3).
 * The v1.1.3 rule then did not take effect on the signing machine for another
 * round, because git's stat cache treats the already-checked-out CRLF copies
 * as current and never rewrites them (SOP §11.22) — the tree only became
 * correct after a re-clone that the network stretched to 107 minutes.
 *
 * Root fix: check out what was committed. build.yml sets
 * `core.autocrlf=false` before the checkout, and this step rewrites the files
 * an earlier run left as CRLF, so a long-lived runner workspace converges on
 * byte-exact content without a re-clone. It is idempotent: once the tree is
 * exact it rewrites nothing and costs one `git ls-files --eol`.
 *
 * Only index-LF files whose working copy carries CRLF are touched. Files
 * committed with CRLF, `-text` files and binaries are already byte-exact.
 *
 * Exit codes: 0 = working tree byte-exact, 1 = could not normalize (named).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Parse `git ls-files --eol -z`: one NUL-terminated record per file, shaped
 * `<index eol>  <worktree eol>  attr/<attrs>\t<path>` (a path may contain
 * spaces, so the tab before it — not whitespace — is the separator).
 */
export function parseLsFilesEol(output) {
  return String(output)
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.lastIndexOf('\t');
      const meta = record.slice(0, tab).match(/i\/(\S+)\s+w\/(\S+)\s+attr\/(\S*)/);
      return { index: meta?.[1], work: meta?.[2], attr: meta?.[3] ?? '', path: record.slice(tab + 1) };
    });
}

/** Working copies that differ from their LF index entry by line endings only. */
export function selectCrlfCarryover(entries) {
  return entries
    .filter((entry) => entry.index === 'lf' && (entry.work === 'crlf' || entry.work === 'mixed'))
    .filter((entry) => !/\beol=crlf\b/.test(entry.attr))
    .map((entry) => entry.path);
}

/** Only these settings leave index bytes untouched on checkout. Unset = false. */
export function allowsExactCheckout(autocrlfConfigValue) {
  const value = String(autocrlfConfigValue).trim().toLowerCase();
  return value === '' || value === 'false' || value === 'input';
}

export function normalizeWorktreeEol({ cwd = process.cwd() } = {}) {
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
  };
  const must = (args, input) => {
    const result = git(args, input);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim()}`);
    }
    return result.stdout;
  };

  // Rewriting is pointless while checkout would convert the files back.
  const autocrlf = git(['config', '--get', 'core.autocrlf']).stdout.trim();
  if (!allowsExactCheckout(autocrlf)) {
    throw new Error(
      `core.autocrlf=${autocrlf} rewrites line endings on checkout; set it to false first `
      + '(build.yml "Configure Git (Windows)")',
    );
  }

  const targets = selectCrlfCarryover(parseLsFilesEol(must(['ls-files', '--eol', '-z'])));
  if (targets.length === 0) {
    console.log('[ci-worktree-eol] working tree is already byte-exact');
    return { rewritten: 0, remaining: 0 };
  }

  const paths = `${targets.join('\0')}\0`;
  // Delete the carry-over copies before checking them out again. checkout-index
  // skips any entry whose cached stat still matches the file on disk, --force
  // or not (entry.c: "if (!changed) return 0;"), and compares contents only for
  // entries as young as the index file. The cached stat describes the CRLF
  // copy, so without this the rewrite depends on timing: it worked while a
  // checkout stayed within one timestamp second, and left the files it wrote
  // before that boundary alone when it did not (run 46014677636, 2026-11-27:
  // two of three files still CRLF). A missing file is always written.
  for (const relative of targets) {
    fs.rmSync(path.join(cwd, relative), { force: true });
  }
  must(['checkout-index', '--force', '--stdin', '-z'], paths);
  // checkout-index writes the index bytes but leaves the index stat data sized
  // for the old CRLF copy, which git would then report as modified (a size
  // mismatch skips its content check). Refresh those entries; the content
  // equals the index, so nothing is staged — verified below.
  must(['update-index', '-z', '--stdin'], paths);

  const remaining = selectCrlfCarryover(parseLsFilesEol(must(['ls-files', '--eol', '-z'])));
  if (remaining.length > 0) {
    throw new Error(`${remaining.length} file(s) still carry CRLF after rewrite, e.g. ${remaining.slice(0, 5).join(', ')}`);
  }
  if (git(['diff', '--cached', '--quiet']).status !== 0) {
    throw new Error('normalization staged content changes; refusing to continue');
  }
  console.log(`[ci-worktree-eol] rewrote ${targets.length} file(s) to their committed (LF) bytes`);
  return { rewritten: targets.length, remaining: 0 };
}

function main() {
  try {
    normalizeWorktreeEol();
  } catch (error) {
    console.error(`✗ ci-worktree-eol: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
