#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function relayResult(result) {
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..', '..');
const cliScript = path.resolve(repoRoot, 'scripts', 'metabot-cli.mjs');

const result = spawnSync(process.execPath, [
  cliScript,
  'publish-service',
  ...process.argv.slice(2),
], {
  cwd: repoRoot,
  env: process.env,
  encoding: 'utf8',
});

relayResult(result);
