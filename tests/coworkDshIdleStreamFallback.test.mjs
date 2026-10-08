// Idle-session stream fallback in DshTurnHub hub handlers.
//
// Controller-less kernel turns (subagent-finished wakes, scheduled nudges)
// had a one-legged wiring: hub onMessage routed their placeholder rows to
// onIdleSessionMessage (persisted with isStreaming:true), but
// onMessageUpdate/onMessageFinalize dispatched to a live controller ONLY and
// were silently dropped for exactly those turns. Every kernel-initiated wake
// therefore left empty, never-finalized streaming rows in the transcript, and
// the renderer's abandoned-think detection rendered the "This turn was
// interrupted when the app quit or restarted" notice for turns that actually
// finished (2026-10-09 session 85e6885a: three subagent-finished wakes, six
// orphan rows, zero app restarts — the boot heal then hardened the false
// narrative into a persisted dshTurnInterrupted marker on the next launch).
//
// Fix under test: onMessageUpdate/onMessageFinalize fall back to
// onIdleSessionMessageUpdate/onIdleSessionMessageFinalize for OWNED sessions
// with no live controller. Unmapped sessions (continuable children, orphans)
// stay dropped — their raw transcript must not fold into any cowork session.
//
// Requires: npm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname
const compiled = path.join(here, '..', 'dist-electron', 'main', 'libs', 'coworkDshTurn.js')

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-idle-stream-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require(compiled)
  } finally {
    Module._load = originalLoad
  }
}

function buildHub(DshTurnHub) {
  const idleMessages = []
  const idleUpdates = []
  const idleFinalizes = []
  const hub = new DshTurnHub({
    runtimeDir: path.resolve(here, '..', 'dsh-runtime'),
    sessionRoot: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'idbots-idle-stream-')),
    log: () => undefined,
    onIdleSessionMessage: (coworkId, message) => {
      const id = `row-${idleMessages.length + 1}`
      idleMessages.push({ coworkId, message, id })
      return id
    },
    onIdleSessionMessageUpdate: (coworkId, messageId, content) => {
      idleUpdates.push({ coworkId, messageId, content })
    },
    onIdleSessionMessageFinalize: (coworkId, messageId, content, metadata) => {
      idleFinalizes.push({ coworkId, messageId, content, metadata })
    },
  })
  // Private maps, but this suite runs against compiled JS (no type privacy).
  const handlers = hub.hubHandlers({ key: 'mock' }, () => ({
    respondApproval: async () => ({}),
    respondAsk: async () => ({}),
    respondPolicy: async () => ({}),
  }))
  return { hub, handlers, idleMessages, idleUpdates, idleFinalizes }
}

test('controller-less kernel turns stream through the idle fallbacks', { skip: fs.existsSync(compiled) ? false : 'run pnpm run compile:electron first' }, () => {
  const { DshTurnHub } = loadModules()
  const { hub, handlers, idleMessages, idleUpdates, idleFinalizes } = buildHub(DshTurnHub)
  // The mapping a settled host turn leaves behind: pinned, but no live
  // controller — exactly the state a kernel-initiated wake turn runs in.
  hub.pinnedDshIds.set('cowork-1', 'dsh-1')

  const rowId = handlers.onMessage('dsh-1', {
    type: 'assistant',
    content: '',
    metadata: { isThinking: true, isStreaming: true },
  })
  assert.equal(rowId, 'row-1')
  assert.equal(idleMessages.length, 1)
  assert.equal(idleMessages[0].coworkId, 'cowork-1')

  handlers.onMessageUpdate('dsh-1', rowId, 'partial reasoning')
  handlers.onMessageFinalize('dsh-1', rowId, 'final reasoning', { isThinking: true })

  assert.deepEqual(idleUpdates, [{ coworkId: 'cowork-1', messageId: 'row-1', content: 'partial reasoning' }])
  assert.deepEqual(idleFinalizes, [{
    coworkId: 'cowork-1',
    messageId: 'row-1',
    content: 'final reasoning',
    metadata: { isThinking: true },
  }])
})

test('a live controller still takes precedence over the idle fallbacks', { skip: fs.existsSync(compiled) ? false : 'run pnpm run compile:electron first' }, () => {
  const { DshTurnHub } = loadModules()
  const { hub, handlers, idleUpdates, idleFinalizes } = buildHub(DshTurnHub)
  const controllerUpdates = []
  const controllerFinalizes = []
  hub.pinnedDshIds.set('cowork-2', 'dsh-2')
  hub.controllersByDsh.set('dsh-2', {
    cb: {
      onMessageUpdate: (messageId, content) => controllerUpdates.push({ messageId, content }),
      onMessageFinalize: (messageId, content, metadata) => controllerFinalizes.push({ messageId, content, metadata }),
    },
  })

  handlers.onMessageUpdate('dsh-2', 'row-9', 'host delta')
  handlers.onMessageFinalize('dsh-2', 'row-9', 'host final', { isThinking: true })

  assert.deepEqual(controllerUpdates, [{ messageId: 'row-9', content: 'host delta' }])
  assert.deepEqual(controllerFinalizes, [{ messageId: 'row-9', content: 'host final', metadata: { isThinking: true } }])
  assert.equal(idleUpdates.length, 0)
  assert.equal(idleFinalizes.length, 0)
})

test('unmapped (child / orphan) sessions stay dropped on every stream event', { skip: fs.existsSync(compiled) ? false : 'run pnpm run compile:electron first' }, () => {
  const { DshTurnHub } = loadModules()
  const { handlers, idleMessages, idleUpdates, idleFinalizes } = buildHub(DshTurnHub)

  const orphanId = handlers.onMessage('dsh-child', {
    type: 'assistant',
    content: '',
    metadata: { isThinking: true, isStreaming: true },
  })
  assert.equal(orphanId, 'dsh-orphan-dsh-child')
  handlers.onMessageUpdate('dsh-child', 'x', 'y')
  handlers.onMessageFinalize('dsh-child', 'x', 'y', { isThinking: true })

  assert.equal(idleMessages.length, 0)
  assert.equal(idleUpdates.length, 0)
  assert.equal(idleFinalizes.length, 0)
})
