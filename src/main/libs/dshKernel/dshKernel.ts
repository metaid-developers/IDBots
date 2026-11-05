// DSH kernel adapter (Phase 1 M4): owns the DSH runtime subprocess and exposes
// the kernel-agnostic turn/control surface for cowork sessions.
//
// Lifecycle: ensureRuntime() generates the composition (provider table +
// prompt sections via dsh-runtime/lib/generate-runtime-config.mjs), writes it
// next to the session root, and spawns `node bin.mjs <config>` — in Electron
// the binary runs with ELECTRON_RUN_AS_NODE=1 so the packaged app needs no
// extra Node runtime. Credentials ride the child env (apiKeyEnv names), never
// the config file.
//
// Wire: @deepseek-ai/dsh-sdk-client (ESM, dynamic-imported like the Claude
// SDK) against idbots-sdk-server's extensions: session/ensure (create-or-
// resume + per-session provider route), session/steer, session/cancel,
// idbots/approval/respond.
//
// Events: session.event envelopes flow through DshEventMapper into the host's
// handlers — the same message/streaming/turn contract handleClaudeEvent
// produces for the Claude kernel.

import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { resolveElectronExecutablePath } from '../runtimePaths'
import { mergeDshRuntimeProcessEnv } from '../windowsPathEnv'
import { DshEventMapper } from './dshEventMapper'
import { currentClientTimeZone } from './clientTimeZone'
import type {
  DshApprovalAsk,
  DshHostToolImagePayload,
  DshKernelHandlers,
  DshUsageProjectionResult,
  DshUserQuestionAsk,
  DshMapperAction,
  DshRuntimeConfigInput,
  DshSessionEventEnvelope,
  DshStreamSlot,
} from './types'

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>

export const DSH_PUMP_YIELD_EVERY = 8

/** Fingerprint of the jsonl persistence backend's encoding-uniformity
 *  rejection ("…uses .jsonl[.zstd], but this backend is configured for
 *  compression …"). Upstream error message — stable substring, upstream
 *  error fingerprints are the one sanctioned class of text matching. */
export function isSessionEncodingMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('but this backend is configured for compression')
}

/** Composition JSON filename. Each provider-keyed runtime writes its own file
 *  so two kernels sharing sessionRoot cannot clobber each other. */
export function dshRuntimeConfigFileName(runtimeId?: string): string {
  if (!runtimeId) return 'cordis.runtime.json'
  const safe = String(runtimeId).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return `cordis.runtime.${safe || 'default'}.json`
}

export interface DshKernelOptions {
  /** Directory containing bin.mjs + node_modules (defaults: repo dsh-runtime/). */
  runtimeDir?: string
  /** Node executable override (tests). Defaults to resolveElectronExecutablePath(). */
  nodePath?: string
  handlers: DshKernelHandlers
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void
  /**
   * Assistant chat-experience mode getter, handed to every session's
   * DshEventMapper and evaluated per stream-hold decision — the mode can flip
   * mid-session while mappers stay alive. Receives the DSH session id so
   * the host can scope the experience to specific sessions (owner chats);
   * absent means professional stream behavior.
   */
  assistantModeProvider?: (dshSessionId: string) => boolean
}

export class DshKernel {
  private readonly opts: DshKernelOptions
  private client: any = null
  private pump: Promise<void> | null = null
  private mappers = new Map<string, DshEventMapper>()
  private slotIds = new Map<string, Partial<Record<DshStreamSlot, string>>>()
  private runtimeConfig: DshRuntimeConfigInput | null = null
  private rootMigration: { sessionRoot: string; migrate: (root: string, opts?: unknown) => Promise<unknown> } | null = null
  private closed = false
  private pumpEventsSinceYield = 0

  constructor(opts: DshKernelOptions) {
    this.opts = opts
  }

