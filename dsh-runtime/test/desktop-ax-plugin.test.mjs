// Unit + wiring tests for the AX-first desktop locator plugin.
//
// Runs under plain node (no GUI, no permissions): the CLI is a fake `run`
// function, and the two integration seams that could hide a defect — the real
// kernel tool compiler and the real runtime-config generator — are exercised
// against the real modules.
//
// Run: node test/desktop-ax-plugin.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AgentDesktopBinaryError,
  DEFAULT_RUNTIME_ROOT,
  DesktopAxLocator,
  actionArgv,
  agentDesktopCandidates,
  apply,
  buildDesktopAxTool,
  findArgv,
  parseActEnvelope,
  parseFindEnvelope,
  resolveAgentDesktopBin,
  sanitizeCliEnv,
  selectorOf,
} from '../plugins/idbots-desktop-ax.mjs'
import { defineTool, parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const envelope = (body) => JSON.stringify({ version: '2.6', ...body })

const FIND_HIT = (overrides = {}) => envelope({
  ok: true,
  command: 'find',
  data: {
    match: {
      ref_id: '@s1:e1',
      role: 'button',
      name: '计数器 +1',
      value: null,
      interactive: true,
      path: ['window:harness', 'group', 'button:计数器 +1'],
      ...overrides,
    },
    snapshot_id: 's1',
  },
})

const FIND_EMPTY = envelope({ ok: true, command: 'find', data: { matches: [], total_matches: 0, snapshot_id: 's-empty' } })

const FIND_ERROR = (code, retry = 'unsafe') => envelope({
  ok: false,
  command: 'find',
  error: { code, message: `${code} while reading the tree`, disposition: { delivery: 'not_delivered', retry } },
})

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
})

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
})

const SCREENSHOT_OK = envelope({
  ok: true,
  command: 'screenshot',
  data: { format: 'png', height: 1064, width: 1504, path: '/tmp/fake-shot.png', scale_factor: 2 },
})

const WINDOWS_OK = envelope({
  ok: true,
  command: 'list-windows',
  data: [{ id: 'w-1', app_name: 'Harness', title: 'Harness', bounds: { x: 495, y: 324, width: 720, height: 460 } }],
})

/** Scripted runner: records every argv and answers by command name. */
function fakeRun(script) {
  const calls = []
  const run = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs })
    const reply = await script(argv, calls.length)
    return { exitCode: 0, stdout: '', stderr: '', ms: 7, timedOut: false, ...reply }
  }
  return { run, calls }
}

function makeLocator(overrides = {}) {
  const { run, calls } = overrides.runner ?? fakeRun((argv, n) => ({ stdout: n === 1 ? FIND_HIT() : ACT_VERIFIED }))
  const locator = new DesktopAxLocator({ run, bin: '/fake/agent-desktop', retryDelayMs: 0, ...overrides.options })
  return { locator, calls }
}

// ---------------------------------------------------------------------------
// Binary resolution: AGD_BIN → bundled resource → PATH
// ---------------------------------------------------------------------------

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return file
}

const fakePackageBin = (root) => path.join(root, 'node_modules', 'agent-desktop', 'bin', `agent-desktop-${process.platform}-${process.arch}`)

test('binary resolution: the installed dsh-runtime dependency is found without AGD_BIN', () => {
  const resolved = resolveAgentDesktopBin({ runtimeRoot: DEFAULT_RUNTIME_ROOT, env: { PATH: '' }, platform: process.platform, arch: process.arch })
  assert.equal(resolved.source, 'runtime-dependency')
  assert.ok(resolved.bin.startsWith(path.join(DEFAULT_RUNTIME_ROOT, 'node_modules', 'agent-desktop', 'bin')))
  assert.ok(fs.statSync(resolved.bin).isFile(), 'the resolved path must be a real file')
})

