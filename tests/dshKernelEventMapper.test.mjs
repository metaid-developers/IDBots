// M4 unit test: DshEventMapper turns recorded rc.6 wire envelopes into the
// same message/streaming/turn contract handleClaudeEvent produces.
// All fixtures are verbatim recorded shapes (M1-M3 wire traffic).

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const { DshEventMapper, innermostProviderMessage, compactionFailureContent } = require('../dist-electron/main/libs/dshKernel/dshEventMapper.js')
const { splitThinkTaggedContent } = require('../dist-electron/main/libs/dshKernel/thinkTags.js')
const { foldsToolRideTextIntoThinking } = require('../dist-electron/main/libs/dshModelReasoning.js')

const kinds = (actions) => actions.map((a) => a.kind)

test('user/message events map to nothing — the host records user bubbles', () => {
  const mapper = new DshEventMapper()
  // Human input, plugin runtime-context snapshots, and tool carries are all
  // model-facing facts; echoing them would duplicate the submission path's
  // own user messages (prompts and steers alike).
  for (const source of [{ kind: 'user' }, { kind: 'plugin', form: 'snapshot' }, { kind: 'tool', callId: 'c1' }]) {
    const actions = mapper.consume({
      type: 'user/message',
      seq: 4,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'x' }], source },
    })
    assert.deepEqual(actions, [])
  }
})

test('text deltas open a streaming slot and update with accumulated content', () => {
  const mapper = new DshEventMapper()
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'mock ' } },
  })
  assert.deepEqual(kinds(opened), ['message', 'messageUpdate'])
  assert.equal(opened[0].slot, 'text')
  assert.equal(opened[0].message.metadata.isStreaming, true)
  assert.equal(opened[1].content, 'mock ')

  const more = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'says' } },
  })
  assert.deepEqual(kinds(more), ['messageUpdate'])
  assert.equal(more[0].content, 'mock says')
})

test('reasoning deltas stream into a separate thinking slot', () => {
  const mapper = new DshEventMapper()
  const actions = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } },
  })
  assert.equal(actions[0].slot, 'thinking')
  assert.equal(actions[0].message.metadata.isThinking, true)
})

test('assistant/message finalizes open slots and reports usage with route', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'request/header', data: { header: { config: { provider: 'mockgw', model: 'mock-1' } } } })
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: 'hi' } } })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model' } },
      usage: { inputTokens: 11, outputTokens: 7 },
    },
  })
  assert.deepEqual(kinds(done), ['messageFinalize', 'usage'])
  assert.equal(done[0].slot, 'text')
  assert.equal(done[0].content, 'hi')
  assert.equal(done[1].usage.provider, 'mockgw')
  assert.equal(mapper.usage().inputTokens, 11)
})

test('tool call and result map to tool_use / tool_result messages', () => {
  const mapper = new DshEventMapper()
  const call = mapper.consume({
    type: 'tool/call',
    data: { turn: 2, step: 1, callId: 'call_spike_ping_1', name: 'spike_ping', arguments: '{"echo":"hi"}' },
  })
  assert.equal(call[0].message.type, 'tool_use')
  assert.equal(call[0].message.metadata.toolName, 'spike_ping')
  assert.deepEqual(call[0].message.metadata.toolInput, { echo: 'hi' })
  assert.equal(call[0].message.metadata.toolUseId, 'call_spike_ping_1')

  const result = mapper.consume({
    type: 'tool/result',
    data: {
      turn: 2, step: 1,
      message: {
        source: { kind: 'tool', callId: 'call_spike_ping_1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call_spike_ping_1',
          content: [{ type: 'text', text: '{"pong":"hi"}' }],
          isError: false,
        }],
      },
    },
  })
  assert.equal(result[0].message.type, 'tool_result')
  assert.equal(result[0].message.metadata.toolUseId, 'call_spike_ping_1')
  assert.equal(result[0].message.metadata.isError, false)
  assert.equal(result[0].message.content, '{"pong":"hi"}')
})

test('denied tool result keeps isError and surfaces the deny reason', () => {
  const mapper = new DshEventMapper()
  const result = mapper.consume({
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'the user rejected tool "dangerous_tool"' }],
          isError: true,
        }],
      },
    },
  })
  assert.equal(result[0].message.metadata.isError, true)
  assert.match(result[0].message.content, /rejected/)
})

test('turn/end maps with reason; aborted carries the cause', () => {
  const mapper = new DshEventMapper()
  const ended = mapper.consume({
    type: 'turn/end',
    data: { turn: 5, reason: { kind: 'aborted', reason: 'm1 wire cancel' } },
  })
  assert.deepEqual(kinds(ended), ['turnEnd'])
  assert.equal(ended[0].reason.kind, 'aborted')
  assert.equal(ended[0].reason.reason, 'm1 wire cancel')
})

test('empty terminal turn flags a clean stop with no text and no tool calls', () => {
  const mapper = new DshEventMapper()
  // The DeepSeek truncation signature: only reasoning deltas, then a clean stop.
  mapper.consume({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' } } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.kind, 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, true)
  const thinkingDone = ended.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(thinkingDone.content, 'thinking…')
})

test('turn/end with text output is not an empty terminal turn', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, undefined)
})

test('turn/end after tool calls is not an empty terminal turn', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  assert.equal(ended[0].emptyTerminal, undefined)
})

test('empty-terminal flags reset between turns', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } })
  mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  // Next turn produces nothing at all — still empty (reasoning-only or fully silent).
  const second = mapper.consume({ type: 'turn/end', data: { turn: 2, reason: { kind: 'stop' } } })
  assert.equal(second[0].emptyTerminal, true)
})

test('non-stop reasons never flag empty terminal', () => {
  const mapper = new DshEventMapper()
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
  assert.equal(ended[0].emptyTerminal, undefined)
})

test('assistant/message reasoning blocks become a thinking slot', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need to inspect git first' },
          { type: 'text', text: 'I will run git status.' },
        ],
      },
    },
  })
  assert.equal(done[0].slot, 'thinking')
  assert.equal(done[0].message.metadata.isThinking, true)
  assert.equal(done[1].slot, 'thinking')
  assert.equal(done[1].content, 'need to inspect git first')
  assert.equal(done[2].slot, 'text')
  assert.equal(done[3].content, 'I will run git status.')
})

