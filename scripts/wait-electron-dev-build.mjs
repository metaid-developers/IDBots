#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseable = (filePath) => {
  try {
    // This only checks syntax; it does not execute the bundle.
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(filePath, 'utf8'));
    return true;
  } catch {
    return false;
  }
};

const resolveMainBundlePath = (distDir) => {
  const mainPath = path.join(distDir, 'main.js');
  if (!fs.existsSync(mainPath)) {
    return { mainPath, bundlePath: null, reason: 'dist-electron/main.js is missing' };
  }

  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const match = mainSource.match(/require\(["']\.\/(main-[^"']+\.js)["']\)/);
  if (!match?.[1]) {
    return { mainPath, bundlePath: null, reason: 'dist-electron/main.js has not been rewritten to the Vite main bundle yet' };
  }

  return {
    mainPath,
    bundlePath: path.join(distDir, match[1]),
    reason: '',
  };
};

export function getElectronDevBuildStatus(distDir = path.resolve('dist-electron')) {
  const preloadPath = path.join(distDir, 'preload.js');
  const { mainPath, bundlePath, reason } = resolveMainBundlePath(distDir);

  if (reason) {
    return { ready: false, reason };
  }
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    return { ready: false, reason: 'Vite main bundle is missing' };
  }
  if (!fs.existsSync(preloadPath)) {
    return { ready: false, reason: 'dist-electron/preload.js is missing' };
  }
  if (!parseable(mainPath)) {
    return { ready: false, reason: 'dist-electron/main.js is not parseable yet' };
  }
  if (!parseable(bundlePath)) {
    return { ready: false, reason: `${path.basename(bundlePath)} is not parseable yet` };
  }
  if (!parseable(preloadPath)) {
    return { ready: false, reason: 'dist-electron/preload.js is not parseable yet' };
  }

  return { ready: true, reason: 'ready' };
}

export async function waitForElectronDevBuild(options = {}) {
  const distDir = options.distDir ?? path.resolve('dist-electron');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = getElectronDevBuildStatus(distDir);

  while (!lastStatus.ready && Date.now() < deadline) {
    await sleep(intervalMs);
    lastStatus = getElectronDevBuildStatus(distDir);
  }

  if (!lastStatus.ready) {
    throw new Error(`Timed out waiting for Electron dev build: ${lastStatus.reason}`);
  }
  return lastStatus;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('dist-electron');
  waitForElectronDevBuild({ distDir })
    .then(() => {
      console.log(`[electron:dev] Electron bundle ready: ${distDir}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