test('binary resolution: AGD_BIN wins over everything else', () => {
  const dir = tempDir('agd-bin-')
  const bin = writeExecutable(path.join(dir, 'agent-desktop'))
  const resolved = resolveAgentDesktopBin({
    env: { AGD_BIN: bin, PATH: '' },
    runtimeRoot: path.join(dir, 'missing-runtime'),
    platform: process.platform,
    arch: process.arch,
  })
  assert.equal(resolved.bin, bin)
  assert.equal(resolved.source, 'AGD_BIN')
})

test('binary resolution: a packaged layout resolves through Resources/dsh-runtime', () => {
  const dir = tempDir('agd-packaged-')
  const resources = path.join(dir, 'Resources')
  const packaged = writeExecutable(fakePackageBin(path.join(resources, 'dsh-runtime')))
  const resolved = resolveAgentDesktopBin({
    env: { PATH: '' },
    runtimeRoot: path.join(dir, 'not-there'),
    resourcesPath: resources,
    platform: process.platform,
    arch: process.arch,
  })
  assert.equal(resolved.bin, packaged)
  assert.equal(resolved.source, 'runtime-dependency')
})

test('binary resolution: PATH is the last resort', () => {
  const dir = tempDir('agd-path-')
  writeExecutable(path.join(dir, 'agent-desktop'))
  const resolved = resolveAgentDesktopBin({
    env: { PATH: dir },
    runtimeRoot: path.join(dir, 'none'),
    platform: process.platform,
    arch: process.arch,
  })
  assert.equal(resolved.source, 'PATH')
})

test('binary resolution: a miss fails loudly with every candidate and a fix, never ENOENT', () => {
  const dir = tempDir('agd-missing-')
  let error
  try {
    resolveAgentDesktopBin({ env: { PATH: path.join(dir, 'empty') }, runtimeRoot: dir, platform: process.platform, arch: process.arch })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof AgentDesktopBinaryError)
  assert.equal(error.code, 'AGENT_DESKTOP_NOT_FOUND')
  assert.match(error.message, /agent-desktop CLI not found/)
  assert.match(error.message, /AGD_BIN=/)
  assert.match(error.message, /pnpm --dir dsh-runtime add agent-desktop/)
  assert.ok(error.looked.length >= 2, 'the error must list what was tried')
  assert.ok(error.looked.every((entry) => entry.path && entry.source))
})

test('binary resolution: AGD_BIN pointing at nothing says so instead of silently falling through', () => {
  const dir = tempDir('agd-bad-')
  let error
  try {
    resolveAgentDesktopBin({ env: { AGD_BIN: path.join(dir, 'nope'), PATH: '' }, runtimeRoot: dir, platform: process.platform, arch: process.arch })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof AgentDesktopBinaryError)
  assert.match(error.message, /AGD_BIN is set to/)
})

test('candidate list covers all three tiers in priority order', () => {
  const candidates = agentDesktopCandidates({
    env: { AGD_BIN: '/x/agent-desktop', PATH: '/usr/bin' },
    runtimeRoot: '/rt',
    resourcesPath: '/app/Resources',
    platform: 'darwin',
    arch: 'arm64',
  })
  const sources = candidates.map((entry) => entry.source)
  assert.equal(sources[0], 'AGD_BIN')
  assert.ok(sources.indexOf('runtime-dependency') > 0)
  assert.ok(sources.indexOf('PATH') > sources.indexOf('runtime-dependency'))
})

test('the CLI child never inherits the ELECTRON_RUN_AS_NODE trap', () => {
  const env = sanitizeCliEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' })
  assert.equal(env.PATH, '/bin')
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in env, false)
})

// ---------------------------------------------------------------------------
// The two-call fast path
// ---------------------------------------------------------------------------

test('AX hit: read → act → verify is exactly two process calls, never a snapshot', async () => {
  const { locator, calls } = makeLocator()
  const outcome = await locator.perform({
    action: 'click',
    query: { windowId: 'w-1', role: 'button', text: '计数器' },
    expect: { role: 'statictext', text: 'count=1' },
  })

  assert.equal(outcome.layer, 'ax')
  assert.equal(outcome.verification.state, 'verified')
  assert.equal(outcome.calls.length, 2)
  assert.deepEqual(calls[0].argv, ['find', '--window-id', 'w-1', '--role', 'button', '--text', '计数器', '--first'])
  assert.deepEqual(calls[1].argv, ['click', '@s1:e1', '--timeout-ms', '5000', '--wait-for', 'statictext:count=1', '--wait-timeout', '5000'])
  assert.ok(calls.every((call) => !call.argv.includes('snapshot')), 'the fast path never snapshots')
})