test('text-delta think tags stream into the thinking slot and leave visible text', () => {
  const mapper = new DshEventMapper()
  const first = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '<think>plan it</think>hello' } },
  })
  assert.equal(first[0].slot, 'thinking')
  assert.equal(first[0].message.metadata.isThinking, true)
  assert.equal(first[1].content, 'plan it')
  assert.equal(first[2].slot, 'text')
  assert.equal(first[3].content, 'hello')

  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, undefined)
})

test('think-tag-only text-delta is an empty terminal turn (reasoning, no reply)', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '<think>still figuring it out</think>' } },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, true)
})

test('block-start reasoning opens the thinking slot before deltas arrive', () => {
  const mapper = new DshEventMapper()
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  assert.equal(opened[0].slot, 'thinking')
  assert.equal(opened[0].message.metadata.isThinking, true)
})

// ---- DeepSeek Responses phase classification ------------------------------
// Text items arrive tagged commentary (thinking out loud around tool calls)
// or final_answer (the visible reply); the tag rides the assembled replay
// state only — content blocks and streaming deltas carry no phase.

const sig = (phase) => JSON.stringify({ v: 1, id: 'msg_1', phase })

test('streamed commentary text converts the text message into thinking at finalize', () => {
  const mapper = new DshEventMapper()
  // Commentary streams as plain text (phase unknown on the wire mid-stream).
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '让我先查一下配置。' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 3, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '让我先查一下配置。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
        source: {
          kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash',
          replayState: { kind: 'pi-ai', version: 1, api: 'openai-responses', blocks: [
            { type: 'text', textSignature: sig('commentary') },
            { type: 'tool-call' },
          ] },
        },
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize')
  assert.equal(finalize.slot, 'text')
  assert.equal(finalize.content, '让我先查一下配置。')
  assert.equal(finalize.metadata.isThinking, true, 'streamed text message reclassifies to thinking')
  // A commentary-only step followed by its tool call must not look empty.
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: 'cancel' } } })
  assert.equal(ended[0].kind, 'turnEnd')
})

test('final_answer text stays visible (no thinking metadata)', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 4, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Here is the result.' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 4, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the result.' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text', textSignature: sig('final_answer') }] } },
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize')
  assert.equal(finalize.slot, 'text')
  assert.equal(finalize.content, 'Here is the result.')
  assert.equal(finalize.metadata, undefined)
})

test('a turn whose only output is commentary is an empty terminal turn', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 5, step: 1, chunk: { type: 'text-delta', index: 0, text: '考虑一下该怎么回答……' } },
  })
  mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 5, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '考虑一下该怎么回答……' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text', textSignature: sig('commentary') }] } },
      },
    },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 5, reason: { kind: 'stop' } } })
  // Commentary reclassified as thinking → nothing visible → the auto-continue
  // guard must fire instead of reporting a hollow completed turn.
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, true)
})

test('unassembled commentary (block-end only) opens a thinking message', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 6, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Thinking out loud without any streamed deltas.' },
          { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', replayState: { blocks: [
          { type: 'text', textSignature: sig('commentary') },
          { type: 'tool-call' },
        ] } },
      },
    },
  })
  // No text slot was streamed, so commentary materializes as a thinking
  // message. Per-round Think rows: the round's commentary finalizes SETTLED at
  // assistant/message so the next round opens its own row below the tool rows.
  const opened = done.find((a) => a.kind === 'message')
  assert.equal(opened.slot, 'thinking')
  assert.equal(opened.message.metadata.isThinking, true)
  const settled = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(settled.content, 'Thinking out loud without any streamed deltas.')
})

test('mixed commentary and final text split across slots in order', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 7, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First, deliberation.' },
          { type: 'text', text: 'The final answer.' },
        ],
        source: { kind: 'model', replayState: { blocks: [
          { type: 'text', textSignature: sig('commentary') },
          { type: 'text', textSignature: sig('final_answer') },
        ] } },
      },
    },
  })
  const thinking = done.filter((a) => a.slot === 'thinking').find((a) => a.kind === 'messageFinalize')
  assert.equal(thinking.content, 'First, deliberation.')
  const textFinal = done.filter((a) => a.slot === 'text').find((a) => a.kind === 'messageFinalize')
  assert.equal(textFinal.content, 'The final answer.')
  assert.equal(textFinal.metadata, undefined)
})

test('unsigned replay signatures keep the legacy all-visible classification', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 8, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'plain visible reply' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text' }] } },
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize')
  assert.equal(finalize.slot, 'text')
  assert.equal(finalize.content, 'plain visible reply')
  assert.equal(finalize.metadata, undefined)
})

test('native DeepSeek tool-step text folds into thinking and does not open a visible bubble', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: 'need a tool' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need a tool' },
          { type: 'text', text: '本地没装 tsx，用 npx 临时拉一个跑（不碰 package.json）：' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false, 'commentary must not become a visible bubble')
  // Per-round Think row: this step's reasoning + commentary finalizes settled.
  const settled = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.match(settled.content, /need a tool/)
  assert.match(settled.content, /本地没装 tsx/)
})

test('native DeepSeek finalizes one Think row per tool round (interleaved timeline)', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: 'first plan' } },
  })
  const step1 = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'first plan' },
          { type: 'text', text: '先看仓库结构。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  // Round 1 settles its own Think row with this step's reasoning + commentary.
  const row1 = step1.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.match(row1.content, /first plan/)
  assert.match(row1.content, /先看仓库结构/)

  // Round 2 reasoning opens a FRESH Think row (new message, no round-1 prefix)
  // after the tool rows, restoring the think → tools → think interleaving.
  const step2open = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: ' next' } },
  })
  const opened2 = step2open.find((a) => a.kind === 'message' && a.slot === 'thinking')
  assert.notEqual(opened2, undefined, 'round 2 must open a fresh thinking message')
  const update2 = step2open.find((a) => a.kind === 'messageUpdate')
  assert.equal(update2.content, ' next')
  assert.equal(update2.content.includes('first plan'), false, 'fresh row carries no earlier rounds')

  const step2 = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'next' },
          { type: 'text', text: '继续读安装器。' },
          { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
        ],
      },
    },
  })
  const row2 = step2.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(row2.content, 'next\n\n继续读安装器。')

  const reply = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'ready to answer' },
          { type: 'text', text: '## 本轮测试汇总' },
        ],
      },
    },
  })
  // The reply step's reasoning gets its own settled Think row, then the reply.
  const row3 = reply.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(row3.content, 'ready to answer')
  const textDone = reply.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(textDone.content, '## 本轮测试汇总')
  assert.equal(textDone.metadata, undefined)
})

