// M5 integration test: a real CoworkRunner runs one cowork turn on the DSH
// kernel — through the actual runDshSessionLocal path (store writes, runner
// events, pendingPermissions approval flow, steer, native cancel), against
// the real dsh-runtime subprocess on a mock OpenAI gateway.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const runtimeDir = path.resolve(import.meta.dirname, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (predicate, timeoutMs = 25000, what = 'condition') => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${what}`)
}

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-integration-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      runner: require('../dist-electron/main/libs/coworkRunner.js'),
      claudeSettings: require('../dist-electron/main/libs/claudeSettings.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

class RecordingStore {
  constructor() {
    this.messages = []
    this.sessions = new Map()
    this.configValue = {}
    this.sourceChannel = null
  }
  getSession(id) { return this.sessions.get(id) ?? null }
  // Runner reads the session goal through this lighter accessor every DSH turn.
  getSessionWithoutMessages(id) { return this.sessions.get(id) ?? null }
  getMetabotIdForSession(id) { return this.sessions.get(id)?.metabotId ?? null }
  getConfig() { return this.configValue }
  updateSession(id, updates) {
    const existing = this.sessions.get(id) ?? { id, messages: this.messages }
    this.sessions.set(id, { ...existing, ...updates })
  }
  addMessage(sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: Date.now(), ...message }
    this.messages.push({ sessionId, ...stored })
    return stored
  }
  getConversationSourceContextBySession() {
    return this.sourceChannel
      ? { sourceChannel: this.sourceChannel, externalConversationId: null }
      : { hasSourceContext: false }
  }
  getMemoryBackend() {
    const noMemories = () => []
    return {
      getEffectiveMemoryPolicyForSession: () => ({ memoryEnabled: true }),
      resolveMetabotIdForMemory: () => 1,
      applyTurnMemoryUpdates: async () => ({}),
      listUserMemories: noMemories,
      listDailySummaries: noMemories,
      searchDailySummaries: noMemories,
    }
  }
  getMessageById(sessionId, messageId) {
    return this.messages.find((m) => m.sessionId === sessionId && m.id === messageId) ?? null
  }
  updateMessage(sessionId, messageId, updates) {
    const entry = this.messages.find((m) => m.sessionId === sessionId && m.id === messageId)
    if (!entry) return
    if (updates.content !== undefined) entry.content = updates.content
    if (updates.metadata !== undefined) entry.metadata = { ...(entry.metadata ?? {}), ...updates.metadata }
  }
  getSessionUsageStats() { return null }
  // Proven-techniques injection (a6f7d570) reads capability drafts every turn;
  // none exist in this fixture.
  listCapabilityDrafts() { return [] }
  listInjectableTechniques() { return [] }
}

