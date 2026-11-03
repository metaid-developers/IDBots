// Requires: pnpm run compile:electron (this suite loads the compiled runner).

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)

function loadRunner() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => `/tmp/idbots-assistant-owner-update-${name}`,
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkRunner.js')
  } finally {
    Module._load = originalLoad
  }
}

function loadTurnAckReply() {
  return require('../dist-electron/main/libs/turnAckReply.js')
}

class RecordingStore {
  constructor() {
    this.messages = []
  }

  getSession() { return null }
  getConfig() { return {} }

  addMessage(sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: Date.now(), ...message }
    this.messages.push({ sessionId, ...stored })
    return stored
  }
}

function setup({ assistant = true, active = true, waitTimeoutMs = 0 } = {}) {
  const { CoworkRunner } = loadRunner()
  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0, assistantOwnerWaitTimeoutMs: waitTimeoutMs })
  runner.isAssistantModeOwnerChatSession = () => assistant
  runner.buildSessionInlineTools = () => []
  if (active) {
    runner.activeSessions.set('s1', {
      sessionId: 's1',
      permissionMode: 'plan',
      assistantOwnerUpdateCount: 0,
      dshTurnAckVisibleTextSeen: false,
      abortController: new AbortController(),
      autoApproveTools: new Set(),
    })
  }
  const tools = runner.buildDshHostTools('s1')
  runner.dshHostToolRegistry.set('s1', new Map(tools.map((tool) => [tool.name, tool])))
  return { runner, store, tools }
}

const callUpdate = (runner, message, kind = 'milestone') => (
  runner.executeDshHostTool('s1', 'owner_update', { message, kind })
)

const { buildInstantTurnAckOpening } = loadTurnAckReply()

test('owner_update mounts only for an active assistant owner turn', () => {
  const assistant = setup()
  const update = assistant.tools.find((tool) => tool.name === 'owner_update')
  assert.ok(update, 'active assistant turn exposes owner_update')
  assert.equal(update.parameters.type, 'object')
  assert.equal(update.parameters.properties.message.maxLength, 280)
  assert.ok(update.parameters.required.includes('message'))
  assert.match(update.description, /At most 6 updates/)

  assert.equal(
    setup({ assistant: false }).tools.some((tool) => tool.name === 'owner_update'),
    false,
    'professional mode does not expose owner_update',
  )
  assert.equal(
    setup({ active: false }).tools.some((tool) => tool.name === 'owner_update'),
    false,
    'idle or background execution does not expose owner_update',
  )
})

test('owner_update allows plan mode, emits six whole bubbles, and rejects the seventh', async () => {
  const { runner, store } = setup()
  const emitted = []
  runner.on('message', (sessionId, message) => emitted.push({ sessionId, message }))

  for (let index = 1; index <= 7; index += 1) {
    const kind = index === 1 ? 'opening' : index === 7 ? 'problem' : 'milestone'
    const result = await callUpdate(runner, `Update ${index}`, kind)
    assert.equal(result.ok, true, `call ${index} executes in plan mode: ${result.error ?? 'ok'}`)
    const payload = JSON.parse(result.text)
    if (index <= 6) {
      assert.equal(payload.shown, true)
      assert.equal(payload.remaining, 6 - index)
    } else {
      assert.equal(payload.shown, false)
      assert.match(payload.reason, /per-submission update cap reached/)
    }
  }

  assert.deepEqual(store.messages.map((message) => message.content), [
    'Update 1', 'Update 2', 'Update 3', 'Update 4', 'Update 5', 'Update 6',
  ])
  assert.equal(store.messages[0].metadata.narration, true)
  assert.equal(store.messages[0].metadata.ownerUpdateKind, 'opening')
  assert.equal(store.messages[1].metadata.ownerUpdateKind, 'milestone')
  assert.equal(store.messages.some((message) => message.metadata.ownerUpdateKind === 'problem'), false)
  assert.equal(emitted.length, 6, 'only the six persisted bubbles reach the renderer')
  assert.deepEqual(emitted.map((entry) => entry.message.content), store.messages.map((message) => message.content))
  assert.ok(emitted.every((entry) => entry.sessionId === 's1'))
  assert.ok(emitted.every((entry) => entry.message.metadata.isStreaming === undefined), 'updates arrive whole, not as rewritable streams')

  const active = runner.activeSessions.get('s1')
  assert.equal(active.assistantOwnerUpdateCount, 6)
  assert.equal(active.dshTurnAckVisibleTextSeen, true, 'a real update suppresses a late acknowledgment')
})