test('reasoning-chunks is dead vocabulary post-0.1.5; live reasoning streams via assistant/chunk deltas', () => {
  const mapper = new DshEventMapper()
  // DSH 0.1.5 deleted the v0 packed chunk rows (187c31e2), so these envelopes
  // no longer exist on the wire and the mapper drops them.
  const dead = mapper.consume({
    type: 'reasoning-chunks',
    data: { turn: 1, step: 1, index: 0, texts: ['The', ' user', ' wants'] },
  })
  assert.deepEqual(dead, [])

  // The DSH web stream now arrives through the bridged assistant/chunk feed:
  // a native reasoning block opens the thinking slot, deltas accumulate there.
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  const first = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'The user wants' } },
  })
  assert.equal(first.some((a) => a.kind === 'message' && a.slot === 'thinking'), false, 'block-start already opened the slot')
  assert.equal(first[0].kind, 'messageUpdate')
  assert.equal(first[0].slot, 'thinking')
  assert.equal(first[0].content, 'The user wants')

  const more = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: ' a tool' } },
  })
  assert.equal(more[0].content, 'The user wants a tool')
})

test('text-delta after a native reasoning block does not open a body bubble', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  const leaked = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: '本地没装 tsx，用 npx 临时拉一个跑：' } },
  })
  assert.equal(leaked.some((a) => a.slot === 'text'), false)
})

test('compaction/summary maps to a structured checkpoint stub — summary text stays out of the transcript', () => {
  const mapper = new DshEventMapper()
  const actions = mapper.consume({
    type: 'compaction/summary',
    data: {
      summary: [{ type: 'text', text: 'Earlier turns discussed the install path.' }],
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 420,
    },
  })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'message')
  assert.equal(actions[0].message.type, 'system')
  assert.equal(actions[0].message.metadata.compaction, true)
  assert.equal(actions[0].message.metadata.compactedItems, 3)
  assert.equal(actions[0].message.metadata.compactedTokens, 420)
  // The summary is the kernel's LLM context, not chat content — it must not
  // leak into the stored transcript body.
  assert.equal(actions[0].message.content, '')
})

test('compaction/start is silent; compaction/end only reports failures', () => {
  const mapper = new DshEventMapper()
  assert.deepEqual(mapper.consume({ type: 'compaction/start', data: { turn: null } }), [])
  assert.deepEqual(mapper.consume({ type: 'compaction/end', data: { turn: null } }), [])
  const failed = mapper.consume({
    type: 'compaction/end',
    data: { turn: null, error: 'summary unavailable' },
  })
  assert.equal(failed[0].message.type, 'system')
  assert.equal(failed[0].message.metadata.isError, true)
  assert.match(failed[0].message.content, /Compaction failed: summary unavailable/)
})

test('a context-overflow compaction failure renders a readable line instead of the raw gateway JSON', () => {
  const mapper = new DshEventMapper()
  // Verbatim Command Code gateway 400 from session cw-2c70849f (turn 182).
  const gateway400 = '400: {"message":"{\\"error\\":{\\"message\\":\\"The prompt exceeds the context window this endpoint can start from. Compact the conversation and retry.\\",\\"type\\":\\"invalid_request_error\\",\\"param\\":\\"messages\\",\\"code\\":\\"context_length_exceeded\\"}}","type":"invalid_request_error"}'
  const failed = mapper.consume({
    type: 'compaction/end',
    data: { turn: null, error: gateway400 },
  })
  const content = failed[0].message.content
  assert.equal(failed[0].message.metadata.isError, true)
  assert.ok(!content.includes('400: {"message"'), content)
  assert.ok(/压缩失败|the compaction request itself exceeded/i.test(content), content)
  // The provider's own wording stays visible for support/diagnosis.
  assert.ok(content.includes('The prompt exceeds the context window this endpoint can start from'), content)
})

test('innermostProviderMessage unwraps nested gateway JSON and passes plain text through', () => {
  const nested = '400: {"message":"{\\"error\\":{\\"message\\":\\"inner provider text\\",\\"code\\":\\"context_length_exceeded\\"}}"}'
  assert.equal(innermostProviderMessage(nested), 'inner provider text')
  assert.equal(innermostProviderMessage('summary unavailable'), 'summary unavailable')
  assert.equal(innermostProviderMessage('400: {"message":"plain single layer"}'), 'plain single layer')
})

test('compactionFailureContent keeps the raw prefix for non-overflow failures', () => {
  assert.equal(compactionFailureContent('summary unavailable'), 'Compaction failed: summary unavailable')
})

// ---- Effort-"off" tool-call commentary (reasoning-disabled route) ---------
// With thinking disabled, native DeepSeek has no reasoning channel: text that
// rides alongside tool calls is the only process text. It streams as ordinary
// text until the tool-call block starts, then must fold into the thinking
// display immediately (not at assistant/message finalize — that late fold is
// the "thinking flashes as body copy, then retracts into a Think row" bug).

