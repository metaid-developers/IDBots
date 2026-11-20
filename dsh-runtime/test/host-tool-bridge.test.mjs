// Host tool bridge wire test: a config-declared tool proxy is callable by the
// model; execution round-trips to the wire host (idbots/tool/request →
// idbots/tool/respond), a host error becomes an error tool result the model
// sees, and image payloads on a respond reach the model as image blocks via
// the attachment store — or degrade to a text note on a text-only route, or
// when the attachment store rejects the image (oversize) — and the turn must
// still settle in every case.
//
// Run: node test/host-tool-bridge.test.mjs   (from dsh-runtime/)

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

// 1x1 transparent PNG.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// Minimal PNG stream carrying arbitrary IHDR dimensions (the attachment
// store's inspector reads the header only, so no IDAT is needed to exercise
// its size validation).
const makePngWithSize = (width, height) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25) // length(4) + 'IHDR'(4) + 13 data + crc(4, unchecked)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  return Buffer.concat([sig, ihdr, iend]).toString('base64')
}

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const main = async () => {
  const { server, seen } = await startMockServer(48793)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hosttool-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [
      {
        key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48793/v1', apiKeyEnv: 'HOSTTOOL_KEY',
        models: [{ id: 'mock-1', contextWindow: 32768, input: ['text', 'image'] }],
      },
      {
        // Same gateway, but the route declares text-only input: image responds
        // on this route must degrade to a note instead of image blocks.
        key: 'mockgw-text', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48793/v1', apiKeyEnv: 'HOSTTOOL_KEY',
        models: [{ id: 'mock-1', contextWindow: 32768 }],
      },
    ],
    sections: [],
    hostTools: [{
      name: 'host_echo_tool',
      description: 'Echo a message through the host bridge.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    }],
    extraEntries: [{ id: 'idbots-test-tools', name: path.join(runtimeDir, 'test/fixtures/test-tools.mjs') }],
  })
  const configPath = path.join(os.tmpdir(), `dsh-hosttool-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, HOSTTOOL_KEY: 'sk-hosttool', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `hosttool-${Date.now().toString(36)}`

  const waiters = new Set()
  const events = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event') {
        // `events` collects the primary session only; waiters observe every
        // session (the text-route turn below rides a second DSH session).
        if (notification.params.sessionId === sessionId) events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      } else if (notification.method?.startsWith('idbots/')) {
        for (const wait of waiters) wait(notification)
      }
    }
  })()
  pumping.catch(() => {})
  const waitFor = (predicate, timeoutMs = 20000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => {
      if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) }
    }
    waiters.add(wait)
  })
  const waitForEvent = (predicate, timeoutMs = 20000) =>
    waitFor((p) => p?.type !== undefined && predicate(p), timeoutMs)

  // Turn 1: successful host round trip.
  const turn1 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_HOST_TOOL please' }])
  const request = await waitFor((n) => n.method === 'idbots/tool/request')
  record('host tool call arrives as idbots/tool/request', request.params.name === 'host_echo_tool'
    && request.params.arguments.message === 'ping the host'
    && request.params.sessionId === sessionId, JSON.stringify(request.params).slice(0, 80))
  await client.request('idbots/tool/respond', { id: request.params.id, ok: true, text: 'HOST-ECHO: ping the host' })
  await turn1
  const result = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('HOST-ECHO'))
  record('host result reaches the model-visible tool result', Boolean(result))
  const followUp = seen.filter((r) => r.body?.messages?.some((m) => m.role === 'tool')).at(-1)
  const toolMsg = followUp?.body?.messages?.find((m) => m.role === 'tool')
  record('follow-up request carries the host result', String(typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content)).includes('HOST-ECHO'))

  // Turn 2: host error path.
  const turn2 = waitForEvent((e) => e.type === 'turn/end' && e.data?.turn === 2)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_HOST_TOOL again' }])
  const request2 = await waitFor((n) => n.method === 'idbots/tool/request' && n.params.id !== request.params.id)
  await client.request('idbots/tool/respond', { id: request2.params.id, ok: false, error: 'host exploded' })
  await turn2
  const errorResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('host exploded'))
  record('host error becomes an error tool result', Boolean(errorResult))

  // Turn 3: image respond on an image-capable route. The bytes commit to the
  // attachment store, the tool result carries an image block, and the next
  // provider request carries the image as an image_url data URL.
  const turn3 = waitForEvent((e) => e.type === 'turn/end' && e.data?.turn === 3)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_HOST_TOOL_IMAGE please' }])
  const request3 = await waitFor((n) => n.method === 'idbots/tool/request' && n.params.id !== request2.params.id)
  await client.request('idbots/tool/respond', {
    id: request3.params.id,
    ok: true,
    text: 'HOST-SHOT: captured 1x1',
    images: [{ data: PNG_1x1_BASE64, mediaType: 'image/png', name: 'shot' }],
  })
  await turn3
  const imageResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('HOST-SHOT'))
  const imageBlock = imageResult && JSON.stringify(imageResult).includes('"type":"image"')
    ? JSON.stringify(imageResult)
    : null
  record('image respond renders an image block in the tool result', Boolean(imageBlock))
  const expectedHash = crypto.createHash('sha256').update(Buffer.from(PNG_1x1_BASE64, 'base64')).digest('hex')
  const stored = fs.existsSync(path.join(sessionRoot, 'attachments', `${expectedHash}.bin`))
  record('image bytes are content-addressed in the attachment store', stored)
  const imageFollowUp = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('data:image/png;base64,')).at(-1)
  record('follow-up provider request carries the image_url data URL', Boolean(imageFollowUp))

  // Turn 3b: REGRESSION — an image the attachment store rejects (here: 8200px
  // on a side, over the 8192px limit) must degrade to an omission note and the
  // turn MUST still end. Before the fix, the store's AttachmentError escaped
  // idbotsToolRespond after the pending entry was already deleted, so the
  // model's tool call never settled and the session wedged permanently (a
  // terminate + resume re-ran the same screenshot call and wedged again).
  const turn3b = waitForEvent((e) => e.type === 'turn/end' && e.data?.turn === 4)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_HOST_TOOL_IMAGE please' }])
  const priorRequestIds = new Set([request.params.id, request2.params.id, request3.params.id])
  const request3b = await waitFor((n) => n.method === 'idbots/tool/request' && !priorRequestIds.has(n.params.id))
  const oversizePng = makePngWithSize(8200, 100)
  await client.request('idbots/tool/respond', {
    id: request3b.params.id,
    ok: true,
    text: 'HOST-SHOT: captured oversize',
    images: [{ data: oversizePng, mediaType: 'image/png', name: 'oversize' }],
  })
  await turn3b // wedged bridge: this await times out and fails the test
  const oversizeResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('HOST-SHOT: captured oversize'))
  const oversizeJson = oversizeResult ? JSON.stringify(oversizeResult) : ''
  record('rejected image settles the tool call as an omission note (turn ends)',
    Boolean(oversizeResult)
      && oversizeJson.includes('omitted')
      && oversizeJson.includes('exceeds the per-side limit')
      && !oversizeJson.includes('"type":"image"'), oversizeJson.slice(0, 120))
  // The follow-up provider request still carries turn 3's committed 1x1 image
  // in history, so assert on the REJECTED image's own bytes, not data URLs in
  // general: the note rides the tool message, the rejected bytes never do.
  const oversizeFollowUp = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('HOST-SHOT: captured oversize')).at(-1)
  const oversizeFollowUpJson = oversizeFollowUp ? JSON.stringify(oversizeFollowUp.body?.messages ?? []) : ''
  record('follow-up provider request carries the note, not the rejected image bytes',
    oversizeFollowUpJson.includes('omitted') && !oversizeFollowUpJson.includes(oversizePng))

  // Turn 4: same image respond on a TEXT-ONLY route — the result must degrade
  // to the omission note with no image block (an image on this route would
  // poison the durable history with a permanent conversion error).
  // Session-event waiters receive the bare event (no sessionId), but turns 1-3
  // already settled, so the next omitted-bearing tool/result can only be the
  // text-route session's.
  const textSessionId = `${sessionId}-text`
  await client.request('session/ensure', { sessionId: textSessionId, provider: 'mockgw-text', model: 'mock-1' })
  const degradedSettled = waitForEvent((e) => e.type === 'tool/result' && JSON.stringify(e).includes('omitted'), 20000)
  await client.prompt(textSessionId, [{ type: 'text', text: 'CALL_HOST_TOOL_IMAGE on text route' }])
  const request4 = await waitFor((n) => n.method === 'idbots/tool/request' && n.params.sessionId === textSessionId)
  await client.request('idbots/tool/respond', {
    id: request4.params.id,
    ok: true,
    text: 'HOST-SHOT: captured 1x1',
    images: [{ data: PNG_1x1_BASE64, mediaType: 'image/png' }],
  })
  await degradedSettled
  const degradedJson = JSON.stringify(await degradedSettled)
  record('text-only route degrades the image to an omission note',
    degradedJson.includes('omitted') && degradedJson.includes('HOST-SHOT') && !degradedJson.includes('"type":"image"'))
  const textRouteRequests = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('on text route'))
  record('text-only route never sends an image_url upstream',
    textRouteRequests.length > 0 && textRouteRequests.every(
      (r) => !JSON.stringify(r.body?.messages ?? []).includes('data:image/png;base64,')
    ))

  // Turn 5: prompt attachments — idbots/prompt with images commits through
  // the attachment store and lands the image in the user message (and thus in
  // the next provider request). The pump now forwards every session's events,
  // so wait on the image-bearing user/message event directly.
  const attachSessionId = `${sessionId}-attach`
  await client.request('session/ensure', { sessionId: attachSessionId, provider: 'mockgw', model: 'mock-1' })
  // The pump forwards every session's events, so a bare turn/end waiter can
  // resolve on an earlier session's trailing end — wait on attach-turn-specific
  // content instead (its user/message image block, then its provider request).
  const attachUserImage = waitForEvent((e) => e.type === 'user/message' && JSON.stringify(e).includes('"type":"image"'), 20000)
  await client.request('idbots/prompt', {
    sessionId: attachSessionId,
    text: 'Analyze this attachment:\n附件路径: /tmp/shot.png',
    images: [{ data: PNG_1x1_BASE64, mediaType: 'image/png', name: 'shot.png' }],
  })
  const attachMessage = await attachUserImage
  const waitForRequest = async (needle, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes(needle)).at(-1)
      if (hit) return hit
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return undefined
  }
  record('idbots/prompt carries the image into the user message', JSON.stringify(attachMessage).includes('attachmentId'))
  const attachFollowUp = await waitForRequest('附件路径: /tmp/shot.png')
  record('prompt image reaches the provider request as image_url', Boolean(
    attachFollowUp && JSON.stringify(attachFollowUp.body?.messages ?? []).includes('data:image/png;base64,')
  ))

  // Turn 6: same prompt on the TEXT-ONLY route — no image block may enter the
  // user message; the omission note rides the text instead.
  const attachTextSessionId = `${sessionId}-attach-text`
  await client.request('session/ensure', { sessionId: attachTextSessionId, provider: 'mockgw-text', model: 'mock-1' })
  await client.request('idbots/prompt', {
    sessionId: attachTextSessionId,
    text: 'Analyze this attachment:',
    images: [{ data: PNG_1x1_BASE64, mediaType: 'image/png' }],
  })
  await waitForRequest('omitted — the active model does not accept image input')
  const attachTextRequests = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('omitted — the active model does not accept image input'))
  record('text-only prompt keeps images out of the user message (omission note)',
    attachTextRequests.length > 0 && attachTextRequests.every(
      (r) => !JSON.stringify(r.body?.messages ?? []).includes('data:image/png;base64,')
    ))

  // Turn 7: batch-count cap — idbots/prompt with more images than the
  // attachment store's per-message limit must refuse the whole batch through
  // the attachment store's admitPromptContent service (count and aggregate-byte
  // limits apply to the batch, never member-by-member). The RPC rejects with
  // the attachment error message and no image block enters the session.
  const batchSessionId = `${sessionId}-attach-batch`
  await client.request('session/ensure', { sessionId: batchSessionId, provider: 'mockgw', model: 'mock-1' })
  let batchError = ''
  try {
    await client.request('idbots/prompt', {
      sessionId: batchSessionId,
      text: 'Over the cap:',
      images: Array.from({ length: 11 }, () => ({ data: PNG_1x1_BASE64, mediaType: 'image/png' })),
    })
  } catch (error) {
    batchError = String(error?.message ?? error)
  }
  record('image batch over the per-message cap rejects the prompt RPC',
    /image-count limit/i.test(batchError))

  const refreshSessionId = `${sessionId}-refresh`
  const refreshTools = (names) => names.map((name) => ({
    name,
    description: `${name} schema`,
    parameters: { type: 'object', properties: {} },
  }))
  const ensureRefreshTools = (names) => client.request('session/ensure', {
    sessionId: refreshSessionId,
    provider: 'mockgw',
    model: 'mock-1',
    hostTools: refreshTools(names),
  })
  await ensureRefreshTools(['host_echo_tool', 'host_refresh_stale'])
  await ensureRefreshTools(['host_echo_tool'])
  await client.prompt(refreshSessionId, [{ type: 'text', text: 'verify slim live tool surface' }])
  const slimRequest = await waitForRequest('verify slim live tool surface')
  const slimNames = slimRequest?.body?.tools?.map((tool) => tool.function?.name) ?? []
  record('live session re-ensure removes stale host tools',
    slimNames.includes('host_echo_tool') && !slimNames.includes('host_refresh_stale'), slimNames.join(','))

  await ensureRefreshTools(['host_echo_tool', 'host_refresh_added'])
  await client.prompt(refreshSessionId, [{ type: 'text', text: 'verify expanded live tool surface' }])
  const expandedRequest = await waitForRequest('verify expanded live tool surface')
  const expandedNames = expandedRequest?.body?.tools?.map((tool) => tool.function?.name) ?? []
  record('live session re-ensure mounts newly added host tools',
    expandedNames.includes('host_echo_tool') && expandedNames.includes('host_refresh_added')
      && !expandedNames.includes('host_refresh_stale'), expandedNames.join(','))

  await client.request('session/ensure', { sessionId: refreshSessionId, provider: 'mockgw', model: 'mock-1' })
  await client.prompt(refreshSessionId, [{ type: 'text', text: 'verify route-only ensure preserves tools' }])
  const routeOnlyRequest = await waitForRequest('verify route-only ensure preserves tools')
  const routeOnlyNames = routeOnlyRequest?.body?.tools?.map((tool) => tool.function?.name) ?? []
  record('route-only re-ensure preserves the current host tools',
    routeOnlyNames.includes('host_echo_tool') && routeOnlyNames.includes('host_refresh_added')
      && !routeOnlyNames.includes('host_refresh_stale'), routeOnlyNames.join(','))

  await ensureRefreshTools(['host_echo_tool', 'host_refresh_stale'])
  subscription.close()
  await client.close()
  const restartedClient = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, HOSTTOOL_KEY: 'sk-hosttool', SPIKE_QUIET: '1' },
  })
  restartedClient.start()
  await restartedClient.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  await restartedClient.request('session/ensure', {
    sessionId: refreshSessionId,
    provider: 'mockgw',
    model: 'mock-1',
    hostTools: refreshTools(['host_echo_tool']),
  })
  await restartedClient.prompt(refreshSessionId, [{ type: 'text', text: 'verify restart slim tool surface' }])
  const restartRequest = await waitForRequest('verify restart slim tool surface')
  const restartNames = restartRequest?.body?.tools?.map((tool) => tool.function?.name) ?? []
  record('runtime restart applies the slim surface to a persisted session',
    restartNames.includes('host_echo_tool') && !restartNames.includes('host_refresh_stale'), restartNames.join(','))
  await restartedClient.close()
  server.close()
  try { fs.rmSync(sessionRoot, { recursive: true, force: true }) } catch { /* OS-swept temp dir */ }
  try { fs.rmSync(configPath, { force: true }) } catch { /* OS-swept temp file */ }
  record('clean close', true)

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[hosttool-test] fatal:', error)
  process.exit(1)
})
