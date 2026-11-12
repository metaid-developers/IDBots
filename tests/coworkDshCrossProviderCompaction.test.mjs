// Cross-provider re-pin must mount the session's PREVIOUS provider so the
// kernel's pre-switch compaction can summarize through it.
//
// Incident (session cw-4b78a0fd-2b41-4c98-a67d-6ab0aa6ddc73, 2026-11-12): the
// session grew ~2MB of history on deepseek-official (1M window), then the bot
// switched to metaid-free/deepseek-4.1-flash. Runtime slots are keyed per
// provider (dshRuntimeKeyOf), so the switch re-pinned the session onto the
// metaid-free slot whose composition never mounted deepseek-official. The
// kernel's model-switch pricing compacts BEFORE honoring the switch and
// resolves its summarizer from the session's last routed request
// (deepseek-official) — `no adapter registered for provider
// "deepseek-official"` → MODEL_SWITCH_COMPACTION_FAILED → every turn died
// with no compaction, no switch, no reply (and the manual compact button hit
// the same wall).
//
// Fix: the hub mounts the previous provider's route into the new slot's
// composition (DshEnsureKernelOptions.mountProviders). The previous route is
// remembered per DSH session id — in memory (routeByDsh) and in a JSON hint
// file next to the session root so the first cross-provider turn AFTER AN APP
// RESTART mounts it too.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-crossprov-${name}`),
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

/** Mock OpenAI chat endpoint that records every completion call and answers
 *  from the requested model id. Reply size is driven by the LAST user message
 *  carrying a size marker (FAT_REPLY ~154KB / MEDIUM_REPLY ~46KB / default
 *  short): the kernel appends volatile context (a time-zone sample) AFTER the
 *  prompt and its summarization request replays the whole conversation with
 *  the compaction instruction appended last, so payload-wide matching cannot
 *  tell the turns apart. The instruction's first line is the stable
 *  compaction marker. */
function startRecordingMock(port) {
  const seen = []
  const FAT_TEXT = 'history filler. '.repeat(11_000) // ~154KB ≈ 38K tokens
  const MEDIUM_TEXT = 'medium filler. '.repeat(3_200) // ~46KB ≈ 11K tokens
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      seen.push({ method: req.method, url: req.url, body: parsed, at: Date.now() })
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'big-model', object: 'model' }, { id: 'small-model', object: 'model' }],
        }))
        return
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const model = parsed.model ?? 'big-model'
      // Reply shape by message role, not raw payload matching: the kernel
      // appends volatile context (e.g. a time-zone sample) AFTER the prompt,
      // and its summarization request replays the whole conversation
      // (including the FAT_REPLY user turn) with the compaction instruction
      // appended LAST — so "last user message mentions FAT_REPLY" misses
      // turn 1 and "any message mentions it" would stream filler as the
      // summary. The instruction's first line is the stable marker.
      const messageText = (message) => typeof message?.content === 'string'
        ? message.content
        : JSON.stringify(message?.content ?? [])
      const messages = parsed.messages ?? []
      const lastUserText = messageText([...messages].reverse().find((message) => message?.role === 'user'))
      const isCompactionCall = lastUserText.includes('acting as a compaction engine')
      const marker = isCompactionCall
        ? null
        : [...messages].reverse()
          .map((message) => (message?.role === 'user' ? messageText(message) : ''))
          .find((text) => text.includes('FAT_REPLY') || text.includes('MEDIUM_REPLY'))
      const wantsFat = marker?.includes('FAT_REPLY') ?? false
      const wantsMedium = marker?.includes('MEDIUM_REPLY') ?? false
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model }
      frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      const filler = wantsFat ? FAT_TEXT : wantsMedium ? MEDIUM_TEXT : ''
      if (filler) {
        // Chunked so no single SSE frame carries the whole payload.
        for (let offset = 0; offset < filler.length; offset += 8_000) {
          frame({ ...base, choices: [{ index: 0, delta: { content: filler.slice(offset, offset + 8_000) }, finish_reason: null }] })
        }
      } else {
        frame({ ...base, choices: [{ index: 0, delta: { content: `ok:${model}` }, finish_reason: null }] })
      }
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      frame({ ...base, choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } })
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, seen }))
  })
}

const callbacks = () => ({
  onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
  onMessageUpdate: () => undefined,
  onMessageFinalize: () => undefined,
  onUsage: () => undefined,
  onApprovalRequest: () => undefined,
  onApprovalCancelled: () => undefined,
  onError: () => undefined,
})

const bigRoute = (port) => ({
  key: 'prov-big', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: 'sk-big', model: 'big-model', contextWindow: 1_000_000, maxOutputTokens: 8_192,
})
const smallRoute = (port) => ({
  key: 'prov-small', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: 'sk-small', model: 'small-model', contextWindow: 32_768, maxOutputTokens: 4_096,
})

const mkHub = ({ DshTurnHub }, sessionRoot) => new DshTurnHub({
  runtimeDir,
  sessionRoot,
  mcpServersProvider: () => [],
  log: () => undefined,
})

const run = (hub, dshSessionId, provider, prompt) => hub.runTurn({
  sessionId: dshSessionId.replace(/^cw-/, 'cowork-'),
  dshSessionId,
  provider,
  sections: [],
  prompt,
  workspace: { cwd: os.tmpdir() },
  callbacks: callbacks(),
})

const completions = (seen) => seen.filter((r) => r.method === 'POST' && r.url.endsWith('/chat/completions'))

/** The kernel's summarization call: the compaction instruction ("You are now
 *  acting as a compaction engine…") is appended as the final user message. */
const compactionCalls = (seen) => completions(seen).filter((r) => {
  const messages = r.body?.messages ?? []
  const text = (message) => typeof message?.content === 'string'
    ? message.content
    : JSON.stringify(message?.content ?? [])
  return text([...messages].reverse().find((message) => message?.role === 'user')).includes('acting as a compaction engine')
})

