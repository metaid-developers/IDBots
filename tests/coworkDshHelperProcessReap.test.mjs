// Helper processes an agent leaves behind must not outlive their runtime in
// server mode (2026-11-27 tenant host: one tenant kept two idle headless
// Chromium instances, about 1.2 GiB, for three hours after its last turn).
//
// Three things are pinned here:
//   - the pure logic of libs/helperProcessReap — procfs parsing, orphan
//     selection, SIGTERM → SIGKILL, the single-flight timer — with fakes;
//   - a REAL detached process: something that left its launcher's session is
//     re-parented to PID 1, and the sweep's real signal path removes it;
//   - the premise the design rests on, against the real DSH runtime: a plain
//     `cmd &` helper is already removed by the runtime's own subprocess
//     manager when its slot retires, so the sweep only has to deal with what
//     detaches beyond the runtime's reach.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))
const posixOnly = process.platform === 'win32' ? 'POSIX process semantics' : false

const reap = require('../dist-electron/main/libs/helperProcessReap.js')

const entry = (pid, ppid, comm = 'bash') => ({ pid, ppid, comm, startTimeTicks: String(pid * 10) })

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

test('parseProcStat reads ppid and start time after a comm with spaces and parentheses', () => {
  // Real layout: pid (comm) state ppid … — starttime is field 22 of the line.
  const stat = '421 (Headless Chromium (helper)) S 1 421 421 0 -1 4194560 10 0 0 0 5 3 0 0 20 0 3 0 987654 0'
  assert.deepEqual(reap.parseProcStat(421, stat), {
    pid: 421,
    ppid: 1,
    comm: 'Headless Chromium (helper)',
    startTimeTicks: '987654',
  })
  assert.equal(reap.parseProcStat(1, 'not a stat line'), null)
})

test('findOrphanProcesses keeps what lost its parent, and nothing else', () => {
  const table = [
    entry(1, 0),                 // PID 1 itself
    entry(7, 1),                 // the app's own main process
    entry(40, 1, 'dbus-daemon'), // the entrypoint's session bus: protected
    entry(41, 7),                // a live child of the app
    entry(90, 1, 'chromium'),    // a re-parented helper
    entry(91, 1, 'sleep'),
  ]
  assert.deepEqual(reap.findOrphanProcesses(table, 7).map((e) => e.pid), [90, 91])
})

test('sweepOrphanProcesses does nothing while the agent may still be working', async () => {
  const signals = []
  const result = await reap.sweepOrphanProcesses({
    listProcesses: () => [entry(90, 1, 'chromium')],
    signal: (pid, signal) => signals.push([pid, signal]),
    isAgentQuiescent: () => false,
    selfPid: 7,
    sleep: async () => {},
  })
  assert.deepEqual(result, { status: 'busy', terminated: [] })
  assert.deepEqual(signals, [])
  assert.equal(
    (await reap.sweepOrphanProcesses({
      listProcesses: () => [entry(7, 1), entry(40, 1, 'dbus-daemon'), entry(41, 7)],
      signal: () => assert.fail('nothing may be signalled'),
      isAgentQuiescent: () => true,
      selfPid: 7,
      sleep: async () => {},
    })).status,
    'clean',
  )
})

test('sweepOrphanProcesses SIGTERMs orphans and SIGKILLs only the same processes that remain', async () => {
  let table = [entry(90, 1, 'chromium'), entry(91, 1, 'sleep'), entry(92, 1, 'ffmpeg')]
  const signals = []
  const logs = []
  const result = await reap.sweepOrphanProcesses({
    // After the grace period: 90 is gone, 92 exited and its pid was reused by
    // a new process, 91 ignored SIGTERM.
    listProcesses: () => table,
    signal: (pid, signal) => signals.push([pid, signal]),
    isAgentQuiescent: () => true,
    selfPid: 7,
    sleep: async () => {
      table = [table[1], { pid: 92, ppid: 1, comm: 'unrelated', startTimeTicks: '9999' }]
    },
    log: (level, message, detail) => logs.push({ level, message, detail }),
  }, 5)
  assert.equal(result.status, 'swept')
  assert.deepEqual(result.terminated.map((e) => e.pid), [90, 91, 92])
  assert.deepEqual(signals, [[90, 'SIGTERM'], [91, 'SIGTERM'], [92, 'SIGTERM'], [91, 'SIGKILL']])
  assert.equal(logs.length, 1)
  assert.equal(logs[0].message, 'helperProcessReap.orphanSweep')
  assert.deepEqual(logs[0].detail.terminated, [
    { pid: 90, comm: 'chromium' },
    { pid: 91, comm: 'sleep' },
    { pid: 92, comm: 'ffmpeg' },
  ])
})

