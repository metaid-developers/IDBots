// GT-02 provider-outage fallback for DSH session turns (2026-09 field
// incident): when the configured provider route (e.g. z.ai) is DOWN, every
// retry layer re-hit the same dead route until the turn failed — the runtime
// step-level ladder (~3min), then the host transient-resume budget (3x) — while
// the bot's configured fallback brain (fallback_llm_*) was never consulted for
// session turns. The runner now resolves that fallback brain and, when it maps
// to a DIFFERENT route, resumes the turn on it (the hub re-pins the live dsh
// session, JSONL history carries over).
//
// Host-side coverage only: the DSH turn hub is faked (no dsh-runtime spawn),
// so this file does NOT need dsh-runtime/node_modules.
//
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)

// coworkLog writes <userData>/logs/cowork.log; the electron mock below maps
// userData here, so degradation events can be asserted on the real log file.
const coworkLogPath = () =>
  path.join(process.cwd(), '.cowork-temp', 'dsh-fallback-userData', 'logs', 'cowork.log')

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-fallback-${name}`),
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
      assistantReply: require('../dist-electron/main/libs/coworkAssistantReply.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

class RecordingStore {
  constructor() {
    this.messages = []
    this.sessions = new Map()
  }
  getSession(id) { return this.sessions.get(id) ?? null }
  getSessionWithoutMessages(id) { return this.getSession(id) }
  getConfig() { return {} }
  updateSession(id, updates) {
    const existing = this.sessions.get(id) ?? { id }
    this.sessions.set(id, { ...existing, ...updates })
  }
  addMessage(sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: Date.now(), ...message }
    this.messages.push({ sessionId, ...stored })
    return stored
  }
  updateMessage(sessionId, messageId, updates) {
    const entry = this.messages.find((m) => m.sessionId === sessionId && m.id === messageId)
    if (!entry) return
    if (updates.content !== undefined) entry.content = updates.content
    if (updates.metadata !== undefined) entry.metadata = { ...(entry.metadata ?? {}), ...updates.metadata }
  }
  getConversationSourceContextBySession() {
    return { hasSourceContext: false }
  }
  getMemoryBackend() {
    const noMemories = () => []
    return {
      getEffectiveMemoryPolicyForSession: () => ({ memoryEnabled: false }),
      resolveMetabotIdForMemory: () => 1,
      applyTurnMemoryUpdates: async () => ({}),
      listUserMemories: noMemories,
      listDailySummaries: noMemories,
      searchDailySummaries: noMemories,
    }
  }
  getSessionUsageStats() { return null }
}

// Two enabled providers: gw-a serves the primary brain (mock-a1), gw-b serves
// the fallback brain (mock-b1) with its own limits — the fallback turn must
// carry the FALLBACK model's maxOutputTokens, not the primary's.
function installApiConfig(claudeSettings, overrides = {}) {
  const fakeConfigStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://primary.example/v1' },
        model: {
          availableModels: [{ id: 'mock-a1', name: 'mock-a1' }, { id: 'mock-b1', name: 'mock-b1' }],
          defaultModel: overrides.defaultModel ?? 'mock-a1',
          defaultProvider: overrides.defaultProvider ?? 'gw-a',
        },
        providers: {
          'gw-a': {
            enabled: true,
            apiKey: 'sk-a',
            baseUrl: 'http://primary.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'mock-a1', name: 'mock-a1', contextWindow: 32768, maxOutputTokens: 4096 }],
          },
          'gw-b': {
            enabled: true,
            apiKey: 'sk-b',
            baseUrl: 'http://fallback.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'mock-b1', name: 'mock-b1', contextWindow: 64000, maxOutputTokens: 8192 }],
          },
          ...overrides.providers,
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeConfigStore)
}

// 2026-10-23 system-rescue-brain: an enabled, keyed, non-free provider that no
// brain binds (gw-b in the default fixture) is now a rescue candidate, so a
// quota/auth death that used to terminate now rescues onto it. Tests that
// verify the NO-rescue terminal behavior disable it with this override.
const NO_RESCUE_PROVIDERS = {
  'gw-b': { enabled: false, apiKey: '', baseUrl: 'http://fallback.example/v1', apiFormat: 'openai', models: [] },
}

// Drive one runDshSessionLocal turn with a scripted fake hub. `script(input,
// callNo)` returns the DshTurnOutcome for each hub.runTurn call (callNo is
// 1-based). Returns the recorded calls plus the post-turn session row.
async function driveTurn({ sessionId, metabot, script, sessionRow = {}, configOverrides = {} }) {
  const { runner: runnerModule, claudeSettings, assistantReply } = loadModules()
  const { CoworkRunner } = runnerModule
  installApiConfig(claudeSettings, configOverrides)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, {
    getMetabotById: (id) => (metabot && id === metabot.id ? metabot : null),
  })

  const runTurnCalls = []
  runner.dshTurnHub = {
    runTurn: async (input) => {
      runTurnCalls.push(input)
      return script(input, runTurnCalls.length)
    },
    prewarmTurnSlot: async () => undefined,
    cancel: async () => undefined,
    cancelAgent: async () => undefined,
    forceSettle: () => undefined,
    usageProjection: async () => null,
    compact: async () => ({ ok: true, compacted: false }),
  }

  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
    permissionMode: 'default',
    readFiles: new Map(),
  }
  runner.activeSessions.set(sessionId, activeSession)
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', metabotId: metabot?.id ?? null, ...sessionRow, messages: [] })
  const errors = []
  runner.on('error', (sid, error) => errors.push({ sid, error }))
  runner.on('permissionRequest', () => undefined)
  const completed = new Promise((resolve) => runner.once('complete', resolve))

  await runner.runDshSessionLocal(activeSession, 'GT02_PROBE do the task', process.cwd(), 'You are Alice.')

  return {
    runner,
    store,
    runTurnCalls,
    errors,
    completed,
    sessionRow: store.sessions.get(sessionId),
    TRANSIENT_TURN_RESUME_PROMPT: assistantReply.TRANSIENT_TURN_RESUME_PROMPT,
  }
}

