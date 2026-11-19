// Empty-length-stop overflow regression (session cw-636ddce2, 2026-11-19).
//
// A gateway whose request fills the model's context window may answer with a
// NORMAL `length` stop carrying a few reasoning tokens instead of a
// CONTEXT_WINDOW_EXCEEDED error (opencode zen: output=16, input+cacheRead at
// the window boundary). Two committed kernel patches recover that:
//
//   1. @earendil-works+pi-ai — isContextOverflow Case 3 accepts a
//      SILENT_OVERFLOW_OUTPUT_SLACK output budget, so the finish classifies
//      as CONTEXT_WINDOW_EXCEEDED and compaction-basic compacts + retries.
//   2. @deepseek-ai+dsh-agent-loop — the adapter-agnostic net that diverts a
//      still-masquerading max-tokens finish (empty content, <=64 output
//      tokens) into the agent/request-error waterfall.
//
// This test pins the recovery end to end: the overflowing turn must COMPILE
// back to a normal completed turn (compaction event + retried request), and
// a length stop beyond the slack must still settle as max-tokens (no false
// positive).
//
// Run: node test/empty-length-stop-overflow.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'

const CONTEXT_WINDOW = 1400
const FILLER = 'x'.repeat(1800) // ~450 tokens per prompt

// Output-token slack the gateway may report and still be the window boundary
// (mirrors SILENT_OVERFLOW_OUTPUT_SLACK in the pi-ai patch and the
// EMPTY_LENGTH_STOP_OUTPUT_TOKEN_CEILING net in the agent-loop patch).
const SLACK = 16
const BEYOND_SLACK = 500

/** Minimal OpenAI-compatible SSE gateway with scripted length-stop replies. */
async function startScriptedServer(port) {
  const seen = []
  const served = { overflow: false, strict: false }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      seen.push({ url: req.url, body: parsed })
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const base = { id: 'chatcmpl-scripted', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'mock-1' }
      const messages = parsed.messages ?? []
      const raw = JSON.stringify(messages)
      const requestChars = messages.reduce((sum, m) => sum + String(m.content ?? '').length, 0)
      const promptTokens = Math.max(1, Math.ceil(requestChars / 4))
      const lengthStop = (completionTokens) => {
        // NO content deltas — the stream ends at the window boundary with
        // only the reported reasoning-token count.
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
        frame({ ...base, choices: [], usage: { prompt_tokens: Math.max(promptTokens, Math.floor(CONTEXT_WINDOW * 0.997)), completion_tokens: completionTokens, total_tokens: Math.max(promptTokens, Math.floor(CONTEXT_WINDOW * 0.997)) + completionTokens } })
        res.write('data: [DONE]\n\n')
        res.end()
      }
      if (raw.includes('OVERFLOW_ME') && !served.overflow) {
        // Report input at the window boundary and output inside the slack —
        // exactly the cw-636ddce2 signature (output=16 vs a ===0 check).
        served.overflow = true
        lengthStop(SLACK)
        return
      }
      if (raw.includes('OVERFLOW_STRICT_ME') && !served.strict) {
        // Output beyond the slack with no content: NOT classifiable as the
        // window boundary — must stay a plain max-tokens finish.
        served.strict = true
        lengthStop(BEYOND_SLACK)
        return
      }
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
      const reply = `ack: ${String(lastUser?.content ?? '').slice(0, 24).trim() || 'ok'}`
      frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      frame({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 8, total_tokens: promptTokens + 8 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { server, seen }
}

const main = async () => {
  const { server, seen } = await startScriptedServer(48799)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lenstop-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48799/v1', apiKeyEnv: 'LENSTOP_KEY',
      models: [{ id: 'mock-1', contextWindow: CONTEXT_WINDOW }],
    }],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-lenstop-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(process.cwd(), 'bin.mjs'), configPath],
    env: { ...process.env, LENSTOP_KEY: 'sk-lenstop', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: process.cwd(), provider: 'mockgw', model: 'mock-1' })
  const sessionId = `lenstop-${Date.now().toString(36)}`

  const waiters = new Set()
  const sessionEvents = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        sessionEvents.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})
  const waitForEvent = (predicate, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for session event')), timeoutMs)
    const wait = (event) => { if (predicate(event)) { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })

  // Turn 1: normal exchange — builds compactable history for the recovery.
  let ended = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: `FILLER turn 1: ${FILLER}` }])
  await ended
  assert.equal(sessionEvents.at(-1).data.reason.kind, 'completed', 'turn 1 completes normally')

  // Turn 2: the scripted window-boundary length stop (output=16, input at
  // 99.7% of the window). The patched kernel must classify it as a context
  // overflow, compact the surface, retry the request, and COMPLETE the turn —
  // never settle as max-tokens.
  ended = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: `OVERFLOW_ME FILLER turn 2: ${FILLER}` }])
  await ended
  const turn2End = sessionEvents.at(-1)
  assert.equal(turn2End.data.reason.kind, 'completed', `turn 2 recovers via compaction instead of dying as ${turn2End.data.reason.kind}`)
  const compactionKinds = [...new Set(sessionEvents.filter((e) => String(e.type).startsWith('compaction/')).map((e) => e.type))]
  assert.ok(compactionKinds.length > 0, 'a compaction ran during the overflow recovery')
  const conversationRequests = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('OVERFLOW_ME'))
  assert.ok(conversationRequests.length >= 2, 'the overflowing request was retried after compaction')
  const finalAssistant = sessionEvents.filter((e) => e.type === 'assistant/message').at(-1)
  const finalText = (finalAssistant?.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.ok(finalText.startsWith('ack:'), `the retried step produced a real answer (${JSON.stringify(finalText.slice(0, 40))})`)

  // Turn 3: length stop with output beyond the slack — must stay max-tokens
  // (the masquerade signature is intentionally narrow; no false positive).
  ended = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: `OVERFLOW_STRICT_ME FILLER turn 3: ${FILLER}` }])
  await ended
  assert.equal(sessionEvents.at(-1).data.reason.kind, 'max-tokens', 'a length stop beyond the output slack still settles as max-tokens')

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('PASS  empty length-stop overflow compacts, retries, and completes; beyond-slack stays max-tokens')
  process.exit(0)
}

main().catch((error) => {
  console.error('[empty-length-stop-test] fatal:', error)
  process.exit(1)
})
