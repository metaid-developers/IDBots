import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'

const require = createRequire(import.meta.url)
const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let electronBinary
try { electronBinary = require('electron') } catch { /* root dev dependency is optional here */ }

test('Electron without the native builtin addon boots a composition stored outside dsh-runtime', {
  skip: electronBinary ? false : 'root electron dev dependency not installed',
  timeout: 60_000,
}, async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-electron-resolution-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'commandcode',
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'ELECTRON_RESOLUTION_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    workspace: { cwd: sessionRoot },
    browserUse: { mode: 'launch', headless: true },
    computerUse: true,
  })
  const configPath = path.join(sessionRoot, 'cordis.runtime.commandcode.auto-bc.json')
  fs.writeFileSync(configPath, JSON.stringify(config))

  const child = spawn(electronBinary, [path.join(runtimeDir, 'bin.mjs'), configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RESOLUTION_KEY: 'sk-test',
      SPIKE_QUIET: '1',
    },
  })
  let stderr = ''
  let bootTimer
  let exitTimer
  try {
    child.stderr.on('data', (chunk) => { stderr += chunk })
    await new Promise((resolve, reject) => {
      bootTimer = setTimeout(() => reject(new Error(`runtime boot timed out: ${stderr.slice(-4000)}`)), 45_000)
      child.stderr.on('data', () => {
        if (!stderr.includes('[idbots-dsh-runtime] booted')) return
        clearTimeout(bootTimer)
        resolve()
      })
      child.once('exit', (code) => {
        clearTimeout(bootTimer)
        reject(new Error(`runtime exited before boot (code ${code}): ${stderr.slice(-6000)}`))
      })
    })
    assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND|Application Support\/IDBots\/\.cordis/)

    child.stdin.end()
    await new Promise((resolve, reject) => {
      exitTimer = setTimeout(() => reject(new Error('runtime did not exit after stdin EOF')), 15_000)
      child.once('exit', (code) => {
        clearTimeout(exitTimer)
        try {
          assert.equal(code, 0)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
  } finally {
    clearTimeout(bootTimer)
    clearTimeout(exitTimer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    try { fs.rmSync(sessionRoot, { recursive: true, force: true }) } catch { /* OS sweeps temp dirs */ }
  }
})
