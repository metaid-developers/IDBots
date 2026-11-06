// IDBots DSH runtime bin: boots the composed plugin tree and keeps the process
// alive. Spawned and supervised by the Electron main process; stdin/stdout
// belong to the JSON-RPC protocol owned by idbots-sdk-server.
//
// Usage: node bin.mjs <path-to-cordis.yml|json>
//
// The config path may live anywhere (the app writes generated configs into
// userData): bare package names resolve against THIS directory's node_modules
// via bareModuleBaseUrl, and generated configs reference our plugins by
// absolute path.

import path from 'node:path'
import { installWin32SpawnShim } from './lib/win32-spawn-shim.mjs'
import { installPortableModuleLoader } from './lib/portable-module-loader.mjs'
import { boot } from '@deepseek-ai/dsh-app-boot'

installWin32SpawnShim()

const configPath = process.argv[2]
if (!configPath) {
  process.stderr.write('idbots-dsh-runtime: config path required\n')
  process.exit(2)
}

const moduleBase = new URL('.', import.meta.url)
const ctx = await boot(
  'idbots-dsh-runtime',
  path.resolve(configPath),
  undefined,
  (ctx) => { installPortableModuleLoader(ctx) },
  moduleBase.href,
)
process.stderr.write(`[idbots-dsh-runtime] booted ${path.resolve(configPath)}\n`)

const keepalive = setInterval(() => {}, 1 << 30)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { clearInterval(keepalive); process.exit(0) })
}

// Parent-death self-clean: the JSON-RPC stdin pipe EOFs when the spawning
// main process dies without closing us (crash, SIGKILL). Without this, the
// keepalive above pins the event loop and the orphaned runtime keeps every
// session write lock (flock) it holds — the next app instance then wedges on
// `session "<id>" is already owned by an active write handle` for each of
// those sessions until the orphan is reaped by hand. On EOF, dispose the root
// context (write handles flush and release their flocks) and exit; the
// backstop timer covers a wedged dispose.
let orphanExitStarted = false
const exitOnParentGone = () => {
  if (orphanExitStarted) return
  orphanExitStarted = true
  clearInterval(keepalive)
  const backstop = setTimeout(() => process.exit(0), 10_000)
  backstop.unref()
  Promise.resolve(ctx.root.fiber.dispose()).finally(() => process.exit(0))
}
for (const event of ['end', 'close', 'error']) {
  process.stdin.on(event, exitOnParentGone)
}