const BOT_WITH_FALLBACK = {
  id: 1,
  name: 'GT02 Bot',
  llm_id: 'mock-a1',
  llm_provider: 'gw-a',
  fallback_llm_id: 'mock-b1',
  fallback_llm_provider: 'gw-b',
}

const transientError = () => ({ kind: 'error', error: { code: 'SERVER', message: '503 upstream unavailable' } })

test('primary route exhausting transient resumes switches to the bot fallback brain route and completes', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-fallback-success',
    metabot: BOT_WITH_FALLBACK,
    // Initial turn + 3 primary resumes all die transiently (provider outage);
    // the first FALLBACK attempt succeeds.
    script: (_input, callNo) => (callNo <= 4 ? transientError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 5, '1 initial + 3 primary resumes + 1 fallback resume')
  const [initial, ...resumes] = result.runTurnCalls
  assert.match(initial.prompt, /GT02_PROBE/, 'the first attempt carries the user prompt')
  for (const call of resumes) {
    assert.equal(call.prompt, result.TRANSIENT_TURN_RESUME_PROMPT, 'resume attempts reuse the shared resume cue')
  }
  for (const call of result.runTurnCalls.slice(0, 4)) {
    assert.equal(call.provider.key, 'gw-a', 'initial + primary resumes stay on the primary route')
    assert.equal(call.provider.model, 'mock-a1')
  }
  const fallbackCall = result.runTurnCalls[4]
  assert.equal(fallbackCall.provider.key, 'gw-b', 'the exhausted turn switches to the fallback provider route')
  assert.equal(fallbackCall.provider.model, 'mock-b1')
  assert.equal(fallbackCall.provider.baseUrl, 'http://fallback.example/v1')
  assert.equal(fallbackCall.provider.apiKey, 'sk-b')
  assert.equal(fallbackCall.provider.maxOutputTokens, 8192, 'fallback model limits ride the fallback route')
  // Same live dsh session id: the hub re-pin keeps the JSONL history.
  assert.equal(fallbackCall.dshSessionId, initial.dshSessionId)
  assert.equal(result.sessionRow?.status, 'completed', 'the turn completes on the fallback route')
  assert.equal(result.errors.length, 0, 'no session error is surfaced')
  await result.completed
})

test('a runtime boot failure switches to the fallback brain with the original prompt and completes', async () => {
  const { DshRuntimeBootError } = require('../dist-electron/main/libs/dshRuntimeBootError.js')
  const result = await driveTurn({
    sessionId: 'gt02-runtime-boot-fallback',
    metabot: BOT_WITH_FALLBACK,
    script: (_input, callNo) => {
      if (callNo === 1) {
        throw new DshRuntimeBootError('DSH runtime for provider "gw-a.auto-bc" failed to boot: native module loader unavailable')
      }
      return { kind: 'completed' }
    },
  })

  assert.equal(result.runTurnCalls.length, 2, 'one failed primary boot + one fallback attempt')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-a')
  assert.equal(result.runTurnCalls[1].provider.key, 'gw-b')
  assert.equal(result.runTurnCalls[1].provider.model, 'mock-b1')
  assert.equal(
    result.runTurnCalls[1].prompt,
    result.runTurnCalls[0].prompt,
    'the pre-prompt boot failure retries the exact original task, not a context-free resume cue',
  )
  assert.match(result.runTurnCalls[1].prompt, /GT02_PROBE do the task/)
  assert.notEqual(result.runTurnCalls[1].prompt, result.TRANSIENT_TURN_RESUME_PROMPT)
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)
  await result.completed
})

test('a runtime boot failure without any alternative keeps the boot diagnostic', async () => {
  const { DshRuntimeBootError } = require('../dist-electron/main/libs/dshRuntimeBootError.js')
  const result = await driveTurn({
    sessionId: 'gt02-runtime-boot-no-alternative',
    metabot: { id: 9, name: 'NoFallback Boot Bot', llm_id: 'mock-a1', llm_provider: 'gw-a' },
    configOverrides: { providers: NO_RESCUE_PROVIDERS },
    script: () => {
      throw new DshRuntimeBootError('DSH runtime for provider "gw-a.auto-bc" failed to boot: native module loader unavailable')
    },
  })

  assert.equal(result.runTurnCalls.length, 1)
  assert.equal(result.sessionRow?.status, 'error')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].error, /native module loader unavailable/)
  assert.doesNotMatch(result.errors[0].error, /未配置可用模型|No usable model configured/)
})

