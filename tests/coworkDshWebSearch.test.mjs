// Host-side wiring for DeepSeek web search + fetch on the DSH kernel. Every
// runtime slot mounts the same web seam — the host web-tools proxy
// (services/dshWebToolsProxy) — so the model sees `web_search`/`web_fetch`
// regardless of which chat provider the slot serves. The proxy owns the
// credential ladder (the user's own DeepSeek key first, the ID.Bots
// relay when that key is missing or answers 401/402/403); the runtime config
// only ever carries the loopback proxy URL and an env NAME whose value is a
// loopback-local token — neither a provider key nor the token itself enters
// the config file. The 0.2.1 composition stays: direct Search/Fetch API
// providers selected, the legacy Messages-turn provider kept as rollback,
// and a search round trip executes against the Search API shape.
// Requires: npm run compile:electron + dsh-runtime/node_modules.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = Module.createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))
const PORT = 48795

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `websearch-${name}`),
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

test('deepseek web search: route detection + tools-root derivation', () => {
  const { isOfficialDeepSeekRoute, deepSeekWebToolsRoot } = loadModules()
  assert.equal(isOfficialDeepSeekRoute({ key: 'deepseek', baseUrl: 'http://relay.example/v1' }), true)
  assert.equal(isOfficialDeepSeekRoute({ key: 'opencode', baseUrl: 'https://api.deepseek.com/anthropic' }), true)
  assert.equal(isOfficialDeepSeekRoute({ key: 'opencode', baseUrl: 'http://127.0.0.1:48795/v1' }), false)
  // The proxy derives the user's Search/Fetch API root from any configured
  // base shape, the same way the runtime generator does for the mounted block.
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com/anthropic/v1'), 'https://api.deepseek.com/v1/tools')
})

test('web search: every slot mounts the host web-tools proxy and a DeepSeek-keyed search round trip executes through it',
  { skip: !runtimeReady && 'dsh-runtime node_modules not installed' },
  async () => {
    const { DshTurnHub, dshRuntimeConfigFileName, createDshWebToolsProxy } = loadModules()
    const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
    const { server, seen } = await startMockServer(PORT)
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-websearch-'))
    const messages = []
    const hubLogs = []
    const proxyLogs = []
    // The mock port doubles as the user's "DeepSeek" Search API upstream.
    const proxy = await createDshWebToolsProxy({
      resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: `http://127.0.0.1:${PORT}/v1/tools`, apiKey: 'sk-web-test' }),
      resolveRelayUpstream: async () => null,
      log: (line) => proxyLogs.push(line),
    })
    const proxyOrigin = proxy.baseURL.replace(/\/anthropic\/v1$/, '')
    const hub = new DshTurnHub({
      runtimeDir,
      sessionRoot,
      webToolsProxy: () => ({ baseURL: proxy.baseURL, token: proxy.token }),
      log: (level, event, data) => { hubLogs.push({ level, event, data }) },
    })
    const callbacks = {
      onMessage: (message) => { messages.push(message); return `msg-${messages.length}` },
      onMessageUpdate: () => undefined,
      onMessageFinalize: () => undefined,
      onUsage: () => undefined,
      onApprovalRequest: () => undefined,
      onApprovalCancelled: () => undefined,
    }
    const runOneTurn = (dshSessionId, provider, prompt) => hub.runTurn({
      sessionId: `cowork-${dshSessionId}`,
      dshSessionId,
      prompt,
      provider,
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks,
    })

    try {
      const outcome = await runOneTurn(`ws-${Date.now().toString(36)}`, {
        key: 'deepseek',
        apiFormat: 'openai',
        baseUrl: `http://127.0.0.1:${PORT}`,
        apiKey: 'sk-web-test',
        model: 'mock-1',
      }, 'CALL_WEB_SEARCH please')
      assert.notEqual(outcome.kind, 'error', `turn failed: ${outcome.reason}`)

      // Composition file: the web seam points at the loopback proxy with the
      // env-name indirection — neither the provider key nor the proxy token
      // ever appears in the runtime config.
      const raw = fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName('deepseek')), 'utf8')
      const cfg = JSON.parse(raw)
      const web = cfg.find((e) => e.name === '@deepseek-ai/dsh-web')
      assert.ok(web, 'dsh-web entry mounted')
      assert.equal(web.config.searchProvider, 'deepseek-search-api')
      assert.equal(web.config.fetchProvider, 'deepseek-fetch-api')
      const apiProviders = cfg.find((e) => e.name === '@deepseek-ai/dsh-web-deepseek-api')
      assert.ok(apiProviders, 'web-deepseek-api entry mounted')
      assert.equal(apiProviders.config.apiKeyEnv, 'IDBOTS_DSH_WEBSEARCH_TOKEN')
      assert.equal(apiProviders.config.baseURL, `${proxyOrigin}/v1/tools`, 'Search/Fetch API calls go to the host proxy')
      const search = cfg.find((e) => e.name === '@deepseek-ai/dsh-web-search-deepseek')
      assert.ok(search, 'legacy web-search-deepseek entry kept as rollback')
      assert.equal(search.config.apiKeyEnv, 'IDBOTS_DSH_WEBSEARCH_TOKEN')
      assert.equal(search.config.baseURL, proxy.baseURL)
      assert.equal(search.config.model, 'deepseek-flash')
      const toolWeb = cfg.find((e) => e.name === '@deepseek-ai/dsh-tool-web')
      assert.ok(toolWeb, 'tool-web entry mounted')
      assert.equal(toolWeb.config.fetch, true)
      assert.ok(!raw.includes('sk-web-test'), 'the provider key never enters the config file')
      assert.ok(!raw.includes(proxy.token), 'the proxy token rides the child env, never the config file')

      // The search executed against the Search API shape THROUGH the proxy:
      // the mock saw the forwarded request carrying the user's own key.
      const searchReq = seen.find((r) => r.method === 'POST' && String(r.url).endsWith('/v1/tools/search'))
      assert.ok(searchReq, 'Search API request reached the DeepSeek upstream')
      assert.equal(typeof searchReq.body?.query, 'string')
      assert.equal(searchReq.auth, 'Bearer sk-web-test', 'the proxy forwards with the user\'s DeepSeek key')

      // The model saw the tool and the formatted sources landed in history.
      assert.ok(messages.some((m) => m.type === 'tool_use' && m.metadata?.toolName === 'web_search'), 'web_search tool_use recorded')
      assert.ok(messages.some((m) => m.type === 'tool_result' && String(m.content).includes('Sources:')), 'formatted sources recorded')
      const followUp = seen.filter((r) => r.body?.messages?.some((m) => m.role === 'tool')).at(-1)
      const toolMsg = followUp?.body?.messages?.filter((m) => m.role === 'tool').at(-1)
      const toolContent = typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content ?? '')
      assert.match(toolContent, /Sources:/, 'follow-up request carries the search result to the model')

      // A later NON-DeepSeek provider boots its own process and mounts the
      // SAME seam: web search is no longer tied to the slot's chat provider
      // (the proxy decides whose credential pays), and no provider key leaks
      // into that runtime either.
      await runOneTurn(`ws2-${Date.now().toString(36)}`, {
        key: 'mockgw',
        apiFormat: 'openai',
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        apiKey: 'sk-other',
        model: 'mock-1',
      }, 'HELLO_MOCK')
      assert.equal(hub.runtimeSlotCount, 2, 'the second provider must spawn its own runtime')
      const rawOther = fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName('mockgw')), 'utf8')
      const cfgOther = JSON.parse(rawOther)
      assert.ok(cfgOther.some((e) => e.name === '@deepseek-ai/dsh-web'), 'non-DeepSeek slot mounts the web seam too')
      const otherApi = cfgOther.find((e) => e.name === '@deepseek-ai/dsh-web-deepseek-api')
      assert.equal(otherApi?.config?.baseURL, `${proxyOrigin}/v1/tools`, 'same host proxy for every slot')
      assert.equal(otherApi?.config?.apiKeyEnv, 'IDBOTS_DSH_WEBSEARCH_TOKEN')
      assert.ok(!rawOther.includes('sk-web-test') && !rawOther.includes('sk-other'), 'no provider key in the non-DeepSeek composition')
      assert.ok(!rawOther.includes('IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'), 'the retired DeepSeek-key env name is gone')

      // The non-DeepSeek turn's model-facing request DOES offer web_search.
      // (/v1/chat/completions is only the mockgw provider's URL space here —
      // the DeepSeek provider's chat and tools requests never carry /v1 before
      // chat/completions.)
      const gwRequests = seen.filter((r) => r.method === 'POST' && String(r.url).endsWith('/v1/chat/completions'))
      assert.ok(gwRequests.length > 0, 'non-DeepSeek turn reached its gateway')
      const gwTools = gwRequests.at(-1)?.body?.tools ?? []
      assert.ok(gwTools.some((t) => t?.function?.name === 'web_search' || t?.name === 'web_search'), 'non-DeepSeek turn offers web_search to the model')

      // With the proxy running there is nothing to gate: no unavailability notice.
      assert.equal(hubLogs.filter((l) => l.event === 'dshTurnHub.webSearchProxyUnavailable').length, 0)
      assert.equal(hubLogs.filter((l) => l.event === 'dshTurnHub.webSearchProviderGated').length, 0, 'the per-slot provider gate is retired')
    } finally {
      await hub.close()
      await proxy.stop()
      server.close()
      fs.rmSync(sessionRoot, { recursive: true, force: true })
    }
  })

