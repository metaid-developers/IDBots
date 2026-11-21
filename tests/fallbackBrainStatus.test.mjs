// §9 session-level visibility for a fallback-brain turn (2026-11-20
// dream-distillation batch): the transcript already carried a switch notice,
// but the SESSION STATUS surface (sidebar row) kept saying 运行中 while the
// primary brain was dead. This file covers the marker's own behavior and its
// wiring into the visible status — route selection is out of scope and must
// stay untouched (the existing GT-02 suite is the guard for that).
//
// Requires: npm run compile:electron (the main-side registry is imported from
// dist-electron, matching tests/coworkDshFallbackRoute.test.mjs).

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')

const mainModuleUrl = pathToFileURL(
  path.join(projectRoot, 'dist-electron/main/libs/fallbackBrainStatus.js'),
).href
const rendererModuleUrl = pathToFileURL(
  path.join(projectRoot, 'src/renderer/components/cowork/fallbackBrainPresentation.js'),
).href

const mainModule = await import(mainModuleUrl)
const rendererModule = await import(rendererModuleUrl)

const { FallbackBrainRegistry, withActiveFallbackBrain, toSummaryField } = mainModule
const {
  resolveFallbackBrainStatusLabelKey,
  buildFallbackBrainStatusDetail,
  isFallbackBrainStatusActive,
  FALLBACK_BRAIN_LABEL_KEYS,
} = rendererModule