test('CoworkRunner DSH integration', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server, seen } = await startMockServer(48791)

  // Inject a fake provider table: one OpenAI-compatible provider aimed at the
  // mock gateway, and enable the DSH rollout flag.
  const fakeStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-test', baseUrl: 'http://127.0.0.1:48791/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: {
            enabled: true,
            apiKey: 'sk-integration-test',
            baseUrl: 'http://127.0.0.1:48791/v1',
            apiFormat: 'openai',
            models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }],
          },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 })
  // Fixture tools ride the runtime composition via the hub's extraEntries seam.
  runner.dshRuntimeExtraEntries = [
    { id: 'idbots-test-tools', name: path.join(runtimeDir, 'test', 'fixtures', 'test-tools.mjs') },
  ]
  // Unique per run: the runtime resumes persisted session logs under
  // .cowork-temp, so a fixed id would replay stale history from earlier
  // runs (e.g. steers sent by older code) into the mock gateway requests.
  const sessionId = `dsh-integration-${process.pid}-${Date.now().toString(36)}`
  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
  }
  runner.activeSessions.set(sessionId, activeSession)
  // The assistant-mode gate reads the PERSISTED session record (bad5dfe3
  // retired the sourceChannel==='cowork_ui' fallback): owner_update only
  // registers for a session whose store row carries the assistantMode
  // marker, so seed it here — the live Studio surface stamps the same field.
  store.updateSession(sessionId, { assistantMode: true })

  const events = { messages: [], updates: [], completes: [], permissions: [], steerSettled: [] }
  runner.on('message', (sid, message) => { if (sid === sessionId) events.messages.push(message) })
  runner.on('messageUpdate', (sid, messageId, content) => { if (sid === sessionId) events.updates.push({ messageId, content }) })
  runner.on('complete', (sid) => { if (sid === sessionId) events.completes.push(sid) })
  runner.on('permissionRequest', (sid, request) => { if (sid === sessionId) events.permissions.push(request) })
  runner.on('steerSettled', (sid, submissionId) => { if (sid === sessionId) events.steerSettled.push(submissionId) })
  runner.on('error', () => undefined) // EventEmitter: unhandled 'error' throws
  const handleErrorOrig = runner.handleError.bind(runner)
  let failure = null
  runner.handleError = (sid, message) => { failure = message; handleErrorOrig(sid, message) }

  try {
    // Routing decision: flag on + openai provider + no handle → dsh.
    assert.equal(runner.shouldRunDshKernel(activeSession), true, 'routing picks dsh')

    // One full turn through the product path.
    const turn = runner.runDshSessionLocal(activeSession, 'HELLO_MOCK', process.cwd(), 'You are Alice, an on-chain assistant.')
    await turn
    assert.ok(!failure, `turn should not fail: ${failure}`)
    // The host records user bubbles on submission — the mapper must NOT echo
    // them back (that duplicated every message in the live app).
    assert.ok(!events.messages.some((m) => m.type === 'user'), 'mapper does not echo user input')
    // Streaming fills content via updateMessage (the emitted snapshot is the
    // empty open), so assert on the store's mutated copies.
    assert.ok(store.messages.some((m) => m.type === 'assistant' && m.content.includes('mock says')), 'assistant reply stored')
    assert.ok(events.completes.length === 1, 'complete emitted')
    assert.ok(!runner.activeSessions.has(sessionId), 'active session torn down after turn completion')
    assert.ok(activeSession.claudeSessionId?.startsWith('dsh:'), `session handle pinned: ${activeSession.claudeSessionId}`)
    const firstRequest = seen.find((r) => r.body?.messages?.some((m) => m.role === 'system'))
    assert.match(firstRequest.body.messages.find((m) => m.role === 'system').content, /You are Alice/)

    // Assistant owner updates travel the real runtime schema → host execution
    // → persistence/event path, ordered between the tool call and its result.
    const beforeOwnerTurn = store.messages.length
    store.sourceChannel = 'cowork_ui'
    activeSession.skipInitialUserMessage = true
    await runner.runDshSessionLocal(activeSession, 'CALL_OWNER_UPDATE', process.cwd(), 'You are Alice.')
    assert.ok(!failure, `owner_update turn should not fail: ${failure}`)
    const ownerMessages = store.messages.slice(beforeOwnerTurn)
    const ownerTool = ownerMessages.find((m) => m.type === 'tool_use' && m.metadata?.toolName === 'owner_update')
    const ownerBubble = ownerMessages.find((m) => m.type === 'assistant' && m.content === 'Owner milestone from runtime')
    const ownerResult = ownerMessages.find((m) => m.type === 'tool_result' && m.metadata?.toolUseId === ownerTool?.metadata?.toolUseId)
    const ownerReply = ownerMessages.find((m) => m.type === 'assistant' && m.content.includes('mock says: tool finished'))
    assert.ok(ownerTool, 'runtime emitted the owner_update tool call')
    assert.ok(ownerBubble, `host persisted the owner update bubble: ${JSON.stringify(ownerMessages)}`)
    assert.ok(ownerResult, 'runtime received the host tool result')
    assert.ok(ownerReply, 'final answer still follows the owner update')
    assert.equal(ownerBubble.metadata.narration, true)
    assert.equal(ownerBubble.metadata.ownerUpdateKind, 'milestone')
    assert.equal(ownerReply.metadata.narration, undefined)
    assert.match(String(ownerResult.content), /"shown":true/)
    assert.match(String(ownerResult.content), /"remaining":5/)
    assert.ok(ownerMessages.indexOf(ownerTool) < ownerMessages.indexOf(ownerBubble))
    assert.ok(ownerMessages.indexOf(ownerBubble) < ownerMessages.indexOf(ownerResult))
    assert.equal(activeSession.assistantOwnerUpdateCount, 1)
    assert.ok(
      seen.some((r) => (r.body?.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === 'owner_update')),
      'the normalized owner_update schema reached the real runtime',
    )

    const beforeFinalization = store.messages.length
    await runner.runDshSessionLocal(activeSession, 'CALL_FINALIZATION', process.cwd(), 'You are Alice.')
    assert.ok(!failure, `finalization turn should not fail: ${failure}`)
    const finalizationMessages = store.messages.slice(beforeFinalization)
    const integratedReply = finalizationMessages.find((m) => m.type === 'assistant'
      && m.metadata?.isThinking !== true
      && m.content === '找到了，本机已有可复用文件。验证已完成，下一步只需要你提供编号。')
    assert.ok(integratedReply, `finalization produced the integrated owner reply: ${JSON.stringify(finalizationMessages.map((m) => ({ type: m.type, content: m.content, metadata: m.metadata })))}`)
    assert.equal(finalizationMessages.some((m) => m.type === 'assistant'
      && m.metadata?.isThinking !== true
      && m.content === '权限已收紧。接下来还需要你提供编号。'), false, 'the short addendum never displaces the full answer')
    assert.equal(activeSession.finalizationAttempted, true)
    const finalizationRequest = seen.findLast((r) => (r.body?.messages ?? []).some((m) => String(m.content ?? '').includes('The execution phase has stopped')))
    assert.ok(finalizationRequest, 'the real runtime received the finalization continuation')
    assert.equal((finalizationRequest.body.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === 'owner_update'), false, 'host tools are physically absent during finalization')
    store.sourceChannel = null
    activeSession.skipInitialUserMessage = false

    // Routing stickiness: the pinned handle keeps dsh even with the store gone.
    claudeSettings.setStoreGetter(() => null)
    assert.equal(runner.shouldRunDshKernel(activeSession), true, 'pinned session stays dsh')
    assert.equal(runner.shouldRunDshKernel({ ...activeSession, claudeSessionId: 'sdk-legacy' }), true, 'legacy Claude handle still runs DSH')

    // Steer + cancel through the runner surface (second turn, store restored).
    claudeSettings.setStoreGetter(() => fakeStore)
    const turn2 = runner.runDshSessionLocal(activeSession, 'STEER_TEST', process.cwd(), 'You are Alice.')
    await waitFor(() => events.messages.some((m) => m.type === 'tool_use' && m.metadata?.toolName === 'slow_tool'), 25000, 'slow_tool via runner')
    // The capability gate is the real UI entry: an active DSH turn must admit
    // steers natively (regression: it used to fall into 'closing-local', which
    // parked the interjection as a queued steer that waited out the whole
    // turn before continuing).
    assert.equal(runner.getSteerCapability(sessionId), 'open-dsh', 'active DSH turn admits native steer')
    const steerResult = runner.trySubmitSteer(sessionId, 'sub-1', 'STEERED_IN_RUNNER')
    assert.ok(steerResult?.accepted !== false, `steer accepted: ${JSON.stringify(steerResult && { reason: steerResult.reason })}`)
    // Steer bubbles come from the submission path; consumption is proven by
    // the delivered promise settling AND the follow-up model request carrying
    // the steer text to the gateway.
    await Promise.race([
      steerResult.delivered,
      sleep(15000).then(() => { throw new Error('steer delivery timed out') }),
    ])
    await turn2
    const steerRequest = seen.filter((r) => r.body?.messages?.some((m) => String(m.content).includes('STEERED_IN_RUNNER'))).at(-1)
    assert.ok(steerRequest, 'steer text reached the model on the follow-up request')
    // Both kernels frame the interrupt identically: the correction rides an
    // operator_steer envelope so the model treats it as superseding work.
    const steerMessage = steerRequest.body.messages.find((m) => String(m.content).includes('STEERED_IN_RUNNER'))
    assert.match(String(steerMessage.content), /<operator_steer>/, 'steer rides the operator_steer envelope')
    // Interrupt-on-steer: the steer's cancel(keepInbox) aborted the in-flight
    // slow_tool (its result is the runtime's "tool call aborted" error, not
    // the completed {"slept":true} payload) instead of waiting out the
    // 1500ms step boundary, and the steer text became the follow-up turn's
    // user message — the whole steered exchange settled as ONE runner turn.
    const slowResults = store.messages.filter((m) => m.type === 'tool_result' && String(m.content).includes('tool call aborted'))
    assert.ok(slowResults.length > 0, 'aborted slow_tool result recorded')
    assert.ok(
      !store.messages.some((m) => m.type === 'tool_result' && String(m.content).includes('"slept":true')),
      'slow_tool never ran to completion after the steer interrupt'
    )
    // The steered exchange settled as one runner turn, and the steer
    // submission reached its terminal lifecycle state (drained at turn
    // settlement — without it the message would sit on "Sent to MetaBot").
    assert.ok(events.steerSettled.includes('sub-1'), 'steer submission settled with the steered exchange')

    // Approval: third turn triggers dangerous_tool ask → respond allow.
    const turn3 = runner.runDshSessionLocal(activeSession, 'CALL_DANGEROUS', process.cwd(), 'You are Alice.')
    const permission = await waitFor(() => events.permissions[0], 25000, 'permission request')
    assert.equal(permission.toolName, 'dangerous_tool')
    runner.respondToPermission(permission.requestId, { behavior: 'allow' })
    await turn3
    await waitFor(() => events.messages.some((m) => m.type === 'tool_result' && m.content.includes('"executed":true')), 25000, 'approved execution')

    // Policy chain: plan mode blocks mutating runtime tools through the host
    // permission gate (idbots/policy round trip).
    activeSession.permissionMode = 'plan'
    const planTurn = runner.runDshSessionLocal(activeSession, 'RUN_BASH', process.cwd(), 'You are Alice.')
    await planTurn
    const deniedResult = store.messages.filter((m) => m.type === 'tool_result').at(-1)
    assert.match(String(deniedResult?.content ?? ''), /plan mode/, 'plan mode denies bash via host policy gate')
    activeSession.permissionMode = 'default'

    // Native cancel: fourth turn aborted mid-tool.
    events.messages.length = 0
    const turn4 = runner.runDshSessionLocal(activeSession, 'STEER_TEST', process.cwd(), 'You are Alice.')
    await waitFor(() => events.messages.some((m) => m.type === 'tool_use' && m.metadata?.toolName === 'slow_tool'), 25000, 'second slow_tool')
    activeSession.abortController.abort()
    await turn4
    assert.ok(events.completes.length >= 4, 'aborted turn still completes the runner lifecycle')
  } finally {
    await runner.dshTurnHub?.close().catch(() => undefined)
    server.close()
  }
})