test('procfs deps exist on Linux only', () => {
  assert.equal(reap.createProcfsHelperProcessDeps('darwin'), null)
  assert.equal(reap.createProcfsHelperProcessDeps('win32'), null)
  assert.equal(typeof reap.createProcfsHelperProcessDeps('linux').listProcesses, 'function')
})

test('HelperProcessReaper: one unref-ed timer, single-flight sweeps, clean stop', async () => {
  const timers = []
  let sweeps = 0
  let release
  const reaper = new reap.HelperProcessReaper({
    listProcesses: () => [entry(90, 1, 'chromium')],
    signal: () => {},
    isAgentQuiescent: () => true,
    selfPid: 7,
    sleep: () => { sweeps += 1; return new Promise((resolve) => { release = resolve }) },
  }, (fn, ms) => {
    const timer = { fn, ms, unrefed: false, unref() { this.unrefed = true } }
    timers.push(timer)
    return timer
  }, (timer) => { timer.cancelled = true })

  reaper.start()
  reaper.start()
  assert.equal(timers.length, 1, 'start is idempotent')
  assert.equal(timers[0].ms, 60_000)
  assert.equal(timers[0].unrefed, true, 'the timer must never keep the process alive')

  timers[0].fn()
  const first = reaper.sweep()
  const second = reaper.sweep()
  assert.equal(first, second, 'a sweep in flight is not started again')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sweeps, 1)
  release()
  assert.equal((await first).status, 'swept')
  assert.notEqual(reaper.sweep(), first, 'a finished sweep may run again')
  release()
  await reaper.inFlight

  reaper.stop()
  assert.equal(timers[0].cancelled, true)
})

test('HelperProcessReaper keeps running after a failing sweep', async () => {
  const logs = []
  const reaper = new reap.HelperProcessReaper({
    listProcesses: () => { throw new Error('procfs vanished') },
    signal: () => {},
    isAgentQuiescent: () => true,
    selfPid: 7,
    log: (level, message, detail) => logs.push({ level, message, detail }),
  })
  const result = await reaper.sweep()
  assert.deepEqual(result, { status: 'clean', terminated: [] })
  assert.equal(logs[0].level, 'warn')
  assert.equal(logs[0].message, 'helperProcessReap.orphanSweepFailed')
  assert.equal(logs[0].detail.error, 'procfs vanished')
})