test('off-mode commentary converts at block-start tool-call and streams as thinking', () => {
  const mapper = new DshEventMapper()
  // Commentary starts as an optimistic body bubble (it may yet prove to be
  // the reply)…
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '现在' } },
  })
  assert.deepEqual(kinds(opened), ['message', 'messageUpdate'])
  assert.equal(opened[0].slot, 'text')

  // …the tool-call block-start is the earliest proof it is commentary.
  const converted = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  assert.deepEqual(kinds(converted), ['messageFinalize'])
  assert.equal(converted[0].slot, 'text')
  assert.equal(converted[0].content, '现在')
  assert.equal(converted[0].metadata.isThinking, true)
  assert.equal(converted[0].metadata.isStreaming, true, 'converted bubble keeps the streaming pulse')

  // Remaining deltas of the round stream into the SAME message (text slot id).
  const more = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '查一下' } },
  })
  assert.deepEqual(kinds(more), ['messageUpdate'])
  assert.equal(more[0].slot, 'text')
  assert.equal(more[0].content, '现在查一下')

  // Round finalize: assembled text is authoritative; the round's Think row
  // settles (no isStreaming) so the next round opens its own row.
  const round1 = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '现在查一下' },
          { type: 'tool-call', id: 'c1', name: 'search_metaweb', arguments: '{}' },
        ],
      },
    },
  })
  const ride1 = round1.find((a) => a.kind === 'messageFinalize')
  assert.equal(ride1.slot, 'text')
  assert.equal(ride1.content, '现在查一下')
  assert.equal(ride1.metadata.isThinking, true)
  assert.equal(ride1.metadata.isStreaming, undefined, 'round 1 settles its own Think row')
  assert.equal(round1.some((a) => a.kind === 'message' && a.slot === 'thinking'), false, 'no second Think bubble')

  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'search_metaweb', arguments: '{}' } })

  // Round 2 commentary opens a FRESH optimistic bubble (the ride settled, so
  // nothing is held)…
  const opened2 = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: '继续读' } },
  })
  assert.deepEqual(kinds(opened2), ['message', 'messageUpdate'])
  assert.equal(opened2[0].slot, 'text')
  // …and its own tool-call block-start converts it into round 2's Think row.
  const converted2 = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 2, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  assert.deepEqual(kinds(converted2), ['messageFinalize'])
  assert.equal(converted2[0].slot, 'text')
  assert.equal(converted2[0].content, '继续读')
  assert.equal(converted2[0].metadata.isThinking, true)

  const round2 = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 2,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '继续读。' },
          { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  const ride2 = round2.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(ride2.content, '继续读。')
  assert.equal(ride2.metadata.isStreaming, undefined, 'round 2 settles its own Think row')

  // The pure reply lands as its own visible bubble…
  const reply = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 3,
      message: { role: 'assistant', content: [{ type: 'text', text: '## 汇总' }] },
    },
  })
  const settles = reply.filter((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(settles.length, 1, 'only the reply bubble finalizes')
  assert.equal(settles[0].content, '## 汇总')
  assert.equal(settles[0].metadata, undefined, 'the reply is plain visible text')

  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, undefined)
  assert.equal(ended.some((a) => a.kind === 'messageFinalize'), false, 'nothing left to close')
})

test('off-mode turn aborted mid-round settles the converted thinking display', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '让我' } },
  })
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'cancel' } } })
  const settled = ended.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(settled.content, '让我')
  assert.equal(settled.metadata.isThinking, true)
  assert.equal(settled.metadata.isStreaming, undefined, 'isStreaming cannot stick across the abort')
  assert.equal(ended.some((a) => a.kind === 'turnEnd'), true)
})

test('block-start tool-call without streaming text converts nothing', () => {
  const mapper = new DshEventMapper()
  const actions = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
  })
  assert.deepEqual(actions, [])
})

test('conversion is skipped while a native reasoning block keeps text held', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } })
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: 'plan' } } })
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: '先看仓库。' } } })
  const atTool = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } },
  })
  assert.deepEqual(atTool, [])
})

test('tool-call-chunks is dead vocabulary post-0.1.5; block-start tool-call triggers the conversion', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '先看' } },
  })
  // The packed tool-call-chunks row went away with DSH 0.1.5 (187c31e2): the
  // envelope is inert now.
  const dead = mapper.consume({
    type: 'tool-call-chunks',
    data: { turn: 1, step: 1, index: 1, id: 'call_1', name: 'bash', args: [''] },
  })
  assert.deepEqual(dead, [])
  // The conversion still fires through the bridged assistant/chunk feed.
  const converted = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  const finalize = converted.find((a) => a.kind === 'messageFinalize')
  assert.equal(finalize.slot, 'text')
  assert.equal(finalize.content, '先看')
  assert.equal(finalize.metadata.isThinking, true)
})

test('fallback: commentary with no block-start signal still folds at finalize', () => {
  const mapper = new DshEventMapper()
  // Route that never emits block-start tool-call chunks: the pre-fix behavior
  // (fold at assistant/message) remains as the safety net.
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '本地没装 tsx，用 npx 跑：' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '本地没装 tsx，用 npx 跑：' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(finalize.content, '本地没装 tsx，用 npx 跑：')
  assert.equal(finalize.metadata.isThinking, true)
})

test('splitThinkTaggedContent extracts think and thinking tags', () => {
  assert.deepEqual(splitThinkTaggedContent('plain reply'), { thinking: '', text: 'plain reply' })
  assert.deepEqual(
    splitThinkTaggedContent('<think>plan</think>answer'),
    { thinking: 'plan', text: 'answer' },
  )
  assert.deepEqual(
    splitThinkTaggedContent('<thinking>plan</thinking>\nanswer'),
    { thinking: 'plan', text: '\nanswer' },
  )
  assert.deepEqual(
    splitThinkTaggedContent('<think>unclosed'),
    { thinking: 'unclosed', text: '' },
  )
})

// ---- Family gating: GLM keeps tool-ride text visible ----------------------
// The narration fold (text riding a tool call → thinking display) is a
// DeepSeek-family dialect trait. GLM puts its process text in the reasoning
// channel, so text riding a tool call is CONTENT: the 2026-09-25 gas-pool
// incident had glm-5.3-flash emit the complete daily report as a text block
// next to a todo_write call, and the fold hid it twice behind a one-line
// summary the user mistook for the whole delivery.

const glmHeader = (mapper) => mapper.consume({
  type: 'request/header',
  data: { header: { config: { provider: 'zhipu', model: 'glm-5.3-flash' } } },
})

test('foldsToolRideTextIntoThinking: GLM never folds; DeepSeek and unknown keep the fold', () => {
  assert.equal(foldsToolRideTextIntoThinking('glm-5.3-flash'), false)
  assert.equal(foldsToolRideTextIntoThinking('GLM-5.3-Flash'), false)
  assert.equal(foldsToolRideTextIntoThinking('z-ai/glm-4.6'), false)
  assert.equal(foldsToolRideTextIntoThinking('glm-4.5-air'), false)
  assert.equal(foldsToolRideTextIntoThinking('deepseek-v4.1-flash'), true)
  assert.equal(foldsToolRideTextIntoThinking('deepseek/deepseek-flash'), true)
  assert.equal(foldsToolRideTextIntoThinking('brand-new-model'), true)
  assert.equal(foldsToolRideTextIntoThinking(undefined), true)
})

test('GLM: reasoning + deliverable text + tool call keeps the text visible', () => {
  const mapper = new DshEventMapper()
  glmHeader(mapper)
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: 'all data collected' } } })
  // Text streams visibly while a native reasoning block is live (Claude-path
  // parity — the hold is a narration-fold-route concern only).
  const streamed = mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: '# 巡检报告' } } })
  assert.equal(streamed.some((a) => a.slot === 'text'), true)

  // A tool-call block-start must NOT convert the streaming text to thinking.
  const atTool = mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } } })
  assert.deepEqual(atTool, [])

  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'all data collected' },
          { type: 'text', text: '# 巡检报告' },
          { type: 'tool-call', id: 'c1', name: 'todo_write', arguments: '{}' },
        ],
      },
    },
  })
  const textFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(textFinal.content, '# 巡检报告')
  assert.equal(textFinal.metadata, undefined, 'the deliverable stays visible — no isThinking reclass')
  const thinkFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(thinkFinal.content, 'all data collected', 'the Think row carries reasoning only')
})

