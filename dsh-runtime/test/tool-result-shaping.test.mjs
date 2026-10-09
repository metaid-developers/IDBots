// Unit tests: idbots-tool-result-shaping.
//
// Two suites in one file, both driven through a fake ctx that captures the
// tools/post-execute waterfall handler:
//   * JSON-safe truncation (issue #50) — an oversized single-JSON-block result
//     must stay parseable: arrays lose whole elements only, the marker rides a
//     namespaced key, the legacy head+tail path is kept for everything else.
//   * spill cooperation (upstream dade791b, cowork session 540635be) — when a
//     spillStore is mounted the FULL original is saved before any slice, the
//     marker carries its locator, and the shaped inline prices strictly under
//     the spill-policy cap.
//
// Zero dependencies beyond the token meter, no network, no runtime boot.
// Run: node test/tool-result-shaping.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import { apply, MARKER_KEY, ENVELOPE_KEY } from '../plugins/idbots-tool-result-shaping.mjs'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

const MARKER_TEXT = 'tool result trimmed'
const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const check = (name, fn) => {
  try {
    fn()
    record(name, true)
  } catch (error) {
    record(name, false, String(error?.message ?? error))
  }
}

// The documented legacy contract, written independently of the plugin: a single
// text block is replaced by head + marker + tail.
const legacyMarker = (original) => `\n[idbots: tool result trimmed, ${original} chars total — head+tail shown]\n`
const legacySingleBlock = (text, maxChars = 20000, tailChars = 4000) => {
  const budget = Math.min(text.length, maxChars)
  const keepTail = Math.min(tailChars, Math.floor(budget / 4))
  return text.slice(0, budget - keepTail) + legacyMarker(text.length) + text.slice(-keepTail)
}

const harness = (config = {}) => {
  const handlers = []
  apply({ on: (event, handler, options) => handlers.push({ event, handler, options }), get: () => undefined }, config)
  const entry = handlers.find((h) => h.event === 'tools/post-execute')
  assert.ok(entry, 'tools/post-execute handler registered')
  assert.equal(entry.options?.global, true, 'handler registered globally')
  return {
    run: (content, { isError = false, decision = { kind: 'accept' }, name = 'probe_tool' } = {}) =>
      entry.handler({ name }, { content, isError }, async () => decision),
  }
}

const textOf = (decision) => decision?.content?.[0]?.text
const parseOf = (decision) => JSON.parse(textOf(decision))
const parseOk = (text) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const blob = 'x'.repeat(60000)
const objectPayload = JSON.stringify({ head: 'BIG-BLOB-START', blob, tail: 'BIG-BLOB-END', note: '' })
const workers = (count, pad = 200) => Array.from({ length: count }, (_, i) => ({ index: i, name: `worker-${i}`, meta: 'm'.repeat(pad) }))
const listPayload = JSON.stringify(workers(200))
const numbers = Array.from({ length: 30000 }, (_, i) => i)
const sized = (chars) => JSON.stringify({ pad: 'y'.repeat(chars - JSON.stringify({ pad: '' }).length) })

