#!/usr/bin/env node
/**
 * Voice-input e2e runner (voice P0, subtask #10).
 *
 * Runs the voice spec against the MOCK dev server (port 5196, same base as
 * run-mobile-e2e.mjs) plus the standalone voice stub gateway
 * (scripts/voice-stub-gateway.mjs on 8791, injected via VITE_VOICE_WS_URL).
 * The browser uses Chromium's fake media device, so "speech" is a synthetic
 * tone but the WHOLE frontend pipeline is real: getUserMedia → AudioWorklet →
 * PCM chunker → WebSocket → stub → streaming partials → draft backfill.
 *
 * Scope: --project=pixel7 only (fake-media flags are Chromium switches;
 * iOS Safari behavior is covered by the compatibility path + delivery notes,
 * honest NOT-RUN on real iOS hardware in this slice).
 *
 * Usage: node scripts/run-mobile-e2e-voice.mjs [extra playwright args]
 * Spec gate: only specs tagged @voice run (they self-skip without
 * VOICE_E2E=1 so the regular suites are untouched).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.E2E_PORT || '5196';
const BASE_URL = `http://localhost:${PORT}`;
const VOICE_STUB_PORT = process.env.VOICE_STUB_PORT || '8791';

const viteBin = path.join(repoRoot, 'node_modules', '.bin', 'vite');
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');

function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${url}/login`, { cache: 'no-store' });
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${url}/login`));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

function waitForStdout(child, matcher, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`voice stub did not print ${matcher}`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(matcher)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
}

const children = [];
function cleanup() {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

async function main() {
  const stub = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'voice-stub-gateway.mjs'), '--port', VOICE_STUB_PORT], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(stub);
  await waitForStdout(stub, 'listening on');

  const vite = spawn(viteBin, ['--config', 'vite.mobile.config.ts', '--port', PORT, '--strictPort'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VITE_MOBILE_MOCK: '1',
      MOBILE_FORCE_COLOR: '0',
      VITE_VOICE_WS_URL: `ws://127.0.0.1:${VOICE_STUB_PORT}/voice`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(vite);
  vite.stdout.on('data', () => {});
  vite.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(BASE_URL);
    const extraArgs = process.argv.slice(2);
    const playwright = spawn(
      process.execPath,
      [playwrightCli, 'test', '--project=pixel7', '--grep', '@voice', ...extraArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          E2E_BASE_URL: BASE_URL,
          VOICE_E2E: '1',
          MOBILE_FORCE_COLOR: '0',
          VOICE_SHOT_DIR: process.env.VOICE_SHOT_DIR || 'test-results/voice-shots',
        },
        stdio: 'inherit',
      },
    );
    children.push(playwright);
    playwright.on('exit', (code) => {
      cleanup();
      process.exit(code ?? 1);
    });
  } catch (error) {
    console.error(error);
    cleanup();
    process.exit(1);
  }
}

await main();
