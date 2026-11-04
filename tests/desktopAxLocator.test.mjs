import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  DesktopAxLocator,
  parseFindEnvelope,
  parseActEnvelope,
  selectorOf,
  findArgv,
  actionArgv,
  sanitizeCliEnv,
} = require('../dist-electron/main/libs/desktopAxLocator.js');
const { buildDesktopAxAgentTools } = require('../dist-electron/main/libs/desktopAxAgentTools.js');

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

const FIND_ERROR = (code, retry = 'unsafe') =>
  envelope({
    ok: false,
    command: 'find',
    error: { code, message: `${code} while reading the tree`, disposition: { delivery: 'not_delivered', retry } },
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

const ACT_NO_MATCH = envelope({
  ok: true,
  command: 'click',
  data: {
    snapshot_id: 's2',
    after_action: {
      steps: [{ label: 'AXPress', mechanism: 'semantic_api', outcome: 'succeeded' }],
      disposition: { delivery: 'delivered_unverified', retry: 'unsafe' },
    },
  },
});

/** Scripted CLI runner that records every spawn (the 2-call budget is asserted on it). */
function fakeCli(script) {
  const calls = [];
  return {
    bin: '/fake/agent-desktop',
    calls,
    async run(input) {
      calls.push({ argv: input.argv, timeoutMs: input.timeoutMs });
      const reply = await script(input.argv, calls.length);
      return { exitCode: 0, stdout: '', stderr: '', ms: 7, timedOut: false, ...reply };
    },
  };
}

function fakeVisual({ png = Buffer.from('fake-png'), pointer = null } = {}) {
  const seen = { observe: [], pointer: [] };
  const port = {
    async observe(input) {
      seen.observe.push(input);
      return {
        bounds: input?.bounds ?? { x: 100, y: 200, width: 640, height: 420 },
        scaleFactor: 2,
        png,
        screenshotPath: '/tmp/fake-visual.png',
        bytes: png.length,
        note: 'fake visual port',
      };
    },
  };
  if (pointer) {
    port.clickPoint = async (input) => {
      seen.pointer.push(input);
      return pointer(input);
    };
  }
  return { port, seen };
}

function makeLocator(overrides = {}) {
  const cli = overrides.cli ?? fakeCli(() => ({ stdout: FIND_HIT() }));
  const visual = overrides.visual ?? fakeVisual();
  const locator = new DesktopAxLocator({
    cli,
    visual: visual.port,
    retryDelayMs: 0,
    ...overrides.options,
  });
  return { locator, cli, visual };
}

// ---------------------------------------------------------------------------
// The fast path: read → act → verify in exactly two process calls.
// ---------------------------------------------------------------------------

test('AX hit: click is one find plus one acting call carrying the verification wait', async () => {
  const cli = fakeCli((argv, n) => ({ stdout: n === 1 ? FIND_HIT() : ACT_VERIFIED }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0 });

  const outcome = await locator.perform({
    action: 'click',
    query: { windowId: 'w-42', role: 'button', text: '计数器' },
    expect: { role: 'statictext', text: 'count=1' },
  });

  assert.equal(outcome.layer, 'ax');
  assert.equal(outcome.ref, '@s1:e1');
  assert.equal(outcome.verification.state, 'verified');
  assert.equal(outcome.delivery.delivery, 'delivered_unverified');
  assert.equal(outcome.calls.length, 2, 'read → act → verify must stay at two process calls');

  assert.deepEqual(cli.calls[0].argv, ['find', '--window-id', 'w-42', '--role', 'button', '--text', '计数器', '--first']);
  assert.deepEqual(cli.calls[1].argv, [
    'click',
    '@s1:e1',
    '--timeout-ms',
    '5000',
    '--wait-for',
    'statictext:count=1',
    '--wait-timeout',
    '5000',
  ]);
  assert.ok(
    cli.calls.every((call) => !call.argv.includes('snapshot')),
    'the fast path must never take a full snapshot',
  );
});

test('AX hit without an expectation is reported unverified, never assumed verified', async () => {
  const cli = fakeCli((argv, n) => ({ stdout: n === 1 ? FIND_HIT() : ACT_NO_MATCH }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0 });

  const outcome = await locator.perform({ action: 'click', query: { windowId: 'w-42', role: 'button', text: 'x' } });
  assert.equal(outcome.verification.state, 'unverified');
  assert.match(outcome.verification.detail, /post-condition was never read back/);
  assert.equal(outcome.calls.length, 2);
});

test('a click whose post-condition never appears fails verification but keeps the delivery report', async () => {
  const cli = fakeCli((argv, n) => ({
    stdout:
      n === 1
        ? FIND_HIT()
        : envelope({
            ok: false,
            command: 'click',
            error: {
              code: 'WAIT_TIMEOUT',
              message: 'the selector never appeared',
              disposition: { delivery: 'delivered_unverified', retry: 'unsafe' },
            },
          }),
    exitCode: n === 1 ? 0 : 1,
  }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0 });

  const outcome = await locator.perform({
    action: 'click',
    query: { windowId: 'w-42', role: 'button', text: 'x' },
    expect: { text: 'count=1' },
  });
  assert.equal(outcome.verification.state, 'failed');
  assert.equal(outcome.verification.errorCode, 'WAIT_TIMEOUT');
  assert.equal(outcome.delivered, true, 'the press landed even though the proof did not');
  assert.equal(outcome.calls.length, 2);
});

test('an ok acting envelope without the selector is a failed verification, not a pass', async () => {
  const cli = fakeCli((argv, n) => ({ stdout: n === 1 ? FIND_HIT() : ACT_NO_MATCH }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0 });
  const outcome = await locator.perform({
    action: 'click',
    query: { windowId: 'w-42', role: 'button', text: 'x' },
    expect: { text: 'count=1' },
  });
  assert.equal(outcome.verification.state, 'failed');
  assert.match(outcome.verification.detail, /returned ok without matching/);
});

test('type / set-value / scroll reuse the same two-call shape with their own argv', async () => {
  for (const [input, expected] of [
    [{ action: 'type', text: 'hello' }, ['type', '@s1:e1', 'hello', '--timeout-ms', '5000']],
    [{ action: 'set-value', value: '42' }, ['set-value', '@s1:e1', '42', '--timeout-ms', '5000']],
    [
      { action: 'scroll', direction: 'down', amount: 3 },
      ['scroll', '@s1:e1', '--direction', 'down', '--amount', '3', '--timeout-ms', '5000'],
    ],
  ]) {
    const cli = fakeCli((argv, n) => ({ stdout: n === 1 ? FIND_HIT({ role: 'textfield' }) : ACT_VERIFIED }));
    const { port } = fakeVisual();
    const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0 });
    const outcome = await locator.perform({ ...input, query: { windowId: 'w-42', role: 'textfield', text: 'f' } });
    assert.equal(outcome.layer, 'ax');
    assert.deepEqual(cli.calls[1].argv.slice(0, expected.length), expected);
    assert.equal(cli.calls.length, 2);
  }
});

