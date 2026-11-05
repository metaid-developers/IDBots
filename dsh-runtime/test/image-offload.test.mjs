// Image offload E2E: an image-capable pi-ai route whose request-image bound
// is exceeded by history must RECOVER, not fail the turn.
// @deepseek-ai/dsh-compaction-image-offload answers the adapter's
// IMAGE_OFFLOAD_REQUIRED failure on the agent/request-error waterfall with a
// durable image/offload decision plus a retry, so the turn completes and
// every later request carries a placeholder for the offloaded occurrences
// instead of their base64 bytes.
//
// Regression (v1.0.2 user report): the executor was never mounted, so every
// computer-use session that accumulated enough screenshots died with
// "pi-ai request images exceed the 20971520-byte base64 bound; N more oldest
// occurrence(s) must be offloaded." — and typing "continue" failed the same
// way, because nothing ever shrank the image history. The CONTROL run below
// reproduces that with the mount stripped from the generated config; the
// FIXED run proves the recovery, then restarts the runtime and resumes the
// same session to prove the offload decisions replay from the persisted log.
//
// Run: node test/image-offload.test.mjs   (from dsh-runtime/)

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

// 1x1 transparent PNG (70 encoded bytes). readImageRequest passes a source
// that already fits the route's request pixel/byte targets through unchanged,
// so every occurrence costs exactly base64Length(70) = 96 bytes of the bound.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const IMAGE_BASE64_BYTES = 4 * Math.ceil(Buffer.from(PNG_1x1_BASE64, 'base64').byteLength / 3)
// Two retained occurrences fit; the third exceeds the bound by less than one
// image, so each image-bearing turn past the second must offload exactly one.
const MAX_REQUEST_IMAGE_BYTES = 2 * IMAGE_BASE64_BYTES + Math.floor(IMAGE_BASE64_BYTES / 2)
const RETAINED_IMAGES = 2
const INLINE_IMAGE_MARKER = 'data:image/png;base64,'
const OFFLOADED_PLACEHOLDER = 'image omitted to fit request image limits'

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const countOf = (haystack, needle) => haystack.split(needle).length - 1
const requestPayload = (request) => JSON.stringify(request?.body?.messages ?? [])

/** Generated composition with the pi-ai route bound lowered to the test
 *  budget; `mountImageOffload: false` strips the executor to reproduce the
 *  pre-fix composition. */
const composeConfig = ({ sessionRoot, port, mountImageOffload }) => {
  const entries = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'OFFLOAD_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768, input: ['text', 'image'] }],
    }],
    sections: [],
  })
  const piAi = entries.find((entry) => entry.id === 'llm-pi-ai')
  assert.ok(piAi?.config?.providers?.mockgw, 'generated config carries the pi-ai mockgw route')
  piAi.config.providers.mockgw.maxRequestImageBytes = MAX_REQUEST_IMAGE_BYTES
  const mounted = entries.some((entry) => entry.name === '@deepseek-ai/dsh-compaction-image-offload')
  assert.ok(mounted, 'generateRuntimeConfig mounts @deepseek-ai/dsh-compaction-image-offload')
  return mountImageOffload ? entries : entries.filter((entry) => entry.name !== '@deepseek-ai/dsh-compaction-image-offload')
}

/** Boot one runtime process on `configPath` and pump the session's events. */
const bootRuntime = async ({ configPath, sessionId }) => {
  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, OFFLOAD_KEY: 'sk-offload', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })

  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})
  const waitForEvent = (predicate, what, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (event) => { if (predicate(event)) { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })
  const turnEnd = (turn) => waitForEvent((e) => e.type === 'turn/end' && e.data?.turn === turn, `turn ${turn} end`)
  const promptImage = (text) => client.request('idbots/prompt', {
    sessionId, text, images: [{ data: PNG_1x1_BASE64, mediaType: 'image/png', name: 'shot.png' }],
  })
  const promptText = (text) => client.request('idbots/prompt', { sessionId, text })
  const close = async () => { subscription.close(); await client.close() }
  return { client, events, turnEnd, promptImage, promptText, close }
}

const endReason = (event) => event?.data?.reason ?? {}
const describeEnd = (event) => {
  const reason = endReason(event)
  return reason.kind === 'error' ? `${reason.kind}:${reason.error?.code}` : String(reason.kind)
}

