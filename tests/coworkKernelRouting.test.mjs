// DSH-only kernel routing: Anthropic Messages rides pi-ai; sticky `dsh:`
// handles stay on DSH. Sessions whose transcript the kernel never saw (legacy
// pre-DSH handles, branched sessions) get an honest history handoff.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const {
  DSH_SESSION_PREFIX,
  isDshSessionHandle,
  dshSessionIdOf,
  makeDshSessionHandle,
  isDshEligibleApiType,
  dshApiFormatOf,
  resolveKernelChoice,
  buildSessionHistoryHandoff,
} = require('../dist-electron/main/libs/coworkKernelRouting.js')

test('session handle helpers round-trip', () => {
  const handle = makeDshSessionHandle('cw-42')
  assert.ok(handle.startsWith(DSH_SESSION_PREFIX))
  assert.equal(isDshSessionHandle(handle), true)
  assert.equal(isDshSessionHandle('classic-sdk-session-id'), false)
  assert.equal(isDshSessionHandle(null), false)
  assert.equal(dshSessionIdOf(handle), 'cw-42')
  assert.equal(dshSessionIdOf('classic'), null)
})

test('apiType eligibility includes Anthropic Messages', () => {
  assert.equal(isDshEligibleApiType('openai'), true)
  assert.equal(isDshEligibleApiType('responses'), true)
  assert.equal(isDshEligibleApiType('anthropic'), true)
  assert.equal(isDshEligibleApiType(undefined), false)
})

test('dshApiFormatOf preserves anthropic and responses', () => {
  assert.equal(dshApiFormatOf('anthropic'), 'anthropic')
  assert.equal(dshApiFormatOf('responses'), 'responses')
  assert.equal(dshApiFormatOf('openai'), 'openai')
  assert.equal(dshApiFormatOf(undefined), 'openai')
})

test('local cowork is DSH-only including Anthropic Messages', () => {
  assert.equal(resolveKernelChoice({ apiType: 'openai' }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: 'responses' }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: 'anthropic' }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: undefined }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: 'anthropic', sessionHandle: 'dsh:cw-1' }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: 'anthropic', sessionHandle: 'sdk-123' }), 'dsh')
})

test('legacy-handle handoff summarizes prior turns and stays bounded', () => {
  assert.equal(buildSessionHistoryHandoff([]), '')
  assert.equal(buildSessionHistoryHandoff([{ type: 'system', content: 'noise' }]), '')
  const text = buildSessionHistoryHandoff([
    { type: 'user', content: 'Remember the project is Twin.' },
    { type: 'assistant', content: 'I will keep Twin in the Twin folder.' },
    { type: 'tool_use', content: 'ignored' },
  ])
  assert.match(text, /previous kernel/)
  assert.match(text, /User: Remember the project is Twin\./)
  assert.match(text, /Assistant: I will keep Twin in the Twin folder\./)
  assert.doesNotMatch(text, /ignored/)
  const long = 'x'.repeat(800)
  const clipped = buildSessionHistoryHandoff([{ type: 'user', content: long }])
  assert.ok(clipped.length < 1200)
  assert.match(clipped, /…/)
})

test('branched-session handoff announces the branch origin with the same digest body', () => {
  const text = buildSessionHistoryHandoff([
    { type: 'user', content: 'Original session prompt.' },
    { type: 'assistant', content: 'Original session reply.' },
    { type: 'tool_result', content: 'ignored' },
  ], 'branched-session')
  assert.match(text, /branched from an earlier session/)
  assert.match(text, /User: Original session prompt\./)
  assert.match(text, /Assistant: Original session reply\./)
  assert.doesNotMatch(text, /ignored/)
  assert.match(text, /Do not claim you remember anything/)
})