test('an action without an expectation is unverified, never assumed to have worked', async () => {
  const { run } = fakeRun((argv, n) => ({ stdout: n === 1 ? FIND_HIT() : ACT_NO_MATCH }))
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
  const outcome = await locator.perform({ action: 'click', query: { windowId: 'w-1', role: 'button', text: 'x' } })
  assert.equal(outcome.verification.state, 'unverified')
  assert.match(outcome.verification.detail, /never read back/)
})

test('a post-condition that never appears fails verification but keeps the delivery report', async () => {
  const { run } = fakeRun((argv, n) => ({
    stdout: n === 1 ? FIND_HIT() : envelope({
      ok: false,
      command: 'click',
      error: { code: 'WAIT_TIMEOUT', message: 'selector never appeared', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } },
    }),
    exitCode: n === 1 ? 0 : 1,
  }))
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
  const outcome = await locator.perform({ action: 'click', query: { windowId: 'w-1', role: 'button', text: 'x' }, expect: { text: 'count=1' } })
  assert.equal(outcome.verification.state, 'failed')
  assert.equal(outcome.verification.errorCode, 'WAIT_TIMEOUT')
  assert.equal(outcome.delivered, true, 'the press may have landed even though the proof did not')
})

test('a transient read failure on the acting call is re-read once before being called failed', async () => {
  // Measured for real: the press landed (DOM advanced) but the post-condition
  // wait answered APP_UNRESPONSIVE. Reporting that as "failed" would be a false
  // negative, so the layer re-reads once, read-only, and says how it recovered.
  const { run, calls } = fakeRun((argv, n) => {
    if (n === 1) return { stdout: FIND_HIT() }
    if (n === 2) {
      return {
        stdout: envelope({
          ok: false,
          command: 'click',
          error: { code: 'APP_UNRESPONSIVE', message: 'Accessibility surface read was incomplete', disposition: { delivery: 'delivered_unverified', retry: 'safe' } },
        }),
        exitCode: 1,
      }
    }
    return { stdout: FIND_HIT({ role: 'statictext', name: 'count=1', value: 'count=1' }) }
  })
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
  const outcome = await locator.perform({
    action: 'click',
    query: { windowId: 'w-1', role: 'button', text: '计数器' },
    expect: { role: 'statictext', text: 'count=1' },
  })
  assert.equal(outcome.verification.state, 'verified')
  assert.equal(outcome.verification.recoveredAfter, 'APP_UNRESPONSIVE')
  assert.equal(calls.length, 3, 'the happy path stays at two calls; only this recovery path costs a third')
  assert.equal(calls[2].argv[0], 'find')
})

test('type / set-value / scroll share the same shape with their own argv', async () => {
  const expected = {
    type: ['type', '@s1:e1', 'hello', '--timeout-ms', '5000'],
    'set-value': ['set-value', '@s1:e1', '42', '--timeout-ms', '5000'],
    scroll: ['scroll', '@s1:e1', '--direction', 'down', '--amount', '3', '--timeout-ms', '5000'],
  }
  for (const [action, argv] of Object.entries(expected)) {
    const { run, calls } = fakeRun((a, n) => ({ stdout: n === 1 ? FIND_HIT({ role: 'textfield' }) : ACT_VERIFIED }))
    const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
    await locator.perform({
      action,
      query: { windowId: 'w-1', role: 'textfield', text: 'f' },
      value: action === 'type' ? 'hello' : '42',
      direction: 'down',
      amount: 3,
    })
    assert.deepEqual(calls[1].argv, argv)
    assert.equal(calls.length, 2)
  }
})

// ---------------------------------------------------------------------------
// Readable-empty vs error
// ---------------------------------------------------------------------------

