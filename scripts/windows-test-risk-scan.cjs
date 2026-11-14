#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Windows CI risk scan for test files changed since a release tag (§3.3 开工四查 #4).
 *
 * macOS test runs can never surface these, and each class has already cost a
 * full CI round or worse:
 *   R1  mkdtempSync + rmSync without an intervening close()/disposeStore —
 *       EPERM on Windows CI while macOS POSIX silently succeeds (§11.2b,
 *       v1.0.9 tag run failed twice on this).
 *   R2  readFileSync + LF-anchored regex (`\n` inside a regex literal) —
 *       a CRLF checkout never matches (§11.9, v1.1.0 umbrella failures).
 *       Mitigated in place by normalizing to LF after readFileSync.
 *   R3  fixed short setTimeout drains before async assertions — Windows timer
 *       granularity (~15ms/hop) blows past fixed windows (v1.1.0 debounce
 *       flake). INFO: prefer poll-until-observed helpers.
 *   R4  dynamic import() of constructed paths without pathToFileURL —
 *       ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows (§11.22).
 *
 * The report is candidates for human review, not verdicts — the SOP's scan
 * step (§3.3 四查 #4) pairs this output with a look at the flagged lines.
 *
 * Usage:
 *   node scripts/windows-test-risk-scan.cjs                 # diff since the latest v* tag
 *   node scripts/windows-test-risk-scan.cjs --base v1.0.10  # explicit base ref
 *   node scripts/windows-test-risk-scan.cjs --files a,b,c   # scan specific files
 *   node scripts/windows-test-risk-scan.cjs --report-only   # always exit 0
 *   node scripts/windows-test-risk-scan.cjs --write-baseline # record current findings as the baseline
 *
 * Baseline: scripts/windows-risk-baseline.json records the accepted findings
 * ("file::id" keys). A run FAILS only on findings outside the baseline, so
 * pre-existing debt does not block releases while new risks still do —
 * shrink the baseline as the debt gets fixed. v1.1.0's first scan surfaced
 * the pre-existing debt; it lives in the committed baseline until cleaned.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const REPORT_ONLY = args.includes('--report-only');
const WRITE_BASELINE = args.includes('--write-baseline');
const BASELINE_PATH = path.join(__dirname, 'windows-risk-baseline.json');

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function resolveBase() {
  const explicit = argValue('--base');
  if (explicit) {
    return explicit;
  }
  try {
    return git(['describe', '--tags', '--match', 'v*', '--abbrev=0']).trim();
  } catch {
    return 'HEAD~50';
  }
}

function collectFiles(base) {
  const out = git(['diff', '--name-only', '--diff-filter=ACMR', `${base}..HEAD`, '--', 'tests/']);
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

const LF_ANCHORED_REGEX = /\/(?:[^/\\\n]|\\.)*\\n(?:[^/\\\n]|\\.)*\/[gimsuy]*/;
const FIXED_DRAIN = /setTimeout\(\s*(?:resolve|r|done|cb)\s*,\s*(\d{1,4})\s*\)/g;

function scanFile(relativePath) {
  const findings = [];
  let source;
  try {
    source = fs.readFileSync(path.resolve(relativePath), 'utf8');
  } catch {
    return findings; // deleted or renamed since the base
  }
  const crlfMitigated = /\.replace\(\s*/.test(source) && /\\r\\n/.test(source);

  // R1 — mkdtempSync + rmSync around SQLite handles without close (§11.2b's
  // actual root cause: temp dirs without open DB handles rm fine on Windows).
  const sqliteish = /sqlite|sql\.js|better-sqlite|\.db['"`\s]|-wal/i.test(source);
  if (source.includes('mkdtempSync') && source.includes('rmSync') && sqliteish && !/close\s*\(/.test(source) && !source.includes('disposeStore')) {
    findings.push({
      level: 'HIGH',
      id: 'R1',
      detail: 'mkdtempSync+rmSync around SQLite without an intervening close()/disposeStore — EPERM on Windows CI (§11.2b); close the store first, then best-effort rm',
    });
  }

  // R2 — readFileSync + LF-anchored regex without CRLF normalization.
  if (source.includes('readFileSync') && LF_ANCHORED_REGEX.test(source)) {
    if (crlfMitigated) {
      findings.push({
        level: 'MITIGATED',
        id: 'R2',
        detail: 'readFileSync + LF-anchored regex, but the source is CRLF-normalized in place (§11.9 pattern) — OK',
      });
    } else {
      findings.push({
        level: 'HIGH',
        id: 'R2',
        detail: 'readFileSync + LF-anchored regex with no CRLF normalization — a CRLF checkout never matches (§11.9); normalize to LF after reading',
      });
    }
  }

  // R3 — fixed short drains before async assertions.
  for (const match of source.matchAll(FIXED_DRAIN)) {
    const ms = Number(match[1]);
    if (ms > 0 && ms <= 200) {
      findings.push({
        level: 'INFO',
        id: 'R3',
        detail: `fixed setTimeout(resolve, ${ms}) drain — Windows timer granularity (~15ms/hop) can blow past fixed windows; prefer poll-until-observed (§3.3 四查 #4)`,
        line: source.slice(0, match.index).split('\n').length,
      });
      break; // one note per file is enough
    }
  }

  // R4 — dynamic import() of constructed paths without pathToFileURL.
  if (/import\(\s*[`'"][^`'"]*\$\{/.test(source) && !source.includes('pathToFileURL')) {
    findings.push({
      level: 'HIGH',
      id: 'R4',
      detail: 'dynamic import() of a constructed path without pathToFileURL — ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows (§11.22)',
    });
  }

  return findings;
}

function loadBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set(); // no baseline yet: every HIGH counts
  }
}

function main() {
  const base = resolveBase();
  let files;
  const filesArg = argValue('--files');
  if (filesArg) {
    files = filesArg.split(',').map((entry) => entry.trim()).filter(Boolean);
  } else {
    files = collectFiles(base);
  }

  console.log(`[win-scan] base=${base} files=${files.length}`);
  const baseline = loadBaseline();
  const currentKeys = new Set();
  let high = 0;
  let baselined = 0;
  let mitigated = 0;
  let info = 0;

  for (const file of files) {
    const findings = scanFile(file);
    for (const finding of findings) {
      const at = finding.line ? `:${finding.line}` : '';
      if (finding.level === 'HIGH') currentKeys.add(`${file}::${finding.id}`);
      if (finding.level === 'HIGH' && baseline.has(`${file}::${finding.id}`)) {
        baselined += 1;
        console.log(`[BASELINE] ${file} — ${finding.id}: ${finding.detail}`);
        continue;
      }
      console.log(`[${finding.level}] ${file}${at} — ${finding.id}: ${finding.detail}`);
      if (finding.level === 'HIGH') high += 1;
      else if (finding.level === 'MITIGATED') mitigated += 1;
      else info += 1;
    }
  }

  if (WRITE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify([...currentKeys].sort(), null, 2)}\n`, 'utf8');
    console.log(`[win-scan] baseline written: ${BASELINE_PATH} (${currentKeys.size} HIGH findings accepted)`);
    return;
  }

  console.log(`[win-scan] summary: ${high} new high, ${baselined} baselined, ${info} info, ${mitigated} mitigated, ${files.length} files scanned`);
  if (high > 0 && !REPORT_ONLY) {
    console.error('[win-scan] NEW HIGH risks found — fix or review them before tagging (§3.3 四查 #4); add deliberate ones to scripts/windows-risk-baseline.json.');
    process.exit(1);
  }
}

main();
