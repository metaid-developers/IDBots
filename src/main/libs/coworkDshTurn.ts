// DSH turn orchestration for cowork sessions (Phase 1 M5).
//
// DshTurnHub owns one DshKernel (and therefore one runtime subprocess) PER
// provider key. Twin on official DeepSeek and Lucy on OpenCode must be able
// to run at the same time — a single shared process cannot pick up a new
// provider without restarting, and that restart used to dispose every
// in-flight turn ("DSH runtime stream closed", exit 0). Same-provider
// sessions still multiplex on one kernel (models union via mergeProviderRoute).
//
// A config change the running process cannot serve (a new model route or MCP
// server joining the union) used to wait a bounded 90s for in-flight turns
// and then restart anyway — killing any turn still running past the budget
// (incident: a long scheduled-task turn died exactly 90s after a v4-pro
// session first arrived on a flash-only slot). Now such a change boots a
// SUCCESSOR kernel immediately and marks the old one draining: the caller's
// turn runs on the successor, in-flight turns finish on the old process, and
// the drained process closes once its last turn settles.
// DshTurnController drives one active turn: ensure → prompt → mapper
// actions → turn end, with native steer/cancel and approval bridging.

import { app } from 'electron'
import { join } from 'path'
import {
  getMetaidRpcToken,
  getMetaidRpcTokenFilePath,
  METAID_RPC_AUTHFILE_ENV,
} from '../services/metaidRpcEndpoint'
import { DshKernel, isSessionEncodingMismatchError } from './dshKernel/dshKernel'
import { DshShutdownError } from './dshShutdownError'

/**
 * The runtime process died on its own (crash/OOM/kill) — as opposed to a
 * deliberate close/restart. The SDK surfaces this as a closedError whose
 * message names the exit; `DshKernel: closed` is deliberately excluded
 * (that one means *we* closed it, e.g. app shutdown — see DshShutdownError).
 */
function isUnexpectedRuntimeExitError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  if (text.includes('DshKernel: closed') || text.includes('DshTurnHub: shutting down')) return false
  // "runtime is not running" is the request-side face of the same death (a
  // call raced the crash before the notification pump marked the client
  // dead) — it must respawn too, not fail the turn.
  return /runtime exited|stream closed|runtime is not running/i.test(text)
}
import type { DshKernelOptions } from './dshKernel/dshKernel'
import { dshModelReasoningDeclaration } from './dshModelReasoning'
import { currentClientTimeZone } from './dshKernel/clientTimeZone'
import type {
  DshApprovalAsk,
  DshHostToolImagePayload,
  DshMcpServerDefinition,
  DshUsageProjectionResult,
  DshUserQuestionAsk,
  DshPromptSectionInput,
  DshProviderRoute,
  DshRuntimeConfigInput,
  DshStreamSlot,
  DshUsageSnapshot,
} from './dshKernel/types'

export { dshRuntimeConfigFileName } from './dshKernel/dshKernel'

export interface DshTurnProviderRoute {
  key: string
  apiFormat: 'openai' | 'responses' | 'anthropic'
  baseUrl: string
  apiKey: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
  /** Input modalities the model declares (['text','image'] for vision models). */
  inputModalities?: string[]
  /** Per-turn DSH reasoning effort (off|low|medium|high|max on the pi-ai
   * vocabulary; the native deepseek ladder is off|low|high|max). */
  reasoningEffort?: string
}

/** Automation backends bundled into a runtime slot key. Browser automation
 *  and computer use mount at composition scope (runtime-wide), so a bot that
 *  opts in must not share its process with bots that did not — keying the
 *  slot by the exact opt-in combo makes cross-bot tool leaks structurally
 *  impossible and lets an opt-out take effect on the very next turn (the
 *  session re-pins onto the clean runtime, the automation slot idles out). */
export interface DshAutomationSlotFlags {
  browser: boolean
  computer: boolean
}

/** Pool key for a DSH runtime process: one subprocess per provider AND
 *  automation combo. Both-off keeps the legacy bare provider key (existing
 *  runtime ids/config files are untouched); opted-in combos get a filename-
 *  safe suffix (`.auto-b` / `.auto-c` / `.auto-bc`). */
export function dshRuntimeKeyOf(
  provider: Pick<DshTurnProviderRoute, 'key'>,
  automation?: DshAutomationSlotFlags,
): string {
  const browser = automation?.browser === true
  const computer = automation?.computer === true
  if (!browser && !computer) return provider.key
  return `${provider.key}.auto-${browser ? 'b' : ''}${computer ? 'c' : ''}`
}

/** Map a turn's resolved automation state onto the slot-key flags. */
function automationSlotFlagsOf(state: DshAutomationSlotState): DshAutomationSlotFlags {
  return { browser: state.browserUse !== undefined, computer: state.computerUse }
}

/** Env var carrying the DeepSeek key for the runtime's web-search provider. */
const DSH_WEBSEARCH_API_KEY_ENV = 'IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'
/** Model serving the auxiliary search call (cheap + fast; search quality is
 *  provider-side, the model only formats the query — official DSH default). */
const DSH_WEBSEARCH_MODEL = 'deepseek-flash'

/** Stable per-route credential env var name. The runtime child env is fixed
 *  at spawn while the route table is a cross-session UNION, so every route
 *  MUST read its own env name — a single shared name (the pre-fix
 *  IDBOTS_DSH_API_KEY) carried only the key of whichever provider last
 *  restarted the runtime, and every other route then sent that foreign key
 *  upstream (opencode/deepseek cross-provider 401 "Invalid API key" while
 *  the very same key worked via curl). dsh-credentials only accepts refs
 *  matching /^[A-Za-z_][A-Za-z0-9_]*$/, so provider-key characters outside
 *  [A-Za-z0-9_] collapse to '_' (route-key collisions would already merge
 *  in the config generator's own sanitization, so this stays unique). */
export const dshProviderApiKeyEnv = (providerKey: string): string =>
  `IDBOTS_DSH_KEY_${String(providerKey).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`

/** Hostname of a URL string, '' when it does not parse (regex, not URL — an
 *  invalid base can never throw here; port/userinfo are not provider shapes). */