const runJsonSafeSuite = async () => {
  const shaper = harness()

  // ---- JSON path: root object with one oversized string member ------------
  const shapedObject = await shaper.run([{ type: 'text', text: objectPayload }])
  const objectText = textOf(shapedObject)
  const objectJson = parseOf(shapedObject)
  record('JSON source chars', true, `${objectPayload.length} chars`)

  check('root object: shaped text still parses as JSON', () => assert.equal(parseOk(objectText), true))
  check('root object: shaped text is inside the budget including the marker', () => assert.ok(objectText.length <= 20000, `${objectText.length} chars`))
  check('root object: marker is a top-level sibling and tool keys are untouched', () => {
    assert.equal(objectJson[MARKER_KEY]?.truncated, true)
    assert.equal(objectJson.head, 'BIG-BLOB-START')
    assert.equal(objectJson.tail, 'BIG-BLOB-END')
    assert.equal(objectJson.note, '')
    assert.deepEqual(Object.keys(objectJson), ['head', 'blob', 'tail', 'note', MARKER_KEY])
  })
  check('root object: marker names the trimmed path and its units', () => {
    const marker = objectJson[MARKER_KEY]
    assert.equal(marker.mode, 'trimmed')
    assert.equal(marker.kind, 'string')
    assert.equal(marker.path, '$.blob')
    assert.equal(marker.total, 60000)
    assert.ok(marker.returned > 0 && marker.returned < 60000, `returned ${marker.returned}`)
    assert.equal(marker.originalChars, objectPayload.length)
    assert.ok(marker.note.includes(MARKER_TEXT), `note: ${marker.note}`)
    assert.deepEqual(marker.trims, [{ path: '$.blob', kind: 'string', returned: marker.returned, total: 60000 }])
  })
  check('root object: the shortened member is an exact prefix of the source', () => {
    assert.equal(blob.startsWith(objectJson.blob), true)
    assert.equal(objectJson.blob.length, objectJson[MARKER_KEY].returned)
  })

  // ---- JSON path: root array (envelope + sibling marker) ------------------
  const shapedList = await shaper.run([{ type: 'text', text: listPayload }])
  const listText = textOf(shapedList)
  const listJson = parseOf(shapedList)
  const keptElements = listJson[ENVELOPE_KEY]
  check('root array: payload rides the envelope and the marker is its sibling', () => {
    assert.ok(Array.isArray(keptElements), `${typeof keptElements}`)
    assert.equal(listJson[MARKER_KEY].mode, 'envelope')
    assert.equal(listJson[MARKER_KEY].kind, 'array')
    assert.equal(listJson[MARKER_KEY].path, '$')
    assert.equal(listJson[MARKER_KEY].total, 200)
    assert.equal(listJson[MARKER_KEY].returned, keptElements.length)
    assert.ok(parseOk(listText))
    assert.ok(listText.length <= 20000, `${listText.length} chars`)
  })
  check('root array: only whole elements are dropped, kept part = source prefix', () => {
    assert.ok(keptElements.length > 0 && keptElements.length < 200, `kept ${keptElements.length}/200`)
    assert.deepEqual(keptElements, workers(200).slice(0, keptElements.length))
  })
  check('root array: array-of-array element shapes are never half an element', () => {
    for (const element of keptElements) {
      assert.deepEqual(Object.keys(element), ['index', 'name', 'meta'])
      assert.equal(typeof element.meta, 'string')
      assert.equal(element.meta.length, 200)
    }
  })

  // ---- JSON path: nested array keeps dot/bracket path ---------------------
  const nestedPayload = JSON.stringify({ page: 1, data: { items: workers(200) }, ok: true })
  const shapedNested = await shaper.run([{ type: 'text', text: nestedPayload }])
  const nestedJson = parseOf(shapedNested)
  check('nested array: path is dot form, neighbours survive, prefix deep-equal', () => {
    assert.equal(nestedJson.page, 1)
    assert.equal(nestedJson.ok, true)
    assert.equal(nestedJson[MARKER_KEY].kind, 'array')
    assert.equal(nestedJson[MARKER_KEY].path, '$.data.items')
    const kept = nestedJson.data.items
    assert.ok(kept.length > 0 && kept.length < 200, `kept ${kept.length}/200`)
    assert.deepEqual(kept, workers(200).slice(0, kept.length))
    assert.ok(textOf(shapedNested).length <= 20000)
  })

  // ---- JSON path: bare numeric root array ---------------------------------
  const shapedNumbers = await shaper.run([{ type: 'text', text: JSON.stringify(numbers) }])
  const numbersJson = parseOf(shapedNumbers)
  check('bare root array: whole-element prefix, deep-equal', () => {
    const kept = numbersJson[ENVELOPE_KEY]
    assert.ok(kept.length > 0 && kept.length < numbers.length, `kept ${kept.length}/${numbers.length}`)
    assert.deepEqual(kept, numbers.slice(0, kept.length))
    assert.equal(numbersJson[MARKER_KEY].returned, kept.length)
    assert.equal(numbersJson[MARKER_KEY].total, numbers.length)
  })

  // ---- JSON path: a JSON string document ---------------------------------
  const stringDoc = 'z'.repeat(60000)
  const shapedString = await shaper.run([{ type: 'text', text: JSON.stringify(stringDoc) }])
  const stringJson = parseOf(shapedString)
  check('JSON string document: envelope carries the char prefix, marker sibling', () => {
    assert.equal(typeof stringJson[ENVELOPE_KEY], 'string')
    assert.equal(stringDoc.startsWith(stringJson[ENVELOPE_KEY]), true)
    assert.equal(stringJson[MARKER_KEY].kind, 'string')
    assert.equal(stringJson[MARKER_KEY].path, '$')
    assert.equal(stringJson[MARKER_KEY].total, stringDoc.length)
    assert.ok(textOf(shapedString).length <= 20000)
  })

  // ---- JSON path: a single oversized array member -------------------------
  const oneMember = 'q'.repeat(60000)
  const shapedMember = await shaper.run([{ type: 'text', text: JSON.stringify([oneMember]) }])
  const memberJson = parseOf(shapedMember)
  check('single oversized member: no element is drained, the member string is shortened', () => {
    assert.equal(memberJson[ENVELOPE_KEY].length, 1)
    assert.equal(memberJson[MARKER_KEY].kind, 'string')
    assert.equal(memberJson[MARKER_KEY].path, '$[0]')
    assert.equal(oneMember.startsWith(memberJson[ENVELOPE_KEY][0]), true)
    assert.ok(textOf(shapedMember).length <= 20000)
  })

  // ---- JSON path: several oversized nodes (composed trims) ----------------
  const twoHuge = JSON.stringify([{ blob: 'a'.repeat(60000) }, { blob: 'b'.repeat(60000) }])
  const shapedTwo = await shaper.run([{ type: 'text', text: twoHuge }])
  const twoJson = parseOf(shapedTwo)
  check('several oversized nodes: trims compose and the document still parses', () => {
    assert.ok(textOf(shapedTwo).length <= 20000, `${textOf(shapedTwo).length} chars`)
    const marker = twoJson[MARKER_KEY]
    assert.equal(marker.path, '$')
    assert.equal(marker.kind, 'array')
    assert.equal(marker.total, 2)
    assert.ok(marker.returned >= 1 && marker.returned < 2, `returned ${marker.returned}`)
    assert.ok(marker.trims.length >= 1)
    const kept = twoJson[ENVELOPE_KEY]
    assert.ok(kept.length >= 1 && kept.length <= 2)
    // kept elements are whole source elements (a member may carry its own trim)
    assert.deepEqual(Object.keys(kept[0]), ['blob'])
    assert.equal('a'.repeat(60000).startsWith(kept[0].blob), true)
  })

  // ---- markers never collide with the tool's own keys ---------------------
  const ownedKey = JSON.stringify({ [MARKER_KEY]: 'tool-owned', blob })
  const shapedOwned = await shaper.run([{ type: 'text', text: ownedKey }])
  check('namespaced-key collision: legacy path instead of overwriting the tool key', () => {
    assert.equal(textOf(shapedOwned), legacySingleBlock(ownedKey))
    assert.ok(textOf(shapedOwned).includes(MARKER_TEXT))
  })

  const ownTruncated = JSON.stringify({ truncated: false, blob })
  const ownTruncatedJson = parseOf(await shaper.run([{ type: 'text', text: ownTruncated }]))
  check('a tool key literally named "truncated" survives at the root', () => {
    assert.equal(ownTruncatedJson.truncated, false)
    assert.equal(ownTruncatedJson[MARKER_KEY].truncated, true)
  })

  // ---- legacy path, byte for byte ----------------------------------------
  const plain = 'A'.repeat(30000)
  const shapedPlain = await shaper.run([{ type: 'text', text: plain }])
  check('non-JSON text: legacy head+tail, byte for byte', () => {
    assert.equal(textOf(shapedPlain), legacySingleBlock(plain))
    assert.equal(parseOk(textOf(shapedPlain)), false)
  })

  const trailingGarbage = objectPayload + '\n(trailing log line)'
  const shapedGarbage = await shaper.run([{ type: 'text', text: trailingGarbage }])
  check('text that only nearly parses: legacy head+tail, byte for byte', () => {
    assert.equal(textOf(shapedGarbage), legacySingleBlock(trailingGarbage))
  })

  const shapedTwoBlocks = await shaper.run([{ type: 'text', text: objectPayload }, { type: 'text', text: 'TAIL-BLOCK' }])
  check('two text blocks: legacy path, a JSON document is never split across blocks', () => {
    assert.equal(shapedTwoBlocks.content.length, 1)
    assert.equal(shapedTwoBlocks.content[0].text, objectPayload.slice(0, 20000) + legacyMarker(objectPayload.length))
    assert.equal(parseOk(shapedTwoBlocks.content[0].text), false)
  })

  // ---- untouched decision shapes -----------------------------------------
  const atBudget = sized(20000)
  const decisionAtBudget = { kind: 'accept' }
  const resultAtBudget = await shaper.run([{ type: 'text', text: atBudget }], { decision: decisionAtBudget })
  check('exactly at budget: decision untouched (identity)', () => {
    assert.equal(atBudget.length, 20000)
    assert.equal(resultAtBudget, decisionAtBudget)
  })

  const overBudget = sized(20001)
  const resultOverBudget = await shaper.run([{ type: 'text', text: overBudget }])
  check('budget + 1: shaping engages and stays inside the budget', () => {
    assert.equal(overBudget.length, 20001)
    assert.ok(textOf(resultOverBudget).length <= 20000, `${textOf(resultOverBudget).length} chars`)
    assert.equal(parseOk(textOf(resultOverBudget)), true)
  })

  const decisionError = { kind: 'accept' }
  const resultError = await shaper.run([{ type: 'text', text: objectPayload }], { isError: true, decision: decisionError })
  check('error result: passed through verbatim (identity)', () => assert.equal(resultError, decisionError))

  const decisionReplace = { kind: 'replace', content: [{ type: 'text', text: 'downstream owns it' }] }
  const resultReplace = await shaper.run([{ type: 'text', text: objectPayload }], { decision: decisionReplace })
  check('non-accept decision: untouched (identity)', () => assert.equal(resultReplace, decisionReplace))

  const decisionContent = { kind: 'accept', content: [{ type: 'text', text: 'already shaped' }] }
  const resultContent = await shaper.run([{ type: 'text', text: objectPayload }], { decision: decisionContent })
  check('accept decision that already carries content: untouched (identity)', () => assert.equal(resultContent, decisionContent))

  const decisionContexts = { kind: 'accept', additionalContexts: [{ type: 'text', text: 'ctx' }] }
  const resultContexts = await shaper.run([{ type: 'text', text: objectPayload }], { decision: decisionContexts })
  check('JSON-safe accept keeps additionalContexts', () => {
    assert.deepEqual(resultContexts.additionalContexts, decisionContexts.additionalContexts)
    assert.equal(resultContexts.kind, 'accept')
  })

  // ---- whitespace-only overflow ------------------------------------------
  const tight = harness({ maxChars: 800, tailChars: 200 })
  let prettyDoc = null
  for (let pad = 1; pad <= 40 && prettyDoc === null; pad++) {
    const raw = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ i, label: 'l'.repeat(pad) })) }, null, 2)
    if (raw.length > 800 && JSON.stringify(JSON.parse(raw)).length <= 800) prettyDoc = raw
  }
  check('found a pretty-printed document that only overflows on whitespace', () => assert.ok(prettyDoc, 'fixture not found'))
  const shapedPretty = await tight.run([{ type: 'text', text: prettyDoc }])
  check('whitespace-only overflow: compacted, nothing lost, marker discloses re-serialization', () => {
    const out = textOf(shapedPretty)
    const outJson = JSON.parse(out)
    assert.ok(out.length <= 800, `${out.length} chars`)
    assert.deepEqual(outJson.items, JSON.parse(prettyDoc).items)
    // H-81 ②③: the compact path is no longer silent — the marker rides
    // alongside with mode='compact' and a note that says re-serialized.
    const marker = outJson[MARKER_KEY]
    assert.ok(marker, 'compact marker present')
    assert.equal(marker.mode, 'compact')
    assert.equal(marker.truncated, false)
    assert.equal(marker.trimCount, 0)
    assert.deepEqual(marker.trims, [])
    assert.equal(marker.note.includes('re-serialized'), true, `note: ${marker.note}`)
    assert.equal(marker.note.includes('value unchanged, bytes changed'), true, `note: ${marker.note}`)
    assert.equal(marker.originalChars, prettyDoc.length)
    // shapedChars is the compact document BEFORE the marker bytes are added;
    // the final inline is that document plus the marker's own footprint.
    assert.ok(marker.shapedChars > 0 && marker.shapedChars < prettyDoc.length, `shapedChars ${marker.shapedChars}`)
    assert.equal(out.length > marker.shapedChars, true, 'marker adds its own bytes on top of the compact document')
  })

  const tightPayload = JSON.stringify({ items: workers(50) })
  const shapedTight = await tight.run([{ type: 'text', text: tightPayload }])
  check('configured budget (800) is honoured by the JSON path', () => {
    assert.ok(textOf(shapedTight).length <= 800, `${textOf(shapedTight).length} chars`)
    assert.equal(parseOk(textOf(shapedTight)), true)
    assert.equal(parseOf(shapedTight)[MARKER_KEY].note.includes('budget 800 chars'), true)
  })

  check('default budget stays 20000 (unchanged defaults)', () => assert.ok(textOf(shapedObject).length <= 20000 && textOf(shapedObject).length > 19000))

  // ---- the plugin never mutates the source result ------------------------
  const sourceContent = [{ type: 'text', text: objectPayload }]
  await shaper.run(sourceContent)
  check('the source content blocks are left untouched', () => {
    assert.equal(sourceContent.length, 1)
    assert.equal(sourceContent[0].type, 'text')
    assert.equal(sourceContent[0].text, objectPayload)
  })

  // ---- H-81 three-state summary: every emitter carries mode ---------------
  check('H-81: trimmed marker keeps the original note text and mode=trimmed', () => {
    const marker = objectJson[MARKER_KEY]
    assert.equal(marker.mode, 'trimmed')
    assert.equal(marker.note.includes(MARKER_TEXT), true, `note: ${marker.note}`)
    assert.equal(marker.note.includes('budget 20000 chars'), true, `note: ${marker.note}`)
  })
  check('H-81: envelope marker carries mode=envelope', () => {
    assert.equal(numbersJson[MARKER_KEY].mode, 'envelope')
    assert.equal(numbersJson[MARKER_KEY].truncated, true)
  })
  check('H-81: compact marker re-serializes without loss (value unchanged, bytes changed)', () => {
    const out = textOf(shapedPretty)
    assert.equal(JSON.parse(out)[MARKER_KEY].mode, 'compact')
    assert.deepEqual(JSON.parse(out).items, JSON.parse(prettyDoc).items, 'value unchanged')
    assert.equal(out.length !== prettyDoc.length, true, 'byte footprint changed vs source')
  })

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  return failed
}

