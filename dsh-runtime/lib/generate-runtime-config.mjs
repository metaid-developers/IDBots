// Runtime config generator: turns IDBots' provider table + prompt sections
// into a bootable runtime composition (JSON — the include plugin reads both
// YAML and JSON, and JSON keeps this generator dependency-free).
//
// The Electron main process (M4 adapter) reads its SQLite provider rows,
// normalizes them into the input shape below, writes the JSON next to the
// session root, and spawns `bin.mjs` with it.
//
// Input shape:
// {
//   sessionRoot: string,               // JSONL persistence root (versioned dir under userData)
//   providers: [{
//     key: string,                     // route name + llm_id (IDBots provider key)
//     apiFormat: 'openai' | 'responses' | 'anthropic',
//     baseUrl: string,
//     apiKeyEnv: string,               // env var name the app fills when spawning (never the key)
//                                      // baseUrl on the opencode.ai/zen gateway → the route
//                                      //   profile carries a stable x-opencode-session header
//                                      //   (the gateway 400s header-less requests; see the
//                                      //   isOpenCodeGoBaseUrl helper below)
//     native?: true,                   // official DeepSeek: rides the first-party
//                                      // dsh-llm-deepseek adapter (chat-completions wire,
//                                      // native off/low/high/max effort ladder) instead
//                                      // of pi-ai; baseUrl is normalized to the bare origin
//     models: [{ id, contextWindow, maxOutputTokens? }],
//   }],
//   sections: [{ name, order, text }], // stable prompt layers (promptComposer)
//   shaping?: { maxChars?, tailChars? },
//   hostTools?: [{ name, description, parameters }], // proxies bridged to the host
//   mcpServers?: [{ name, transportType: 'stdio'|'sse'|'http', command?, args?, env?, url?, headers? }],
//                                        // user MCP servers → dsh-mcp-client entries
//   webSearch?: {                        // DeepSeek web search + fetch. 0.2.1: the direct
//     apiKeyEnv: string,                 //   Search/Fetch APIs (dsh-web-deepseek-api) are
//     baseURL: string,                   //   the selected providers; baseURL stays the
//     model: string,                     //   Anthropic root incl. /v1, the tools base is
//   },                                   //   derived from it. model serves the legacy
//                                        //   Messages-turn provider, kept mounted as the
//                                        //   rollback path. Mounted once the host has
//                                        //   seen an official DeepSeek provider
//   workspace?: { cwd: string },       // mounts DSH-native bash/fs tools at cwd
//   spill?: { maxInlineTokens?: number }, // 0.1.7 spill-policy cap in estimated tokens (default 2048;
//                                        // workspace compositions only)
//   subagentModelSelection?: {          // child-delegation model choice (0.1.2):
//     enabled?: boolean,                //   default true; allowlist = every configured
//   },                                  //   provider/model route (the provider table is
//                                        //   the authorization surface)
//   persistenceCompression?: 'zstd'|'none', // session artifact encoding (default
//                                        //   zstd; the host migrates existing roots first)
//   workspaceInstructions?: {          // AGENTS.md/CLAUDE.md discovery controls
//     maxBytes?: number,               //   rendered baseline byte budget (default 65536)
//   },                                 //   0.2.1: the global-instruction homes resolve from
//                                        //   the DSH_HOME / DSH_AGENTS_HOME child env (the
//                                        //   dshHome config key was removed upstream)
//   browserUse?: {                     // 0.1.7 experimental browser automation
//     mode: 'launch'|'attach',         //   (dsh-browser-use + Playwright MCP provider):
//     headless?: boolean,              //   launch starts one headless Chromium per
//     executablePath?: string,         //   session; attach claims an existing browser's
//     endpoint?: string,               //   debugging endpoint (tabs + login state ride
//   },                                 //   along). Tools surface as mcp__playwright-mcp__*.
//   computerUse?: boolean,             // 0.1.7 experimental desktop control (cua-driver
//                                      //   native provider): OS desktop permissions must
//                                      //   be granted to the host app; off by default.
//   timeContext?: {                    // 0.1.7 clock context (dsh-time-context): appends a
//     timeZone?: string,               //   durable reading (ISO time + zone + elapsed) each
//     refreshIntervalMs?: number,      //   eligible step, at most once per interval
//   },                                 //   (default 10 min). The host passes the user's zone.
//   extraEntries?: [...],              // dev/test fixtures appended verbatim
// }
//
// Model entries accept an optional `input` modality array (['text','image']):
// pi-ai refuses to convert images for a route whose model does not declare
// image input, and read_image/host-bridged image results gate on it — a tool
// result is durable history, so an undeclared route degrades to text instead.
//
// Providers ride one dsh-llm-pi-ai entry: pi-ai covers all three IDBots
// apiFormats (openai-completions / openai-responses / anthropic-messages),
// which also resolves the Phase 0 open question about the Responses API.
// The official DeepSeek route is the exception: it rides its first-party
// dsh-llm-deepseek adapter (Messages API since 0.1.7 — the chat-completions
// wire and the `protocol` option were removed) via `native: true` on the
// route.

const API_FORMAT_TO_PROTOCOL = {
  openai: 'openai-completions',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
}

const sanitizeRouteKey = (key) => String(key).replace(/[^a-zA-Z0-9_-]/g, '-')