test('GLM: unassembled report next to a tool call still finalizes visible', () => {
  // No streamed chunks — the assembled assistant/message alone proves the shape
  // recorded in the 2026-09-25 incident (reasoning + 4.6k-char report + tool call).
  const mapper = new DshEventMapper()
  glmHeader(mapper)
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '两路数据都已到齐。' },
          { type: 'text', text: '# 《MVC Subsidy / Sponsor 资金池巡检报告》' },
          { type: 'tool-call', id: 'c1', name: 'todo_write', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text' && a.kind === 'messageFinalize' && a.metadata?.isThinking), false)
  const textFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(textFinal.content, '# 《MVC Subsidy / Sponsor 资金池巡检报告》')
  const thinkFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(thinkFinal.content, '两路数据都已到齐。')
})

test('GLM (effort off): text before a tool call stays a visible bubble', () => {
  const mapper = new DshEventMapper()
  glmHeader(mapper)
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '先看仓库结构。' } },
  })
  assert.equal(opened[0].slot, 'text')
  const atTool = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  assert.deepEqual(atTool, [], 'no conversion to thinking on GLM routes')
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先看仓库结构。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  const textFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(textFinal.content, '先看仓库结构。')
  assert.equal(textFinal.metadata, undefined)
})

test('explicit DeepSeek route keeps the narration fold', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' } } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need a tool' },
          { type: 'text', text: '本地没装 tsx，用 npx 临时拉一个跑：' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false, 'DeepSeek commentary still never becomes a visible bubble')
  const settled = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.match(settled.content, /need a tool/)
  assert.match(settled.content, /本地没装 tsx/)
})

// ---- Assistant chat-experience mode: one visibility policy for every family
// Tool-ride commentary folds into the hidden thinking display on DeepSeek,
// GLM and unknown routes — no mapper action ever carries metadata.narration.
// The bounded post-reasoning hold applies even on effort-off/no-reasoning
// steps; text past the window may stream as a possible final answer, and a
// subsequent tool call folds it back. Visible progress bubbles are minted
// host-side by explicit owner_update({ message, kind }) calls (coworkRunner
// emitAssistantOwnerUpdate, capped per turn — see
// coworkAssistantOwnerUpdate.test.mjs); the mapper-side contract pinned here
// is that ordinary commentary never becomes one.

const assistantMapper = () => new DshEventMapper({ assistantMode: () => true })

test('assistant mode: short streamed commentary stays held and folds silently into the thinking row', () => {
  const mapper = assistantMapper()
  // Phase-tagged commentary (DeepSeek Responses): under the hold window the
  // text opens NO body bubble — assistant mode gates short text exactly like
  // post-reasoning commentary instead of streaming it optimistically.
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '让我先查一下配置。' } },
  })
  assert.deepEqual(opened, [], 'short commentary opens no visible slot in assistant mode')

  // The tool-call block-start arrives with nothing held open: no conversion,
  // no retraction — the fold completes silently at assistant/message.
  const atTool = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 3, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  assert.deepEqual(atTool, [])

  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 3, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '让我先查一下配置。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
        source: {
          kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash',
          replayState: { kind: 'pi-ai', version: 1, api: 'openai-responses', blocks: [
            { type: 'text', textSignature: sig('commentary') },
            { type: 'tool-call' },
          ] },
        },
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false, 'no visible bubble ever opened')
  const thinking = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(thinking.content, '让我先查一下配置。', 'commentary settles into the hidden Think row')
  assert.equal(thinking.metadata, undefined)
  assert.equal(done.some((a) => a.message?.metadata?.narration === true), false, 'the mapper never mints narration rows')

  // A commentary-only step followed by its tool call must not look empty.
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: 'cancel' } } })
  assert.equal(ended[0].kind, 'turnEnd')
})

test('assistant mode: held commentary folds into the reasoning round\'s Think row — no separate narration message', () => {
  const mapper = assistantMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  const streamed = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: 'need a tool' } },
  })
  assert.equal(streamed[0].slot, 'thinking')

  // Live reasoning holds the riding text until the assembled message
  // classifies it (native DeepSeek, no phase tags): commentary joins the
  // round's reasoning in ONE settled Think row — exactly the professional-
  // mode fold. Assistant mode mints no separate narration message.
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need a tool' },
          { type: 'text', text: '本地没装 tsx，用 npx 临时拉一个跑：' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  const thinkFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(thinkFinal.content, 'need a tool\n\n本地没装 tsx，用 npx 临时拉一个跑：', 'reasoning + commentary share one settled Think row')
  assert.equal(done.some((a) => a.slot === 'text'), false, 'held commentary never opens a visible stream placeholder')
  assert.equal(done.some((a) => a.message?.metadata?.narration === true), false, 'the mapper never mints narration rows')
})

test('assistant mode: final_answer stays a plain bubble without the narration tag', () => {
  const mapper = assistantMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 4, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Here is the result.' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 4, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the result.' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text', textSignature: sig('final_answer') }] } },
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(finalize.content, 'Here is the result.')
  assert.equal(finalize.metadata, undefined)
})

test('assistant mode: unassembled mixed commentary + final_answer splits into a Think row then a plain reply', () => {
  const mapper = assistantMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 7, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First, deliberation.' },
          { type: 'text', text: 'The final answer.' },
        ],
        source: { kind: 'model', replayState: { blocks: [
          { type: 'text', textSignature: sig('commentary') },
          { type: 'text', textSignature: sig('final_answer') },
        ] } },
      },
    },
  })
  const thinking = done.filter((a) => a.slot === 'thinking').find((a) => a.kind === 'messageFinalize')
  assert.equal(thinking.content, 'First, deliberation.', 'commentary is thinking here, not a narration bubble')
  const textFinal = done.filter((a) => a.slot === 'text').find((a) => a.kind === 'messageFinalize')
  assert.equal(textFinal.content, 'The final answer.')
  assert.equal(textFinal.metadata, undefined, 'the reply is plain visible text')
  assert.equal(done.some((a) => a.message?.metadata?.narration === true), false, 'the mapper never mints narration rows')
})

