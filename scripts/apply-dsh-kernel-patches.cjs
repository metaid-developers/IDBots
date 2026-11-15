#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Apply the committed kernel patches under scripts/dsh-kernel-patches/ to the
 * installed dsh-runtime node_modules.
 *
 * Why: some @deepseek-ai kernel packages ship Windows behavior we must fix
 * between releases (e.g. dsh-win32-process creating tool subprocesses via raw
 * CreateProcessW without CREATE_NO_WINDOW, which flashes a console window on
 * every bash tool call). The runtime is a nested pnpm package, so root-level
 * patch-package cannot reach it and hand-editing files would be lost on every
 * `pnpm --dir dsh-runtime install`. Committed .patch files + this script
 * keep the fixes reproducible across fresh clones, CI builds (electron-builder
 * packages the patched dsh-runtime/node_modules), and kernel upgrades.
 *
 * Patch files follow the patch-package naming convention:
 *   <package-name-with-+> + <exact-version> + .patch
 * The version in the filename must equal the installed package version — an
 * upgrade:dsh that does not rebase its patches fails loudly here instead of
 * silently shipping an unpatched kernel.
 *
 * Usage:
 *   node scripts/apply-dsh-kernel-patches.cjs           # apply (idempotent)
 *   node scripts/apply-dsh-kernel-patches.cjs --check   # verify only, no writes
 *
 * Wired into: root postinstall (after `pnpm --dir dsh-runtime install`),
 * check:dsh-deps gate (--check), and upgrade:dsh (re-apply after reinstall).
 * See scripts/dsh-kernel-patches/README.md for how to add or rebase patches.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PATCHES_DIR = path.join(__dirname, 'dsh-kernel-patches');
const RUNTIME_NODE_MODULES = path.join(PROJECT_ROOT, 'dsh-runtime', 'node_modules');

const CHECK_ONLY = process.argv.includes('--check');

const tempDirs = [];

process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — temp dir, never worth failing the build over
    }
  }
});

/**
 * `git apply` compares the patch bytes against the working-tree file bytes, so
 * a patch file that Git rewrote to CRLF on checkout (Git for Windows' default
 * core.autocrlf=true) can never match an LF file in node_modules — the apply
 * then fails with "patch does not apply" even though the patch is correct.
 * `.gitattributes` keeps our own checkouts LF, and this normalizes any patch
 * file that arrived with CRLF anyway (a clone made before the attribute
 * existed, a tar extraction, or a runner workspace that is never re-checked
 * out). Only line endings are normalized: the patch content is still matched
 * byte for byte, so a genuinely drifted package keeps failing loudly.
 */