// pi-ai catalog vendors that a user provider key can collide with on the
// anthropic-messages protocol, mapped to the vendor's OFFICIAL API host.
// A vendor-named route whose models match the catalog by id inherits the
// catalog compat — including `supportsMidConvoToolChanges`, which makes the
// route serialize mid-conversation tool changes as `tool_addition` /
// `tool_removal` blocks. Real Anthropic implements those; third-party
// Anthropic-format gateways frequently do not, and one rejection poisons the
// whole session: the tool-change developer events are durable history, so
// every later turn replays them and dies with
// "unknown variant `tool removal`" (the v1.0.2 user report — a wedged
// conversation that no key/model switch could revive). The flag is "withhold"
// in pi-ai's compat gates, so config cannot turn it off; the only lever is
// not naming the route after the vendor. Official endpoints keep the bare
// vendor key (catalog inheritance there is correct and valuable); anything
// else gets a deterministic "-gw" suffix. The host mirrors this exact rule
// in claudeSettings.ts (dshPiAiRouteKey) because every turn passes the route
// key from the host — the two implementations must stay in sync
// (tests/coworkDshRouteKeySync.test.mjs pins the agreement).
export const PI_AI_VENDOR_OFFICIAL_HOSTS = Object.freeze({ anthropic: 'api.anthropic.com' })

const hostOf = (baseUrl) => {
  try { return new URL(String(baseUrl)).hostname.toLowerCase() } catch { return '' }
}

/** DSH pi-ai route key for one user provider: vendor-named anthropic-format
 *  gateways are suffixed so they cannot inherit the catalog vendor's wire
 *  behavior (mid-convo tool-change blocks above all). */
export const dshPiAiRouteKey = (provider) => {
  const key = sanitizeRouteKey(provider.key)
  if (provider.apiFormat !== 'anthropic') return key
  const officialHost = PI_AI_VENDOR_OFFICIAL_HOSTS[String(provider.key).toLowerCase()]
  if (officialHost === undefined || hostOf(provider.baseUrl) === officialHost) return key
  return `${key}-gw`
}

/** DeepSeek official Messages-API wire: thinking disabled (`off`) or
 *  reasoning_effort low/high/max (`output_config.effort`). Kept for the
 *  effort ladder documentation; the native adapter validates it itself.
 *  256K mirrors upstream deepseek-harness (DEFAULT_MAX_TOKENS in
 *  packages/llm/llm-deepseek/src/defaults.ts), whose flash catalog entries
 *  declare no per-model maxTokens so the default applies. Only used when a
 *  provider row carries no explicit maxOutputTokens. */
const NATIVE_DEEPSEEK_DEFAULT_MAX_TOKENS = 256_000

/** Normalize any DeepSeek provider base URL onto the Messages API root the
 *  0.1.7 native adapter expects (it appends `/v1/messages` unless the path
 *  already ends in `/v1`; the official root is `https://api.deepseek.com/
 *  anthropic`). Historical chat-completions-era shapes — bare origin,
 *  `…/v1`, `…/responses`, `…/anthropic`, `…/anthropic/v1`, and a leftover
 *  `…/chat/completions` suffix — all collapse to `<origin>/anthropic`.
 *  The native route only ever targets api.deepseek.com (coworkRunner gates
 *  on the host), so collapsing to the origin is safe; an empty input returns
 *  undefined so the entry omits baseURL and the adapter default applies. */
const deepSeekMessagesBaseURL = (baseUrl) => {
  let base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  base = base.replace(/\/chat\/completions$/i, '')
  base = base.replace(/\/responses$/i, '')
  base = base.replace(/\/anthropic\/v\d+$/i, '')
  base = base.replace(/\/anthropic$/i, '')
  base = base.replace(/\/v\d+$/i, '')
  return base.length > 0 ? `${base}/anthropic` : undefined
}

/** Derive the DeepSeek Search/Fetch API base (`<root>/v1/tools`) from the
 *  Anthropic messages root the host seeds the web-search block with
 *  (`<root>/anthropic/v1`; dsh-web-deepseek-api appends `/search` | `/fetch`).
 *  An empty/unrecognized input omits the key so the package default
 *  (https://api.deepseek.com/v1/tools) applies. */
const deepSeekWebToolsBaseURL = (messagesBaseURL) => {
  const root = String(messagesBaseURL ?? '').trim()
    .replace(/\/+$/, '')
    .replace(/\/anthropic(\/v\d+)?$/i, '')
    .replace(/\/v\d+$/i, '')
  return root.length > 0 ? `${root}/v1/tools` : undefined
}

/** Official adapter request-image budgets. These are IDBots-pinned caps
 *  (carried since 0.1.1), deliberately tighter than the 0.1.7 adapter
 *  defaults (V4.1 token grid ≈1302² / 2 MiB): kept per the 2026-09-24
 *  upgrade review to hold request-image cost stable across the bump. */
const NATIVE_DEEPSEEK_IMAGE_PIXEL_BUDGET = 640_000
const NATIVE_DEEPSEEK_IMAGE_MAX_BYTES = 1_048_576

/** Outage-tuned LLM retry policy shared by every route. The upstream defaults
 *  (5 retries, 500ms→10s backoff ≈ 46s total) and the earlier pi-ai override
 *  (2 retries ≈ 10s) both lose whole turns to ordinary machine-level network
 *  blips — a Wi-Fi roam/DNS flap routinely takes 30–90s to settle, and each
 *  dead fetch costs ~5s of DNS/connect timeout on top. 8 retries with a 1s→30s
 *  ladder stretches the step-level retry window to ~3 minutes, long enough to
 *  ride out a blip without the turn (and the task behind it) dying. */
const TRANSIENT_OUTAGE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 8,
  backoff: Object.freeze({ initialDelayMs: 1_000, maxDelayMs: 30_000 }),
})