test('web search: without the host proxy no slot mounts the seam and the hub says so exactly once',
  { skip: !runtimeReady && 'dsh-runtime node_modules not installed', timeout: 180000 },
  async () => {
    const { DshTurnHub, dshRuntimeConfigFileName } = loadModules()
    const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
    const { server } = await startMockServer(48845)
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-websearch-noproxy-'))
    const hubLogs = []
    const hub = new DshTurnHub({
      runtimeDir,
      sessionRoot,
      webToolsProxy: () => null,
      log: (level, event, data) => { hubLogs.push({ level, event, data }) },
    })
    try {
      await hub.prewarmTurnSlot({ sessionId: 'np-a', provider: { key: 'deepseek', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48845', apiKey: 'sk-ds', model: 'mock-1' }, workspace: { cwd: sessionRoot } })
      await hub.prewarmTurnSlot({ sessionId: 'np-b', provider: { key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48845/v1', apiKey: 'sk-o', model: 'mock-1' }, workspace: { cwd: sessionRoot } })
      for (const key of ['deepseek', 'mockgw']) {
        const raw = fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName(key)), 'utf8')
        assert.ok(!raw.includes('@deepseek-ai/dsh-web'), `${key}: no web seam without the proxy`)
        assert.ok(!raw.includes('IDBOTS_DSH_WEBSEARCH_TOKEN'), `${key}: no token env referenced`)
      }
      const notices = hubLogs.filter((l) => l.event === 'dshTurnHub.webSearchProxyUnavailable')
      assert.equal(notices.length, 1, 'one notice per hub, not per slot')
      assert.ok(String(notices[0].data?.detail).includes('browser-search skill'), 'the notice names the skill fallback')
    } finally {
      await hub.close()
      server.close()
      fs.rmSync(sessionRoot, { recursive: true, force: true })
    }
  })
