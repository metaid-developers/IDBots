// Reasoning capability declarations for model families the pi-ai installed
// catalog does not describe.
//
// dsh-llm-pi-ai materializes a route model's reasoning capability from
// (1) an explicit `reasoningEfforts` declaration on the model entry, else
// (2) the installed catalog entry with the same model id, else
// (3) `reasoning: false`.
// Custom providers — any gateway pi-ai has no catalog file for (commandcode,
// private relays, …) — always land in case 3, so a reasoning-capable model
// served behind an arbitrary OpenAI-compatible endpoint gets NO thinking
// control at all: the effort selector's "off" sends nothing and the upstream
// default (thinking on) applies. The declaration must therefore ride the
// MODEL's identity — its family's own wire dialect — not the provider that
// happens to serve it. (One family can still speak two dialects: GLM on the
// OpenCode Go gateway uses reasoning_effort, not the z.ai thinking object —
// see GLM_OPENCODE_GO_CHAT_COMPLETIONS_DECLARATION.)

import { isOpenCodeGoBaseUrl } from './opencodeGatewayHeaders';
import { modelAlwaysThinks } from './modelThinking';
//
// Scope: chat-completions and responses routes. Chat-completions carries the
// family's own wire dialect (deepseek thinking, zai thinking). The Responses
// wire has no "disable" parameter — reasoning is opt-in by design — but for
// GLM that opt-in must be EXPLICIT: an undeclared model sends nothing and the
// gateway's server-side default decides whether the model thinks. z.ai
// flipped that default mid-2026-09-03 with no host change (A2A thread
// 0f81a549: turns ≤111 returned separate reasoning items, turns ≥112 none),
// and with no thinking channel GLM narrated its reply-or-skip deliberation
// into the visible text, which the A2A private-chat path then published
// on-chain verbatim (fix/a2a-private-chat-thinking-leak).
//
// Anthropic-Messages relays speak Claude's adaptive-thinking dialect: enabled
// rungs send `thinking: { type: 'adaptive' }` plus `output_config.effort`, and
// `off` sends the explicit `thinking: { type: 'disabled' }`.

/** Wire declarations dsh-llm-pi-ai accepts on a route model entry. */
export interface DshModelReasoningDeclaration {
  /**
   * UI level → wire value. `null` on `off` keeps `off` absent from the
   * materialized thinkingLevelMap, which pi-ai reads as "supported — send
   * nothing"; the deepseek thinkingFormat branch then emits the explicit
   * `thinking: { type: 'disabled' }`. Undeclared levels (minimal / medium /
   * xhigh) materialize as unsupported, mirroring the official profile.
   */
  reasoningEfforts: Record<string, string | null>;
  compat: Record<string, unknown>;
}

// DeepSeek V4 family, bare ids (deepseek-flash, deepseek-v4-flash) and
// vendor-prefixed ids (deepseek/deepseek-flash) alike. The declaration
// mirrors the official DeepSeek profile shipped in pi-ai's own catalog
// (@earendil-works/pi-ai providers/data/deepseek.json): chat-completions
// `thinking` enable/disable + reasoning_effort low/high/max — the same ladder
// the first-party dsh-llm-deepseek adapter speaks natively. The V4.1 rename
// (`deepseek-v4-flash` → `deepseek-flash`, 2026-09-10) keeps the same wire
// dialect, so both id shapes match.
const DEEPSEEK_V4_PATTERN = /deepseek-(?:v4|flash)(?:[.\-_]|$)/i;

// `deepseek-chat` is the free-quota relay's (metaid-free) legacy wire id for
// deepseek-v4-flash — the app's own legacy-model migration already treats it
// as the v4-flash alias (DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP), and pi-ai's
// installed catalog only lists the v4 ids, so without this alias a relay
// route would materialize reasoning:false and the effort selector would be
// dead on the free model.
// `deepseek-4.1-flash` is the 2026-10-16 relay catalog rename of that same
// model (chat still routes the old alias server-side). The version segment
// "4.1" precedes "flash", so DEEPSEEK_V4_PATTERN does not match it — it rides
// this explicit-id list to keep the same V4 chat-completions dialect.
const DEEPSEEK_V4_EXPLICIT_IDS = new Set(['deepseek-chat', 'deepseek-4.1-flash']);