/** Per-route compaction policy scaling. compaction-basic's threshold is
 *  `min(thresholdRatio × window, window − reservedOutput − headroomTokens)`
 *  and it silently disables proactive compaction for a route whose pressure
 *  budget (window − reservedOutput − headroom) goes non-positive — the
 *  2026-09-30 space-bunny-free incident: a real-128K model with the flat 64K
 *  headroom and an unclamped 128K output ceiling had a zero budget, never
 *  compacted proactively, overflowed at its true window, and the reactive
 *  summarize request overflowed again.
 *
 *  The policy is tiered by window size (keep in sync with the output-ceiling
 *  clamp tiers in src/main/libs/coworkModelLimits.ts — clampCoworkMaxOutputTokens):
 *
 *  - Small windows (<256K): thresholdRatio 0.9. A small-window model burns a
 *    noticeable share of its context on the first prompt (~8K against 128K),
 *    so the threshold must sit high to keep usable context. That only works
 *    because the host caps small-window output at 6% of the window (8K
 *    floor) and headroom scales at 4%: out + headroom ≤ 10% of the window,
 *    so the 90% ratio is actually reachable (128K → ~89.6%).
 *  - Large windows (≥256K): thresholdRatio 0.8 (upstream default). The 32%
 *    output reserve matters more than the last percentiles of context for
 *    long-form / thinking workloads (1M/256K DeepSeek → 70.4% effective —
 *    the output reserve makes 80% physically unreachable, by design; 1M/128K
 *    GLM → exactly 80%).
 *
 *  Headroom scales at 4% of the window, clamped to [2K, 64K]: 1M routes keep
 *  40K of summarization slack, while even a 16K window keeps a positive
 *  pressure budget (16384 − 8192 output floor − 2048 headroom = 6144). */
const COMPACTION_SMALL_WINDOW_TOKENS = 262_144
const COMPACTION_THRESHOLD_RATIO_SMALL_WINDOW = 0.9
const COMPACTION_THRESHOLD_RATIO_DEFAULT = 0.8
const COMPACTION_HEADROOM_RATIO = 0.04
const COMPACTION_HEADROOM_MIN_TOKENS = 2_048
const COMPACTION_HEADROOM_MAX_TOKENS = 65_536

/** Command Code gateway (api.commandcode.ai) GLM relay routes refuse to START a
 *  request far below the model's advertised window. 2026-10-27 session
 *  cw-2c70849f on `commandcode/z-ai/glm-5.3-flash` (declared 1,048,576):
 *  cold starts up to 623,755 upstream-counted tokens and a warm continuation
 *  at 716,532 were accepted, ~730K was rejected with `400
 *  context_length_exceeded` ("The prompt exceeds the context window this
 *  endpoint can start from. Compact the conversation and retry."). The tiered
 *  threshold above (0.8 → 838,860) therefore never fired, every turn died with
 *  the request 400 plus an identical compaction 400, and only the DeepSeek
 *  fallback brain could carry the session. The gateway documents no such cap
 *  (its own CLI compacts at 90%), and the same session's Zhipu-direct
 *  `glm-5.3` route accepted 798K — so the policy is scoped to Command Code +
 *  GLM-family ids on large windows, not to GLM everywhere. 0.5 × 1,048,576 =
 *  524,288 sits ~100K under the highest accepted cold start, leaving a whole
 *  tool-heavy step of growth between pre-step checks; the compaction-basic
 *  overflow-shrink kernel patch (scripts/dsh-kernel-patches) is the safety
 *  net if the gateway moves the line again, this policy is what keeps the
 *  route proactive so that net is rarely needed. */
const COMPACTION_THRESHOLD_RATIO_COMMANDCODE_GLM = 0.5
const COMMANDCODE_GATEWAY_HOST = 'commandcode.ai'

const isCommandCodeGatewayRoute = (provider) => {
  if (provider?.key === 'commandcode') return true
  try {
    const host = new URL(String(provider?.baseUrl ?? '')).hostname.toLowerCase()
    return host === COMMANDCODE_GATEWAY_HOST || host.endsWith(`.${COMMANDCODE_GATEWAY_HOST}`)
  } catch {
    return false
  }
}

/** GLM-family model id in any gateway spelling: `glm-5.3-flash`,
 *  `z-ai/glm-5.3-flash`, `zai-org/GLM-5.3`. */
const isGlmFamilyModelId = (modelId) => /(?:^|\/)glm-/i.test(String(modelId ?? ''))

const compactionThresholdRatio = (provider, modelId, window) => {
  if (window < COMPACTION_SMALL_WINDOW_TOKENS) return COMPACTION_THRESHOLD_RATIO_SMALL_WINDOW
  if (isCommandCodeGatewayRoute(provider) && isGlmFamilyModelId(modelId)) return COMPACTION_THRESHOLD_RATIO_COMMANDCODE_GLM
  return COMPACTION_THRESHOLD_RATIO_DEFAULT
}

const compactionHeadroomTokens = (contextWindow) => {
  const window = Number.isFinite(contextWindow) ? Math.floor(contextWindow) : 0
  if (window <= 0) return undefined
  return Math.max(
    COMPACTION_HEADROOM_MIN_TOKENS,
    Math.min(COMPACTION_HEADROOM_MAX_TOKENS, Math.floor(window * COMPACTION_HEADROOM_RATIO)),
  )
}

/** One compaction-basic modelPolicies entry per configured provider/model
 *  route. `provider` must equal the REGISTERED route key (dshPiAiRouteKey for
 *  pi-ai routes, or the native adapter's fixed `deepseek-official`) and `model`
 *  the exact model id — a mismatch silently never applies, and a duplicate
 *  target fails plugin load, so dedupe last-wins per target (mirroring the
 *  routes-dict overwrite semantics for sanitized-key collisions). */
const compactionModelPolicies = (providers) => {
  const byTarget = new Map()
  for (const provider of providers ?? []) {
    const routeKey = provider.native ? 'deepseek-official' : dshPiAiRouteKey(provider)
    for (const model of provider.models ?? []) {
      const headroomTokens = compactionHeadroomTokens(model?.contextWindow)
      if (headroomTokens === undefined || !model?.id) continue
      const window = Math.floor(model.contextWindow)
      byTarget.set(JSON.stringify([routeKey, model.id]), {
        provider: routeKey,
        model: model.id,
        thresholdRatio: compactionThresholdRatio(provider, model.id, window),
        headroomTokens,
      })
    }
  }
  return [...byTarget.values()]
}

