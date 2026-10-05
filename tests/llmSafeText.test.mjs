// Surrogate-safe text truncation for LLM request bodies.
//
// 2026-08-24 user report: a Twin Worker bio longer than 200 UTF-16 units was
// capped by capText's `text.slice(0, 199)`, which split the 🌐 surrogate pair
// and stranded a lone high surrogate in the system prompt. JSON.stringify
// serialized it as a `\ud83c` hex escape and DeepSeek's strict parser
// rejected the whole request — "lone leading surrogate in hex escape",
// HTTP 400, surfaced to the user as a generic
// "DSH turn failed: DeepSeek API error (HTTP 400)".
//
// Covers the llmSafeText helpers, the Twin roster regression (roster
// block from an over-cap bio with an emoji at the cut), and the
// native-adapter route gate (a 'deepseek'-keyed provider on a custom proxy
// base URL must stay on the generic pi-ai route).
// Requires: npm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'

const require = Module.createRequire(import.meta.url)

// eslint-disable-next-line no-misleading-character-class
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function readSource(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => process.cwd(),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      llmSafeText: require('../dist-electron/main/libs/llmSafeText.js'),
      twinWorkerDirectoryService: require('../dist-electron/main/services/twinWorkerDirectoryService.js'),
      coworkDshTurn: require('../dist-electron/main/libs/coworkDshTurn.js'),
      coworkToolResultSnip: require('../dist-electron/main/libs/coworkToolResultSnip.js'),
      coworkToolResultFold: require('../dist-electron/main/libs/coworkToolResultFold.js'),
      experiencePromptBlocks: require('../dist-electron/main/libs/experiencePromptBlocks.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

test('truncateUtf16Units: plain cuts unchanged, surrogate pairs never split', () => {
  const { truncateUtf16Units } = loadModules().llmSafeText
  assert.equal(truncateUtf16Units('abcdef', 3), 'abc')
  assert.equal(truncateUtf16Units('abcdef', 10), 'abcdef')
  assert.equal(truncateUtf16Units('abcdef', 0), '')
  assert.equal(truncateUtf16Units('abcdef', -1), '')
  // Cut boundary INSIDE a pair: the pair is dropped whole, one unit shorter.
  const splitAtPair = 'a'.repeat(199) + '🌐' + 'b'.repeat(10)
  const cut = truncateUtf16Units(splitAtPair, 200)
  assert.equal(cut.length, 199)
  assert.equal(cut, 'a'.repeat(199))
  assert.equal(LONE_SURROGATE_RE.test(cut), false)
  // Cut boundary NOT inside a pair: exact length preserved.
  const pairFirst = '🌐' + 'a'.repeat(199)
  const cutPairFirst = truncateUtf16Units(pairFirst, 200)
  assert.equal(cutPairFirst.length, 200)
  assert.equal(cutPairFirst, '🌐' + 'a'.repeat(198))
})

test('truncateUtf16UnitsFromEnd: tail never starts on a stranded low surrogate', () => {
  const { truncateUtf16UnitsFromEnd } = loadModules().llmSafeText
  const text = 'a'.repeat(300) + '🌐' + 'b'
  // Naive text.slice(text.length - 2) starts on the pair's low half.
  const tail = truncateUtf16UnitsFromEnd(text, 2)
  assert.equal(tail, 'b')
  assert.equal(LONE_SURROGATE_RE.test(tail), false)
  // Boundary outside a pair: exact tail preserved.
  assert.equal(truncateUtf16UnitsFromEnd('abcdef', 3), 'def')
  assert.equal(truncateUtf16UnitsFromEnd('abcdef', 10), 'abcdef')
  assert.equal(truncateUtf16UnitsFromEnd('abcdef', 0), '')
})

test('truncate edge: maxUnits=1 still never strands a surrogate half', () => {
  const { truncateUtf16Units, truncateUtf16UnitsFromEnd } = loadModules().llmSafeText
  assert.equal(truncateUtf16Units('a🌐', 1), 'a')
  // The pair occupies units 0-1; cutting to 1 would keep only the high half.
  assert.equal(truncateUtf16Units('🌐b', 1), '')
  assert.equal(truncateUtf16UnitsFromEnd('b🌐', 1), '')
  assert.equal(truncateUtf16Units('🌐', 1), '')
  assert.equal(truncateUtf16Units('ab', 1), 'a')
})

test('stripLoneSurrogates: consecutive corrupt halves cannot leak a lone surrogate', () => {
  const { stripLoneSurrogates } = loadModules().llmSafeText
  for (const input of [
    '\uD83C\uD83C',
    '\uDC00\uDC00',
    '\uD83C\uD83C\uDC00',
    '\uDC00\uD83C\uDC00',
    '\uD83C\uDC00\uD83C',
    'a\uD83C\uD83Cb\uDC00c',
  ]) {
    const out = stripLoneSurrogates(input)
    assert.equal(LONE_SURROGATE_RE.test(out), false, `input ${JSON.stringify(input)} -> ${JSON.stringify(out)}`)
  }
})

test('stripLoneSurrogates: drops halves, keeps valid pairs and BMP', () => {
  const { stripLoneSurrogates } = loadModules().llmSafeText
  assert.equal(stripLoneSurrogates('a\uD83Cb'), 'ab')
  assert.equal(stripLoneSurrogates('\uDC00b'), 'b')
  assert.equal(stripLoneSurrogates('好🌐!'), '好🌐!')
  // High half at end of string, low half at start of string.
  assert.equal(stripLoneSurrogates('x\uD83C'), 'x')
  assert.equal(stripLoneSurrogates('\uDC00x'), 'x')
})

test('twin roster: an over-cap bio with an emoji at the cut carries no lone surrogate', () => {
  const { buildTwinLocalRosterBlock } = loadModules().twinWorkerDirectoryService
  // The reported shape: bio > 200 UTF-16 units with 🌐 straddling unit 199
  // (the pre-fix capText slice point). Documents the failure mode first.
  const bio = 'x'.repeat(198) + '🌐 worldwide automation hub ' + 'y'.repeat(80)
  assert.ok(bio.length > 200)
  const legacyCap = `${bio.slice(0, 199)}…`
  assert.equal(LONE_SURROGATE_RE.test(legacyCap), true)

  const directory = {
    requester: { sessionId: 's1', twinId: 1, ownerGlobalMetaId: 'id_owner' },
    workers: [{
      id: 913,
      name: 'Worker A',
      type: 'worker',
      enabled: true,
      globalMetaID: 'id_worker_a',
      ownerGlobalMetaId: 'id_owner',
      ownerBindingVerified: true,
      role: 'a'.repeat(198) + '🌐',
      bio,
      goal: 'g'.repeat(198) + '🌐',
      personaSummary: '',
      skills: ['web'],
      chatSkills: [],
      capabilityEvidence: [],
      availability: 'available',
      activeOrchestrationSteps: 0,
    }],
  }
  const roster = buildTwinLocalRosterBlock(directory)
  assert.ok(roster.includes('Worker A'))
  assert.equal(LONE_SURROGATE_RE.test(roster), false)
  // The wire form must be free of lone-surrogate hex escapes too.
  assert.equal(LONE_SURROGATE_RE.test(JSON.stringify(roster)), false)
})

test('isNativeDeepSeekChatRoute: only the official api.deepseek.com host rides the native adapter', () => {
  const { isNativeDeepSeekChatRoute } = loadModules().coworkDshTurn
  // Official host, chat-completions shape (dshApiRootOf keeps /v1) → native.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiFormat: 'openai' }), true)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai' }), true)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'responses' }), true)
  // Custom proxy base URL under the 'deepseek' key → generic pi-ai route.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://relay.example.com/v1', apiFormat: 'openai' }), false)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'http://127.0.0.1:48795/v1', apiFormat: 'openai' }), false)
  // Anthropic-format official endpoint → pi-ai anthropic-messages.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic' }), false)
  // Another provider keyed on the official host is not the deepseek route.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'opencode', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai' }), false)
})

test('isNativeDeepSeekChatRoute: host parsing is robust to shape noise', () => {
  const { isNativeDeepSeekChatRoute } = loadModules().coworkDshTurn
  // Case-insensitive hostname, explicit port, whitespace padding.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://API.DEEPSEEK.COM/v1', apiFormat: 'openai' }), true)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com:443/v1', apiFormat: 'openai' }), true)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: '  https://api.deepseek.com/v1  ', apiFormat: 'openai' }), true)
  // Null/empty/garbage base URLs can never be native (provider may still be 'deepseek').
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: null, apiFormat: 'openai' }), false)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: '', apiFormat: 'openai' }), false)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'not-a-url', apiFormat: 'openai' }), false)
  // Port-bearing custom relay stays on pi-ai.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://relay.example.com:8443/v1', apiFormat: 'openai' }), false)
})

