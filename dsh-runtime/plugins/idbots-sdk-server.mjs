// idbots-sdk-server: IDBots' JSON-RPC SDK server for the DSH runtime.
//
// The stock @deepseek-ai/dsh-sdk-jsonrpc-server wires initialize/session/prompt/
// shutdown over stdio and its handleRequest is a closed switch (no extension hook).
// We keep the stock server class — subclassing it, not forking — and take over the
// apply() wiring ourselves so the single stdio transport also dispatches the
// control-plane methods IDBots needs on the wire (Phase 0 verified they are absent
// upstream, report §2 F10/F11):
//
//   session/steer          { sessionId, contentBlocks } → step-boundary steering mid-turn
//   session/cancel         { sessionId, cause?, keepInbox? } → abort active turn with cause
//   session/ensure         { sessionId, provider?, model?, maxTokens?,
//                           reasoningEffort?, cwd? } → live agent for the
//                           session: create fresh, or RESUME when a persisted log exists
//                           (the stock server only lazily creates and would fail on an
//                           existing log after a runtime restart). Also the per-session
//                           provider/model/effort override the stock wire lacks — a live
//                           ensure reapplies the route through the agent/request
//                           waterfall so a mid-conversation model switch actually
//                           reaches the next LLM call (the loop otherwise keeps
//                           seeding from the first-turn session header).
//                           Optional absolute `cwd` is the cowork workspace:
//                           bash/fs resolve relative paths from
//                           session.header.cwd, NOT the composition-level
//                           plugin default (which is pinned once so the
//                           shared runtime does not restart per bot).
//   session/dispose         { sessionId } → drain + unregister a live agent
//                           so another provider-keyed runtime can resume the
//                           same JSONL without a split-brain in-memory agent
//   idbots/approval/respond { id, outcome } → answer a pending approval ask (M2)
//   idbots/ask/respond       { id, answers } → answer a pending user question
//   idbots/usage             { sessionId } → token-meter session projections
//                           (tokenUsage / contextPressure / contextBreakdown)
//   idbots/compact           { sessionId } → idle-session native compactNow
//                           (in-place history replace; no new session id)
//   idbots/ping            → extension presence canary
//
// Notifications we emit (beyond the stock session.event / session.status /
// subagent.* set):
//
//   idbots/approval/request   { id, sessionId, toolName, callId?, reason? }
//   idbots/approval/cancelled { id }
//   idbots/ask/request        { id, sessionId, questions } (ask_user_question)
//   idbots/ask/cancelled      { id }
//
// Plus synthetic 'assistant/chunk' session.event notifications: 0.1.5 moved
// live streaming off the durable feed onto the process-local
// 'agent/assistant-stream' dispatch, so we bridge chunk frames back onto the
// wire in the retired event's shape (see constructor).
//
// Approval bridging: the dsh-user-approval service owns the `approval` seam,
// audit events (approval/asked + approval/decided ride the session feed), and
// the scope-filtered `approval/request` answerer waterfall (default answer
// 'unavailable' = fail-closed). We register the answerer here with { global:
// true } — the waterfall dispatches through the agent's scope carrier, which
// filters ordinary fiber-context listeners out (Phase 0 F5 lesson) — and
// forward each ask to the Electron host over the wire. The service itself
// races the turn's AbortSignal against our answer and discards late replies.

import { isAbsolute, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import * as dshToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as dshToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { reviewPendingAction } from './idbots-auto-review.mjs'

const RESPOND_OUTCOMES = new Set(['allowed-once', 'rejected'])

const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/**
 * Validate the host-supplied client time zone the way dsh-time-context does:
 * UTC or a CANONICAL IANA Area/Location name. Anything else (missing, an
 * abbreviation like "CST", a non-canonical alias) is dropped instead of
 * forwarded — the time-context plugin THROWS on an invalid zone while
 * assembling the request, so a bad value here would fail the whole turn.
 * @param value - raw `clientTimeZone` from the idbots/prompt wire params.
 * @returns the canonical zone, or undefined when the host did not supply one.
 */
const canonicalClientTimeZone = (value) => {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value !== 'UTC' && !IANA_TIME_ZONE.test(value)) return undefined
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone === value
      ? value
      : undefined
  } catch {
    return undefined
  }
}

// session/ensure retry budget for SessionAlreadyOwnedError: covers the
// seconds a superseded/dying runtime takes to exit and release its
// session.lock flock. Not meant to out-wait a healthy foreign owner.
const IDBOTS_ENSURE_OWNED_RETRY_DELAYS_MS = [500, 1500, 3000, 5000]

/** True for the persistence write-claim refusal (in-process claim or the
 * cross-process session.lock flock) — matched by class name with a message
 * fallback so a re-wrapped error still classifies. */
function isSessionAlreadyOwnedError(error) {
  if (error == null) return false
  if (error.name === 'SessionAlreadyOwnedError') return true
  return /already owned by an active write handle/.test(String(error.message ?? error))
}

export const name = 'idbots-sdk-server'
// 'llm' feeds the 0.2.2 auto reviewer (decision "review" on the policy gate
// assesses the pending call with the session's own model). Every composition
// mounts llm; the reviewer's remaining inputs come from session introspection,
// so no other service dependency is added here.
export const inject = ['agents', 'tools', 'llm']

