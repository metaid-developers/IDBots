// Windows spawn shim for the DSH runtime child.
//
// dsh-bash-local / dsh-subprocess-local spawn a bare `bash` name with no
// windowsHide. Packaged Start-menu Electron then flashes a console per tool
// call, and a Path/PATH regression makes bash ENOENT even when mingit is on
// PATH. Rewrite argv[0] to CLAUDE_CODE_GIT_BASH_PATH when set, and hide the
// console. No-op on non-Windows.

import childProcess, {
  spawn as realSpawn,
  execFile as realExecFile,
  exec as realExec,
} from 'node:child_process'
import { existsSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

export function resolveWin32BashProgram(file, env = process.env) {
  const name = String(file ?? '')
  const lower = name.toLowerCase()
  const isBareBash = name === 'bash' || lower === 'bash.exe' || lower.endsWith('\\bash.exe') || lower.endsWith('/bash.exe')
  if (!isBareBash) return file
  const configured = String(env.CLAUDE_CODE_GIT_BASH_PATH || env.IDBOTS_BASH_PATH || '').trim()
  if (configured && existsSync(configured)) return configured
  return file
}

export function withWin32SpawnOptions(options) {
  return { windowsHide: true, ...(options && typeof options === 'object' ? options : {}), windowsHide: true }
}

export function installWin32SpawnShim(testOptions) {
  const platform = testOptions?.platform ?? process.platform
  if (platform !== 'win32') return () => {}
  if (childProcess.spawn.__idbotsWin32Shim) return () => {}
  const spawnImpl = testOptions?.spawnImpl ?? realSpawn
  const execFileImpl = testOptions?.execFileImpl ?? realExecFile
  const execImpl = testOptions?.execImpl ?? realExec
  const prevSpawn = childProcess.spawn
  const prevExecFile = childProcess.execFile
  const prevExec = childProcess.exec

  const patchedSpawn = function spawnWithHiddenWindows(file, args, options) {
    let argv = args
    let opts = options
    if (argv !== undefined && argv !== null && !Array.isArray(argv) && typeof argv === 'object') {
      opts = argv
      argv = undefined
    }
    const program = resolveWin32BashProgram(file, process.env)
    const nextOpts = withWin32SpawnOptions(opts)
    return argv === undefined ? spawnImpl(program, nextOpts) : spawnImpl(program, argv, nextOpts)
  }
  patchedSpawn.__idbotsWin32Shim = true

  const patchedExecFile = function execFileWithHiddenWindows(file, args, options, callback) {
    const program = resolveWin32BashProgram(file, process.env)
    if (typeof args === 'function') {
      return execFileImpl(program, [], withWin32SpawnOptions(undefined), args)
    }
    if (!Array.isArray(args)) {
      if (typeof options === 'function') {
        return execFileImpl(program, [], withWin32SpawnOptions(args), options)
      }
      return execFileImpl(program, [], withWin32SpawnOptions(args), callback)
    }
    if (typeof options === 'function') {
      return execFileImpl(program, args, withWin32SpawnOptions(undefined), options)
    }
    return execFileImpl(program, args, withWin32SpawnOptions(options), callback)
  }
  patchedExecFile.__idbotsWin32Shim = true

  const patchedExec = function execWithHiddenWindows(command, options, callback) {
    if (typeof options === 'function') {
      return execImpl(command, withWin32SpawnOptions(undefined), options)
    }
    return execImpl(command, withWin32SpawnOptions(options), callback)
  }
  patchedExec.__idbotsWin32Shim = true

  childProcess.spawn = patchedSpawn
  childProcess.execFile = patchedExecFile
  childProcess.exec = patchedExec
  syncBuiltinESMExports()

  return () => {
    childProcess.spawn = prevSpawn
    childProcess.execFile = prevExecFile
    childProcess.exec = prevExec
    syncBuiltinESMExports()
  }
}