test('owner_update validates input and trims the persisted message', async () => {
  const { runner, store } = setup()

  for (const args of [
    { message: '   ', kind: 'milestone' },
    { message: 'x'.repeat(281), kind: 'milestone' },
    { message: 'invalid kind', kind: 'internal' },
  ]) {
    const result = await runner.executeDshHostTool('s1', 'owner_update', args)
    assert.equal(result.ok, true)
    assert.equal(JSON.parse(result.text).shown, false)
  }
  assert.equal(store.messages.length, 0)

  const accepted = await callUpdate(runner, '  Verified result  ')
  assert.equal(JSON.parse(accepted.text).shown, true)
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].content, 'Verified result')
})

test('a non-assistant session cannot emit through a forged owner_update registry entry', async () => {
  const { runner, store } = setup({ assistant: false })
  const active = runner.activeSessions.get('s1')
  runner.dshHostToolRegistry.set('s1', new Map([[
    'owner_update',
    {
      name: 'owner_update',
      description: 'forged',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => runner.emitAssistantOwnerUpdate('s1', args, active),
    },
  ]]))

  const result = await callUpdate(runner, 'must not appear')
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(result.text), { shown: false, reason: 'owner update turn is no longer active' })
  assert.equal(store.messages.length, 0)
})

test('a late owner_update cannot charge the next submission or suppress its ack', async () => {
  const { runner, store } = setup()
  const previous = runner.activeSessions.get('s1')
  const next = {
    sessionId: 's1',
    permissionMode: 'plan',
    assistantOwnerUpdateCount: 0,
    dshTurnAckVisibleTextSeen: false,
    abortController: new AbortController(),
    autoApproveTools: new Set(),
  }
  runner.activeSessions.set('s1', next)

  const result = await callUpdate(runner, 'late previous-turn update')
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(result.text), { shown: false, reason: 'owner update turn is no longer active' })
  assert.equal(store.messages.length, 0)
  assert.equal(previous.assistantOwnerUpdateCount, 0)
  assert.equal(previous.dshTurnAckVisibleTextSeen, false)
  assert.equal(next.assistantOwnerUpdateCount, 0)
  assert.equal(next.dshTurnAckVisibleTextSeen, false)
})

test('a second opening is rejected once an opening or real reply is already visible', async () => {
  const { runner, store } = setup()
  const first = await callUpdate(runner, 'I will check the purchase validation first.', 'opening')
  assert.equal(JSON.parse(first.text).shown, true)
  const second = await callUpdate(runner, 'I will check the purchase validation first.', 'opening')
  assert.equal(JSON.parse(second.text).shown, false)
  assert.match(JSON.parse(second.text).reason, /opening already delivered/)
  assert.equal(store.messages.length, 1)
})

test('host waiting update fires at five minutes and backs off without hidden tool activity resetting it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runner, store } = setup({ waitTimeoutMs: 300_000 })
  const active = runner.activeSessions.get('s1')
  runner.armAssistantOwnerWaitTimer('s1', active)

  t.mock.timers.tick(299_999)
  assert.equal(store.messages.length, 0)
  active.assistantOwnerWaitingForTool = true
  t.mock.timers.tick(1)
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].metadata.ownerUpdateKind, 'waiting')
  assert.match(store.messages[0].content, /执行步骤|execution step/)
  assert.equal(active.assistantOwnerUpdateCount, 1)

  t.mock.timers.tick(599_999)
  assert.equal(store.messages.length, 1)
  t.mock.timers.tick(1)
  assert.equal(store.messages.length, 2)
  assert.equal(active.assistantOwnerUpdateCount, 2)
  clearTimeout(active.assistantOwnerHeartbeatTimer)
  t.mock.timers.reset()
})