const DEEPSEEK_V4_CHAT_COMPLETIONS_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
  compat: {
    thinkingFormat: 'deepseek',
    supportsReasoningEffort: true,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
  },
};

// GLM-4.5+ / GLM-5.x OpenAI-compatible endpoints use Z.AI's thinking wire:
// `thinking: { type: 'enabled' | 'disabled', clear_thinking: false }`. They
// do not use DeepSeek's reasoning_content replay contract and should not be
// sent a provider-default `reasoning_effort` field. Map every enabled UI rung
// to the one supported wire state and keep the explicit off state available.
const GLM_PATTERN = /^glm-(?:4\.[5-9](?:[.\-_].*)?|5(?:[.\-_].*)?|[6-9]\d*(?:[.\-_].*)?)/i;
const GLM_CHAT_COMPLETIONS_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'enabled', high: 'enabled', max: 'enabled' },
  compat: {
    thinkingFormat: 'zai',
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
};

// GLM behind an OpenAI Responses-compatible gateway (z.ai serves /v1/responses
// for the GLM line). Enabled rungs send `reasoning: { effort, summary }` plus
// the reasoning.encrypted_content include — exactly what pi-ai's
// openai-responses generator emits once the model declares reasoning — which
// streams the deliberation as separate reasoning_text deltas and keeps the
// message text clean (verified against api.z.ai 2026-09-07, streaming and
// non-streaming, with tools and ~200KB payloads). Compat: only fields the
// RESPONSES_COMPAT_GATE offers are settable — supportsStore and the
// chat-completions dialect knobs are completions-only and fail plugin load on
// this wire.
//
// `off` is spelled per family generation. GLM-4.x honors `effort: 'none'`, so
// it keeps the off:null shape (absent from the thinkingLevelMap → pi-ai's
// responses writer sends reasoning:{effort:'none'}). GLM-5.x cannot disable —
// zhipu's chat wire 400s 'none' outright and Volcengine Ark silently ignores
// it while running UNBOUNDED default-effort thinking that consumed the whole
// configured output budget (2026-11-05 glm-5.3-flash@ark session 1ed5daec,
// "Response incomplete: length") — so it declares off:'low', the bounded
// lowest rung. pi-ai then answers an off turn with the MINIMAL
// reasoning:{effort:'low'} shape (no summary/include surface), the same
// doctrine the OpenAI-compat proxy applies via
// modelThinking.responsesEffortForThinkingOff.
const GLM_RESPONSES_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'high' },
  compat: {
    supportsDeveloperRole: false,
  },
};

const GLM5_RESPONSES_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: 'low', low: 'low', high: 'high', max: 'high' },
  compat: {
    supportsDeveloperRole: false,
  },
};

// GLM on the OpenCode Go gateway's chat-completions wire. The gateway does
// NOT speak Z.AI's `thinking: {type}` object — it rejects the body outright
// (2026-10-13 continuation of the glm-5.3-flash incident: after the protocol
// correction moved GLM onto /v1/chat/completions, the zai-dialect declaration
// above produced `400 {"param":"thinking","message":"Upstream request failed:
// [unknown_parameter] json: unknown field \"thinking\""}`). pi-ai's own
// opencode-go catalog declares these models with a plain low/high/max ladder
// and its default compat for opencode.ai hosts (supportsReasoningEffort:
// true, no thinkingFormat) — i.e. the standard `reasoning_effort` field. This
// variant mirrors exactly that; `off` keeps the send-nothing shape (gateway
// default decides). Compat fields match the catalog's opencode-go GLM entries.
const GLM_OPENCODE_GO_CHAT_COMPLETIONS_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
  compat: {
    supportsReasoningEffort: true,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
};