// ---------------------------------------------------------------------------
// Readable-empty vs error: the two failure shapes must never be conflated.
// ---------------------------------------------------------------------------

test('readable empty is retried a bounded number of times, then falls back to the visual port', async () => {
  const cli = fakeCli(() => ({ stdout: FIND_EMPTY }));
  const { port, seen } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0, emptyReadRetries: 2 });

  const outcome = await locator.perform({
    action: 'click',
    query: { windowId: 'w-42', text: 'custom control' },
    visualPoint: { x: 120, y: 60 },
  });

  assert.equal(outcome.layer, 'visual');
  assert.equal(outcome.reason, 'no_ax_match');
  assert.equal(outcome.calls.length, 3, 'initial read plus two bounded retries');
  assert.equal(seen.observe.length, 1);
  assert.deepEqual(outcome.clickPoint, { x: 120, y: 60 });
  assert.equal(outcome.delivery, null, 'no pointer was injected, so nothing may claim delivery');
  assert.ok(
    cli.calls.every((call) => call.argv[0] === 'find'),
    'a miss must never be followed by an acting call',
  );
});

test('an unreadable tree is reported as ax_unavailable and stays distinguishable from an empty read', async () => {
  const cli = fakeCli(() => ({ stdout: FIND_ERROR('PERM_DENIED', 'unsafe'), exitCode: 1 }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0 });

  const outcome = await locator.locate({ windowId: 'w-42', text: 'x' });
  assert.equal(outcome.layer, 'visual');
  assert.equal(outcome.reason, 'ax_unavailable');
  assert.equal(outcome.calls.length, 1, 'a non-retry-safe error is not retried');
  assert.match(outcome.detail, /PERM_DENIED/);
});

test('a retry-safe error is retried exactly once', async () => {
  let reads = 0;
  const cli = fakeCli(() => {
    reads += 1;
    return reads === 1
      ? { stdout: FIND_ERROR('WINDOW_NOT_FOUND', 'safe'), exitCode: 1 }
      : { stdout: FIND_HIT() };
  });
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0, errorRetries: 1 });

  const outcome = await locator.locate({ windowId: 'w-42', role: 'button', text: 'x' });
  assert.equal(outcome.layer, 'ax');
  assert.equal(outcome.attempts, 2);
});

test('a matched node with no addressable ref falls back instead of clicking a guess', async () => {
  const cli = fakeCli(() => ({ stdout: FIND_HIT({ ref_id: null, role: 'statictext', interactive: false }) }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0 });

  const outcome = await locator.perform({ action: 'click', query: { windowId: 'w-42', text: 'count=' } });
  assert.equal(outcome.layer, 'visual');
  assert.match(outcome.detail, /without an addressable ref/);
  assert.equal(cli.calls.length, 1);
});