test('cross-provider switch compacts through the previous provider (same app run)', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { server, seen } = await startRecordingMock(48861)
  // Mirror the production layout: <userData>/dsh-sessions/v0 with the hint
  // directory at <userData>/dsh-sessions/route-hints (session root's sibling).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-crossprov-a-'))
  const sessionRoot = path.join(base, 'sessions', 'v0')
  const hub = mkHub({ DshTurnHub }, sessionRoot)

  try {
    // Turn 1 on the large-window provider: a ~38K-token reply.
    const first = await run(hub, 'cw-cross-a', bigRoute(48861), 'TOKEN_TURN_ONE FAT_REPLY')
    assert.equal(first.kind, 'completed', `turn 1 should complete, got ${JSON.stringify(first)}`)

    // Turn 2 stays on the large provider but leaves a retained tail
    // (~11K tokens > the small route's 16% retention budget, 5,243 tokens)
    // so the fat node sits OUTSIDE the tail and is compactable. Without
    // enough tail mass the fat node would be the newest retained node and
    // no compaction range could ever reach it.
    const tail = await run(hub, 'cw-cross-a', bigRoute(48861), 'TOKEN_TURN_TWO MEDIUM_REPLY')
    assert.equal(tail.kind, 'completed', `tail turn should complete, got ${JSON.stringify(tail)}`)

    // Turn 3 re-pins the SAME session onto the small provider's runtime slot.
    // Pre-fix: MODEL_SWITCH_COMPACTION_FAILED / `no adapter registered for
    // provider "prov-big"` — the small slot never mounted prov-big.
    const third = await run(hub, 'cw-cross-a', smallRoute(48861), 'TOKEN_TURN_THREE')
    assert.equal(third.kind, 'completed', `turn 3 should complete after compaction-backed switch, got ${JSON.stringify(third)}`)

    const calls = completions(seen)
    const turnThree = calls.find((r) => JSON.stringify(r.body?.messages ?? []).includes('TOKEN_TURN_THREE'))
    assert.ok(turnThree, 'turn 3 completion call recorded')
    assert.equal(turnThree.body?.model, 'small-model', `turn 3 must run on small-model, got ${turnThree.body?.model}`)
    // The pre-switch summarization ran through the PREVIOUS provider's
    // adapter — that is the regression this file pins: without the mounted
    // prov-big route the turn died with `no adapter registered for provider
    // "prov-big"` before any request could go out.
    const summaries = compactionCalls(seen)
    assert.equal(summaries.length, 1, `expected exactly one pre-switch summarization call, got ${summaries.length}`)
    assert.equal(summaries[0].body?.model, 'big-model', `summarization must run on the previous provider's model, got ${summaries[0].body?.model}`)
    // The compaction succeeded: turn 3's request no longer carries the fat
    // filler in its prompt. (The medium tail stays by design — it IS the
    // retained region.)
    assert.doesNotMatch(
      JSON.stringify(turnThree.body?.messages ?? []),
      /history filler\./,
      'turn 3 prompt must exclude the compacted filler history',
    )
  } finally {
    await hub.close?.().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

test('cross-provider switch compacts after an app restart via the route hint', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { server, seen } = await startRecordingMock(48862)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-crossprov-b-'))
  const sessionRoot = path.join(base, 'sessions', 'v0')
  // Hub 1 = the app run before the restart: fat + retained-tail turns on the
  // big provider (same shape as test 1).
  const hub1 = mkHub({ DshTurnHub }, sessionRoot)
  const first = await run(hub1, 'cw-cross-b', bigRoute(48862), 'TOKEN_TURN_ONE FAT_REPLY')
  assert.equal(first.kind, 'completed', `turn 1 should complete, got ${JSON.stringify(first)}`)
  const tail = await run(hub1, 'cw-cross-b', bigRoute(48862), 'TOKEN_TURN_TWO MEDIUM_REPLY')
  assert.equal(tail.kind, 'completed', `tail turn should complete, got ${JSON.stringify(tail)}`)
  await hub1.close?.().catch(() => undefined)

  // Hub 2 = a fresh process: no in-memory routeByDsh; the JSON hint next to
  // the session root is the only carrier of \"this session last ran on
  // prov-big\". The switch onto the small provider must still compact through
  // prov-big's adapter.
  const hub2 = mkHub({ DshTurnHub }, sessionRoot)
  try {
    const third = await run(hub2, 'cw-cross-b', smallRoute(48862), 'TOKEN_TURN_THREE')
    assert.equal(third.kind, 'completed', `post-restart switch should complete, got ${JSON.stringify(third)}`)
    const calls = completions(seen)
    const turnThree = calls.find((r) => JSON.stringify(r.body?.messages ?? []).includes('TOKEN_TURN_THREE'))
    assert.ok(turnThree, 'turn 3 completion call recorded')
    assert.equal(turnThree.body?.model, 'small-model', `turn 3 must run on small-model, got ${turnThree.body?.model}`)
    // The hint file is hub 2's ONLY knowledge of prov-big — the summarization
    // still has to run through prov-big's adapter (mounted from the hint).
    const summaries = compactionCalls(seen)
    assert.equal(summaries.length, 1, `expected exactly one pre-switch summarization call, got ${summaries.length}`)
    assert.equal(summaries[0].body?.model, 'big-model', `summarization must run on the previous provider's model, got ${summaries[0].body?.model}`)
    assert.doesNotMatch(
      JSON.stringify(turnThree.body?.messages ?? []),
      /history filler\./,
      'turn 3 prompt must exclude the compacted filler history',
    )
  } finally {
    await hub2.close?.().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})
