// Regression test for the dsh-llm-deepseek kernel patch
// (scripts/dsh-kernel-patches/@deepseek-ai+dsh-llm-deepseek+0.2.2-rc.1.patch).
//
// The Messages adapter used to settle each tool-call block's accumulated
// input_json_delta with a bare JSON.parse at message_stop; a gateway-truncated
// JSON body therefore killed the whole agent turn with MALFORMED_RESPONSE
// ("DeepSeek Messages stream: tool input is invalid JSON"), a code the kernel
// deliberately never step-retries. The patch settles tool arguments at
// content_block_stop and applies a conservative structural repair first:
// cut back to the last fully-read value, drop the incomplete tail member,
// close the containers still open — never complete a scalar cut mid-token,
// because a wrong-but-plausible argument is worse than an honest failure.
//
// These tests drive the real installed adapter (the patched lib/index.js)
// against a stubbed global fetch serving canned Anthropic-Messages SSE
// streams, asserting that a stream whose tool input JSON is truncated
// completes with a usable tool call, that unrepairable input still throws
// MALFORMED_RESPONSE (host one-shot continue semantics unchanged), and that
// every successful repair reports exactly one telemetry event.
//
// Requires dsh-runtime/node_modules; skips cleanly when they are absent.
// Fails loudly when the node_modules exist but the patch is missing.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const runtimeDir = path.resolve(import.meta.dirname, '..', 'dsh-runtime')
const deepseekLib = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'package.json'))

const sseStream = (...events) =>
  events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n`).join('\n') + '\n'

const baseEvents = () => [
  ['message_start', {
    type: 'message_start',
    message: { id: 'msg_repair_1', type: 'message', role: 'assistant', model: 'mock-1', usage: { input_tokens: 8, output_tokens: 0 } },
  }],
]

const toolUseStream = (partialJson, { id = 'toolu_repair_1', name = 'write_file', stopReason = 'tool_use' } = {}) =>
  sseStream(
    ...baseEvents(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 16 } }],
    ['message_stop', { type: 'message_stop' }],
  )

const twoToolStream = () =>
  sseStream(
    ...baseEvents(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'write_file', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "/a", "content": "# par' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_b', name: 'bash', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "ls", "cwd": "/tm' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }],
    ['message_stop', { type: 'message_stop' }],
  )

const runStream = async ({ sse, repairs }) => {
  const deepseek = await import(deepseekLib)
  const connection = deepseek.resolveAdapterOptions({
    baseURL: 'http://127.0.0.1:9',
    models: [{ id: 'mock-1', contextWindow: 32768 }],
  })
  const adapter = new deepseek.DeepSeekAdapter({
    providerName: 'RepairTest',
    options: () => connection,
    resolveAuth: async () => ({ headers: { authorization: 'Bearer sk-repair-test' } }),
    resolveUserId: () => 'repair-test-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    onToolInputRepaired: (detail) => repairs.push(detail),
  })
  const events = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  try {
    for await (const event of adapter.stream({
      provider: 'repairgw',
      model: 'mock-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'please call the tool' }] }],
    })) {
      events.push(event)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  return events
}

const toolCallBlockEnd = (events, index) => {
  const blockEnd = events.find((event) => event.type === 'block-end' && event.index === index)
  assert.ok(blockEnd, `block-end for block ${index} arrived`)
  assert.equal(blockEnd.block.type, 'tool-call')
  return blockEnd.block
}

test('repair: truncated member tail is dropped, object closed, turn completes', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const repairs = []
  const events = await runStream({ sse: toolUseStream('{"command": "ls -la", "path": "/tmp/par'), repairs })
  const block = toolCallBlockEnd(events, 0)
  assert.deepEqual(JSON.parse(block.arguments), { command: 'ls -la' })
  const finish = events.find((event) => event.type === 'finish')
  assert.ok(finish, 'finish arrived (turn completes instead of erroring)')
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.equal(repairs.length, 1, 'exactly one repair telemetry event')
  assert.deepEqual(repairs[0], { model: 'mock-1', toolCallId: 'toolu_repair_1', toolName: 'write_file' })
})

test('repair: nested containers are closed after the last complete value', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const repairs = []
  const events = await runStream({ sse: toolUseStream('{"outer": {"a": 1, "b": [1, 2'), repairs })
  const block = toolCallBlockEnd(events, 0)
  assert.deepEqual(JSON.parse(block.arguments), { outer: { a: 1, b: [1] } })
  assert.equal(repairs.length, 1)
})

test('repair: one telemetry event per truncated tool call in a multi-block stream', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const repairs = []
  const events = await runStream({ sse: twoToolStream(), repairs })
  assert.deepEqual(JSON.parse(toolCallBlockEnd(events, 0).arguments), { path: '/a' })
  assert.deepEqual(JSON.parse(toolCallBlockEnd(events, 1).arguments), { command: 'ls' })
  assert.equal(events.filter((event) => event.type === 'finish').length, 1)
  assert.deepEqual(repairs, [
    { model: 'mock-1', toolCallId: 'toolu_a', toolName: 'write_file' },
    { model: 'mock-1', toolCallId: 'toolu_b', toolName: 'bash' },
  ])
})

test('repair: valid tool input passes through untouched with no repair event', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const repairs = []
  const events = await runStream({ sse: toolUseStream('{"command": "ls"}'), repairs })
  const block = toolCallBlockEnd(events, 0)
  assert.equal(block.arguments, '{"command": "ls"}')
  assert.equal(repairs.length, 0)
  assert.ok(events.some((event) => event.type === 'finish'), 'finish arrived')
})

test('no repair: sole member truncated still throws MALFORMED_RESPONSE', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const repairs = []
  await assert.rejects(
    runStream({ sse: toolUseStream('{"path": "/tmp/par'), repairs }),
    (error) => error?.code === 'MALFORMED_RESPONSE' && String(error?.message ?? '').includes('tool input is invalid JSON'),
  )
  assert.equal(repairs.length, 0, 'failed repairs are not reported as repairs')
})

test('no repair: top-level array that repairs to valid JSON still fails the object gate', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const repairs = []
  await assert.rejects(
    runStream({ sse: toolUseStream('[1, 2'), repairs }),
    (error) => error?.code === 'MALFORMED_RESPONSE',
  )
  assert.equal(repairs.length, 0)
})

test('no repair: genuinely malformed (non-truncation) input still throws MALFORMED_RESPONSE', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const repairs = []
  await assert.rejects(
    runStream({ sse: toolUseStream('{unquoted: 1'), repairs }),
    (error) => error?.code === 'MALFORMED_RESPONSE',
  )
  assert.equal(repairs.length, 0)
})
