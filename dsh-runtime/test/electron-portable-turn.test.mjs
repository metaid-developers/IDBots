import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const require = createRequire(import.meta.url)
const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let electronBinary
try { electronBinary = require('electron') } catch { /* root dev dependency is optional here */ }

test('Electron portable module loading completes a real mock-provider turn', {
  skip: electronBinary ? false : 'root electron dev dependency not installed',
  timeout: 60_000,
}, async () => {
  const { server, seen } = await startMockServer(0)
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-electron-turn-'))
  const configPath = path.join(sessionRoot, 'cordis.runtime.json')
  fs.writeFileSync(configPath, JSON.stringify(generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw',
      apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnv: 'ELECTRON_TURN_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    workspace: { cwd: sessionRoot },
  })))

  const client = new HarnessClient({}, {
    command: electronBinary,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    environment: () => ({
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_TURN_KEY: 'sk-test',
      SPIKE_QUIET: '1',
    }),
    description: 'idbots-dsh-runtime-electron-turn-test',
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
  })
  let subscription
  let endTimer
  try {
    client.start()
    await client.initialize({ cwd: sessionRoot, provider: 'mockgw', model: 'mock-1' })
    const sessionId = `electron-turn-${Date.now().toString(36)}`
    let settleEnd
    let failEnd
    const ended = new Promise((resolve, reject) => {
      settleEnd = resolve
      failEnd = reject
    })
    subscription = client.subscribe()
    const pumping = (async () => {
      for (;;) {
        const notification = await subscription.next()
        if (notification.method !== 'session.event') continue
        const { sessionId: sid, event } = notification.params
        if (sid === sessionId && event.type === 'turn/end') settleEnd(event)
      }
    })()
    pumping.catch(() => {})
    endTimer = setTimeout(() => failEnd(new Error('Electron turn never ended')), 30_000)

    await client.prompt(sessionId, [{ type: 'text', text: 'ELECTRON_PORTABLE_TURN_PROBE' }])
    const end = await ended
    assert.equal(end.data?.reason?.kind, 'completed')
    assert.ok(seen.some((request) =>
      request.method === 'POST'
      && request.url.endsWith('/chat/completions')
      && JSON.stringify(request.body?.messages ?? []).includes('ELECTRON_PORTABLE_TURN_PROBE')))
  } finally {
    clearTimeout(endTimer)
    subscription?.close()
    await client.close().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    try { fs.rmSync(sessionRoot, { recursive: true, force: true }) } catch { /* OS sweeps temp dirs */ }
  }
})
