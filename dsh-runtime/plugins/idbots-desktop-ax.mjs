// idbots-desktop-ax: AX-first desktop locate with a visual fallback, mounted
// ONLY when the host opts a bot into computer use.
//
// Why this plugin exists: the mounted cua-driver backend locates targets by
// pixels (screenshot → model reads a coordinate → click that coordinate), and a
// few points of error clicks the neighbouring row. macOS publishes the same
// window's accessibility (AX) tree, so a control with a role and a name can be
// addressed semantically instead — and a semantic AX press never moves the
// user's physical pointer, which is exactly the direction the route guard
// (idbots-cu-route-guard) already enforces.
//
// Two layers, one decision point:
//   1. AX  — one targeted `find`, then ONE `click`/`type`/`set-value`/`scroll`
//            that also carries the post-condition wait: the whole
//            read → act → verify round trip is TWO process calls and never a
//            full `snapshot`.
//   2. Visual — when AX has no match (canvas, game surface, custom-drawn
//            control) or cannot be read at all, capture the window with the
//            CLI's own `screenshot` and hand back the image path plus the
//            geometry the model needs to pick a point. Delivery stays with the
//            existing background pixel tool; this plugin never moves the pointer.
//
// Mounted by dsh-runtime/lib/generate-runtime-config.mjs inside the same
// `input.computerUse === true` branch as the cua driver, so the MetaBot editor's
// "desktop control (experimental)" switch turns it on and off with everything
// else. Nothing here requests OS permissions.
//
// Path A note (measured, do not retry): agent-desktop@1.1.0 is a pure prebuilt
// CLI — no main/exports, no .node/.dylib, the shipped binary is MH_EXECUTE.
// `require('agent-desktop')` throws MODULE_NOT_FOUND, so a child process is the
// only integration seam.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'idbots-desktop-ax'
export const inject = ['tools', 'systemPrompt']

export const TOOL_NAME = 'desktop_ax'

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))
/** dsh-runtime/ — the package that owns this plugin and its dependencies. */
export const DEFAULT_RUNTIME_ROOT = path.resolve(PLUGIN_DIR, '..')

/** Env vars that must never reach the CLI child (see resolveBinary + docs). */
const TRAP_ENV_KEYS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING']

/** Bounded retries for a READABLE but empty AX tree (a fresh Chromium window). */
const DEFAULT_EMPTY_READ_RETRIES = 2
/** Bounded retries for a retry-safe CLI error (WINDOW_NOT_FOUND / TIMEOUT). */
const DEFAULT_ERROR_RETRIES = 1
const DEFAULT_RETRY_DELAY_MS = 150
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_WAIT_TIMEOUT_MS = 5000
const RETRYABLE_AX_ERRORS = new Set(['WINDOW_NOT_FOUND', 'TIMEOUT', 'APP_UNRESPONSIVE'])
/** Acting-call read failures worth one read-only re-check before declaring "failed". */
const RETRYABLE_VERIFICATION_ERRORS = new Set(['APP_UNRESPONSIVE', 'TIMEOUT', 'WAIT_TIMEOUT', 'CLI_TIMEOUT'])

// ---------------------------------------------------------------------------
// Binary resolution: AGD_BIN → packaged/runtime resource → PATH
// ---------------------------------------------------------------------------

const platformBinaryName = (platform, arch) => {
  const suffix = platform === 'win32' ? `.exe` : ''
  return `agent-desktop-${platform}-${arch}${suffix}`
}

const executableNames = (platform) => (
  platform === 'win32'
    ? ['agent-desktop.exe', 'agent-desktop']
    : ['agent-desktop']
)