// ---- spill cooperation suite (upstream dade791b; identifiers namespaced) ----
const OVER_CAP = 'HEAD-MARK ' + 'x'.repeat(40000) + ' TAIL-MARK'
const tokenPrice = (blocks) => blocks.reduce((sum, block) => sum + (block.type === 'text' ? estimateContent([block]) : 0), 0)
const textOfBlocks = (content) => content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block))).join('')

function spillHarness({ spillStore, config = {} } = {}) {
  const handlers = {}
  const ctx = {
    on: (event, handler) => { handlers[event] = handler },
    get: (service) => (service === 'spillStore' ? spillStore : undefined),
  }
  apply(ctx, config)
  const exec = { name: 'big_tool', callId: 'call-1', agent: { session: { header: { id: 'session-1' } } } }
  const run = (content) => handlers['tools/post-execute'](
    exec,
    { isError: false, content },
    async () => ({ kind: 'accept' }),
  )
  return { run }
}

const saved = []
const store = {
  async saveText(input) {
    const ref = {
      locator: `/tmp/spill/session-1/big_tool-${saved.length + 1}.txt`,
      bytes: input.content.length,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
    saved.push({ ...input, ref })
    return ref
  },
}

const runSpillSuite = async () => {
  // 1. Oversize result with a spill store: the FULL original is saved, the
  //    marker carries its locator, and the shaped inline prices strictly
  //    under the spill-policy cap (no re-spill of the trimmed copy).
  {
    const decision = await spillHarness({ spillStore: store }).run([{ type: 'text', text: OVER_CAP }])
    assert.equal(saved.length, 1, 'exactly one spill save')
    assert.equal(saved[0].content, OVER_CAP, 'spill file received the FULL original')
    assert.equal(saved[0].owner.sessionId, 'session-1', 'spill saved under the session owner')
    const text = textOfBlocks(decision.content)
    assert.ok(text.includes('tool result trimmed'), 'marker present')
    assert.ok(text.includes(`full original stored at: ${saved[0].ref.locator}`), 'marker carries the locator')
    assert.ok(text.includes('HEAD-MARK') && text.includes('TAIL-MARK'), 'head and tail survive')
    assert.ok(tokenPrice(decision.content) <= 2048 - 128, `shaped copy prices under the policy cap (${tokenPrice(decision.content)} tokens)`)
  }

  // 2. saveText failure degrades to the legacy trim (bounded, no locator).
  {
    const failing = { async saveText() { throw new Error('disk full') } }
    const decision = await spillHarness({ spillStore: failing }).run([{ type: 'text', text: OVER_CAP }])
    const text = textOfBlocks(decision.content)
    assert.ok(text.includes('tool result trimmed'), 'legacy marker present')
    assert.ok(!text.includes('full original stored at:'), 'no locator promised on spill failure')
    assert.ok(text.length < 21000, `legacy trim bounds history (${text.length} chars)`)
  }

  // 3. No spill store mounted: byte-for-byte legacy behavior.
  {
    const decision = await spillHarness().run([{ type: 'text', text: OVER_CAP }])
    const text = textOfBlocks(decision.content)
    assert.ok(text.includes('[idbots: tool result trimmed, 40020 chars total — head+tail shown]'), 'legacy marker verbatim')
    assert.equal(saved.length, 1, 'no extra spill saves')
  }

  // 4. Under-cap results pass through untouched.
  {
    const decision = await spillHarness({ spillStore: store }).run([{ type: 'text', text: 'small result' }])
    assert.equal(decision.content, undefined, 'plain accept returned unshaped')
  }

  // 5. Multi-block results: the original is saved whole; the inline keeps the
  //    front-loaded head and the locator covers whatever the budget dropped.
  {
    const blocks = [
      { type: 'text', text: 'A-HEAD ' + 'a'.repeat(15000) },
      { type: 'text', text: 'B-HEAD ' + 'b'.repeat(15000) },
    ]
    const decision = await spillHarness({ spillStore: store }).run(blocks)
    assert.equal(saved.at(-1).content, blocks.map((block) => block.text).join(''), 'multi-block original saved whole')
    const text = textOfBlocks(decision.content)
    assert.ok(text.includes('A-HEAD'), 'head budget front-loaded across blocks')
    assert.ok(text.includes('full original stored at:'), 'locator present for everything the budget dropped')
    assert.ok(tokenPrice(decision.content) <= 2048 - 128, `multi-block copy prices under the policy cap (${tokenPrice(decision.content)} tokens)`)
  }

  console.log('tool-result-shaping.test.mjs: all assertions passed')
}

// ---- interaction: JSON-safe shaping AND spill cooperation on one payload ----
// Neither suite above covers this: the JSON-safe suite runs with no spillStore
// and the spill suite uses a non-JSON payload, so the composite behaviour
// (full original saved, locator in the JSON marker, inline still parseable and
// under the policy cap) is asserted here.
const JSON_BIG = JSON.stringify({ list: Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(200) })) })