test('a readable empty tree is retried a bounded number of times, then falls back to a screenshot', async () => {
  const { run, calls } = fakeRun((argv) => {
    if (argv[0] === 'find') return { stdout: FIND_EMPTY }
    if (argv[0] === 'screenshot') return { stdout: SCREENSHOT_OK }
    if (argv[0] === 'list-windows') return { stdout: WINDOWS_OK }
    throw new Error(`unexpected argv ${argv.join(' ')}`)
  })
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
  const outcome = await locator.perform({ action: 'click', query: { windowId: 'w-1', text: 'custom control' } })

  assert.equal(outcome.layer, 'visual')
  assert.equal(outcome.reason, 'no_ax_match')
  const finds = calls.filter((call) => call.argv[0] === 'find')
  assert.equal(finds.length, 3, 'initial read plus two bounded retries')
  assert.ok(calls.some((call) => call.argv[0] === 'screenshot'), 'the fallback captures the window')
  assert.equal(outcome.observation.width, 1504)
  assert.equal(outcome.observation.scaleFactor, 2)
  assert.deepEqual(outcome.observation.bounds, { x: 495, y: 324, width: 720, height: 460 })
})

test('an unreadable tree is ax_unavailable and stays distinct from an empty read', async () => {
  const { run, calls } = fakeRun(() => ({ stdout: FIND_ERROR('PERM_DENIED'), exitCode: 1 }))
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
  const outcome = await locator.locate({ windowId: 'w-1', text: 'x' })
  assert.equal(outcome.layer, 'visual')
  assert.equal(outcome.reason, 'ax_unavailable')
  assert.equal(calls.filter((call) => call.argv[0] === 'find').length, 1, 'a non-retry-safe error is not retried')
  assert.match(outcome.detail, /PERM_DENIED/)
})

test('a retry-safe error is retried exactly once, then succeeds', async () => {
  let reads = 0
  const { run } = fakeRun(() => {
    reads += 1
    return reads === 1 ? { stdout: FIND_ERROR('WINDOW_NOT_FOUND', 'safe'), exitCode: 1 } : { stdout: FIND_HIT() }
  })
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
  const outcome = await locator.locate({ windowId: 'w-1', role: 'button', text: 'x' })
  assert.equal(outcome.layer, 'ax')
  assert.equal(outcome.attempts, 2)
})

test('a matched node with no addressable ref falls back instead of clicking a guess', async () => {
  const { run, calls } = fakeRun((argv) => {
    if (argv[0] === 'find') return { stdout: FIND_HIT({ ref_id: null, role: 'statictext', interactive: false }) }
    if (argv[0] === 'screenshot') return { stdout: SCREENSHOT_OK }
    return { stdout: WINDOWS_OK }
  })
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0 })
  const outcome = await locator.perform({ action: 'click', query: { windowId: 'w-1', text: 'count=' } })
  assert.equal(outcome.layer, 'visual')
  assert.match(outcome.detail, /without an addressable ref/)
  assert.equal(calls.filter((call) => call.argv[0] === 'click').length, 0, 'no click is sent to an unaddressable node')
})

test('an unparseable envelope is an error, not a miss', async () => {
  const { run } = fakeRun(() => ({ stdout: 'not json' }))
  const locator = new DesktopAxLocator({ run, bin: 'x', retryDelayMs: 0, errorRetries: 0 })
  const outcome = await locator.locate({ windowId: 'w-1', text: 'x' })
  assert.equal(outcome.layer, 'visual')
  assert.equal(outcome.reason, 'ax_unavailable')
  assert.match(outcome.detail, /UNPARSEABLE_ENVELOPE/)
})