test('without a fallback brain the turn fails after the primary resume budget (behavior unchanged)', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-no-fallback',
    metabot: { id: 2, name: 'NoFallback Bot', llm_id: 'mock-a1', llm_provider: 'gw-a' },
    script: () => ({ kind: 'error', error: { code: 'TIMEOUT', message: 'request timed out' } }),
    configOverrides: { providers: NO_RESCUE_PROVIDERS },
  })

  assert.equal(result.runTurnCalls.length, 4, '1 initial + 3 primary resumes, then the turn fails')
  for (const call of result.runTurnCalls) {
    assert.equal(call.provider.key, 'gw-a', 'every attempt stays on the primary route')
  }
  assert.equal(result.sessionRow?.status, 'error')
  assert.ok(
    result.errors.some((entry) => String(entry.error).includes('DSH turn failed')),
    'the transient failure settles as a session error',
  )
})

test('a config-class hard error (auth) degrades to the fallback brain with a single attempt and logs the config error', async () => {
  // 2026-10-08 Boss ruling corollary 3 (error-type routing): a config-class
  // hard error (auth) can never succeed on the same route, but the fallback
  // brain may point at a route whose key IS valid — degrade + log, like
  // quota, with a SINGLE attempt (a wrong key does not heal mid-turn).
  const result = await driveTurn({
    sessionId: 'gt02-auth-degrade',
    metabot: BOT_WITH_FALLBACK,
    script: (_input, callNo) => (callNo === 1
      ? { kind: 'error', error: { code: 'AUTH_FAILED', message: '401 invalid api key' } }
      : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 2, '1 initial auth death + 1 single fallback attempt')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-a')
  assert.equal(result.runTurnCalls[1].provider.key, 'gw-b', 'the auth death degrades to the fallback brain')
  assert.equal(result.sessionRow?.status, 'completed')

  const logText = fs.readFileSync(coworkLogPath(), 'utf-8')
  assert.ok(
    logText.includes('configuration-level hard error (auth / model not found)'),
    'the config-error WARN is written to cowork.log, distinguishing it from a rate limit',
  )
  await result.completed
})

test('a model-id-not-served hard error (404 model not found) degrades to the fallback brain', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-model-missing-degrade',
    metabot: BOT_WITH_FALLBACK,
    script: (_input, callNo) => (callNo === 1
      ? { kind: 'error', error: { code: 'MODEL_NOT_FOUND', message: '404 {"error":"model mock-a1 does not exist"}' } }
      : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 2, '1 initial model-missing death + 1 single fallback attempt')
  assert.equal(result.runTurnCalls[1].provider.key, 'gw-b')
  assert.equal(result.runTurnCalls[1].provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed')
  await result.completed
})

test('a transport-class hard error (413 body limit) still never triggers the fallback chain', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-other-hard-error',
    metabot: BOT_WITH_FALLBACK,
    script: () => ({ kind: 'error', error: { code: 'REQUEST_TOO_LARGE', message: '413 request too large' } }),
  })

  assert.equal(result.runTurnCalls.length, 1, '413 body limit: no resume, no fallback attempt (transport cap, not model availability)')
  assert.equal(result.sessionRow?.status, 'error')
  assert.ok(result.errors.some((entry) => String(entry.error).includes('413 request too large')))
})

test('a fallback brain resolving to the SAME route as the failed primary is not retried', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-same-route-fallback',
    configOverrides: { providers: NO_RESCUE_PROVIDERS },
    // Fallback brain points at the same provider+model as the primary —
    // switching would just re-hit the dead path.
    metabot: {
      id: 3,
      name: 'SameRoute Bot',
      llm_id: 'mock-a1',
      llm_provider: 'gw-a',
      fallback_llm_id: 'mock-a1',
      fallback_llm_provider: 'gw-a',
    },
    script: () => transientError(),
  })

  assert.equal(result.runTurnCalls.length, 4, 'same-route fallback: primary budget only, no extra attempts')
  for (const call of result.runTurnCalls) {
    assert.equal(call.provider.key, 'gw-a')
  }
  assert.equal(result.sessionRow?.status, 'error')
})

// §9 (GROUP-TASK-FIX-REQ-v2): the identity-layer fallback must sink into the
// session runtime layer for EVERY bot that configured one — including a bot
// whose PRIMARY brain is the app-global default (no llm_id on its metabot
// row). Before the fix, getSessionAutomationBrain gated on llm_id and such a
// bot's fallback_llm_* was never consulted: an outage on the default route
// failed the turn outright instead of degrading.
test('a bot without a primary llm_id still inherits its configured fallback brain on outage', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-fallback-only-bot',
    metabot: { id: 4, name: 'FallbackOnly Bot', fallback_llm_id: 'mock-b1', fallback_llm_provider: 'gw-b' },
    // Global default route (mock-a1 via gw-a) dies transiently; the first
    // FALLBACK attempt succeeds.
    script: (_input, callNo) => (callNo <= 4 ? transientError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 5, '1 initial + 3 default-route resumes + 1 fallback resume')
  for (const call of result.runTurnCalls.slice(0, 4)) {
    assert.equal(call.provider.key, 'gw-a', 'primary attempts ride the app-global default route')
    assert.equal(call.provider.model, 'mock-a1')
  }
  const fallbackCall = result.runTurnCalls[4]
  assert.equal(fallbackCall.provider.key, 'gw-b', 'the exhausted turn degrades to the configured fallback brain')
  assert.equal(fallbackCall.provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)
  await result.completed
})