const modelDeclaresImageInput = (model) =>
  Array.isArray(model.input) && model.input.includes('image')

/** One native-route → one dsh-llm-deepseek plugin entry. Deployment defaults:
 *  thinking on at `high` when a turn carries no explicit effort (per-turn
 *  effort rides session/ensure; the off/low/high/max ladder is adapter-owned). */
const nativeDeepSeekEntry = (provider) => ({
  id: `llm-deepseek-${sanitizeRouteKey(provider.key)}`,
  // 0.1.7-rc.2 split the plugin out of the library package: this entry owns
  // `apiKeyEnv` credential resolution (credentials seam, else the launching
  // environment) and calls registerDeepSeekProvider for `deepseek-official`.
  name: '@deepseek-ai/dsh-llm-deepseek-api-key',
  config: {
    apiKeyEnv: provider.apiKeyEnv,
    // 0.1.7 Messages-API root (`<origin>/anthropic`); undefined omits the key
    // so the adapter default (https://api.deepseek.com/anthropic) applies.
    ...(deepSeekMessagesBaseURL(provider.baseUrl) !== undefined
      ? { baseURL: deepSeekMessagesBaseURL(provider.baseUrl) }
      : {}),
    thinking: 'enabled',
    reasoningEffort: 'high',
    // Without this the adapter default (5 retries, 500ms→10s) applies — too
    // thin for machine-level network blips (see TRANSIENT_OUTAGE_RETRY_POLICY).
    retryPolicy: TRANSIENT_OUTAGE_RETRY_POLICY,
    defaultContextWindow: provider.models[0].contextWindow,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.id,
      contextWindow: model.contextWindow,
      maxTokens: Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : NATIVE_DEEPSEEK_DEFAULT_MAX_TOKENS,
      // 0.1.7 Messages mode: read the latest `system` message at any history
      // position as the effective system prompt; changed snapshots append
      // after the cached prefix instead of rewriting the leading system
      // message — keeps our per-turn prompt-sections updates cache-friendly.
      systemPromptUpdate: 'in-history',
      // DeepSeek-V4.1-Flash-1017's Messages endpoint accepts `tool_addition`
      // blocks but REJECTS `tool_removal` (serde "unknown variant" 400) — the
      // 'in-history' mode we used at 0.2.0-rc.2 emitted both and every turn
      // with a tool-set change (plan mode toggles exit_plan_mode per turn)
      // died at the API. 'addition-only' (also upstream's own default for
      // deepseek-flash) keeps additions in history and handles removals by
      // omitting the tool from declarations, which the endpoint accepts.
      toolUpdate: 'addition-only',
      // 0.1.1 rejects image blocks unless the catalog entry lists `image`.
      ...(modelDeclaresImageInput(model) ? {
        inputModalities: model.input,
        imagePixelBudget: NATIVE_DEEPSEEK_IMAGE_PIXEL_BUDGET,
        imageMaxBytes: NATIVE_DEEPSEEK_IMAGE_MAX_BYTES,
      } : {}),
    })),
  },
})

/** One user MCP server → one dsh-mcp-client entry config; undefined skips. */
const mcpEntryConfig = (server) => {
  if (!server || typeof server !== 'object') return undefined
  // serverName namespaces the model-facing tool names (mcp__<name>__<tool>) and
  // must match [A-Za-z0-9_-]{1,32}; sanitizing keeps tool names stable.
  const serverName = sanitizeRouteKey(String(server.name ?? '')).slice(0, 32)
  if (serverName.length === 0) return undefined
  if (server.transportType === 'stdio') {
    const command = String(server.command ?? '').trim()
    if (!command) return undefined
    return {
      transport: 'stdio',
      serverName,
      command,
      ...(Array.isArray(server.args) && server.args.length > 0 ? { args: server.args.map(String) } : {}),
      ...(server.env && typeof server.env === 'object' ? { env: server.env } : {}),
    }
  }
  if (server.transportType === 'sse' || server.transportType === 'http') {
    const url = String(server.url ?? '').trim()
    if (!url) return undefined
    return {
      transport: 'streamable-http',
      serverName,
      url,
      ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}),
    }
  }
  return undefined
}

// Absolute plugin paths so the generated config is location-independent: the
// Electron main process writes it into userData, not next to the runtime dir.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const plugin = (file) => fileURLToPath(new URL(`../plugins/${file}`, import.meta.url))

// OpenCode Go ("Console Go") gateway session headers — mirror of the app-side
// src/main/libs/opencodeGatewayHeaders.ts predicate (this generator is a
// standalone ESM loaded straight from Resources, so it cannot import TS).
// The gateway refuses header-less requests (400 MissingSessionID, see
// https://opencode.ai/docs/go/#where-can-i-use-it), and pi-ai routes only
// send headers configured ON the provider profile — so gateway-bound routes
// carry a `headers` entry with an x-opencode-session id here. The id is a
// deterministic RFC 4122 v5 uuid per route key, NOT a random one: the
// serialized config feeds dshConfigChangedKeys() restart comparisons, and a
// fresh uuid on every generation would flap the shared runtime (the DSH
// CLI's settings-layer fix made the same trade with its fixed uuid).
const OPENCODE_GO_HOST = 'opencode.ai'
// Fixed v5 namespace for IDBots runtime session ids (any 16 bytes work; this
// one is carved in stone so ids stay stable across app updates).
const OPENCODE_SESSION_NAMESPACE = '3d2f6a58-9c41-5b7e-8a26-d4f0c1e95b73'

const isOpenCodeGoBaseUrl = (baseUrl) => {
  if (!baseUrl || typeof baseUrl !== 'string') return false
  const lower = baseUrl.toLowerCase()
  if (!lower.includes(OPENCODE_GO_HOST)) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === OPENCODE_GO_HOST || host.endsWith(`.${OPENCODE_GO_HOST}`)
  } catch {
    return lower.startsWith(`${OPENCODE_GO_HOST}`) || lower.startsWith(`://${OPENCODE_GO_HOST}`)
  }
}