test('parse helpers read both find shapes and the acting post-condition', () => {
  assert.equal(parseFindEnvelope(FIND_HIT()).match.ref, '@s1:e1')
  assert.equal(parseFindEnvelope(envelope({ ok: true, data: { matches: [{ ref_id: '@s9:e2' }], total_matches: 1 } })).match.ref, '@s9:e2')
  assert.equal(parseFindEnvelope(FIND_EMPTY).totalMatches, 0)
  const acted = parseActEnvelope(ACT_VERIFIED)
  assert.equal(acted.matchedSelector, 'statictext:count=1')
  assert.equal(acted.delivery ?? acted.disposition.delivery, 'delivered_unverified')
  assert.equal(selectorOf({ text: 'done' }), 'statictext:done')
  assert.deepEqual(findArgv({ app: 'Notes', role: 'button', name: 'OK', exact: true }), ['find', '--app', 'Notes', '--role', 'button', '--name', 'OK', '--exact', '--first'])
  assert.deepEqual(actionArgv({ action: 'click', query: {} }, '@s:e1'), ['click', '@s:e1', '--timeout-ms', '5000'])
})

// ---------------------------------------------------------------------------
// Kernel acceptance + mount
// ---------------------------------------------------------------------------

test('the real kernel tool compiler accepts the definition', () => {
  const definition = buildDesktopAxTool({
    resolveBin: () => ({ bin: '/fake/agent-desktop', source: 'AGD_BIN', looked: [] }),
    makeLocator: ({ run, bin }) => new DesktopAxLocator({ run, bin }),
  })
  assert.doesNotThrow(() => defineTool(definition))
  const schema = parameterSchemaSpecToJsonSchema(definition.parameters)
  assert.equal(schema.type, 'object')
  assert.deepEqual([...schema.properties.action.enum].sort(), ['click', 'locate', 'scroll', 'set-value', 'type'].sort())
})

test('the tool schema carries none of the routes the cua guard denies', () => {
  const definition = buildDesktopAxTool({
    resolveBin: () => ({ bin: '/fake', source: 'AGD_BIN', looked: [] }),
    makeLocator: ({ run, bin }) => new DesktopAxLocator({ run, bin }),
  })
  const denied = ['delivery_mode', 'scope', 'drag', 'modifier', 'modifiers', 'target', 'set_config', 'replay_trajectory', 'move_cursor']
  for (const key of denied) {
    assert.equal(Object.hasOwn(definition.parameters, key), false, `desktop_ax must not expose ${key}`)
  }
})

test('apply() registers the tool and a prompt section on the context', () => {
  const registered = []
  const sections = []
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    systemPrompt: { section: (section) => { sections.push(section) } },
  }
  apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'desktop_ax')
  assert.equal(typeof registered[0].execute, 'function')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'idbots:desktop-ax')
  assert.match(sections[0].text, /expect_text/)
})

test('the generated runtime config mounts the plugin only under computerUse', () => {
  const base = {
    sessionRoot: '/tmp/x',
    providers: [{ key: 'openai-gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm1', contextWindow: 64000 }] }],
  }
  const on = generateRuntimeConfig({ ...base, computerUse: true })
  const off = generateRuntimeConfig({ ...base })
  const mounted = (entries) => entries.find((entry) => entry.id === 'idbots-desktop-ax')
  assert.ok(mounted(on), 'computerUse=true must mount the AX layer')
  assert.ok(String(mounted(on).name).endsWith(path.join('plugins', 'idbots-desktop-ax.mjs')))
  assert.equal(mounted(off), undefined, 'the layer must not exist when the switch is off')
  // It rides the same branch as the driver it fronts, third in that group.
  const ids = on.filter((entry) => ['computer-use', 'computer-use-cua-native', 'idbots-cu-route-guard', 'idbots-desktop-ax'].includes(entry.id)).map((entry) => entry.id)
  assert.deepEqual(ids, ['computer-use', 'computer-use-cua-native', 'idbots-cu-route-guard', 'idbots-desktop-ax'])
})

test('the mounted plugin file exists where the generator points', () => {
  const pluginPath = path.join(DEFAULT_RUNTIME_ROOT, 'plugins', 'idbots-desktop-ax.mjs')
  assert.ok(fs.existsSync(pluginPath), `${pluginPath} must exist next to the other plugins`)
  assert.ok(fs.existsSync(path.join(HERE, '..', 'plugins', 'idbots-cu-route-guard.mjs')))
})