test('assistant mode: long effort-off text streams as a possible final answer and a tool call folds it back', () => {
  const mapper = assistantMapper()
  // Assistant mode applies the hold window even with no reasoning block, so
  // the length check alone is what lets a genuinely long answer stream
  // early — the exact professional wrong-bet contract, one guard earlier.
  const longText = `我来处理这个排查请求。${'先从任务来源开始逐层说明。'.repeat(40)}`
  assert.ok(longText.length >= 160, 'fixture must exceed the hold window')
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: longText } },
  })
  assert.deepEqual(kinds(opened), ['message', 'messageUpdate'], 'past the window the possible answer streams')
  assert.equal(opened[0].slot, 'text')

  // The tool call proves the bet wrong: the bubble folds into the thinking
  // display in place (the effort-off conversion — no thinking slot is live
  // to retract into), keeping the streamed buffer verbatim.
  const atTool = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  const converted = atTool.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(converted.content, longText, 'the fold keeps the text the user watched stream')
  assert.equal(converted.metadata.isThinking, true)
  assert.equal(converted.metadata.isStreaming, true, 'the converted display keeps the streaming pulse')
  assert.equal(converted.metadata.narration, undefined, 'no narration mark — this is the professional-mode conversion')

  const settled = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: longText },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  const ride = settled.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(ride.content, longText)
  assert.equal(ride.metadata.isThinking, true)
  assert.equal(ride.metadata.isStreaming, undefined, 'the round settles its own Think row')
  assert.equal(settled.some((a) => a.kind === 'message' && a.slot === 'thinking'), false, 'no second Think bubble')
})

test('assistant mode: a turn whose only output is commentary is still an empty terminal turn', () => {
  const mapper = assistantMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 5, step: 1, chunk: { type: 'text-delta', index: 0, text: '考虑一下该怎么回答……' } },
  })
  mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 5, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '考虑一下该怎么回答……' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text', textSignature: sig('commentary') }] } },
      },
    },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 5, reason: { kind: 'stop' } } })
  // Folded commentary is process text, not the reply: the auto-continue
  // guard must still fire, exactly as in professional mode.
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, true)
})

test('assistant mode: a turn aborted mid possible-answer stream settles the bubble plain', () => {
  const mapper = assistantMapper()
  // Whatever streamed past the window was a POSSIBLE final answer, so the
  // abort settles it as plain visible text — never with a narration mark.
  const longText = `正在整理最终结论。${'补充一些细节。'.repeat(40)}`
  assert.ok(longText.length >= 160, 'fixture must exceed the hold window')
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: longText } },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'cancel' } } })
  const settled = ended.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(settled.content, longText, 'the streamed buffer settles verbatim at the abort')
  assert.equal(settled.metadata, undefined, 'plain visible text — the mapper never tags narration')
  assert.equal(ended.some((a) => a.kind === 'turnEnd'), true)
})

test('assistant mode: short GLM tool-ride commentary stays hidden and is not promoted at turn end', () => {
  const mapper = assistantMapper()
  glmHeader(mapper)
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '先看仓库结构。' } },
  })
  const atTool = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  assert.deepEqual(atTool, [], 'short GLM commentary is held like every other family')
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先看仓库结构。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false)
  assert.match(done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking').content, /先看仓库结构/)
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  assert.equal(ended.some((a) => a.slot === 'text'), false, 'a short process note never becomes the final answer')
})

test('assistant mode: a substantive GLM deliverable beside the terminal tool call enters finalizing with the full report as fallback', () => {
  const mapper = assistantMapper()
  glmHeader(mapper)
  const report = `## 汇总\n${'完整交付与验证结果。'.repeat(30)}`
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'deliver and record completion' },
          { type: 'text', text: report },
          { type: 'tool-call', id: 'c1', name: 'todo_write', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false, 'the candidate is not emitted beside the tool call')
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'todo_write', arguments: '{}' } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.finalizationRequired, true)
  assert.equal(turnEnd.fallbackFinalText, report)
  assert.equal(ended.some((a) => a.kind === 'messageFinalize' && a.slot === 'text'), false, 'no partial answer is published before finalizing')
})

test('assistant mode: a complete answer followed by a tool and a short addendum finalizes from the full candidate', () => {
  const mapper = assistantMapper()
  const fullAnswer = `**找到了，本机已经有可复用的文件。**${'包含直接回答、验证结果、限制和下一步。'.repeat(12)}`
  mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: fullAnswer },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  const addendum = mapper.consume({
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '权限已收紧。接下来还需要你提供编号。' }] } },
  })
  assert.equal(addendum.some((a) => a.kind === 'messageFinalize' && a.slot === 'text' && a.content), false, 'the short addendum cannot displace the complete answer')
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.finalizationRequired, true)
  assert.equal(turnEnd.fallbackFinalText, fullAnswer)
})

test('assistant mode: a DeepSeek final_answer phase beside tools is still a finalization candidate, not an immediate reply', () => {
  const mapper = assistantMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '阿码的收尾切片交付了。拉回执并验关键面。' },
          { type: 'tool-call', id: 'c1', name: 'twin_task_status', arguments: '{}' },
        ],
        source: {
          kind: 'model', provider: 'deepseek', model: 'deepseek-flash',
          replayState: { kind: 'pi-ai', version: 1, api: 'openai-responses', blocks: [
            { type: 'text', textSignature: sig('final_answer') },
            { type: 'tool-call' },
          ] },
        },
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false)
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'twin_task_status', arguments: '{}' } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.finalizationRequired, true)
  assert.equal(turnEnd.fallbackFinalText, undefined)
})

test('assistant mode: twenty GLM commentary rounds produce only the final answer', () => {
  const mapper = assistantMapper()
  glmHeader(mapper)
  const allActions = []
  for (let round = 1; round <= 20; round += 1) {
    const commentary = `第 ${round} 轮：内部检索和核对已完成。`
    allActions.push(...mapper.consume({
      type: 'assistant/chunk',
      data: { turn: 1, step: round, chunk: { type: 'text-delta', index: 0, text: commentary } },
    }))
    allActions.push(...mapper.consume({
      type: 'assistant/chunk',
      data: { turn: 1, step: round, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
    }))
    mapper.consume({ type: 'tool/call', data: { callId: `c${round}`, name: 'bash', arguments: '{}' } })
    allActions.push(...mapper.consume({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: round,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: commentary },
            { type: 'tool-call', id: `c${round}`, name: 'bash', arguments: '{}' },
          ],
        },
      },
    }))
  }
  assert.equal(allActions.some((a) => a.slot === 'text'), false, 'no GLM process round opens a visible text slot')
  const final = mapper.consume({
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '## 汇总\n全部完成。' }] } },
  })
  const textFinal = final.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(textFinal.content, '## 汇总\n全部完成。')
})

