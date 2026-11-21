import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildBrowserIframeBridgeScript } from '../src/renderer/features/botBrowser/browserIframeBridge.ts';
import {
  BROWSER_TAB_DRAG_MARKERS,
  buildBrowserTabDragScript,
} from '../src/renderer/features/botBrowser/browserTabDragScript.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Wiring for the Bot Browser tab-strip reorder script (PR #177).
 *
 * `browserTabDragScript.ts` emits the JS that runs inside ABC's srcDoc page;
 * `browserIframeBridge.ts` is the injection point. This suite pins the seam
 * between the two — plus the bilingual labels and the test:bot-browser chain
 * entry — so the drag layer can't silently fall out of the build or the suite.
 */

test('the bridge injects the tab-drag script into the ABC page (every wiring marker rides the composed script)', () => {
  const bridge = buildBrowserIframeBridgeScript();
  for (const marker of BROWSER_TAB_DRAG_MARKERS) {
    assert.ok(bridge.includes(marker), `bridge script must carry drag marker ${marker}`);
  }

  // The drag module installs before the bridge IIFE, so a rebuilt srcDoc
  // re-runs both under their own install guards.
  const dragAt = bridge.indexOf('__idbotsBrowserTabDragInstalled');
  const bridgeAt = bridge.indexOf('installIdbotsBrowserIframeBridge');
  assert.ok(dragAt >= 0 && bridgeAt >= 0 && dragAt < bridgeAt, 'the drag script must be injected before the bridge install');
});

test('the emitted drag script embeds the labels the bridge passes it', () => {
  const drag = buildBrowserTabDragScript({ dragHint: 'Drag hint X', armedHint: 'Armed hint Y' });
  assert.ok(drag.includes('"dragHint":"Drag hint X"'), 'the drag hint label must be embedded verbatim');
  assert.ok(drag.includes('"armedHint":"Armed hint Y"'), 'the armed hint label must be embedded verbatim');

  // Empty / whitespace labels fall back to the defaults instead of rendering
  // an empty title/toast.
  const fallback = buildBrowserTabDragScript({ dragHint: '  ', armedHint: '' });
  assert.match(fallback, /Drag to reorder tabs/);
  assert.match(fallback, /Move mode: click a target tab to move it there/);
});

test('both UI languages carry the two drag strings (zh + en)', () => {
  const i18n = read('src/renderer/services/i18n.ts');
  for (const key of ['botBrowserTabDragHint', 'botBrowserTabDragArmedHint']) {
    const occurrences = i18n.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} should exist in both zh and en dictionaries`);
  }
});

test('the drag suites stay wired into the test:bot-browser chain', () => {
  const pkg = JSON.parse(read('package.json'));
  const chain = pkg.scripts['test:bot-browser'];
  assert.match(chain, /tests\/botBrowserTabDragWiring\.test\.mjs/);
  assert.match(chain, /tests\/botBrowserTabDrag\.test\.mjs/);
});