test('tool-result snipping: head/tail cuts never strand surrogate halves', () => {
  const { snipStaleToolResultBlocks, COWORK_TOOL_RESULT_SNIP_HEAD_CHARS, COWORK_TOOL_RESULT_SNIP_TAIL_CHARS } = loadModules().coworkToolResultSnip
  const snip = (text) => {
    const { messages, stats } = snipStaleToolResultBlocks(
      [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] }],
      10_000_000,
    )
    assert.equal(stats.snippedBlocks, 1, 'fixture must exceed the snip threshold')
    return messages[0].content[0].content
  }
  // Emoji exactly at the head cut boundary (pre-fix: lone high surrogate).
  const headSplit = 'a'.repeat(COWORK_TOOL_RESULT_SNIP_HEAD_CHARS - 1) + '🌐' + 'x'.repeat(COWORK_TOOL_RESULT_SNIP_TAIL_CHARS + 400)
  const snipHead = snip(headSplit)
  assert.equal(LONE_SURROGATE_RE.test(snipHead), false)
  // Emoji exactly at the tail start (pre-fix: lone low surrogate).
  const tailSplit = 'x'.repeat(COWORK_TOOL_RESULT_SNIP_HEAD_CHARS + 320) + '🌐' + 'y'.repeat(COWORK_TOOL_RESULT_SNIP_TAIL_CHARS - 1)
  const snipTail = snip(tailSplit)
  assert.equal(LONE_SURROGATE_RE.test(snipTail), false)
  // Both cuts land on clean boundaries: deterministic shape unchanged.
  const plain = 'p'.repeat(COWORK_TOOL_RESULT_SNIP_HEAD_CHARS + COWORK_TOOL_RESULT_SNIP_TAIL_CHARS + 400)
  const snipPlain = snip(plain)
  assert.match(snipPlain, /\[snipped tool result/)
  assert.equal(LONE_SURROGATE_RE.test(snipPlain), false)
})