// GLM behind an Anthropic-Messages-compatible gateway (Volcengine Ark's
// coding/agent plans serve the GLM line over /v1/messages). The wire dialect
// is Claude's adaptive thinking: enabled rungs send
// `thinking: { type: 'adaptive', display: 'summarized' }` plus
// `output_config: { effort }`. Ark's accepted effort vocabulary is exactly
// low/medium/high/max — it 400s `xhigh` (cc-switch#2729, 2026-05-11) — which
// this ladder never emits. forceAdaptiveThinking is offered by the anthropic
// compat gate; without it pi-ai falls back to budget_tokens thinking, which
// Ark's GLM-serving endpoint does not document. Verified against pi-ai
// anthropic-messages streamSimple/buildParams (2026-09-17).
//
// `off` is spelled per family generation. GLM-4.x keeps off:null (the writer
// emits the explicit thinking:{type:'disabled'}, honored by disable-capable
// gateways). GLM-5.x OMITS off entirely: pi-ai pins thinkingLevelMap.off to
// null (unsupported), so once the runner drops the off effort
// (dshRouteReasoningEffort) the writer emits NO thinking control and the
// provider default applies — the same tolerate-and-default treatment the
// working GLM gateways give an off turn. Declaring any off value here would
// make the writer emit `thinking:{type:'disabled'}`, which Ark rejects with
// 400 InvalidParameter ("thinking.type `disabled` is not supported by this
// model", 2026-11-05 session 1ed5daec).
const GLM_ANTHROPIC_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
  compat: {
    forceAdaptiveThinking: true,
  },
};

const GLM5_ANTHROPIC_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  compat: {
    forceAdaptiveThinking: true,
  },
};

/** Bare model id: drop any vendor prefix ("deepseek/deepseek-v4-flash" → "deepseek-v4-flash"). */
const bareModelIdOf = (modelId: string): string => {
  const trimmed = modelId.trim();
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
};

/**
 * Reasoning declaration for a model on a non-native DSH route, or null when
 * the family is unknown — the model then keeps the provider default, and the
 * turn layer must NOT send effort (an undeclared reasoning:false model would
 * reject any non-off effort outright).
 *
 * `baseUrl` (optional) disambiguates the wire dialect per gateway: the same
 * GLM family speaks Z.AI's `thinking` object on z.ai/zhipu OpenAI-compatible
 * endpoints but the standard `reasoning_effort` field on the OpenCode Go
 * gateway (GLM_OPENCODE_GO_CHAT_COMPLETIONS_DECLARATION). Omit it only when
 * the route's base URL is genuinely unknown.
 */
export function dshModelReasoningDeclaration(
  modelId: string,
  apiFormat: 'openai' | 'responses' | 'anthropic',
  baseUrl?: string | null,
): DshModelReasoningDeclaration | null {
  const bare = bareModelIdOf(modelId);
  if (isDeepSeekV4FamilyModelId(bare)) {
    if (apiFormat !== 'openai') return null;
    return DEEPSEEK_V4_CHAT_COMPLETIONS_DECLARATION;
  }
  if (GLM_PATTERN.test(bare)) {
    // GLM-5.x always thinks and cannot express off on any wire (zhipu 400
    // code 1210; Volcengine Ark 400 InvalidParameter on thinking.type
    // `disabled`) — its responses/anthropic declarations spell off
    // differently from the disable-capable GLM-4.x ones (see the constant
    // comments).
    const alwaysThinks = modelAlwaysThinks(bare);
    if (apiFormat === 'openai') {
      return isOpenCodeGoBaseUrl(baseUrl)
        ? GLM_OPENCODE_GO_CHAT_COMPLETIONS_DECLARATION
        : GLM_CHAT_COMPLETIONS_DECLARATION;
    }
    if (apiFormat === 'responses') return alwaysThinks ? GLM5_RESPONSES_DECLARATION : GLM_RESPONSES_DECLARATION;
    return alwaysThinks ? GLM5_ANTHROPIC_DECLARATION : GLM_ANTHROPIC_DECLARATION;
  }
  return null;
}

/**
 * The effort value a turn may actually put on the wire for this route.
 *
 * Efforts other than "off" ride untouched, and so does "off" itself for every
 * family that can express it. GLM-5.x-class always-thinking models are the
 * exception: no wire offers a silent off once reasoning is declared. The zai
 * chat dialect HARDCODES `thinking:{type:'disabled'}` whenever no effort
 * rides (any declared rung produces the identical
 * `thinking:{type:'enabled', clear_thinking:false}`), so an off turn must
 * carry the lowest rung to avoid the kill switch Ark rejects with 400
 * InvalidParameter (2026-11-05 session 1ed5daec). The reasoning_effort
 * dialect (OpenCode Go) already sends nothing for off — keep it. On the
 * responses and anthropic wires the effort is DROPPED and the declaration
 * decides: glm-5+ responses maps off→'low' (minimal
 * reasoning:{effort:'low'}), glm-5+ anthropic omits off entirely (no
 * thinking control; provider default — the same tolerate-and-default
 * treatment CommandCode/zhipu give an off turn).
 */