  get runtimeDir(): string {
    if (this.opts.runtimeDir) return this.opts.runtimeDir
    if (process.env.IDBOTS_DSH_RUNTIME_DIR) return process.env.IDBOTS_DSH_RUNTIME_DIR
    // The main bundle lands at different depths depending on the build: the
    // vite dev bundle sits at dist-electron/main.js while tsc output lives at
    // dist-electron/main/libs/dshKernel/. Probe instead of guessing, with
    // app.getAppPath() (project root in dev) first.
    const candidates = [
      // Packaged builds ship dsh-runtime as an extra resource next to the
      // asar archive — real files on disk, which the spawned runtime needs
      // (asar paths would break module resolution inside the child).
      ...(app.isPackaged ? [join(process.resourcesPath, 'dsh-runtime')] : []),
      join(app.getAppPath(), 'dsh-runtime'),
      join(__dirname, 'dsh-runtime'),
      join(__dirname, '..', 'dsh-runtime'),
      join(__dirname, '..', '..', '..', 'dsh-runtime'),
      join(__dirname, '..', '..', '..', '..', 'dsh-runtime'),
    ]
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'bin.mjs'))) return candidate
    }
    return candidates[0]
  }

  get running(): boolean {
    return this.client !== null && !this.closed
  }

  /** Diagnostics/tests: how many times the runtime process was restarted. */
  restartCount = 0

  /**
   * Timestamp of the newest notification this kernel's pump observed (any
   * session event, status, subagent lifecycle edge — host-turn OR
   * kernel-initiated). The turn hub uses it as the "something is still
   * running on this process" signal that controller-only accounting cannot
   * provide: continuable-subagent turns have no host controller, so a
   * drained/superseded kernel must not be retired (nor in-place-restarted
   * on a config change) while notifications keep flowing (2026-09-28
   * session cluster 540635be/cf70e758/406a8208: two runtimes exited under
   * in-flight turns, exit 0, zero close-side log trails).
   */
  lastNotificationAt = 0

  /**
   * DSH session ids whose agent the runtime currently reports as 'running'
   * (session.status notifications) — host turns AND kernel-initiated turns
   * (subagent-finished wakes, scheduled nudges) alike. The turn hub reads
   * this to hold queue gates closed while a controller-less kernel turn is
   * in flight; cleared with the rest of the process state on restart/death.
   */
  private readonly busySessions = new Set<string>()

  /** In-flight boot promise shared by concurrent ensureRuntime callers. The
   * turn hub serializes its own calls through a per-slot chain, but the crash
   * respawn-once path restarts outside that chain, and `this.client` only
   * appears after the ~20s wire handshake — an unmerged second caller in that
   * window would boot a DUPLICATE runtime; whichever client finished first
   * got dropped without close(), leaking its process while both wrote one
   * sessionRoot. Everyone awaits the same boot; a failure clears the memo so
   * the next caller retries fresh. */
  private ensureInFlight: Promise<void> | null = null

  /** Generate config, spawn the runtime, and perform the wire handshake.
   * Concurrent calls coalesce onto one boot (first caller's config); callers
   * that queued behind the boot re-enter the reuse branch afterwards, so a
   * config change still takes effect through the normal restart path.
   *
   * Contract (kill-safety): with a live runtime this NEVER restarts the
   * process on its own — it reuses it whatever the config says. Applying a
   * config change is the turn hub's decision (in-place restart only when
   * truly idle, successor+drain otherwise); the silent kernel-level restart
   * this method used to perform killed in-flight turns with no log whenever
   * the incoming config JSON drifted from the recorded one. */
  async ensureRuntime(config: DshRuntimeConfigInput): Promise<void> {
    if (this.closed) throw new Error('DshKernel: closed')
    if (this.client) {
      // Reuse the live runtime. Config application is hub-owned.
      return
    }
    if (this.ensureInFlight) {
      await this.ensureInFlight
      return this.ensureRuntime(config)
    }
    const boot = this.bootRuntime(config)
    this.ensureInFlight = boot
    try {
      await boot
    } finally {
      this.ensureInFlight = null
    }
  }

  /**
   * True when a notification arrived within the grace window — i.e. the
   * process showed observable activity too recently to be retired or
   * restarted underneath. Kernel-side turns stream constantly while they
   * work; total silence for the whole window means nothing observable is
   * running (long provider-side waits still stream status/usage edges, and
   * host-controller turns are protected separately by the hub's controller
   * accounting).
   */
  hasRecentActivity(graceMs: number): boolean {
    if (this.lastNotificationAt <= 0) return false
    return Date.now() - this.lastNotificationAt < Math.max(0, graceMs)
  }

  /** True while the runtime reports this session's agent as 'running'
   *  (session.status) — host and kernel-initiated turns alike. */
  isSessionBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId)
  }

  /** Spawn the runtime process and complete the wire handshake — the
   * single-flight body of {@link ensureRuntime}. */
  private async bootRuntime(config: DshRuntimeConfigInput): Promise<void> {
    const runtimeDir = this.runtimeDir
    const binPath = join(runtimeDir, 'bin.mjs')
    if (!existsSync(binPath)) {
      throw new Error(`DshKernel: runtime bin not found at ${binPath} (run pnpm --dir dsh-runtime install)`)
    }

    const generatorUrl = pathToFileURL(join(runtimeDir, 'lib', 'generate-runtime-config.mjs')).href
    const { generateRuntimeConfig } = await dynamicImport(generatorUrl)
    mkdirSync(config.sessionRoot, { recursive: true })
    // 0.1.2 persistence encoding: the jsonl backend refuses a root that mixes
    // physical encodings, so existing plaintext session.jsonl artifacts are
    // migrated onto zstd (atomic per artifact, crash-recoverable) before the
    // runtime boots a zstd composition. A migration failure propagates — the
    // rollback keeps the root uniformly plaintext, but booting 'none' after
    // an fs-level failure would be a silent lie about durability instead.
    const migrationUrl = pathToFileURL(join(runtimeDir, 'lib', 'migrate-session-root-zstd.mjs')).href
    const { migrateSessionRootToZstd } = await dynamicImport(migrationUrl)
    this.rootMigration = { sessionRoot: config.sessionRoot, migrate: migrateSessionRootToZstd }
    await migrateSessionRootToZstd(config.sessionRoot, {
      log: (level, event, data) => this.opts.log?.(level, `dshKernel.${event}`, data),
    })
    // 0.1.x M1 wire wrote turn/end aborts with a bare-string cause ("steer",
    // "cancel"); the 0.1.5 v0→v1 format migration requires an object cause
    // and refuses the WHOLE Session otherwise ("abort cause must be a JSON
    // object"), leaving upgraded users unable to open any session where a
    // turn was steered/cancelled on an old kernel. Sanitize those events in
    // place (original bytes backed up, one-time marker-gated sweep) before
    // the runtime's persistence layer ever opens the root.
    const sanitizerUrl = pathToFileURL(join(runtimeDir, 'lib', 'sanitize-v0-abort-cause.mjs')).href
    const { sanitizeV0AbortCauses } = await dynamicImport(sanitizerUrl)
    await sanitizeV0AbortCauses(config.sessionRoot, {
      log: (level, event, data) => this.opts.log?.(level, `dshKernel.${event}`, data),
    })
    const configPath = join(config.sessionRoot, dshRuntimeConfigFileName(config.runtimeId))
    writeFileSync(configPath, JSON.stringify(generateRuntimeConfig(config), null, 2))
    this.runtimeConfig = config

    const clientUrl = pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js')).href
    const { HarnessClient } = await dynamicImport(clientUrl)
    // dsh-sdk-client 0.1.2 dropped `command`/`args` from HarnessClient options
    // (one-arg construction now resolves and spawns the same-version `dsh`
    // CLI). We launch our own bin; that rides the second constructor argument
    // (RuntimeProcessOptions) — the channel upstream's fake-runtime tests use
    // via createProcessHarnessClient, untyped in the public d.ts.
    const client = new HarnessClient({}, {
      command: this.opts.nodePath ?? resolveElectronExecutablePath(),
      args: [binPath, configPath],
      environment: () => mergeDshRuntimeProcessEnv({ configEnv: config.env }),
      description: 'idbots-dsh-runtime',
      initializeTimeoutMs: 20_000,
    })
    client.start()
    const first = config.providers[0]
    try {
      await client.initialize({
        cwd: config.sessionRoot,
        provider: first.key,
        model: first.models[0]?.id ?? 'default',
      })
    } catch (error) {
      // Boot failures stay loud by design (the fallback brain covers provider
      // outages mid-turn, not a runtime that cannot load its own plugin tree).
      // Name the provider so the user knows which model configuration to
      // inspect; the SDK error already carries the exit code and stderr tail,
      // where a plugin-load rejection names the offending field.
      const runtimeKey = config.runtimeId ?? first?.key ?? 'unknown'
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `DSH runtime for provider "${runtimeKey}" failed to boot. This is usually a provider/model configuration problem (a reasoning or compat setting this wire rejects) or broken runtime dependencies, not a transient network issue. Original error: ${detail}`,
      )
    }

    this.client = client
    this.closed = false
    this.lastNotificationAt = Date.now()
    this.pump = this.pumpNotifications(client)
    this.opts.log?.('info', 'dshKernel.ensureRuntime', { configPath, providers: config.providers.length })
  }

  /** Re-run the plaintext→zstd artifact migration for this kernel's session
   *  root (idempotent). Self-heal path: a sibling app instance on an older
   *  build sharing this userData can drop plaintext artifacts into the root
   *  AFTER this runtime booted — the boot-time migration alone does not see
   *  that drift. No-op before the first ensureRuntime. */
  async remigrateSessionRootToZstd(): Promise<void> {
    if (!this.rootMigration) return
    await this.rootMigration.migrate(this.rootMigration.sessionRoot, {
      log: (level: string, event: string, data: unknown) =>
        this.opts.log?.(level as 'info' | 'warn' | 'error', `dshKernel.${event}`, data),
    })
  }

  /** Ensure a live agent for the session: fresh create or restart-resume. */
  async ensureSession(input: {    sessionId: string
    provider?: string
    model?: string
    maxTokens?: number
    /** DSH/pi-ai ReasoningEffortId (off|low|medium|high|max). */
    reasoningEffort?: string
    sections?: Array<{ name: string; order: number; text: string; interpolate?: false }>
    hostTools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    /** Per-session cowork workspace. Bash/fs resolve relative paths from this
     *  cwd; composition-level plugin cwd stays pinned so cwd churn does not
     *  restart the shared runtime. */
    cwd?: string
  }): Promise<{ resumed: boolean }> {
    this.requireClient()
    return this.client.request('session/ensure', input)
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: DshHostToolImagePayload[]
  ): Promise<{ messageId: string }> {
    this.requireClient()
    // Every prompt rides the idbots/prompt extension: images are committed
    // through the runtime's attachment store, and the client time zone is
    // declared on the user message source so dsh-time-context can resolve the
    // request zone instead of reporting it unavailable (the stock SDK prompt
    // has no zone field that reaches the message source). Without a zone the
    // runtime falls back to the stock prompt path unchanged.
    const clientTimeZone = currentClientTimeZone()
    return this.client.request('idbots/prompt', {
      sessionId,
      text,
      ...(images && images.length > 0 ? { images } : {}),
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    })
  }

  async steer(sessionId: string, text: string): Promise<{ steered: boolean; messageId: string }> {
    this.requireClient()
    return this.client.request('session/steer', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })
  }

  async cancel(
    sessionId: string,
    cause?: string,
    options?: { keepInbox?: boolean }
  ): Promise<{ cancelled: boolean }> {
    this.requireClient()
    return this.client.request('session/cancel', {
      sessionId,
      cause,
      keepInbox: options?.keepInbox === true,
    })
  }

  /** Drain a live agent so another provider-keyed runtime can resume the
   *  same session JSONL. No-op when the process has no agent for this id. */
  async disposeSession(sessionId: string): Promise<{ disposed: boolean }> {
    if (!this.client || !sessionId) return { disposed: false }
    return this.client.request('session/dispose', { sessionId })
  }

  async respondApproval(id: string, outcome: 'allowed-once' | 'rejected'): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/approval/respond', { id, outcome })
  }

  /** Subagent panel: children of a DSH session. */
  async listSubagents(dshSessionId: string): Promise<{ agents: Array<{ agentId: string; status: string; startedAt: number }> }> {
    this.requireClient()
    return this.client.request('idbots/subagents/list', { sessionId: dshSessionId })
  }

  /** Subagent panel: transcript view of one child. */
  async getSubagentMessages(dshSessionId: string, agentId: string, limit?: number): Promise<{ messages: Array<{ id: string; type: string; content: string; timestamp: number }> }> {
    void dshSessionId
    this.requireClient()
    return this.client.request('idbots/subagents/messages', { sessionId: dshSessionId, agentId, limit })
  }

  /**
   * Subagent panel stop for DSH sessions: kernel 'user'-authority interrupt —
   * cancels only the child's current turn; a continuable child stays resident.
   */
  async interruptSubagent(dshSessionId: string, agentId: string): Promise<{ accepted: boolean; reason?: string }> {
    this.requireClient()
    return this.client.request('idbots/subagent/interrupt', { sessionId: dshSessionId, agentId })
  }

  /**
   * Official token-meter session projections for the usage panel (cumulative
   * disjoint token buckets + context pressure/composition). Degrades to
   * { available: false } when the runtime composition lacks the projection
   * registry or the session has no live agent.
   */
  async usageProjection(dshSessionId: string): Promise<DshUsageProjectionResult> {
    this.requireClient()
    return this.client.request('idbots/usage', { sessionId: dshSessionId })
  }

  /**
   * Idle-session native compaction (DSH /compact). Replaces a history span
   * in place on the live agent; does not mint a new session id.
   */
  async compact(dshSessionId: string): Promise<{
    ok: boolean
    compacted?: boolean
    code?: string
    message?: string
    shadowedItemCount?: number
    shadowedTokenCount?: number
  }> {
    this.requireClient()
    return this.client.request('idbots/compact', { sessionId: dshSessionId })
  }

  /**
   * Plan-mode switch (dsh-plan-mode ctx.planMode.set). Must land on the
   * kernel that owns the live agent — the result reports the controller
   * outcome ('committed' | 'queued' | 'cancelled' | 'noop') plus the
   * controller's current { active, pending? } view.
   */
  async planModeSet(
    dshSessionId: string,
    active: boolean,
  ): Promise<{ ok: boolean; result?: string; plan?: { active: boolean; pending?: boolean } }> {
    this.requireClient()
    return this.client.request('idbots/plan-mode/set', { sessionId: dshSessionId, active })
  }

  /** Answer a pending ask_user_question bridged from the runtime. */
  async respondAsk(
    id: string,
    answers: Array<{ id: string; selected: string[]; custom?: string }>
  ): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/ask/respond', { id, answers })
  }

  /** Answer a runtime-native tool policy check. 'review' hands the verdict to
   * the session's own model (0.2.2 headless auto review) — denial is final. */
  async respondPolicy(id: string, decision: 'allow' | 'deny' | 'ask' | 'review', reason?: string): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/policy/respond', { id, decision, reason })
  }

  /** Answer a host tool bridge call. Images commit through the runtime's
   * attachment store and render as image blocks when the route allows. */
  async respondTool(
    id: string,
    result: { ok: true; text: string; images?: DshHostToolImagePayload[] } | { ok: false; error: string }
  ): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/tool/respond', { id, ...result })
  }

  /** Latest usage snapshot for a session (getContextUsage equivalent). */
  usage(sessionId: string) {
    return this.mappers.get(sessionId)?.usage() ?? null
  }

  /** Kill the runtime (sessions persist; ensureRuntime can resume them). */
  async restart(config?: DshRuntimeConfigInput): Promise<void> {
    // client.close() owns the EOF→SIGTERM→SIGKILL ladder and reaps the child;
    // dropping the reference without closing leaks the runtime (its keepalive
    // interval would pin the parent's event loop).
    if (this.client) await this.client.close().catch(() => undefined)
    this.client = null
    this.pump = null
    this.mappers.clear()
    this.slotIds.clear()
    this.busySessions.clear()
    this.runtimeConfig = null
    if (config) {
      this.restartCount += 1
      await this.ensureRuntime(config)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.client) await this.client.close().catch(() => undefined)
    this.client = null
    this.pump = null
  }

  private requireClient(): void {
    if (!this.client) throw new Error('DshKernel: runtime not started (call ensureRuntime first)')
  }

  private async pumpNotifications(client: any): Promise<void> {
    try {
      const subscription = client.subscribe()
      for (;;) {
        const notification = await subscription.next()
        // Every observed notification is process liveness, host-side turn or
        // kernel-initiated alike — feeds hasRecentActivity (see field docs).
        this.lastNotificationAt = Date.now()
        const { method, params } = notification
        if (method === 'session.event') {
          // One bad handler must never kill the whole event stream: contain
          // per-event failures and keep the pump alive.
          try {
            const envelope = params.event as DshSessionEventEnvelope
            // Log-only title events bypass the mapper (it drops unknown types
            // by design) — surface them raw to the host's sidebar-title mirror.
            if (envelope?.type === 'session/title') {
              const title = typeof envelope.data?.title === 'string' ? envelope.data.title.trim() : ''
              const kind = envelope.data?.source?.kind
              if (title && (kind === 'fallback' || kind === 'provider' || kind === 'user')) {
                this.opts.handlers.onSessionTitle?.(params.sessionId, title, kind)
              }
            }
            this.applyEvent(params.sessionId, envelope)
          } catch (error) {
            // Contained per-event failure: log and keep pumping. onError is
            // the FATAL channel (transport death) that settles in-flight turns.
            this.opts.log?.('error', 'dshKernel.eventError', {
              message: error instanceof Error ? error.message : String(error),
              type: (params.event as DshSessionEventEnvelope)?.type,
            })
          }
        } else if (method === 'idbots/approval/request') {
          this.opts.handlers.onApprovalRequest(params.sessionId, params as DshApprovalAsk)
        } else if (method === 'idbots/approval/cancelled') {
          this.opts.handlers.onApprovalCancelled(params.id)
        } else if (method === 'idbots/tool/request') {
          this.opts.handlers.onToolRequest?.(params)
        } else if (method === 'idbots/policy/request') {
          this.opts.handlers.onPolicyRequest?.(params)
        } else if (method === 'idbots/ask/request') {
          const rawQuestions = Array.isArray(params.questions) ? params.questions : []
          const questions = rawQuestions.map((question: any, index: number) => ({
            ...question,
            id: typeof question?.id === 'string' && question.id.trim()
              ? question.id
              : `q-${index + 1}`,
          }))
          this.opts.handlers.onAskRequest?.({ ...params, questions } as DshUserQuestionAsk)
        } else if (method === 'idbots/ask/cancelled') {
          this.opts.handlers.onAskCancelled?.(params.id)
        } else if (method === 'idbots/subagent/started') {
          this.opts.handlers.onSubagentEvent?.({ kind: 'started', ...params })
        } else if (method === 'idbots/subagent/progress') {
          this.opts.handlers.onSubagentEvent?.({ kind: 'progress', ...params })
        } else if (method === 'idbots/subagent/finished') {
          this.opts.handlers.onSubagentEvent?.({ kind: 'finished', ...params })
        } else if (method === 'session.status') {
          if (params.status === 'running') {
            this.busySessions.add(params.sessionId)
          } else {
            this.busySessions.delete(params.sessionId)
          }
          this.opts.handlers.onStatus?.(params.sessionId, params.status)
        }
        // Yield so session-switch / other IPC can run while two sessions
        // stream. The pump is a single sequential loop; without this, handler
        // work (even after persist is deferred) still head-of-line-blocks
        // cowork:session:get.
        this.pumpEventsSinceYield += 1
        if (this.pumpEventsSinceYield >= DSH_PUMP_YIELD_EVERY) {
          this.pumpEventsSinceYield = 0
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    } catch (error) {
      if (!this.closed) {
        // The transport died without our hand (runtime crash/OOM/kill — e.g.
        // the 2026-09-24 spill-ENOENT kernel exit). Drop the dead client so
        // `running` reports false and the next ensureRuntime boots a successor
        // instead of "reusing the live runtime" that no longer exists; the
        // identity guard keeps a superseded pump from nulling a successor's
        // client after restart() already swapped it. The per-process mapper
        // and slot bookkeeping is dead state for a successor process (same
        // contract as restart()) — clear it so the successor's first events
        // cannot fold into stale stream positions. In-flight turns were
        // settled through onError below; requests racing the death reject on
        // the dead client and the turn hub's respawn-once path covers them.
        if (this.client === client) {
          this.client = null
          this.pump = null
          this.mappers.clear()
          this.slotIds.clear()
          this.busySessions.clear()
          this.runtimeConfig = null
        }
        // The transport can reject while the process still hangs (half-dead
        // stdio), so reap this pump's own child through the SDK's
        // EOF→SIGTERM→SIGKILL ladder in the background instead of trusting
        // the exit — idempotent for an already-reaped client, and it never
        // blocks turn settlement.
        try {
          void Promise.resolve(client.close?.()).catch(() => undefined)
        } catch { /* a broken client object must not block settlement either */ }
        this.opts.handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private applyEvent(sessionId: string, envelope: DshSessionEventEnvelope): void {
    if (!sessionId) return
    const mapper = this.mappers.get(sessionId)
      ?? new DshEventMapper({
        // Bind the mapper to ITS session: the provider is re-read per stream-
        // hold decision (live mode flips), always for this dshSessionId.
        assistantMode: () => this.opts.assistantModeProvider?.(sessionId) ?? false,
      })
    this.mappers.set(sessionId, mapper)
    for (const action of mapper.consume(envelope)) {
      this.applyAction(sessionId, action)
    }
  }

  private applyAction(sessionId: string, action: DshMapperAction): void {
    const handlers = this.opts.handlers
    switch (action.kind) {
      case 'message': {
        const id = handlers.onMessage(sessionId, action.message, action.slot)
        if (action.slot) {
          const slots = this.slotIds.get(sessionId) ?? {}
          slots[action.slot] = id
          this.slotIds.set(sessionId, slots)
        }
        break
      }
      case 'messageUpdate': {
        const id = this.slotId(sessionId, action.slot)
        if (id) handlers.onMessageUpdate(sessionId, id, action.content)
        break
      }
      case 'messageFinalize': {
        const id = this.slotId(sessionId, action.slot)
        if (id) handlers.onMessageFinalize(sessionId, id, action.content, action.metadata)
        break
      }
      case 'turnEnd':
        handlers.onTurnEnd(sessionId, action.reason, action.emptyTerminal, action.finalizationRequired, action.fallbackFinalText)
        break
      case 'usage':
        handlers.onUsage(sessionId, action.usage)
        break
    }
  }

  private slotId(sessionId: string, slot: DshStreamSlot): string | undefined {
    return this.slotIds.get(sessionId)?.[slot]
  }
}