test('an unparseable envelope is an error, not a miss', async () => {
  const cli = fakeCli(() => ({ stdout: 'not json at all' }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0, errorRetries: 0 });
  const outcome = await locator.locate({ windowId: 'w-42', text: 'x' });
  assert.equal(outcome.layer, 'visual');
  assert.equal(outcome.reason, 'ax_unavailable');
  assert.match(outcome.detail, /UNPARSEABLE_ENVELOPE/);
});

// ---------------------------------------------------------------------------
// Visual branch contract
// ---------------------------------------------------------------------------

test('visual fallback delivers through the injected pointer when one exists', async () => {
  const cli = fakeCli(() => ({ stdout: FIND_EMPTY }));
  const { port, seen } = fakeVisual({ pointer: () => ({ delivered: true, mechanism: 'electron-send-input-event', detail: 'synthetic' }) });
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0, emptyReadRetries: 0 });

  const outcome = await locator.perform({
    action: 'click',
    query: { windowId: 'w-42', text: 'canvas pad' },
    visualPoint: { x: 10, y: 20 },
    visualBounds: { x: 100, y: 200, width: 640, height: 420 },
  });

  assert.equal(outcome.layer, 'visual');
  assert.equal(outcome.delivery.delivered, true);
  assert.equal(seen.pointer.length, 1);
  assert.deepEqual({ x: seen.pointer[0].x, y: seen.pointer[0].y }, { x: 10, y: 20 });
  assert.deepEqual(seen.observe[0].bounds, { x: 100, y: 200, width: 640, height: 420 });
});

test('a failing visual port degrades to a detail message instead of throwing', async () => {
  const cli = fakeCli(() => ({ stdout: FIND_EMPTY }));
  const port = { observe: async () => { throw new Error('screen recording denied'); } };
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0, emptyReadRetries: 0 });
  const outcome = await locator.locate({ windowId: 'w-42', text: 'x' });
  assert.equal(outcome.layer, 'visual');
  assert.equal(outcome.observation, null);
  assert.match(outcome.detail, /screen recording denied/);
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
// Tool surface
// ---------------------------------------------------------------------------

function toolHarness(controlOverrides = {}) {
  const cli = fakeCli((argv, n) => ({ stdout: n === 1 ? FIND_HIT() : ACT_VERIFIED }));
  const { port } = fakeVisual();
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0, emptyReadRetries: 0 });
  const tools = buildDesktopAxAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control: { locator, ...controlOverrides },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { cli, byName, tool: byName.desktop_ax };
}

test('the tool surface names the four actions the existing desktop tools use', async () => {
  const { tool } = toolHarness();
  const shape = tool.schema.action;
  const values = shape?._def?.values ?? shape?.options ?? [];
  assert.deepEqual([...values].sort(), ['click', 'locate', 'scroll', 'set-value', 'type'].sort());
});

test('desktop_ax click returns the two-call verification summary', async () => {
  const { tool } = toolHarness();
  const result = await tool.handler({
    action: 'click',
    window_id: 'w-42',
    role: 'button',
    query_text: '计数器',
    expect_role: 'statictext',
    expect_text: 'count=1',
  });
  const summary = JSON.parse(result.content[0].text);
  assert.equal(summary.layer, 'ax');
  assert.equal(summary.verified, 'verified');
  assert.equal(summary.calls, 2);
  assert.equal(result.content[0].type, 'text');
});

test('desktop_ax refuses a call with no window scope instead of scanning everything', async () => {
  const { tool } = toolHarness();
  const result = await tool.handler({ action: 'click', query_text: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires window_id.*or app/);
});

test('desktop_ax fails closed when the computer-use gate is off', async () => {
  const { tool } = toolHarness({ isEnabled: () => false });
  const result = await tool.handler({ action: 'locate', window_id: 'w-42', query_text: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /disabled for this bot/);
});

test('a visual fallback result carries the screenshot inline for the model', async () => {
  const cli = fakeCli(() => ({ stdout: FIND_EMPTY }));
  const { port } = fakeVisual({ png: Buffer.from('png-bytes-here') });
  const locator = new DesktopAxLocator({ cli, visual: port, retryDelayMs: 0, emptyReadRetries: 0 });
  const tools = buildDesktopAxAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control: { locator },
  });
  const result = await tools[0].handler({ action: 'click', window_id: 'w-42', query_text: 'canvas', point: { x: 5, y: 6 } });
  assert.equal(result.content.length, 2);
  assert.equal(result.content[1].type, 'image');
  assert.equal(Buffer.from(result.content[1].data, 'base64').toString(), 'png-bytes-here');
  const summary = JSON.parse(result.content[0].text);
  assert.equal(summary.layer, 'visual');
  assert.equal(summary.reason, 'no_ax_match');
});