function hostnameOf(value: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(value.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

/** True when the route is the official DeepSeek provider (key or api host). */
export function isOfficialDeepSeekRoute(provider: Pick<DshTurnProviderRoute, 'key' | 'baseUrl'>): boolean {
  const key = provider.key?.toLowerCase()
  return key === 'deepseek' || key === 'deepseek-official' || hostnameOf(provider.baseUrl) === 'api.deepseek.com'
}

/**
 * True when the route rides the first-party dsh-llm-deepseek adapter. Since
 * kernel 0.1.7 that adapter speaks the OFFICIAL Messages-API dialect
 * (thinking / `output_config.effort` ladder, `<origin>/anthropic` root after
 * the config generator's base-URL migration), so it is only valid against
 * api.deepseek.com. A provider keyed 'deepseek' with a custom base URL —
 * proxy relays preserved by the model-settings migration, which hides the
 * field but keeps stored values — must stay on the generic pi-ai route: the
 * official dialect sent to an OpenAI-compatible relay is an HTTP 400 the
 * relay reports without DeepSeek's `{"error":{...}}` body, surfacing as the
 * generic "DeepSeek API error (HTTP 400)" turn failure.
 */
export function isNativeDeepSeekChatRoute(
  route: { provider?: string | null; baseUrl?: string | null; apiFormat?: string | null },
): boolean {
  return route.provider === 'deepseek'
    && route.apiFormat !== 'anthropic'
    && hostnameOf(String(route.baseUrl ?? '')) === 'api.deepseek.com'
}

/**
 * Normalize any DeepSeek provider base URL onto the Anthropic-compatible root
 * the web-search provider expects (`/messages` is appended by the package):
 * `https://api.deepseek.com` / `.../v1` / `.../anthropic` / `.../responses`-style
 * bases all resolve to `<root>/anthropic/v1`.
 */
export function deepSeekWebSearchBaseURL(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  base = base.replace(/\/responses$/, '')
  if (/\/anthropic\/v\d+$/.test(base)) return base
  if (/\/anthropic$/.test(base)) return `${base}/v1`
  // A chat-completions-style `.../v1` base (the common OpenAI-format DeepSeek
  // config) must collapse to the host root first — the Anthropic-compatible
  // endpoint is NOT nested under it, so `/v1/anthropic/v1/messages` 404s.
  base = base.replace(/\/v\d+$/, '')
  return `${base}/anthropic/v1`
}

export interface DshTurnCallbacks {
  onMessage: (
    message: { type: string; content: string; metadata?: Record<string, unknown> },
    slot?: DshStreamSlot
  ) => string
  onMessageUpdate: (messageId: string, content: string) => void
  onMessageFinalize: (messageId: string, content: string, metadata?: { isThinking?: boolean }) => void
  onUsage: (usage: DshUsageSnapshot) => void
  onApprovalRequest: (ask: DshApprovalAsk) => void
  onApprovalCancelled: (askId: string) => void
  onAskRequest?: (ask: DshUserQuestionAsk) => void
  onAskCancelled?: (askId: string) => void
  onSubagentEvent?: (event: {
    kind: 'started' | 'progress' | 'finished'
    sessionId: string
    agentId: string
    summary?: string
    status?: string
  }) => void
  onError?: (error: Error) => void
}

export interface DshTurnInput {
  /** Cowork session id (store key). */
  sessionId: string
  /** Host-bridged tool schemas to expose to the model this turn. */
  hostTools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  /** Workspace mount for DSH-native bash/fs tools. */
  workspace?: { cwd: string }
  /** DSH session id (without the dsh: prefix). */
  dshSessionId: string
  provider: DshTurnProviderRoute
  /** Stable prompt layers (promptComposer sections). */
  sections: DshPromptSectionInput[]
  /** Full user-visible turn text (volatile context already prepended). */
  prompt: string
  /** Image attachments to commit and send alongside the prompt text. */
  promptImages?: DshHostToolImagePayload[]
  callbacks: DshTurnCallbacks
}

export interface DshTurnOutcome {
  kind: string
  reason?: string
  /** Carried on kind:'error' outcomes: the provider/runtime failure detail
   *  straight from the turn/end reason ({ message, code }) — e.g. TRANSPORT
   *  for a network-level fetch failure. */
  error?: { message?: string; code?: string }
  /** True when the turn stopped cleanly having produced no text and no tool
   * calls (the DeepSeek reasoning-only truncation signature). */
  emptyTerminal?: boolean
}

class DshTurnController {
  readonly dshSessionId: string
  private readonly callbacks: DshTurnCallbacks
  private settleTurn!: (reason: DshTurnOutcome) => void
  private readonly turnDone: Promise<DshTurnOutcome>
  private steerWaiters: Array<(text: string) => void> = []
  /**
   * Set while a steer's inbox message has not been consumed by a follow-up
   * turn yet. Any turn boundary that arrives in this state — the steer's own
   * cancel(keepInbox) abort, or a natural end racing the steer — is swallowed
   * instead of settling the turn: the preserved inbox steer is waking input,
   * so a follow-up turn is guaranteed and the caller's single runTurn must
   * stay open until the steered exchange finishes. Only fatal outcomes
   * (kind 'error') and non-steer aborts (user stop, stall watchdog) settle
   * through; see handleTurnEnd.
   */
  private steerFollowUpExpected = false

  constructor(input: DshTurnInput) {
    this.dshSessionId = input.dshSessionId
    this.callbacks = input.callbacks
    this.turnDone = new Promise((resolve) => { this.settleTurn = resolve })
  }

  done(): Promise<DshTurnOutcome> {
    return this.turnDone
  }

  handleTurnEnd(reason: { kind: string; reason?: unknown }, emptyTerminal?: boolean): void {
    const outcome = emptyTerminal === true ? { ...reason, emptyTerminal: true } : reason
    // Fatal outcomes and non-steer aborts (user stop, stall watchdog) always
    // settle through — a pending steer never outranks them. The steer abort
    // reads as the pre-0.1.7 string cause 'steer' or, since the kernel's
    // closed cancel-cause union, the V4 hook form {kind:'hook',reason:'steer'}
    // the wire extension now translates it into.
    const abortCause = reason.reason
    const isSteerAbort = abortCause === 'steer'
      || (typeof abortCause === 'object' && abortCause !== null
        && (abortCause as { kind?: unknown }).kind === 'hook'
        && (abortCause as { reason?: unknown }).reason === 'steer')
    const settlesThrough = reason.kind === 'error'
      || (reason.kind === 'aborted' && !isSteerAbort)
    if (this.steerFollowUpExpected && !settlesThrough) {
      // Swallow exactly one boundary — the steer's cancel(keepInbox) abort,
      // or a natural end that raced the steer (an unconsumed inbox steer is
      // waking input, so a follow-up turn is guaranteed and owns settlement).
      this.steerFollowUpExpected = false
      return
    }
    this.steerFollowUpExpected = false
    this.settleTurn(outcome as DshTurnOutcome)
    for (const waiter of this.steerWaiters.splice(0)) waiter('')
  }

  /** Arm the swallow above: the next steer-abort boundary belongs to us. */
  expectSteerFollowUp(): void {
    this.steerFollowUpExpected = true
  }

  /** Disarm without settling — used when the steer/cancel RPCs failed. */
  clearSteerFollowUp(): void {
    this.steerFollowUpExpected = false
  }

  notifySteerDelivered(text: string): void {
    for (const waiter of this.steerWaiters.splice(0)) waiter(text)
  }

  waitForSteerDelivery(): Promise<string> {
    return new Promise((resolve) => this.steerWaiters.push(resolve))
  }

  get cb(): DshTurnCallbacks {
    return this.callbacks
  }
}

export interface DshHubOptions {
  runtimeDir?: string
  /** Session-root directory under userData (versioned per format). */
  sessionRoot: string
  /** Execute a host-bridged tool call; resolves {ok,text,images?} or rejects. */
  executeTool?: (coworkSessionId: string, name: string, args: Record<string, unknown>) => Promise<{ ok: true; text: string; images?: DshHostToolImagePayload[] } | { ok: false; error: string }>
  /** Host permission chain for runtime-native tools (bash/write/edit…). */
  evaluatePolicy?: (coworkSessionId: string, name: string, args: Record<string, unknown>) => Promise<{ decision: 'allow' | 'deny' | 'ask'; reason?: string }>
  /** User-configured MCP servers, read fresh each turn (additions mount on the
   * next turn; the config union never removes until restart, same as providers). */
  mcpServersProvider?: (coworkSessionId: string) => DshMcpServerDefinition[]
  /** 0.1.7 experimental browser automation (dsh-browser-use + Playwright MCP),
   *  per-bot opt-in. One headless Chromium per session. The provider mounts at
   *  composition scope, so opted-in sessions are routed onto their own
   *  provider+automation runtime slot (dshRuntimeKeyOf) — sessions whose bot
   *  did not opt in never see the tools, and opting out re-pins the session
   *  onto the clean slot on the very next turn. */
  browserAutomationProvider?: (coworkSessionId: string) => DshRuntimeConfigInput['browserUse'] | undefined
  /** 0.1.7 experimental desktop control (cua-driver native). Per-bot opt-in
   *  with the same slot isolation as browser automation; the host app must
   *  hold the OS desktop permission grants. */
  computerUseProvider?: (coworkSessionId: string) => boolean
  log?: DshKernelOptions['log']
  /** Extra composition entries for the runtime (test fixtures; later the
   * idbots tools/policy plugins mount here). */
  extraEntries?: Array<Record<string, unknown>>
  /** Re-read every turn (unlike the static extraEntries): the user-managed
   *  plugin directory feeds entries here, so an install/uninstall applies on
   *  the next turn — config-change restart waits for quiescence as usual. */
  extraEntriesProvider?: () => Array<Record<string, unknown>>
  /** Idle-session events (native compact checkpoints) when no turn controller is live. */
  onIdleSessionMessage?: (coworkSessionId: string, message: { type: string; content: string; metadata?: Record<string, unknown> }) => string
  /** Idle-session stream deltas (controller-less kernel turns): throttled
   *  renderer-only updates; SQLite stays finalize-only, same as host turns. */
  onIdleSessionMessageUpdate?: (coworkSessionId: string, messageId: string, content: string) => void
  /** Idle-session stream finalizes (controller-less kernel turns): persist
   *  the accumulated content and close the streaming placeholder. Without
   *  this fallback a kernel-initiated turn's placeholders are created via
   *  onIdleSessionMessage but never finalized — orphaned isStreaming rows the
   *  transcript then misreads as an aborted turn. */
  onIdleSessionMessageFinalize?: (coworkSessionId: string, messageId: string, content: string, metadata?: Record<string, unknown>) => void
  /** Whole-agent status transitions for OWNED sessions (strict mapping — a
   *  continuable child's lifecycle never maps to its parent). Fires for
   *  kernel-initiated turns too, so hosts can hold queue gates closed while
   *  a controller-less kernel turn runs and release them when it settles. */
  onSessionStatusChange?: (coworkSessionId: string, status: 'idle' | 'running') => void
  /** Automatic session titles: the kernel's dsh-session-title fallback lands
   *  on the first human message; the LLM summary refinement is host-owned
   *  (coworkRunner.scheduleHostSessionTitleRefinement). Fires for live
   *  appends only; the host decides whether the sidebar title may follow. */
  onSessionTitle?: (coworkSessionId: string, title: string, source: 'fallback' | 'provider' | 'user') => void
  /** Global skill-script host env (IDBOTS_API_BASE_URL, SKILLS_ROOT, BASH_ENV, …).
   *  Re-read every ensure. Per-session identity cannot live here (shared
   *  runtime); those values are written to a DSH_SESSION_ID-keyed env file
   *  that bash sources via BASH_ENV after the KEY/TOKEN scrub. */
  skillHostEnvProvider?: () => Record<string, string>
  /** Close a slot's runtime after this long with no in-flight turns
   *  (default 30min; 0 disables; tests shrink it). Next turn on that slot
   *  cold-starts and resumes sessions from disk. Also sweeps drained
   *  (superseded) kernels whose turns have all settled. */
  runtimeIdleTtlMs?: number
  /**
   * Grace window for kernel-side activity (any runtime notification —
   * host-turn or kernel-initiated, e.g. continuable-subagent turns with no
   * host controller). A runtime that observed a notification within this
   * window is treated as busy: drained kernels are not retired, slots are
   * not reaped, and config changes take the successor+drain path instead
   * of an in-place restart (default 10min; 0 disables the protection for
   * tests that need deterministic retirement).
   */
  kernelActivityGraceMs?: number
}

/** Child-env map for the shared DSH runtime. Route credentials and the RPC
 *  token stay first-class; skillHostEnv (IDBOTS_API_BASE_URL, SKILLS_ROOT)
 *  is merged last so bash-launched SKILL scripts inherit the same host
 *  channels as Claude subprocesses. */
export function buildDshChildEnv(parts: {
  routeApiKeys: Iterable<{ envName: string; apiKey: string }>
  webSearchApiKey?: string
  rpcToken: string
  rpcAuthFile: string
  skillHostEnv?: Record<string, string>
  /** Absolute path used as DSH_HOME for the runtime process. */
  dshHome?: string
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      [...parts.routeApiKeys].map(({ envName, apiKey }) => [envName, apiKey])
    ),
    ...(parts.webSearchApiKey ? { [DSH_WEBSEARCH_API_KEY_ENV]: parts.webSearchApiKey } : {}),
    IDBOTS_RPC_TOKEN: parts.rpcToken,
    [METAID_RPC_AUTHFILE_ENV]: parts.rpcAuthFile,
    // 0.1.7: pin the kernel home under userData so the DeepSeek Files-API
    // id-reuse cache (llm-deepseek/files-v3.json) and any other kernel home
    // state live in app-managed storage instead of ~/.dsh.
    ...(parts.dshHome ? { DSH_HOME: parts.dshHome } : {}),
    ...(parts.skillHostEnv ?? {}),
  }
}

/** Sentinel cowork/DSH session id for startup warmup (no MCP, no pin). */
export const DSH_WARMUP_SESSION_ID = '__dsh_warmup__'

/**
 * Default kernel-activity grace window (see DshHubOptions.kernelActivityGraceMs).
 * Streaming turns emit notifications continuously, so total silence for this
 * long means nothing observable is running host-side OR kernel-side; anything
 * more recent keeps the process alive through drains/reaps/config changes.
 */
export const DSH_KERNEL_ACTIVITY_GRACE_MS = 10 * 60_000

const DSH_WARMUP_CALLBACKS: DshTurnCallbacks = {
  onMessage: () => 'dsh-warmup',
  onMessageUpdate: () => undefined,
  onMessageFinalize: () => undefined,
  onUsage: () => undefined,
  onApprovalRequest: () => undefined,
  onApprovalCancelled: () => undefined,
}

/** One turn's resolved automation opt-in state, read ONCE per turn from the
 *  host providers so the slot key, the re-pin decision and the accumulated
 *  composition can never disagree (a mid-turn toggle race would otherwise
 *  route by stale flags while unioning fresh ones). */
interface DshAutomationSlotState {
  browserUse: DshRuntimeConfigInput['browserUse'] | undefined
  computerUse: boolean
}

interface DshEnsureKernelOptions {
  /** Real turns pin composition bash/fs plugin load to the first workspace
   *  (plugin default only). Per-session execution cwd rides session/ensure.
   *  Warmup loads the plugins without locking that default to a guessed cwd. */
  pinWorkspace?: boolean
  /** Real turns union MCP servers into the composition; warmup does not spawn
   *  user MCP subprocesses at app start. */
  accumulateMcp?: boolean
  /** Pre-resolved by runTurn (it needs the flags for the re-pin decision
   *  before ensureKernel runs); ensureKernel resolves them itself otherwise. */
  automation?: DshAutomationSlotState
}

/** One DSH subprocess and the composition state it was last spawned with. */
interface DshRuntimeSlot {
  key: string
  kernel: DshKernel
  /** Superseded kernels still serving their in-flight turns. A config change
   *  the running process cannot serve boots a successor kernel instead of
   *  restarting under live turns; drained kernels close once their last turn
   *  settles (never force-killed — a legitimately long turn must outlive the
   *  handover). */
  drainingKernels: DshKernel[]
  /** Serializes ensureRuntime for THIS slot so warmup and the first turn
   *  on the same provider cannot double-spawn. Other providers boot in parallel. */
  kernelEnsureChain: Promise<void>
  lastConfigJson: string | undefined
  workspaceSeen: DshRuntimeConfigInput['workspace']
  providersSeen: Map<string, DshProviderRoute>
  routeApiKeys: Map<string, { envName: string; apiKey: string }>
  mcpServersSeen: Map<string, DshMcpServerDefinition>
  /** The slot key already encodes this combo, so every turn landing here
   *  carries the same values — these simply record them for config rebuilds
   *  (warmup turns skip accumulation, so the first real turn writes them). */
  browserUseSeen?: DshRuntimeConfigInput['browserUse']
  computerUseSeen: boolean
  lastUsedAt: number
}

export class DshTurnHub {
  /** One runtime process per provider key + automation combo (a bot opted
   *  into browser/desktop automation never shares a process with bots that
   *  did not — see dshRuntimeKeyOf). */
  private readonly slots = new Map<string, DshRuntimeSlot>()
  /** Keyed by DSH session id — that is what kernel event callbacks carry. */
  private controllersByDsh = new Map<string, DshTurnController>()
  /** cowork session id → DSH session id (steer/cancel look up by cowork id). */
  private dshByCowork = new Map<string, string>()
  /** Reverse mapping for tool-request routing. */
  private coworkByDsh = new Map<string, string>()
  /** cowork id → dsh id, kept across turns for post-hoc panel lookups. */
  private pinnedDshIds = new Map<string, string>()
  /**
   * Continuable-subagent lineage: child DSH session id (== runtime agent id)
   * → parent DSH session id, learned from idbots/subagent/started. Resident
   * children run kernel-initiated turns with NO host controller, so their
   * policy/tool requests can only resolve through this lineage → parent's
   * cowork mapping (the delegation captured the parent's policy, making the
   * parent's checks exactly the right gate). Without it every native-tool
   * check from a continuable child fails closed with "no cowork session
   * mapping" (2026-09-28 session 540635be: 48 denied tool calls while the
   * workers kept retrying). The runtime re-emits started on every
   * re-materialization, so entries stay fresh for live children; finished
   * (agent/disposed) and close() remove them.
   */
  private subagentParentByChild = new Map<string, string>()
  /** dsh session id → provider key of the kernel that last served it. */
  private runtimeKeyByDsh = new Map<string, string>()
  /** dsh session id → the kernel instance whose process holds the session's
   *  live agent. Slot key alone is ambiguous while a superseded kernel drains
   *  alongside its successor; steer/cancel/dispose must reach the exact
   *  process that owns the agent. */
  private kernelByDsh = new Map<string, DshKernel>()
  /** Approval / ask ids belong to the kernel that raised them. */
  private askKernelById = new Map<string, DshKernel>()
  /** DeepSeek server-side web search is composition-level and shared across
   *  every provider slot once an official DeepSeek route has been seen —
   *  same stickiness as the pre-split single runtime. */
  private webSearchSeen: { apiKey: string; baseURL: string } | null = null
  private reapTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-DSH-session turn chain: a runTurn for a session whose previous turn
   *  is still in flight must queue, never overwrite the live controller —
   *  the overwrite made the loser's finally delete the winner's event
   *  registrations, silently dropping a reply the runtime had produced. */
  private turnChainsByDsh = new Map<string, Promise<void>>()
  /** Abort-convergence guard: the kernel's session/cancel ack means the abort
   *  was REQUESTED, not that it converged (0.2.0 does tool-result recovery
   *  work on the abort path, widening the window further). Session-scoped
   *  wire events carry no turn discriminator, so a runTurn that registers its
   *  controller while the previous turn's abort is still converging catches
   *  the late turn-end boundary and settles instantly with a phantom
   *  'aborted' (observed 2026-09-29: a watchdog-cancelled turn's boundary
   *  killed the re-sent turn 7ms in). runTurn waits for the next turn-end
   *  boundary after a cancel — or a bounded backstop, since a cancel against
   *  an already-idle agent never emits one. */
  private pendingAbortByDsh = new Map<string, { promise: Promise<void>; settle: () => void; timer: ReturnType<typeof setTimeout> }>()
  /** Set the moment close() begins: turns submitted afterwards fail soft
   *  (DshShutdownError) instead of booting orphan runtimes during shutdown. */
  private closed = false
  private readonly opts: DshHubOptions

  constructor(opts: DshHubOptions) {
    this.opts = opts
  }

  get running(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.kernel.running) return true
      if (slot.drainingKernels.some((kernel) => kernel.running)) return true
    }
    return false
  }

  get restartCount(): number {
    let total = 0
    for (const slot of this.slots.values()) {
      total += slot.kernel.restartCount
      for (const kernel of slot.drainingKernels) total += kernel.restartCount
    }
    return total
  }

  /** Test/diagnostics: how many runtime slots (provider + automation combo) exist. */
  get runtimeSlotCount(): number {
    return this.slots.size
  }

  /**
   * Spawn (or reuse) the shared runtime without opening a session or sending
   * a prompt. Used at app-ready so the first cowork turn does not pay process
   * boot + plugin load. Workspace is mounted for bash/fs plugin load but not
   * pinned — execution cwd is per-session on session/ensure, and the first
   * real turn still owns the composition plugin-default lock.
   */
  async prewarm(input: {
    provider: DshTurnProviderRoute
    workspace?: { cwd: string }
  }): Promise<void> {
    await this.ensureKernel({
      sessionId: DSH_WARMUP_SESSION_ID,
      dshSessionId: DSH_WARMUP_SESSION_ID,
      prompt: '',
      provider: input.provider,
      sections: [],
      workspace: input.workspace,
      callbacks: DSH_WARMUP_CALLBACKS,
    }, { pinWorkspace: false, accumulateMcp: false })
  }

  /** Start (or reuse) the runtime and run one turn to completion. */
  async runTurn(input: DshTurnInput): Promise<DshTurnOutcome> {
    if (this.closed) throw new DshShutdownError()
    // One active turn per DSH session: a concurrent runTurn for the same
    // session must never overwrite the live controller in controllersByDsh —
    // the overwriting turn's finally also deleted the winner's registrations,
    // so a turn that completed in the runtime never reached the host. Queue
    // behind the in-flight turn instead (the loop re-checks after each wake
    // so multiple waiters chain onto the latest one, not all at once).
    for (;;) {
      const prior = this.turnChainsByDsh.get(input.dshSessionId)
      if (prior === undefined) break
      this.opts.log?.('info', 'dshTurnHub.turnQueued', {
        sessionId: input.sessionId,
        dshSessionId: input.dshSessionId,
      })
      await prior
      if (this.closed) throw new DshShutdownError()
    }
    let releaseTurn!: () => void
    const mine = new Promise<void>((resolve) => { releaseTurn = resolve })
    this.turnChainsByDsh.set(input.dshSessionId, mine)
    try {
      // Hold the chain while the previous turn's abort converges: queued
      // turns wait behind us, and we must not register a controller while a
      // late turn-end boundary for the cancelled predecessor can still arrive
      // (see pendingAbortByDsh).
      await this.pendingAbortByDsh.get(input.dshSessionId)?.promise
      if (this.closed) throw new DshShutdownError()
      return await this.runTurnExclusive(input)
    } finally {
      // Runs after runTurnExclusive's own finally (controller cleanup), so a
      // queued turn starts only once its predecessor fully settled.
      if (this.turnChainsByDsh.get(input.dshSessionId) === mine) this.turnChainsByDsh.delete(input.dshSessionId)
      releaseTurn()
    }
  }

  private async runTurnExclusive(input: DshTurnInput): Promise<DshTurnOutcome> {
    if (this.closed) throw new DshShutdownError()
    // Resolve the automation opt-in ONCE per turn: the slot key below, the
    // re-pin decision and the composition union inside ensureKernel must all
    // agree, or a mid-setup toggle could route by stale flags while unioning
    // fresh ones (re-introducing the cross-bot leak the key split prevents).
    const automation = this.automationSlotStateOf(input.sessionId)
    const nextKey = dshRuntimeKeyOf(input.provider, automationSlotFlagsOf(automation))
    const prevKey = this.runtimeKeyByDsh.get(input.dshSessionId)
    // Same dsh session id + a new slot key: the old process still holds
    // the live agent (idbotsAgents never evicts on its own). Re-pinning
    // without dispose leaves A→B→A talking to A's stale in-memory agent
    // that never saw B's turns, and two processes writing one JSONL. A key
    // change is also how an automation toggle takes effect: the session
    // leaves the old combo's runtime and resumes from disk on the new one.
    if (prevKey && prevKey !== nextKey) {
      await this.disposeSessionOnSlot(prevKey, input.dshSessionId)
    }
    this.runtimeKeyByDsh.set(input.dshSessionId, nextKey)
    let kernel = await this.ensureKernel(input, { automation })
    // The session's live agent may sit on a superseded (draining) kernel when
    // this turn starts — release it there first so exactly one process owns
    // the JSONL (same contract as the cross-provider re-pin above).
    const holder = this.kernelByDsh.get(input.dshSessionId)
    if (holder && holder !== kernel && holder.running) {
      await holder.disposeSession(input.dshSessionId).catch(() => undefined)
    }
    this.kernelByDsh.set(input.dshSessionId, kernel)
    const controller = new DshTurnController(input)
    // runTurn's per-session queue guarantees no live controller for this dsh
    // session at this point; the set is a fresh registration, never an
    // overwrite of an in-flight turn.
    this.controllersByDsh.set(input.dshSessionId, controller)
    this.dshByCowork.set(input.sessionId, input.dshSessionId)
    this.coworkByDsh.set(input.dshSessionId, input.sessionId)
    this.pinnedDshIds.set(input.sessionId, input.dshSessionId)

    try {
      // Encoding-mismatch self-heal (2026-09-01 incident: a sibling app
      // instance on an older pre-zstd build sharing this userData kept a
      // compression:'none' backend alive and dropped plaintext artifacts into
      // the root after this slot's zstd runtime booted; every session/ensure
      // then died and the task behind it stalled). The backend caches its
      // root-encoding rejection, so recovery needs all three steps: re-migrate
      // the drifted artifacts, swap in a fresh process (clean cache), retry
      // the ensure there exactly once. Non-mismatch errors propagate as-is.
      const ensureSessionInput = {
        sessionId: input.dshSessionId,
        provider: input.provider.key,
        model: input.provider.model,
        ...Number.isFinite(input.provider.maxOutputTokens) ? { maxTokens: input.provider.maxOutputTokens } : {},
        ...(input.provider.reasoningEffort != null && input.provider.reasoningEffort !== ''
          ? { reasoningEffort: input.provider.reasoningEffort }
          : {}),
        sections: input.sections,
        hostTools: input.hostTools,
        ...(input.workspace?.cwd ? { cwd: input.workspace.cwd } : {}),
      }
      let runtimeRespawnAttempted = false
      for (;;) {
        if (this.closed) throw new DshShutdownError()
        try {
          try {
            await kernel.ensureSession(ensureSessionInput)
          } catch (error) {
            const slot = this.slots.get(nextKey)
            // Heal only zstd compositions — a plaintext ('none') test composition
            // must not have its artifacts migrated out from under it.
            if (!slot || !isSessionEncodingMismatchError(error) || slot.lastConfigJson?.includes('"persistenceCompression":"none"')) {
              throw error
            }
            this.opts.log?.('warn', 'dshTurnHub.encodingMismatchHeal', {
              runtime: nextKey,
              sessionId: input.sessionId,
              message: error instanceof Error ? error.message : String(error),
            })
            await kernel.remigrateSessionRootToZstd()
            // Never boot the successor into a closing hub — that would orphan
            // a runtime process during app shutdown.
            if (this.closed) throw new DshShutdownError()
            const successor = this.supersedeKernel(slot)
            const config = this.buildRuntimeConfig(slot, input)
            await successor.ensureRuntime(config)
            slot.lastConfigJson = JSON.stringify(config)
            kernel = successor
            this.kernelByDsh.set(input.dshSessionId, successor)
            await successor.ensureSession(ensureSessionInput)
          }
          await kernel.prompt(input.dshSessionId, input.prompt, input.promptImages)
          break
        } catch (error) {
          // A closing hub (app quit) kills in-flight session calls with raw
          // transport errors ("DeepSeek Harness runtime closed", "exited"…)
          // that name no shutdown — reclassify by state, not text, so every
          // caller sees the one soft-fail type.
          if (this.closed) throw new DshShutdownError()
          // Unexpected runtime death (crash/OOM): the kernel keeps a stale
          // client and every session call would fail the turn into session
          // 'error'. Respawn the process once and retry the ensure+prompt;
          // anything on the second failure propagates as before.
          if (runtimeRespawnAttempted || !isUnexpectedRuntimeExitError(error)) {
            throw error
          }
          runtimeRespawnAttempted = true
          this.opts.log?.('warn', 'dshTurnHub.respawnAfterUnexpectedExit', {
            runtime: nextKey,
            sessionId: input.sessionId,
            message: error instanceof Error ? error.message : String(error),
          })
          const slot = this.slots.get(nextKey) ?? this.getOrCreateSlot(nextKey)
          const config = this.buildRuntimeConfig(slot, input)
          await kernel.restart(config)
          slot.lastConfigJson = JSON.stringify(config)
          this.kernelByDsh.set(input.dshSessionId, kernel)
        }
      }
      try {
        return await controller.done()
      } catch (error) {
        // Same reclassification for the streaming stage: the runtime was
        // closed out from under the turn by app shutdown, not by the turn.
        if (this.closed) throw new DshShutdownError()
        throw error
      }
    } finally {
      this.controllersByDsh.delete(input.dshSessionId)
      this.dshByCowork.delete(input.sessionId)
      this.coworkByDsh.delete(input.dshSessionId)
      // Turn ran on a superseded kernel: release its agent so the successor
      // can resume the session from disk, then retire the drained process
      // once nothing else runs on it.
      const servedKernel = this.kernelByDsh.get(input.dshSessionId)
      const slot = this.slots.get(nextKey)
      if (servedKernel && slot && servedKernel !== slot.kernel) {
        await servedKernel.disposeSession(input.dshSessionId).catch(() => undefined)
        this.settleDrains(nextKey)
      }
      this.scheduleReap()
    }
  }

  /**
   * Strictly-owned resolution: the live turn mapping plus the session's OWN
   * pin. Used by transcript-affecting paths (idle message insertion, session
   * titles) — a continuable child's raw transcript must NOT fold into the
   * parent chat (children report through send_message + the subagent panel
   * by design) and a child title must not rename its parent's session.
   */
  private ownedCoworkOfDsh(dshSessionId: string): string | undefined {
    const live = this.coworkByDsh.get(dshSessionId)
    if (live) return live
    for (const [coworkId, dshId] of this.pinnedDshIds) {
      if (dshId === dshSessionId) return coworkId
    }
    return undefined
  }

  private coworkOfDsh(dshSessionId: string): string | undefined {
    const owned = this.ownedCoworkOfDsh(dshSessionId)
    if (owned) return owned
    // Continuable-subagent lineage: a resident child session resolves through
    // its parent's cowork mapping — the delegation captured the parent's
    // policy, so the child's checks are exactly the parent's checks. Used by
    // request routing (policy/tool); an unknown session still returns
    // undefined so the fail-closed deny for genuinely unresolvable sessions
    // is preserved.
    const parent = this.subagentParentByChild.get(dshSessionId)
    if (parent !== undefined && parent !== dshSessionId) {
      return this.ownedCoworkOfDsh(parent)
    }
    return undefined
  }

  /**
   * True while the kernel reports this cowork session's agent as running —
   * the ONLY signal that covers kernel-initiated turns (subagent-finished
   * wakes, scheduled nudges), which run with no host controller and are
   * invisible to controllersByDsh/activeSession-based busy checks.
   */
  isKernelSessionBusy(coworkSessionId: string): boolean {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    if (!dshId) return false
    for (const slot of this.slots.values()) {
      if (slot.kernel.isSessionBusy(dshId)) return true
      for (const kernel of slot.drainingKernels) {
        if (kernel.isSessionBusy(dshId)) return true
      }
    }
    return false
  }

  /**
   * Idle-session native compact (DSH /compact). Requires a live runtime and a
   * pinned DSH session from a previous turn. Busy when a turn is in flight.
   */
  async compact(coworkSessionId: string): Promise<{
    ok: boolean
    compacted?: boolean
    code?: string
    message?: string
    shadowedItemCount?: number
    shadowedTokenCount?: number
  }> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    if (!dshId) {
      return { ok: false, code: 'no-agent', message: 'no DSH session to compact' }
    }
    const kernel = this.kernelForDsh(dshId)
    if (!kernel) {
      return { ok: false, code: 'no-runtime', message: 'DSH runtime is not running' }
    }
    if (this.controllersByDsh.has(dshId)) {
      return {
        ok: false,
        code: 'busy',
        message: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      }
    }
    return kernel.compact(dshId)
  }

  private controllerOfCowork(sessionId: string): DshTurnController | undefined {
    const dshId = this.dshByCowork.get(sessionId)
    return dshId === undefined ? undefined : this.controllersByDsh.get(dshId)
  }

  /**
   * Interrupt-on-steer (parity with the local path's interrupt semantics):
   * cancel the active turn with keepInbox FIRST, then submit the steer. The
   * order is load-bearing — the runtime's wake latch only arms for waking
   * input submitted while the abort is converging (or after it reaches
   * idle); a steer submitted BEFORE the cancel parks in the inbox with
   * nobody left to wake it (verified against dsh-agent-loop: the aborted
   * turn exits the driver without the inbox continuation check, so the steer
   * sits dormant until some later wake). Submitted after, the preserved
   * steer wakes a follow-up turn that consumes the correction as its next
   * turn input.
   */
  async steer(sessionId: string, text: string): Promise<void> {
    const controller = this.controllerOfCowork(sessionId)
    const kernel = this.kernelForDsh(controller?.dshSessionId)
    if (!controller || !kernel) throw new Error('DshTurnHub: no active turn for steer')
    // Arm the boundary latch only when the cancel actually interrupted a
    // running activity. A no-op cancel against an idle agent (steer racing
    // turn start, or a second steer after a first abort already converged)
    // never emits the steer-abort boundary — arming there would swallow the
    // turn's natural end instead. Older runtime builds always report
    // cancelled:true, so only an explicit false skips the latch.
    let interrupted = true
    // A thrown cancel means no interrupt happened: plain step-boundary
    // steering, nothing armed. Let it propagate.
    const cancelResult = await kernel.cancel(controller.dshSessionId, 'steer', { keepInbox: true })
    interrupted = cancelResult.cancelled !== false
    if (interrupted) controller.expectSteerFollowUp()
    try {
      await kernel.steer(controller.dshSessionId, text)
    } catch (error) {
      // Interrupt landed but the steer never queued: disarm so the aborted
      // turn's boundary settles normally; the steer itself is lost (the
      // caller's delivery promise settles empty at turn end).
      controller.clearSteerFollowUp()
      throw error
    }
    controller.notifySteerDelivered(text)
  }

  /**
   * Watchdog escape hatch: settle the active turn controller directly when
   * the runtime cannot — a cancel against an idle agent (no active activity)
   * is a documented no-op that never emits turnEnd, so a controller whose
   * boundary was swallowed (steer follow-up that never woke) would otherwise
   * await forever. Same no-op safety as a normal double settle.
   */
  forceSettle(sessionId: string, reason: string): void {
    this.controllerOfCowork(sessionId)?.handleTurnEnd({ kind: 'aborted', reason })
  }

  /** Resolves when the steer text was delivered (or the turn ended first). */
  waitForSteerDelivery(sessionId: string): Promise<string> {
    return this.controllerOfCowork(sessionId)?.waitForSteerDelivery() ?? Promise.resolve('')
  }

  async cancel(sessionId: string, cause?: string): Promise<void> {
    const controller = this.controllerOfCowork(sessionId)
    const kernel = this.kernelForDsh(controller?.dshSessionId)
    if (!controller || !kernel) return
    // Arm BEFORE issuing the RPC: the abort's turn-end boundary can arrive
    // ahead of the ack, and a missed boundary would hold the next turn until
    // the backstop.
    this.armAbortConvergence(controller.dshSessionId)
    try {
      await kernel.cancel(controller.dshSessionId, cause)
    } catch (error) {
      // A rejected cancel means no abort is converging (session gone, dead
      // runtime) — disarm so the next turn is not held to the backstop.
      this.pendingAbortByDsh.get(controller.dshSessionId)?.settle()
      throw error
    }
  }

  /**
   * Cancel a turn that has no host controller — kernel-initiated turns
   * (subagent-finished wakes, scheduled nudges) run straight on the runtime,
   * so controllerOfCowork-based cancel() cannot reach them. Used when a human
   * message arrives mid kernel turn: the kernel turn is aborted and the human
   * input then starts as a regular hosted turn. Returns false when nothing
   * was interrupted (no mapping, no runtime, or the turn already ended).
   */
  async cancelKernelTurn(coworkSessionId: string, cause: string): Promise<boolean> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    if (!dshId) return false
    // Cancel on the process that actually reports the session busy — the
    // same scan isKernelSessionBusy uses — so a stale holder map cannot
    // route the cancel to the wrong runtime.
    let kernel: DshKernel | null = null
    for (const slot of this.slots.values()) {
      if (slot.kernel.isSessionBusy(dshId)) {
        kernel = slot.kernel
        break
      }
      const draining = slot.drainingKernels.find((k) => k.isSessionBusy(dshId))
      if (draining) {
        kernel = draining
        break
      }
    }
    kernel ??= this.kernelForDsh(dshId)
    if (!kernel) return false
    // Arm BEFORE issuing the RPC (same pattern as cancel()): the abort's
    // turn-end boundary can arrive ahead of the ack, and the follow-up human
    // turn's runTurn must wait for that boundary or it would catch it as a
    // phantom settle.
    this.armAbortConvergence(dshId)
    try {
      const result = await kernel.cancel(dshId, cause)
      if (result.cancelled === false) {
        // Already idle (the kernel turn ended in the race): no boundary is
        // coming — disarm so the follow-up turn is not held to the backstop.
        this.pendingAbortByDsh.get(dshId)?.settle()
        return false
      }
      return true
    } catch (error) {
      this.pendingAbortByDsh.get(dshId)?.settle()
      throw error
    }
  }

  /** Backstop for the abort-convergence guard: a cancel against an already
   *  idle agent never emits a turn-end boundary, so the wait must be bounded. */
  private static readonly ABORT_CONVERGENCE_BACKSTOP_MS = 2000

  private armAbortConvergence(dshSessionId: string): void {
    if (this.pendingAbortByDsh.has(dshSessionId)) return
    let settle!: () => void
    const promise = new Promise<void>((resolve) => {
      settle = () => {
        const entry = this.pendingAbortByDsh.get(dshSessionId)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pendingAbortByDsh.delete(dshSessionId)
        resolve()
      }
    })
    const timer = setTimeout(() => settle(), DshTurnHub.ABORT_CONVERGENCE_BACKSTOP_MS)
    timer.unref?.()
    this.pendingAbortByDsh.set(dshSessionId, { promise, settle, timer })
  }

  /** Cancel a live DSH agent by its runtime session id (subagent Stop). */
  async cancelAgent(dshSessionId: string, cause?: string): Promise<void> {
    if (!dshSessionId) return
    const kernel = this.kernelForDsh(dshSessionId)
    if (kernel) {
      await kernel.cancel(dshSessionId, cause)
      return
    }
    for (const slot of this.slots.values()) {
      const candidates = [slot.kernel, ...slot.drainingKernels]
      for (const kernel of candidates) {
        if (kernel.running) {
          await kernel.cancel(dshSessionId, cause).catch(() => undefined)
        }
      }
    }
  }

  /** Subagent panel (cowork session id in, DSH routing inside). */
  /**
   * Any running runtime process. The session root is shared across provider
   * slots, so read-only, persistence-backed RPCs (subagent catalog, child
   * transcripts) can be served by whichever runtime is up — the session's own
   * provider process is not required.
   */
  private anyRunningKernel(): DshKernel | null {
    for (const slot of this.slots.values()) {
      if (slot.kernel.running) return slot.kernel
    }
    return null
  }

  async listSubagents(
    coworkSessionId: string,
    opts?: { dshSessionId?: string; provider?: DshTurnProviderRoute },
  ): Promise<Array<{ agentId: string; status: string; startedAt: number; mode?: string; label?: string }>> {
    // Resolution order: live turn mapping → pinned mapping → the host's
    // persisted handle hint (post-restart, every in-memory map is empty).
    const dshId = this.dshByCowork.get(coworkSessionId)
      ?? this.pinnedDshIds.get(coworkSessionId)
      ?? opts?.dshSessionId
    if (!dshId) return []
    let kernel = this.kernelForDsh(dshId) ?? this.anyRunningKernel()
    if (!kernel && opts?.provider) {
      // No runtime at all (app restart / idle reap): boot one so the
      // persistence-backed list can answer. Best-effort — no API config, no read.
      await this.prewarm({ provider: opts.provider }).catch(() => undefined)
      kernel = this.anyRunningKernel()
    }
    if (!kernel) return []
    const result = await kernel.listSubagents(dshId)
    return result.agents ?? []
  }

  async getSubagentMessages(
    coworkSessionId: string,
    agentId: string,
    limit?: number,
    opts?: { dshSessionId?: string; provider?: DshTurnProviderRoute },
  ): Promise<Array<{ id: string; type: string; content: string; timestamp: number }>> {
    const dshId = this.dshByCowork.get(coworkSessionId)
      ?? this.pinnedDshIds.get(coworkSessionId)
      ?? opts?.dshSessionId
    if (!dshId) return []
    let kernel = this.kernelForDsh(dshId) ?? this.anyRunningKernel()
    if (!kernel && opts?.provider) {
      await this.prewarm({ provider: opts.provider }).catch(() => undefined)
      kernel = this.anyRunningKernel()
    }
    if (!kernel) return []
    const result = await kernel.getSubagentMessages(dshId, agentId, limit)
    return result.messages ?? []
  }

  /** Subagent panel stop: kernel 'user'-authority interrupt (DSH sessions). */
  async interruptSubagent(coworkSessionId: string, agentId: string): Promise<{ accepted: boolean; reason?: string }> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    const kernel = this.kernelForDsh(dshId)
    if (!kernel || !dshId) return { accepted: false, reason: 'DSH kernel not running for this session' }
    return kernel.interruptSubagent(dshId, agentId)
  }

  /**
   * Official token-meter projections for the usage panel (cowork session id
   * in, DSH routing inside; post-turn safe via the pinned-id fallback).
   * Null when the runtime is down or the cowork session never ran on DSH.
   */
  async usageProjection(coworkSessionId: string): Promise<DshUsageProjectionResult | null> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    const kernel = this.kernelForDsh(dshId)
    if (!kernel || !dshId) return null
    return kernel.usageProjection(dshId)
  }

  /**
   * Read-only plan-mode view backing the sidebar chip's initial state.
   * Served by the idbots/usage wire view, which needs a live agent — null
   * when the session's runtime is down (the chip then keeps its inactive
   * default and resyncs from the next toggle response).
   */
  async planModeGet(
    coworkSessionId: string,
    opts?: { dshSessionId?: string },
  ): Promise<{ active: boolean; pending?: boolean } | null> {
    const dshId = this.dshByCowork.get(coworkSessionId)
      ?? this.pinnedDshIds.get(coworkSessionId)
      ?? opts?.dshSessionId
    if (!dshId) return null
    const kernel = this.kernelForDsh(dshId)
    if (!kernel) return null
    const projection = await kernel.usageProjection(dshId).catch(() => null)
    return projection?.plan ?? null
  }

  /**
   * Plan-mode switch for a cowork session. Unlike the read-only
   * persistence-backed RPCs this must reach the kernel that owns the live
   * agent (ctx.planMode.set mutates session state), so there is no
   * anyRunningKernel fallback and no prewarm — a session whose runtime was
   * reaped has no live mode to switch.
   */
  async planModeSet(
    coworkSessionId: string,
    active: boolean,
    opts?: { dshSessionId?: string },
  ): Promise<{ ok: boolean; result?: string; plan?: { active: boolean; pending?: boolean }; reason?: string }> {
    const dshId = this.dshByCowork.get(coworkSessionId)
      ?? this.pinnedDshIds.get(coworkSessionId)
      ?? opts?.dshSessionId
    const kernel = this.kernelForDsh(dshId)
    if (!kernel || !dshId) return { ok: false, reason: 'DSH kernel not running for this session' }
    return kernel.planModeSet(dshId, active)
  }

  async respondApproval(id: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const kernel = this.askKernelById.get(id) ?? this.firstRunningKernel()
    if (!kernel) throw new Error('DshTurnHub: runtime not started')
    await kernel.respondApproval(id, outcome)
  }

  /** Answer a pending ask_user_question for the owning session. */
  async respondAsk(id: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): Promise<void> {
    const kernel = this.askKernelById.get(id) ?? this.firstRunningKernel()
    if (!kernel) throw new Error('DshTurnHub: runtime not started')
    await kernel.respondAsk(id, answers)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.reapTimer) {
      clearTimeout(this.reapTimer)
      this.reapTimer = null
    }
    // Release turns parked on the abort-convergence guard; they fail soft on
    // the closed check right after.
    for (const entry of [...this.pendingAbortByDsh.values()]) entry.settle()
    const kernels: Promise<void>[] = []
    for (const slot of this.slots.values()) {
      kernels.push(slot.kernel.close())
      for (const kernel of slot.drainingKernels) kernels.push(kernel.close())
    }
    await Promise.all(kernels)
    this.slots.clear()
    this.controllersByDsh.clear()
    this.dshByCowork.clear()
    this.coworkByDsh.clear()
    this.subagentParentByChild.clear()
    this.runtimeKeyByDsh.clear()
    this.kernelByDsh.clear()
    this.askKernelById.clear()
  }

  private kernelForDsh(dshId: string | undefined): DshKernel | null {
    if (!dshId) return null
    // Holder first: while a drained kernel and its successor coexist, the
    // agent (and any in-flight turn) lives on the exact process recorded here.
    const holder = this.kernelByDsh.get(dshId)
    if (holder?.running) return holder
    const key = this.runtimeKeyByDsh.get(dshId)
    if (key) {
      const slot = this.slots.get(key)
      if (slot?.kernel.running) return slot.kernel
    }
    return null
  }

  private firstRunningKernel(): DshKernel | null {
    for (const slot of this.slots.values()) {
      if (slot.kernel.running) return slot.kernel
      for (const kernel of slot.drainingKernels) {
        if (kernel.running) return kernel
      }
    }
    return null
  }

  private inFlightOnSlot(key: string): number {
    let count = 0
    for (const dshId of this.controllersByDsh.keys()) {
      if (this.runtimeKeyByDsh.get(dshId) === key) count += 1
    }
    return count
  }

  private async disposeSessionOnSlot(runtimeKey: string, dshSessionId: string): Promise<void> {
    // The agent may live on a drained kernel of this slot rather than on the
    // current one — dispose where it actually is (no-op elsewhere).
    const kernel = this.kernelForDsh(dshSessionId)
    if (!kernel) return
    this.opts.log?.('info', 'dshTurnHub.disposeSession', {
      dshSessionId,
      runtime: runtimeKey,
    })
    try {
      await kernel.disposeSession(dshSessionId)
    } catch (error) {
      this.opts.log?.('warn', 'dshTurnHub.disposeSession failed', {
        dshSessionId,
        runtime: runtimeKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private get kernelActivityGraceMs(): number {
    return this.opts.kernelActivityGraceMs ?? DSH_KERNEL_ACTIVITY_GRACE_MS
  }

  private scheduleReap(): void {
    const ttl = this.opts.runtimeIdleTtlMs ?? 30 * 60 * 1000
    if (ttl <= 0 || this.reapTimer) return
    const delay = Math.max(50, Math.min(ttl, 60_000))
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null
      void this.reapIdleSlots()
    }, delay)
    this.reapTimer.unref?.()
  }

  private async reapIdleSlots(): Promise<void> {
    const ttl = this.opts.runtimeIdleTtlMs ?? 30 * 60 * 1000
    if (ttl <= 0) return
    const now = Date.now()
    for (const [key, slot] of [...this.slots]) {
      // Retire drained kernels whose turns have all settled, even when the
      // slot itself is too young/fresh to reap.
      this.settleDrains(key)
      if (this.inFlightOnSlot(key) > 0) continue
      // Kernel-side activity (subagent turns with no host controller) keeps
      // the slot's processes alive through the reap the same way.
      if (slot.kernel.hasRecentActivity(this.kernelActivityGraceMs)) continue
      if (now - slot.lastUsedAt < ttl) continue
      this.opts.log?.('info', 'dshTurnHub.reapIdleRuntime', { runtime: key })
      await slot.kernel.close().catch(() => undefined)
      for (const kernel of slot.drainingKernels) await kernel.close().catch(() => undefined)
      this.slots.delete(key)
      for (const [dshId, mapped] of [...this.runtimeKeyByDsh]) {
        if (mapped === key) this.runtimeKeyByDsh.delete(dshId)
      }
      for (const [dshId, holder] of [...this.kernelByDsh]) {
        if (holder === slot.kernel || slot.drainingKernels.includes(holder)) {
          this.kernelByDsh.delete(dshId)
        }
      }
    }
    if (this.slots.size > 0) this.scheduleReap()
  }

  private getOrCreateSlot(key: string): DshRuntimeSlot {
    const existing = this.slots.get(key)
    if (existing) {
      existing.lastUsedAt = Date.now()
      return existing
    }
    const slot: DshRuntimeSlot = {
      key,
      kernel: null as unknown as DshKernel,
      drainingKernels: [],
      kernelEnsureChain: Promise.resolve(),
      lastConfigJson: undefined,
      workspaceSeen: undefined,
      providersSeen: new Map(),
      routeApiKeys: new Map(),
      mcpServersSeen: new Map(),
      browserUseSeen: undefined,
      computerUseSeen: false,
      lastUsedAt: Date.now(),
    }
    this.attachKernel(slot)
    this.slots.set(key, slot)
    return slot
  }

  /** Create the slot's CURRENT kernel. Handlers bind to this exact instance —
   *  a slot can briefly host a drained kernel alongside its successor, and
   *  approvals/tool responses must reach the process that raised them. The
   *  lazy resolver dodges the constructor/assignment cycle. */
  private attachKernel(slot: DshRuntimeSlot): DshKernel {
    const kernel = new DshKernel({
      runtimeDir: this.opts.runtimeDir,
      handlers: this.hubHandlers(slot, () => kernel),
      log: this.opts.log,
    })
    slot.kernel = kernel
    return kernel
  }

  /** Swap in a successor kernel and mark the current one draining. Idle
   *  agents on the old process are released right away; in-flight turns keep
   *  it alive until they settle (their runTurn finally releases the agent and
   *  calls settleDrains). */
  private supersedeKernel(slot: DshRuntimeSlot): DshKernel {
    const old = slot.kernel
    for (const [dshId, holder] of this.kernelByDsh) {
      if (holder !== old || this.controllersByDsh.has(dshId)) continue
      void old.disposeSession(dshId).then(
        () => this.settleDrains(slot.key),
        () => undefined,
      )
    }
    slot.drainingKernels.push(old)
    return this.attachKernel(slot)
  }

  /** Close drained kernels: a superseded runtime retires once no turn is left
   *  running on it. Never force-closes — a turn that legitimately outlasts the
   *  handover keeps its process for exactly as long as it runs. */
  private settleDrains(key: string): void {
    const slot = this.slots.get(key)
    if (!slot) return
    slot.drainingKernels = slot.drainingKernels.filter((kernel) => {
      if (kernel.running && this.inFlightOnKernel(kernel) > 0) return true
      // Kernel-side activity extends the drain too: continuable-subagent
      // turns run with no host controller, so controller-only accounting
      // alone retired kernels under live work (2026-09-28 incident cluster).
      if (kernel.running && kernel.hasRecentActivity(this.kernelActivityGraceMs)) {
        this.opts.log?.('info', 'dshTurnHub.drainRetireDeferredByActivity', {
          runtime: key,
          idleForMs: Date.now() - kernel.lastNotificationAt,
        })
        return true
      }
      void kernel.close().then(() => undefined, () => undefined)
      for (const [dshId, holder] of this.kernelByDsh) {
        if (holder === kernel) this.kernelByDsh.delete(dshId)
      }
      this.opts.log?.('info', 'dshTurnHub.drainedRuntimeClosed', {
        runtime: key,
        inFlightAtClose: this.inFlightOnKernel(kernel),
        idleForMs: kernel.lastNotificationAt > 0 ? Date.now() - kernel.lastNotificationAt : null,
      })
      return false
    })
  }

  /** Turns whose kernel is this exact instance (a slot's in-flight turns may
   *  be split between a drained kernel and its successor). */
  private inFlightOnKernel(kernel: DshKernel): number {
    let count = 0
    for (const [dshId, holder] of this.kernelByDsh) {
      if (holder === kernel && this.controllersByDsh.has(dshId)) count += 1
    }
    return count
  }

  /** Resolve this turn's automation opt-in from the host providers. Warmup's
   *  synthetic session resolves to both-off, so warmup always lands on (and
   *  pre-warms) the clean slot — the automation slots cold-start on the
   *  first real turn that needs them. */
  private automationSlotStateOf(coworkSessionId: string): DshAutomationSlotState {
    return {
      browserUse: this.opts.browserAutomationProvider?.(coworkSessionId) ?? undefined,
      computerUse: this.opts.computerUseProvider?.(coworkSessionId) === true,
    }
  }

  private rememberTurnInputs(slot: DshRuntimeSlot, input: DshTurnInput, options?: DshEnsureKernelOptions, automation?: DshAutomationSlotState): void {
    slot.providersSeen.set(
      input.provider.key,
      mergeProviderRoute(slot.providersSeen.get(input.provider.key), providerRouteOf(input.provider)),
    )
    slot.routeApiKeys.set(input.provider.key, {
      envName: dshProviderApiKeyEnv(input.provider.key),
      apiKey: input.provider.apiKey,
    })
    if (options?.accumulateMcp !== false) {
      for (const server of this.opts.mcpServersProvider?.(input.sessionId) ?? []) {
        const name = String(server?.name ?? '').trim()
        if (name) slot.mcpServersSeen.set(name, server)
      }
    }
    // Browser automation / computer use ride the same accumulateMcp gate:
    // warmup turns must not claim a browser/desktop for a synthetic session.
    // The values come from the turn's pre-resolved automation state — the
    // slot key already encodes this combo, so every real turn landing here
    // writes the same thing (the guards only cover the skipped-warmup case).
    if (options?.accumulateMcp !== false && automation !== undefined) {
      if (slot.browserUseSeen === undefined && automation.browserUse !== undefined) {
        slot.browserUseSeen = automation.browserUse
      }
      if (!slot.computerUseSeen && automation.computerUse) {
        slot.computerUseSeen = true
      }
    }
    if (isOfficialDeepSeekRoute(input.provider) && input.provider.apiKey) {
      this.webSearchSeen = {
        apiKey: input.provider.apiKey,
        baseURL: deepSeekWebSearchBaseURL(input.provider.baseUrl),
      }
    }
    if (options?.pinWorkspace !== false && !slot.workspaceSeen && input.workspace) {
      slot.workspaceSeen = input.workspace
    }
  }

  private buildRuntimeConfig(slot: DshRuntimeSlot, input: DshTurnInput): DshRuntimeConfigInput {
    return {
      sessionRoot: this.opts.sessionRoot,
      runtimeId: slot.key,
      providers: [...slot.providersSeen.values()],
      // sections/hostTools are PER-SESSION and ride session/ensure (agent-
      // scoped registration) — keeping them out of the config is what stops
      // every new session's prompt from restarting this slot's runtime.
      workspace: slot.workspaceSeen ?? input.workspace,
      // Pin the user-global AGENTS.md home to a controlled directory under
      // userData: a global instruction file left over from another harness
      // cannot silently enter every session. Since 0.1.7 the same directory
      // is the runtime's real DSH_HOME (see buildDshChildEnv) — kernel home
      // state like the Files-API image cache lands there too, which is fine:
      // it stays app-managed either way.
      ...(slot.workspaceSeen ?? input.workspace) ? {
        workspaceInstructions: { dshHome: join(app.getPath('userData'), 'dsh-home') },
      } : {},
      mcpServers: [...slot.mcpServersSeen.values()],
      ...(slot.browserUseSeen !== undefined ? { browserUse: slot.browserUseSeen } : {}),
      ...(slot.computerUseSeen ? { computerUse: true } : {}),
      ...(this.webSearchSeen ? {
        webSearch: {
          apiKeyEnv: DSH_WEBSEARCH_API_KEY_ENV,
          baseURL: this.webSearchSeen.baseURL,
          model: DSH_WEBSEARCH_MODEL,
        },
      } : {}),
      // 0.1.7 clock context: the model gets a durable reading (ISO time +
      // zone + elapsed) at most every 10 minutes, in the user's own zone —
      // bots stop guessing dates for on-chain timestamps, schedules and
      // memory work. Omitted when the host has no canonical zone.
      ...(currentClientTimeZone() === undefined ? {} : { timeContext: { timeZone: currentClientTimeZone() } }),
      extraEntries: [...(this.opts.extraEntries ?? []), ...(this.opts.extraEntriesProvider?.() ?? [])],
      env: buildDshChildEnv({
        routeApiKeys: slot.routeApiKeys.values(),
        webSearchApiKey: this.webSearchSeen?.apiKey,
        rpcToken: getMetaidRpcToken(),
        rpcAuthFile: getMetaidRpcTokenFilePath(app.getPath('userData')),
        skillHostEnv: this.opts.skillHostEnvProvider?.(),
        dshHome: join(app.getPath('userData'), 'dsh-home'),
      }),
    }
  }

  private async ensureKernel(input: DshTurnInput, options?: DshEnsureKernelOptions): Promise<DshKernel> {
    if (this.closed) throw new DshShutdownError()
    // Apply this slot's route/MCP/workspace immediately so a racing first
    // turn can steer a still-booting warmup spawn (config is snapshotted
    // only after the per-slot serialize lock is acquired).
    const automation = options?.automation ?? this.automationSlotStateOf(input.sessionId)
    const slot = this.getOrCreateSlot(dshRuntimeKeyOf(input.provider, automationSlotFlagsOf(automation)))
    this.rememberTurnInputs(slot, input, options, automation)
    const run = slot.kernelEnsureChain.then(() => this.spawnOrReuseFromSeenState(slot, input))
    slot.kernelEnsureChain = run.then(() => undefined, () => undefined)
    return run
  }

  private async spawnOrReuseFromSeenState(slot: DshRuntimeSlot, input: DshTurnInput): Promise<DshKernel> {
    const config = this.buildRuntimeConfig(slot, input)
    // A config change restarts THIS slot's runtime only. Other providers
    // keep their processes. GT#26 follow-up still applies inside a slot:
    // MCP/env flaps on the same provider must not kill in-flight turns.
    if (slot.kernel.running && slot.lastConfigJson !== undefined) {
      const nextJson = JSON.stringify(config)
      const inFlight = this.inFlightOnSlot(slot.key)
      // "Busy" includes kernel-side activity the controller accounting
      // cannot see: continuable-subagent turns run with no host controller
      // (2026-09-28 incident: the old code counted controllers only, saw 0
      // while subagents worked, and the kernel-level silent restart killed
      // the process under them).
      const kernelSideBusy = slot.kernel.hasRecentActivity(this.kernelActivityGraceMs)
      if (nextJson !== slot.lastConfigJson && (inFlight > 0 || kernelSideBusy)) {
        const changedKeys = dshConfigChangedKeys(slot.lastConfigJson, nextJson)
        const callerRouteJson = JSON.stringify(providerRouteOf(input.provider))
        // The route JSON records the credential's env NAME only; the key VALUE
        // rides the child env the running process was spawned with. A rotated
        // API key must count as unserved, or this deferral keeps answering
        // from the old process with the old credential until app restart.
        const servedByRunningRuntime =
          lastProviderRouteJsonOf(slot.lastConfigJson, input.provider.key) === callerRouteJson
          && runningEnvApiKeyOf(slot.lastConfigJson, input.provider.key) === input.provider.apiKey
        if (servedByRunningRuntime) {
          this.opts.log?.('warn',
            'config changed but the running runtime serves this turn; restart deferred until quiescence',
            { runtime: slot.key, changed: changedKeys, inFlight, kernelSideBusy })
          return slot.kernel
        }
        // The caller needs a config the running process cannot serve (e.g.
        // the first v4-pro turn on a flash-only slot). Waiting a bounded 90s
        // and restarting anyway killed turns that legitimately ran longer
        // (incident: "DSH runtime stream closed", exit 0, exactly 90s after
        // the config diff). Instead boot a successor process immediately and
        // let the old one drain its in-flight turns.
        this.opts.log?.('warn',
          'config change with live activity; booting a successor runtime and draining the old one',
          { runtime: slot.key, changed: changedKeys, inFlight, kernelSideBusy })
        const successor = this.supersedeKernel(slot)
        await successor.ensureRuntime(config)
        slot.lastConfigJson = nextJson
        return successor
      }
      if (nextJson !== slot.lastConfigJson) {
        // Truly idle (no host controllers AND no kernel-side activity for a
        // full grace window): safe to restart in place. This is the ONLY
        // place a live runtime may be restarted for a config change —
        // explicit and logged, replacing the kernel-level silent restart
        // that killed in-flight work with no trail.
        const changedKeys = dshConfigChangedKeys(slot.lastConfigJson, nextJson)
        this.opts.log?.('info', 'dshTurnHub.inPlaceRuntimeRestart', {
          runtime: slot.key,
          changed: changedKeys,
          idleForMs: Date.now() - (slot.kernel.lastNotificationAt || Date.now()),
        })
        await slot.kernel.restart(config)
        slot.lastConfigJson = nextJson
        return slot.kernel
      }
      // Config unchanged: plain reuse (ensureRuntime boots only when the
      // process is not running; it never restarts on its own).
      await slot.kernel.ensureRuntime(config)
      return slot.kernel
    }
    await slot.kernel.ensureRuntime(config)
    slot.lastConfigJson = JSON.stringify(config)
    return slot.kernel
  }

  private hubHandlers(slot: DshRuntimeSlot, kernelOf: () => DshKernel): DshKernelOptions['handlers'] {
    // Kernel event callbacks carry the DSH session id.
    const controllerOf = (dshSessionId: string) => this.controllersByDsh.get(dshSessionId)
    // Bound to THIS kernel instance: while a drained kernel coexists with its
    // successor, responses (approvals/tools/policy) must reach the process
    // that raised the request.
    return {
      onMessage: (sessionId, message, streamSlot) => {
        const controller = controllerOf(sessionId)
        if (controller) return controller.cb.onMessage(message, streamSlot)
        // Transcript-affecting: strictly-owned resolution only. A continuable
        // child's raw messages stay out of the parent chat (they report via
        // send_message + the subagent panel).
        const coworkId = this.ownedCoworkOfDsh(sessionId)
        if (coworkId && this.opts.onIdleSessionMessage) {
          return this.opts.onIdleSessionMessage(coworkId, message)
        }
        return `dsh-orphan-${sessionId}`
      },
      onMessageUpdate: (sessionId, messageId, content) => {
        const controller = controllerOf(sessionId)
        if (controller) {
          controller.cb.onMessageUpdate(messageId, content)
          return
        }
        // Kernel-initiated turns (subagent-finished wakes, scheduled nudges)
        // have no controller; their placeholders were created through the
        // onIdleSessionMessage fallback above, so their deltas must fall back
        // too (throttled renderer updates only — persistence stays
        // finalize-only, same contract as host turns).
        const coworkId = this.ownedCoworkOfDsh(sessionId)
        if (coworkId) this.opts.onIdleSessionMessageUpdate?.(coworkId, messageId, content)
      },
      onMessageFinalize: (sessionId, messageId, content, metadata) => {
        const controller = controllerOf(sessionId)
        if (controller) {
          controller.cb.onMessageFinalize(messageId, content, metadata)
          return
        }
        // Same idle fallback: dropping a controller-less turn's finalize left
        // its placeholder rows stuck at isStreaming:true with empty content —
        // the transcript then showed the "turn was interrupted when the app
        // quit" diagnostic for a turn that actually finished (2026-10-09
        // session 85e6885a: three subagent-finished wakes, six orphan rows).
        const coworkId = this.ownedCoworkOfDsh(sessionId)
        if (coworkId) this.opts.onIdleSessionMessageFinalize?.(coworkId, messageId, content, metadata)
      },
      onUsage: (sessionId, usage) => {
        controllerOf(sessionId)?.cb.onUsage(usage)
      },
      onTurnEnd: (sessionId, reason, emptyTerminal) => {
        // A turn boundary marks the session's pending abort as converged —
        // release a queued next turn waiting on it before dispatching.
        this.pendingAbortByDsh.get(sessionId)?.settle()
        controllerOf(sessionId)?.handleTurnEnd(reason, emptyTerminal)
      },
      onStatus: (sessionId, status) => {
        // Strictly-owned like onMessage's idle path: a continuable child's
        // lifecycle must not mark its parent's cowork session busy/idle.
        const coworkId = this.ownedCoworkOfDsh(sessionId)
        if (coworkId) this.opts.onSessionStatusChange?.(coworkId, status)
      },
      onApprovalRequest: (sessionId, ask) => {
        this.askKernelById.set(ask.id, kernelOf())
        const controller = controllerOf(sessionId)
        if (!controller) {
          // Settle-don't-strand, the same contract onAskRequest enforces: an
          // approval raised by a kernel-initiated turn (subagent-finished
          // wake, no host turn controller) must never be dropped silently —
          // the runtime's approval promise would strand and the turn would
          // wedge with no stall watchdog armed. Auto-reject THIS call; the
          // model sees the denial and adapts.
          this.opts.log?.('warn', 'dshTurnHub.onApprovalRequest', {
            message: 'approval request has no live turn controller for its DSH session; auto-rejecting',
            askId: ask.id,
            toolName: ask.toolName,
            dshSessionId: sessionId,
            runtime: slot.key,
          })
          void kernelOf().respondApproval(ask.id, 'rejected').catch(() => undefined)
          return
        }
        controller.cb.onApprovalRequest(ask)
      },
      onApprovalCancelled: (askId) => {
        for (const controller of this.controllersByDsh.values()) controller.cb.onApprovalCancelled(askId)
      },
      onAskRequest: (ask) => {
        this.askKernelById.set(ask.id, kernelOf())
        const controller = controllerOf(ask.sessionId)
        const onAskRequest = controller?.cb.onAskRequest
        if (!controller || !onAskRequest) {
          // A silent drop here strands the runtime-side bridge promise
          // forever (the tool contract requires settling). Decline explicitly
          // so the asking turn unwinds instead of hanging. A controller can
          // still exist during a handoff/drain while its callback is absent;
          // that case must settle the same way as a missing controller.
          this.opts.log?.('warn', 'dshTurnHub.onAskRequest', {
            message: !controller
              ? 'ask_user_question has no live turn controller for its DSH session; auto-declining'
              : 'ask_user_question has no host callback for its DSH session; auto-declining',
            askId: ask.id,
            dshSessionId: ask.sessionId,
            runtime: slot.key,
          })
          void kernelOf().respondAsk(
            ask.id,
            (ask.questions ?? []).map((q) => ({
              id: q.id,
              selected: [],
              custom: 'The user could not be reached for this question.',
            })),
          ).catch(() => undefined)
          return
        }
        onAskRequest(ask)
      },
      onAskCancelled: (askId) => {
        for (const controller of this.controllersByDsh.values()) controller.cb.onAskCancelled?.(askId)
      },
      onSubagentEvent: (event) => {
        // Lineage first — it must register even with no live parent
        // controller (a continuable child re-materializes and runs turns
        // long after the parent's host turn settled). started carries the
        // PARENT dsh session id and the child's id as agentId.
        const childId = typeof event.agentId === 'string' ? event.agentId : ''
        const parentId = typeof event.sessionId === 'string' ? event.sessionId : ''
        if (childId && parentId && parentId !== childId) {
          if (event.kind === 'started') {
            this.subagentParentByChild.set(childId, parentId)
          } else if (event.kind === 'finished') {
            this.subagentParentByChild.delete(childId)
          }
        }
        controllerOf(event.sessionId)?.cb.onSubagentEvent?.(event)
      },
      onSessionTitle: (sessionId, title, kind) => {
        // Title events arrive outside the turn-controller lifecycle (the
        // provider's auxiliary LLM call can settle after turn end), so resolve
        // through the pinned mapping rather than the live controller.
        // Strictly-owned: a continuable child's title must not rename its
        // parent's cowork session.
        const coworkId = this.ownedCoworkOfDsh(sessionId)
        if (coworkId) this.opts.onSessionTitle?.(coworkId, title, kind)
      },
      onError: (error) => {
        this.opts.log?.('error', 'dshTurnHub.pump', { message: error.message, runtime: slot.key })
        // Only settle turns on THIS kernel instance — a drained kernel dying
        // must not fail turns already re-pinned to its successor (and vice
        // versa; the slot key alone cannot tell them apart).
        const kernel = kernelOf()
        for (const [dshId, controller] of this.controllersByDsh) {
          if (this.kernelByDsh.get(dshId) !== kernel) continue
          controller.handleTurnEnd({ kind: 'error', reason: `DSH runtime stream closed: ${error.message}` })
        }
      },
      onPolicyRequest: (request) => {
        // Resolve through the pinned fallback like onToolRequest: kernel-
        // initiated turns (subagent-finished wakes) raise native-tool policy
        // checks with no live mapping, and those turns are exactly as real as
        // host-submitted ones — plan-mode gating, read-image guards, and
        // delete confirmations must not silently lapse on them.
        const coworkId = this.coworkOfDsh(request.sessionId)
        if (!coworkId) {
          if (this.opts.evaluatePolicy) {
            // Fail closed: with a host policy configured, an unresolvable
            // session must not settle to the permissive default — the settle
            // VALUE matters as much as settling at all. Deny so the kernel
            // turn unwinds instead of executing ungated native tools.
            this.opts.log?.('warn', 'dshTurnHub.onPolicyRequest', {
              message: 'policy request has no cowork session mapping; denying',
              toolName: request.name,
              dshSessionId: request.sessionId,
              runtime: slot.key,
            })
            void kernelOf()
              .respondPolicy(request.id, 'deny', 'no cowork session mapping for this runtime session')
              .catch(() => undefined)
            return
          }
          // Ungated deployment (no host policy anywhere): default-allow.
          void kernelOf().respondPolicy(request.id, 'allow').catch(() => undefined)
          return
        }
        if (!this.opts.evaluatePolicy) {
          // No host policy: default-allow so ungated deployments keep working.
          void kernelOf().respondPolicy(request.id, 'allow').catch(() => undefined)
          return
        }
        void this.opts.evaluatePolicy(coworkId, request.name, request.arguments ?? {})
          .then((result) => kernelOf().respondPolicy(request.id, result.decision, result.reason).catch(() => undefined))
          .catch(() => {
            try {
              void kernelOf().respondPolicy(request.id, 'deny', 'policy evaluation failed').catch(() => undefined)
            } catch {
              // Drained kernel already closed — nothing left to answer.
            }
          })
      },
      onToolRequest: (request) => {
        // Map the DSH session id back to the cowork id for the executor.
        // Kernel-initiated turns (subagent-finished wakes, scheduled nudges)
        // run with NO live host turn controller — the live mapping died with
        // the last host turn — so resolve through the pinned fallback exactly
        // like onMessage's idle path does.
        const coworkId = this.coworkOfDsh(request.sessionId)
        if (!coworkId || !this.opts.executeTool) {
          // A silent drop strands the runtime-side bridge promise forever:
          // the kernel keeps awaiting the tool result, the turn wedges, and
          // only the 10-minute stall watchdog unwinds it — re-sent prompts
          // queue behind the wedged turn the whole time (2026-09-25 session
          // 8665a5fd: a subagent-wake turn's longterm_subtask_wait was dropped
          // silently, then "继续" stalled for the full watchdog window before
          // "Error: tool call aborted before dispatch"). Settle the promise
          // with an explicit error instead — the same contract onAskRequest
          // already enforces for its bridge.
          this.opts.log?.('warn', 'dshTurnHub.onToolRequest', {
            message: !coworkId
              ? 'host tool request has no cowork session mapping; rejecting so the turn unwinds'
              : 'host tool request has no host executor; rejecting so the turn unwinds',
            toolName: request.name,
            dshSessionId: request.sessionId,
            runtime: slot.key,
          })
          try {
            void kernelOf().respondTool(request.id, {
              ok: false,
              error: `host tool "${request.name}" was rejected: the host has no session mapping for this runtime session (it may have been closed)`,
            }).catch(() => undefined)
          } catch {
            // Kernel already closed — nothing left to answer.
          }
          return
        }
        void this.opts.executeTool(coworkId, request.name, request.arguments ?? {})
          .then((result) => kernelOf().respondTool(request.id, result))
          .catch((error) => {
            // The kernel may have drained and closed while the host tool ran.
            try {
              kernelOf().respondTool(request.id, { ok: false, error: error instanceof Error ? error.message : String(error) })
            } catch {
              // Process already gone — nothing left to answer.
            }
          })
      },
    }
  }
}

function providerRouteOf(provider: DshTurnProviderRoute): DshProviderRoute {
  // Reasoning declaration rides the MODEL (its family's wire dialect), not the
  // provider: a catalog-unknown gateway serving a reasoning-capable model
  // would otherwise materialize reasoning:false and lose all effort control.
  // The native route is exempt — the first-party adapter owns its own ladder.
  const reasoning = provider.key === 'deepseek-official'
    ? null
    : dshModelReasoningDeclaration(provider.model, provider.apiFormat);
  return {
    key: provider.key,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    // Per-route credential name (see dshProviderApiKeyEnv): the runtime reads
    // process.env under exactly this name, and the child env carries every
    // seen route's key under its own name.
    apiKeyEnv: dshProviderApiKeyEnv(provider.key),
    // 'deepseek-official' is the dsh-llm-deepseek adapter's route key — the
    // generator mounts it on its first-party adapter instead of pi-ai.
    native: provider.key === 'deepseek-official',
    models: [{
      id: provider.model,
      contextWindow: provider.contextWindow ?? 64000,
      ...Number.isFinite(provider.maxOutputTokens) ? { maxOutputTokens: provider.maxOutputTokens } : {},
      ...(Array.isArray(provider.inputModalities) && provider.inputModalities.length > 0
        ? { input: provider.inputModalities }
        : {}),
      ...(reasoning
        ? { reasoningEfforts: reasoning.reasoningEfforts, compat: reasoning.compat }
        : {}),
    }],
  }
}

/**
 * Union models onto an already-seen provider route instead of replacing it.
 * Replacing dropped the original model and forced a runtime restart on every
 * same-provider switch; the live agent then ignored the new ensure() route
 * (effort-only bind) so only the cowork's first model kept working.
 */
export function mergeProviderRoute(
  existing: DshProviderRoute | undefined,
  next: DshProviderRoute,
): DshProviderRoute {
  if (!existing) return next
  const models = [...existing.models]
  for (const model of next.models) {
    const index = models.findIndex((candidate) => candidate.id === model.id)
    if (index >= 0) models[index] = model
    else models.push(model)
  }
  return { ...next, models }
}

/** Top-level config keys whose serialized value differs between two configs
 *  (restarting the shared runtime is destructive — say WHAT changed). */
export function dshConfigChangedKeys(lastJson: string, nextJson: string): string[] {
  try {
    const last = JSON.parse(lastJson) as Record<string, unknown>
    const next = JSON.parse(nextJson) as Record<string, unknown>
    const keys = new Set([...Object.keys(last), ...Object.keys(next)])
    return [...keys].filter((key) => JSON.stringify(last[key]) !== JSON.stringify(next[key]))
  } catch {
    return ['<unparseable>']
  }
}

/** Serialized provider route stored in a config JSON by key, or null when the
 *  key is absent — the runtime can only serve a turn whose route is present
 *  verbatim. */
export function lastProviderRouteJsonOf(configJson: string, providerKey: string): string | null {
  try {
    const parsed = JSON.parse(configJson) as { providers?: Array<{ key: string }> }
    const route = (parsed.providers ?? []).find((candidate) => candidate.key === providerKey)
    return route === undefined ? null : JSON.stringify(route)
  } catch {
    return null
  }
}

/** API key value the running runtime's child env holds for a provider route,
 *  parsed from the config snapshot the process was spawned/restarted with.
 *  Undefined when the snapshot has no credential recorded for the route. */
export function runningEnvApiKeyOf(configJson: string, providerKey: string): string | undefined {
  try {
    const parsed = JSON.parse(configJson) as { env?: Record<string, string | undefined> }
    return parsed.env?.[dshProviderApiKeyEnv(providerKey)]
  } catch {
    return undefined
  }
}

export function dshSessionRootFor(userDataPath: string): string {
  // Versioned directory so a future DSH session-format break (format v0 has no
  // upstream compatibility promise) can never touch older logs.
  return join(userDataPath, 'dsh-sessions', 'v0')
}
