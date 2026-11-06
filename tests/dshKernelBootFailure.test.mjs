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
