import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeRequire = createRequire(import.meta.url)

const importUrl = (specifier, baseUrl) => {
  if (specifier.startsWith('file:')) return specifier
  if (path.isAbsolute(specifier)) return pathToFileURL(specifier).href
  if (specifier.startsWith('.')) return new URL(specifier, baseUrl).href
  return pathToFileURL(runtimeRequire.resolve(specifier)).href
}

/** Electron versions unsupported by node-addon-require-builtin still need a
 * resolver anchored in this package, never in the userData config directory. */
export const installPortableModuleLoader = (ctx) => {
  if (ctx.loader.internal) return false
  ctx.loader.internal = {
    import: (specifier, baseUrl) => import(importUrl(specifier, baseUrl)),
  }
  return true
}
