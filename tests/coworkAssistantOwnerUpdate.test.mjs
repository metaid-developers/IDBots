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

function loadCoworkUtil() {
  return require('../dist-electron/main/libs/coworkUtil.js')
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

function setup({ assistant = true, active = true, waitTimeoutMs = 0, waitGenerator, ackGate } = {}) {
  const { CoworkRunner } = loadRunner()
  const store = new RecordingStore()
  const runner = new CoworkRunner(store, {
    localTurnStallTimeoutMs: 0,
    assistantOwnerWaitTimeoutMs: waitTimeoutMs,
    cerebellumTurnAckGate: ackGate,
    // 2026-11-04: the heartbeat text is LLM-written per fire (no canned
    // strings anywhere); tests inject a stub. The production default is
    // coworkUtil's generateOwnerWaitUpdate on the Twin system brain.
    ownerWaitUpdateGenerator: waitGenerator ?? (async () => '我还在继续推进，稍等我一下。'),
  })
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

const { buildDeterministicTurnAckOpening } = loadTurnAckReply()

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

// 2026-11-03 session 32a29372: the model's one opening narration was bounced
// ("opening already delivered") because visible text (a thinking bubble) had
// armed dshTurnAckVisibleTextSeen with NO real opening delivered, and the
// model then looped tools for ~6 minutes with no user-facing progress. The
// suppression now keys on dshTurnAckOpeningEmitted — only a real opening
// bubble (the host ack or an earlier owner_update 'opening') suppresses
// another; thinking/process text is not an opening.
test('visible thinking without a real opening no longer suppresses owner_update opening', async () => {
  const { runner, store } = setup()
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckVisibleTextSeen = true // a thinking bubble became visible
  // dshTurnAckOpeningEmitted stays falsy — no opening bubble went out.
  const result = await callUpdate(runner, '我先逐条核实分支状态，再给合并建议。', 'opening')
  assert.equal(JSON.parse(result.text).shown, true)
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].metadata.ownerUpdateKind, 'opening')
  assert.equal(active.dshTurnAckOpeningEmitted, true, 'the delivered opening marks the slot')
  const second = await callUpdate(runner, '另一个开场', 'opening')
  assert.equal(JSON.parse(second.text).shown, false, 'a second opening is still rejected')
  runner.removeActiveSession('s1', active)
})

test('host waiting update fires at five minutes and backs off without hidden tool activity resetting it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runner, store } = setup({ waitTimeoutMs: 300_000 })
  const active = runner.activeSessions.get('s1')
  runner.armAssistantOwnerWaitTimer('s1', active)

  t.mock.timers.tick(299_999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 0)
  active.assistantOwnerWaitingForTool = true
  t.mock.timers.tick(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].metadata.ownerUpdateKind, 'waiting')
  assert.equal(store.messages[0].content, '我还在继续推进，稍等我一下。', 'the bubble carries the generator text, never a canned string')
  assert.equal(active.assistantOwnerUpdateCount, 1)

  t.mock.timers.tick(599_999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 1)
  t.mock.timers.tick(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 2)
  assert.equal(active.assistantOwnerUpdateCount, 2)
  clearTimeout(active.assistantOwnerHeartbeatTimer)
  t.mock.timers.reset()
})

test('an empty generator result emits no bubble and backs off to the next window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runner, store } = setup({ waitTimeoutMs: 300_000, waitGenerator: async () => '' })
  const active = runner.activeSessions.get('s1')
  runner.armAssistantOwnerWaitTimer('s1', active)

  t.mock.timers.tick(300_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 0, 'no bubble beats a canned one — empty generation emits nothing')
  assert.equal(active.assistantOwnerHeartbeatCount, 1, 'the failed fire still counts for backoff')
  assert.ok(active.assistantOwnerHeartbeatTimer, 'the timer re-armed for the next window')
  // Next window doubles (backoff), so nothing at +300s, one more try at +600s.
  t.mock.timers.tick(300_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(active.assistantOwnerHeartbeatCount, 1)
  t.mock.timers.tick(300_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(active.assistantOwnerHeartbeatCount, 2)
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
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 1)
  t.mock.timers.tick(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 2)
  assert.equal(store.messages[1].metadata.ownerUpdateKind, 'waiting')
  clearTimeout(active.assistantOwnerHeartbeatTimer)
  t.mock.timers.reset()
})

test('a delivered final reply suppresses the wait heartbeat and it does not re-arm', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runner, store } = setup({ waitTimeoutMs: 300_000 })
  const active = runner.activeSessions.get('s1')
  // Session 09bb4098 shape: the visible final reply finalized, then the turn
  // stayed active with no new tool — the heartbeat must stay silent.
  active.assistantOwnerFinalReplyDelivered = true
  runner.armAssistantOwnerWaitTimer('s1', active)

  t.mock.timers.tick(300_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 0, 'no "still working" bubble after the answer was delivered')
  assert.equal(active.assistantOwnerHeartbeatTimer, null, 'the dropped heartbeat does not re-arm')
  t.mock.timers.tick(900_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 0, 'later windows stay silent too')
  t.mock.timers.reset()
})

