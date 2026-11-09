import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
// Implementation note (2026-11-10 release review): this file originally
// required dist-electron/main/libs/desktopAxLocator.js — a host-side module
// that was never merged — so none of it ever ran. The locator/envelope code
// actually ships in the kernel plugin required below; the session-level AX
// behaviors (two-call verify budget, screenshot fallback, retries) are
// covered by dsh-runtime/test/desktop-ax-plugin.test.mjs, which this suite
// complements with the pure helpers and the plugin's own tool surface.
const {
  parseFindEnvelope,
  parseActEnvelope,
  selectorOf,
  findArgv,
  actionArgv,
  sanitizeCliEnv,
  buildDesktopAxTool,
} = require('../dsh-runtime/plugins/idbots-desktop-ax.mjs');

/** One agent-desktop JSON envelope as the CLI prints it (single line). */
function envelope(body) {
  return JSON.stringify({ version: '2.6', ...body });
}

const FIND_HIT = (overrides = {}) =>
  envelope({
    ok: true,
    command: 'find',
    data: {
      match: {
        ref_id: '@s1:e1',
        role: 'button',
        name: '计数器 +1',
        value: null,
        interactive: true,
        path: ['window:AX Harness', 'group', 'button:计数器 +1'],
        ...overrides,
      },
      snapshot_id: 's1',
    },
  });

const FIND_EMPTY = envelope({
  ok: true,
  command: 'find',
  data: { matches: [], total_matches: 0, snapshot_id: 's-empty' },
});

const ACT_VERIFIED = envelope({
  ok: true,
  command: 'click',
  data: {
    matched_selector: 'statictext:count=1',
    snapshot_id: 's2',
    after_action: {
      steps: [{ label: 'AXPress', mechanism: 'semantic_api', outcome: 'succeeded' }],
      disposition: { delivery: 'delivered_unverified', retry: 'unsafe' },
    },
  },
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseFindEnvelope accepts both the --first match shape and the matches[] shape', () => {
  const single = parseFindEnvelope(FIND_HIT());
  assert.equal(single.match.ref, '@s1:e1');
  const many = parseFindEnvelope(
    envelope({ ok: true, command: 'find', data: { matches: [{ ref_id: '@s2:e9', role: 'button' }], total_matches: 1 } }),
  );
  assert.equal(many.match.ref, '@s2:e9');
  const empty = parseFindEnvelope(FIND_EMPTY);
  assert.equal(empty.ok, true);
  assert.equal(empty.match, null);
  assert.equal(empty.totalMatches, 0);
});

test('parseActEnvelope reads the post-condition and the delivery disposition', () => {
  const parsed = parseActEnvelope(ACT_VERIFIED);
  assert.equal(parsed.matchedSelector, 'statictext:count=1');
  assert.equal(parsed.delivered, true);
  assert.equal(parsed.disposition.delivery, 'delivered_unverified');
  assert.equal(parsed.disposition.retry, 'unsafe');
});

test('argv builders keep --first and never add read-only retries to acting calls', () => {
  assert.deepEqual(findArgv({ app: 'Notes', role: 'button', name: 'OK', exact: true }), [
    'find',
    '--app',
    'Notes',
    '--role',
    'button',
    '--name',
    'OK',
    '--exact',
    '--first',
  ]);
  assert.deepEqual(actionArgv({ action: 'click', query: {} }, '@s:e1'), ['click', '@s:e1', '--timeout-ms', '5000']);
  assert.equal(selectorOf({ role: 'status', text: 'done' }), 'status:done');
  assert.equal(selectorOf({ text: 'done' }), 'statictext:done');
});

test('sanitizeCliEnv strips the ELECTRON_RUN_AS_NODE trap from the child environment', () => {
  const env = sanitizeCliEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' });
  assert.equal(env.PATH, '/bin');
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in env, false);
});

// ---------------------------------------------------------------------------
// Tool surface (real kernel-plugin execute)
// ---------------------------------------------------------------------------

test('desktop_ax refuses a call with no window scope instead of scanning everything', async () => {
  const tool = buildDesktopAxTool({
    resolveBin: () => ({ bin: '/fake/agent-desktop', source: 'test' }),
    run: async () => ({ stdout: FIND_HIT() }),
    makeLocator: () => ({ locate: async () => ({}), perform: async () => ({}) }),
  });
  await assert.rejects(
    () => tool.execute({ action: 'click', query_text: 'x' }, {}),
    /requires window_id/,
  );
});
