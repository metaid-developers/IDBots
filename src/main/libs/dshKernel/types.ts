// DSH kernel types: the kernel-agnostic surface between coworkRunner and the
// DSH runtime subprocess (Phase 1 M4).
//
// The mapper's output contract mirrors what handleClaudeEvent produces for the
// Claude SDK today: CoworkMessage-shaped messages, same-message-id streaming
// updates, and turn/usage facts. CoworkMessage itself stays the single
// currency — the renderer and coworkStore are untouched.

export type CoworkMessageInput = {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system'
  content: string
  metadata?: Record<string, unknown>
}

/** Which streaming slot an action refers to (the store assigns real ids). */
export type DshStreamSlot = 'text' | 'thinking'

/**
 * Finalize-time metadata overrides. Used when assembly reclassifies a message
 * after streaming: DeepSeek Responses commentary-phase text streams as text
 * (the wire marks the phase only in the assembled replay state) and is
 * finalized as thinking so it collapses exactly like Claude-kernel thinking.
 * Official DeepSeek (no phase tags) uses the same finalize metadata when a
 * leaked text placeholder has to be closed; tool-step commentary otherwise
 * stays in the thinking slot without a second message.
 */
export type DshFinalizeMetadata = {
  isThinking?: boolean
  /**
   * Keep the streaming pulse on a finalized message. Normally finalize marks
   * the message settled; a message converted mid-stream into the thinking
   * display (tool-call commentary, effort "off") keeps accumulating content
   * across tool rounds, so it must stay visually streaming until the turn's
   * reply or turn/end settles it. The gate spreads metadata AFTER its own
   * isStreaming:false, so this flag wins.
   */
  isStreaming?: boolean
}

/** Actions the adapter applies to the store + event surface. */
export type DshMapperAction =
  | {
      kind: 'message'
      slot?: DshStreamSlot
      message: CoworkMessageInput
    }
  | { kind: 'messageUpdate'; slot: DshStreamSlot; content: string }
  | {
      kind: 'messageFinalize'
      slot: DshStreamSlot
      content: string
      metadata?: DshFinalizeMetadata
    }
  | {
      kind: 'turnEnd'
      turn: number
      reason: { kind: string; reason?: string }
      /** True when the turn stopped cleanly having produced no text and no tool calls. */
      emptyTerminal?: boolean
      finalizationRequired?: boolean
      fallbackFinalText?: string
    }
  | { kind: 'usage'; usage: DshUsageSnapshot }

export interface DshUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  provider?: string
  model?: string
}

/**
 * Official token-meter session projections, read over the wire via the
 * idbots/usage extension. Mirrors @deepseek-ai/dsh-token-meter's
 * TokenUsageProjection / ContextPressureProjection / ContextBreakdown
 * projection contracts (all four usage buckets are DISJOINT — reasoning is
 * already inside outputTokens, uncached input excludes cache reads/writes).
 */
export interface DshUsageProjectionResult {
  available: boolean
  reason?: string
  asOfSeq?: number
  tokenUsage?: {
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  } | null
  contextPressure?: {
    pressureTokens?: number
    projectedTokens?: number
    contextWindow?: number
  } | null
  contextBreakdown?: {
    systemTokens: number
    toolsTokens: number
    messageTokens: number
  } | null
  /** 0.1.5 plan-mode wire view (dsh-plan-mode); null when not composed. */
  plan?: { active: boolean; pending?: boolean } | null
}

/** Loose envelope of the wire `session.event` notification payload. */
export interface DshSessionEventEnvelope {
  type: string
  seq?: number
  time?: number
  data?: any
}

