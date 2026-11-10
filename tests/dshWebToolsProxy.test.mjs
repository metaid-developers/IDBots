// DshWebToolsProxy — the loopback web-tools seam every DSH slot searches
// through (src/main/services/dshWebToolsProxy.ts). Pins the credential ladder
// the owner asked for (2026-10-26): the user's own DeepSeek key serves while
// it works; a 401/402/403 from DeepSeek suppresses that upstream for a TTL and
// the call falls back to the ID.Bots relay (free search bucket); 5xx/429/
// transport failures fall through without marking; other 4xx are the
// request's fault and come back as-is. No electron import — the module is
// host-plain. Requires: npm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const {
  createDshWebToolsProxy,
  resolveDeepSeekWebToolsUpstream,
  deepSeekWebToolsRoot,
  relayWebToolsBase,
} = require('../dist-electron/main/services/dshWebToolsProxy.js')

/** Tiny scripted upstream: records requests, answers from a queue of responses. */
async function startUpstream() {
  const seen = []
  const script = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null })
      const next = script.length > 0 ? script.shift() : { status: 200, body: { results: [] } }
      res.writeHead(next.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(next.body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    seen,
    script,
    toolsBase: `http://127.0.0.1:${port}/v1/tools`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const OK_RESULTS = { results: [{ url: 'https://example.org', title: 'Example', snippet: 'hi', date: null }] }

async function callProxy(proxy, kind, body, token = proxy.token) {
  const toolsBase = deepSeekWebToolsRoot(proxy.baseURL)
  const response = await fetch(`${toolsBase}/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

test('deepSeekWebToolsRoot mirrors the runtime generator for every base shape', () => {
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com/anthropic/v1'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('https://api.deepseek.com/v1/tools'), 'https://api.deepseek.com/v1/tools')
  assert.equal(deepSeekWebToolsRoot('http://127.0.0.1:4000/anthropic/v1'), 'http://127.0.0.1:4000/v1/tools')
})

test('relayWebToolsBase derives <llm root>/v1/tools from the stored relay chat base without doubling /v1', () => {
  // The client stores the bootstrap PublicBaseURL, which already ends in /v1
  // (`…/v2/assist/llm/v1`): the 2026-10-26 production probe caught a naive
  // `${base}/v1/tools` producing `…/v1/v1/tools` (a 404 on the relay).
  const root = 'https://www.metaso.network/assist-open-api/v2/assist/llm'
  assert.equal(relayWebToolsBase(`${root}/v1`), `${root}/v1/tools`)
  assert.equal(relayWebToolsBase(`${root}/v1/`), `${root}/v1/tools`)
  assert.equal(relayWebToolsBase(root), `${root}/v1/tools`)
  assert.equal(relayWebToolsBase(`${root}/`), `${root}/v1/tools`)
  assert.equal(relayWebToolsBase(`${root}/v1/tools`), `${root}/v1/tools`, 'idempotent on an already-derived base')
  assert.equal(relayWebToolsBase(` ${root}/v1 `), `${root}/v1/tools`, 'whitespace trimmed')
})

test('resolveDeepSeekWebToolsUpstream picks the enabled official DeepSeek entry only', () => {
  const isOfficial = ({ key, baseUrl }) => key === 'deepseek' || /api\.deepseek\.com/.test(baseUrl ?? '')
  assert.deepEqual(
    resolveDeepSeekWebToolsUpstream({
      zhipu: { enabled: true, apiKey: 'sk-z', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      deepseek: { enabled: true, apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1' },
    }, isOfficial),
    { label: 'deepseek', apiKey: 'sk-ds', baseURL: 'https://api.deepseek.com/v1/tools' },
  )
  assert.equal(resolveDeepSeekWebToolsUpstream({ deepseek: { enabled: false, apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com' } }, isOfficial), null)
  assert.equal(resolveDeepSeekWebToolsUpstream({ deepseek: { enabled: true, apiKey: '', baseUrl: 'https://api.deepseek.com' } }, isOfficial), null)
  assert.equal(resolveDeepSeekWebToolsUpstream({ relay: { enabled: true, apiKey: 'sk-r', baseUrl: 'http://relay.example/v1' } }, isOfficial), null)
  assert.equal(resolveDeepSeekWebToolsUpstream({}, isOfficial), null)
})

test('proxy: healthz, auth gate, unsupported route', async (t) => {
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => null,
    resolveRelayUpstream: async () => null,
    log: () => undefined,
  })
  t.after(() => proxy.stop())
  const origin = proxy.baseURL.replace(/\/anthropic\/v1$/, '')
  const health = await fetch(`${origin}/healthz`)
  assert.equal(health.status, 200)
  assert.equal((await callProxy(proxy, 'search', { query: 'x' }, null)).status, 401, 'missing bearer is refused')
  assert.equal((await callProxy(proxy, 'search', { query: 'x' }, 'not-the-token')).status, 401, 'wrong bearer is refused')
  const legacy = await fetch(`${proxy.baseURL}/messages`, { method: 'POST', headers: { authorization: `Bearer ${proxy.token}` }, body: '{}' })
  assert.equal(legacy.status, 501, 'the legacy Messages-turn path is not served')
})

test('proxy: the user\'s DeepSeek key serves first and the relay is never consulted', async (t) => {
  const deepseek = await startUpstream()
  const relay = await startUpstream()
  t.after(async () => { await deepseek.close(); await relay.close() })
  deepseek.script.push({ status: 200, body: OK_RESULTS })
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: deepseek.toolsBase, apiKey: 'sk-user' }),
    resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
    log: () => undefined,
  })
  t.after(() => proxy.stop())

  const result = await callProxy(proxy, 'search', { query: 'node release', count: 5 })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json, OK_RESULTS, 'the upstream body passes through untouched')
  assert.equal(deepseek.seen.length, 1)
  assert.equal(deepseek.seen[0].url, '/v1/tools/search')
  assert.equal(deepseek.seen[0].auth, 'Bearer sk-user', 'the user\'s own key rides to DeepSeek')
  assert.deepEqual(deepseek.seen[0].body, { query: 'node release', count: 5 }, 'request body forwarded verbatim')
  assert.equal(relay.seen.length, 0, 'relay untouched while DeepSeek works')
})

test('proxy: DeepSeek 402 marks the upstream unusable for the TTL and the relay serves until it elapses', async (t) => {
  const deepseek = await startUpstream()
  const relay = await startUpstream()
  t.after(async () => { await deepseek.close(); await relay.close() })
  let now = 1_000_000
  const logs = []
  deepseek.script.push({ status: 402, body: { error: { message: 'Insufficient Balance' } } })
  relay.script.push({ status: 200, body: OK_RESULTS }, { status: 200, body: OK_RESULTS })
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: deepseek.toolsBase, apiKey: 'sk-user' }),
    resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
    now: () => now,
    exhaustedTtlMs: 60_000,
    log: (line) => logs.push(line),
  })
  t.after(() => proxy.stop())

  const first = await callProxy(proxy, 'search', { query: 'q1' })
  assert.equal(first.status, 200, 'the caller sees the relay result, not the 402')
  assert.deepEqual(first.json, OK_RESULTS)
  assert.equal(deepseek.seen.length, 1, 'DeepSeek was tried once')
  assert.equal(relay.seen.length, 1, 'then the relay served')
  assert.equal(relay.seen[0].auth, 'Bearer mrk_relay', 'the relay key rides to the relay')
  assert.ok(logs.some((l) => l.includes('marked unusable (HTTP 402)')), 'the transition is logged')

  now += 30_000
  const second = await callProxy(proxy, 'search', { query: 'q2' })
  assert.equal(second.status, 200)
  assert.equal(deepseek.seen.length, 1, 'inside the TTL DeepSeek is skipped')
  assert.equal(relay.seen.length, 2, 'the relay keeps serving')

  now += 31_000
  deepseek.script.push({ status: 200, body: OK_RESULTS })
  const third = await callProxy(proxy, 'search', { query: 'q3' })
  assert.equal(third.status, 200)
  assert.equal(deepseek.seen.length, 2, 'after the TTL DeepSeek is probed again')
  assert.equal(relay.seen.length, 2, 'and a recovered DeepSeek serves without the relay')
  assert.ok(logs.some((l) => l.includes('suppression elapsed')), 'the re-probe is logged')
})

test('proxy: 401 and 403 from DeepSeek also fall back and mark; 5xx and 429 fall back WITHOUT marking', async (t) => {
  for (const status of [401, 403]) {
    const deepseek = await startUpstream()
    const relay = await startUpstream()
    deepseek.script.push({ status, body: { error: { message: 'bad key' } } })
    relay.script.push({ status: 200, body: OK_RESULTS }, { status: 200, body: OK_RESULTS })
    const proxy = await createDshWebToolsProxy({
      resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: deepseek.toolsBase, apiKey: 'sk-user' }),
      resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
      log: () => undefined,
    })
    assert.equal((await callProxy(proxy, 'search', { query: 'a' })).status, 200)
    assert.equal((await callProxy(proxy, 'search', { query: 'b' })).status, 200)
    assert.equal(deepseek.seen.length, 1, `HTTP ${status} marks DeepSeek: second call skips it`)
    assert.equal(relay.seen.length, 2)
    await proxy.stop(); await deepseek.close(); await relay.close()
  }
  for (const status of [500, 503, 429]) {
    const deepseek = await startUpstream()
    const relay = await startUpstream()
    deepseek.script.push({ status, body: { error: { message: 'transient' } } }, { status: 200, body: OK_RESULTS })
    relay.script.push({ status: 200, body: OK_RESULTS })
    const proxy = await createDshWebToolsProxy({
      resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: deepseek.toolsBase, apiKey: 'sk-user' }),
      resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
      log: () => undefined,
    })
    assert.equal((await callProxy(proxy, 'search', { query: 'a' })).status, 200, `HTTP ${status}: relay served this call`)
    assert.equal(relay.seen.length, 1)
    assert.equal((await callProxy(proxy, 'search', { query: 'b' })).status, 200)
    assert.equal(deepseek.seen.length, 2, `HTTP ${status} did NOT mark DeepSeek: the next call tries it again`)
    assert.equal(relay.seen.length, 1, 'and DeepSeek served it')
    await proxy.stop(); await deepseek.close(); await relay.close()
  }
})

test('proxy: a 4xx request fault from DeepSeek is returned as-is (the relay would fail the same way)', async (t) => {
  const deepseek = await startUpstream()
  const relay = await startUpstream()
  t.after(async () => { await deepseek.close(); await relay.close() })
  deepseek.script.push({ status: 400, body: { error: { message: 'query is required' } } })
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: deepseek.toolsBase, apiKey: 'sk-user' }),
    resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
    log: () => undefined,
  })
  t.after(() => proxy.stop())
  const result = await callProxy(proxy, 'search', {})
  assert.equal(result.status, 400)
  assert.equal(result.json.error.message, 'query is required')
  assert.equal(relay.seen.length, 0)
})

test('proxy: an unreachable DeepSeek upstream falls through to the relay', async (t) => {
  const relay = await startUpstream()
  t.after(() => relay.close())
  relay.script.push({ status: 200, body: OK_RESULTS })
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: 'http://127.0.0.1:1/v1/tools', apiKey: 'sk-user' }),
    resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
    log: () => undefined,
  })
  t.after(() => proxy.stop())
  const result = await callProxy(proxy, 'search', { query: 'x' })
  assert.equal(result.status, 200)
  assert.equal(relay.seen.length, 1)
})

test('proxy: no DeepSeek key → the relay serves directly; relay errors are final and pass through', async (t) => {
  const relay = await startUpstream()
  t.after(() => relay.close())
  relay.script.push(
    { status: 200, body: OK_RESULTS },
    { status: 429, body: { error: { message: 'free search quota exhausted', code: 'free_quota_exhausted' } } },
  )
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => null,
    resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
    log: () => undefined,
  })
  t.after(() => proxy.stop())
  assert.equal((await callProxy(proxy, 'search', { query: 'x' })).status, 200)
  const exhausted = await callProxy(proxy, 'search', { query: 'y' })
  assert.equal(exhausted.status, 429)
  assert.equal(exhausted.json.error.code, 'free_quota_exhausted', 'the relay\'s own quota answer reaches the plugin')
})

test('proxy: with no upstream at all the plugin gets an actionable 503', async (t) => {
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => null,
    resolveRelayUpstream: async () => { throw new Error('relay bootstrap offline') },
    log: () => undefined,
  })
  t.after(() => proxy.stop())
  const result = await callProxy(proxy, 'search', { query: 'x' })
  assert.equal(result.status, 503)
  assert.match(result.json.error.message, /DeepSeek API key/)
  assert.match(result.json.error.message, /ID\.Bots/)
})

test('proxy: /fetch rides the same ladder', async (t) => {
  const deepseek = await startUpstream()
  const relay = await startUpstream()
  t.after(async () => { await deepseek.close(); await relay.close() })
  deepseek.script.push({ status: 402, body: { error: { message: 'Insufficient Balance' } } })
  relay.script.push({ status: 200, body: { title: 'Example', content: '# Example' } })
  const proxy = await createDshWebToolsProxy({
    resolveDeepSeekUpstream: () => ({ label: 'deepseek', baseURL: deepseek.toolsBase, apiKey: 'sk-user' }),
    resolveRelayUpstream: async () => ({ label: 'idbots-free', baseURL: relay.toolsBase, apiKey: 'mrk_relay' }),
    log: () => undefined,
  })
  t.after(() => proxy.stop())
  const result = await callProxy(proxy, 'fetch', { url: 'https://example.org' })
  assert.equal(result.status, 200)
  assert.equal(result.json.content, '# Example')
  assert.equal(deepseek.seen[0].url, '/v1/tools/fetch')
  assert.equal(relay.seen[0].url, '/v1/tools/fetch')
  assert.deepEqual(relay.seen[0].body, { url: 'https://example.org' })
})