// ---------------------------------------------------------------------------
// CONTROL: the pre-fix composition (executor stripped). Two image turns fit,
// the third dies with IMAGE_OFFLOAD_REQUIRED, and "continue" dies the same
// way — the exact user-visible failure loop this change removes.
const runControl = async () => {
  const port = 48835
  const { server } = await startMockServer(port)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offload-control-'))
  const configPath = path.join(os.tmpdir(), `dsh-offload-control-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(composeConfig({ sessionRoot, port, mountImageOffload: false })))
  const sessionId = `offload-control-${Date.now().toString(36)}`
  const rt = await bootRuntime({ configPath, sessionId })

  for (const turn of [1, 2]) {
    const ended = rt.turnEnd(turn)
    await rt.promptImage(`screenshot ${turn}`)
    const end = await ended
    record(`control: image turn ${turn} fits the bound`, endReason(end).kind !== 'error', describeEnd(end))
  }
  const ended3 = rt.turnEnd(3)
  await rt.promptImage('screenshot 3')
  const end3 = await ended3
  record('control: third image turn fails with IMAGE_OFFLOAD_REQUIRED (unmounted executor)',
    endReason(end3).kind === 'error' && endReason(end3).error?.code === 'IMAGE_OFFLOAD_REQUIRED', describeEnd(end3))
  record('control: the failure names the bound and the offload count',
    // 0.2.2 / pi-ai 1.3.0 wording: the route image budget replaced the old
    // per-request base64 byte bound; the offload count is still named.
    /exceed the route image budget; 1 more oldest occurrence/.test(String(endReason(end3).error?.message)),
    String(endReason(end3).error?.message).slice(0, 120))
  const ended4 = rt.turnEnd(4)
  await rt.promptText('continue')
  const end4 = await ended4
  record('control: "continue" fails identically — nothing shrank the image history',
    endReason(end4).kind === 'error' && endReason(end4).error?.code === 'IMAGE_OFFLOAD_REQUIRED', describeEnd(end4))
  record('control: no image/offload decision was ever recorded', !rt.events.some((e) => e.type === 'image/offload'))

  await rt.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
}

// ---------------------------------------------------------------------------
// FIXED: the shipped composition. The same conversation completes every turn,
// each over-budget request records one image/offload decision and retries,
// later requests carry placeholders, and the decisions survive a restart.
const runFixed = async () => {
  const port = 48836
  const { server, seen } = await startMockServer(port)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offload-fixed-'))
  const configPath = path.join(os.tmpdir(), `dsh-offload-fixed-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(composeConfig({ sessionRoot, port, mountImageOffload: true })))
  const sessionId = `offload-fixed-${Date.now().toString(36)}`
  let rt = await bootRuntime({ configPath, sessionId })

  const IMAGE_TURNS = 4
  for (let turn = 1; turn <= IMAGE_TURNS; turn += 1) {
    const ended = rt.turnEnd(turn)
    await rt.promptImage(`screenshot ${turn}`)
    const end = await ended
    record(`fixed: image turn ${turn} completes`, endReason(end).kind !== 'error', describeEnd(end))
  }
  const offloads = rt.events.filter((e) => e.type === 'image/offload')
  const expectedOffloads = IMAGE_TURNS - RETAINED_IMAGES
  record(`fixed: one image/offload decision per over-budget turn (${expectedOffloads})`,
    offloads.length === expectedOffloads, `saw ${offloads.length}`)
  record('fixed: each decision offloads exactly one oldest occurrence',
    offloads.every((e) => Array.isArray(e.data?.targets)
      && e.data.targets.reduce((n, t) => n + (t.imageIndexes?.length ?? 0), 0) === 1),
    JSON.stringify(offloads.map((e) => e.data?.targets)).slice(0, 160))

  // "continue" after the offloads: text-only turn, history still holds every
  // image occurrence — the retained ones inline, the offloaded ones as text.
  const ended5 = rt.turnEnd(IMAGE_TURNS + 1)
  await rt.promptText('CONTINUE_AFTER_OFFLOAD')
  const end5 = await ended5
  record('fixed: "continue" completes after offloads', endReason(end5).kind !== 'error', describeEnd(end5))
  const continueRequest = seen.filter((r) => requestPayload(r).includes('CONTINUE_AFTER_OFFLOAD')).at(-1)
  const payload = requestPayload(continueRequest)
  record('fixed: the follow-up request inlines only the retained occurrences',
    countOf(payload, INLINE_IMAGE_MARKER) === RETAINED_IMAGES, `${countOf(payload, INLINE_IMAGE_MARKER)} inline`)
  record('fixed: every offloaded occurrence rides as the placeholder text',
    countOf(payload, OFFLOADED_PLACEHOLDER) === expectedOffloads, `${countOf(payload, OFFLOADED_PLACEHOLDER)} placeholders`)
  // Request bodies of the retried turns must have fit: pi-ai throws BEFORE
  // sending when the bound is exceeded, so no over-budget body ever hit the
  // wire — every recorded conversation request stays within the bound.
  const overBudget = seen.filter((r) => countOf(requestPayload(r), INLINE_IMAGE_MARKER) > RETAINED_IMAGES)
  record('fixed: no provider request ever carried more inline images than the bound admits', overBudget.length === 0,
    `${overBudget.length} over-budget request(s)`)

  // Restart: the offload decisions are durable session events whose
  // projection the mounted executor registers; a fresh process must replay
  // them and keep sending placeholders (a missing projection would either
  // refuse the log or re-inline the images and fail the request again).
  await rt.close()
  await sleep(500) // session.lock flocks die with the process; give the OS a beat
  rt = await bootRuntime({ configPath, sessionId })
  const ensure = await rt.client.request('session/ensure', { sessionId })
  record('fixed: the session resumes from its persisted log after a restart', ensure.resumed === true)
  const resumedEnd = rt.turnEnd(IMAGE_TURNS + 2)
  await rt.promptText('CONTINUE_AFTER_RESTART')
  const end6 = await resumedEnd
  record('fixed: "continue" completes in the resumed session', endReason(end6).kind !== 'error', describeEnd(end6))
  const resumedRequest = seen.filter((r) => requestPayload(r).includes('CONTINUE_AFTER_RESTART')).at(-1)
  const resumedPayload = requestPayload(resumedRequest)
  record('fixed: replayed offload decisions keep the resumed request within the bound',
    countOf(resumedPayload, INLINE_IMAGE_MARKER) === RETAINED_IMAGES
      && countOf(resumedPayload, OFFLOADED_PLACEHOLDER) === expectedOffloads,
    `${countOf(resumedPayload, INLINE_IMAGE_MARKER)} inline, ${countOf(resumedPayload, OFFLOADED_PLACEHOLDER)} placeholders`)

  await rt.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
}

const main = async () => {
  await runControl()
  await runFixed()
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[image-offload-test] fatal:', error)
  process.exit(1)
})
