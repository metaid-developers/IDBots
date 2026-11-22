// Live Bot Browser tab state as a pull tool (2026-11-18 Studio long-session
// post-mortem; owner ruling 2026-11-19): the per-turn <browser_context>
// snapshot carried the full open-tab list on EVERY user message — tab state
// alone accumulated to ~63% of one day's context growth (243K chars / 17
// snapshots in the incident session), all near-duplicates that the kernel
// history kept forever. The static browser guide (byte-stable) stays in the
// volatile tail under the dedup gate; the live tab state is a browser_tabs
// tool the model pulls on demand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');
const mainSource = readFileSync(join(here, '../src/main/main.ts'), 'utf8');

test('the volatile tail injects the byte-stable browser guide only, under the dedup gate', () => {
  assert.ok(
    runnerSource.includes("this.getBrowserGuidePrompt && !trustSuppressed && !isProactiveStudioBriefingTurn && shouldInjectVolatile('browser')"),
    'coworkRunner: the browser volatile section must be the dedupable guide (shouldInjectVolatile), not the live tab list',
  );
  assert.ok(
    !runnerSource.includes('getBrowserContextPrompt'),
    'coworkRunner: the old every-turn browser context provider must be fully renamed away',
  );
});

test('main.ts splits the static guide from the live tab state', () => {
  assert.ok(
    mainSource.includes('getBrowserGuidePrompt: async (sessionId: string)'),
    'main.ts: the guide provider must exist',
  );
  assert.ok(
    mainSource.includes('getBrowserTabsPrompt: async (sessionId: string)'),
    'main.ts: the live tabs provider must exist',
  );
  // The guide may teach the tool but must not carry the live tab XML itself.
  const guideStart = mainSource.indexOf('getBrowserGuidePrompt: async');
  const guideEnd = mainSource.indexOf('getBrowserTabsPrompt: async');
  const guideBody = mainSource.slice(guideStart, guideEnd);
  assert.ok(guideStart >= 0 && guideEnd > guideStart, 'main.ts: guide provider must precede the tabs provider');
  assert.ok(
    !guideBody.includes("'<open_tabs>'"),
    'main.ts: the guide provider must not inject the open-tabs list',
  );
  assert.ok(
    guideBody.includes('browser_tabs tool FIRST'),
    'main.ts: the guide must redirect live-tab questions to the browser_tabs tool',
  );
  assert.ok(
    guideBody.includes("browserUri: active.uri"),
    'main.ts: the session↔tab binding refresh must survive as a background side effect (no prompt cost)',
  );
});

test('the browser_tabs tool is registered for browser-type sessions with an empty object schema', () => {
  const toolStart = runnerSource.indexOf("passthrough(\n        'browser_tabs'");
  assert.ok(toolStart > 0, 'coworkRunner: the browser_tabs tool must be registered');
  const toolBody = runnerSource.slice(toolStart, toolStart + 2400);
  assert.ok(
    toolBody.includes("sessionType === 'browser'") || runnerSource.slice(toolStart - 700, toolStart).includes("sessionType === 'browser'"),
    'coworkRunner: the tool must be gated on browser-type (Studio) sessions',
  );
  assert.ok(
    /'browser_tabs',\s*\n[^\n]*\n\s*\{\},/.test(runnerSource),
    'coworkRunner: the tool takes no parameters (complete empty object schema, projection_begin precedent)',
  );
  assert.ok(
    toolBody.includes('this.getBrowserTabsPrompt!'),
    'coworkRunner: the tool handler must serve the live tabs provider',
  );
});

test('the live tabs provider keeps the failure fallback as plain text', () => {
  assert.ok(
    mainSource.includes('Failed to build browser tabs state'),
    'main.ts: the live provider degrades with a notice instead of throwing',
  );
});

test('browser_guide is gated by turn intent and wraps motion-video preference rules cleanly', () => {
  assert.ok(
    runnerSource.includes('shouldInjectBrowserGuideForTurn(prompt, sessionBrowserUri)')
    && runnerSource.includes('filterBrowserGuideForTurn(rawGuide, prompt)'),
    'coworkRunner: <browser_guide> must be gated by turn intent / active external URI and filtered for motion-video intent',
  );
  assert.ok(
    mainSource.includes('<motion_video_guide>') && mainSource.includes('</motion_video_guide>'),
    'main.ts: the motion-video preference block must be isolatable for non-video browser turns',
  );
});