test('read-side pollution coverage: stored rows are sanitized before prompts (review round 3)', async () => {
  // Behavioral: the exported dream-daily block sanitizes a polluted summary.
  const { buildRecentDailySummariesBlock } = loadModules().experiencePromptBlocks
  const pollutedBlock = buildRecentDailySummariesBlock([
    { summaryDate: '2026-08-20', summaryText: 'helped the owner ship a release \uD83C and wrote docs' },
  ])
  assert.equal(LONE_SURROGATE_RE.test(pollutedBlock), false)
  assert.match(pollutedBlock, /helped the owner ship a release/)

  // Static anchors for the non-exported read-side chokepoints.
  const coworkStore = readSource('src/main/coworkStore.ts')
  assert.match(
    coworkStore,
    /text: stripLoneSurrogates\(row\.text \?\? ''\)/,
    'mapMemoryRow must sanitize stored memory text on read (user_memories prompt path)',
  )
  const cognition = readSource('src/main/services/metaidCognitionContext.ts')
  assert.match(
    cognition,
    /const normalized = stripLoneSurrogates\(text\(value\)\)/,
    'group-cognition truncate must sanitize dream/impression free text',
  )
  assert.match(
    cognition,
    /truncateUtf16Units\(rendered, Math\.max\(0, maxTotalChars - 1\)\)/,
    'group-cognition rendered cap must cut surrogate-safe',
  )
  const openTeam = readSource('src/main/services/openTeamService.ts')
  assert.match(
    openTeam,
    /const goal = stripLoneSurrogates\(task\.goal\)/,
    'open-team invite goal must strip on EVERY branch, not only over-cap',
  )
})

