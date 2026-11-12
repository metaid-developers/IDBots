// The security gate for the AX action tools, run end-to-end on real code.
//
// The owner's requirement: an AX tool that can CHANGE desktop state must sit
// behind the same gate as the cua-driver tools (computerUseProvider), never
// behind the unconditional registration the read-only screenshot tool uses.
// Two levels must both hold:
//   1. app-wide kill switch  automation.experimentalEnabled
//   2. per-bot switch        cowork.computerUse ('1' opts in; missing means off)
//
// This test wires the REAL gate functions, the REAL runtime-config generator and
// the REAL plugin, then asserts what actually reaches a session's tool list.
//
// Run: node --test tests/desktopAxComputerUseGate.test.mjs   (needs compile:electron)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

const {
  COWORK_COMPUTER_USE_KEY,
  EXPERIMENTAL_AUTOMATION_GLOBAL_KEY,
  isCoworkComputerUseEnabled,
  isExperimentalAutomationAllowed,
} = require('../dist-electron/main/services/coworkAutomationPreference.js')
const { generateRuntimeConfig } = await import('../dsh-runtime/lib/generate-runtime-config.mjs')
const { apply } = await import('../dsh-runtime/plugins/idbots-desktop-ax.mjs')

const PROVIDERS = [{
  key: 'openai-gw',
  apiFormat: 'openai',
  baseUrl: 'https://a.example/v1',
  apiKeyEnv: 'K1',
  models: [{ id: 'm1', contextWindow: 64000 }],
}]

/** kv + metabot-settings doubles, shaped like SqliteStore / MetabotStore. */
function makeStores({ killSwitch, perBot = {} }) {
  const kv = new Map()
  if (killSwitch !== undefined) kv.set(EXPERIMENTAL_AUTOMATION_GLOBAL_KEY, killSwitch)
  const settings = new Map(Object.entries(perBot))
  return {
    store: { get: (key) => kv.get(key), set: (key, value) => kv.set(key, value) },
    metabotStore: { getMetabotSetting: (id, key) => settings.get(`${id}:${key}`) },
  }
}

/**
 * The `computer` provider, transcribed from src/main/main.ts:6987-6994:
 *     if (!isExperimentalAutomationAllowed(getStoreOrNull())) return false
 *     return isCoworkComputerUseEnabled(getMetabotStore(), metabotId)
 * The transcription is guarded below by a source assertion, so it cannot drift
 * silently if the real provider changes.
 */
function computerProvider(stores) {
  return (metabotId) => {
    if (!isExperimentalAutomationAllowed(stores.store)) return false
    return isCoworkComputerUseEnabled(stores.metabotStore, metabotId)
  }
}

/** What a session's tool list actually contains for this feature. */
function toolsForSession(computerUse) {
  const entries = generateRuntimeConfig({ sessionRoot: '/tmp/x', providers: PROVIDERS, computerUse })
  const entry = entries.find((candidate) => candidate.id === 'idbots-desktop-ax')
  if (!entry) return { mounted: false, tools: [] }
  const registered = []
  apply({
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    systemPrompt: { section: () => () => {} },
  })
  return { mounted: true, tools: registered.map((tool) => tool.name) }
}

const AX_ACTION_TOOL = 'desktop_ax'

test("per-bot '1' (explicit opt-in) + app switch allowed: the AX tool IS in the session list", () => {
  const stores = makeStores({ killSwitch: undefined, perBot: { [`7:${COWORK_COMPUTER_USE_KEY}`]: '1' } })
  const computer = computerProvider(stores)
  const computerUse = computer(7) === true
  const session = toolsForSession(computerUse)

  assert.equal(computerUse, true)
  assert.equal(session.mounted, true)
  assert.ok(session.tools.includes(AX_ACTION_TOOL), `expected ${AX_ACTION_TOOL} in ${JSON.stringify(session.tools)}`)
})

test("per-bot switch missing (default off): the AX tool is NOT in the session list", () => {
  const stores = makeStores({ killSwitch: undefined, perBot: {} })
  const computer = computerProvider(stores)
  const computerUse = computer(7) === true
  const session = toolsForSession(computerUse)

  assert.equal(computerUse, false)
  assert.equal(session.mounted, false)
  assert.deepEqual(session.tools, [], 'a bot that never opted in must see no desktop_ax at all')
})