// ---------------------------------------------------------------------------
// A real detached process
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (predicate, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const psField = (pid, field) => spawnSync('ps', [`-o`, `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()

const perlAvailable = spawnSync('perl', ['-MPOSIX', '-e', 'POSIX::setsid(); 1']).status === 0

/** Starts `sleep 600` in a session of its own from a launcher that exits at
 *  once — the shape of the Chromium instances found on the tenant host. */
const launchDetachedOrphan = () => new Promise((resolve, reject) => {
  const launcher = spawn('bash', ['-c', "perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die \"exec failed\"' sleep 600 >/dev/null 2>&1 & echo $!"], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  launcher.stdout.setEncoding('utf8')
  launcher.stdout.on('data', (chunk) => { out += chunk })
  launcher.once('error', reject)
  launcher.once('exit', (code) => {
    const pid = Number(out.trim())
    if (code === 0 && Number.isInteger(pid) && pid > 0) resolve(pid)
    else reject(new Error(`launcher exited ${code}, output "${out.trim()}"`))
  })
})

test('a helper that left its launcher\'s session is re-parented to PID 1, and the sweep removes it', {
  skip: posixOnly || (perlAvailable ? false : 'perl is not installed'),
}, async () => {
  const pid = await launchDetachedOrphan()
  try {
    // It leads its own session (pgid === pid) and PID 1 adopted it — which is
    // exactly why neither the runtime's process groups nor a parent/child
    // walk could ever find it. (The launcher exits before perl has even
    // called setsid, so both facts have to be waited for.)
    await waitFor(() => psField(pid, 'ppid') === '1', 5000, 'PID 1 to adopt the detached helper')
    await waitFor(() => psField(pid, 'pgid') === String(pid), 5000, 'the helper to lead its own process group')
    const startTimeTicks = psField(pid, 'lstart')

    const guarded = await reap.sweepOrphanProcesses({
      listProcesses: () => [{ pid, ppid: 1, comm: 'sleep', startTimeTicks }],
      signal: (target, signal) => process.kill(target, signal),
      isAgentQuiescent: () => false,
      selfPid: process.pid,
    })
    assert.equal(guarded.status, 'busy')
    assert.equal(isAlive(pid), true, 'a busy agent must protect the helper')

    const result = await reap.sweepOrphanProcesses({
      listProcesses: () => [{ pid, ppid: 1, comm: 'sleep', startTimeTicks }],
      signal: (target, signal) => process.kill(target, signal),
      isAgentQuiescent: () => true,
      selfPid: process.pid,
    }, 300)
    assert.equal(result.status, 'swept')
    await waitFor(() => !isAlive(pid), 5000, 'the detached helper to die')
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
})

// ---------------------------------------------------------------------------
// The premise, against the real runtime
// ---------------------------------------------------------------------------

function loadHubModule() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-reap-${name}`),
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

test('a plain background helper is already removed by the runtime itself when its slot retires', {
  skip: posixOnly || (runtimeReady ? false : 'dsh-runtime/node_modules not installed'),
}, async () => {
  // The sweep deliberately does NOT handle plain `cmd &` jobs:
  // dsh-subprocess-local runs each tool subprocess as its own process group
  // and signals the group's members when the runtime exits. If a kernel
  // upgrade ever drops that, plain helpers start leaking on desktop too and
  // this fails first.
  const { DshTurnHub } = loadHubModule()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48828)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-reap-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    // Idle is measured from the slot's last use (the turn's start), so a TTL
    // of 3 s leaves about a second after the turn to observe the helper alive.
    runtimeIdleTtlMs: 3_000,
    kernelActivityGraceMs: 0,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  let helperPid = null
  try {
    const out = await hub.runTurn({
      sessionId: 'cowork-reap',
      dshSessionId: 'cw-reap',
      prompt: 'RUN_BASH_BG_SPAWN please',
      provider: {
        key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48828/v1',
        apiKey: 'sk-a', model: 'mock-1',
      },
      workspace: { cwd: sessionRoot },
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
    assert.notEqual(out.kind, 'error', `helper-spawn turn failed: ${JSON.stringify(out).slice(0, 240)}`)
    const pidFile = path.join(sessionRoot, 'bg-helper.pid')
    await waitFor(() => fs.existsSync(pidFile), 8000, 'the background helper pid file')
    helperPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    assert.equal(isAlive(helperPid), true, 'the background helper must be running right after the turn')

    await waitFor(() => hub.runtimeSlotCount === 0, 10_000, 'the idle slot to retire')
    await waitFor(() => !isAlive(helperPid), 8_000, "the runtime's own subprocess manager to remove the helper")
    assert.ok(logs.some((l) => l.message === 'dshTurnHub.reapIdleRuntime'))
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    if (helperPid && isAlive(helperPid)) process.kill(helperPid, 'SIGKILL')
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
