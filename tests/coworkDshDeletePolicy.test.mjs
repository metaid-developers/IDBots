// DSH host tool policy — delete-class confirmation matrix (Task 2 of the DSH
// integration fix list): the delete ask must fire ONLY under 'default'
// permission mode, matching the Claude path's canUseTool (acceptEdits and
// bypassPermissions skip the delete-safety question). Unconditional asking
// hung unattended worker sessions (acceptEdits) forever on `rm -rf` cleanup
// steps, because no human watches a background session to answer the dialog.
//
// Requires: npm run compile:electron.

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
          getPath: (name) => `/tmp/idbots-delete-policy-${name}`,
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

class MinimalStore {
  getSession() { return null }
  getConfig() { return {} }
}

const DELETE_COMMANDS = [
  'rm -rf /tmp/some-dir',
  'find . -name "*.log" -delete',
  'git clean -fd',
]
const SAFE_COMMAND = 'ls -la'

test('evaluateDshToolPolicy asks for deletes only under default permission mode', async () => {
  const { CoworkRunner } = loadRunner()
  const runner = new CoworkRunner(new MinimalStore(), { localTurnStallTimeoutMs: 0 })
  const policy = async (toolName, toolInput, permissionMode) => {
    if (permissionMode !== null) {
      runner.activeSessions.set('s1', { sessionId: 's1', permissionMode })
    } else {
      runner.activeSessions.delete('s1')
    }
    return runner.evaluateDshToolPolicy('s1', toolName, toolInput)
  }

  for (const command of DELETE_COMMANDS) {
    // 'default' keeps the human confirmation (foreground interactive use).
    assert.equal((await policy('bash', { command }, 'default')).decision, 'ask', `default asks for: ${command}`)
    // Worker/unattended modes skip it, exactly like the Claude path — this
    // was the permanent-hang regression after the DSH kernel switch.
    assert.equal((await policy('bash', { command }, 'acceptEdits')).decision, 'allow', `acceptEdits allows: ${command}`)
    assert.equal((await policy('bash', { command }, 'bypassPermissions')).decision, 'allow', `bypassPermissions allows: ${command}`)
    // No active session (orphan policy request): fail closed to ask.
    assert.equal((await policy('bash', { command }, null)).decision, 'ask', `no-session asks for: ${command}`)
  }

  // Non-delete commands stay allowed in every mode (bash policy gate).
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
    assert.equal((await policy('bash', { command: SAFE_COMMAND }, mode)).decision, 'allow', `${mode} allows non-delete bash`)
  }

  // Plan mode still denies mutating tools ahead of the delete check.
  assert.equal((await policy('bash', { command: SAFE_COMMAND }, 'plan')).decision, 'deny', 'plan denies non-read-only bash')
  // Direct delete-named tools ask under default too.
  assert.equal((await policy('delete', { path: '/tmp/x' }, 'default')).decision, 'ask', 'delete tool asks under default')
  assert.equal((await policy('delete', { path: '/tmp/x' }, 'acceptEdits')).decision, 'allow', 'delete tool allowed under acceptEdits')
})

// autoApprove (unattended: A2A conversations, orchestrator/worker turns) must
// NEVER block on a human confirmation — deletes are auto-decided by workspace
// scope: anything outside or not statically verifiable is auto-denied so the
// agent routes around it. Since the 0.2.2 headless auto-review integration,
// the calls the old path blind-allowed (provably-inside deletions and other
// mutating work) now go to the session's own model for a pre-execution review
// (decision "review") instead — the reviewer's risk tiers decide allow/deny,
// and denial is final. The workspace boundary guard still fires FIRST, so
// out-of-workspace deletes deny exactly as before.
test('autoApprove sessions auto-decide deletes by workspace scope (never ask)', async () => {
  const { CoworkRunner } = loadRunner()
  const runner = new CoworkRunner(new MinimalStore(), { localTurnStallTimeoutMs: 0 })
  runner.activeSessions.set('s1', {
    sessionId: 's1',
    permissionMode: 'default',
    autoApprove: true,
    workspaceRoot: '/workspace',
  })
  const policy = (toolName, toolInput) => runner.evaluateDshToolPolicy('s1', toolName, toolInput)
  const REVIEW = [
    ['bash', { command: 'rm -rf ./dist' }],
    ['bash', { command: 'rm -rf sub/dir && echo done' }],
    ['bash', { command: 'cd sub && rm -rf x' }],
    ['bash', { command: 'rm -rf "quoted dir"' }],
    ['bash', { command: 'find . -name "*.log" -delete' }],
    ['bash', { command: 'git clean -fd' }],
    // The delete keyword inside quoted output text is not a deletion.
    ['bash', { command: 'echo "rm -rf done"' }],
    ['bash', { command: 'bash -c "rm -rf ./x"' }],
    ['bash', { command: 'ls -la' }],
    ['delete', { path: 'sub/file.txt' }],
    ['delete', { path: './cache' }],
  ]
  for (const [toolName, toolInput] of REVIEW) {
    const result = await policy(toolName, toolInput)
    assert.equal(result.decision, 'review', `autoApprove hands in-workspace work to the auto reviewer: ${JSON.stringify(toolInput)}`)
  }
  const DENY = [
    ['bash', { command: 'rm -rf /tmp/some-dir' }],
    ['bash', { command: 'rm -rf ../outside' }],
    ['bash', { command: 'rm -rf ~/some-dir' }],
    ['bash', { command: 'rm -rf $CACHE_DIR/x' }],
    ['bash', { command: 'cd /tmp && rm -rf x' }],
    ['bash', { command: 'find /tmp -delete' }],
    ['bash', { command: 'bash -c "rm -rf /tmp/x"' }],
    // Unattributable delete keyword (xargs) fails closed.
    ['bash', { command: 'echo x | xargs rm -rf' }],
    ['delete', { path: '/tmp/x' }],
    ['delete', { path: '../outside.txt' }],
  ]
  for (const [toolName, toolInput] of DENY) {
    const result = await policy(toolName, toolInput)
    assert.equal(result.decision, 'deny', `autoApprove denies outside/unverifiable: ${JSON.stringify(toolInput)}`)
    assert.match(result.reason ?? '', /workspace|工作区/i, 'deny reason explains the workspace boundary')
  }
  // An autoApprove delete decision never produces an interactive ask.
  assert.equal((await policy('bash', { command: 'rm -rf /tmp/some-dir' })).decision !== 'ask', true)
})