const activation = (overrides = {}) => ({
  provider: 'gw-b',
  model: 'mock-b1',
  fromProvider: 'gw-a',
  fromModel: 'mock-a1',
  rung: 'bot-fallback',
  at: 1_700_000_000_000,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Write side: the registry the runner writes at the switch and clears at settle
// ---------------------------------------------------------------------------

test('marking a session exposes the marker and its summary field until it is cleared', () => {
  const registry = new FallbackBrainRegistry()
  assert.equal(registry.get('cw-1'), null, 'no marker before any switch')

  const stored = registry.mark('cw-1', activation())
  assert.ok(stored, 'mark returns the stored activation')
  assert.deepEqual(registry.get('cw-1'), activation(), 'lookup returns the recorded route facts')
  assert.deepEqual(registry.summaryField('cw-1'), {
    activeFallbackBrain: {
      provider: 'gw-b',
      model: 'mock-b1',
      fromProvider: 'gw-a',
      fromModel: 'mock-a1',
      rung: 'bot-fallback',
      since: 1_700_000_000_000,
    },
  })

  assert.equal(registry.clear('cw-1'), true, 'clear reports the marker it removed')
  assert.equal(registry.get('cw-1'), null, 'cleared marker is gone')
  assert.equal(registry.summaryField('cw-1'), null, 'no summary field after settle')
  assert.equal(registry.clear('cw-1'), false, 'clearing twice is a no-op')
})

test('a malformed mark never throws and never creates a marker', () => {
  const registry = new FallbackBrainRegistry()
  assert.equal(registry.mark('', activation()), null, 'empty session id refused')
  assert.equal(registry.mark('cw-1', activation({ model: '   ' })), null, 'blank model refused')
  assert.equal(registry.mark('cw-1', activation({ rung: 'bogus' })), null, 'unknown rung refused')
  assert.equal(registry.get('cw-1'), null)
  assert.equal(registry.size, 0)
})

test('the registry is bounded: the oldest marks are evicted, the newest survives', () => {
  const registry = new FallbackBrainRegistry()
  for (let i = 0; i < 300; i += 1) {
    registry.mark(`cw-${i}`, activation({ model: `mock-${i}` }))
  }
  assert.equal(registry.size, 256, 'bounded at the documented cap')
  assert.ok(registry.get('cw-299'), 'the newest mark is retained')
  assert.equal(registry.get('cw-0'), null, 'the oldest mark was evicted')
})

test('withActiveFallbackBrain only decorates sessions with a live marker', () => {
  const registry = new FallbackBrainRegistry()
  registry.mark('cw-live', activation())
  const lookup = (id) => registry.get(id)

  const live = withActiveFallbackBrain({ id: 'cw-live', status: 'running' }, lookup)
  assert.equal(live.activeFallbackBrain.model, 'mock-b1')
  assert.equal(live.status, 'running', 'the status itself is never rewritten')

  const idle = { id: 'cw-idle', status: 'running' }
  assert.equal(withActiveFallbackBrain(idle, lookup), idle, 'untouched rows keep their reference')
  assert.equal(withActiveFallbackBrain(idle, null), idle, 'no lookup leaves rows untouched')
  assert.deepEqual(
    toSummaryField(activation()).rung,
    'bot-fallback',
    'the summary field carries the rung the label keys off',
  )
})

// ---------------------------------------------------------------------------
// Display side: what the session row actually says
// ---------------------------------------------------------------------------

test('a running turn on the bot fallback brain labels its status 备用脑运行中', () => {
  const row = { id: 'cw-1', status: 'running', activeFallbackBrain: toSummaryField(activation()) }
  assert.equal(resolveFallbackBrainStatusLabelKey(row), FALLBACK_BRAIN_LABEL_KEYS.botFallback)
  assert.equal(isFallbackBrainStatusActive(row), true)

  const t = (key) => ({
    coworkStatusFallbackBrain: '备用脑运行中',
    coworkStatusFallbackBrainDetail: '主模型 {from} 不可用，本轮由 {route} 继续执行。',
  })[key] ?? key
  assert.equal(t(resolveFallbackBrainStatusLabelKey(row)), '备用脑运行中')
  assert.equal(
    buildFallbackBrainStatusDetail(row, t),
    '主模型 mock-a1 不可用，本轮由 mock-b1 (gw-b) 继续执行。',
    'the tooltip names both the failed and the serving route',
  )
})

test('current-default / system-rescue rungs use the degraded label, not the fallback-brain one', () => {
  for (const rung of ['current-default', 'system-rescue']) {
    const row = { id: 'cw-1', status: 'running', activeFallbackBrain: toSummaryField(activation({ rung })) }
    assert.equal(
      resolveFallbackBrainStatusLabelKey(row),
      FALLBACK_BRAIN_LABEL_KEYS.degraded,
      `${rung} is a degradation but not the bot's own fallback brain`,
    )
  }
})

test('the label never appears without both a running status and a live marker', () => {
  const marked = { id: 'cw-1', status: 'running', activeFallbackBrain: toSummaryField(activation()) }
  assert.equal(
    resolveFallbackBrainStatusLabelKey({ ...marked, status: 'completed' }),
    null,
    'a settled row must not claim the fallback brain is running',
  )
  assert.equal(
    resolveFallbackBrainStatusLabelKey({ ...marked, status: 'error' }),
    null,
    'a failed row must not claim the fallback brain is running',
  )
  assert.equal(resolveFallbackBrainStatusLabelKey({ id: 'cw-1', status: 'running' }), null, 'no marker → plain status')
  assert.equal(
    resolveFallbackBrainStatusLabelKey({ id: 'cw-1', status: 'running', activeFallbackBrain: { rung: 'bot-fallback' } }),
    null,
    'a marker without a model cannot name a route',
  )
  assert.equal(buildFallbackBrainStatusDetail({ id: 'cw-1', status: 'running' }, () => 'x'), '')
})

test('the tooltip degrades safely when the primary route is unknown', () => {
  const row = {
    id: 'cw-1',
    status: 'running',
    activeFallbackBrain: toSummaryField(activation({ fromModel: null, fromProvider: null })),
  }
  const t = (key) => ({
    coworkStatusFallbackBrainDetail: 'Primary model {from} is unavailable; this turn is continuing on {route}.',
    coworkStatusFallbackBrainUnknownPrimary: 'the primary model',
  })[key] ?? key
  assert.equal(
    buildFallbackBrainStatusDetail(row, t),
    'Primary model the primary model is unavailable; this turn is continuing on mock-b1 (gw-b).',
  )
})

// ---------------------------------------------------------------------------
// Wiring guards: the marker must be written where a switch commits, cleared
// where the turn settles, and merged into the one summary source of truth
// ---------------------------------------------------------------------------

test('the runner marks the switch at the GT-02 commit point and clears it in finish()', () => {
  const source = read('src/main/libs/coworkRunner.ts')

  assert.match(
    source,
    /this\.markFallbackBrainActive\(sessionId, \{\s*\n\s*provider: fallbackRoute\.provider,/,
    'the GT-02 fallback route marks the session after committing the switch',
  )
  assert.match(
    source,
    /rung: fallbackIsSystemRescue \? 'system-rescue' : fallbackIsCurrentDefault \? 'current-default' : 'bot-fallback'/,
    'the marked rung reflects the ladder rung that actually resolved the route',
  )
  assert.match(
    source,
    /this\.markFallbackBrainActive\(sessionId, \{\s*\n\s*provider: bypass\.route\.provider,/,
    'the quota pre-gate bypass marks the session as degraded too',
  )

  const finishMatch = source.match(/const finish = \(status: CoworkSessionStatus\) => \{[\s\S]*?\n\s{4}\};/)
  assert.ok(finishMatch, 'finish() exists')
  assert.match(finishMatch[0], /this\.clearFallbackBrainActive\(sessionId\);/, 'the single settle point clears the marker')
  const statusWriteIndex = finishMatch[0].indexOf('this.store.updateSession')
  const clearIndex = finishMatch[0].indexOf('this.clearFallbackBrainActive')
  assert.ok(statusWriteIndex >= 0 && clearIndex > statusWriteIndex, 'the status settles before the marker clears')

  assert.match(
    source,
    /getActiveFallbackBrain\(sessionId: string\): FallbackBrainActivation \| null/,
    'the runner exposes the live marker to the summary IPC',
  )
})

test('the summary IPC merges the marker into the list and the per-session read', () => {
  const source = read('src/main/main.ts')
  assert.match(source, /import \{ withActiveFallbackBrain, type FallbackBrainActivation \}/, 'main imports the merge helper')
  assert.match(
    source,
    /const decorateWithFallbackBrain = <T extends \{ id\?: string \| null \}>\(rows: T\[\]\): T\[\] => \{/,
    'one decorator reads the runner registry',
  )
  assert.match(source, /const sessions = decorateWithFallbackBrain\(/, 'cowork:session:list decorates its rows')
  assert.match(source, /const \[decorated\] = decorateWithFallbackBrain\(\[summary \?\? raw\]\)/, 'cowork:session:getSummary decorates its row')
  assert.match(
    source,
    /coworkRunner\.on\('fallbackBrain'/,
    'the runner announcement is subscribed so an open list refreshes mid-turn',
  )
  assert.match(source, /broadcastToRenderers\('cowork:session:fallbackBrain', \{ sessionId \}\)/, 'the ping channel is broadcast')
})

test('the renderer receives the ping and re-reads the summary (no parallel state)', () => {
  const preload = read('src/main/preload.ts')
  assert.match(preload, /onSessionFallbackBrain: \(callback: \(data: \{ sessionId: string \}\) => void\)/, 'preload exposes the listener')
  assert.match(preload, /ipcRenderer\.on\('cowork:session:fallbackBrain', handler\)/, 'preload binds the channel')

  const types = read('src/renderer/types/electron.d.ts')
  assert.match(types, /onSessionFallbackBrain: \(callback: \(data: \{ sessionId: string \}\) => void\) => \(\) => void;/, 'the renderer type declares it')

  const service = read('src/renderer/services/cowork.ts')
  assert.match(service, /cowork\.onSessionFallbackBrain\?\.\(\(\{ sessionId \}\) => \{/, 'the service subscribes')
  assert.match(service, /refreshSessionSummaryOrReload\(sessionId\)\.catch/, 'the listener re-reads the summary')

  const summaryType = read('src/renderer/types/cowork.ts')
  assert.match(summaryType, /activeFallbackBrain\?: CoworkActiveFallbackBrain \| null;/, 'the summary type carries the marker')
})

test('the session row renders the fallback label instead of the plain running word', () => {
  const item = read('src/renderer/components/cowork/CoworkSessionItem.tsx')
  assert.match(item, /const fallbackBrainLabelKey = resolveFallbackBrainStatusLabelKey\(session\);/, 'the row resolves the label key')
  assert.match(item, /const statusLabel = i18nService\.t\(fallbackBrainLabelKey \?\? statusLabels\[session\.status\]\);/, 'the label replaces the plain status word')
  assert.match(item, /\{statusLabel\}/, 'the meta line renders the resolved label')
  assert.match(item, /fallbackBrainLabelKey\s*\n\s*\?\s*'text-amber-600 dark:text-amber-400'/, 'the degraded status is visibly distinct')
  assert.match(item, /data-fallback-brain=/, 'the dot exposes a test hook')
  // The Studio history surface hides idle/running words; a degradation must
  // still be visible there (that list is exactly where a post-mortem looks).
  assert.match(item, /DEATH_STATUS_LABEL_STATES\.has\(session\.status\) \|\| fallbackBrainLabelKey/, 'Studio rows keep the degradation visible')

  const i18n = read('src/renderer/services/i18n.ts')
  assert.match(i18n, /coworkStatusFallbackBrain: '备用脑运行中'/, 'zh copy')
  assert.match(i18n, /coworkStatusFallbackBrain: 'Fallback brain running'/, 'en copy')
  assert.match(i18n, /coworkStatusDegradedModel: '降级模型运行中'/)
  assert.match(i18n, /coworkStatusDegradedModel: 'Degraded model running'/)
})