// Config-level facet of the same gap: with no llm_id AND no enabled default
// provider, route resolution used to skip the bot's fallback brain entirely
// (the branch required a primary override). The turn must START on the
// fallback route instead of failing with "provider not enabled".
test('a fallback-only bot starts on its fallback brain when the default provider is disabled', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-fallback-only-disabled-default',
    metabot: { id: 5, name: 'FallbackOnly Bot', fallback_llm_id: 'mock-b1', fallback_llm_provider: 'gw-b' },
    configOverrides: {
      providers: {
        'gw-a': {
          enabled: false,
          apiKey: 'sk-a',
          baseUrl: 'http://primary.example/v1',
          apiFormat: 'openai',
          models: [{ id: 'mock-a1', name: 'mock-a1', contextWindow: 32768, maxOutputTokens: 4096 }],
        },
      },
    },
    script: () => ({ kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 1, 'no dead primary attempt — the turn starts on the fallback route')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-b')
  assert.equal(result.runTurnCalls[0].provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)
  await result.completed
})

// §9 acceptance, end to end at the runner layer: a GROUP-TASK worker session
// (sessionType 'group_task', metabotId set — exactly what ensureGroupTaskSession
// creates) hits a primary-route outage, degrades to the bot's fallback brain,
// completes the turn (the task is not interrupted), and the degradation event
// is visible both in the session transcript and in cowork.log.
test('a group-task worker session degrades to the bot fallback brain and logs the event', async () => {
  const sessionId = 'gt02-group-task-worker'
  const result = await driveTurn({
    sessionId,
    metabot: BOT_WITH_FALLBACK,
    sessionRow: { sessionType: 'group_task' },
    script: (_input, callNo) => (callNo <= 4 ? transientError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 5)
  assert.equal(result.runTurnCalls[4].provider.key, 'gw-b', 'the worker turn completes on the fallback model')
  assert.equal(result.runTurnCalls[4].provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed', 'the turn completes — the group task is not interrupted')
  assert.equal(result.errors.length, 0)

  const notice = result.store.messages.find(
    (m) => m.sessionId === sessionId && m.type === 'system' && m.metadata?.dshRouteFallback === true,
  )
  assert.ok(notice, 'a dshRouteFallback system message lands in the worker session transcript')
  assert.match(notice.content, /mock-b1/)
  assert.match(notice.content, /gw-b/)

  const logText = fs.readFileSync(coworkLogPath(), 'utf-8')
  assert.ok(
    logText.includes('switching to the bot fallback brain route'),
    'the degradation WARN event is written to cowork.log',
  )
  assert.ok(logText.includes(sessionId), 'the degradation log line names the worker session')
  await result.completed
})

// Quota death joins the fallback switch (2026-09-28 nightly-automation
// post-mortem: opencode credit exhaustion killed every nightly study/dream
// turn with 429 GoUsageLimitError while the bot's zhipu fallback brain sat
// unused). A QUOTA error is NOT transient — it never enters the same-route
// resume ladder — but the fallback switch must still fire, with a SINGLE
// attempt on the fallback route (exhausted credit does not heal, so no
// ladder there).
const quotaError = () => ({ kind: 'error', error: { code: 'QUOTA', message: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}' } })

test('a quota death on the primary route switches to the fallback brain with a single attempt and completes', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-quota-fallback-success',
    metabot: BOT_WITH_FALLBACK,
    // Call 1 dies on quota; the fallback attempt (call 2) succeeds. No
    // same-route resumes and no fallback ladder may appear.
    script: (_input, callNo) => (callNo === 1 ? quotaError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 2, '1 initial quota death + 1 single fallback attempt')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-a')
  assert.equal(result.runTurnCalls[1].provider.key, 'gw-b', 'the out-of-credit turn degrades to the fallback brain')
  assert.equal(result.runTurnCalls[1].provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)
  await result.completed
})

// When the fallback route ALSO dies on quota, the turn settles with the
// error whose quota notice names the route that actually ran out — the
// fallback route (via lastAttemptRoute), not the primary.
test('a quota death on the fallback route settles with the notice naming the fallback route', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-quota-both-routes-dead',
    metabot: BOT_WITH_FALLBACK,
    script: (_input) => quotaError(),
  })

  assert.equal(result.runTurnCalls.length, 2, '1 initial + 1 single fallback attempt — no ladders on quota')
  assert.equal(result.sessionRow?.status, 'error')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].error, /GoUsageLimitError/)
  assert.match(result.errors[0].error, /mock-b1/, 'the quota notice names the fallback model (lastAttemptRoute)')
  assert.match(result.errors[0].error, /gw-b/)
})

// Regression pin for the 2026-09-28 independent-verification finding: the
// quota-only unconditional first attempt must NOT leak into the transient
// path. When BOTH routes keep failing transiently, the fallback budget stays
// exactly what origin/main gives (DSH_FALLBACK_TURN_MAX_RESUMES = 2): total
// calls = 1 initial + 3 primary resumes + 2 fallback resumes = 6. A draft of
// this fix raised it to 7 by adding an unconditional attempt for transient
// entries too.
test('persistent transient failure on both routes keeps the origin fallback budget (6 calls, not 7)', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-transient-budget-unchanged',
    metabot: BOT_WITH_FALLBACK,
    script: () => transientError(),
  })

  assert.equal(result.runTurnCalls.length, 6, '1 initial + 3 primary resumes + 2 fallback resumes — quota fix must not change this')
  assert.equal(result.sessionRow?.status, 'error')
})