/** One IDBots provider row, normalized for the runtime config generator. */
export interface DshProviderRoute {
  key: string
  apiFormat: 'openai' | 'responses' | 'anthropic'
  baseUrl: string
  apiKeyEnv: string
  /**
   * Official DeepSeek rides its first-party dsh-llm-deepseek adapter
   * (chat-completions wire, native off/low/high/max efforts, reasoning in the
   * dedicated reasoning_content channel) instead of the pi-ai route; the
   * generator emits a dedicated plugin entry and never adds this provider to
   * llm-pi-ai. apiFormat becomes irrelevant for the wire (the adapter always
   * speaks chat completions; the base URL is normalized onto the host root).
   */
  native?: boolean
  models: Array<{
    id: string
    contextWindow: number
    maxOutputTokens?: number
    /** Input modalities the route declares (['text','image'] for vision models); pi-ai gates image blocks on it. */
    input?: string[]
    /**
     * Reasoning capability declaration (see dshModelReasoningDeclaration):
     * forwarded verbatim to dsh-llm-pi-ai, which otherwise derives the
     * capability from its installed catalog — catalog-unknown models
     * (custom gateways) materialize `reasoning: false` and lose all effort
     * control. Never set for native routes (the first-party adapter owns
     * its own ladder).
     */
    reasoningEfforts?: Record<string, string | null>
    compat?: Record<string, unknown>
  }>
}

/** Stable prompt layer (promptComposer section list). */
export interface DshPromptSectionInput {
  name: string
  order: number
  text: string
  /**
   * Render the text literally instead of interpolating kernel `{{variable}}`
   * references. Required for sections whose text embeds authored or untrusted
   * content — the A2A base prompt carries the peer conversation history, and
   * any literal `{{...}}` inside it (e.g. a quoted {{METABOT_SKILL_PIN}}
   * placeholder in a peer message) otherwise kills the whole turn in
   * dsh-system-prompt's strict interpolator. App-composed sections are
   * finished text, never kernel templates.
   */
  interpolate?: false
}

/**
 * A user-configured MCP server for the runtime composition: one
 * dsh-mcp-client plugin entry per server (`mcp__<name>__<tool>` naming).
 * Structurally compatible with the app's UserConfiguredMcpServerDefinition
 * (transportType stays `string`; the generator validates and skips unknown
 * transports instead of failing the composition).
 */
