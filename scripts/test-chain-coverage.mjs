#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Test-chain coverage guard + unwired-test sweep (2026-11-19 hygiene line).
 *
 * The failure class this closes: the repo whitelists new test files into git
 * (`.gitignore` `tests/*` + `!tests/...` entries) but nothing forces a new
 * test to be WIRED into a chain. By 2026-11-19 the repo carried ~610 tracked
 * test files that no `pnpm test` path ever executed — agents shipped tests
 * that looked green locally and then silently stopped being run by anyone.
 * The 2026-11-19 PR-merge line found real cross-PR breakage (a dead
 * receipt-tier classifier) only because those orphan files were run by hand.
 *
 * This script defines the discipline (one formula, three tiers):
 *
 *   tracked tests (git ls-files, tests/*.test.{mjs,ts,tsx})
 *     = wired        — named by a package.json script / CI workflow / scripts/
 *                      file, or mentioned by a WIRED test file (fixture reuse);
 *     = excluded     — listed in tests/unwired-exclusions.json with a reason
 *                      (env-gated, manual-only, known-stale; each entry needs
 *                      one) and NOT run anywhere;
 *     = unwired      — the complement. `pnpm run test:unwired` executes the
 *                      complement as a SWEEP (node --test for .mjs, npx tsx
 *                      --test for .ts/.tsx), so every tracked test is under
 *                      daily test pressure: a new unwired test runs in the
 *                      next root-chain pass, a red one reds the chain instead
 *                      of sitting silently dead. Graduation into a thematic
 *                      chain (or exclusion with a reason) is the way out.
 *
 * `--check` is the ledger-hygiene guard: it fails on exclusions whose file is
 * now wired (stale), deleted/untracked, or reason-less, and prints the tier
 * counts so drift stays visible on every root-chain run. It does NOT fail on
 * sweep members — the sweep itself is what keeps them honest.
 *
 * Usage:
 *   node scripts/test-chain-coverage.mjs --check   (guard: ledger hygiene + tier counts)
 *   node scripts/test-chain-coverage.mjs           (run the unwired sweep)
 *   node scripts/test-chain-coverage.mjs --list    (print the unwired set, no run)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const LEDGER_PATH = 'tests/unwired-exclusions.json';
const TEST_FILE_RE = /^tests\/.+\.test\.(mjs|ts|tsx)$/;
const REF_RE = /tests\/[\w./-]+\.test\.(?:mjs|tsx|ts)/g;

const sh = (cmd, args) =>
  execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const trackedTests = () =>
  sh('git', ['ls-files', 'tests/'])
    .split('\n')
    .filter((f) => TEST_FILE_RE.test(f))
    .sort();

// Every textual `tests/...test.*` mention in chain-defining surfaces.
const wiredMentions = () => {
  const sources = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  sources.push(JSON.stringify(pkg.scripts ?? {}));
  const wfDir = path.join(repoRoot, '.github', 'workflows');
  if (fs.existsSync(wfDir)) {
    for (const entry of fs.readdirSync(wfDir)) sources.push(fs.readFileSync(path.join(wfDir, entry), 'utf8'));
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js|json|yml|yaml)$/.test(entry.name)) sources.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(repoRoot, 'scripts'));
  const found = new Set();
  for (const src of sources) for (const m of src.match(REF_RE) ?? []) found.add(m);
  return found;
};

// Files mentioned by a WIRED test file's source (fixture reuse: an orphan
// imported by a wired test effectively runs in-chain).
const wiredTestSources = () => {
  const referenced = wiredMentions();
  const out = [];
  for (const f of referenced) {
    const p = path.join(repoRoot, f);
    if (fs.existsSync(p)) out.push(fs.readFileSync(p, 'utf8'));
  }
  return { referenced, sources: out };
};

const loadLedger = () => {
  if (!fs.existsSync(path.join(repoRoot, LEDGER_PATH))) return { comment: '', exclusions: [] };
  const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, LEDGER_PATH), 'utf8'));
  if (!Array.isArray(parsed.exclusions)) throw new Error(`${LEDGER_PATH}: missing "exclusions" array`);
  return parsed;
};

const classify = () => {
  const tracked = trackedTests();
  const { referenced, sources } = wiredTestSources();
  const ledger = loadLedger();
  const excluded = new Set(ledger.exclusions.map((e) => e.file));
  const mentionedByWired = new Set();
  const baseNames = new Map(tracked.map((f) => [path.basename(f), f]));
  for (const src of sources) {
    for (const [base] of baseNames) if (src.includes(base)) mentionedByWired.add(baseNames.get(base));
  }
  const wired = new Set([...referenced].filter((f) => TEST_FILE_RE.test(f)));
  const strays = tracked.filter((f) => !wired.has(f) && !excluded.has(f) && !mentionedByWired.has(f));
  return { tracked, referenced, ledger, wired, excluded, mentionedByWired, strays };
};

const check = () => {
  const { tracked, ledger, wired, excluded, strays } = classify();
  let failed = false;
  const knownTracked = new Set(tracked);
  for (const e of ledger.exclusions) {
    if (!e.file || !TEST_FILE_RE.test(e.file)) { failed = true; console.error(`✖ ledger: invalid file "${e.file}"`); continue; }
    if (!e.reason || typeof e.reason !== 'string' || !e.reason.trim()) { failed = true; console.error(`✖ ledger: ${e.file} has no reason — exclusions must justify themselves`); }
    if (!knownTracked.has(e.file)) { failed = true; console.error(`✖ ledger: ${e.file} is not a tracked test file (deleted? untracked?) — remove the entry`); }
    else if (wired.has(e.file)) { failed = true; console.error(`✖ ledger: ${e.file} is now wired into a chain — remove the stale exclusion`); }
  }
  if (failed) process.exit(1);
  console.log(`test-chain coverage: ${tracked.length} tracked test files — ${wired.size} wired, ${excluded.size} excluded with reason, ${strays.length} under the unwired sweep.`);
};

const sweep = (listOnly) => {
  const { strays } = classify();
  if (strays.length === 0) {
    console.log('unwired sweep: nothing to run (0 strays).');
    return;
  }
  if (listOnly) {
    for (const f of strays) console.log(f);
    return;
  }
  const mjs = strays.filter((f) => f.endsWith('.mjs'));
  const tsLike = strays.filter((f) => !f.endsWith('.mjs'));
  let failed = false;
  if (mjs.length > 0) {
    console.log(`unwired sweep: node --test over ${mjs.length} .mjs files`);
    // Per-test timeout: a file that wedges under sweep concurrency (resource
    // contention around spawned daemons — green solo, hung in company) must
    // turn into a RED sweep result, never into a wedged root chain. The batch
    // cap is the last-resort backstop.
    const r = spawnSync('node', ['--test', '--test-concurrency=4', '--test-timeout=180000', ...mjs], {
      cwd: repoRoot, stdio: 'inherit', maxBuffer: 1024 * 1024 * 1024,
      timeout: 35 * 60 * 1000, killSignal: 'SIGKILL',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    if (r.status !== 0) failed = true;
  }
  if (tsLike.length > 0) {
    console.log(`unwired sweep: npx tsx --test over ${tsLike.length} .ts/.tsx files`);
    const r = spawnSync('npx', ['tsx', '--test', ...tsLike], {
      cwd: repoRoot, stdio: 'inherit', maxBuffer: 1024 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    if (r.status !== 0) failed = true;
  }
  if (failed) {
    console.error('unwired sweep RED — fix the failing test or exclude it with a reason in');
    console.error(`${LEDGER_PATH} (a red orphan must never sit silently in the sweep).`);
    process.exit(1);
  }
  console.log(`unwired sweep GREEN (${strays.length} files).`);
};

const mode = process.argv[2];
if (mode === '--check') check();
else if (mode === '--list') sweep(true);
else sweep(false);
