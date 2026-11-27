// Two MetaBots on different providers must not share one DSH process.
//
// Incident (session 836aeeb7, 2026-08-22): Twin on official DeepSeek was
// mid-`sleep 90` when Lucy's OpenCode turn called ensureKernel. The shared
// runtime waited 90s then restarted — "DSH runtime stream closed", exit 0.
// Fix: one kernel (subprocess) per provider key. A second provider boots
// alongside the first and must not dispose the in-flight turn.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-perprov-${name}`),
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

test('dshRuntimeConfigFileName isolates composition files per provider', () => {
  const { dshRuntimeConfigFileName, dshRuntimeKeyOf } = loadModules()
  assert.equal(dshRuntimeConfigFileName(), 'cordis.runtime.json')
  assert.equal(dshRuntimeConfigFileName('deepseek'), 'cordis.runtime.deepseek.json')
  assert.equal(dshRuntimeConfigFileName('open code'), 'cordis.runtime.open_code.json')
  assert.equal(dshRuntimeKeyOf({ key: 'opencode' }), 'opencode')
})

test('a second provider boots its own runtime and does not kill an in-flight turn', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub, dshRuntimeConfigFileName } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48813)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-perprov-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })
  const route = (key) => ({
    key, apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48813/v1',
    apiKey: 'sk-a', model: 'mock-1',
  })
  const runTurn = (dshSessionId, provider, prompt) => hub.runTurn({
    sessionId: `cowork-${dshSessionId}`, dshSessionId, prompt, provider,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    callbacks: callbacks(),
  })

  try {
    const turnA = runTurn('twin', route('deepseek'), 'RUN_LONG_BASH please')
    await waitFor(() => logs.some((l) => l.message.includes('dshKernel.ensureRuntime')), 25000, 'first runtime boot')

    const turnB = runTurn('lucy', route('opencode'), 'hello')

    const [outA, outB] = await Promise.all([turnA, turnB])
    assert.notEqual(outA.kind, 'error', `Twin turn must survive Lucy's provider: ${JSON.stringify(outA).slice(0, 240)}`)
    assert.notEqual(outA.kind, 'aborted', 'Twin turn must not be aborted by a second-provider boot')
    assert.notEqual(outB.kind, 'error', `Lucy turn must complete on its own runtime: ${JSON.stringify(outB).slice(0, 240)}`)
    assert.equal(hub.runtimeSlotCount, 2, 'each provider owns a runtime process')
    assert.equal(hub.restartCount, 0, 'neither process should have been restarted')
    assert.ok(
      !logs.some((l) => String(l.message).includes('waiting (bounded) for in-flight turns')),
      'a new provider must not wait-then-restart the other provider\'s process',
    )
    assert.ok(fs.existsSync(path.join(sessionRoot, dshRuntimeConfigFileName('deepseek'))))
    assert.ok(fs.existsSync(path.join(sessionRoot, dshRuntimeConfigFileName('opencode'))))
    const ensureRuntimeCount = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(ensureRuntimeCount, 2, `two boots, no restarts (got ${ensureRuntimeCount})`)
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

test('idle provider runtimes are reaped after the configured TTL', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48814)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-idle-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    runtimeIdleTtlMs: 200,
    // The kernel stamps activity at boot and on every notification, and a
    // recently active kernel is protected for the grace window (10 minutes by
    // default). The TTL alone must decide here, or the reap never lands.
    kernelActivityGraceMs: 0,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  try {
    const out = await hub.runTurn({
      sessionId: 'cowork-idle',
      dshSessionId: 'cw-idle',
      prompt: 'hello',
      provider: {
        key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48814/v1',
        apiKey: 'sk-a', model: 'mock-1',
      },
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks: {
        onMessage: () => 'm1',
        onMessageUpdate: () => undefined,
        onMessageFinalize: () => undefined,
        onUsage: () => undefined,
        onApprovalRequest: () => undefined,
        onApprovalCancelled: () => undefined,
      },
    })
    assert.notEqual(out.kind, 'error', `idle-reap setup turn failed: ${JSON.stringify(out).slice(0, 200)}`)
    assert.equal(hub.runtimeSlotCount, 1)
    await waitFor(() => hub.runtimeSlotCount === 0, 5000, 'idle runtime reap')
    assert.ok(logs.some((l) => l.message.includes('dshTurnHub.reapIdleRuntime')))
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