export interface DshMcpServerDefinition {
  name: string
  transportType: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface DshRuntimeConfigInput {
  sessionRoot: string
  providers: DshProviderRoute[]
  sections?: DshPromptSectionInput[]
  /**
   * Commit-time tool-result shaping. `inlineTokenBudget` defaults to the
   * spill-policy cap (mirrored by generate-runtime-config): a shaped copy
   * must price strictly under that cap so the policy never re-spills the
   * trimmed text as "Full formatted result" (session 540635be).
   */
  shaping?: { maxChars?: number; tailChars?: number; inlineTokenBudget?: number }
  hostTools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  workspace?: { cwd: string }
  /**
   * AGENTS.md/CLAUDE.md discovery controls for the dsh-agent-instructions
   * plugin. 0.2.1 removed the `dshHome` key: the user-global homes now resolve
   * from the child env, where the host pins DSH_HOME and DSH_AGENTS_HOME to a
   * controlled directory under userData (see buildDshChildEnv) so a
   * user-global `~/.dsh/AGENTS.md` (e.g. left over from a DeepSeek Harness
   * install) never silently leaks into IDBots sessions.
   */
  workspaceInstructions?: { maxBytes?: number }
  /** User-configured MCP servers mounted as dsh-mcp-client plugin entries. */
  mcpServers?: DshMcpServerDefinition[]
  /**
   * 0.1.7 experimental browser automation (dsh-browser-use + Playwright MCP
   * provider): one MCP server + Chromium per session, connected inside
   * agent/created before the first model request. `launch` starts a headless
   * browser; `attach` claims an existing browser's debugging endpoint (tabs
   * and login state ride along). Off when absent.
   */
  browserUse?: {
    mode: 'launch' | 'attach'
    headless?: boolean
    executablePath?: string
    endpoint?: string
  }
  /**
   * 0.1.7 experimental desktop control (cua-driver native provider, mounted
   * in-process). The host app must hold the OS desktop permission grants;
   * off when absent/false.
   */
  computerUse?: boolean
  /**
   * 0.1.7 clock context (dsh-time-context): a durable time reading appended
   * at most once per `refreshIntervalMs` (default 10 minutes) so the model
   * interprets dates and times in the user's zone. The host passes its own
   * IANA zone; omitted entirely when the host has none (upstream disabled
   * default).
   */
  timeContext?: { timeZone?: string; refreshIntervalMs?: number }
  /**
   * DeepSeek server-side web search (dsh-web trio): mounts the model-facing
   * `web_search` tool backed by an auxiliary Anthropic-compatible Messages
   * call with the native web_search_20250305 server tool. Present once the
   * host has seen a DeepSeek provider; the API key rides `env` under
   * `apiKeyEnv`, never this config.
   */
  webSearch?: {
    apiKeyEnv: string
    baseURL: string
    model: string
  }
  extraEntries?: Array<Record<string, unknown>>
  /** Extra env for the runtime process (credential vars, never keys in config). */
  env?: Record<string, string>
  /**
   * Child-delegation model choice (DSH 0.1.2): default enabled — the
   * allowlist is derived from `providers` by the generator (the provider
   * table is the authorization surface). Set `enabled: false` to opt out.
   */
  subagentModelSelection?: { enabled?: boolean }
  /**
   * Session artifact physical encoding (DSH 0.1.2). Default `zstd` (Node
   * builtin zlib); `ensureRuntime` migrates existing plaintext artifacts
   * before booting a zstd composition. `'none'` stays plaintext (tests that
   * parse the artifact as text).
   */
  persistenceCompression?: 'zstd' | 'none'
  /** Distinguishes this process's composition file when several kernels share
   *  one sessionRoot (one runtime per provider). Not a composition field. */
  runtimeId?: string
}

export interface DshHostToolImagePayload {
  /** Base64-encoded image bytes. */
  data: string
  /** Declared media type (image/png | image/jpeg | image/webp | image/gif). */
  mediaType: string
  /** Optional display name stripped of path information. */
  name?: string
}

export interface DshHostToolRequest {
  id: string
  sessionId: string
  name: string
  arguments: Record<string, unknown>
}

export interface DshApprovalAsk {
  id: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
}

/** A pending ask_user_question bridged from the runtime's user-questions service. */
export interface DshUserQuestionAsk {
  id: string
  sessionId: string
  questions: Array<{
    id: string
    question: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
    /** 0.1.5 plan review: full plan markdown attached by exit_plan_mode. */
    detail?: string
    /** Wire passthrough (e.g. { kind: 'plan-review' }); not rendered today. */
    intent?: Record<string, unknown>
  }>
}

/** Event callbacks the host (coworkRunner adapter wiring) subscribes to. */
export interface DshKernelHandlers {
  onMessage: (sessionId: string, message: CoworkMessageInput, slot?: DshStreamSlot) => string
  onMessageUpdate: (sessionId: string, messageId: string, content: string) => void
  onMessageFinalize: (sessionId: string, messageId: string, content: string, metadata?: DshFinalizeMetadata) => void
  onTurnEnd: (sessionId: string, reason: { kind: string; reason?: string }, emptyTerminal?: boolean, finalizationRequired?: boolean, fallbackFinalText?: string) => void
  onUsage: (sessionId: string, usage: DshUsageSnapshot) => void
  onApprovalRequest: (sessionId: string, ask: DshApprovalAsk) => void
  onApprovalCancelled: (askId: string) => void
  onAskRequest?: (ask: DshUserQuestionAsk) => void
  onAskCancelled?: (askId: string) => void
  /** Live subagent lifecycle rows (parent DSH session id in the payload). */
  onSubagentEvent?: (event: {
    kind: 'started' | 'progress' | 'finished'
    sessionId: string
    agentId: string
    summary?: string
    status?: string
  }) => void
  onToolRequest: (request: DshHostToolRequest) => void
  onPolicyRequest?: (request: { id: string; sessionId: string; name: string; arguments: Record<string, unknown> }) => void
  /**
   * Log-only `session/title` events from dsh-session-title (0.1.5): the
   * deterministic fallback on the first human message ('user' only if the
   * runtime itself renames — the app never routes renames through the
   * kernel). The LLM summary refinement is host-owned (coworkRunner's
   * scheduleHostSessionTitleRefinement); the kernel first-prompt provider is
   * not mounted because IDBots' context-wrapped first message exceeds its
   * input cap. The mapper ignores these events (not model-facing); the kernel
   * surfaces them raw so the host can mirror the title into the cowork store
   * and the sidebar.
   */
  onSessionTitle?: (sessionId: string, title: string, source: 'fallback' | 'provider' | 'user') => void
  onStatus?: (sessionId: string, status: 'idle' | 'running') => void
  onError?: (error: Error) => void
}