export function dshRouteReasoningEffort(
  modelId: string,
  apiFormat: 'openai' | 'responses' | 'anthropic',
  baseUrl: string | null | undefined,
  effort: string | null | undefined,
): string | undefined {
  if (effort !== 'off') return effort ?? undefined;
  if (!modelAlwaysThinks(bareModelIdOf(modelId))) return effort;
  if (apiFormat === 'openai') {
    return isOpenCodeGoBaseUrl(baseUrl) ? effort : 'low';
  }
  return undefined;
}

/**
 * Family trait for the DSH event mapper's tool-ride text classification:
 * DeepSeek models narrate tool-round process text in the CONTENT channel —
 * short "先看仓库结构。" lines riding a tool call — so the mapper folds such
 * text into the hidden thinking display. GLM keeps its process text in the
 * reasoning channel, so text riding a tool call is real content and must stay
 * visible: the 2026-09-25 gas-pool incident had glm-5.3-flash emit the
 * complete daily report as a text block next to a todo_write call, and the
 * fold hid it twice — the user saw a one-line summary while the full report
 * sat in the Think row. Families without a declaration keep the historical
 * fold default; add them here once their narration dialect is known.
 */
export function foldsToolRideTextIntoThinking(modelId: string | undefined | null): boolean {
  if (!modelId) return true;
  return !GLM_PATTERN.test(bareModelIdOf(modelId));
}

/**
 * True when the model id (vendor prefixes stripped) is the GLM family this
 * file declares reasoning for. Shared with the gateway protocol resolution
 * (opencodeGoProtocol.ts): the OpenCode Go gateway serves the GLM line over
 * chat completions only, so a route-level 'responses' apiFormat must be
 * corrected before the declaration lookup — otherwise the lookup itself is
 * keyed on a wire the gateway refuses.
 */
export function isGlmFamilyModelId(modelId: string): boolean {
  return GLM_PATTERN.test(bareModelIdOf(modelId));
}

/**
 * True when the model id (vendor prefixes stripped) is the DeepSeek V4 family
 * this file declares reasoning for — the same membership the chat-completions
 * declaration above keys on. Shared with the gateway protocol resolution
 * (opencodeGoProtocol.ts): the OpenCode Go gateway lists the family only
 * under chat completions, so a route-level 'responses' apiFormat must be
 * corrected before the declaration lookup, exactly like GLM.
 */
export function isDeepSeekV4FamilyModelId(modelId: string): boolean {
  const bare = bareModelIdOf(modelId);
  return DEEPSEEK_V4_PATTERN.test(bare) || DEEPSEEK_V4_EXPLICIT_IDS.has(bare.toLowerCase());
}

const undeclaredEffortWarnedRoutes = new Set<string>();

/**
 * Warn-once text for a route whose configured reasoning effort cannot ride
 * the wire (the family is undeclared on this apiFormat), or null once the
 * route identity has already been reported this process. Without a
 * declaration the effort is silently ignored and the provider's server-side
 * default decides whether the model thinks — exactly the silence that let
 * the 2026-09-03 z.ai default flip leak deliberation on-chain for days. One
 * log line per route identity makes the next flip visible in cowork.log.
 */
export function undeclaredReasoningRouteWarning(input: {
  provider: string;
  model: string;
  apiFormat: 'openai' | 'responses' | 'anthropic';
  effort: string;
}): string | null {
  const key = `${input.provider}|${input.model}|${input.apiFormat}|${input.effort}`;
  if (undeclaredEffortWarnedRoutes.has(key)) return null;
  undeclaredEffortWarnedRoutes.add(key);
  return (
    `Reasoning effort "${input.effort}" is configured but cannot ride model "${input.model}" ` +
    `on the ${input.apiFormat} wire (provider "${input.provider}"): the family has no thinking ` +
    'declaration, so the effort is ignored and the provider server default decides whether the ' +
    'model thinks. Add a declaration in dshModelReasoning.ts if this model supports reasoning.'
  );
}