const runInteractionSuite = async () => {
  const before = saved.length
  const decision = await spillHarness({ spillStore: store }).run([{ type: 'text', text: JSON_BIG }])
  const text = textOfBlocks(decision.content)
  assert.equal(saved.length, before + 1, 'the FULL JSON original is saved before any trim')
  assert.equal(saved.at(-1).content, JSON_BIG, 'spill file received the full original document')
  const parsed = JSON.parse(text)
  const marker = parsed.__idbots_tool_result_shaping__
  assert.ok(marker, 'JSON marker present on the shaped inline')
  assert.ok(marker.note.includes(saved.at(-1).ref.locator), 'JSON marker note carries the locator')
  assert.ok(Array.isArray(parsed.list) && parsed.list.length < 500 && parsed.list.length > 0, `oversized array lost whole elements only (${parsed.list.length}/500)`)
  assert.ok(text.length <= 20000, `inline stays inside maxChars (${text.length})`)
  assert.ok(tokenPrice(decision.content) <= 2048 - 128, `inline prices under the spill-policy cap (${tokenPrice(decision.content)} tokens)`)
  console.log('tool-result-shaping.test.mjs: interaction assertions passed')
}

// ---- one entrypoint: JSON-safe suite first, then the spill-cooperation suite
const run = async () => {
  const jsonFailed = await runJsonSafeSuite()
  await runSpillSuite()
  await runInteractionSuite()
  process.exit(jsonFailed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[shaping-test] fatal:', error)
  process.exit(1)
})
