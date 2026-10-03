// Regression test: rotating a provider's API key must take effect on the NEXT
// turn — no app restart required.
//
// Pre-fix behavior: the busy-runtime deferral (coworkDshRestartDefer) decided
// "the running runtime serves this turn" by comparing the provider ROUTE JSON
// only. The route records the credential's env NAME, never its value — the
// value rides the child env the process was spawned with. So after the user
// replaced an API key in Settings, every subsequent turn (existing sessions
// AND brand-new ones) kept authenticating with the OLD key from the old
// process until the app was relaunched: the runtime had recent activity
// (10-minute grace), the route still matched, and the restart kept deferring.
//
// Fix under test: the deferral also compares the key value the running env
// holds (runningEnvApiKeyOf). A rotated key is unserved → a successor runtime
// boots with the new credential while the old process drains.
//
// The mock gateway validates keys with a real 401, so under the old code the
// rotated turn fails with the upstream auth error; under the fix it completes.
//
// Requires: pnpm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-keyrotate-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
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

/** OpenAI-compatible mock that rejects any key other than the expected ones
 *  with a real 401 — the discriminator for serving a turn with a stale key. */
function startKeyValidatingMock(port) {
  const seen = []
  const validKeys = new Set(['key-a', 'key-b'])
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      const auth = req.headers.authorization ?? '(none)'
      seen.push({ method: req.method, url: req.url, auth, body: parsed })
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
        return
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
        return
      }
      const key = (auth.match(/^Bearer\s+(.+)$/) ?? [])[1] ?? ''
      if (!validKeys.has(key)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'AuthError', message: 'Invalid API key.' } }))
        return
      }
      // OpenAI chat.completion.chunk SSE stream (same shape the shared
      // mock-openai fixture serves) with a usage trailer so pi-ai's stream
      // finalizer accepts the turn.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'mock-1' }
      frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      frame({ ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      frame({ ...base, choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } })
      res.end(`data: [DONE]\n\n`)
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, seen }))
  })
}

test('runningEnvApiKeyOf reads the credential value the running env holds', () => {
  const { runningEnvApiKeyOf } = loadModules()
  const config = JSON.stringify({
    providers: [{ key: 'mockgw' }],
    env: { IDBOTS_DSH_KEY_MOCKGW: 'key-a', IDBOTS_RPC_TOKEN: 't' },
  })
  assert.equal(runningEnvApiKeyOf(config, 'mockgw'), 'key-a')
  assert.equal(runningEnvApiKeyOf(config, 'other-route'), undefined, 'unknown route holds no credential')
  assert.equal(runningEnvApiKeyOf('{broken', 'mockgw'), undefined, 'unparseable snapshot is unserved')
})

test('rotated API key takes effect on the next turn via a successor runtime', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshTurnHub } = loadModules()
  const { server, seen } = await startKeyValidatingMock(48841)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-keyrotate-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    mcpServersProvider: () => [],
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })

  // ONE provider route whose credential rotates — the Settings "replace API
  // key" flow changes only the key value, everything else stays identical.
  const provider = (apiKey) => ({
    key: 'mockgw',
    apiFormat: 'openai',
    baseUrl: 'http://127.0.0.1:48841/v1',
    apiKey,
    model: 'mock-1',
    contextWindow: 64000,
  })
  const turn = (apiKey) => hub.runTurn({
    sessionId: `s-${apiKey}`,
    dshSessionId: `dsh-${apiKey}`,
    provider: provider(apiKey),
    sections: [],
    prompt: 'reply with ok',
    workspace: { cwd: sessionRoot },
    callbacks: {
      onMessage: () => 'm1',
      onMessageUpdate: () => undefined,
      onMessageFinalize: () => undefined,
      onUsage: () => undefined,
      onApprovalRequest: () => undefined,
      onApprovalCancelled: () => undefined,
      onError: () => undefined,
    },
  })

  try {
    // Turn 1 with the original key: baseline, served by the freshly booted
    // runtime. Its completion leaves recent kernel activity, so the next turn
    // lands on the busy-runtime deferral path.
    const first = await turn('key-a')
    assert.equal(first.kind, 'completed', `turn 1 (original key) should complete, got ${JSON.stringify(first)}`)

    // Turn 2 with the ROTATED key, same provider route otherwise. Pre-fix the
    // deferral treated the route as served and answered with the OLD key from
    // the old process — the mock answered 401 and the turn errored.
    const second = await turn('key-b')
    assert.equal(second.kind, 'completed', `turn 2 (rotated key) must complete without an app restart, got ${JSON.stringify(second)}`)

    assert.ok(
      logs.some((l) => l.message.includes('booting a successor runtime and draining the old one')),
      'the rotated key must boot a successor runtime, not defer the restart',
    )
    assert.ok(
      !logs.some((l) => l.message.includes('restart deferred until quiescence')),
      'a rotated key must never be served by the running runtime',
    )
    // Same provider slot — the rotation stays inside one runtime slot.
    assert.equal(hub.runtimeSlotCount, 1, 'the rotation must not fragment provider slots')

    const completionCalls = seen.filter((r) => r.method === 'POST' && r.url.endsWith('/chat/completions'))
      .filter((r) => !JSON.stringify(r.body?.messages ?? []).includes('Create a concise title for an AI coding-assistant session'))
    assert.ok(completionCalls.length >= 2, `expected >=2 completion calls, got ${completionCalls.length}`)
    assert.equal(completionCalls[0].auth, 'Bearer key-a', 'the first turn rides the original key')
    assert.equal(completionCalls[1].auth, 'Bearer key-b', 'the turn after rotation must carry the NEW key upstream')
  } finally {
    await hub.close?.().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
