// Boot-failure diagnosis (plan B for the 2026-09-07 supportsStore regression):
// when the DSH runtime process dies before the JSON-RPC handshake (plugin tree
// rejected the config), the surfaced error must name the failing provider and
// keep the SDK's exit code + stderr tail — that regression presented as a bare
// "JSON-RPC input closed" with no pointer to WHICH provider's configuration
// was responsible. Injects a runtime dir whose bin.mjs exits 1 immediately and
// drives the real DshKernel ensureRuntime path (needs the installed
// dsh-sdk-client, symlinked from the repo runtime).

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..')
const realRuntimeDir = path.join(repoRoot, 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(realRuntimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

test('automation runtimes get a longer initialize budget than a plain route', () => {
  const {
    dshInitializeTimeoutMs,
    DSH_INITIALIZE_TIMEOUT_MS,
    DSH_AUTOMATION_INITIALIZE_TIMEOUT_MS,
  } = require('../dist-electron/main/libs/dshKernel/dshKernel.js')
  // Plain routes stay on the historical 20s handshake. Browser and desktop
  // slots load Playwright and cua-driver before initialize returns; that boot
  // was measured at 11–38s, so they share the 60s budget the runtime tests
  // already use for those compositions.
  assert.equal(DSH_INITIALIZE_TIMEOUT_MS, 20_000)
  assert.equal(DSH_AUTOMATION_INITIALIZE_TIMEOUT_MS, 60_000)
  assert.equal(dshInitializeTimeoutMs({}), 20_000)
  assert.equal(dshInitializeTimeoutMs({ computerUse: false }), 20_000)
  assert.equal(dshInitializeTimeoutMs({ browserUse: { mode: 'launch' } }), 60_000)
  assert.equal(dshInitializeTimeoutMs({ computerUse: true }), 60_000)
  assert.equal(dshInitializeTimeoutMs({
    browserUse: { mode: 'attach' },
    computerUse: true,
  }), 60_000)
})

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

test('a timed-out automation boot reaps the runtime process', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshKernel } = require('../dist-electron/main/libs/dshKernel/dshKernel.js')

  const fakeRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-hang-runtime-'))
  fs.mkdirSync(path.join(fakeRuntimeDir, 'lib'), { recursive: true })
  // Stays up until stdin closes. initialize never returns; close() must EOF
  // stdin so the child exits. Leaving it running is the leak: this.client is
  // only assigned after a successful handshake, so the next turn would spawn
  // another process beside this one.
  fs.writeFileSync(path.join(fakeRuntimeDir, 'bin.mjs'), `
import fs from 'node:fs'
import path from 'node:path'
const pidPath = path.join(path.dirname(process.argv[2]), 'hung-boot.pid')
fs.writeFileSync(pidPath, String(process.pid))
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`)
  fs.writeFileSync(path.join(fakeRuntimeDir, 'lib', 'generate-runtime-config.mjs'),
    'export const generateRuntimeConfig = () => [];\n')
  fs.writeFileSync(path.join(fakeRuntimeDir, 'lib', 'migrate-session-root-zstd.mjs'),
    'export const migrateSessionRootToZstd = async () => undefined;\n')
  fs.writeFileSync(path.join(fakeRuntimeDir, 'lib', 'sanitize-v0-abort-cause.mjs'),
    'export const sanitizeV0AbortCauses = async () => undefined;\n')
  fs.symlinkSync(path.join(realRuntimeDir, 'node_modules'), path.join(fakeRuntimeDir, 'node_modules'))

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-hang-root-'))
  const pidPath = path.join(sessionRoot, 'hung-boot.pid')
  const kernel = new DshKernel({
    runtimeDir: fakeRuntimeDir,
    nodePath: process.execPath,
    initializeTimeoutMs: 800,
    handlers: {
      onMessage: () => 'unused',
      onMessageUpdate: () => undefined,
      onMessageFinalize: () => undefined,
      onTurnEnd: () => undefined,
      onUsage: () => undefined,
      onApprovalRequest: () => undefined,
      onApprovalCancelled: () => undefined,
      onError: () => undefined,
    },
    log: () => undefined,
  })

  try {
    await assert.rejects(
      kernel.ensureRuntime({
        sessionRoot,
        runtimeId: 'deepseek-official.auto-bc',
        computerUse: true,
        providers: [{
          key: 'deepseek-official',
          apiFormat: 'openai',
          baseUrl: 'https://api.deepseek.com',
          apiKeyEnv: 'DSH_BOOT_HANG_CREDENTIAL',
          models: [{ id: 'deepseek-v4-flash', contextWindow: 1_000 }],
        }],
      }),
      (error) => {
        assert.equal(error.name, 'DshRuntimeBootError')
        assert.match(error.message, /deepseek-official\.auto-bc/)
        assert.match(error.message, /timed out after 800ms/)
        return true
      },
    )
    const pid = Number(fs.readFileSync(pidPath, 'utf8'))
    const deadline = Date.now() + 4_000
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(pidAlive(pid), false)
  } finally {
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8'))
      if (pidAlive(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  }
})

test('ensureRuntime names the provider when the runtime process dies at boot', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshKernel } = require('../dist-electron/main/libs/dshKernel/dshKernel.js')

  const fakeRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-fail-runtime-'))
  fs.mkdirSync(path.join(fakeRuntimeDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(fakeRuntimeDir, 'bin.mjs'),
    'console.error("plugin tree failed to load: fake rejection for the boot test");\nprocess.exit(1);\n')
  fs.writeFileSync(path.join(fakeRuntimeDir, 'lib', 'generate-runtime-config.mjs'),
    'export const generateRuntimeConfig = () => [];\n')
  fs.writeFileSync(path.join(fakeRuntimeDir, 'lib', 'migrate-session-root-zstd.mjs'),
    'export const migrateSessionRootToZstd = async () => undefined;\n')
  fs.writeFileSync(path.join(fakeRuntimeDir, 'lib', 'sanitize-v0-abort-cause.mjs'),
    'export const sanitizeV0AbortCauses = async () => undefined;\n')
  fs.symlinkSync(path.join(realRuntimeDir, 'node_modules'), path.join(fakeRuntimeDir, 'node_modules'))

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-fail-root-'))
  const kernel = new DshKernel({
    runtimeDir: fakeRuntimeDir,
    nodePath: process.execPath,
    handlers: {
      onMessage: () => 'unused',
      onMessageUpdate: () => undefined,
      onMessageFinalize: () => undefined,
      onTurnEnd: () => undefined,
      onUsage: () => undefined,
      onApprovalRequest: () => undefined,
      onApprovalCancelled: () => undefined,
      onError: () => undefined,
    },
    log: () => undefined,
  })

  await assert.rejects(
    kernel.ensureRuntime({
      sessionRoot,
      runtimeId: 'custom-zai',
      providers: [{
        key: 'custom-zai',
        apiFormat: 'responses',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKeyEnv: 'DSH_BOOT_FAILURE_CREDENTIAL',
        models: [{ id: 'glm-fake', contextWindow: 1_000 }],
      }],
    }),
    (error) => {
      assert.equal(error.name, 'DshRuntimeBootError')
      assert.equal(error.code, 'DSH_RUNTIME_BOOT_FAILED')
      assert.match(error.message, /DSH runtime for provider "custom-zai" failed to boot/)
      assert.match(error.message, /provider\/model configuration problem/)
      // The SDK transport detail (exit code + stderr tail) must survive the wrap.
      assert.match(error.message, /fake rejection for the boot test/)
      return true
    },
  )
})
