#!/usr/bin/env node
/**
 * Build-time invariant for the ELECTRON MAIN side of dist-electron.
 *
 * Guards the failure class behind the 2026-11 "the bot cannot write to the
 * chain" incident: `dist-electron/main/libs/createPinWorker.js` was missing
 * while the app still started and looked healthy, because the only runtime
 * detector is a `new Worker(path)` call that throws when the chain write is
 * first attempted (metaidCore.ts: "createPinWorker.js not found … Run npm run
 * compile:electron"). Compilation itself never fails on a worker entrypoint
 * that failed to emit — tsc exits 0 for a stale/partial output directory —
 * so a packaged build could carry an unwritable chain path.
 *
 * What is verified (all under dist-electron/, produced by `vite build` +
 * `compile:electron`):
 *
 *   1. the two entry scripts Electron loads directly: main.js and preload.js;
 *   2. every worker entrypoint spawned by basename from the main process —
 *      the list is DERIVED from `src/main/libs/*Worker.ts`, so a new worker
 *      cannot be forgotten here (it is resolved through
 *      workerPathResolver/metaiCore/transferService/metaFileUploadService/
 *      walletRawTxService at runtime, path.join(__dirname, 'libs', name));
 *   3. `services/dailyReportCollector.js` — resolved by explicit candidate
 *      paths in src/main/sqliteReadWorker.ts (the off-thread read worker's
 *      collector module), never imported statically, so tsc cannot notice its
 *      absence either;
 *   4. every plain `.js` runtime module under src/main — `compile:electron`'s
 *      copy-electron-js.cjs step copies them verbatim (they are required by
 *      path, not compiled), and a missed copy fails only at first use.
 *
 * Wiring: the tail of `pnpm run build`, right after verify-twemoji-bundle.mjs,
 * so a missing artifact turns the BUILD red instead of a chain write red.
 * Standalone: `node scripts/verify-dist-electron.mjs` (requires a prior build).
 *
 * Exit codes: 0 = every artifact present, 1 = one or more missing (named).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(repoRoot, 'src', 'main');
const OUT_ROOT = path.join(repoRoot, 'dist-electron');
const OUT_MAIN = path.join(OUT_ROOT, 'main');

const die = (message) => {
  console.error(`✗ dist-electron: ${message}`);
  process.exit(1);
};

const rel = (absolute) => path.relative(repoRoot, absolute);

// --- 1) Entry scripts Electron loads directly (main.js + preload.js).
const ENTRY_ARTIFACTS = [
  { file: path.join(OUT_ROOT, 'main.js'), from: 'vite build (src/main/main.ts)' },
  { file: path.join(OUT_ROOT, 'preload.js'), from: 'vite build (src/main/preload.ts)' },
];

// --- 2) Worker entrypoints, derived from source so the list cannot drift.
// Every `src/main/libs/*Worker.ts` is spawned as `libs/<basename>.js`.
const workerSources = fs
  .readdirSync(path.join(SOURCE_ROOT, 'libs'))
  .filter((name) => name.endsWith('Worker.ts'))
  .map((name) => name.replace(/\.ts$/, ''));
if (workerSources.length === 0) die('no src/main/libs/*Worker.ts found — the derivation rule is broken');
const WORKER_ARTIFACTS = workerSources.map((basename) => ({
  file: path.join(OUT_MAIN, 'libs', `${basename}.js`),
  from: `compile:electron (src/main/libs/${basename}.ts)`,
}));

// --- 3) Off-thread collector resolved by explicit candidate paths
// (src/main/sqliteReadWorker.ts: services/dailyReportCollector.js).
const COLLECTOR_SOURCE = path.join(SOURCE_ROOT, 'services', 'dailyReportCollector.ts');
if (!fs.existsSync(COLLECTOR_SOURCE)) {
  die('src/main/services/dailyReportCollector.ts is gone — update the artifact list in this script');
}
const SERVICE_ARTIFACTS = [
  {
    file: path.join(OUT_MAIN, 'services', 'dailyReportCollector.js'),
    from: 'compile:electron (src/main/services/dailyReportCollector.ts; resolved by sqliteReadWorker.ts)',
  },
];

// --- 4) Plain `.js` runtime modules copied verbatim by copy-electron-js.cjs.
const copyJsSources = [];
const walkSourceJs = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceJs(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) copyJsSources.push(path.relative(SOURCE_ROOT, full));
  }
};
walkSourceJs(SOURCE_ROOT);
const COPY_ARTIFACTS = copyJsSources.map((relativeSource) => ({
  file: path.join(OUT_MAIN, relativeSource),
  from: `compile:electron copy (src/main/${relativeSource.split(path.sep).join('/')})`,
}));

const ARTIFACTS = [...ENTRY_ARTIFACTS, ...WORKER_ARTIFACTS, ...SERVICE_ARTIFACTS, ...COPY_ARTIFACTS];

// --- Verdict: every artifact must exist as a non-empty regular file.
if (!fs.existsSync(OUT_ROOT)) {
  die('dist-electron/ not found — run the build (vite build + compile:electron) first');
}
const missing = [];
for (const artifact of ARTIFACTS) {
  let ok = false;
  try {
    const stat = fs.statSync(artifact.file);
    ok = stat.isFile() && stat.size > 0;
  } catch {
    ok = false;
  }
  if (!ok) missing.push(artifact);
}

if (missing.length > 0) {
  console.error(`✗ dist-electron artifact check FAILED: ${missing.length}/${ARTIFACTS.length} missing`);
  for (const artifact of missing) {
    console.error(`  missing: ${rel(artifact.file)}  (from: ${artifact.from})`);
  }
  console.error(
    '  The app can start without these and fail only at first use (chain write / off-thread read), so this gate fails the build instead.',
  );
  process.exit(1);
}

const counts = {
  entry: ENTRY_ARTIFACTS.length,
  worker: WORKER_ARTIFACTS.length,
  service: SERVICE_ARTIFACTS.length,
  copiedJs: COPY_ARTIFACTS.length,
};
console.log(
    `✓ dist-electron artifact check PASSED: ${ARTIFACTS.length}/${ARTIFACTS.length} present `
  + `(${counts.entry} entry, ${counts.worker} worker entrypoints, ${counts.service} off-thread service, `
  + `${counts.copiedJs} copied runtime .js modules); worker list derived from src/main/libs/*Worker.ts.`,
);