// ---------------------------------------------------------------------------
// 2026-10-08 stale-binding rescue: the bot brain (or session model) is pinned
// to an exhausted provider and NO fallback brain is configured — Boss ruling:
// a model call has NO stickiness; while the CURRENT default model is valid,
// the call must work. The turn must rescue itself onto the freshly resolved
// current default route instead of dying (and re-dying for every queued
// message behind it — the 429 avalanche). Nothing is anchored: the failure
// affects only that attempt; the next turn re-resolves from scratch.
// ---------------------------------------------------------------------------

const BOT_WITHOUT_FALLBACK = {
  id: 2,
  name: 'StaleBinding Bot',
  llm_id: 'mock-a1',
  llm_provider: 'gw-a',
  fallback_llm_id: null,
  fallback_llm_provider: null,
}

// Free-relay rescue target (still valid after the 2026-10-08 rework ruling:
// the free relay remains an acceptable rescue path, it is just no longer the
// ONLY one — see the paid-default rescue test below).
const FREE_RELAY_OVERRIDES = {
  defaultModel: 'free-m1',
  defaultProvider: 'metaid-free',
  providers: {
    'metaid-free': {
      enabled: true,
      apiKey: 'sk-free',
      baseUrl: 'http://free.example/v1',
      apiFormat: 'openai',
      models: [{ id: 'free-m1', name: 'free-m1', contextWindow: 32768, maxOutputTokens: 4096 }],
    },
  },
}