test('the wait heartbeat names the last started tool as currentActivity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const inputs = []
  const { runner, store } = setup({
    waitTimeoutMs: 300_000,
    waitGenerator: async (input) => { inputs.push(input); return '我还在等 Builder阿码 交回结果。' },
  })
  runner.getMetabotById = (id) => (id === 7 ? { id: 7, name: 'Builder阿码' } : null)
  const active = runner.activeSessions.get('s1')
  active.assistantOwnerCurrentTool = { name: 'local_worker_delegate', input: { workerMetabotId: 7 } }
  runner.armAssistantOwnerWaitTimer('s1', active)

  t.mock.timers.tick(300_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(inputs.length, 1, 'the generator fired once')
  assert.equal(
    inputs[0].currentActivity,
    'delegated work to Builder阿码 and is waiting for it to report back',
    'the worker name resolves through the metabot lookup',
  )
  assert.equal(store.messages.length, 1)
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

// 2026-11-03 second pass: the deterministic opening is reserved for
// information-bearing delivery notices; generic first sentences come from the
// LLM. The emitter stays idempotent — one bubble per turn, never a duplicate.
test('deterministic opening bubble is emitted once and seeds the per-turn budget', () => {
  const { runner, store } = setup()
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const prompt = '你要不搜一下本机看有没有这个文件？'

  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, '我先在本机查这个文件。')
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].metadata.turnAckReply, true)
  assert.equal(store.messages[0].content, '我先在本机查这个文件。')
  assert.equal(active.dshTurnAckOpeningText, '我先在本机查这个文件。')
  assert.equal(active.assistantOwnerUpdateCount, 1)

  // A second emit (double kick, late call) cannot duplicate the bubble.
  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, '另一条开场白')
  assert.equal(store.messages.length, 1)
  runner.removeActiveSession('s1', active)
})

test('delivery prompts: the LLM first sentence stays out; the deterministic opening carries the actor context', async () => {
  const { runner, store } = setup()
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const prompt = '来自af3365c8-dfb6-4348-b350-0a0db4edbcc4 的信息：<cross_session_message trust="untrusted">[ORCH-NOTIFY] worker Builder阿码 已完成 task 46828477-0719-4984-8391-3148bec1a3fc → review，请验收</cross_session_message>'

  // The LLM first sentence never touches delivery prompts — their opening is
  // deterministic and actor-aware, emitted synchronously by the site.
  await runner.emitTurnAckReplyBubble('s1', prompt, active, 1)
  assert.equal(store.messages.length, 0)

  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, buildDeterministicTurnAckOpening(prompt))
  assert.equal(store.messages.length, 1)
  assert.match(store.messages[0].content, /^Builder阿码已交付一个子任务/)
  assert.ok(!store.messages[0].content.includes('cross_session'))
  runner.removeActiveSession('s1', active)
})

test('a direct-reply verdict releases the held first sentence when no visible reply meets the grace window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { runner, store } = setup({ ackGate: async () => false })
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const coworkUtil = loadCoworkUtil()
  t.mock.method(coworkUtil, 'generateTurnAckReply', async () => '我先把这个方向展开成几种不同表达，再给你筛选建议。')

  const pending = runner.emitTurnAckReplyBubble('s1', '帮我想几个新的文案方向', active, 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 0, 'the direct-reply verdict holds the generated opening initially')

  t.mock.timers.tick(2_999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.messages.length, 0, 'the grace window is not cut short')

  t.mock.timers.tick(1)
  await pending
  assert.equal(store.messages.length, 1, 'a status-only turn gets its first sentence after the grace window')
  assert.equal(store.messages[0].content, '我先把这个方向展开成几种不同表达，再给你筛选建议。')
  assert.equal(store.messages[0].metadata.turnAckReply, true)
  assert.equal(active.dshTurnAckOpeningEmitted, true)
  runner.removeActiveSession('s1', active)
  t.mock.timers.reset()
})

test('a visible main reply inside the grace window suppresses the held first sentence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { runner, store } = setup({ ackGate: async () => false })
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const coworkUtil = loadCoworkUtil()
  t.mock.method(coworkUtil, 'generateTurnAckReply', async () => '这条首句不应该再出现。')

  const pending = runner.emitTurnAckReplyBubble('s1', '你好', active, 1)
  await new Promise((resolve) => setImmediate(resolve))
  active.dshTurnAckVisibleTextSeen = true
  t.mock.timers.tick(3_000)
  await pending

  assert.equal(store.messages.length, 0, 'a fast direct answer remains a single-bubble turn')
  assert.ok(!active.dshTurnAckOpeningEmitted, 'no opening was emitted or marked as delivered')
  runner.removeActiveSession('s1', active)
  t.mock.timers.reset()
})

test('a non-direct verdict still emits the first sentence without waiting for the grace window', async (t) => {
  const { runner, store } = setup({ ackGate: async () => true })
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const coworkUtil = loadCoworkUtil()
  t.mock.method(coworkUtil, 'generateTurnAckReply', async () => '我先检查相关文件，再告诉你结果。')

  await runner.emitTurnAckReplyBubble('s1', '帮我检查这个项目的构建问题', active, 1)
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].content, '我先检查相关文件，再告诉你结果。')
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

test('a delivery opening via the deterministic builder keeps the per-turn budget seeded at one', async () => {
  const { runner, store } = setup()
  const active = runner.activeSessions.get('s1')
  active.dshTurnAckSerial = 1
  const prompt = '来自af3365c8-dfb6-4348-b350-0a0db4edbcc4 的信息：<cross_session_message trust="untrusted">[ORCH-NOTIFY] worker Builder阿码 已完成 task 46828477-0719-4984-8391-3148bec1a3fc → review，请验收</cross_session_message>'
  runner.emitTurnAckOpeningBubble('s1', prompt, active, 1, buildDeterministicTurnAckOpening(prompt))
  assert.equal(store.messages.length, 1)
  assert.equal(active.assistantOwnerUpdateCount, 1, 'the host opening consumes one budget slot')
  // The model's own kind:'opening' is rejected now — the host bubble IS the opening.
  const rejection = await callUpdate(runner, '收到，这是一条模型自己的开场。', 'opening')
  assert.deepEqual(JSON.parse(rejection.text), { shown: false, reason: 'opening already delivered; report only new milestones or problems' })
})
