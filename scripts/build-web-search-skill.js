#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_SEARCH_SKILL_DIR = path.join(ROOT, 'SKILLs', 'web-search');
const REQUIRED_WEB_SEARCH_PACKAGES = [
  { name: 'express', marker: path.join('node_modules', 'express', 'package.json') },
  { name: 'playwright-core', marker: path.join('node_modules', 'playwright-core', 'package.json') },
  { name: '@types/express', marker: path.join('node_modules', '@types', 'express', 'package.json') },
];

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function quoteCmdArg(value) {
  const stringValue = String(value);
  if (!/[\s"]/u.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, '\\"')}"`;
}

function runCommand(command, args, options = {}) {
  const platform = options.platform || process.platform;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const execOptions = {
    cwd: options.cwd,
    stdio: options.stdio || 'inherit',
  };

  if (platform === 'win32') {
    const commandLine = [command, ...args].map(quoteCmdArg).join(' ');
    execFileSyncImpl('cmd.exe', ['/d', '/s', '/c', commandLine], execOptions);
    return;
  }

  execFileSyncImpl(command, args, execOptions);
}

function resolveMissingWebSearchPackages(skillDir = WEB_SEARCH_SKILL_DIR, existsSyncImpl = fs.existsSync) {
  return REQUIRED_WEB_SEARCH_PACKAGES
    .filter((pkg) => !existsSyncImpl(path.join(skillDir, pkg.marker)))
    .map((pkg) => pkg.name);
}

function ensureWebSearchDependencies(input = {}) {
  const skillDir = input.skillDir || WEB_SEARCH_SKILL_DIR;
  const existsSyncImpl = input.existsSyncImpl || fs.existsSync;
  const execFileSyncImpl = input.execFileSyncImpl || execFileSync;
  const platform = input.platform || process.platform;
  const log = input.log || console.log;
  const missingPackages = resolveMissingWebSearchPackages(skillDir, existsSyncImpl);
  if (missingPackages.length === 0) {
    return false;
  }

  log(
    `[skills] Missing web-search dependencies in current worktree: ${missingPackages.join(', ')}. Running npm ci...`
  );
  runCommand(npmCmd, ['ci'], {
    platform,
    execFileSyncImpl,
    cwd: skillDir,
    stdio: 'inherit',
  });
  return true;
}

function compileWebSearchSkill(input = {}) {
  const rootDir = input.rootDir || ROOT;
  const execFileSyncImpl = input.execFileSyncImpl || execFileSync;
  const platform = input.platform || process.platform;
  runCommand(npmCmd, ['exec', '--', 'tsc', '-p', 'SKILLs/web-search/tsconfig.json'], {
    platform,
    execFileSyncImpl,
    cwd: rootDir,
    stdio: 'inherit',
  });
}

function buildWebSearchSkill(input = {}) {
  ensureWebSearchDependencies(input);
  compileWebSearchSkill(input);
}

function main() {
  buildWebSearchSkill();
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_WEB_SEARCH_PACKAGES,
  resolveMissingWebSearchPackages,
  ensureWebSearchDependencies,
  compileWebSearchSkill,
  buildWebSearchSkill,
};
