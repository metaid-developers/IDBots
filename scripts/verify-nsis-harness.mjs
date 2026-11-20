#!/usr/bin/env node
/**
 * Compile scripts/nsis-syntax-harness.nsi with real makensis (-WX), both
 * shapes the production build uses (installer + uninstaller).
 *
 * Why: NSIS has no meaningful local lint — an unknown $var silently expands
 * to the empty string and an unresolvable label only fails at compile time.
 * The v1.0.9 incident ($SYSTEMDRIVE, dff5739c) and the 2026-11-19 review
 * both surfaced exactly this class AFTER everything else was green. The
 * regex test (tests/windowsInstallerReliability.test.mjs) pins source
 * shapes but cannot see NSIS grammar; this script is the grammar gate.
 *
 * makensis resolution order:
 *   1. IDBOTS_MAKENSIS env var
 *   2. PATH
 *   3. electron-builder's NSIS cache (Windows: %LOCALAPPDATA%/electron-builder/Cache/nsis/**\/makensis.exe)
 *
 * Exit codes:
 *   0  both shapes compiled (or --allow-missing and no makensis found)
 *   1  compile failure, or --require-makensis and no makensis found
 *
 * CI (Windows packaging job) passes --require-makensis and installs NSIS via
 * choco when neither PATH nor the electron-builder cache has it. Locally
 * (e.g. a dev mac with `brew install nsis`) plain `node
 * scripts/verify-nsis-harness.mjs` verifies the harness and fails on real
 * grammar errors.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const harnessNsi = path.join(repoRoot, 'scripts', 'nsis-syntax-harness.nsi');
const installerNsh = path.join(repoRoot, 'scripts', 'nsis-installer.nsh');
const allowMissing = process.argv.includes('--allow-missing');
const requireMakensis = process.argv.includes('--require-makensis');

const log = (line) => console.log(`[verify-nsis-harness] ${line}`);

function findMakensis() {
  if (process.env.IDBOTS_MAKENSIS && fs.existsSync(process.env.IDBOTS_MAKENSIS)) {
    return process.env.IDBOTS_MAKENSIS;
  }
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  const candidates = pathDirs.map((dir) => path.join(dir, `makensis${process.platform === 'win32' ? '.exe' : ''}`));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // electron-builder downloads its own NSIS bundle on first Windows
  // packaging; reuse it when present so CI does not need a second install.
  const locals = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const cacheRoot = path.join(locals, 'electron-builder', 'Cache', 'nsis');
  if (fs.existsSync(cacheRoot)) {
    const versions = fs.readdirSync(cacheRoot)
      .map((name) => ({ name, dir: path.join(cacheRoot, name) }))
      .filter((entry) => fs.statSync(entry.dir).isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
    for (const version of versions) {
      const makensis = path.join(version.dir, 'makensis.exe');
      if (fs.existsSync(makensis)) return makensis;
    }
  }
  return null;
}

function compile(makensis, { uninstaller }) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-nsis-harness-')), uninstaller ? 'harness-uninst.exe' : 'harness.exe');
  // -INPUTCHARSET UTF8 matches electron-builder's real NSIS compile
  // (NsisTarget pushes exactly this flag): makensis otherwise reads the
  // script as the system ANSI codepage, and on a non-UTF-8 ACP machine
  // (GBK zh-CN win-sign) BOM-less UTF-8 comment punctuation (em-dash) is
  // rejected as "Bad text encoding" even though the real build compiles it.
  const args = ['-WX', '-INPUTCHARSET', 'UTF8', '-DIDBOTS_NSIS_SYNTAX_HARNESS', `-DIDBOTS_NSIS_SCRIPT=${installerNsh}`, `-DIDBOTS_NSIS_OUTPUT=${outFile}`];
  if (uninstaller) args.unshift('-DBUILD_UNINSTALLER');
  args.push(harnessNsi);
  // POSIX makensis ignores -INPUTCHARSET and derives the input charset from
  // the process locale instead, so a C/POSIX-locale caller (CI shells,
  // agent harnesses) rejects valid UTF-8 punctuation with the same "Bad
  // text encoding" error. Pin a UTF-8 locale on non-Windows so the gate is
  // deterministic regardless of the caller's environment; Windows decides
  // purely via the flag above.
  const result = spawnSync(makensis, args, {
    encoding: 'utf8',
    env: process.platform === 'win32'
      ? process.env
      : { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { result, output, label: uninstaller ? 'uninstaller' : 'installer' };
}

const makensis = findMakensis();
if (!makensis) {
  if (requireMakensis) {
    console.error('[verify-nsis-harness] FAIL: makensis not found (set IDBOTS_MAKENSIS, put it on PATH, install nsis via choco, or run electron-builder packaging once to populate its cache).');
    process.exit(1);
  }
  if (allowMissing) {
    log('makensis not found and --allow-missing: SKIPPED (no grammar gate this run).');
    process.exit(0);
  }
  console.error('[verify-nsis-harness] FAIL: makensis not found. Install it (brew install nsis / choco install nsis), set IDBOTS_MAKENSIS, or pass --allow-missing to skip.');
  process.exit(1);
}

log(`makensis: ${makensis}`);
if (!fs.existsSync(harnessNsi)) {
  console.error('[verify-nsis-harness] FAIL: harness script missing: ' + harnessNsi);
  process.exit(1);
}
if (!fs.existsSync(installerNsh)) {
  console.error('[verify-nsis-harness] FAIL: installer nsh missing: ' + installerNsh);
  process.exit(1);
}

let failed = false;
for (const shape of [{ uninstaller: false }, { uninstaller: true }]) {
  const { result, output, label } = compile(makensis, shape);
  if (output) log(`--- ${label} shape output ---\n${output}`);
  if (result.status !== 0) {
    console.error(`[verify-nsis-harness] FAIL: ${label} shape did not compile (exit ${result.status}, signal ${result.signal ?? 'none'}).`);
    failed = true;
  } else {
    log(`${label} shape: compiled clean under -WX.`);
  }
}

if (failed) process.exit(1);
log('PASS: both harness shapes compiled under -WX.');
