// GT#26 follow-up: a config flap while a long tool call runs must NOT restart
// the shared runtime out from under the in-flight turn. The incident shape:
// a second turn's ensureKernel saw a changed config, waited out the 90s
// quiescence budget while a `sleep 40`-style turn was mid-tool, then
// restarted the runtime anyway — "DSH runtime stream closed", exit 0, exactly
// 90s after the turn started. Fix under test: when the calling turn's
// provider route is already served by the running runtime, the restart is
// deferred to the next quiescent ensureKernel (lastConfigJson keeps the
// running config so the diff stays visible). When it is NOT served, the
// successor/drain handover covers it (coworkDshRuntimeDrain.test.mjs).
// 2026-10-03 refresh: since 3f04cf70 the hub also treats recent kernel-side
// activity as busy (10-minute grace), so "the next quiescent ensureKernel"
// needs that grace to expire. The test shrinks the grace via
// kernelActivityGraceMs and sleeps past it before the apply turn.
// Requires: npm run compile:electron + dsh-runtime/node_modules.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-restartdef-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkDshTurn.js')
  } finally {
    Module._load = originalLoad
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (predicate, timeoutMs = 25000, what = 'condition') => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${what}`)
}

test('helpers: config diff names the changed top-level keys; route lookup by provider key', () => {
  const { dshConfigChangedKeys, lastProviderRouteJsonOf } = loadModules()
  const a = JSON.stringify({ providers: [{ key: 'p', baseUrl: 'x' }], env: { A: '1' }, mcpServers: [] })
  const b = JSON.stringify({ providers: [{ key: 'p', baseUrl: 'x' }], env: { A: '2' }, mcpServers: [{ name: 'm' }] })
  assert.deepEqual(dshConfigChangedKeys(a, b).sort(), ['env', 'mcpServers'])
  assert.equal(dshConfigChangedKeys(a, a).length, 0)
  assert.ok(lastProviderRouteJsonOf(b, 'p').includes('"baseUrl":"x"'))
  assert.equal(lastProviderRouteJsonOf(b, 'q'), null)
})

test('config flap during a long tool call defers the restart; the in-flight turn survives', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48799)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-restartdef-'))
  const logs = []
  let mcpServers = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    mcpServersProvider: () => mcpServers,
    // The hub treats a kernel as busy while it has recent activity (host-less
    // subagent work has no controller to count — 3f04cf70), defaulting to a
    // 10-minute grace. A 500ms grace lets "quiescence" actually arrive inside
    // the test (after turn C's predecessors settle) while the deferral under
    // live activity — the behavior under test — is driven by the in-flight
    // controller, not the timer.
    kernelActivityGraceMs: 500,
  })
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48799/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const runTurn = (dshSessionId, prompt) => hub.runTurn({
    sessionId: `cowork-${dshSessionId}`, dshSessionId, prompt, provider,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    callbacks: callbacks(),
  })

  try {
    // Turn A: long foreground bash (sleep 5) — in flight far past the 500ms
    // quiescence budget that used to kill it.
    const turnA = runTurn('a', 'RUN_LONG_BASH please')
    await waitFor(() => logs.some((l) => l.message.includes('dshKernel.ensureRuntime')), 25000, 'runtime boot')

    // Flap the config (an MCP server mounts) while A is mid-tool; turn B on
    // the SAME provider route must defer the restart, not restart under A.
    mcpServers = [{
      name: 'restartdef-echo',
      transportType: 'stdio',
      command: process.execPath,
      args: [path.join(runtimeDir, 'test', 'fixtures', 'mcp-echo-server.mjs')],
    }]
    const turnB = runTurn('b', 'hello')

    const [outA, outB] = await Promise.all([turnA, turnB])
    assert.notEqual(outA.kind, 'error', `turn A must survive the config flap: ${JSON.stringify(outA).slice(0, 200)}`)
    assert.notEqual(outA.kind, 'aborted', 'turn A must not be aborted by a restart')
    assert.notEqual(outB.kind, 'error', `turn B must run on the deferred (old) runtime: ${JSON.stringify(outB).slice(0, 200)}`)
    assert.ok(
      logs.some((l) => l.message.includes('restart deferred until quiescence')),
      'deferral was logged with the changed keys',
    )
    const deferLog = logs.find((l) => l.message.includes('restart deferred until quiescence'))
    assert.ok(Array.isArray(deferLog.detail.changed) && deferLog.detail.changed.includes('mcpServers'),
      'the diff log names the changed field')

    // After quiescence the next turn applies the pending config (a real
    // restart) and still succeeds. Quiescence = no in-flight turns AND the
    // kernel-side activity grace expired: sleep past the 500ms test grace so
    // turn B's end boundary (the last kernel activity) ages out, or turn C
    // would defer a second time — with the production 10-minute grace it
    // always did, which is what this test's stale expectation missed.
    await sleep(800)
    const outC = await runTurn('c', 'hello again')
    assert.notEqual(outC.kind, 'error', `turn C must succeed after the deferred apply: ${JSON.stringify(outC).slice(0, 200)}`)
    const ensureRuntimeCount = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.ok(ensureRuntimeCount >= 2, `the deferred config applied at quiescence (${ensureRuntimeCount} boots)`)
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