function isExecutableFile(candidate, platform) {
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return false
    if (platform === 'win32') return true
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Candidate binary paths in priority order.
 *
 * ① AGD_BIN — an explicit override, trusted first (and reported as such).
 * ② runtime/packaged resources — dsh-runtime ships as an electron-builder
 *    extraResources copy, so its node_modules travel with the app:
 *    `<resources>/dsh-runtime/node_modules/agent-desktop/bin/...`. The same
 *    lookup also covers a bare `extraResources/agent-desktop` layout.
 * ③ PATH — a system/global install.
 */
export function agentDesktopCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = options.env ?? process.env
  const runtimeRoot = options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT
  const resourcesPath = options.resourcesPath
    ?? (typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined)

  const binNames = [platformBinaryName(platform, arch), ...executableNames(platform)]
  const candidates = []

  if (typeof env.AGD_BIN === 'string' && env.AGD_BIN.trim().length > 0) {
    candidates.push({ path: env.AGD_BIN.trim(), source: 'AGD_BIN' })
  }
  for (const root of [runtimeRoot, resourcesPath ? path.join(resourcesPath, 'dsh-runtime') : null]) {
    if (typeof root !== 'string' || root.length === 0) continue
    for (const binName of binNames) {
      candidates.push({
        path: path.join(root, 'node_modules', 'agent-desktop', 'bin', binName),
        source: 'runtime-dependency',
      })
    }
  }
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    for (const binName of binNames) {
      candidates.push({ path: path.join(resourcesPath, 'agent-desktop', 'bin', binName), source: 'packaged-resource' })
    }
  }
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const binName of binNames) {
      candidates.push({ path: path.join(dir, binName), source: 'PATH' })
    }
  }
  return candidates
}

export class AgentDesktopBinaryError extends Error {
  constructor(looked) {
    const lines = looked.map((entry) => `  - [${entry.source}] ${entry.path}`)
    super([
      'agent-desktop CLI not found — computer use cannot start.',
      'Looked for the binary at:',
      ...lines,
      'Fix one of these ways:',
      '  1) Install the bundled dependency:   pnpm --dir dsh-runtime add agent-desktop',
      '     (its postinstall downloads the per-platform binary, ~29 MB)',
      '  2) Point at an existing binary:      export AGD_BIN=/absolute/path/to/agent-desktop',
      '  3) Put it on PATH:                   npm i -g agent-desktop',
    ].join('\n'))
    this.name = 'AgentDesktopBinaryError'
    this.code = 'AGENT_DESKTOP_NOT_FOUND'
    this.looked = looked
  }
}

/**
 * Resolve the CLI. Fails loudly with the full candidate list instead of
 * degrading into "no such file or directory" from deep inside a spawn.
 */
export function resolveAgentDesktopBin(options = {}) {
  const platform = options.platform ?? process.platform
  const looked = agentDesktopCandidates(options)
  for (const candidate of looked) {
    if (isExecutableFile(candidate.path, platform)) {
      return { bin: candidate.path, source: candidate.source, looked }
    }
  }
  // AGD_BIN set but unusable is a configuration error, not a missing install:
  // say so explicitly instead of silently falling through to PATH.
  const env = options.env ?? process.env
  if (typeof env.AGD_BIN === 'string' && env.AGD_BIN.trim().length > 0) {
    const error = new AgentDesktopBinaryError(looked)
    error.message = `AGD_BIN is set to ${env.AGD_BIN} but it is not an executable file.\n${error.message}`
    throw error
  }
  throw new AgentDesktopBinaryError(looked)
}

