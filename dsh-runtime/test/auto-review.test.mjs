// Auto-review E2E (0.2.2 headless integration): the host policy bridge can
// answer idbots/policy/respond with decision "review", and the pending gated
// call is then judged by the session's own model (plugins/idbots-auto-review
// .mjs) before execution:
//
//  1. allow verdict  -> the bash body executes and its output reaches the tool
//     result; the reviewer request carried the pending action and env
//  2. deny verdict   -> fail-closed final denial naming the risk tier and the
//     reviewer's reason; the body never executes
//  3. malformed verdict (prose instead of the JSON protocol) -> reviewer
//     failure also denies; it must never fail open
//
// Run: node test/auto-review.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const main = async () => {
  const { server, seen } = await startMockServer(48840)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoreview-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoreview-ws-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48840/v1', apiKeyEnv: 'AUTO_REVIEW_KEY',
      models: [{ id: 'mock-1', contextWindow: 32000 }],
    }],
    sections: [],
    workspace: { cwd: workspace },
  })
  const configPath = path.join(os.tmpdir(), `dsh-autoreview-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, AUTO_REVIEW_KEY: 'sk-autoreview', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: workspace, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `autoreview-${Date.now().toString(36)}`

  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
      }
      // The emulated host posture: unattended sessions answer bash policy
      // checks with "review" instead of a blind allow (the
      // shouldAutoReviewDshToolCall counterpart lives host-side).
      if (notification.method === 'idbots/policy/request' && notification.params.name === 'bash') {
        void client.request('idbots/policy/respond', { id: notification.params.id, decision: 'review' }).catch(() => {})
      }
      for (const wait of waiters) wait(notification)
    }
  })()
  pumping.catch(() => {})
  const waitFor = (predicate, timeoutMs = 40000, what = 'event') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what} (${events.map((e) => e.type).join(',')})`)), timeoutMs)
    const wait = (notification) => {
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId && predicate(notification.params.event)) {
        clearTimeout(timer)
        waiters.delete(wait)
        resolve(notification.params.event)
      }
    }
    waiters.add(wait)
  })
  const runTurn = async (text) => {
    const end = waitFor((e) => e.type === 'turn/end', 40000, `turn end for "${text}"`)
    await client.prompt(sessionId, [{ type: 'text', text }])
    return await end
  }
  const toolResultText = (event) => JSON.stringify(event.data?.message ?? {})
  // Plain rendered text of the tool result's text blocks — prose assertions
  // must match this, not the JSON.stringify form (quotes get escaped there).
  const toolResultProse = (event) => (event.data?.message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const findToolResult = (needle) => events.find((e) => e.type === 'tool/result' && toolResultText(e).includes(needle))

  try {
    // ---- 1. allow verdict --------------------------------------------------
    {
      const end = await runTurn('CALL_BASH_REVIEW_ALLOW please')
      const result = findToolResult('AUTO_REVIEW_ALLOW_OK')
      assert.ok(result, 'allow verdict lets the bash body execute (output in tool result)')
      assert.ok(!toolResultText(result).includes('"isError":true'), 'allow path yields a non-error tool result')
      assert.equal(end.data?.reason?.kind, 'completed', 'allow turn completes')
      const reviewSeen = seen.find((r) => JSON.stringify(r.body?.messages ?? []).includes('REVIEW_POLICY'))
      assert.ok(reviewSeen, 'reviewer one-shot reached the gateway')
      const reviewPayload = JSON.stringify(reviewSeen.body?.messages ?? [])
      assert.ok(reviewPayload.includes('AUTO_REVIEW_ALLOW_OK'), 'reviewer request carries the pending action arguments')
      assert.ok(reviewPayload.includes('PENDING_ACTION'), 'reviewer request carries the pending action frame')
      assert.ok(reviewPayload.includes('CALL_BASH_REVIEW_ALLOW'), 'reviewer request carries the user instruction frame')
      console.log('PASS  allow verdict executes the call and the reviewer saw the action')
    }

    // ---- 2. deny verdict ---------------------------------------------------
    {
      await runTurn('CALL_BASH_REVIEW_DENY please')
      const result = events.filter((e) => e.type === 'tool/result').at(-1)
      assert.ok(result, 'deny path still settles a tool result')
      assert.ok(toolResultText(result).includes('"isError":true'), 'deny path yields an error tool result')
      const prose = toolResultProse(result)
      assert.ok(prose.includes('Auto review denied tool "bash" (medium risk)'), 'denial names the tool and risk tier')
      assert.ok(prose.includes('destructive deletion is not authorized'), 'denial carries the reviewer reason verbatim')
      console.log('PASS  deny verdict fails closed with the reviewer reason')
    }

    // ---- 3. malformed verdict ----------------------------------------------
    {
      await runTurn('CALL_BASH_REVIEW_MALFORMED please')
      const result = events.filter((e) => e.type === 'tool/result').at(-1)
      assert.ok(result, 'malformed reviewer output still settles a tool result')
      assert.ok(toolResultText(result).includes('"isError":true'), 'malformed review yields an error tool result')
      assert.ok(toolResultProse(result).includes('Auto review of tool "bash" failed'), 'reviewer failure fails closed (deny, never fail open)')
      console.log('PASS  malformed reviewer output fails closed')
    }
  } finally {
    subscription.close()
    await Promise.race([client.close(), new Promise((resolve) => setTimeout(resolve, 10000))]).catch(() => {})
    server.closeAllConnections?.()
    await Promise.race([new Promise((resolve) => server.close(() => resolve())), new Promise((resolve) => setTimeout(resolve, 5000))])
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }

  console.log('\nauto-review E2E: all checks passed')
  process.exit(0)
}

main().catch((error) => {
  console.error('[auto-review-test] fatal:', error)
  process.exit(1)
})