test("per-bot '0' (explicit opt-out): the AX tool is NOT in the session list", () => {
  const stores = makeStores({ killSwitch: undefined, perBot: { [`7:${COWORK_COMPUTER_USE_KEY}`]: '0' } })
  const computer = computerProvider(stores)
  const computerUse = computer(7) === true
  const session = toolsForSession(computerUse)

  assert.equal(computerUse, false)
  assert.equal(session.mounted, false)
  assert.deepEqual(session.tools, [], 'an opted-out bot must see no desktop_ax at all')
})

test("app-wide kill switch '0' beats a bot that never opted out", () => {
  const stores = makeStores({ killSwitch: '0', perBot: {} })
  const computer = computerProvider(stores)
  const computerUse = computer(7) === true
  const session = toolsForSession(computerUse)

  assert.equal(computerUse, false, 'the fleet-wide switch must win')
  assert.equal(session.mounted, false)
  assert.deepEqual(session.tools, [])
})

test("app-wide kill switch '0' beats even an explicitly enabled bot", () => {
  const stores = makeStores({ killSwitch: '0', perBot: { [`7:${COWORK_COMPUTER_USE_KEY}`]: '1' } })
  const computer = computerProvider(stores)
  const computerUse = computer(7) === true
  const session = toolsForSession(computerUse)

  assert.equal(computerUse, false)
  assert.equal(session.mounted, false)
  assert.deepEqual(session.tools, [])
})

test('a bot-less session (metabotId null) sees no AX action tool', () => {
  const stores = makeStores({ killSwitch: undefined, perBot: {} })
  const computer = computerProvider(stores)
  const computerUse = computer(null) === true
  const session = toolsForSession(computerUse)

  assert.equal(computerUse, false)
  assert.equal(session.mounted, false)
  assert.deepEqual(session.tools, [])
})

// ---------------------------------------------------------------------------
// Drift guards: the transcription above and the wiring in the app must keep
// matching what this test assumes. A refactor that breaks these fails loudly
// instead of leaving the gate silently weaker.
// ---------------------------------------------------------------------------

test('main.ts still composes `computer` from both gate levels, in that order', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/main.ts'), 'utf8')
  const block = source.slice(source.indexOf('const metabotAutomationProviders = {'))
  const computer = block.slice(block.indexOf('computer: (metabotId: number | null) => {'), block.indexOf('computer: (metabotId: number | null) => {') + 320)
  assert.match(computer, /if \(!isExperimentalAutomationAllowed\(getStoreOrNull\(\)\)\) return false/)
  assert.match(computer, /return isCoworkComputerUseEnabled\(getMetabotStore\(\), metabotId\)/)
  assert.ok(
    computer.indexOf('isExperimentalAutomationAllowed') < computer.indexOf('isCoworkComputerUseEnabled'),
    'the fleet-wide switch is checked first',
  )
})

test('coworkRunner feeds `computerUse` into the runtime config from the provider, not a literal', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/libs/coworkRunner.ts'), 'utf8')
  assert.match(source, /computerUseProvider: \(coworkSessionId\) => this\.computerUseProvider\?\.\(coworkSessionId\) === true/)
  assert.match(source, /computerUse: this\.computerUseForMetabot\?\.\(metabotId\) === true/)
})

test('the screenshot tool is unconditional and the AX tool is not — the two are wired differently', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/libs/coworkRunner.ts'), 'utf8')
  const screenshotAt = source.indexOf('buildScreenshotAgentTools({ tool, host: this.screenshotHost })')
  assert.ok(screenshotAt > 0, 'the screenshot registration must still exist')
  // Nothing about the AX layer is registered on the Claude tool path at all:
  // it is a DSH plugin, so its gate is the runtime config, asserted above.
  assert.equal(source.includes('desktopAx'), false, 'no AX tool may be registered outside the computerUse-gated plugin')
})

test('the generator mounts the AX plugin only inside the computerUse branch', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'dsh-runtime/lib/generate-runtime-config.mjs'), 'utf8')
  const branch = source.slice(source.indexOf("...(input.computerUse === true ? ["))
  const end = branch.indexOf('] : []),')
  assert.ok(end > 0)
  const gated = branch.slice(0, end)
  assert.ok(gated.includes("plugin('idbots-desktop-ax.mjs')"), 'the AX mount must live inside the computerUse branch')
  // And it must appear exactly once in the whole generator — no second, ungated mount.
  assert.equal(source.split("plugin('idbots-desktop-ax.mjs')").length - 1, 1)
})
