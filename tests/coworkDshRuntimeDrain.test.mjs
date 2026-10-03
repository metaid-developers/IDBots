// Runtime drain handover: a config change the running process cannot serve
// (the first turn on a new MODEL of the same provider grows the providers
// union) must NEVER kill in-flight turns. The incident shape: a long
// scheduled-task turn (sleep-5 bash) was mid-tool when a v4-pro session
// first arrived on a flash-only slot; the hub waited out its 90s quiescence
// budget and restarted the runtime anyway — "DSH runtime stream closed",
// exit 0, exactly 90s after the config diff. Fix under test: the hub boots a
// SUCCESSOR kernel immediately, the caller's turn runs there, the old kernel
// drains its in-flight turn and closes once it settles; the drained
// session's next turn resumes on the successor from disk.
// 2026-10-03 refresh: since 3f04cf70 a kernel counts as busy while it receives
// any runtime notification (liveness keepalives included), so a running
// drained process is retired by the idle-slot reap rather than the grace path.
// The test shrinks the grace and reap TTL via hub options and asserts the
// drained process is closed by either path (no leaked process), instead of
// timing out against the production windows.
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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-drain-${name}`),
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

test('a model joining the provider union boots a successor runtime; the in-flight turn drains, not dies', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48826)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-drain-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    // A drained kernel's retirement is deliberately conservative since
    // 3f04cf70: a kernel counts as busy while it receives ANY runtime
    // notification (liveness keepalives included), so a running drained
    // process is not settled by the grace path alone — the idle-slot reap is
    // the eventual closer, and it closes draining kernels with the slot.
    // The test shrinks both windows (500ms grace, 2s reap TTL) so the "no
    // leaked process" invariant is observable inside the test; the production
    // defaults are 10 minutes / 30 minutes.
    kernelActivityGraceMs: 500,
    runtimeIdleTtlMs: 2000,
    // Bridge the mock's `bash` tool call as a genuinely long host tool so the
    // in-flight turn REALLY outlives the handover window (the raw hub has no
    // native bash plugin; without this the turn settles in ~1s).
    executeTool: async (_coworkId, name, args) => {
      if (name !== 'bash') return { ok: false, error: `unexpected tool ${name}` }
      const seconds = Number(/sleep (\d+)/.exec(String(args.command ?? ''))?.[1] ?? 1)
      await sleep(seconds * 1000)
      return { ok: true, text: 'LONG_BASH_DONE' }
    },
  })
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })
  const route = (model) => ({
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48826/v1',
    apiKey: 'sk-a', model,
  })
  const runTurn = (dshSessionId, provider, prompt) => hub.runTurn({
    sessionId: `cowork-${dshSessionId}`, dshSessionId, prompt, provider,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    hostTools: [{
      name: 'bash',
      description: 'Run a shell command (test bridge).',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'string' } },
        required: ['command'],
      },
    }],
    callbacks: callbacks(),
  })

  try {
    // Turn A: long foreground bash (sleep 5) — the incident's scheduled-task
    // shape. Far past any quiescence budget the old code enforced.
    const turnA = runTurn('a', route('mock-1'), 'RUN_LONG_BASH please')
    await waitFor(() => logs.some((l) => l.message.includes('dshKernel.ensureRuntime')), 25000, 'runtime boot')

    // Turn B: FIRST turn on a second model of the SAME provider — the
    // providers union grows, a config the running process cannot serve.
    // Old code: bounded wait, then restart under A (kill). New code: successor.
    const turnB = runTurn('b', route('mock-2'), 'hello from the new model')

    const [outA, outB] = await Promise.all([turnA, turnB])
    assert.notEqual(outA.kind, 'error', `turn A must survive the handover: ${JSON.stringify(outA).slice(0, 240)}`)
    assert.notEqual(outA.kind, 'aborted', 'turn A must not be aborted by the successor boot')
    assert.notEqual(outB.kind, 'error', `turn B must run on the successor runtime: ${JSON.stringify(outB).slice(0, 240)}`)

    const handover = logs.find((l) => l.message.includes('booting a successor runtime and draining the old one'))
    assert.ok(handover, 'the handover was logged')
    assert.ok(
      Array.isArray(handover.detail.changed) && handover.detail.changed.includes('providers'),
      'the diff log names the changed field',
    )
    assert.ok(
      !logs.some((l) => String(l.message).includes('waiting (bounded) for in-flight turns')),
      'the destructive bounded wait is gone',
    )
    assert.equal(hub.runtimeSlotCount, 1, 'one provider, one slot')
    const ensureRuntimeCount = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(ensureRuntimeCount, 2, `two processes booted, zero restarts (got ${ensureRuntimeCount})`)

    // Session continuity: the drained session's next turn resumes its agent
    // from disk on the successor. Runs BEFORE the retirement wait — an
    // in-flight turn also keeps the reap pass from touching the slot.
    const outC = await runTurn('a', route('mock-1'), 'hello again')
    assert.notEqual(outC.kind, 'error', `follow-up turn on the successor must succeed: ${JSON.stringify(outC).slice(0, 240)}`)

    // The drained process must not leak: once nothing runs on it and its
    // liveness notifications have aged out, it is closed — either by the
    // settle-time retire (drainedRuntimeClosed) or by the idle-slot reap
    // (reapIdleRuntime, which closes draining kernels with the slot).
    await waitFor(
      () => logs.some((l) =>
        l.message.includes('dshTurnHub.drainedRuntimeClosed')
        || l.message.includes('dshTurnHub.reapIdleRuntime')),
      25000,
      'drained runtime retirement',
    )
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