test('tool-result fold preview: middle cut never strands surrogate halves (review round 4)', () => {
  const { foldLowValueToolResults } = loadModules().coworkToolResultFold
  // 79 code units, then an emoji straddling the naive 80-unit head cut.
  const polluted = `状态: executing | ${'x'.repeat(63)}\uD83C\uDF10${'y'.repeat(100)}`
  const messages = [0, 1, 2].map((i) => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: polluted }],
  }))
  const { messages: folded, stats } = foldLowValueToolResults(messages)
  assert.equal(stats.folded, 1)
  assert.notEqual(folded, messages)
  assert.equal(LONE_SURROGATE_RE.test(JSON.stringify(folded)), false)
})

test('review round-4 sweep: every converted chokepoint routes through llmSafeText', () => {
  const anchors = [
    ['src/main/services/groupTaskDaemon.ts', /truncateUtf16Units\(lastBlock, EXPERIENCE_BLOCK_MAX_CHARS\)/],
    ['src/main/libs/dreamPrompt.ts', /truncateUtf16Units\(normalized, maxChars\)/],
    ['src/main/skillManager.ts', /const window = truncateUtf16Units\(text, maxChars\)/],
    ['src/main/libs/coworkToolResultFold.ts', /truncateUtf16UnitsFromEnd\(clean, Math\.floor\(maxChars \/ 2\)\)/],
    ['src/main/services/privateChatDaemon.ts', /truncateUtf16UnitsFromEnd\(text, tailLength\)/],
    ['src/main/services/a2aGuidanceRestart.ts', /truncateUtf16Units\(clean, A2A_GUIDANCE_RESTART_MAX_CONTEXT_LINE_CHARS\)/],
    ['src/main/services/cognitiveOrchestrator.ts', /truncateUtf16Units\(content, READ_FILE_MAX_CHARS\)/],
    ['src/main/libs/coworkSessionActivity.ts', /truncateUtf16Units\(trimmed, max - 1\)/],
    ['src/main/services/botSearchService.ts', /return truncateUtf16Units\(clean, maxLen\)/],
    ['src/main/services/metabotManageService.ts', /truncateUtf16Units\(text, maxLength - 1\)/],
    ['src/main/services/metawebStudyService.ts', /truncateUtf16Units\(clean, max\)/],
    ['src/main/libs/metaIdSearchAgentTools.ts', /truncateUtf16Units\(clean, max\)/],
    ['src/main/libs/networkServicesAgentTools.ts', /truncateUtf16Units\(clean, max\)/],
    ['src/main/libs/knowledgeBaseAgentTools.ts', /truncateUtf16Units\(clean, max\)/],
    ['src/main/libs/metawebLearningAgentTools.ts', /truncateUtf16Units\(clean, max\)/],
    ['src/main/libs/metabotManageAgentTools.ts', /truncateUtf16Units\(clean, max - 1\)/],
  ]
  for (const [file, pattern] of anchors) {
    const source = readSource(file)
    assert.match(source, /llmSafeText/, `${file} must import the llmSafeText helpers`)
    assert.match(source, pattern, `${file} keeps an unswept raw truncation`)
  }
})