test('a quota death with NO fallback brain rescues the turn onto the free-relay CURRENT default and completes', async () => {
  const result = await driveTurn({
    sessionId: 'stale-binding-quota-default-rescue',
    metabot: BOT_WITHOUT_FALLBACK,
    // Owner moved the default to the free relay AFTER the session/bot binding
    // to gw-a/mock-a1 was made; the stale binding dies on quota at call 1 and
    // the free-relay default carries call 2 to completion.
    configOverrides: { ...FREE_RELAY_OVERRIDES, providers: { ...FREE_RELAY_OVERRIDES.providers, ...NO_RESCUE_PROVIDERS } },
    script: (_input, callNo) => (callNo === 1 ? quotaError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 2, '1 initial quota death + 1 single default-rescue attempt')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-a', 'call 1 rides the stale bound route')
  assert.equal(result.runTurnCalls[1].provider.key, 'metaid-free', 'the exhausted turn degrades to the free-relay CURRENT default')
  assert.equal(result.runTurnCalls[1].provider.model, 'free-m1')
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)

  const notice = result.store.messages.find(
    (m) => m.type === 'system' && m.metadata?.dshRouteFallback === true,
  )
  assert.ok(notice, 'a dshRouteFallback system message lands in the transcript')
  assert.match(notice.content, /free-m1/)
  assert.match(notice.content, /当前默认|current default/)
  await result.completed
})

test('a PAID current default IS accepted by the rescue — the turn completes on it (guardrail removed)', async () => {
  // 2026-10-08 Boss rework ruling: the free-relay-only guardrail is removed.
  // gw-b is a PAID provider and the current default — the rescue must take
  // it ("rescue may cost" is not a concern; a dead turn is). A non-free mock
  // target proves the paid default is actually rescued onto, not declined.
  const result = await driveTurn({
    sessionId: 'stale-binding-paid-default-rescue',
    metabot: BOT_WITHOUT_FALLBACK,
    configOverrides: { defaultModel: 'mock-b1', defaultProvider: 'gw-b' },
    script: (_input, callNo) => (callNo === 1 ? quotaError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 2, '1 initial quota death + 1 single paid-default rescue attempt')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-a', 'call 1 rides the stale bound route')
  assert.equal(result.runTurnCalls[1].provider.key, 'gw-b', 'the exhausted turn degrades onto the PAID current default')
  assert.equal(result.runTurnCalls[1].provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed', 'the turn completes on the paid default — no dead turn')
  assert.equal(result.errors.length, 0)
  const notice = result.store.messages.find(
    (m) => m.type === 'system' && m.metadata?.dshRouteFallback === true,
  )
  assert.ok(notice, 'a dshRouteFallback system message lands in the transcript')
  assert.match(notice.content, /mock-b1/)
  assert.match(notice.content, /当前默认|current default/)

  const logText = fs.readFileSync(coworkLogPath(), 'utf-8')
  assert.ok(
    logText.includes('rescuing the turn onto the current default route'),
    'the rescue WARN names the paid target route in cowork.log',
  )
  // NOTE: cowork.log is append-only across runs, so a whole-file doesNotMatch
  // against pre-rework guardrail strings would false-positive on historical
  // entries; the positive rescue assertion above is the behavior check.
  await result.completed
})

test('an exhausted RATE_LIMIT (transient) ladder with no fallback brain rescues onto the free-relay default route', async () => {
  const rateLimitError = () => ({ kind: 'error', error: { code: 'RATE_LIMIT', message: '429 too many requests' } })
  const result = await driveTurn({
    sessionId: 'stale-binding-ratelimit-default-rescue',
    metabot: BOT_WITHOUT_FALLBACK,
    configOverrides: { ...FREE_RELAY_OVERRIDES, providers: { ...FREE_RELAY_OVERRIDES.providers, ...NO_RESCUE_PROVIDERS } },
    // 1 initial + 3 same-route transient resumes all rate-limited on the dead
    // bound route; the default-rescue attempt (call 5) completes.
    script: (_input, callNo) => (callNo <= 4 ? rateLimitError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 5, '1 initial + 3 primary resumes + 1 default-rescue attempt')
  for (const call of result.runTurnCalls.slice(0, 4)) {
    assert.equal(call.provider.key, 'gw-a', 'the primary ladder stays on the bound route')
  }
  assert.equal(result.runTurnCalls[4].provider.key, 'metaid-free')
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)
  await result.completed
})

test('a quota death with no valid ladder target names the exhausted provider, never a config error', async () => {
  // 2026-10-12 correction of the ring-④ wording: 全环查遍确无可用配置 is only
  // a CONFIGURATION error when the cause is config-shaped (stale/missing model
  // id, dead key). When the cause is an exhausted allowance the model IS
  // configured and worked until its quota ran out, so the terminal copy must
  // name the exhausted route instead of telling the user to go fix a
  // misconfiguration. The raw GoUsageLimitError body stays stripped (full raw
  // outcome in the cowork.log ERROR line) and the normalized code is kept.
  const result = await driveTurn({
    sessionId: 'stale-binding-no-op-rescue',
    configOverrides: { providers: NO_RESCUE_PROVIDERS },
    metabot: BOT_WITHOUT_FALLBACK,
    // defaultModel stays mock-a1/gw-a — the same route that is quota-dead.
    script: (_input, callNo) => (callNo === 1 ? quotaError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 1, 'no rescue attempt when the default is the dead route itself')
  assert.equal(result.sessionRow?.status, 'error')
  assert.equal(result.errors.length, 1)
  const errorText = String(result.errors[0].error)
  assert.match(errorText, /gw-a/, 'the terminal error names the exhausted provider')
  assert.match(errorText, /mock-a1/, 'and the exhausted model')
  assert.doesNotMatch(errorText, /未配置可用模型/, 'quota exhaustion is not reported as a missing configuration')
  assert.doesNotMatch(errorText, /配置错误/, 'and specifically not as a configuration error')
  assert.doesNotMatch(errorText, /GoUsageLimitError/, 'the native 429 body is not retained in the user-visible error')
  assert.match(errorText, /QUOTA/, 'the normalized error code stays for diagnosis')

  const logText = fs.readFileSync(coworkLogPath(), 'utf-8')
  assert.ok(
    logText.includes('GoUsageLimitError'),
    'the full raw provider body is preserved in the cowork.log ERROR line',
  )
})

test('a quota death on the FREE relay tells the user to bring their own key (banner code included)', async () => {
  // 2026-10-12 fresh-install report: the free starter allowance is the only
  // route a new install has, so its 429 free_quota_exhausted produced
  // "未配置可用模型 … 这是配置错误而非临时限流" — actively misleading.
  // The free-relay death gets its own copy, and the literal
  // `free_quota_exhausted` token rides along so the renderer's quota banner
  // (CoworkSessionDetail, which keys off that code) appears with its
  // Settings > Model shortcut.
  const result = await driveTurn({
    sessionId: 'fresh-install-free-quota-death',
    metabot: { ...BOT_WITHOUT_FALLBACK, id: 3, name: 'Fresh Twin', llm_id: 'free-m1', llm_provider: 'metaid-free' },
    // Fresh-install shape: the free relay is the ONLY configured route — the
    // fixture's residual gw-a must not become a system rescue brain either.
    configOverrides: {
      ...FREE_RELAY_OVERRIDES,
      providers: {
        ...FREE_RELAY_OVERRIDES.providers,
        ...NO_RESCUE_PROVIDERS,
        'gw-a': { enabled: false, apiKey: '', baseUrl: 'http://primary.example/v1', apiFormat: 'openai', models: [] },
      },
    },
    script: () => ({
      kind: 'error',
      error: {
        code: 'QUOTA',
        message: '429 {"type":"error","error":{"type":"api_error","message":"free_quota_exhausted: free quota exhausted"}}',
      },
    }),
  })

  assert.equal(result.runTurnCalls.length, 1, 'the free relay has no ladder target to rescue onto')
  assert.equal(result.sessionRow?.status, 'error')
  const errorText = String(result.errors[0].error)
  assert.match(errorText, /免费额度已用完|Free starter quota exhausted/, 'the copy names the exhausted free allowance')
  assert.match(errorText, /free_quota_exhausted/, 'the renderer banner code is present')
  assert.doesNotMatch(errorText, /未配置可用模型/, 'not the misleading no-usable-model wording')
  assert.doesNotMatch(errorText, /配置错误而非临时限流/, 'and not the configuration-error explanation')
})

test('a genuinely misconfigured route still reports the configuration error', async () => {
  // The other half of the correction: a config-shaped death (the bound model
  // does not exist on the route, no fallback, no other default) keeps the
  // ring-④ configuration semantics — quota wording must never mask it.
  const result = await driveTurn({
    sessionId: 'stale-binding-model-missing',
    configOverrides: { providers: NO_RESCUE_PROVIDERS },
    metabot: BOT_WITHOUT_FALLBACK,
    script: (_input, callNo) => (
      callNo === 1
        ? { kind: 'error', error: { code: 'MODEL_NOT_FOUND', message: '404 model mock-a1 does not exist' } }
        : { kind: 'completed' }
    ),
  })

  assert.equal(result.sessionRow?.status, 'error')
  const errorText = String(result.errors[0].error)
  assert.match(errorText, /未配置可用模型/, 'a real config hole keeps the configuration-error wording')
  assert.match(errorText, /配置错误/, 'including the explicit "not a rate limit" clarification')
  assert.doesNotMatch(errorText, /免费额度|free_quota_exhausted/, 'and never claims a quota problem')
})

test('a transport-class terminal death with no alternative is NOT reported as a configuration error', async () => {
  // Ledger #25 (2026-10-25): a dead network (or an unreachable provider)
  // with no fallback brain and no rescue default settles after the transient
  // resume budget is exhausted. The old no-alternative copy read
  // "未配置可用模型 … 这是配置错误而非临时限流" for this environmental death
  // too, sending the user hunting for a misconfiguration during an outage.
  // The transport-class terminal death gets its own copy: it names the
  // environmental failure, tells the user to resend after recovery, and
  // carries the machine code — and never contains the 配置错误 wording.
  const result = await driveTurn({
    sessionId: 'transport-death-no-alternative',
    configOverrides: { providers: NO_RESCUE_PROVIDERS },
    metabot: BOT_WITHOUT_FALLBACK,
    script: () => ({
      kind: 'error',
      error: { code: 'TRANSPORT', message: 'fetch failed: network unreachable' },
    }),
  })

  assert.equal(result.sessionRow?.status, 'error')
  const errorText = String(result.errors[0].error)
  assert.match(errorText, /传输类失败|transport-class failure/, 'the copy names the environmental failure class')
  assert.match(errorText, /网络或供应商|network or provider/, 'and the likely cause')
  assert.match(errorText, /TRANSPORT/, 'the machine code rides along for diagnosis')
  assert.doesNotMatch(errorText, /未配置可用模型|No usable model configured/, 'not the no-usable-model wording')
  assert.doesNotMatch(errorText, /配置错误|configuration error/, 'and never claims a configuration problem')
})

test('every transient-class terminal code keeps the transport copy — TIMEOUT carries its own code', async () => {
  // The environmental set is TRANSIENT_TURN_ERROR_CODES
  // (TRANSPORT/TIMEOUT/RATE_LIMIT/SERVER/EMPTY_RESPONSE); the copy must
  // interpolate the ACTUAL code, not a hardcoded TRANSPORT literal.
  const result = await driveTurn({
    sessionId: 'timeout-death-no-alternative',
    configOverrides: { providers: NO_RESCUE_PROVIDERS },
    metabot: BOT_WITHOUT_FALLBACK,
    script: () => ({
      kind: 'error',
      error: { code: 'TIMEOUT', message: 'request timed out after 30000ms' },
    }),
  })

  assert.equal(result.sessionRow?.status, 'error')
  const errorText = String(result.errors[0].error)
  assert.match(errorText, /TIMEOUT/, 'the TIMEOUT code is interpolated verbatim')
  assert.doesNotMatch(errorText, /TRANSPORT/, 'not the hardcoded TRANSPORT literal')
  assert.doesNotMatch(errorText, /配置错误|configuration error/, 'and never claims a configuration problem')
})


// ---------------------------------------------------------------------------
// 2026-10-18 (session 3144cb1a storm: expired OpenCode key on the primary +
// tool_removal-rejecting fallback = 88 dead turns in 7 minutes): the
// config-hard degrade attempt now rides its own resume cue, and repeated
// won't-heal settlements open a per-session route circuit breaker.
// ---------------------------------------------------------------------------

test('a config-class hard error resumes the fallback attempt with the config-hard cue (not the transient one)', async () => {
  const { assistantReply } = loadModules()
  const result = await driveTurn({
    sessionId: 'gt02-auth-degrade-cue',
    metabot: BOT_WITH_FALLBACK,
    script: (_input, callNo) => (callNo === 1
      ? { kind: 'error', error: { code: 'AUTH_FAILED', message: '401 invalid api key' } }
      : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 2, '1 initial auth death + 1 single fallback attempt')
  assert.equal(
    result.runTurnCalls[1].prompt,
    assistantReply.CONFIG_HARD_FALLBACK_RESUME_PROMPT,
    'the config-hard fallback attempt names the real failure class',
  )
  assert.notEqual(result.runTurnCalls[1].prompt, result.TRANSIENT_TURN_RESUME_PROMPT)
  await result.completed
})

// Drive N runDshSessionLocal invocations on ONE runner (the circuit map is a
// per-instance field), each with a fresh activeSession. Pass the returned ctx
// back in `state` to continue the same runner; swap ctx.metabot (and re-run
// installApiConfig) to simulate the user changing the model binding.
async function driveSequence({ sessionId, metabot, script, invocations, configOverrides = {}, state = null }) {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const ctx = state ?? {}
  if (!state) {
    ctx.runTurnCalls = []
    ctx.errors = []
  }
  ctx.metabot = metabot ?? ctx.metabot
  ctx.script = script ?? ctx.script
  installApiConfig(claudeSettings, configOverrides)
  if (!state) {
    ctx.store = new RecordingStore()
    ctx.runner = new CoworkRunner(ctx.store, {
      getMetabotById: (id) => (ctx.metabot && id === ctx.metabot.id ? ctx.metabot : null),
    })
    ctx.runner.dshTurnHub = {
      runTurn: async (input) => {
        ctx.runTurnCalls.push(input)
        return ctx.script(input, ctx.runTurnCalls.length)
      },
      prewarmTurnSlot: async () => undefined,
      cancel: async () => undefined,
      cancelAgent: async () => undefined,
      forceSettle: () => undefined,
      usageProjection: async () => null,
      compact: async () => ({ ok: true, compacted: false }),
    }
    ctx.runner.on('error', (sid, error) => ctx.errors.push({ sid, error }))
    ctx.runner.on('permissionRequest', () => undefined)
  }
  for (let i = 0; i < invocations; i += 1) {
    const activeSession = {
      sessionId,
      claudeSessionId: null,
      workspaceRoot: process.cwd(),
      confirmationMode: 'modal',
      pendingPermission: null,
      abortController: new AbortController(),
      executionMode: 'local',
      localTurnState: 'none',
      permissionMode: 'default',
      readFiles: new Map(),
    }
    ctx.runner.activeSessions.set(sessionId, activeSession)
    ctx.store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', metabotId: ctx.metabot?.id ?? null, messages: [] })
    // eslint-disable-next-line no-await-in-loop
    await ctx.runner.runDshSessionLocal(activeSession, `GT02_PROBE invocation ${ctx.runTurnCalls.length + 1}`, process.cwd(), 'You are Alice.')
  }
  return ctx
}

test('route circuit breaker: consecutive wont-heal deaths stop spending model calls until the cooldown probe', async () => {
  const noFallbackBot = { id: 6, name: 'Circuit Bot', llm_id: 'mock-a1', llm_provider: 'gw-a' }
  const authDeath = () => ({ kind: 'error', error: { code: 'AUTH_FAILED', message: '401 invalid api key' } })

  // Three inbound messages, three won't-heal settlements (no fallback brain —
  // each invocation is a single primary attempt).
  const ctx = await driveSequence({ sessionId: 'gt02-circuit', metabot: noFallbackBot, script: authDeath, invocations: 3, configOverrides: { providers: NO_RESCUE_PROVIDERS } })
  assert.equal(ctx.runTurnCalls.length, 3, 'each invocation spent its primary attempt')
  const opened = ctx.runner.dshRouteCircuits.get('gt02-circuit')
  assert.ok(opened, 'the circuit recorded the failures')
  assert.ok(opened.openUntil > Date.now(), 'the circuit is open after the threshold')

  // While open, further messages settle WITHOUT any model call, with a notice
  // naming the breaker.
  const ctx2 = await driveSequence({ state: ctx, sessionId: 'gt02-circuit', invocations: 2 })
  assert.equal(ctx2.runTurnCalls.length, 3, 'an open circuit spends no model calls')
  assert.ok(
    ctx2.errors.some((entry) => /circuit breaker|熔断/.test(String(entry.error))),
    'the short-circuit settlement explains the breaker',
  )

  // The cooldown probe: force the window to expire, then a live outcome
  // closes the circuit.
  const circuit = ctx2.runner.dshRouteCircuits.get('gt02-circuit')
  assert.ok(circuit, 'circuit state still present')
  circuit.openUntil = 0
  const ctx3 = await driveSequence({ state: ctx2, sessionId: 'gt02-circuit', script: () => ({ kind: 'completed' }), invocations: 1 })
  assert.equal(ctx3.runTurnCalls.length, 4, 'the expired circuit lets one probe through')
  assert.equal(ctx3.runner.dshRouteCircuits.get('gt02-circuit'), undefined, 'a live outcome closes the circuit')
  assert.equal(ctx3.store.sessions.get('gt02-circuit')?.status, 'completed')
})

test('route circuit breaker: changing the model binding resets the verdict', async () => {
  const botV1 = { id: 7, name: 'Circuit Switch Bot', llm_id: 'mock-a1', llm_provider: 'gw-a' }
  const authDeath = () => ({ kind: 'error', error: { code: 'AUTH_FAILED', message: '401 invalid api key' } })
  const ctx = await driveSequence({ sessionId: 'gt02-circuit-switch', metabot: botV1, script: authDeath, invocations: 3, configOverrides: { providers: NO_RESCUE_PROVIDERS } })
  assert.ok((ctx.runner.dshRouteCircuits.get('gt02-circuit-switch')?.openUntil ?? 0) > Date.now(), 'circuit open')

  // The owner rebinds the bot to a different provider/model: the old route's
  // failures must not suppress turns on the new route.
  const ctx2 = await driveSequence({
    state: ctx,
    sessionId: 'gt02-circuit-switch',
    metabot: { id: 7, name: 'Circuit Switch Bot', llm_id: 'mock-c1', llm_provider: 'gw-c' },
    configOverrides: {
      providers: {
        ...NO_RESCUE_PROVIDERS,
        'gw-c': {
          enabled: true,
          apiKey: 'sk-c',
          baseUrl: 'http://third.example/v1',
          apiFormat: 'openai',
          models: [{ id: 'mock-c1', name: 'mock-c1', contextWindow: 32768, maxOutputTokens: 4096 }],
        },
      },
    },
    script: () => ({ kind: 'completed' }),
    invocations: 1,
  })
  const probe = ctx2.runTurnCalls[3]
  assert.ok(probe, 'the rebound route gets a real model call despite the open circuit')
  assert.equal(probe.provider.key, 'gw-c')
  assert.equal(ctx2.runner.dshRouteCircuits.get('gt02-circuit-switch'), undefined, 'the live outcome clears the circuit')
  assert.equal(ctx2.store.sessions.get('gt02-circuit-switch')?.status, 'completed')
})
