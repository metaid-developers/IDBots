// ask_user_question bridge E2E: the model-facing tool (dsh-tool-ask-user over
// the dsh-user-questions seam) round-trips a question to the wire host —
// idbots/ask/request out, idbots/ask/respond back — and the answer reaches
// the model as the tool result (and the next provider request).
//
// Run: node test/ask-bridge.test.mjs   (from dsh-runtime/)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const main = async () => {
  const { server, seen } = await startMockServer(48796)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ask-'))

  // Composition must carry the user-questions service + tool consumer.
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48796/v1', apiKeyEnv: 'ASK_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    hostTools: [{
      name: 'host_echo_tool',
      description: 'Echo a message through the host bridge.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    }],
  })
  const names = JSON.stringify(config)
  record('generator mounts the user-questions service and tool',
    names.includes('@deepseek-ai/dsh-user-questions') && names.includes('@deepseek-ai/dsh-tool-ask-user'))
  // Timed mode blocks until a person answers. timeout -1 is the row default,
  // and the kernel patch ignores a model-supplied timeout.
  const askRow = (Array.isArray(config) ? config : []).find((p) => p?.name === '@deepseek-ai/dsh-tool-ask-user')
  record('generator mounts tool-ask-user in timed mode that waits for a person',
    askRow?.config?.mode === 'timed' && askRow?.config?.timeout === -1,
    JSON.stringify(askRow?.config ?? null))

  const configPath = path.join(os.tmpdir(), `dsh-ask-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, ASK_KEY: 'sk-ask', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `ask-${Date.now().toString(36)}`

  const events = []
  const notices = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      } else if (notification.method?.startsWith('idbots/')) {
        notices.push(notification)
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

  // Turn 1: interactive answer round trip.
  const turn1 = waitFor((e) => e?.type === 'turn/end', 30000)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_ASK_TOOL please' }])
  const ask = await waitFor((n) => n.method === 'idbots/ask/request')
  record('ask_user_question arrives as idbots/ask/request',
    ask.params.sessionId === sessionId
    && ask.params.questions?.[0]?.id === 'q1'
    && ask.params.questions?.[0]?.options?.some((o) => o.label === 'Red'),
    JSON.stringify(ask.params.questions?.[0] ?? {}).slice(0, 80))
  // The kernel patch (scripts/dsh-kernel-patches/@deepseek-ai+dsh-tool-ask-user)
  // declares + forwards per-question `detail` context so the host modal can
  // render background above the options; this guards the passthrough.
  record('ask question detail context survives the bridge',
    ask.params.questions?.[0]?.detail === 'Picking a color refreshes the theme; Red is warm, Blue is calm.')
  await client.request('idbots/ask/respond', {
    id: ask.params.id,
    answers: [{ id: 'q1', selected: ['Blue'] }],
  })
  await turn1
  const answerResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('Blue'))
  record('selected option reaches the model-visible tool result', Boolean(answerResult))
  const followUp = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('CALL_ASK_TOOL')).at(-1)
  record('answer rides the next provider request', Boolean(
    followUp && JSON.stringify(followUp.body?.messages ?? []).includes('Blue')
  ))

  // Turn 2: host-side decline — no selection, decline note as the custom answer.
  const turn2 = waitFor((e) => e?.type === 'turn/end' && e.data?.turn === 2, 30000)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_ASK_TOOL again' }])
  const ask2 = await waitFor((n) => n.method === 'idbots/ask/request' && n.params.id !== ask.params.id)
  await client.request('idbots/ask/respond', {
    id: ask2.params.id,
    answers: [{ id: 'q1', selected: [], custom: 'The user declined to answer.' }],
  })
  await turn2
  const declined = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('declined'))
  record('declined answer surfaces in the tool result', Boolean(declined))

  // Turn 3: a model-supplied 2s timeout must not close the prompt. The host
  // patch forces a blocking ask, so the panel stays until this answer.
  const turn3 = waitFor((e) => e?.type === 'turn/end' && e.data?.turn === 3, 30000)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_ASK_TOOL_TIMED:2' }])
  const ask3 = await waitFor((n) => n.method === 'idbots/ask/request'
    && n.params.id !== ask.params.id && n.params.id !== ask2.params.id)
  record('timed ask still bridges to the host with detail intact',
    ask3.params.questions?.[0]?.detail === 'Picking a color refreshes the theme; Red is warm, Blue is calm.')
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const cancelledEarly = notices.some((notice) => notice.method === 'idbots/ask/cancelled' && notice.params?.id === ask3.params.id)
  record('model timeout does not cancel the bridged host prompt', !cancelledEarly)
  await client.request('idbots/ask/respond', {
    id: ask3.params.id,
    answers: [{ id: 'q1', selected: ['Red'] }],
  })
  await turn3
  const answered3 = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('Red'))
  record('answer after the ignored model timeout still reaches the tool result', Boolean(answered3))

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  record('clean close', true)

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[ask-test] fatal:', error)
  process.exit(1)
})