test('the assistant-mode getter is evaluated per decision (a mid-stream flip degrades to professional streaming)', () => {
  let assistant = true
  const mapper = new DshEventMapper({ assistantMode: () => assistant })
  // Short effort-off text: assistant mode holds it inside the window…
  const held = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '先看配置。' } },
  })
  assert.deepEqual(held, [], 'assistant mode holds short text — no bubble opens')
  // …the user flips to professional mode mid-step: the SAME in-flight stream
  // now behaves professionally (effort-off text streams immediately), proving
  // the getter is re-evaluated at every stream decision, never cached at
  // step or turn start.
  assistant = false
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '继续查。' } },
  })
  assert.deepEqual(kinds(opened), ['message', 'messageUpdate'], 'professional mode opens the bubble on the very next delta')
  assert.equal(opened[0].slot, 'text')
  assert.equal(opened[1].content, '先看配置。继续查。', 'the bubble carries the accumulated in-flight buffer')
  const atTool = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
  })
  const converted = atTool.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(converted.metadata.isThinking, true, 'the professional-mode conversion then folds the commentary')
  assert.equal(converted.metadata.narration, undefined)
})

test('assistant mode: twenty DeepSeek commentary rounds mint no narration rows and the final answer stays plain', () => {
  // 2026-10-24 session 2c70849f follow-up: the old design minted one
  // narration bubble per tool round — 20 progress bubbles in a single turn.
  // Every model family folds commentary into the hidden thinking display;
  // NO mapper action may ever carry
  // metadata.narration (visible progress is minted host-side by explicit
  // owner_update calls, see coworkAssistantOwnerUpdate.test.mjs), and the
  // final answer settles as plain visible text. Simulates the kernel's slot
  // bookkeeping so each message action gets a distinct id and a later
  // finalize cannot rewrite an earlier row — the same harness as the
  // acceptance-report regression this replaces.
  const mapper = assistantMapper()
  const messages = new Map()
  const slotIds = {}
  let nextId = 1
  const rewrites = []
  const apply = (action) => {
    if (action.kind === 'message') {
      const id = `m${nextId++}`
      messages.set(id, { content: action.message.content, metadata: { ...(action.message.metadata ?? {}) } })
      if (action.slot) slotIds[action.slot] = id
      return
    }
    if (action.kind === 'messageUpdate' || action.kind === 'messageFinalize') {
      const id = slotIds[action.slot]
      if (!id) return
      const msg = messages.get(id)
      if (msg && action.kind === 'messageFinalize' && msg.content && action.content !== msg.content) {
        rewrites.push({ id, before: msg.content, after: action.content })
      }
      if (msg) {
        msg.content = action.content
        if (action.metadata) msg.metadata = { ...msg.metadata, ...action.metadata }
      }
    }
  }
  const allActions = []
  const consume = (envelope) => {
    const actions = mapper.consume(envelope)
    allActions.push(...actions)
    for (const action of actions) apply(action)
    return actions
  }

  // Twenty tool rounds, each emitting one short internal commentary line —
  // the exact shape that produced 20 visible progress bubbles under the old
  // narration design (effort-off native DeepSeek: text streams, the
  // tool-call block-start marks the round, the assembled message repeats it).
  const commentaryOf = (round) => `第 ${round} 轮：内部检索和核对已完成。`
  for (let round = 1; round <= 20; round += 1) {
    consume({ type: 'assistant/chunk', data: { turn: 1, step: round, chunk: { type: 'text-delta', index: 0, text: commentaryOf(round) } } })
    consume({ type: 'assistant/chunk', data: { turn: 1, step: round, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } } })
    consume({ type: 'tool/call', data: { callId: `c${round}`, name: 'bash', arguments: '{}' } })
    consume({ type: 'tool/result', data: { message: { toolCallId: `c${round}`, isError: false, content: [{ type: 'text', text: 'ok' }] } } })
    const done = consume({
      type: 'assistant/message',
      data: {
        turn: 1, step: round,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: commentaryOf(round) },
            { type: 'tool-call', id: `c${round}`, name: 'bash', arguments: '{}' },
          ],
        },
      },
    })
    const settled = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
    assert.ok(settled, `round ${round} settles its own Think row`)
    assert.ok(settled.content.includes(commentaryOf(round)), `round ${round}'s commentary folds into the hidden Think row`)
  }

  // Across all twenty rounds: no visible text slot EVER opens…
  assert.equal(allActions.some((a) => a.slot === 'text'), false, 'short commentary never opens a visible text slot in assistant mode')
  // …and no mapper action mints a narration row.
  assert.equal(
    allActions.some((a) => (a.message?.metadata?.narration ?? a.metadata?.narration) === true),
    false,
    'no mapper narration rows — visible progress is host-minted via owner_update',
  )

  // The final answer materializes whole at assistant/message (short replies
  // need no stream) and settles plain — no fold, no narration tag.
  const report = '## 汇总\n全部完成。'
  const reply = consume({
    type: 'assistant/message',
    data: { turn: 1, step: 21, message: { role: 'assistant', content: [{ type: 'text', text: report }] } },
  })
  const textFinal = reply.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(textFinal.content, report)
  assert.equal(textFinal.metadata, undefined, 'the final answer settles as plain visible text')
  consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })

  // Store level: the transcript holds only thinking + tool rows plus the
  // plain reply — zero narration bubbles exist to be rewritten or erased.
  const narrations = [...messages.values()].filter((m) => m.metadata.narration === true)
  assert.deepEqual(narrations, [], 'no narration bubbles in the simulated transcript')
  assert.deepEqual(rewrites, [], 'no finalize may rewrite an already-settled row')
  const finalMessage = [...messages.values()].find((m) => m.content === report)
  assert.ok(finalMessage, 'the final answer is its own message')
  assert.equal(finalMessage.metadata.narration, undefined)
})

