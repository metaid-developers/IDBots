import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function resolveScriptDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function resolvePythonPath(
  env = process.env,
  {
    pathExists = fs.existsSync,
    resolveCommand = (candidate) => {
      const result = spawnSync('bash', ['-lc', `command -v ${candidate}`], {
        encoding: 'utf8',
        env,
      });
      if (result.status === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
      return null;
    },
  } = {},
) {
  if (env.PYTHON_PATH?.trim()) {
    return env.PYTHON_PATH.trim();
  }

  for (const candidate of ['/usr/bin/python3']) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  for (const candidate of ['python3', 'python']) {
    const resolved = resolveCommand(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export function buildMacBuilderEnv({
  cwd = path.resolve(resolveScriptDir(), '..'),
  env = process.env,
  pythonPath = resolvePythonPath(env),
} = {}) {
  const nextEnv = { ...env };
  const hasReleaseSigningEnv = Boolean(
    nextEnv.APPLE_ID?.trim()
    && nextEnv.APPLE_APP_SPECIFIC_PASSWORD?.trim(),
  ) || Boolean(
    nextEnv.CSC_LINK?.trim()
    || nextEnv.MAC_CODESIGN_IDENTITY?.trim(),
  );

  if (!nextEnv.CSC_IDENTITY_AUTO_DISCOVERY && !hasReleaseSigningEnv) {
    nextEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }

  if (!pythonPath) {
    return {
      env: nextEnv,
      pythonPath: null,
      shimDir: null,
    };
  }

  const shimDir = path.join(cwd, '.tmp-bin');
  const shimPath = path.join(shimDir, 'python');

  fs.mkdirSync(shimDir, { recursive: true });
  fs.rmSync(shimPath, { force: true });
  fs.symlinkSync(pythonPath, shimPath);

  nextEnv.PYTHON_PATH = pythonPath;
  nextEnv.PATH = nextEnv.PATH
    ? `${shimDir}${path.delimiter}${nextEnv.PATH}`
    : shimDir;

  return {
    env: nextEnv,
    pythonPath,
    shimDir,
  };
}

function main() {
  const projectRoot = path.resolve(resolveScriptDir(), '..');
  const { env } = buildMacBuilderEnv({ cwd: projectRoot });
  const electronBuilderBin = path.join(projectRoot, 'node_modules', '.bin', 'electron-builder');
  const args = process.argv.slice(2);

  const result = spawnSync(electronBuilderBin, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }
  if (result.error) {
    throw result.error;
  }
  process.exit(1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
