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

test('without a fallback brain the turn fails after the primary resume budget (behavior unchanged)', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-no-fallback',
    metabot: { id: 2, name: 'NoFallback Bot', llm_id: 'mock-a1', llm_provider: 'gw-a' },
    script: () => ({ kind: 'error', error: { code: 'TIMEOUT', message: 'request timed out' } }),
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
    configOverrides: FREE_RELAY_OVERRIDES,
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
    configOverrides: FREE_RELAY_OVERRIDES,
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

test('when the degrade ladder has NO valid target the error reads 未配置可用模型 (config error), not the raw 429', async () => {
  // Boss ruling ring ④: 全环查遍确无可用配置 → 报错语义 = 配置错误. The
  // default IS the dead route itself (no rescue loop possible) and no
  // fallback brain exists — the user-visible error must be the config
  // semantics with the raw GoUsageLimitError body stripped (full raw outcome
  // stays in the cowork.log ERROR line for diagnosis).
  const result = await driveTurn({
    sessionId: 'stale-binding-no-op-rescue',
    metabot: BOT_WITHOUT_FALLBACK,
    // defaultModel stays mock-a1/gw-a — the same route that is quota-dead.
    script: (_input, callNo) => (callNo === 1 ? quotaError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 1, 'no rescue attempt when the default is the dead route itself')
  assert.equal(result.sessionRow?.status, 'error')
  assert.equal(result.errors.length, 1)
  const errorText = String(result.errors[0].error)
  assert.match(errorText, /未配置可用模型/, 'the terminal error carries the no-usable-model-configured semantics')
  assert.doesNotMatch(errorText, /GoUsageLimitError/, 'the native 429 body is not retained in the user-visible error')
  assert.match(errorText, /QUOTA/, 'the normalized error code stays for diagnosis')

  const logText = fs.readFileSync(coworkLogPath(), 'utf-8')
  assert.ok(
    logText.includes('GoUsageLimitError'),
    'the full raw provider body is preserved in the cowork.log ERROR line',
  )
})