/** Child environment without the Electron-as-node trap inherited from the host. */
export function sanitizeCliEnv(env = process.env) {
  const next = { ...env }
  for (const key of TRAP_ENV_KEYS) delete next[key]
  return next
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

export function createCliRunner(options = {}) {
  const bin = options.bin
  const env = sanitizeCliEnv(options.env ?? process.env)
  return async (argv, timeoutMs) => {
    const started = Date.now()
    return await new Promise((resolve) => {
      execFile(bin, argv, { timeout: Math.max(1000, timeoutMs), maxBuffer: 16 * 1024 * 1024, env, windowsHide: true }, (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({
          exitCode: code,
          stdout: stdout || '',
          stderr: stderr || (error ? String(error.message) : ''),
          ms: Date.now() - started,
          timedOut: Boolean(error && error.killed),
        })
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Envelope parsing — readable-empty and error must never be conflated
// ---------------------------------------------------------------------------

export function parseFindEnvelope(stdout) {
  let envelope
  try {
    envelope = JSON.parse(String(stdout || '').trim())
  } catch (error) {
    return {
      ok: false,
      match: null,
      totalMatches: 0,
      snapshotId: null,
      errorCode: 'UNPARSEABLE_ENVELOPE',
      errorMessage: error instanceof Error ? error.message : String(error),
      disposition: null,
    }
  }
  const data = envelope?.data ?? null
  const error = envelope?.error ?? null
  const single = data?.match ?? null
  const many = Array.isArray(data?.matches) ? data.matches : null
  const picked = single ?? (many && many.length > 0 ? many[0] : null)
  const total = typeof data?.total_matches === 'number'
    ? data.total_matches
    : many
      ? many.length
      : picked
        ? 1
        : 0
  return {
    ok: envelope?.ok === true,
    match: picked ? matchOf(picked) : null,
    totalMatches: total,
    snapshotId: typeof data?.snapshot_id === 'string' ? data.snapshot_id : null,
    errorCode: typeof error?.code === 'string' ? error.code : null,
    errorMessage: typeof error?.message === 'string' ? error.message : null,
    disposition: error?.disposition
      ? {
          delivery: typeof error.disposition.delivery === 'string' ? error.disposition.delivery : null,
          retry: typeof error.disposition.retry === 'string' ? error.disposition.retry : null,
        }
      : null,
  }
}

export function parseActEnvelope(stdout) {
  let envelope
  try {
    envelope = JSON.parse(String(stdout || '').trim())
  } catch {
    return { matchedSelector: null, snapshotId: null, delivered: false, disposition: null }
  }
  const data = envelope?.data ?? null
  const after = data?.after_action ?? null
  const disposition = after?.disposition ?? envelope?.error?.disposition ?? null
  return {
    matchedSelector: typeof data?.matched_selector === 'string' ? data.matched_selector : null,
    snapshotId: typeof data?.snapshot_id === 'string' ? data.snapshot_id : null,
    delivered: Array.isArray(after?.steps) && after.steps.some((step) => step?.outcome === 'succeeded'),
    disposition: disposition
      ? {
          delivery: typeof disposition.delivery === 'string' ? disposition.delivery : null,
          retry: typeof disposition.retry === 'string' ? disposition.retry : null,
        }
      : null,
  }
}

function boundsOf(value) {
  if (!value || typeof value !== 'object') return null
  const { x, y, width, height } = value
  if ([x, y, width, height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
  return { x, y, width, height }
}

function matchOf(node) {
  return {
    ref: typeof node?.ref_id === 'string' && node.ref_id ? node.ref_id : null,
    role: typeof node?.role === 'string' ? node.role : null,
    name: typeof node?.name === 'string' ? node.name : null,
    value: typeof node?.value === 'string' ? node.value : null,
    path: Array.isArray(node?.path) ? node.path.filter((p) => typeof p === 'string') : [],
    interactive: node?.interactive === true,
    bounds: boundsOf(node?.bounds),
  }
}

export const selectorOf = (expect) => `${expect.role || 'statictext'}:${expect.text}`

export function findArgv(query) {
  const argv = ['find']
  if (query.windowId) argv.push('--window-id', query.windowId)
  else if (query.app) argv.push('--app', query.app)
  if (query.role) argv.push('--role', query.role)
  if (query.text) argv.push('--text', query.text)
  if (query.name) argv.push('--name', query.name)
  if (query.exact) argv.push('--exact')
  argv.push('--first')
  return argv
}

export function actionArgv(input, ref) {
  const timeout = String(Math.max(0, Math.round(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)))
  switch (input.action) {
    case 'type':
      return ['type', ref, String(input.value ?? ''), '--timeout-ms', timeout]
    case 'set-value':
      return ['set-value', ref, String(input.value ?? ''), '--timeout-ms', timeout]
    case 'scroll':
      return [
        'scroll',
        ref,
        '--direction',
        input.direction || 'down',
        '--amount',
        String(Math.max(1, Math.round(input.amount ?? 1))),
        '--timeout-ms',
        timeout,
      ]
    case 'click':
    default:
      return ['click', ref, '--timeout-ms', timeout]
  }
}

// ---------------------------------------------------------------------------
// The locator (AX first, visual fallback)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DesktopAxLocator {
  constructor(options) {
    this.run = options.run
    this.bin = options.bin ?? 'agent-desktop'
    this.emptyReadRetries = options.emptyReadRetries ?? DEFAULT_EMPTY_READ_RETRIES
    this.errorRetries = options.errorRetries ?? DEFAULT_ERROR_RETRIES
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.defaultWaitTimeoutMs = options.defaultWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    this.sleepImpl = options.sleep ?? sleep
  }

  async invoke(argv, timeoutMs) {
    const raw = await this.run(argv, timeoutMs)
    const parsed = parseFindEnvelope(raw.stdout)
    return {
      call: {
        argv: [this.bin, ...argv],
        ms: raw.ms,
        exitCode: raw.exitCode,
        ok: parsed.ok && !raw.timedOut,
        errorCode: raw.timedOut ? 'CLI_TIMEOUT' : parsed.errorCode,
        errorMessage: parsed.errorMessage ?? (raw.stderr.trim() || null),
        disposition: parsed.disposition,
      },
      stdout: raw.stdout,
    }
  }

  /** Layer 1: resolve only. ONE call on a hit. */
  async locate(query) {
    const argv = findArgv(query)
    const calls = []
    let attempts = 0
    let emptyRetries = 0
    let errorRetries = 0
    let lastDetail = ''

    for (;;) {
      attempts += 1
      const { call, stdout } = await this.invoke(argv, this.defaultTimeoutMs + 5000)
      calls.push(call)
      const parsed = parseFindEnvelope(stdout)

      if (call.ok && parsed.match) {
        return {
          layer: 'ax',
          match: parsed.match,
          snapshotId: parsed.snapshotId,
          attempts,
          retriedFromEmpty: emptyRetries > 0,
          calls,
        }
      }

      if (call.ok) {
        // Readable but empty: the tree answered and the element is not in it.
        lastDetail = `find returned a readable empty result (total_matches=${parsed.totalMatches}) for ${JSON.stringify(query)}`
        if (emptyRetries < this.emptyReadRetries) {
          emptyRetries += 1
          await this.sleepImpl(this.retryDelayMs)
          continue
        }
        return this.visualOutcome('no_ax_match', lastDetail, attempts, calls, query)
      }

      // Unreadable: an error, kept distinct from "no match".
      lastDetail = `${call.errorCode || 'AX_ERROR'}: ${call.errorMessage || 'AX read failed'}`
      const retrySafe = call.disposition?.retry === 'safe'
        || (call.disposition === null && RETRYABLE_AX_ERRORS.has(call.errorCode || ''))
      if (retrySafe && errorRetries < this.errorRetries) {
        errorRetries += 1
        await this.sleepImpl(this.retryDelayMs)
        continue
      }
      const reason = emptyRetries > 0 ? 'ax_empty_after_retry' : 'ax_unavailable'
      return this.visualOutcome(reason, lastDetail, attempts, calls, query)
    }
  }

  /** Layer 1 + 2 for one action; two process calls on the AX path. */
  async perform(input) {
    const located = await this.locate(input.query)
    if (located.layer === 'visual') {
      return this.visualAction(input, located.reason, located.detail, located.calls, located.observation)
    }

    const { match } = located
    if (!match.ref) {
      return this.visualAction(
        input,
        'no_ax_match',
        `AX matched ${match.role || 'an element'} without an addressable ref (path: ${match.path.join(' > ') || 'n/a'})`,
        located.calls,
        null,
      )
    }

    const argv = actionArgv(input, match.ref)
    const expect = input.expect
    if (expect) {
      argv.push(
        '--wait-for',
        selectorOf(expect),
        '--wait-timeout',
        String(Math.max(1, Math.round(input.waitTimeoutMs ?? this.defaultWaitTimeoutMs))),
      )
    }
    const { call, stdout } = await this.invoke(
      argv,
      (input.timeoutMs ?? this.defaultTimeoutMs) + (input.waitTimeoutMs ?? this.defaultWaitTimeoutMs) + 10000,
    )
    const calls = [...located.calls, call]
    const acted = parseActEnvelope(stdout)

    let verification
    if (!expect) {
      verification = { state: 'unverified', detail: 'no expectation supplied: the post-condition was never read back' }
    } else if (acted.matchedSelector === selectorOf(expect)) {
      verification = { state: 'verified', selector: acted.matchedSelector, snapshotId: acted.snapshotId }
    } else if (!call.ok) {
      verification = {
        state: 'failed',
        selector: selectorOf(expect),
        errorCode: call.errorCode,
        detail: call.errorMessage || 'the CLI did not observe the post-condition',
      }
      // A transient read failure (the app's AX surface answered incompletely,
      // or the wait timed out) is NOT the same as "the action did not land": the
      // press may well have been delivered. Re-read once, read-only, before
      // calling it failed — the extra spawn happens only on this path, so the
      // two-call budget of the happy path is untouched.
      if (RETRYABLE_VERIFICATION_ERRORS.has(call.errorCode || '')) {
        const reread = await this.invoke(
          findArgv({ windowId: input.query.windowId, app: input.query.app, role: expect.role || 'statictext', text: expect.text, exact: true }),
          this.defaultTimeoutMs + 5000,
        )
        calls.push(reread.call)
        const rereadParsed = parseFindEnvelope(reread.stdout)
        if (rereadParsed.ok && rereadParsed.match) {
          verification = {
            state: 'verified',
            selector: selectorOf(expect),
            snapshotId: rereadParsed.snapshotId,
            recoveredAfter: call.errorCode,
          }
        }
      }
    } else {
      verification = {
        state: 'failed',
        selector: selectorOf(expect),
        errorCode: null,
        detail: `the CLI returned ok without matching ${selectorOf(expect)}`,
      }
    }

    return {
      layer: 'ax',
      action: input.action,
      ref: match.ref,
      match,
      delivered: acted.delivered || verification.state === 'verified' || (acted.disposition?.delivery || '').startsWith('delivered'),
      delivery: acted.disposition,
      verification,
      snapshotId: acted.snapshotId,
      observation: null,
      clickPoint: null,
      calls,
    }
  }

  /**
   * Visual fallback: capture the window with the CLI's own screenshot and hand
   * back the geometry. No pointer movement, no synthetic input — the caller
   * clicks through the existing background pixel tool.
   */
  async observeVisual(query) {
    const argv = ['screenshot', '--window-id', query.windowId]
    const outPath = path.join(os.tmpdir(), `idbots-desktop-ax-${Date.now()}.png`)
    argv.push(outPath)
    const shot = await this.invoke(argv, 15000)
    const shotData = (() => {
      try {
        return JSON.parse(shot.stdout)?.data ?? null
      } catch {
        return null
      }
    })()
    let bounds = null
    try {
      const listArgv = ['list-windows']
      if (typeof query.app === 'string' && query.app.length > 0) listArgv.push('--app', query.app)
      const listed = await this.invoke(listArgv, 8000)
      const windows = JSON.parse(listed.stdout)?.data
      const found = Array.isArray(windows) ? windows.find((w) => w.id === query.windowId) : null
      bounds = found ? boundsOf(found.bounds) : null
    } catch {
      bounds = null
    }
    return {
      path: typeof shotData?.path === 'string' ? shotData.path : null,
      width: typeof shotData?.width === 'number' ? shotData.width : null,
      height: typeof shotData?.height === 'number' ? shotData.height : null,
      scaleFactor: typeof shotData?.scale_factor === 'number' ? shotData.scale_factor : null,
      bounds,
      bytes: shotData?.path && fs.existsSync(shotData.path) ? fs.statSync(shotData.path).size : 0,
      call: shot.call,
    }
  }

  async visualOutcome(reason, detail, attempts, calls, query) {
    let observation = null
    let note = detail
    try {
      observation = await this.observeVisual(query)
    } catch (error) {
      note = `${detail}; visual capture failed: ${error instanceof Error ? error.message : String(error)}`
    }
    return { layer: 'visual', reason, detail: note, attempts, calls, observation }
  }

  async visualAction(input, reason, detail, calls, existing) {
    let observation = existing ?? null
    let note = detail
    if (!observation) {
      try {
        observation = await this.observeVisual(input.query)
      } catch (error) {
        note = `${detail}; visual capture failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return {
      layer: 'visual',
      action: input.action,
      reason,
      detail: note,
      observation,
      // A window-local point is only meaningful with the window geometry; the
      // model supplies one after reading the image, and delivery stays with the
      // existing background pixel tool.
      clickPoint: input.point ?? null,
      delivery: null,
      calls,
    }
  }
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

const PARAMETERS = {
  action: {
    type: 'string',
    enum: ['locate', 'click', 'type', 'set-value', 'scroll'],
    description: 'locate = resolve only; the others act and (with expect_text) verify inside the same process call.',
  },
  window_id: { type: 'string', description: 'agent-desktop window id from list_windows (e.g. "w-697046"); preferred over app.' },
  app: { type: 'string', description: 'Application display name when no window_id is known.' },
  role: { type: 'string', description: 'AX role to match (button, textfield, statictext, checkbox ...).' },
  query_text: { type: 'string', description: 'Match name, value, title or description of the target.' },
  query_name: { type: 'string', description: 'Match the accessible name/label.' },
  exact: { type: 'boolean', description: 'Require case-insensitive exact matches.' },
  value: { type: 'string', description: 'Payload for action=type or action=set-value.' },
  direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default down).' },
  amount: { type: 'integer', description: 'Scroll wheel notches (default 1).' },
  expect_role: { type: 'string', description: 'Role of the post-condition element; defaults to statictext.' },
  expect_text: { type: 'string', description: 'Text that must appear after the action (the read-back proof, e.g. "count=1"). Without it the action is unverified.' },
  point_x: { type: 'number', description: 'Visual fallback only: window-local X you read off the screenshot.' },
  point_y: { type: 'number', description: 'Visual fallback only: window-local Y you read off the screenshot.' },
  timeout_ms: { type: 'integer', description: 'Ref-resolution/actionability budget in ms (default 5000).' },
  wait_timeout_ms: { type: 'integer', description: 'Post-condition wait budget in ms (default 5000).' },
}

// Kept permissive on purpose: the kernel validates the returned value against
// this schema and renders it through `render`, while every diagnostic rides the
// rendered text. A narrow schema here would turn a legitimate null (e.g. no
// screenshot on the AX path) into a tool failure.
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function summarize(outcome) {
  const calls = Array.isArray(outcome?.calls)
    ? outcome.calls.map((call) => ({
        argv: (call.argv || []).slice(1),
        ms: call.ms,
        ok: call.ok,
        errorCode: call.errorCode,
      }))
    : []
  const observation = outcome?.observation ?? null
  return {
    layer: outcome.layer,
    action: outcome.action ?? 'locate',
    verified: outcome.verification ? outcome.verification.state : null,
    verification: outcome.verification ?? null,
    ref: outcome.ref ?? null,
    reason: outcome.reason ?? null,
    detail: outcome.detail ?? null,
    calls: calls.length,
    callLog: calls,
    clickPoint: outcome.clickPoint ?? null,
    screenshotPath: observation?.path ?? null,
    screenshot: observation
      ? {
          path: observation.path,
          widthPx: observation.width,
          heightPx: observation.height,
          scaleFactor: observation.scaleFactor,
          windowBoundsPoints: observation.bounds,
          bytes: observation.bytes,
        }
      : null,
  }
}

export function formatSummary(summary) {
  const lines = [
    `layer=${summary.layer}${summary.action ? ` action=${summary.action}` : ''}`
      + `${summary.verified ? ` verified=${summary.verified}` : ''} calls=${summary.calls}`,
  ]
  if (summary.ref) lines.push(`ref=${summary.ref}`)
  if (summary.reason) lines.push(`fallback reason=${summary.reason}`)
  if (summary.verification?.detail) lines.push(`verification: ${summary.verification.detail}`)
  if (summary.detail) lines.push(`detail: ${summary.detail}`)
  if (summary.screenshot) {
    const shot = summary.screenshot
    lines.push(
      `screenshot: ${shot.path} (${shot.widthPx}x${shot.heightPx}px, scaleFactor=${shot.scaleFactor})`
        + `${shot.windowBoundsPoints ? ` window=${JSON.stringify(shot.windowBoundsPoints)} points` : ''}`,
    )
    lines.push('AX cannot see this control, so pick the point from the screenshot and click it with the background pixel tool, then verify with a fresh read.')
  }
  lines.push(`call log: ${JSON.stringify(summary.callLog)}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Plugin apply
// ---------------------------------------------------------------------------

export function buildDesktopAxTool(options) {
  const getBin = options.resolveBin
  const makeLocator = options.makeLocator

  const locatorFor = () => {
    const resolved = getBin()
    const run = options.run ?? createCliRunner({ bin: resolved.bin })
    const locator = makeLocator({ run, bin: resolved.bin })
    return { locator, resolved }
  }

  return {
    name: TOOL_NAME,
    description: [
      'Operate a desktop app through the macOS accessibility (AX) tree, with a screenshot fallback.',
      'AX-first: pass window_id (from list_windows) plus role and query_text and the element is resolved semantically — no pixel guessing, no focus steal, no pointer movement.',
      'A full read → act → verify round trip costs two CLI calls: one targeted find, then one acting call that also waits for the post-condition (expect_text). Always pass expect_text for a mutating action; without it the result is reported unverified.',
      'When AX has no match (canvas, game surface, custom-drawn control) the result is layer="visual" with a screenshot path and its geometry; pick the point from the image and use the existing background pixel tool.',
    ].join(' '),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' ? value.text : JSON.stringify(value),
      }],
    },
    execute: async (args, exec) => {
      const query = {
        windowId: typeof args?.window_id === 'string' && args.window_id.trim() ? args.window_id.trim() : undefined,
        app: typeof args?.app === 'string' && args.app.trim() ? args.app.trim() : undefined,
        role: typeof args?.role === 'string' && args.role.trim() ? args.role.trim() : undefined,
        text: typeof args?.query_text === 'string' && args.query_text.trim() ? args.query_text.trim() : undefined,
        name: typeof args?.query_name === 'string' && args.query_name.trim() ? args.query_name.trim() : undefined,
        exact: args?.exact === true,
      }
      if (!query.windowId && !query.app) {
        throw new Error('desktop_ax requires window_id (preferred) or app: call list_windows first.')
      }
      const action = args?.action ?? 'locate'
      const { locator, resolved } = locatorFor()

      if (action === 'locate') {
        const located = await locator.locate(query)
        const summary = summarize(located)
        summary.binary = resolved.source
        return { text: formatSummary(summary), ...summary }
      }

      const expect = typeof args?.expect_text === 'string' && args.expect_text.trim()
        ? { role: typeof args?.expect_role === 'string' && args.expect_role.trim() ? args.expect_role.trim() : undefined, text: args.expect_text.trim() }
        : undefined
      const outcome = await locator.perform({
        action,
        query,
        value: args?.value,
        direction: args?.direction,
        amount: typeof args?.amount === 'number' ? args.amount : undefined,
        expect,
        timeoutMs: typeof args?.timeout_ms === 'number' ? args.timeout_ms : undefined,
        waitTimeoutMs: typeof args?.wait_timeout_ms === 'number' ? args.wait_timeout_ms : undefined,
        point: typeof args?.point_x === 'number' && typeof args?.point_y === 'number'
          ? { x: args.point_x, y: args.point_y }
          : null,
      })
      const summary = summarize(outcome)
      summary.binary = resolved.source
      return { text: formatSummary(summary), ...summary }
    },
  }
}

export function apply(ctx, options = {}) {
  const tool = buildDesktopAxTool({
    resolveBin: options.resolveBin ?? (() => resolveAgentDesktopBin(options.resolve ?? {})),
    makeLocator: options.makeLocator ?? (({ run, bin }) => new DesktopAxLocator({ run, bin })),
    run: options.run,
  })
  ctx.tools.register(tool)
  ctx.systemPrompt.section({
    name: 'idbots:desktop-ax',
    order: 149,
    text: [
      'Desktop control has an AX-first layer (desktop_ax). Use it BEFORE pixel work:',
      '- Resolve with window_id + role + query_text; a control with a role and a name is addressed semantically, no coordinates.',
      '- Pass expect_text on every mutating action: the same CLI call waits for that text and reports verified / failed / unverified. Never claim an unverified action worked.',
      '- layer="visual" means AX cannot see the control (canvas, game, custom-drawn). Read the returned screenshot, choose the point, click it with the background pixel tool, then confirm with a fresh read.',
      '- This layer never moves the physical pointer and has no foreground/desktop/drag/modifier routes; the cua route guard still applies to the pixel tools.',
    ].join('\n'),
  })
  return tool
}

export default { name, inject, apply }