class IdbotsSdkServer extends HarnessSdkJsonRpcServer {
  constructor(ctx, transport, options) {
    super(ctx, transport, options)
    this.idbotsTransport = transport
    this.idbotsAgents = new Map()
    this.idbotsApprovals = new Map() // id → { resolve, sessionId }
    this.idbotsApprovalSeq = 0
    this.idbotsToolPending = new Map() // id → { resolve, reject }
    this.idbotsToolSeq = 0
    this.idbotsPolicyPending = new Map() // id → { resolve }
    this.idbotsPolicySeq = 0
    this.idbotsAsks = new Map() // id → { resolve, reject }
    this.idbotsAskSeq = 0
    this.idbotsPromptSeq = 0
    // Per-agent route for the agent/request waterfall (UI model+effort selector).
    // Mid-session model switches MUST override provider/model here — after the
    // first turn the loop seeds every request from the persisted session
    // header, so ensure() updating only effort left the live agent on the
    // original model (qwen + DeepSeek's "max" → UNSUPPORTED_REASONING_EFFORT).
    this.idbotsRoute = new Map()
    this.idbotsRouteBound = new WeakSet()
    // Subagent lineage for the panel: parent dsh id → [{agentId, status, startedAt}]
    this.idbotsSubagentChildren = new Map()
    // Ring buffers of child session events for transcript viewing.
    this.idbotsChildEvents = new Map()
    // child agent id → parent dsh session id (for live row notifications).
    this.idbotsChildParents = new Map()
    // 0.1.2 child-delegation model selection: true only when the composition
    // mounted the Host-scope subagentModelSelection setting (non-empty
    // allowlist derived from the app provider table).
    this.idbotsSubagentModelSelection = options?.subagentModelSelection === true
    // session/ensure in-flight dedup, session id → promise. Two concurrent
    // ensures for one id both miss idbotsAgents before the winner's agent
    // publishes, and the loser's resume then dies on the winner's in-flight
    // write claim (SessionAlreadyOwnedError); chaining lands the loser on the
    // reuse path instead.
    this.idbotsEnsureInflight = new Map()

    ctx.on('agent/created', ({ agent }) => {
      this.idbotsAgents.set(String(agent.id), agent)
      // Delegation tool (0.1.2): modelSelectionSettings requires an Agent or
      // preset scope, so the tool mounts INSIDE each agent's context — never
      // at composition level. Children inherit the allowlist recorded at the
      // parent's first live seq; mounting for children too keeps nested
      // delegation (maxDepth-gated) identical to the former top-level mount.
      // ctx.plugin returns a cordis Fiber (thenable, no .catch) — wrap it.
      // 0.1.6: agent/created is async-serial and the first model request
      // waits for listener promises — RETURN the mounts so subagent /
      // send_message / interrupt_agent are registered before the first
      // request instead of racing it. The .catch wrappers matter: a rejected
      // listener now fails agent creation outright.
      const subagentMount = Promise.resolve(agent.ctx.plugin(dshToolSubagent, {
        provider: 'spawn',
        toolName: 'subagent',
        // 0.2.1 managed activations: every delegation returns
        // { kind:'activation', subagentId } immediately and the child's final
        // answer arrives as a parent completion notice (the 0.1.3-era
        // enableRunInBackground/backgroundMode keys were removed upstream).
        // Spawn children stay continuable — follow-ups ride the global
        // send_message / interrupt_agent tools registered by
        // dsh-tool-subagent-control below, including after settlement.
        // 0.1.6 moved depth gating behind user settings (default maxDepth 1,
        // which blocks nested delegation). Pin 3 explicitly to preserve the
        // 0.1.5 tool-level default IDBots shipped with.
        maxDepth: 3,
        // 0.2.2 renamed `modelSelectionSettings` to `modelSelection` and split
        // model discovery (list_subagent_models) into its own flag. The
        // allowlist itself still comes from the composition-level
        // model-selection-settings entry, recorded durably as the
        // subagent/model-selection-policy event.
        modelSelection: this.idbotsSubagentModelSelection,
        modelDiscovery: this.idbotsSubagentModelSelection,
      })).catch((error) => {
        this.ctx.logger.warn(`idbots-sdk-server: agent-scoped tool-subagent mount failed for ${String(agent.id)}: ${String(error?.message ?? error)}`)
      })
      // Control tools are agent-scoped too (they register into ctx.tools):
      // every agent — root parents AND resident children — gets send_message
      // (children are prompted by the kernel to report through it) and
      // interrupt_agent (ancestor-scoped turn cancellation).
      const controlMount = Promise.resolve(agent.ctx.plugin(dshToolSubagentControl)).catch((error) => {
        this.ctx.logger.warn(`idbots-sdk-server: agent-scoped tool-subagent-control mount failed for ${String(agent.id)}: ${String(error?.message ?? error)}`)
      })
      // Subagent lineage lives FLATTENED on the session header (not under a
      // meta subobject): header.origin === 'subagent' + header.parentSession.
      const header = agent?.session?.header
      if (header?.origin === 'subagent' && header?.parentSession !== undefined) {
        const parent = String(header.parentSession)
        const agentId = String(agent.id)
        // A continuable child re-materializes on every send_message follow-up
        // after settling (dematerialize + agent/created again): keep one row
        // per child and keep the accumulated transcript buffer.
        const children = this.idbotsSubagentChildren.get(parent) ?? []
        const existing = children.find((c) => c.agentId === agentId)
        if (existing === undefined) {
          children.push({ agentId, status: 'running', startedAt: Date.now() })
        } else {
          existing.status = 'running'
        }
        this.idbotsSubagentChildren.set(parent, children)
        if (!this.idbotsChildEvents.has(agentId)) this.idbotsChildEvents.set(agentId, [])
        this.idbotsChildParents.set(agentId, parent)
        // Live task rows: the host renders these through the same
        // task_started/task_notification channel the Claude path emits.
        this.idbotsTransport.notify('idbots/subagent/started', { sessionId: parent, agentId })
      }
      // Async-serial agent/created: the kernel awaits this before the first
      // model request of the new agent (see the mount comments above).
      return Promise.all([subagentMount, controlMount])
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const children of this.idbotsSubagentChildren.values()) {
        const entry = children.find((c) => c.agentId === String(agent.id))
        if (entry) entry.status = 'done'
      }
      const agentId = String(agent.id)
      const parent = this.idbotsChildParents.get(agentId)
      if (parent !== undefined) {
        this.idbotsChildParents.delete(agentId)
        this.idbotsTransport.notify('idbots/subagent/finished', { sessionId: parent, agentId, status: 'completed' })
      }
    }, { global: true })
    // Buffer child session events for the panel transcript view; the first
    // user message (the delegation prompt) also rides a progress
    // notification so the live row gets a meaningful summary.
    ctx.on('session/event', (session, event) => {
      const sid = typeof session === 'string' ? session : String(session?.id ?? '')
      if (!sid || !this.idbotsChildEvents.has(sid)) return
      const buffer = this.idbotsChildEvents.get(sid)
      const hadUserMessage = buffer.some((e) => e.type === 'user/message')
      buffer.push(event)
      if (buffer.length > 500) buffer.splice(0, buffer.length - 500)
      const parent = this.idbotsChildParents.get(sid)
      // Continuable residency: a resident child does NOT dispose after its
      // run settles, so turn lifecycle is the live signal distinguishing an
      // idle child (parked, awaiting send_message) from a running one.
      if (parent !== undefined && (event.type === 'turn/start' || event.type === 'turn/end')) {
        this.idbotsTransport.notify('idbots/subagent/progress', {
          sessionId: parent,
          agentId: sid,
          status: event.type === 'turn/start' ? 'running' : 'idle',
        })
      }
      if (!hadUserMessage && event.type === 'user/message' && parent !== undefined) {
        const text = (event.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ').trim()
        if (text.length > 0) {
          this.idbotsTransport.notify('idbots/subagent/progress', {
            sessionId: parent,
            agentId: sid,
            summary: text.length > 160 ? `${text.slice(0, 157)}...` : text,
          })
        }
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.idbotsAgents.delete(String(agent.id))
      this.idbotsRoute.delete(String(agent.id))
    }, { global: true })

    // 0.1.5 live streaming bridge: 'assistant/chunk' left the durable session
    // event feed (streams now persist embedded in the settled assistant/message
    // or assistant/attempt), and the loop publishes TRANSIENT frames on the
    // agent-scoped 'agent/assistant-stream' dispatch — which the stock server
    // never puts on the wire. Forward chunk frames as synthetic assistant/chunk
    // session.event notifications so the host mapper keeps its token-level
    // text/reasoning deltas: frame.chunk is the same StreamChunk the retired
    // durable event carried. Global listener because dispatch is
    // scope-filtered (same lesson as the approval waterfall above).
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame?.type !== 'chunk') return
      this.idbotsTransport.notify('session.event', {
        sessionId: String(agent.id),
        event: { type: 'assistant/chunk', data: { chunk: frame.chunk } },
      })
    }, { global: true })

    ctx.on('approval/request', (req, next) => this.idbotsBridgeApproval(req, next), { global: true })
    // user-questions (0.1.2): the answerer seam is the scoped cordis
    // waterfall 'user-questions/request' — claim by answering, delegate via
    // next(). The former service.registerProvider({ask}) API is gone; the
    // service itself rejects owned-child callers (DELEGATED_CALLER) before
    // dispatch, so a global listener still only ever sees root-agent asks.
    ctx.on('user-questions/request', (req, next) => this.idbotsBridgeAsk(req, next), { global: true })
    // Same reactive pattern for the projection registry: reading
    // ctx.sessionProjections without declaring inject throws in cordis, and a
    // hard inject would keep this plugin from ever mounting in compositions
    // without the session-projection plugin. The fiber delivers the registry
    // when present; idbots/usage answers available:false otherwise.
    this.idbotsProjections = null
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      this.idbotsProjections = projectionCtx.sessionProjections
      return () => { this.idbotsProjections = null }
    })
    // Compaction-basic is in the default composition; inject reactively so
    // this plugin still mounts in test compositions that omit it.
    this.idbotsCompaction = null
    ctx.inject(['compaction'], (compactionCtx) => {
      this.idbotsCompaction = compactionCtx.compaction
      return () => { this.idbotsCompaction = null }
    })
    // Subagent service (dsh-subagent): host-side interrupt for continuable
    // children uses the kernel's 'user' authority (parentSessionId-checked).
    // Reactive inject keeps test compositions without subagents mountable.
    this.idbotsSubagents = null
    ctx.inject(['subagents'], (subagentCtx) => {
      this.idbotsSubagents = subagentCtx.subagents
      return () => { this.idbotsSubagents = null }
    })
    // Persistence service (dsh-session-persistence-jsonl): read-only session
    // opens back the durable subagent catalog + child transcripts, so the
    // panel survives runtime reaps and app restarts (in-memory rows do not).
    this.idbotsPersistence = null
    ctx.inject(['sessionPersistence'], (persistenceCtx) => {
      this.idbotsPersistence = persistenceCtx.sessionPersistence
      return () => { this.idbotsPersistence = null }
    })
    // Plan-mode controller (dsh-plan-mode): the host flips session mode
    // through ctx.planMode.set(...). Reactive inject keeps compositions
    // without plan-mode mountable; the RPC reports unavailable then.
    this.idbotsPlanMode = null
    ctx.inject(['planMode'], (planModeCtx) => {
      this.idbotsPlanMode = planModeCtx.planMode
      return () => { this.idbotsPlanMode = null }
    })
  }

  liveAgent(sessionId) {
    const agent = this.idbotsAgents.get(String(sessionId))
    if (agent === undefined) {
      throw new Error(`idbots-sdk-server: no live agent for session ${sessionId}`)
    }
    return agent
  }

  async handleRequest(method, params) {
    switch (method) {
      case 'session/steer': return this.idbotsSteer(params)
      case 'session/cancel': return this.idbotsCancel(params)
      case 'session/ensure': return this.idbotsEnsureSession(params)
      case 'session/dispose': return this.idbotsDisposeSession(params)
      case 'idbots/prompt': return this.idbotsPrompt(params)
      case 'idbots/approval/respond': return this.idbotsApprovalRespond(params)
      case 'idbots/tool/respond': return this.idbotsToolRespond(params)
      case 'idbots/policy/respond': return this.idbotsPolicyRespond(params)
      case 'idbots/ask/respond': return this.idbotsAskRespond(params)
      case 'idbots/subagents/list': return this.idbotsSubagentsList(params)
      case 'idbots/subagents/messages': return this.idbotsSubagentsMessages(params)
      case 'idbots/subagent/interrupt': return this.idbotsSubagentInterrupt(params)
      case 'idbots/usage': return this.idbotsUsage(params)
      case 'idbots/compact': return this.idbotsCompact(params)
      case 'idbots/plan-mode/set': return this.idbotsPlanModeSet(params)
      case 'idbots/ping': {
        return {
          pong: true,
          extensions: ['session/steer', 'session/cancel', 'session/ensure', 'session/dispose', 'idbots/prompt', 'idbots/approval/respond', 'idbots/tool/respond', 'idbots/ask/respond', 'idbots/subagent/interrupt', 'idbots/usage', 'idbots/compact', 'idbots/plan-mode/set'],
        }
      }
      default: return super.handleRequest(method, params)
    }
  }

  async idbotsEnsureSession(hostParams) {
    const id = String(hostParams?.sessionId ?? '')
    if (id.length === 0) throw new Error('idbots-sdk-server: session/ensure requires sessionId')
    // Serialize concurrent ensures per session id (see constructor note):
    // the loser of a resume race awaits the winner, then reuses the published
    // agent. The loop re-checks after each wake so multiple waiters chain onto
    // the latest in-flight ensure instead of all releasing at once.
    for (;;) {
      const prior = this.idbotsEnsureInflight.get(id)
      if (prior === undefined) break
      await prior.catch(() => undefined)
    }
    // .then() defers the exclusive call to a microtask so the map entry is
    // installed before any ensure work runs (waiters must observe it).
    const run = Promise.resolve().then(() => this.idbotsEnsureSessionExclusive(hostParams))
    this.idbotsEnsureInflight.set(id, run)
    try {
      return await run
    } finally {
      if (this.idbotsEnsureInflight.get(id) === run) this.idbotsEnsureInflight.delete(id)
    }
  }

  async idbotsEnsureSessionExclusive(hostParams) {
    const { sessionId, provider, model, maxTokens, reasoningEffort, cwd } = hostParams ?? {}
    const id = String(sessionId ?? '')
    if (this.idbotsAgents.has(id)) {
      const agent = this.idbotsAgents.get(id)
      this.idbotsBindRoute(agent, { provider, model, maxTokens, reasoningEffort })
      this.idbotsBindWorkspace(agent, cwd)
      return { ensured: true, resumed: false }
    }

    const agentOptions = {
      provider: provider ?? this.provider,
      model: model ?? this.model,
      ...Number.isFinite(maxTokens) ? { maxTokens } : {},
    }
    // Resume-first: agents.create does NOT consult the persisted log (it mints
    // a fresh in-memory session), so a restart would silently overwrite
    // history instead of resuming. resume throws `session "<id>" not found`
    // when no log exists — that is the fresh-create signal.
    let handle
    let resumed = true
    // The write claim behind SessionAlreadyOwnedError can be transient: a
    // superseded or dying runtime process releases its session.lock flock the
    // moment it exits, so a short bounded retry heals the handover (runtime
    // restart raced a resume, sibling process shutting down). A lock held by
    // a LONG-LIVED foreign process (a second app instance sharing this
    // userData, or an orphaned pre-crash runtime) never clears — after the
    // budget, surface the original error so the failure stays diagnosable.
    for (let attempt = 0; ; attempt += 1) {
      try {
        handle = await this.ctx.agents.resume({ resumeSessionId: id, agentOptions })
        break
      } catch (error) {
        if (isSessionAlreadyOwnedError(error)) {
          // The owner may have published the agent here while our attempt was
          // in flight — prefer reusing the live agent over retrying.
          const live = this.idbotsAgents.get(id)
          if (live !== undefined) {
            this.idbotsBindRoute(live, { provider, model, maxTokens, reasoningEffort })
            this.idbotsBindWorkspace(live, cwd)
            return { ensured: true, resumed: false }
          }
          if (attempt < IDBOTS_ENSURE_OWNED_RETRY_DELAYS_MS.length) {
            const waitMs = IDBOTS_ENSURE_OWNED_RETRY_DELAYS_MS[attempt]
            this.ctx.logger.warn(`idbots-sdk-server: session/ensure "${id}" is write-owned by another live process; retrying in ${waitMs}ms (attempt ${attempt + 1}/${IDBOTS_ENSURE_OWNED_RETRY_DELAYS_MS.length})`)
            await new Promise((resolve) => setTimeout(resolve, waitMs))
            continue
          }
        }
        if (!/not found/.test(String(error?.message ?? error))) throw error
        // Prefer the host cowork workspace over initialize's sessionRoot so
        // bash/fs land in bots/<id>/<date>, not the shared JSONL directory.
        handle = await this.ctx.agents.create({
          sessionId: id,
          meta: { cwd: this.idbotsResolvedCwd(cwd) ?? this.cwd },
          agentOptions,
        })
        resumed = false
        break
      }
    }
    // Per-session surface: prompt sections and host tools registered on the
    // agent's scoped context (shadowing globals, unwound on disposal).
    this.idbotsRegisterSections(hostParams.sections, handle.agent?.ctx)
    this.idbotsRegisterHostTools(hostParams.hostTools, handle.agent?.ctx)
    this.idbotsBindRoute(handle.agent, { provider, model, maxTokens, reasoningEffort })
    this.idbotsBindWorkspace(handle.agent, cwd)
    // Register with the stock server's bookkeeping (private at the type level,
    // present at runtime) so its lazy session/prompt create reuses this agent
    // instead of colliding on the registry id.
    this.sessions.set(id, { handle })
    return { ensured: true, resumed }
  }

  /**
   * Release a live agent so another runtime process can resume the same
   * persisted session id. handle.dispose() stops the loop, flushes JSONL
   * (session/disposed → persistence retire), and unregisters the agent.
   * The log file stays on disk — this is not a session delete.
   */
  async idbotsDisposeSession(params) {
    const id = String(params?.sessionId ?? '')
    if (id.length === 0) throw new Error('idbots-sdk-server: session/dispose requires sessionId')
    const record = this.sessions.get(id)
    if (typeof record?.handle?.dispose !== 'function') return { disposed: false }
    await record.handle.dispose()
    this.sessions.delete(id)
    return { disposed: true }
  }

  /**
   * Absolute cowork workspace for this ensure, or undefined when the host
   * omitted cwd (stock tests / initialize default). Relative paths are
   * rejected — session.header.cwd is a storage key and a bash/fs root.
   */
  idbotsResolvedCwd(cwd) {
    if (typeof cwd !== 'string') return undefined
    const next = cwd.trim()
    if (next.length === 0) return undefined
    if (!isAbsolute(next)) {
      throw new Error(`idbots-sdk-server: session/ensure cwd must be an absolute path, got "${next}"`)
    }
    return resolve(next)
  }

  /**
   * Point bash/fs at this session's cowork workspace. dsh-tool-bash and
   * dsh-tool-fs resolve relative paths from session.header.cwd; the
   * composition plugin cwd is only a fallback for non-agent calls and is
   * pinned once so Twin/Worker cwd churn does not restart the shared
   * runtime. The SessionHeader object is deep-frozen at create/resume, so
   * a later ensure replaces the header object (every ensure reapplies,
   * including resume-after-restart of pre-fix sessions that stored
   * sessionRoot as cwd).
   */
  idbotsBindWorkspace(agent, cwd) {
    const resolved = this.idbotsResolvedCwd(cwd)
    if (!agent?.session || resolved === undefined) return
    if (agent.session.header?.cwd === resolved) return
    agent.session.header = Object.freeze({ ...agent.session.header, cwd: resolved })
  }

  /**
   * Pin this agent's next LLM request to the host's model+effort selector.
   * Same seam installModelSelection uses: after the first turn the loop seeds
   * every request from the persisted session header, so a live ensure() that
   * only touched effort left provider/model stuck on the original pick.
   * An explicit effort wins; an absent effort strips the inherited value so
   * the adapter falls back to the route default (DeepSeek: high; pi-ai: none).
   */
  idbotsBindRoute(agent, route) {
    if (!agent) return
    const id = String(agent.id)
    const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
    const model = typeof route?.model === 'string' ? route.model.trim() : ''
    const effort = typeof route?.reasoningEffort === 'string' ? route.reasoningEffort.trim() : ''
    this.idbotsRoute.set(id, {
      ...(provider.length > 0 ? { provider } : {}),
      ...(model.length > 0 ? { model } : {}),
      ...Number.isFinite(route?.maxTokens) ? { maxTokens: route.maxTokens } : {},
      ...(effort.length > 0 ? { reasoningEffort: effort } : {}),
    })
    // 0.2.2: provider/model/reasoningEffort move through the durable
    // agent.model selection. The agent/request waterfall may no longer change
    // the route — agent-loop fixes the step selection BEFORE the waterfall and
    // throws "use agent.model.select() before step preparation" on a mismatch,
    // and a cross-agent rewrite would also corrupt subagent children whose
    // selection comes from their own delegation options. This mirrors the
    // kernel's applyConfiguredRoute: keep the previous effort when the route
    // is unchanged and the ensure carries none.
    if (provider.length > 0 && model.length > 0 && agent.model && typeof agent.model.select === 'function') {
      try {
        const previous = agent.model.current()
        const selection = { provider, model, ...(effort.length > 0 ? { reasoningEffort: effort } : {}) }
        if (selection.reasoningEffort === undefined && previous !== undefined
          && previous.provider === selection.provider && previous.model === selection.model
          && previous.reasoningEffort !== undefined) {
          selection.reasoningEffort = previous.reasoningEffort
        }
        agent.model.select(selection)
      } catch (error) {
        this.ctx.logger.warn(`idbots-sdk-server: agent.model.select failed for session "${id}": ${String(error?.message ?? error)}`)
      }
    }
    if (this.idbotsRouteBound.has(agent) || !agent.ctx?.on) return
    this.idbotsRouteBound.add(agent)
    agent.ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      // 0.2.2: the waterfall is shared, so never touch another agent's
      // request (subagent children fix their own route). maxTokens stays a
      // waterfall-legal override; the route fields are owned by the durable
      // selection above.
      if (payload?.agent !== undefined && String(payload.agent.id) !== id) return resolved
      const bound = this.idbotsRoute.get(id)
      if (bound === undefined) return resolved
      return {
        ...resolved,
        ...Number.isFinite(bound.maxTokens) ? { maxTokens: bound.maxTokens } : {},
      }
    })
  }

  async idbotsSteer({ sessionId, contentBlocks }) {
    const agent = this.liveAgent(sessionId)
    const message = {
      id: `steer-${Date.now().toString(36)}`,
      role: 'user',
      content: contentBlocks,
      source: { kind: 'user' },
    }
    agent.steer(message)
    return { steered: true, messageId: message.id }
  }

  // Prompt submission with optional image attachments: the host reads the
  // image files (attachment marker lines carry no bytes over the wire), the
  // runtime commits them through the attachments store and queues the user
  // message as [text, ...image blocks] via the stock prompt path. Same route
  // gate as tool-result images: a user message is durable history, so a
  // text-only route never receives image blocks — an omission note rides the
  // text instead. Admission goes through the attachment store's
  // admitPromptContent method (0.1.5: formerly a standalone export), so the
  // batch count and
  // aggregate-byte limits plus the canonical-base64 check apply exactly as
  // they do to the harness's own browser uploads; a refused batch throws to
  // the RPC caller instead of partially committing.
  async idbotsPrompt({ sessionId, text, images, clientTimeZone }) {
    let content = [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text ?? '') }]
    const imageList = Array.isArray(images) ? images.filter((image) => typeof image?.data === 'string' && image.data.length > 0) : []
    if (imageList.length > 0) {
      const rec = await this.getOrCreateSession(sessionId)
      const agent = rec?.handle?.agent
      const attachments = this.ctx.get('attachments')
      const imageCapable = attachments !== undefined && await this.idbotsRouteAcceptsImages(agent)
      if (imageCapable) {
        content = await attachments.admitPromptContent([
          ...content,
          ...imageList.map((image) => ({
            type: 'image',
            mediaType: image.mediaType,
            data: image.data,
            ...typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {},
          })),
        ])
      } else {
        content = [{
          type: 'text',
          text: `${content[0].text}\n[idbots: ${imageList.length} attached image${imageList.length === 1 ? '' : 's'} omitted — the active model does not accept image input; their file paths stay in the text above]`,
        }]
      }
    }
    // 0.1.7 time context: the stock SDK prompt builds its user message with a
    // bare `{kind:'user'}` source, which leaves dsh-time-context reporting
    // "browser time zone unavailable — ask the user". When the host supplies
    // its zone we build the message ourselves and carry the zone in the
    // source (the seam the Web client uses), so the clock reading resolves
    // instead. No zone on the wire keeps the stock path exactly as before.
    const zone = canonicalClientTimeZone(clientTimeZone)
    if (zone === undefined) return this.prompt({ sessionId, contentBlocks: content })
    const rec = await this.getOrCreateSession(sessionId)
    this.assertLiveAgent(rec, sessionId)
    const message = createUserMessage({
      content,
      source: { kind: 'user', rpcId: `idbots-${Date.now().toString(36)}-${++this.idbotsPromptSeq}`, clientTimeZone: zone },
    })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  async idbotsCancel({ sessionId, cause, keepInbox }) {
    const agent = this.liveAgent(sessionId)
    // Report whether an abort actually fired: a cancel against an idle agent
    // is a documented no-op that never emits a turn boundary, and the host's
    // steer latch arms only on a real interrupt.
    const cancelled = agent.status === 'running'
    // 0.1.7: agent.cancel takes the closed AgentCancelCause union
    // ({kind:'user'|'parent'|'disposed'} or {kind:'hook', reason}). A bare
    // string now slips past abortedCancelCause into assertNever, and the
    // turn/end lands with reason:null. Free-form wire strings ('steer',
    // watchdog texts, …) ride the V4-legal hook form so the cause survives
    // in the log; a bare cancel is the user's own stop.
    const cancelCause = typeof cause === 'string' && cause.length > 0
      ? { kind: 'hook', reason: cause }
      : { kind: 'user' }
    agent.cancel(cancelCause, { keepInbox: keepInbox === true })
    return { cancelled }
  }

  // ---- approval bridge -----------------------------------------------------

  idbotsBridgeApproval(req) {
    const id = `appr-${Date.now().toString(36)}-${++this.idbotsApprovalSeq}`
    const sessionId = String(req.agent?.id ?? '')
    const settle = new Promise((resolve) => {
      this.idbotsApprovals.set(id, { resolve, sessionId })
    })
    this.idbotsTransport.notify('idbots/approval/request', {
      id,
      sessionId,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: String(req.callId) } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    // The service races the turn signal itself and discards our late answer on
    // abort; we only clean up and tell the host to dismiss the dialog.
    req.signal?.addEventListener('abort', () => {
      const pending = this.idbotsApprovals.get(id)
      if (pending === undefined) return
      this.idbotsApprovals.delete(id)
      pending.resolve('cancelled')
      this.idbotsTransport.notify('idbots/approval/cancelled', { id })
    }, { once: true })
    return settle
  }

  async idbotsApprovalRespond({ id, outcome }) {
    if (!RESPOND_OUTCOMES.has(outcome)) {
      throw new Error(`idbots-sdk-server: approval outcome must be one of ${[...RESPOND_OUTCOMES].join('|')}, got ${JSON.stringify(outcome)}`)
    }
    const pending = this.idbotsApprovals.get(String(id))
    if (pending === undefined) {
      throw new Error(`idbots-sdk-server: no pending approval ${JSON.stringify(id)}`)
    }
    this.idbotsApprovals.delete(String(id))
    pending.resolve(outcome)
    return { answered: true, id, outcome }
  }

  // ---- host tool bridge -----------------------------------------------------
  //
  // Model-visible tools whose handlers live in the Electron main process:
  // the schemas ride the plugin config (generated by the host), execution
  // round-trips over the wire — idbots/tool/request notification out,
  // idbots/tool/respond back, idbots/tool/cancelled when the turn aborts
  // mid-call (the tool MUST settle on abort; that contract is enforced here).
  //
  // Image results: a respond may carry `images: [{ data: <base64>, mediaType,
  // name? }]` alongside `text`. Each image is committed through the
  // attachments service (durable, content-addressed) and rendered as a DSH
  // image block next to the text. The route is gated first — a tool result is
  // durable session history, so emitting an image on a route whose model does
  // not declare image input would poison that session's continuation with a
  // permanent conversion error. Non-image routes (or a missing attachment
  // store) degrade to text plus an omission note instead.

  /** True when the calling agent's resolved route declares image input. */
  async idbotsRouteAcceptsImages(agent) {
    try {
      const routed = agent?.session?.requestHeader?.()?.config
      const provider = routed?.provider ?? agent?.options?.provider
      const model = routed?.model ?? agent?.options?.model
      const llm = this.ctx.get('llm')
      if (provider === undefined || model === undefined || llm === undefined) return false
      const info = await llm.resolveModelInfo(provider, model)
      return info?.inputModalities?.includes('image') === true
    } catch {
      return false
    }
  }

  /** Build one host-bridged tool proxy (shared by global and agent-scoped registration). */
  idbotsMakeHostTool(definition) {
    const server = this
    return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => {
            const blocks = [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
            for (const image of Array.isArray(value?.images) ? value.images : []) {
              if (typeof image?.attachmentId !== 'string') continue
              blocks.push({
                type: 'image',
                attachment: {
                  attachmentId: image.attachmentId,
                  mediaType: image.mediaType,
                  bytes: image.bytes,
                  width: image.width,
                  height: image.height,
                  ...image.name !== undefined ? { name: image.name } : {},
                },
              })
            }
            return blocks
          },
        },
      execute: async (args, exec) => {
        const id = `tool-${Date.now().toString(36)}-${++server.idbotsToolSeq}`
        const pending = new Promise((resolve, reject) => {
          server.idbotsToolPending.set(id, { resolve, reject, agent: exec.agent })
        })
        server.idbotsTransport.notify('idbots/tool/request', {
          id,
          sessionId: String(exec.agent?.id ?? ''),
          name: definition.name,
          arguments: args,
        })
        exec.signal?.addEventListener('abort', () => {
          const entry = server.idbotsToolPending.get(id)
          if (entry === undefined) return
          server.idbotsToolPending.delete(id)
          entry.reject(new Error('host tool call aborted'))
          server.idbotsTransport.notify('idbots/tool/cancelled', { id })
        }, { once: true })
        return pending // { text, images? } on success; throws on host error/abort
      },
    }
  }

  idbotsRegisterHostTools(tools, scopeCtx) {
    for (const definition of tools ?? []) {
      (scopeCtx ?? this.ctx).tools.register(this.idbotsMakeHostTool(definition))
    }
  }

  /**
   * Agent-scoped prompt sections: DSH systemPrompt sections registered on the
   * agent's own context SHADOW same-named global sections for that agent
   * alone — per-session prompts ride here instead of the runtime config, so
   * differing system prompts never restart the runtime.
   */
  idbotsRegisterSections(sections, scopeCtx) {
    const systemPrompt = (scopeCtx ?? this.ctx).get('systemPrompt')
    if (!systemPrompt) return
    for (const section of sections ?? []) {
      systemPrompt.section({
        name: section.name,
        order: Number.isFinite(section.order) ? section.order : 0,
        text: section.text,
        // interpolate:false keeps authored content (A2A conversation history in
        // idbots:base, user goal text) literal — a {{placeholder}} quoted in
        // peer messages must not kill the kernel's strict interpolator.
        ...(section.interpolate !== undefined ? { interpolate: section.interpolate } : {}),
      })
    }
  }

  async idbotsToolRespond({ id, ok, text, error, images }) {
    const entry = this.idbotsToolPending.get(String(id))
    if (entry === undefined) {
      throw new Error(`idbots-sdk-server: no pending host tool ${JSON.stringify(id)}`)
    }
    this.idbotsToolPending.delete(String(id))
    if (ok === false) {
      entry.reject(new Error(typeof error === 'string' && error ? error : 'host tool failed'))
      return { answered: true, id }
    }
    // The tool call MUST settle here: the entry is already deleted, so an
    // escaped materialize throw (e.g. the attachment store rejecting an
    // oversize screenshot) leaves the pending promise unsettled forever — not
    // even a turn abort can reach it — and the session wedges for good.
    // Degrade to a text note instead.
    let value
    try {
      value = await this.idbotsMaterializeToolValue(entry.agent, text, images)
    } catch (materializeError) {
      const reason = materializeError instanceof Error ? materializeError.message : String(materializeError)
      const imageCount = Array.isArray(images) ? images.length : 0
      value = {
        text: `${typeof text === 'string' ? text : JSON.stringify(text ?? null)}\n[idbots: ${imageCount} image${imageCount === 1 ? '' : 's'} from this tool result omitted — ${reason}]`,
      }
    }
    entry.resolve(value)
    return { answered: true, id }
  }

  /**
   * Turn a host respond into the tool's canonical value: commit image
   * payloads through the attachments store when the route can carry them,
   * degrade to a text note when it cannot. Never emits an image the active
   * route rejects — the tool result is durable history. A single rejected
   * image (oversize, over the byte cap, malformed) degrades to a note naming
   * the reason instead of throwing, so one bad capture can never wedge the
   * tool call; the model sees the note and can retry with a smaller capture.
   */
  async idbotsMaterializeToolValue(agent, text, images) {
    const value = { text: typeof text === 'string' ? text : JSON.stringify(text ?? null) }
    if (!Array.isArray(images) || images.length === 0) return value
    const attachments = this.ctx.get('attachments')
    const imageCapable = attachments !== undefined && await this.idbotsRouteAcceptsImages(agent)
    if (!imageCapable) {
      return {
        ...value,
        text: `${value.text}\n[idbots: ${images.length} image${images.length === 1 ? '' : 's'} from this tool result omitted — the active model does not accept image input]`,
      }
    }
    const saved = []
    const rejected = []
    for (const image of images) {
      if (typeof image?.data !== 'string' || image.data.length === 0) continue
      try {
        saved.push(await attachments.saveImage({
          data: Uint8Array.from(Buffer.from(image.data, 'base64')),
          mediaType: image.mediaType,
          ...typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {},
        }))
      } catch (saveError) {
        rejected.push(saveError instanceof Error ? saveError.message : String(saveError))
      }
    }
    if (rejected.length === 0) return saved.length > 0 ? { ...value, images: saved } : value
    const noted = `${value.text}\n[idbots: ${rejected.length} image${rejected.length === 1 ? '' : 's'} from this tool result omitted — ${rejected[0]}]`
    return saved.length > 0 ? { ...value, text: noted, images: saved } : { ...value, text: noted }
  }

  // ---- user-questions bridge ---------------------------------------------------
  //
  // The dsh-user-questions service seam + dsh-tool-ask-user expose the
  // model-facing ask_user_question tool; the UI-side PROVIDER is deployment
  // ownership. This bridge forwards each ask to the Electron host
  // (idbots/ask/request out, idbots/ask/respond back) whose renderer renders
  // it through the same AskUserQuestion modal the Claude path uses. The turn
  // signal settles unanswered asks (the tool contract requires settling).

  idbotsBridgeAsk(request, next) {
    const id = `ask-${Date.now().toString(36)}-${++this.idbotsAskSeq}`
    // Older dsh-tool-ask-user payloads may omit the per-question id even
    // though the host response contract requires one. Normalize at the
    // bridge boundary so a malformed model retry cannot wedge the turn
    // before the host can render the question or apply its timeout fallback.
    const questions = (Array.isArray(request?.questions) ? request.questions : [])
      .map((question, index) => {
        const value = question && typeof question === 'object' ? question : {}
        const rawId = typeof value.id === 'string' ? value.id.trim() : ''
        return { ...value, id: rawId || `q-${index + 1}` }
      })
    const pending = new Promise((resolve, reject) => {
      this.idbotsAsks.set(id, { resolve, reject })
    })
    this.idbotsTransport.notify('idbots/ask/request', {
      id,
      sessionId: String(request?.agent?.id ?? ''),
      questions,
    })
    request?.signal?.addEventListener('abort', () => {
      const entry = this.idbotsAsks.get(id)
      if (entry === undefined) return
      this.idbotsAsks.delete(id)
      entry.reject(new Error('ask_user_question was aborted before the user answered'))
      this.idbotsTransport.notify('idbots/ask/cancelled', { id })
    }, { once: true })
    return pending
  }

  async idbotsAskRespond({ id, answers, error }) {
    const entry = this.idbotsAsks.get(String(id))
    if (entry === undefined) {
      throw new Error(`idbots-sdk-server: no pending user question ${JSON.stringify(id)}`)
    }
    this.idbotsAsks.delete(String(id))
    if (error !== undefined) {
      entry.reject(new Error(typeof error === 'string' && error ? error : 'ask failed'))
    } else {
      entry.resolve({
        answers: Array.isArray(answers)
          ? answers.filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
              .map((a) => ({
                id: a.id,
                selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
                ...typeof a.custom === 'string' && a.custom.length > 0 ? { custom: a.custom } : {},
              }))
          : [],
      })
    }
    return { answered: true, id }
  }

  // ---- host policy bridge ----------------------------------------------------
  //
  // Runtime-native tools (bash/write/edit…) route their pre-execute decision
  // through the host's permission chain: idbots/policy/request notification
  // out, idbots/policy/respond back with allow | deny | ask | review. 'ask'
  // returns to the tools pipeline as a normal ask, flowing through
  // user-approval and the M2 approval bridge into the renderer permission
  // dialog. 'review' (0.2.2 headless auto review) hands the verdict to the
  // session's own model before execution — the host answers it on unattended
  // paths where it would otherwise blind-allow; denial is final and a
  // reviewer failure fails closed (see plugins/idbots-auto-review.mjs).

  idbotsRegisterPolicyGate(policyTools) {
    // read/read_image ride the gate so the host can apply its Read guards
    // (non-vision image block, unchanged-file re-read dedup).
    const gated = new Set(policyTools ?? ['bash', 'write', 'edit', 'read', 'read_image'])
    const server = this
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      if (!gated.has(exec?.name)) return next()
      const id = `policy-${Date.now().toString(36)}-${++server.idbotsPolicySeq}`
      const pending = new Promise((resolve) => {
        server.idbotsPolicyPending.set(id, { resolve })
      })
      server.idbotsTransport.notify('idbots/policy/request', {
        id,
        sessionId: String(exec.agent?.id ?? ''),
        name: exec.name,
        arguments: exec.arguments,
      })
      exec.signal?.addEventListener('abort', () => {
        const entry = server.idbotsPolicyPending.get(id)
        if (entry === undefined) return
        server.idbotsPolicyPending.delete(id)
        entry.resolve({ decision: 'deny', reason: 'session aborted' })
      }, { once: true })
      const decision = await pending
      if (decision.decision === 'allow') return next()
      if (decision.decision === 'review') {
        const verdict = await reviewPendingAction(this.ctx, exec)
        if (verdict.kind === 'allow') {
          this.ctx.logger?.info?.(`idbots-auto-review: allowed "${exec.name}" on session "${String(exec.agent?.id ?? '')}"`)
          return next()
        }
        return { kind: 'deny', reason: verdict.reason }
      }
      if (decision.decision === 'ask') return { kind: 'ask', reason: decision.reason }
      return { kind: 'deny', reason: decision.reason ?? 'denied by host policy' }
    }, { global: true })
  }

  /**
   * Read one session's own durable events: the live in-memory log when an
   * agent holds it, otherwise a read-only persistence open (never takes write
   * ownership, so it works under a live writer and after restarts). Events
   * inherited from a fork parent are excluded — the same cut the official
   * projections apply (seq < inheritedEventCount belongs to the fork parent).
   */
  async idbotsReadSessionEvents(sessionId) {
    const id = String(sessionId ?? '')
    if (id.length === 0) return []
    const live = this.idbotsAgents.get(id)
    // ownEvents() is deprecated since 0.1.6 ("existing logic may remain
    // unmigrated for now") but upstream itself still calls it inside
    // dsh-agent-loop 0.1.6-alpha.2 and ships no async replacement yet —
    // re-check at the next kernel bump.
    if (live?.session !== undefined) return [...live.session.ownEvents()]
    if (this.idbotsPersistence === null) return []
    let handle
    try {
      handle = await this.idbotsPersistence.open(id, 'read')
    } catch {
      // Never persisted (or pruned): no durable rows for this session.
      return []
    }
    try {
      const inherited = Number.isFinite(handle.inheritedEventCount) ? handle.inheritedEventCount : 0
      const events = []
      let offset = 0
      for (;;) {
        const slice = await handle.read(offset, 1000)
        const batch = slice?.events ?? []
        for (const event of batch) {
          if (typeof event?.seq === 'number' && event.seq < inherited) continue
          events.push(event)
        }
        if (batch.length < 1000) break
        offset += batch.length
      }
      return events
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Direct-child lineage for the panel. The durable `subagent/catalog` events
   * on the parent's log (0.1.5 dsh-subagent) make this restart- and reap-safe:
   * live in-memory rows still win on status, but a catalog-only child lists
   * as 'done' with its creation facts instead of vanishing.
   */
  async idbotsSubagentsList({ sessionId }) {
    const parent = String(sessionId ?? '')
    const live = this.idbotsSubagentChildren.get(parent) ?? []
    const liveById = new Map(live.map((row) => [row.agentId, row]))
    const catalogByChild = new Map()
    for (const event of await this.idbotsReadSessionEvents(parent)) {
      if (event?.type !== 'subagent/catalog') continue
      const data = event.data
      if (!data || typeof data.childId !== 'string' || typeof data.childCreatedAt !== 'number') continue
      if (data.mode !== 'one-shot' && data.mode !== 'continuable') continue
      catalogByChild.set(data.childId, data)
    }
    const rows = []
    for (const [childId, entry] of catalogByChild) {
      const liveRow = liveById.get(childId)
      rows.push({
        agentId: childId,
        status: liveRow?.status ?? 'done',
        startedAt: liveRow?.startedAt ?? entry.childCreatedAt,
        mode: entry.mode,
        ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
      })
    }
    // Live rows whose catalog event has not landed yet (creation window).
    for (const row of live) {
      if (!catalogByChild.has(row.agentId)) rows.push({ ...row })
    }
    return { agents: rows }
  }

  // ---- usage projections ------------------------------------------------------
  //
  // idbots/usage reads the official token-meter session projections through
  // ctx.sessionProjections.snapshot(): the durable cumulative tokenUsage
  // buckets (uncachedInput/output/cacheRead/cacheWrite — disjoint), the newest
  // contextPressure sample, and the heuristic contextBreakdown composition.
  // The snapshot is replay-derived, so it stays correct across runtime
  // restarts (the resumed log refolds lazily). Graceful absence: a runtime
  // composed without the projection registry or token-meter answers
  // { available: false } and the host keeps its last persisted stats.

  idbotsUsage({ sessionId }) {
    const id = String(sessionId ?? '')
    if (this.idbotsProjections === null) {
      return { available: false, reason: 'session-projections not composed' }
    }
    const agent = this.idbotsAgents.get(id)
    if (agent === undefined || agent?.session === undefined) {
      return { available: false, reason: `no live agent for session ${id || '(none)'}` }
    }
    const snapshot = this.idbotsProjections.snapshot(agent.session)
    return {
      available: true,
      asOfSeq: snapshot.asOfSeq,
      tokenUsage: snapshot.values.tokenUsage ?? null,
      contextPressure: snapshot.values.contextPressure ?? null,
      contextBreakdown: snapshot.values.contextBreakdown ?? null,
      // 0.1.5 whole-log units (dsh-session-stats / dsh-session-turn-outline):
      // null when the composition omits them, same graceful-absence contract.
      sessionStats: snapshot.values.sessionStats ?? null,
      turnOutline: snapshot.values.turnOutline ?? null,
      // 0.1.5 plan-mode wire view ({ active, pending }) for the sidebar
      // mode chip; null when the composition omits dsh-plan-mode.
      plan: snapshot.values.plan ?? null,
    }
  }

  /**
   * Host-driven plan-mode switch (dsh-plan-mode ctx.planMode.set). Returns
   * { ok, result } where result is the controller outcome: 'committed'
   * (logged now), 'queued' (applies at the next in-turn pre-step),
   * 'cancelled' (opposite pending selection cleared), or 'noop'.
   */
  idbotsPlanModeSet({ sessionId, active } = {}) {
    if (this.idbotsPlanMode === null) {
      throw new Error('idbots-sdk-server: plan-mode service not composed in this runtime')
    }
    const agent = this.liveAgent(sessionId)
    const result = this.idbotsPlanMode.set(agent, active === true)
    return { ok: true, result, plan: this.idbotsPlanMode.get(agent) }
  }

  /**
   * Idle-session native compaction (same seam as DSH /compact). compactNow
   * replaces a history span in place; expected failures return `{ ok: false,
   * code }` so the host can surface busy/summary/commit without a JSON-RPC
   * exception. Returns compacted:false when no useful range exists.
   */
  async idbotsCompact({ sessionId } = {}) {
    const id = String(sessionId ?? '')
    if (id.length === 0) {
      return { ok: false, code: 'no-agent', message: 'idbots/compact requires sessionId' }
    }
    if (this.idbotsCompaction === null) {
      return { ok: false, code: 'unavailable', message: 'compaction service is not mounted' }
    }
    let agent
    try {
      agent = this.liveAgent(id)
    } catch (error) {
      return { ok: false, code: 'no-agent', message: error instanceof Error ? error.message : String(error) }
    }
    const controller = new AbortController()
    try {
      const result = await this.idbotsCompaction.compactNow(agent, controller.signal)
      if (result === null) {
        return { ok: true, compacted: false }
      }
      return {
        ok: true,
        compacted: true,
        shadowedItemCount: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
        shadowedTokenCount: result.shadowedTokenCount ?? 0,
      }
    } catch (error) {
      const code = error?.name === 'ManualCompactionError' && typeof error.code === 'string'
        ? error.code
        : 'error'
      return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async idbotsSubagentsMessages({ sessionId, agentId, limit }) {
    void sessionId
    const childId = String(agentId ?? '')
    // Live ring buffer first; a child from before this process's lifetime
    // (restart / runtime reap) reads its transcript back from persistence.
    const events = this.idbotsChildEvents.get(childId) ?? await this.idbotsReadSessionEvents(childId)
    const messages = []
    for (const event of events) {
      const data = event.data ?? {}
      if (event.type === 'user/message' && (data.source ?? data.message?.source)?.kind === 'user') {
        const text = (data.content ?? data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        messages.push({ id: `${agentId}-u-${messages.length}`, type: 'user', content: text, timestamp: event.time })
      } else if (event.type === 'assistant/message') {
        const text = (data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (text) messages.push({ id: `${agentId}-a-${messages.length}`, type: 'assistant', content: text, timestamp: event.time })
      }
    }
    const capped = Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages
    return { messages: capped }
  }

  /**
   * Host-side stop for a continuable child: the kernel's 'user' authority
   * cancels only the child's CURRENT turn (queued inbox messages stay parked;
   * the child itself stays resident for later send_message follow-ups). The
   * kernel re-validates that the child belongs to parentSessionId.
   */
  idbotsSubagentInterrupt({ sessionId, agentId }) {
    const parent = String(sessionId ?? '')
    const target = String(agentId ?? '')
    if (parent.length === 0 || target.length === 0) {
      throw new Error('idbots/subagent/interrupt requires sessionId and agentId')
    }
    if (this.idbotsSubagents === null) {
      throw new Error('idbots/subagent/interrupt: subagent service not composed')
    }
    try {
      this.idbotsSubagents.interrupt(target, { kind: 'user', parentSessionId: parent })
    } catch (error) {
      // Stale panel rows (child already gone, or lineage moved on) surface as
      // a graceful declined stop instead of a JSON-RPC exception.
      const message = error instanceof Error ? error.message : String(error)
      if (!/UNAUTHORIZED|belongs to another parent|is not a live/i.test(message)) throw error
      return { accepted: false, reason: message }
    }
    return { accepted: true }
  }

  async idbotsPolicyRespond({ id, decision, reason }) {
    const entry = this.idbotsPolicyPending.get(String(id))
    if (entry === undefined) {
      throw new Error(`idbots-sdk-server: no pending policy decision ${JSON.stringify(id)}`)
    }
    this.idbotsPolicyPending.delete(String(id))
    entry.resolve({ decision: decision === 'allow' || decision === 'ask' || decision === 'review' ? decision : 'deny', reason })
    return { answered: true, id }
  }
}

export function apply(ctx, config = {}) {
  const rootFiber = ctx.root.fiber
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const exit = config.exit ?? ((code) => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  const server = new IdbotsSdkServer(ctx, transport, {
    maxTokensAsSuccess: config.maxTokensAsSuccess !== false,
    subagentModelSelection: config.subagentModelSelection === true,
  })
  server.idbotsRegisterHostTools(config.tools)
  server.idbotsRegisterPolicyGate(config.policyTools)

  let exitTask
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    // Mirror the rc.8 stock server: `initialize` is the readiness boundary, so
    // do not answer it until async sibling Loader entries (e.g. an MCP
    // client's initial tool discovery) have settled.
    if (method === 'initialize') await ctx.get('loader')?.await()
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'idbots-sdk-server.serve')
}