test('a real owner update resets the five-minute visible-message window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runner, store } = setup({ waitTimeoutMs: 300_000 })
  const active = runner.activeSessions.get('s1')
  runner.armAssistantOwnerWaitTimer('s1', active)
  t.mock.timers.tick(200_000)

  const result = await callUpdate(runner, 'The root cause is verified.')
  assert.equal(JSON.parse(result.text).shown, true)
  t.mock.timers.tick(299_999)
  assert.equal(store.messages.length, 1)
  t.mock.timers.tick(1)
  assert.equal(store.messages.length, 2)
  assert.equal(store.messages[1].metadata.ownerUpdateKind, 'waiting')
  clearTimeout(active.assistantOwnerHeartbeatTimer)
  t.mock.timers.reset()
})

test('turn teardown clears the waiting timer so it cannot leak into the next submission', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runner, store } = setup({ waitTimeoutMs: 1_000 })
  const active = runner.activeSessions.get('s1')
  runner.armAssistantOwnerWaitTimer('s1', active)
  runner.removeActiveSession('s1', active)
  assert.equal(active.assistantOwnerHeartbeatTimer, null)

  t.mock.timers.tick(5_000)
  assert.equal(store.messages.length, 0)
  t.mock.timers.reset()
})

// 2026-11-03 rework: the opening is emitted synchronously (no timer), and
// the LLM ack refines that bubble in place at most once — never a second
// bubble, never a duplicate after the model produced visible text.
test('opening bubble is emitted synchronously and refined in place exactly once', () => {
  const { runner, store } = setup()
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const prompt = '你要不搜一下本机看有没有这个文件？'

  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, '我先在本机查找相关文件和信息。')
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].metadata.turnAckReply, true)
  assert.equal(store.messages[0].content, '我先在本机查找相关文件和信息。')
  assert.equal(active.dshTurnAckOpeningMessageId, store.messages[0].id)
  assert.equal(active.dshTurnAckOpeningText, '我先在本机查找相关文件和信息。')
  assert.equal(active.assistantOwnerUpdateCount, 1)

  // A second emit (late timer, double kick) cannot duplicate the bubble.
  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, '另一条开场白')
  assert.equal(store.messages.length, 1)
  runner.removeActiveSession('s1', active)
})

test('delivery prompts: the refine path emits nothing; the instant opening carries the actor context', async () => {
  const { runner, store } = setup()
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const prompt = '来自af3365c8-dfb6-4348-b350-0a0db4edbcc4 的信息：<cross_session_message trust="untrusted">[ORCH-NOTIFY] worker Builder阿码 已完成 task 46828477-0719-4984-8391-3148bec1a3fc → review，请验收</cross_session_message>'

  // The refine (LLM ack) never touches delivery prompts — their opening is
  // deterministic and actor-aware, emitted synchronously by the site.
  await runner.emitTurnAckReplyBubble('s1', prompt, active, 1)
  assert.equal(store.messages.length, 0)

  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, buildInstantTurnAckOpening(prompt, 's1:1'))
  assert.equal(store.messages.length, 1)
  assert.match(store.messages[0].content, /^Builder阿码已交付一个子任务/)
  assert.ok(!store.messages[0].content.includes('cross_session'))
  runner.removeActiveSession('s1', active)
})

test('the finalization stage rejects every tool through the host policy', async () => {
  const { runner } = setup()
  const active = runner.activeSessions.get('s1')
  active.finalizingTurn = true
  const result = await runner.evaluateDshToolPolicy('s1', 'bash', { command: 'echo should-not-run' })
  assert.equal(result.decision, 'deny')
  assert.match(result.reason, /does not allow tool calls/)
})

test('a delivery opening via the instant builder keeps the per-turn budget seeded at one', async () => {
  const { runner, store } = setup()
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const prompt = '来自af3365c8-dfb6-4348-b350-0a0db4edbcc4 的信息：<cross_session_message trust="untrusted">[ORCH-NOTIFY] worker Builder阿码 已完成 task 46828477-0719-4984-8391-3148bec1a3fc → review，请验收</cross_session_message>'
  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, buildInstantTurnAckOpening(prompt, 's1:1'))
  assert.equal(store.messages.length, 1)
  assert.equal(active.assistantOwnerUpdateCount, 1, 'the host opening consumes one budget slot')
  // The model's own kind:'opening' is rejected now — the host bubble IS the opening.
  const rejection = await callUpdate(runner, '收到，这是一条模型自己的开场。', 'opening')
  assert.deepEqual(JSON.parse(rejection.text), { shown: false, reason: 'opening already delivered; report only new milestones or problems' })
})
