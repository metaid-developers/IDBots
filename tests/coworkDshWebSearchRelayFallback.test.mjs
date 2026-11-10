// End-to-end: the ID.Bots relay fallback for web search (owner ruling
// 2026-10-26). A non-DeepSeek chat provider (zhipu-like) runs a turn that calls
// web_search; the host web-tools proxy tries the user's DeepSeek Search API
// first, receives HTTP 402 (out of balance), marks that upstream unusable for
// the TTL and serves the call from the IDBots-Free relay with the mrk_ relay
// key. The model never sees the 402 — it gets real sources — and the runtime
// composition carries no provider key at all. A second search inside the TTL
// skips DeepSeek entirely. Requires: npm run compile:electron +
// dsh-runtime/node_modules.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = Module.createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))
const PORT = 48796

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `websearch-relay-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      ...require('../dist-electron/main/libs/coworkDshTurn.js'),
      ...require('../dist-electron/main/services/dshWebToolsProxy.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

/** Minimal DeepSeek-Search-API-shaped upstream with a scripted status. */
async function startToolsUpstream(respond) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null })
      const { status, payload } = respond(seen.length)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    seen,
    toolsBase: `http://127.0.0.1:${server.address().port}/v1/tools`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const RELAY_RESULTS = {
  results: [
    { title: 'Node.js — Node.js 26.0.0 (Current)', url: 'https://nodejs.org/en/blog/release/v26.0.0', snippet: 'Node.js 26.0.0 (Current) release notes', date: '2026-05-01T00:00:00+00:00' },
    { title: 'Node.js 24.x LTS releases', url: 'https://nodejs.org/en/blog/release/v24.18.0', snippet: 'Node.js 24.18.0 LTS release', date: null },
  ],
}

test('web search relay fallback: a non-DeepSeek turn searches through the proxy; DeepSeek 402 falls back to the ID.Bots relay',
  { skip: !runtimeReady && 'dsh-runtime node_modules not installed', timeout: 240000 },
  async () => {
    const { DshTurnHub, dshRuntimeConfigFileName, createDshWebToolsProxy } = loadModules()
    const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
    const { server } = await startMockServer(PORT)
    const deepseek = await startToolsUpstream(() => ({ status: 402, payload: { error: { message: 'Insufficient Balance' } } }))
    const relay = await startToolsUpstream(() => ({ status: 200, payload: RELAY_RESULTS }))
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-websearch-relay-'))
    const messages = []
    const proxyLogs = []
    const proxy = await createDshWebToolsProxy({
      resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: deepseek.toolsBase, apiKey: 'sk-user-deepseek' }),
      resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay_key' }),
      log: (line) => proxyLogs.push(line),
    })
    const hub = new DshTurnHub({
      runtimeDir,
      sessionRoot,
      webToolsProxy: () => ({ baseURL: proxy.baseURL, token: proxy.token }),
      log: () => undefined,
    })
    const callbacks = {
      onMessage: (message) => { messages.push(message); return `msg-${messages.length}` },
      onMessageUpdate: () => undefined,
      onMessageFinalize: () => undefined,
      onUsage: () => undefined,
      onApprovalRequest: () => undefined,
      onApprovalCancelled: () => undefined,
    }
    const zhipuLike = {
      key: 'zhipu-like',
      apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      apiKey: 'sk-zhipu',
      model: 'mock-1',
    }
    const runOneTurn = (dshSessionId, prompt) => hub.runTurn({
      sessionId: `cowork-${dshSessionId}`,
      dshSessionId,
      prompt,
      provider: zhipuLike,
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks,
    })

    try {
      const first = await runOneTurn(`rf-${Date.now().toString(36)}`, 'CALL_WEB_SEARCH please')
      assert.notEqual(first.kind, 'error', `turn failed: ${first.reason}`)

      // The non-DeepSeek runtime mounted the seam through the proxy and no
      // provider key (DeepSeek or zhipu) entered its composition.
      const raw = fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName('zhipu-like')), 'utf8')
      assert.ok(raw.includes('@deepseek-ai/dsh-web'), 'web seam mounted for the non-DeepSeek slot')
      assert.ok(raw.includes('IDBOTS_DSH_WEBSEARCH_TOKEN'), 'the token env NAME is referenced')
      assert.ok(!raw.includes('sk-user-deepseek') && !raw.includes('sk-zhipu') && !raw.includes('mrk_relay_key'), 'no credential in the config file')
      assert.ok(!raw.includes(proxy.token), 'the proxy token itself rides the child env only')

      // Ladder: DeepSeek was tried with the user's key and answered 402; the
      // relay served with the relay key; the model got real sources.
      assert.equal(deepseek.seen.length, 1, 'DeepSeek tried once')
      assert.equal(deepseek.seen[0].url, '/v1/tools/search')
      assert.equal(deepseek.seen[0].auth, 'Bearer sk-user-deepseek')
      assert.equal(relay.seen.length, 1, 'the relay served the fallback')
      assert.equal(relay.seen[0].url, '/v1/tools/search')
      assert.equal(relay.seen[0].auth, 'Bearer mrk_relay_key')
      assert.equal(typeof relay.seen[0].body?.query, 'string', 'the plugin\'s search body was forwarded verbatim')
      assert.ok(messages.some((m) => m.type === 'tool_use' && m.metadata?.toolName === 'web_search'), 'web_search tool_use recorded')
      const toolResult = messages.find((m) => m.type === 'tool_result' && String(m.content).includes('Sources:'))
      assert.ok(toolResult, 'the model received formatted sources, not the 402')
      assert.ok(String(toolResult.content).includes('nodejs.org'), 'sources came from the relay payload')
      assert.ok(proxyLogs.some((l) => l.includes('marked unusable (HTTP 402)')), 'the fallback transition is logged')

      // Inside the TTL a second search skips DeepSeek and goes straight to the relay.
      const second = await runOneTurn(`rf2-${Date.now().toString(36)}`, 'CALL_WEB_SEARCH please')
      assert.notEqual(second.kind, 'error', `second turn failed: ${second.reason}`)
      assert.equal(deepseek.seen.length, 1, 'DeepSeek not re-tried inside the suppression TTL')
      assert.equal(relay.seen.length, 2, 'the relay served again')
      assert.equal(hub.runtimeSlotCount, 1, 'one runtime for the one provider; the fallback never rebooted it')
    } finally {
      await hub.close()
      await proxy.stop()
      await deepseek.close()
      await relay.close()
      server.close()
      fs.rmSync(sessionRoot, { recursive: true, force: true })
    }
  })
