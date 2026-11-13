import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn as namedSpawn, execFile as namedExecFile, exec as namedExec } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installWin32SpawnShim,
  resolveWin32BashProgram,
  withWin32SpawnOptions,
} from '../lib/win32-spawn-shim.mjs'

test('withWin32SpawnOptions always sets windowsHide', () => {
  assert.equal(withWin32SpawnOptions(undefined).windowsHide, true)
  assert.equal(withWin32SpawnOptions({ cwd: '/tmp', windowsHide: false }).windowsHide, true)
  assert.equal(withWin32SpawnOptions({ cwd: '/tmp' }).cwd, '/tmp')
})

test('resolveWin32BashProgram rewrites bare bash when the env path exists', () => {
  assert.equal(resolveWin32BashProgram('python', {}), 'python')
  assert.equal(resolveWin32BashProgram('bash', {}), 'bash')
  const missing = path.join(os.tmpdir(), 'idbots-missing-bash.exe')
  assert.equal(resolveWin32BashProgram('bash', { CLAUDE_CODE_GIT_BASH_PATH: missing }), 'bash')
  const existing = existsSync('/bin/bash') ? '/bin/bash' : process.execPath
  assert.equal(
    resolveWin32BashProgram('bash', { CLAUDE_CODE_GIT_BASH_PATH: existing }),
    existing,
  )
  assert.equal(
    resolveWin32BashProgram('bash.exe', { IDBOTS_BASH_PATH: existing }),
    existing,
  )
})

test('installWin32SpawnShim syncs ESM named bindings for spawn, execFile, and exec', (t) => {
  const calls = []
  const restore = installWin32SpawnShim({
    platform: 'win32',
    spawnImpl: (file, args, options) => {
      calls.push({ fn: 'spawn', file, args, options })
      return { mocked: true }
    },
    execFileImpl: (file, args, options, cb) => {
      calls.push({ fn: 'execFile', file, args, options, hasCb: typeof cb === 'function' })
      return { mocked: true }
    },
    execImpl: (cmd, options, cb) => {
      calls.push({ fn: 'exec', cmd, options, hasCb: typeof cb === 'function' })
      return { mocked: true }
    },
  })
  t.after(() => restore())

  namedSpawn('node', ['-v'], { windowsHide: false })
  namedExecFile('git', ['status'], () => {})
  namedExec('whoami', () => {})

  assert.equal(calls.length, 3)
  assert.equal(calls[0].fn, 'spawn')
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[1].fn, 'execFile')
  assert.equal(calls[1].options.windowsHide, true)
  assert.equal(calls[1].hasCb, true)
  assert.equal(calls[2].fn, 'exec')
  assert.equal(calls[2].options.windowsHide, true)
  assert.equal(calls[2].hasCb, true)
})
