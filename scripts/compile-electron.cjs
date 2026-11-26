#!/usr/bin/env node
/**
 * Incremental `compile:electron`.
 *
 * The failure class this closes: 64 npm scripts prefix `pnpm run
 * compile:electron` (the project convention — a suite always runs against
 * freshly compiled output), so one CI job compiles the same ~700-file main
 * process 18 times and the root chain about as often. Measured on 2026-11-25:
 * ~1 min per run on the signing machine (about 18 of the Windows job's 36 test
 * minutes) and ~0.6 min on each hosted macOS runner.
 *
 * tsc's own incremental state decides what is stale (per-file content
 * versions), so an unchanged tree is re-checked in seconds, a changed file is
 * re-emitted, and a new type error still fails the compile.
 *
 * What `tsc --incremental` cannot notice is deleted output: a build-info file
 * that outlives its outputs makes tsc report success without emitting
 * anything — the "Application entry file dist-electron/main.js does not exist"
 * failure that otherwise surfaces at packaging time (release SOP §11.8).
 * `test:memory`, `test:update`, `test:dsh` and `electron:dev` all start with
 * `rimraf dist-electron`, and "delete the output to force a clean compile" is
 * a natural reflex, so both are made safe: the state lives inside the output
 * directory (wiping it wipes the state), and a manifest of the emitted files
 * sits next to it — any recorded file missing means the state is dropped and
 * everything is emitted again.
 *
 * Usage: node scripts/compile-electron.cjs [--project <tsconfig>] [--out-dir <dir>]
 * Defaults: electron-tsconfig.json and its compilerOptions.outDir.
 * Exit codes: tsc's own (0 = compiled, 2 = type errors).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STATE_FILE_NAME = '.tsbuildinfo';
const OUTPUTS_FILE_NAME = '.tsbuildinfo.outputs';

/** compilerOptions.outDir of a tsconfig, resolved against the tsconfig's dir. */
function readOutDir(projectPath) {
  if (!fs.existsSync(projectPath)) return null;
  // tsconfig allows comments and trailing commas; only outDir is needed here,
  // so a tolerant scan beats a JSON.parse that rejects them.
  const match = fs.readFileSync(projectPath, 'utf8').match(/"outDir"\s*:\s*"([^"]+)"/);
  return match ? path.resolve(path.dirname(projectPath), match[1]) : null;
}

function resolveTsc(cwd) {
  // Same binary `npx -p typescript@5 tsc` picks when the project has
  // typescript 5 installed, minus the npx round trip per invocation.
  try {
    return require.resolve('typescript/bin/tsc', { paths: [cwd] });
  } catch {
    return null;
  }
}

function listFiles(root, relative = '') {
  let found = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found = found.concat(listFiles(root, child));
    else if (entry.name !== STATE_FILE_NAME && entry.name !== OUTPUTS_FILE_NAME) found.push(child);
  }
  return found;
}

/** True when the recorded outputs are all still on disk. Unknown = false. */
function outputsIntact(outputDir, manifestPath) {
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(recorded) || recorded.length === 0) return false;
  return recorded.every((relative) => fs.existsSync(path.join(outputDir, relative)));
}

/**
 * @returns {number} tsc's exit code (non-zero on a failed spawn).
 */
function compile({ project = 'electron-tsconfig.json', outDir, cwd = process.cwd(), tsc } = {}) {
  const projectPath = path.resolve(cwd, project);
  const outputDir = outDir ? path.resolve(cwd, outDir) : readOutDir(projectPath);
  if (!outputDir) {
    console.error(`compile-electron: cannot determine outDir from ${projectPath}; pass --out-dir`);
    return 2;
  }
  const stateFile = path.join(outputDir, STATE_FILE_NAME);
  const manifestFile = path.join(outputDir, OUTPUTS_FILE_NAME);
  if (fs.existsSync(stateFile) && !outputsIntact(outputDir, manifestFile)) {
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(manifestFile, { force: true });
  }

  const tscArgs = ['--project', projectPath, '--incremental', '--tsBuildInfoFile', stateFile];
  const localTsc = tsc || resolveTsc(cwd);
  const result = localTsc
    ? spawnSync(process.execPath, [localTsc, ...tscArgs], { cwd, stdio: 'inherit' })
    : spawnSync('npx', ['-p', 'typescript@5', 'tsc', ...tscArgs], {
        cwd,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
  if (result.error) {
    console.error(`compile-electron: could not start tsc: ${result.error.message}`);
    return 2;
  }
  if (result.status === 0) {
    fs.writeFileSync(manifestFile, JSON.stringify(listFiles(outputDir)));
  }
  return result.status ?? 2;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project') options.project = argv[++index];
    else if (argv[index] === '--out-dir') options.outDir = argv[++index];
    else {
      console.error(`compile-electron: unknown argument ${argv[index]}`);
      process.exit(2);
    }
  }
  return options;
}

if (require.main === module) {
  process.exitCode = compile(parseArgs(process.argv.slice(2)));
}

module.exports = { compile, readOutDir, STATE_FILE_NAME, OUTPUTS_FILE_NAME };
