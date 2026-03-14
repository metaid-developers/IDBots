/**
 * Self-test for Gig Square step 2: transfer worker + optional broadcast.
 * 1. Compile: npm run compile:electron
 * 2. Set env: IDBOTS_METABOT_MNEMONIC, IDBOTS_METABOT_PATH (optional, default m/44'/10001'/0'/0/0)
 * 3. Run: node scripts/gig-square-self-test.mjs [toAddress] [amountSPACE]
 *    Example: node scripts/gig-square-self-test.mjs 1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za 0.001
 * If --broadcast is passed, the built tx is broadcast (use with care).
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const toAddress = process.argv[2] || '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';
const amountSpace = process.argv[3] || '0.001';
const doBroadcast = process.argv.includes('--broadcast');

// 0.001 SPACE = 100000 sats (1 SPACE = 10^8 sats)
const amountSats = Math.floor(parseFloat(amountSpace) * 1e8);
if (!Number.isFinite(amountSats) || amountSats < 600) {
  console.error('Invalid amount (min 600 sats). Use e.g. 0.001');
  process.exit(1);
}

const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
const pathStr = process.env.IDBOTS_METABOT_PATH?.trim() || "m/44'/10001'/0'/0/0";

if (!mnemonic) {
  console.error('Set IDBOTS_METABOT_MNEMONIC (e.g. from your first MetaBot wallet).');
  process.exit(1);
}

const workerPath = path.join(root, 'dist-electron', 'libs', 'transferMvcWorker.js');
if (!existsSync(workerPath)) {
  console.error('Worker not found. Run: npm run compile:electron');
  process.exit(1);
}

const payload = JSON.stringify({
  toAddress,
  amountSats,
  feeRate: 1,
});

console.log('[GigSquare self-test] Running MVC worker', { toAddress, amountSats, feeRate: 1 });
console.log('[GigSquare self-test] Worker path:', workerPath);

const electronPath = getElectronPath();
if (!electronPath) {
  console.error('Electron not found. Run from project root with npm install.');
  process.exit(1);
}

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  IDBOTS_METABOT_MNEMONIC: mnemonic,
  IDBOTS_METABOT_PATH: pathStr,
};

const child = spawn(electronPath, [workerPath], {
  cwd: root,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout?.on('data', (d) => { stdout += d.toString(); });
child.stderr?.on('data', (d) => { stderr += d.toString(); });
child.stdin?.write(payload, () => child.stdin?.end());
child.on('error', (err) => {
  console.error('[GigSquare self-test] spawn error:', err.message);
  process.exit(1);
});

child.on('close', (code) => {
  if (stderr.trim()) console.log('[GigSquare self-test] stderr:', stderr.trim());
  if (code !== 0) {
    console.error('[GigSquare self-test] worker exit code:', code);
    console.error(stdout.trim() || stderr.trim());
    process.exit(1);
  }
  try {
    const result = JSON.parse(stdout.trim());
    if (!result.success || !result.txHex) {
      console.error('[GigSquare self-test] worker returned error:', result.error || 'no txHex');
      process.exit(1);
    }
    console.log('[GigSquare self-test] Worker built tx, txHex length:', result.txHex.length);
    if (doBroadcast) {
      broadcastMvc(result.txHex).then((txId) => {
        console.log('[GigSquare self-test] Broadcast success txId:', txId);
      }).catch((err) => {
        console.error('[GigSquare self-test] Broadcast failed:', err.message);
        process.exit(1);
      });
    } else {
      console.log('[GigSquare self-test] OK (no broadcast). Use --broadcast to send.');
    }
  } catch (e) {
    console.error('[GigSquare self-test] parse error:', e.message);
    console.error(stdout);
    process.exit(1);
  }
});

function getElectronPath() {
  try {
    const p = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    if (existsSync(p)) return p;
    const win = path.join(root, 'node_modules', '.bin', 'electron');
    if (existsSync(win)) return win;
    return require.resolve('electron');
  } catch {
    return null;
  }
}

async function broadcastMvc(rawTx) {
  const res = await fetch('https://www.metalet.space/wallet-api/v3/tx/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: 'livenet', rawTx }),
  });
  const data = await res.json();
  if (data?.code !== 0 && data?.code != null) throw new Error(data?.message || 'Broadcast failed');
  return data?.txid ?? data?.txId ?? data?.data ?? '';
}