/** RFC 4122 v5 uuid (SHA-1, namespace + name) — deterministic, valid shape. */
const uuidV5 = (name, namespace) => {
  const digest = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name)
    .digest()
  digest[6] = (digest[6] & 0x0f) | 0x50 // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = digest.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const opencodeSessionHeaders = (routeKey) => ({
  'x-opencode-session': uuidV5(`idbots:dsh-runtime:opencode-session:${routeKey}`, OPENCODE_SESSION_NAMESPACE),
})

/** Deduped dsh-mcp-client composition entries for the user's MCP servers. */
const mcpEntries = (servers) => {
  const byName = new Map()
  for (const server of servers ?? []) {
    const config = mcpEntryConfig(server)
    if (config && !byName.has(config.serverName)) byName.set(config.serverName, config)
  }
  return [...byName.values()].map((config) => ({
    id: `mcp-${config.serverName.toLowerCase()}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config,
  }))
}

export function generateRuntimeConfig(input) {
  if (!input?.sessionRoot || typeof input?.sessionRoot !== 'string') {
    throw new Error('generate-runtime-config: sessionRoot is required')
  }

  const providers = input.providers ?? []
  if (providers.length === 0) {
    throw new Error('generate-runtime-config: at least one provider is required')
  }

  const compactionPolicies = compactionModelPolicies(providers)

  const routes = {}
  const nativeDeepSeekRoutes = []
  for (const provider of providers) {
    if (!Array.isArray(provider.models) || provider.models.length === 0) {
      throw new Error(`generate-runtime-config: provider "${provider.key}" has no models`)
    }
    // Official DeepSeek rides its OWN first-party adapter (dsh-llm-deepseek,
    // Messages-API wire since 0.1.7, native off/low/high/max efforts,
    // reasoning in the dedicated reasoning channel) instead of pi-ai — it
    // never enters the llm-pi-ai providers dict.
    if (provider.native) {
      nativeDeepSeekRoutes.push(provider)
      continue
    }
    const protocol = API_FORMAT_TO_PROTOCOL[provider.apiFormat]
    if (protocol === undefined) {
      throw new Error(`generate-runtime-config: provider "${provider.key}" has unsupported apiFormat ${JSON.stringify(provider.apiFormat)}`)
    }
    const routeKey = dshPiAiRouteKey(provider)
    routes[routeKey] = {
      displayName: provider.key,
      apiKeyEnv: provider.apiKeyEnv,
      api: protocol,
      retryPolicy: TRANSIENT_OUTAGE_RETRY_POLICY,
      baseURL: provider.baseUrl,
      // OpenCode Go gateway requires a stable x-opencode-session header on
      // every request (400 MissingSessionID otherwise); pi-ai only sends
      // profile headers, so gateway-bound routes carry one here. Keyed by
      // route (see isOpenCodeGoBaseUrl above) and deterministic per route.
      ...(isOpenCodeGoBaseUrl(provider.baseUrl)
        ? { headers: opencodeSessionHeaders(routeKey) }
        : {}),
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.id,
        contextWindow: model.contextWindow,
        ...Number.isFinite(model.maxOutputTokens) ? { maxTokens: model.maxOutputTokens } : {},
        // Image-input declaration: routes default to text-only; a vision model
        // declares ['text','image'] so image blocks can enter its history.
        ...Array.isArray(model.input) && model.input.length > 0 ? { input: model.input } : {},
        // Reasoning capability declaration (model-family dialect, e.g.
        // deepseek-v4 on a catalog-unknown chat-completions gateway):
        // forwarded verbatim — dsh-llm-pi-ai validates the shape and without
        // it materializes such models as reasoning:false (no effort control).
        ...model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {},
        ...model.compat ? { compat: model.compat } : {},
      })),
    }
  }

  // Subagent model-selection authorization (0.1.2): children may pick any
  // route the app already configured. Route ids must mirror the llm registry
  // exactly — pi-ai keys are sanitized, the native adapter owns the single
  // fixed `deepseek-official` route. Duplicates would trip the settings
  // service's own validation, so dedupe by provider+model.
  const selectionEnabled = input.subagentModelSelection?.enabled !== false
  const allowedModelMap = new Map()
  for (const provider of providers) {
    const routeKey = provider.native ? 'deepseek-official' : dshPiAiRouteKey(provider)
    for (const model of provider.models) {
      allowedModelMap.set(`${routeKey}\0${model.id}`, { provider: routeKey, model: model.id })
    }
  }
  const subagentModelSelection = {
    enabled: selectionEnabled,
    allowedModels: [...allowedModelMap.values()],
  }
  // One knob, two consumers: the spill-policy inline cap AND the shaping
  // plugin's inlineTokenBudget (a shaped copy must price strictly under the
  // policy's early-return, or the policy re-spills the trimmed text as
  // "Full formatted result" — session 540635be's corrupted recovery file).
  const spillMaxInlineTokens = Number.isFinite(input.spill?.maxInlineTokens) && input.spill.maxInlineTokens > 0
    ? input.spill.maxInlineTokens
    : 2048

  return [
    { id: 'sessions', name: '@deepseek-ai/dsh-session' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    {
      id: 'system-prompt',
      name: '@deepseek-ai/dsh-system-prompt',
      // IDBots personas own the identity voice; the harness line would sit
      // above them and leak "DeepSeek" into self-descriptions.
      config: { includeHarnessIdentity: false },
    },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' },
    // Transient provider failures (timeouts, 5xx) retry instead of killing the turn.
    { id: 'llm-retry', name: '@deepseek-ai/dsh-llm-retry' },
    // dsh-authorization (new 0.1.1 package) is intentionally NOT mounted:
    // IDBots owns API keys in settings and injects them via apiKeyEnv.
    // pi-ai registers OAuth flows only when ctx.authorization exists.
    // Official projection registry plugin (0.1.2+: the package ships its own
    // cordis apply; the former idbots-session-projections.mjs shim is retired).
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    // Projection registry: token-meter (next entry) registers its tokenUsage /
    // contextPressure / contextBreakdown units onto it; idbots-sdk-server's
    // idbots/usage RPC reads them for the host's usage panel. agent-loop also
    // hard-requires ctx.sessionProjections (turnBoundary fold) since 0.1.2.
    { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter' },
    // 0.1.5 whole-log projections: conversation totals (turns/steps, llm/tool
    // wall time, ttft/decode) and the per-turn outline (prompt/response
    // previews). Zero-config units on the same registry; they surface through
    // idbots/usage alongside the token-meter values.
    { id: 'session-stats', name: '@deepseek-ai/dsh-session-stats' },
    { id: 'session-turn-outline', name: '@deepseek-ai/dsh-session-turn-outline' },
    // 0.1.5 session titles: the service mounts for its deterministic fallback
    // (lands on the first human message) and its user-rename pinning inside
    // the session log; the host mirrors those events into the sidebar title.
    // The first-prompt LLM provider is deliberately NOT mounted: IDBots'
    // first kernel user/message carries the host-injected context blocks
    // (remote-services catalog, memory, workspace notes — tens of KB), which
    // exceed the provider's maxInputBytes cap, so it would throw before its
    // request is even logged and the truncation fallback would stay forever.
    // Summary refinement is host-owned instead (coworkRunner
    // .scheduleHostSessionTitleRefinement), which titles from the RAW first
    // user message through the system brain.
    {
      id: 'session-title',
      name: '@deepseek-ai/dsh-session-title',
      config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 },
    },
    // 0.1.5 plan mode (stock section text, copied verbatim from the stock
    // cordis.patch.yml mount): a plan:policy prompt section plus a persistent
    // exit_plan_mode tool, a /plan command, and a `plan` wire projection
    // ({active, pending}). Mode flips are host-driven through
    // ctx.planMode.set(...) — the SDK server exposes that as
    // idbots/plan-mode/set. exit_plan_mode review rides the user-questions
    // bridge, with the full plan markdown carried on question.detail.
    {
      id: 'plan-mode',
      name: '@deepseek-ai/dsh-plan-mode',
      config: {
        section: [
          'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user\'s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.',
          '',
          'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
          '',
          'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
          '',
          'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
          '',
          'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
          '',
          'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
        ].join('\n'),
      },
    },
    // 0.1.5 stock guard rails: repeat-tool-reminder appends a model-visible
    // advisory when the agent re-issues the exact same tool call (canonical
    // arguments) at thresholds 3/5/8 — pure prompt hygiene, never blocks.
    // timeout-policy enforces each tool's own declared timeoutMs as a
    // cooperative deadline (mainly the web_search 60s budget we configure).
    {
      id: 'repeat-tool-reminder',
      name: '@deepseek-ai/dsh-repeat-tool-reminder',
      config: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 },
    },
    { id: 'timeout-policy', name: '@deepseek-ai/dsh-tool-call-timeout-policy' },
    {
      id: 'compaction-basic',
      name: '@deepseek-ai/dsh-compaction-basic',
      config: {
        thresholdRatio: 0.8,
        retainRatio: 0.16,
        maxTokens: 8192,
        compactionRetries: 1,
        // Context-overflow recovery rounds per request error (upstream default
        // 1). The overflow-shrink kernel patch summarizes only the older half
        // of the surface when the full summary request itself overflows, so the
        // retried request can still exceed a provider cap that sits far below
        // the declared window; a second round halves what is left before the
        // original 400 is preserved.
        maxOverflowRetries: 2,
        // Per-route tiered threshold + window-scaled headroom (see
        // compactionModelPolicies) — without it the flat 64K default zeroes
        // the pressure budget on small-window routes and proactive
        // compaction silently turns off.
        ...compactionPolicies.length > 0 ? { modelPolicies: compactionPolicies } : {},
      },
    },
    // Image offload (stock sdk-minimal mount, right after compaction-basic):
    // every image in history is re-encoded into every request, so an
    // image-capable route eventually rejects the request with
    // IMAGE_OFFLOAD_REQUIRED (pi-ai's per-route maxRequestImageBytes bound —
    // 20MiB of base64 by default — or the native route's Files-API budget).
    // This executor answers that failure on the agent/request-error
    // waterfall: it records one durable image/offload decision marking the
    // oldest retained occurrences and retries, so later requests send a
    // placeholder for them. Without it the adapter error reaches the user
    // verbatim and every follow-up turn ("continue") fails identically,
    // because nothing ever shrinks the image history — computer-use sessions
    // hit this after a few dozen screenshots (v1.0.2 user report).
    { id: 'image-offload', name: '@deepseek-ai/dsh-compaction-image-offload' },
    // 0.1.5 tool-result pruner: model-free head/middle/tail pruning of
    // tool-result surface nodes during compaction (defaults 8192/4096/1024
    // chars). compaction-basic picks the service up via ctx.get when mounted.
    { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
    {
      id: 'persistence',
      name: '@deepseek-ai/dsh-session-persistence-jsonl',
      // 0.1.2 physical encoding: zstd (Node builtin zlib — no native addon)
      // shrinks session artifacts several-fold. The backend refuses a root
      // that mixes encodings, so dshKernel.ensureRuntime migrates existing
      // plaintext artifacts (lib/migrate-session-root-zstd.mjs) before
      // spawning a zstd composition. Tests that parse the artifact as text
      // opt back in with persistenceCompression: 'none'.
      config: { root: input.sessionRoot, compression: input.persistenceCompression ?? 'zstd' },
    },
    { id: 'checkpoint-policy', name: '@deepseek-ai/dsh-session-checkpoint-policy' },
    // Unified live-preferred session query (ctx.sessionQuery): reads persisted
    // logs through the mounted persistence service, so continuable subagents
    // can cold-resume dematerialized children (dsh-subagent coldResume) and
    // session listings work. Without it every follow-up to a child whose
    // live activation is gone fails with CONTINUATION_UNAVAILABLE
    // ("continuable subagents require session query" — 2026-09-28 session
    // 540635be: the chair could not wake its persisted workers after a
    // runtime handoff). The plain engine is enough (observeSession/
    // listSessions); the SQLite FTS5 search backend stays unmounted.
    { id: 'session-query', name: '@deepseek-ai/dsh-session-query' },
    { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
    // Model-facing ask_user_question: the service seam plus its tool consumer.
    // The provider (UI side) is registered by idbots-sdk-server and bridges
    // each ask to the Electron host's AskUserQuestion permission modal.
    { id: 'user-questions', name: '@deepseek-ai/dsh-user-questions' },
    // Questions wait for a person. timeout -1 blocks until an answer (or a
    // turn cancel). The kernel patch on dsh-tool-ask-user ignores a
    // model-supplied timeout, so the 300s ceiling and any shorter override
    // no longer close the panel. Plan-mode reviews are unaffected:
    // dsh-plan-mode calls ctx.userQuestions.ask() directly with intent
    // 'plan-review', bypassing this tool definition entirely.
    {
      id: 'tool-ask-user',
      name: '@deepseek-ai/dsh-tool-ask-user',
      config: { mode: 'timed', timeout: -1 },
    },
    // Durable image storage: read_image and host-bridged image tool results
    // commit bytes here before any image block enters session history.
    {
      id: 'attachment-store',
      name: plugin('idbots-attachment-store.mjs'),
      config: { root: join(input.sessionRoot, 'attachments') },
    },
    // User-configured MCP servers: one dsh-mcp-client entry each, tools land
    // as mcp__<serverName>__<rawName>. A bad entry (missing command/url,
    // unmatchable name) is skipped, not fatal — failOnStartupError stays off.
    ...mcpEntries(input.mcpServers),
    // DeepSeek web search + fetch (mounted once the host has seen an official
    // DeepSeek provider). 0.2.1: the default providers are the direct
    // Search/Fetch APIs — one plain HTTP call per op, no auxiliary model turn;
    // the legacy Messages-turn provider (web_search_20250305 server tool) stays
    // mounted as the rollback path. Either way search rides the dedicated web
    // seam because pi-ai's Responses converter only emits function tools,
    // never built-in server tools. The API key never enters this file: it
    // rides the child env under apiKeyEnv.
    ...(input.webSearch ? [
      {
        id: 'web',
        name: '@deepseek-ai/dsh-web',
        config: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
      },
      {
        id: 'web-deepseek-api',
        name: '@deepseek-ai/dsh-web-deepseek-api',
        config: {
          apiKeyEnv: input.webSearch.apiKeyEnv,
          ...(deepSeekWebToolsBaseURL(input.webSearch.baseURL) !== undefined
            ? { baseURL: deepSeekWebToolsBaseURL(input.webSearch.baseURL) }
            : {}),
        },
      },
      {
        id: 'web-search-deepseek',
        name: '@deepseek-ai/dsh-web-search-deepseek',
        config: {
          apiKeyEnv: input.webSearch.apiKeyEnv,
          baseURL: input.webSearch.baseURL,
          model: input.webSearch.model,
        },
      },
      // web_fetch is on now that fetch rides DeepSeek's server-side Fetch API —
      // its 403 policy rejects unsafe targets server-side, so the old
      // local-fetch SSRF concern no longer applies. The 60s search timeout
      // stays for the legacy provider's full-model-turn latency.
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    ] : []),
    // Model-facing subagent delegation (in-process spawn provider, foreground).
    { id: 'subagent', name: '@deepseek-ai/dsh-subagent' },
    { id: 'subagent-spawn-in-process', name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    // Host-scope model-selection preference (0.1.2): the allowlist children
    // may pick from when delegating. Authorized routes = every provider/model
    // the app already configured — the provider table IS the authorization
    // surface. The delegation tool itself is mounted per Agent scope by
    // idbots-sdk-server (modelSelectionSettings requires an Agent/preset
    // scope; a top-level mount throws), reading this setting at each fresh
    // root session and recording it into the session for children to inherit.
    ...(subagentModelSelection.enabled && subagentModelSelection.allowedModels.length > 0 ? [{
      id: 'subagent-model-selection-settings',
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
      config: { enabled: true, allowedModels: subagentModelSelection.allowedModels },
    }] : []),
    {
      id: 'idbots-prompt-sections',
      name: plugin('idbots-prompt-sections.mjs'),
      config: { sections: input.sections ?? [] },
    },
    {
      id: 'idbots-tool-result-shaping',
      name: plugin('idbots-tool-result-shaping.mjs'),
      // inlineTokenBudget mirrors the spill cap (see spillMaxInlineTokens);
      // host-provided shaping keys still win over the mirror.
      config: { inlineTokenBudget: spillMaxInlineTokens, ...(input.shaping ?? {}) },
    },
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: routes },
    },
    ...nativeDeepSeekRoutes.map(nativeDeepSeekEntry),
    {
      id: 'idbots-sdk-server',
      name: plugin('idbots-sdk-server.mjs'),
      config: {
        ...(input.hostTools ? { tools: input.hostTools } : {}),
        // Per-agent tool-subagent mounts read this: true only when the
        // settings entry above is mounted (enabled + non-empty allowlist).
        subagentModelSelection: subagentModelSelection.enabled && subagentModelSelection.allowedModels.length > 0,
      },
    },
    // fs service + 0.2.1 working-directory are UNCONDITIONAL: dsh-subagent now
    // hard-requires the workingDirectory service (static inject), which in
    // turn injects fs + sessionProjections + systemPrompt. Without a workspace
    // the jail root falls back to the session root; model-facing fs/bash tools
    // stay workspace-gated below.
    { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local', config: { cwd: input.workspace?.cwd ?? input.sessionRoot } },
    {
      id: 'working-directory',
      name: '@deepseek-ai/dsh-working-directory',
      config: { defaultDirectory: input.workspace?.cwd ?? input.sessionRoot },
    },
    ...(input.workspace ? [
      { id: 'shell-env', name: '@deepseek-ai/dsh-shell-env' },
      { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
      // Spill trio (workspace compositions only — the model reads a
      // spill file back through the fs/bash tools mounted below). 0.1.7:
      // text AND image results share one estimated-token budget —
      // over-cap results land in a session-scoped spill file with a
      // bounded head/tail preview + read-back path in history; the
      // policy's cap sits UNDER idbots-tool-result-shaping's 20K so
      // mid-size results spill recoverably while shaping stays the hard
      // backstop for mixed content and no-spill compositions. Oversized
      // results are shaped AND spill-recoverable: since the 540635be fix
      // the shaping plugin saves the full original through the spill
      // store itself and sizes its inline under this cap, so the policy
      // never spills a trimmed copy behind a "Full formatted result"
      // notice again.
      {
        id: 'spill-local',
        name: '@deepseek-ai/dsh-spill-local',
        config: { root: join(input.sessionRoot, 'spill') },
      },
      {
        id: 'spill-policy',
        name: '@deepseek-ai/dsh-spill-policy',
        // 0.1.7 renamed the cap to estimated TOKENS (text and images now
        // share one budget; omitted content leaves a read-back path). 2048
        // tokens ≈ the old 8192-byte cap for ASCII-heavy tool output.
        config: { maxInlineTokens: spillMaxInlineTokens },
      },
      {
        id: 'bash',
        name: '@deepseek-ai/dsh-bash-local',
        // Composition cwd is the plugin FALLBACK (non-agent calls). Per-session
        // execution cwd is session.header.cwd, set by session/ensure.
        config: { cwd: input.workspace.cwd, timeoutMs: 60000 },
      },
      { id: 'fs-observation-policy', name: '@deepseek-ai/dsh-fs-observation-policy' },
      // Workspace instructions: discovers AGENTS.md/CLAUDE.md from the session
      // cwd (project root markers → root-to-cwd chain) and injects them as a
      // durable user-role baseline before the first model request — the same
      // mechanism the DeepSeek Harness web UI uses. Also reconciles on fs tool
      // touches. Only mounted with the fs provider it reads through; a
      // providerless composition simply never injects.
      {
        id: 'agent-instructions',
        name: '@deepseek-ai/dsh-agent-instructions',
        // 0.2.1 removed the dshHome config key: the user-global instruction
        // homes resolve from the DSH_HOME / DSH_AGENTS_HOME child env, both
        // pinned under userData by the host (see buildDshChildEnv).
        config: {
          maxBytes: Number.isFinite(input.workspaceInstructions?.maxBytes) && input.workspaceInstructions.maxBytes > 0
            ? input.workspaceInstructions.maxBytes
            : 65536,
        },
      },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      // 0.1.5 model-facing glob/grep over the packaged ripgrep binary: no
      // system rg, no shell layer (fixed argv through ctx.subprocess), and
      // formatted-result spill rides the trio mounted above. Stock config —
      // over-cap glob pages take the modification-time head, not sampling.
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    ] : []),
    // 0.1.7 experimental browser automation (off unless the host opts in):
    // the provider connects one Playwright MCP server + browser per session
    // inside the serial agent/created window (before the first model
    // request) and keeps it across turns. Attach mode claims an existing
    // browser's debugging endpoint with its tabs and login state intact.
    ...(input.browserUse ? [
      { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
      {
        id: 'browser-use-playwright',
        name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
        config: {
          mode: input.browserUse.mode === 'attach' ? 'attach' : 'launch',
          headless: input.browserUse.headless !== false,
          ...(typeof input.browserUse.executablePath === 'string' && input.browserUse.executablePath.length > 0
            ? { executablePath: input.browserUse.executablePath }
            : {}),
          ...(typeof input.browserUse.endpoint === 'string' && input.browserUse.endpoint.length > 0
            ? { endpoint: input.browserUse.endpoint }
            : {}),
        },
      },
    ] : []),
    // 0.1.7 clock context: one small durable reading per eligible step so the
    // model interprets dates/times against the user's zone instead of
    // guessing. Mounted whenever the host provides a zone (it always does);
    // omitted entirely otherwise, which is the upstream disabled default.
    ...(input.timeContext ? [
      {
        id: 'time-context',
        name: '@deepseek-ai/dsh-time-context',
        config: {
          ...(typeof input.timeContext.timeZone === 'string' && input.timeContext.timeZone.length > 0
            ? { timeZone: input.timeContext.timeZone }
            : {}),
          refreshIntervalMs: Number.isFinite(input.timeContext.refreshIntervalMs) && input.timeContext.refreshIntervalMs >= 0
            ? input.timeContext.refreshIntervalMs
            : 600000,
        },
      },
    ] : []),
    // 0.1.7 experimental desktop control (cua-driver native, in-process).
    // The host app must hold macOS Accessibility/Screen Recording grants;
    // nothing here requests them. Off unless the host opts in.
    // The route guard rides the same switch: in this in-process topology the
    // cursor-overlay facility is unavailable and the foreground/desktop/
    // modifier/drag routes move the user's PHYSICAL pointer — the guard
    // denies both at tools/pre-execute, before the provider's approval gate.
    ...(input.computerUse === true ? [
      { id: 'computer-use', name: '@deepseek-ai/dsh-computer-use' },
      { id: 'computer-use-cua-native', name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native' },
      { id: 'idbots-cu-route-guard', name: plugin('idbots-cu-route-guard.mjs') },
    ] : []),
    ...(input.extraEntries ?? []),
  ]
}