function lfNormalizedPatch(patchPath, label) {
  const raw = fs.readFileSync(patchPath);
  if (!raw.includes(0x0d)) {
    return patchPath;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-patch-'));
  tempDirs.push(dir);
  const normalized = path.join(dir, label);
  fs.writeFileSync(normalized, raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  console.log(
    `[dsh-kernel-patches] ${label}: patch file has CRLF (line-ending conversion on checkout) — ` +
    'using an LF-normalized copy',
  );
  return normalized;
}

function fail(message) {
  console.error(`[dsh-kernel-patches] ${message}`);
  process.exit(1);
}

function patchTargets(patchFile) {
  // "<name>+<version>.patch" — name itself may contain '+' (the patch-package
  // encoding of the '/' in scoped names, e.g. @deepseek-ai+dsh-win32-process),
  // so split at the LAST '+' and decode '+' back to '/'.
  const base = path.basename(patchFile, '.patch');
  const plus = base.lastIndexOf('+');
  if (plus <= 0 || plus === base.length - 1) {
    return null;
  }
  return { name: base.slice(0, plus).replace(/\+/g, '/'), version: base.slice(plus + 1) };
}

function git(args) {
  return spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
}

/**
 * Manifest-vs-patch invariant (v1.1.0 retrospective, 2026-11-14): every
 * manifest.json count must be at least the number of marker-bearing lines the
 * patch itself ADDS. The patched file always contains every added occurrence,
 * so a manifest count below the patch's own additions is a manifest bug that
 * darwin-side verification can never see (platform-scoped entries are skipped
 * on a non-matching platform) and that only the CI Windows packaged check
 * would catch — after a tag. v1.1.0 shipped through exactly this: the
 * win32-process manifest said 2 while its patch adds 3.
 *
 * A manifest count ABOVE the added lines is legitimate (the unpatched file may
 * already contain the marker), so that case only logs an informational note.
 * Returns the number of invariant failures added to the run.
 */
function checkManifestCountInvariant(patchFile, label) {
  let failures = 0;
  const manifestPath = path.join(PATCHES_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return 0; // completeness is verify-dsh-kernel-patches.cjs's job, not ours
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Array.isArray(manifest) ? manifest : manifest.patches || [];
  const entry = entries.find((candidate) => candidate.patch === label);
  if (!entry) {
    return 0; // missing manifest entry fails loudly in verify-dsh-kernel-patches.cjs
  }
  const patchLines = fs.readFileSync(patchFile, 'utf8').split('\n');
  for (const target of entry.targets || []) {
    const match = target.match;
    if (!match) {
      continue;
    }
    const expected = target.count;
    if (typeof expected !== 'number') {
      console.error(
        `[dsh-kernel-patches] ${label}: manifest target ${target.file} "${match}" has no numeric count`,
      );
      failures += 1;
      continue;
    }
    // Added content lines start with a single '+' — never the '+++' file header.
    const added = patchLines.filter(
      (line) => line.startsWith('+') && !line.startsWith('+++') && line.includes(match),
    ).length;
    if (added === 0) {
      console.error(
        `[dsh-kernel-patches] ${label}: manifest expects "${match}" in ${target.file} but the patch never adds it — the count cannot be satisfied`,
      );
      failures += 1;
      continue;
    }
    if (expected < added) {
      console.error(
        `[dsh-kernel-patches] ${label}: manifest count ${expected} is below the ${added} "${match}" lines this patch adds to ${target.file} — the patched file must contain at least the added occurrences. Fix manifest.json; a drifted count only fails on the matching platform or in CI (v1.1.0 tag incident).`,
      );
      failures += 1;
      continue;
    }
    if (expected > added) {
      console.log(
        `[dsh-kernel-patches] ${label}: manifest count ${expected} exceeds the ${added} added "${match}" lines — OK if the unpatched file already contains the marker; recheck when rebasing`,
      );
    }
  }
  return failures;
}

function main() {
  if (!fs.existsSync(PATCHES_DIR)) {
    console.log('[dsh-kernel-patches] no patches directory — nothing to do');
    return;
  }
  const patchFiles = fs
    .readdirSync(PATCHES_DIR)
    // `._foo.patch` are macOS AppleDouble sidecars the exFAT worktree volume
    // writes next to real files — never patches (see AGENTS.md Worktree Closeout).
    .filter((name) => name.endsWith('.patch') && !name.startsWith('._'))
    .sort();
  if (patchFiles.length === 0) {
    console.log('[dsh-kernel-patches] no kernel patches present — nothing to do');
    return;
  }

  let failures = 0;
  for (const patchFile of patchFiles) {
    const label = path.basename(patchFile);
    const target = patchTargets(patchFile);
    if (!target) {
      console.error(`[dsh-kernel-patches] ${label}: cannot parse "<name>+<version>.patch" — rename it`);
      failures += 1;
      continue;
    }

    const installedManifest = path.join(RUNTIME_NODE_MODULES, target.name, 'package.json');
    if (!fs.existsSync(installedManifest)) {
      console.error(
        `[dsh-kernel-patches] ${label}: ${target.name} is not installed under dsh-runtime/node_modules — ` +
        'run: pnpm --dir dsh-runtime install',
      );
      failures += 1;
      continue;
    }
    const installedVersion = JSON.parse(fs.readFileSync(installedManifest, 'utf8')).version;
    if (installedVersion !== target.version) {
      console.error(
        `[dsh-kernel-patches] ${label}: patch targets ${target.name}@${target.version} but ` +
        `${installedVersion} is installed. The kernel was upgraded — rebase the patch ` +
        '(scripts/dsh-kernel-patches/README.md) or drop it if upstream fixed the issue.',
      );
      failures += 1;
      continue;
    }

    // Platform-independent manifest sanity: runs on every platform on every
    // gate pass, unlike the packaged-app fingerprint check that only exists
    // for the matching platform in CI.
    failures += checkManifestCountInvariant(path.join(PATCHES_DIR, patchFile), label);

    const patchPath = path.join(PATCHES_DIR, patchFile);
    const applyPath = lfNormalizedPatch(patchPath, label);
    const reverseCheck = git(['apply', '--check', '--reverse', applyPath]);
    if (reverseCheck.status === 0) {
      console.log(`[dsh-kernel-patches] ${label}: already applied`);
      continue;
    }
    const forwardCheck = git(['apply', '--check', applyPath]);
    if (forwardCheck.status !== 0) {
      console.error(
        `[dsh-kernel-patches] ${label}: does not apply to the installed ${target.name}@${installedVersion} ` +
        `(expected version matches, but the file drifted). Rebase the patch:\n${forwardCheck.stderr}`,
      );
      failures += 1;
      continue;
    }
    if (CHECK_ONLY) {
      console.error(`[dsh-kernel-patches] ${label}: NOT applied (run: node scripts/apply-dsh-kernel-patches.cjs)`);
      failures += 1;
      continue;
    }
    const applied = git(['apply', applyPath]);
    if (applied.status !== 0) {
      console.error(`[dsh-kernel-patches] ${label}: git apply failed:\n${applied.stderr}`);
      failures += 1;
      continue;
    }
    console.log(`[dsh-kernel-patches] ${label}: applied`);
  }

  if (failures > 0) {
    process.exit(1);
  }
}

main();
