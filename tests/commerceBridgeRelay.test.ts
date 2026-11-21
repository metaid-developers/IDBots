// The commerce relay lives inside buildBrowserIframeBridgeScript()'s injected
// template string — a typo there ships broken JS into the Bot Browser shell.
// This test pulls the real built script out of the module and syntax-checks
// it with node --check, plus pins the relay's load-bearing security markers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrowserIframeBridgeScript } from '../src/renderer/features/botBrowser/browserIframeBridge.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('injected bridge script is valid JS and carries the commerce relay markers', () => {
  const script = buildBrowserIframeBridgeScript();
  assert.ok(script.length > 1000, 'bridge script looks substantial');
  const tmp = path.join(os.tmpdir(), `idbots-bridge-${Date.now()}.js`);
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  // Relay claims exactly the three commerce methods, capture-phase, and stops
  // propagation so ABC never answers unsupported_method for them.
  for (const method of [
    'browser.commerce.askTwinToBuy',
    'browser.social.addFriendPrompt',
    'browser.commerce.openPromoPack',
  ]) {
    assert.ok(script.includes(`'${method}'`), `relay registers ${method}`);
  }
  assert.match(script, /stopImmediatePropagation/);
  assert.match(script, /addEventListener\('message', function \(event\) \{\s*\n\s*var data = event && event\.data;\s*\n\s*if \(!data \|\| typeof data !== 'object' \|\| data\.type !== 'agent-browser:request'\) return;/);
  assert.match(script, /, true\);/); // capture-phase registration
  assert.match(script, /commerce-intent'/);
  assert.match(script, /agent-browser:response/);
  // No crypto/payment side effects in the injected relay: transport only.
  assert.ok(!/writeMetaIdPin|sendPrivateChat|buyNft|buyMrc721/.test(script));
});