// ---- Post-reasoning hold window: the final answer streams ----------------
// After the step's reasoning block CLOSES (block-end), body text under
// POST_REASONING_TEXT_HOLD_UNITS stays held (commentary folds silently, no
// flash); past the window the answer takes over — the bubble opens and
// streams instead of materializing whole at assistant/message. A tool call
// landing after the bet folds the streamed bubble back into the Think row.

const openReasoningThenClose = (mapper, reasoning) => {
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } })
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: reasoning } } })
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } } },
  })
}

test('DeepSeek: text under the hold window after block-end stays held and folds silently', () => {
  const mapper = new DshEventMapper()
  openReasoningThenClose(mapper, 'need the db schema')
  const held = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: '先查一下库里的表结构。' } },
  })
  assert.equal(held.some((a) => a.slot === 'text'), false, 'commentary-sized text opens no bubble')

  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need the db schema' },
          { type: 'text', text: '先查一下库里的表结构。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false, 'silent fold — no visible bubble ever opened')
  const thinkFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.match(thinkFinal.content, /need the db schema/)
  assert.match(thinkFinal.content, /先查一下库里的表结构。/)
})

test('DeepSeek: answer text past the hold window opens the bubble and streams', () => {
  const mapper = new DshEventMapper()
  openReasoningThenClose(mapper, 'ready to answer')
  const answer = `先说结论：任务来源已查清。${'逐项说明核对过程。'.repeat(40)}`
  assert.ok(answer.length >= 160, 'fixture must exceed the hold window')

  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: answer } },
  })
  assert.deepEqual(kinds(opened), ['message', 'messageUpdate'], 'the bubble opens and streams')
  assert.equal(opened[0].slot, 'text')

  const more = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: '（完）' } },
  })
  assert.deepEqual(kinds(more), ['messageUpdate'])
  assert.equal(more[0].content, `${answer}（完）`, 'updates carry the accumulated stream')

  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'ready to answer' },
          { type: 'text', text: `${answer}（完）` },
        ],
      },
    },
  })
  const textFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(textFinal.content, `${answer}（完）`)
  assert.equal(textFinal.metadata, undefined, 'the streamed bubble settles as the visible reply')
})

test('DeepSeek: a tool call after the streamed window folds the bubble into the Think row and retracts it', () => {
  const mapper = new DshEventMapper()
  openReasoningThenClose(mapper, 'plan: verify the task list')
  const longCommentary = `让我再核对一遍任务清单。${'逐条检查启用状态。'.repeat(40)}`
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: longCommentary } },
  })
  assert.equal(opened.some((a) => a.slot === 'text'), true, 'past the window the text streamed')

  const folded = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } },
  })
  const thinkUpdate = folded.find((a) => a.kind === 'messageUpdate' && a.slot === 'thinking')
  assert.match(thinkUpdate.content, /plan: verify the task list/)
  assert.match(thinkUpdate.content, /逐条检查启用状态。/, 'the streamed text joins the Think row')
  const retract = folded.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(retract.content, '', 'the wrong-bet bubble retracts')

  const tail = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: '继续核对。' } },
  })
  assert.equal(tail.some((a) => a.slot === 'text'), false, 'later deltas bypass the retracted bubble')
  const tailUpdate = tail.find((a) => a.kind === 'messageUpdate' && a.slot === 'thinking')
  assert.match(tailUpdate.content, /继续核对。/, 'later deltas stream into the Think row')

  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan: verify the task list' },
          { type: 'text', text: `${longCommentary}继续核对。` },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  const thinkFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.match(thinkFinal.content, /plan: verify the task list/)
  assert.match(thinkFinal.content, /继续核对。/, 'the settle keeps the authoritative combined Think row')
  assert.equal(done.some((a) => a.kind === 'messageFinalize' && a.slot === 'text'), false)
})

test('assistant mode: a tool call after the streamed window performs the same wrong-bet fold and retraction as professional mode', () => {
  const mapper = new DshEventMapper({ assistantMode: () => true })
  openReasoningThenClose(mapper, 'narration route')
  const longText = `我来处理这个排查请求。${'先从任务来源开始逐层说明。'.repeat(40)}`
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: longText } },
  })
  assert.equal(opened.some((a) => a.slot === 'text'), true, 'past the window the possible answer streams')

  // Assistant mode does NOT tag the streamed bubble as narration and skip
  // the fold (the pre-2026-10-24 behavior): the tool call gets the exact
  // professional-mode wrong-bet treatment — the streamed text joins the
  // live Think row and the bubble retracts.
  const folded = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } },
  })
  const thinkUpdate = folded.find((a) => a.kind === 'messageUpdate' && a.slot === 'thinking')
  assert.match(thinkUpdate.content, /narration route/)
  assert.match(thinkUpdate.content, /先从任务来源开始逐层说明。/, 'the streamed text joins the Think row')
  const retract = folded.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(retract.content, '', 'the wrong-bet bubble retracts')
  assert.equal(retract.metadata?.narration, undefined, 'no narration mark on the retraction')

  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'narration route' },
          { type: 'text', text: longText },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  const thinkFinal = done.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.match(thinkFinal.content, /narration route/)
  assert.match(thinkFinal.content, /先从任务来源开始逐层说明。/)
  assert.equal(done.some((a) => a.kind === 'messageFinalize' && a.slot === 'text'), false)
})

test('DeepSeek: turn aborted while folded settles the Think row with the absorbed text', () => {
  const mapper = new DshEventMapper()
  openReasoningThenClose(mapper, 'interrupted plan')
  const longText = `正在核对任务清单。${'逐条检查。'.repeat(60)}`
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: longText } } })
  const folded = mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } } })
  const retracted = folded.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(retracted.content, '', 'the bubble retracted at fold time')
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', cause: 'user' } } })
  const thinkFinal = ended.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.match(thinkFinal.content, /interrupted plan/)
  assert.match(thinkFinal.content, /逐条检查。/)
})

test('DeepSeek: hold state resets between steps — the next round holds afresh', () => {
  const mapper = new DshEventMapper()
  openReasoningThenClose(mapper, 'round one')
  const longText = `这一轮的正文很长。${'继续补充细节。'.repeat(60)}`
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: longText } } })
  mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'round one' },
          { type: 'text', text: longText },
        ],
      },
    },
  })
  // Round two: a fresh reasoning block holds text again even past the window
  // until its own block-end arrives.
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } })
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: 'round two' } } })
  const held = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: longText } },
  })
  assert.equal(held.some((a) => a.slot === 'text'), false, 'live reasoning holds text regardless of length')
})
