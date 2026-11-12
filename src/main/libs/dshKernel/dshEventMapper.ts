// DSH session-event → CoworkMessage mapper (Phase 1 M4).
//
// This is the DSH counterpart of handleClaudeEvent's SDK-event half: a pure,
// stateful transformer from wire `session/event` envelopes into the same
// message/streaming/turn actions the Claude path emits, so the store, the
// renderer, and every consumer above CoworkRunner stay untouched.
//
// Shapes below are taken verbatim from recorded rc.6 wire traffic (M1-M3
// tests). Event payloads nest under `envelope.data`. Known quirks baked in:
//  - plugin-source user messages (approval policy snapshots, runtime context)
//    must NOT become user bubbles — they are model-facing context only
//  - tool/result carries only the callId; the tool name lives on tool/call
//  - usage arrives on assistant/chunk (usage) and assistant/message events
//  - some DeepSeek/gateway routes leak chain-of-thought into text-delta as
//    <think> tags instead of reasoning-delta; those are split into the
//    thinking slot so the renderer can reuse Claude's ThinkingBlock
//  - DeepSeek Responses (pi-ai) tags text items commentary/final_answer in
//    the assembled replay state; commentary ("thinking out loud" around tool
//    calls) is reclassified into the thinking slot at finalize
//  - Official DeepSeek on dsh-llm-deepseek has no phase tags: professional
//    mode treats text that accompanies tool calls as commentary, except on
//    GLM, whose tool-ride text may be the deliverable itself. Live reasoning
//    tokens arrive as `reasoning-delta` on assistant/chunk (the pre-0.1.5
//    `reasoning-chunks` web-UI stream no longer exists). While a native
//    reasoning block is live, or within POST_REASONING_TEXT_HOLD_UNITS of
//    body text after it closes, the visible text slot stays closed: riding
//    text may still be commentary, and opening a body bubble there is the
//    "thinking flashes as body copy, then folds into a Think row" failure.
//    Past that window the text is the final answer taking over — the bubble
//    OPENS and streams (first-response latency: the answer must not
//    materialize whole at assistant/message). A tool call that lands after
//    the bet folds the streamed bubble back into the live Think row and
//    retracts it (foldStreamedTextIntoThinking). The reasoning-disabled
//    route (effort "off") keeps its own guard: commentary there is the ONLY
//    process text, streams into the body bubble because no reasoning block
//    ever opens the thinking slot, and converts at `block-start tool-call`
//    (textRidesThinking) instead of at assistant/message finalize.
//  - Assistant chat-experience mode (DshEventMapperOptions.assistantMode):
//    every model family and phase label gets the same tool-ride fold, so
//    process text that rode with tool calls cannot bypass owner_update.
//    Text streaming itself follows the SAME family-trait gates as
//    professional mode (owner ruling 2026-11-12: Studio must feel like
//    BotWorks — text appears as soon as it streams instead of popping as
//    milestones). Substantial answers followed by more tools still enter a
//    bounded finalization step with the full candidate preserved as fallback
//    instead of publishing a short addendum. The flag is a getter evaluated
//    per decision, never cached: the mapper is a long-lived per-session
//    instance and the mode can flip mid-session.
//
// Think rows are SEGMENTED PER TOOL ROUND (deepseek-harness web parity): each
// assistant step's thinking is finalized as its own settled Think message at
// assistant/message, so the next round's reasoning opens a FRESH Think row
// below the tool rows it precedes — think → tools → think → tools → reply.
// The earlier design held one streaming ThinkingBlock across every tool round
// of the turn, which stranded a single ever-scrolling Think row above a pile
// of tool calls with no interleaving.

import type { DshMapperAction, DshSessionEventEnvelope, DshUsageSnapshot } from './types'
import { splitThinkTaggedContent } from './thinkTags'
import { foldsToolRideTextIntoThinking } from '../dshModelReasoning'
import { tApp } from '../appLanguage'

const textOf = (blocks: Array<{ type: string; text?: string }> | undefined): string =>
  (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

const reasoningOf = (blocks: Array<{ type: string; text?: string }> | undefined): string =>
  (blocks ?? []).filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('')

const hasToolCallIn = (blocks: Array<{ type: string }> | undefined): boolean =>
  (blocks ?? []).some((b) => b.type === 'tool-call' || b.type === 'tool_use')

const joinThinking = (parts: string[]): string =>
  parts.filter((part) => part.length > 0).join('\n\n')

/** Provider wording that identifies a context-window rejection of the
 *  compaction request itself (Command Code gateway, OpenAI/Anthropic and
 *  DeepSeek dialects). Matched against the raw error detail — the kernel's
 *  `compaction/end` error is the adapter's rendered chain, not a stable code. */
const COMPACTION_OVERFLOW_RE = /context[\s_-]*(?:length|window)[\s_-]*(?:exceed|overflow|limit)|exceeds the context window|context window this endpoint can start from|prompt is too long|too (?:long|large) for (?:this |the )?model|maximum context length/i

/** Unwrap the innermost provider message from a kernel compaction-error
 *  detail. The chain looks like `400: {"message":"{\"error\":{\"message\":
 *  \"...\"}}"}` — one or two nested JSON layers that would otherwise render
 *  as a raw JSON blob in the transcript. */
export const innermostProviderMessage = (detail: string): string => {
  let current: unknown = detail
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'string') break
    const stripped = current.replace(/^\d{3}:\s*/, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(stripped)
    } catch {
      break
    }
    if (parsed && typeof parsed === 'object') {
      const next = (parsed as { message?: unknown }).message
      if (typeof next === 'string' && next.length > 0) {
        current = next
        continue
      }
      const errorLike = (parsed as { error?: { message?: unknown } }).error
      if (errorLike && typeof errorLike.message === 'string' && errorLike.message.length > 0) {
        current = errorLike.message
        continue
      }
    }
    break
  }
  return typeof current === 'string' ? current : detail
}

/** Human-readable compaction failure line. A context-window rejection gets a
 *  factual explanation (the compaction request itself overflowed — the kernel
 *  replays the region as the summary request's prefix on the same route)
 *  instead of the raw `400: {…nested JSON…}` dump the transcript used to show. */
export function compactionFailureContent(detail: string): string {
  const providerMessage = innermostProviderMessage(detail)
  if (COMPACTION_OVERFLOW_RE.test(detail)) {
    const origin = providerMessage && providerMessage !== detail ? ` (provider: ${providerMessage})` : ''
    return tApp(
      `压缩失败：压缩请求本身超出了该模型路由可接受的上下文上限${origin}。内核会缩小压缩范围后重试；若本轮仍失败，会话将切换备用模型继续。`,
      `Compaction failed: the compaction request itself exceeded the context this model route accepts${origin}. The kernel will retry with a smaller range; if the turn still fails, the session continues on the fallback model.`,
    )
  }
  return `Compaction failed: ${detail}`
}

type TextPhase = 'commentary' | 'final_answer'

/**
 * Post-reasoning body-text hold, in UTF-16 units, on narration-fold routes
 * (DeepSeek dialect). Once the step's reasoning block CLOSES (block-end), the
 * first slice of body text is still held back: if a tool call lands inside
 * the window the text is commentary and folds into the Think row with no
 * visible flash; past the window the text is the final answer taking over —
 * the bubble opens and everything streams (first-response/streaming latency:
 * the answer must not materialize whole at assistant/message). Short replies
 * under the window simply settle at finalize, indistinguishable from a full
 * stream.
 */
export const POST_REASONING_TEXT_HOLD_UNITS = 160

/** Parse one pi-ai textSignature (`{"v":1,"id":…,"phase":…}`) into its phase. */
const phaseOfSignature = (signature: unknown): TextPhase | undefined => {
  if (typeof signature !== 'string' || signature.length === 0) return undefined
  try {
    const parsed = JSON.parse(signature)
    if (parsed && typeof parsed === 'object'
      && (parsed.phase === 'commentary' || parsed.phase === 'final_answer')) {
      return parsed.phase
    }
  } catch { /* malformed signatures stay unclassified */ }
  return undefined
}

/**
 * Ordered phases of the message's text blocks, from the assembled replay
 * state (`source.replayState.blocks[].textSignature`). DeepSeek's Responses
 * API tags every text item `commentary` (thinking out loud around tool
 * calls) or `final_answer` (the user-visible reply); pi-ai preserves the tag
 * only there — the wire `content` blocks and streaming deltas carry no phase.
 * Returns null when no block carries a phase (other providers/protocols keep
 * the legacy all-visible classification).
 */
const replayTextPhasesOf = (message: {
  content?: Array<{ type: string; text?: string }>
  source?: { replayState?: { blocks?: Array<{ type: string; textSignature?: unknown }> } }
} | undefined): Array<TextPhase | undefined> | null => {
  const blocks = message?.source?.replayState?.blocks
  if (!Array.isArray(blocks)) return null
  const phases: Array<TextPhase | undefined> = []
  let sawPhase = false
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    const phase = phaseOfSignature(block.textSignature)
    if (phase !== undefined) sawPhase = true
    phases.push(phase)
  }
  return sawPhase ? phases : null
}

export interface DshEventMapperOptions {
  /**
   * Assistant chat-experience mode getter, evaluated at every fold decision
   * (never cached): the mapper is a long-lived per-session instance while the
   * global mode can flip mid-session. Commentary folds into thinking in both
   * modes at tool-call boundaries; text STREAMING follows the same
   * family-trait gates in both modes (2026-11-12 ruling — Studio streams like
   * BotWorks), while round-end deferral and terminal promotion stay
   * assistant-only as the clean-chat guarantee.
   */
  assistantMode?: () => boolean
}

export class DshEventMapper {
  private readonly assistantMode: () => boolean
  private textOpen = false
  private textBuf = ''
  private thinkingOpen = false
  private thinkingBuf = ''
  /** Accumulated raw text-delta (may still contain <think> tags). */
  private rawTextBuf = ''
  /** True once a native reasoning-delta opened the thinking slot this step. */
  private reasoningFromDeltas = false
  /**
   * Native reasoning block is in flight this step (block-start /
   * reasoning-delta). Distinct from think-tag splits inside text-delta.
   * Cleared at the reasoning block-end: text that arrives afterwards may be
   * the final answer, gated by the POST_REASONING_TEXT_HOLD_UNITS window.
   */
  private reasoningBlockLive = false
  /**
   * A native reasoning block STARTED this step (block-start or
   * reasoning-delta), live or already closed. Gates the post-reasoning text
   * hold on narration-fold routes in professional mode. Assistant mode uses
   * the same hold even when effort-off means no reasoning block ever opens.
   */
  private reasoningSeenThisStep = false
  /**
   * A wrong answer-bet — body text streamed past the hold window and a
   * tool-call block-start then proved it commentary — folds the streamed
   * bubble back into the live Think row. Later deltas of the step keep
   * streaming into that row, recomputed against the pre-fold thinking
   * captured in foldedThinkingBase.
   */
  private streamedTextFoldedIntoThinking = false
  /** Thinking content BEFORE the wrong-bet fold; deltas rejoin it wholesale. */
  private foldedThinkingBase = ''
  /**
   * The text-slot message has been converted in place into the thinking
   * display (tool-call commentary on routes with no live reasoning block —
   * notably effort "off", where commentary is the only process text). The
   * converted message keeps living under the TEXT slot id, so every later
   * update and finalize of this round must address slot 'text' while the
   * thinking bookkeeping (thinkingOpen / thinkingBuf) rides on top of it.
   */
  private textRidesThinking = false
  private lastUsage: DshUsageSnapshot | null = null
  private provider: string | undefined
  private model: string | undefined
  // Per-turn activity signals for the empty-terminal-turn guard: a turn that
  // ends 'stop' having produced neither text nor tool calls ended before doing
  // anything — the DeepSeek reasoning-only truncation the Claude path
  // auto-continues on (bf15f63d). Flags reset at every turn/end.
  private turnSawToolCall = false
  /** Sticky per-turn: a step finalized VISIBLE reply text (commentary-phase
   * text finalized into thinking does not count — a turn whose only output is
   * commentary must still look empty so the auto-continue guard can fire). */
  private turnSawFinalText = false
  /** Text streamed since the last assistant/message finalize — the defensive
   * "produced something" signal for streams that end without assembling. */
  private turnSawStreamedText = false
  private deferredAssistantText: { content: string; allowTerminalPromotion: boolean } | null = null

  constructor(opts?: DshEventMapperOptions) {
    this.assistantMode = opts?.assistantMode ?? (() => false)
  }

  consume(envelope: DshSessionEventEnvelope): DshMapperAction[] {
    const actions: DshMapperAction[] = []
    const data = envelope.data ?? {}
    switch (envelope.type) {
      case 'user/message': {
        // NOT mapped: the host's submission path already records user bubbles
        // for prompts and steers (same as handleClaudeEvent never echoes user
        // input back). All user-role events here — human input, plugin runtime
        // snapshots (approval policy), tool-result carries — are model-facing
        // facts only; tool results arrive as their own tool/result events.
        break
      }

      case 'request/header': {
        // Full assembled request snapshot: capture the route for usage reports.
        this.provider = data.header?.config?.provider ?? this.provider
        this.model = data.header?.config?.model ?? this.model
        break
      }

      case 'assistant/chunk': {
        const chunk = data.chunk
        if (chunk?.type === 'block-start' && chunk.blockType === 'reasoning') {
          this.reasoningBlockLive = true
          this.reasoningSeenThisStep = true
          this.openThinking(actions)
        } else if (chunk?.type === 'block-start' && chunk.blockType === 'tool-call') {
          // Professional mode follows the model-family trait; assistant mode
          // folds tool-ride text on every family into the hidden process row.
          if (this.toolRideTextFolds() || this.assistantMode()) {
            if (this.textOpen && this.thinkingOpen) {
              // Wrong answer-bet on a reasoning route: text streamed past the
              // hold window and this tool call proves it commentary. Fold it
              // into the live Think row and retract the bubble now — waiting
              // for assistant/message would leave commentary visible for the
              // whole tool round.
              this.foldStreamedTextIntoThinking(actions)
            } else {
              this.convertRidingTextToThinking(actions)
            }
          }
        } else if (chunk?.type === 'text-delta') {
          this.rawTextBuf += chunk.text ?? ''
          const split = splitThinkTaggedContent(this.rawTextBuf)
          if (!this.reasoningFromDeltas && split.thinking.length > 0) {
            this.openThinking(actions)
            this.thinkingBuf = split.thinking
            actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
          }
          if (this.textRidesThinking) {
            // Commentary keeps streaming into the converted thinking display
            // for the rest of this round (settled at assistant/message).
            this.thinkingBuf = split.text
            actions.push({ kind: 'messageUpdate', slot: 'text', content: this.thinkingBuf })
          } else if (this.streamedTextFoldedIntoThinking) {
            // Wrong answer-bet: the rest of this step's text rejoins the
            // Think row the streamed bubble folded into, recomputed from the
            // pre-fold thinking base plus the full step text.
            this.thinkingBuf = joinThinking([this.foldedThinkingBase, split.text])
            actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
          } else if (split.text.length > 0 && this.postReasoningTextMayStream(split.text)) {
            // Native reasoning live or inside the post-reasoning hold
            // window: text stays held until assistant/message proves it is
            // the final answer — on narration-fold routes (DeepSeek
            // dialect) riding text may still be commentary, and opening a
            // body bubble here is the flash the DSH web UI never does.
            // Past the hold window (or on non-folding families like GLM,
            // whose riding text is content) the text streams visibly.
            this.openText(actions)
            this.textBuf = split.text
            this.turnSawStreamedText = true
            actions.push({ kind: 'messageUpdate', slot: 'text', content: this.textBuf })
          }
        } else if (chunk?.type === 'reasoning-delta') {
          this.reasoningBlockLive = true
          this.reasoningSeenThisStep = true
          this.reasoningFromDeltas = true
          this.appendReasoning(actions, chunk.text ?? '')
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
          // The step's reasoning block is complete — no more reasoning comes
          // this step, so later body text is answer-or-commentary, gated by
          // the post-reasoning hold window instead of the hard hold.
          this.reasoningBlockLive = false
          const assembled = typeof chunk.block.text === 'string' ? chunk.block.text : ''
          if (assembled.length > 0) {
            this.openThinking(actions)
            this.thinkingBuf = assembled
            actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
          }
        } else if (chunk?.type === 'usage') {
          this.lastUsage = this.withRoute(chunk.usage)
        }
        break
      }

      case 'assistant/message': {
        this.finalizeAssistantMessage(actions, data)
        const usage = this.withRoute(data.usage ?? undefined)
        if (usage) {
          this.lastUsage = usage
          actions.push({ kind: 'usage', usage })
        }
        break
      }

      case 'tool/call': {
        this.turnSawToolCall = true
        let toolInput: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(data.arguments ?? '{}')
          if (parsed && typeof parsed === 'object') toolInput = parsed as Record<string, unknown>
        } catch { /* keep empty input on malformed arguments */ }
        actions.push({
          kind: 'message',
          message: {
            type: 'tool_use',
            content: `Using tool: ${data.name ?? 'unknown'}`,
            metadata: {
              toolName: data.name ?? 'unknown',
              toolInput,
              toolUseId: typeof data.callId === 'string' ? data.callId : null,
            },
          },
        })
        break
      }

      case 'tool/result': {
        // 0.1.7: the message IS the tool result — role 'tool', top-level
        // toolCallId/isError, content = raw result blocks. Pre-0.1.7 wrapped
        // it in a content block typed 'tool-result'; keep the fallback so
        // replayed pre-upgrade history still maps.
        const message = data.message as
          | { toolCallId?: unknown; isError?: unknown; content?: Array<{ type: string; toolCallId?: unknown; isError?: unknown; content?: Array<{ type: string; text?: string }> } & { type: string; text?: string }> }
          | undefined
        const legacyBlock = message?.content?.find?.((b) => b.type === 'tool-result')
        const content = textOf(legacyBlock ? legacyBlock.content : message?.content)
        const isError = Boolean(legacyBlock ? legacyBlock.isError : message?.isError)
        const rawCallId = legacyBlock?.toolCallId ?? message?.toolCallId
        actions.push({
          kind: 'message',
          message: {
            type: 'tool_result',
            content,
            metadata: {
              toolResult: content,
              toolUseId: typeof rawCallId === 'string' ? rawCallId : null,
              error: isError ? content || 'Tool execution failed' : undefined,
              isError,
            },
          },
        })
        break
      }

      case 'turn/end': {
        const reason = data.reason ?? { kind: 'unknown' }
        // Empty terminal turn: a clean 'stop' with no text and no tool calls
        // this turn — the model emitted (at most) reasoning and ended. Flag it
        // so the turn runner can auto-continue once instead of reporting a
        // hollow "completed" (parity with the Claude path's bf15f63d fix).
        const emptyTerminal = reason.kind === 'stop'
          && !this.turnSawFinalText
          && !this.turnSawStreamedText
          && !this.turnSawToolCall
        const finalizationRequired = this.assistantMode()
          && (reason.kind === 'stop' || reason.kind === 'completed')
          && this.turnSawToolCall
          && !this.turnSawFinalText
        const fallbackFinalText = finalizationRequired && this.deferredAssistantText?.allowTerminalPromotion
          ? this.deferredAssistantText.content
          : undefined
        this.closeOpenSlots(actions)
        actions.push({
          kind: 'turnEnd',
          turn: data.turn,
          reason,
          ...(emptyTerminal ? { emptyTerminal: true } : {}),
          ...(finalizationRequired ? { finalizationRequired: true } : {}),
          ...(fallbackFinalText ? { fallbackFinalText } : {}),
        })
        this.turnSawFinalText = false
        this.turnSawStreamedText = false
        this.turnSawToolCall = false
        this.deferredAssistantText = null
        break
      }

      case 'compaction/summary': {
        // The summary text is the kernel's new LLM context, not chat content —
        // storing it in the transcript leaked internal state into the UI. Keep
        // a structured stub instead (parity with the Claude route's
        // compact_boundary); the renderer renders one brief localized line.
        const items = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0
        const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
        actions.push({
          kind: 'message',
          message: {
            type: 'system',
            content: '',
            metadata: { compaction: true, compactedItems: items, compactedTokens: tokens },
          },
        })
        break
      }

      case 'compaction/end': {
        if (data.error) {
          const detail = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
          actions.push({
            kind: 'message',
            message: {
              type: 'system',
              content: compactionFailureContent(detail),
              metadata: { compaction: true, isError: true },
            },
          })
        }
        break
      }

      default:
        break
    }
    return actions
  }

  /** Latest usage snapshot (the getContextUsage equivalent source). */
  usage(): DshUsageSnapshot | null {
    return this.lastUsage
  }

  /**
   * Whether this route's family narrates tool-round process text in the
   * content channel (DeepSeek dialect → fold riding text into the thinking
   * display). GLM keeps process text in the reasoning channel, so its riding
   * text is content and stays visible. Unknown families keep the historical
   * fold default; see foldsToolRideTextIntoThinking for the trait registry.
   */
  private toolRideTextFolds(): boolean {
    return foldsToolRideTextIntoThinking(this.model)
  }

  private deferToolRideText(content: string): void {
    if (!this.assistantMode()) return
    this.deferredAssistantText = content.length > 0
      ? {
        content,
        allowTerminalPromotion: content.length >= POST_REASONING_TEXT_HOLD_UNITS,
      }
      : null
  }

  private openThinking(actions: DshMapperAction[]): void {
    if (this.thinkingOpen) return
    this.thinkingOpen = true
    this.thinkingBuf = ''
    actions.push({
      kind: 'message',
      slot: 'thinking',
      message: { type: 'assistant', content: '', metadata: { isThinking: true, isStreaming: true } },
    })
  }

  private openText(actions: DshMapperAction[]): void {
    if (this.textOpen) return
    this.textOpen = true
    this.textBuf = ''
    actions.push({
      kind: 'message',
      slot: 'text',
      message: { type: 'assistant', content: '', metadata: { isStreaming: true } },
    })
  }

  /** Append live reasoning tokens onto the open thinking slot (DSH web stream). */
  private appendReasoning(actions: DshMapperAction[], piece: string): void {
    if (!piece) return
    this.openThinking(actions)
    this.thinkingBuf += piece
    actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
  }

  /**
   * Identical text-streaming policy for both surfaces (owner ruling
   * 2026-11-12: Studio must feel like BotWorks — text appears as soon as it
   * streams, not as popped milestones). Assistant mode used to hold text on
   * EVERY family until the 160-unit window cleared, which turned every
   * Studio reply into a single end-of-turn pop; the family-trait rules below
   * now govern both modes and the existing tool-call folds still retract
   * commentary that streamed optimistically. Round-end deferral and terminal
   * promotion (deferToolRideText / finalizationRequired) are unchanged —
   * they remain the assistant mode's clean-chat guarantee for rounds whose
   * text rode with tool calls.
   */
  private postReasoningTextMayStream(text: string): boolean {
    if (this.textOpen) return true
    if (!this.toolRideTextFolds()) return true
    if (this.reasoningBlockLive) return false
    if (!this.reasoningSeenThisStep) return true
    return text.length >= POST_REASONING_TEXT_HOLD_UNITS
  }

  /**
   * Fold a wrong answer-bet's streamed bubble into the live Think row: the
   * streamed text joins the row's content, the bubble retracts (finalizes
   * empty — the renderer hides it), and the step's later deltas keep
   * streaming into the row. The pre-fold thinking is captured once so each
   * later delta recomputes base + full step text wholesale.
   */
  private foldStreamedTextIntoThinking(actions: DshMapperAction[]): void {
    const split = splitThinkTaggedContent(this.rawTextBuf)
    this.foldedThinkingBase = this.thinkingBuf
    this.thinkingBuf = joinThinking([this.foldedThinkingBase, split.text])
    this.streamedTextFoldedIntoThinking = true
    this.textOpen = false
    this.textBuf = ''
    actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
    actions.push({ kind: 'messageFinalize', slot: 'text', content: '' })
  }

  /**
   * Convert the streaming body bubble into the thinking display the moment a
   * tool call proves its text is commentary. No-op unless text is streaming
   * with no live thinking slot (the effort-"off" native route; with reasoning
   * live the hold logic already keeps text invisible). The message id keeps
   * living under the TEXT slot, so the finalize action retargets that slot
   * and later updates continue on the same message.
   */
  private convertRidingTextToThinking(actions: DshMapperAction[]): void {
    if (this.textRidesThinking || !this.textOpen || this.thinkingOpen) return
    this.textRidesThinking = true
    this.textOpen = false
    this.thinkingOpen = true
    const split = splitThinkTaggedContent(this.rawTextBuf)
    this.thinkingBuf = split.text
    actions.push({
      kind: 'messageFinalize',
      slot: 'text',
      content: this.thinkingBuf,
      metadata: { isThinking: true, isStreaming: true },
    })
  }

  /** Collapse any live slots at a real turn boundary so isStreaming cannot stick. */
  private closeOpenSlots(actions: DshMapperAction[]): void {
    if (this.textRidesThinking) {
      // The converted thinking display never saw a reply round to settle it
      // (turn aborted mid-loop): finalize through the text slot id it rides on.
      this.textRidesThinking = false
      this.thinkingOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: this.thinkingBuf, metadata: { isThinking: true } })
      this.thinkingBuf = ''
    }
    if (this.thinkingOpen) {
      this.thinkingOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'thinking', content: this.thinkingBuf })
      this.thinkingBuf = ''
    }
    if (this.textOpen) {
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: this.textBuf })
      this.textBuf = ''
    }
    this.reasoningFromDeltas = false
    this.reasoningBlockLive = false
    this.resetStepHoldState()
  }

  private finalizeAssistantMessage(
    actions: DshMapperAction[],
    data: { message?: { content?: Array<{ type: string; text?: string }>; source?: { replayState?: { blocks?: Array<{ type: string; textSignature?: unknown }> } } } }
  ): void {
    const blocks = data.message?.content
    const hasToolCall = hasToolCallIn(blocks)
    let reasoning = reasoningOf(blocks)
    let visibleText = textOf(blocks)

    if (this.textRidesThinking) {
      const split = splitThinkTaggedContent(visibleText || this.rawTextBuf)
      if (hasToolCall) this.deferToolRideText(split.text)
      else if (split.text.length > 0) this.deferredAssistantText = null
      this.finalizeRidingText(actions, blocks, visibleText, reasoning)
      this.rawTextBuf = ''
      this.reasoningFromDeltas = false
      this.reasoningBlockLive = false
      this.resetStepHoldState()
      this.turnSawStreamedText = false
      return
    }

    let commentary = ''
    const phases = replayTextPhasesOf(data.message)
    if (phases) {
      const commentaryParts: string[] = []
      const finalParts: string[] = []
      let index = 0
      for (const block of blocks ?? []) {
        if (block.type !== 'text') continue
        const text = block.text ?? ''
        if (text.length > 0) {
          if (phases[index] === 'commentary') commentaryParts.push(text)
          else finalParts.push(text)
        }
        index += 1
      }
      commentary = commentaryParts.join('\n\n')
      visibleText = splitThinkTaggedContent(finalParts.join('\n\n')).text
      if (hasToolCall && this.assistantMode() && visibleText.length > 0) {
        this.deferToolRideText(visibleText)
        commentary = joinThinking([commentary, visibleText])
        visibleText = ''
      }
    } else if (hasToolCall && (this.toolRideTextFolds() || this.assistantMode())) {
      const toolRideText = splitThinkTaggedContent(visibleText).text
      this.deferToolRideText(toolRideText)
      commentary = toolRideText
      visibleText = ''
    } else if (!reasoning) {
      const split = splitThinkTaggedContent(visibleText || this.rawTextBuf)
      reasoning = split.thinking || this.thinkingBuf
      visibleText = split.text
    } else {
      visibleText = splitThinkTaggedContent(visibleText).text
    }

    const shorterAddendum = this.assistantMode()
      && this.deferredAssistantText?.allowTerminalPromotion
      && visibleText.length > 0
      && visibleText.length < (this.deferredAssistantText?.content.length ?? 0)
    if (shorterAddendum) {
      commentary = joinThinking([commentary, visibleText])
      visibleText = ''
    }

    // A commentary-only message whose text already streamed into the text slot
    // converts that message in place (finalize as thinking) — no separate
    // thinking message and no empty visible bubble left behind. Skip when a
    // thinking slot is already live: fold commentary into it instead of
    // minting a second Think row for the same step.
    const convertStreamedTextToThinking = commentary.length > 0
      && visibleText.length === 0
      && this.textOpen
      && !this.thinkingOpen

    const combinedThinking = joinThinking([reasoning, commentary])

    if (!convertStreamedTextToThinking && combinedThinking.length > 0) {
      this.openThinking(actions)
      this.thinkingBuf = combinedThinking
    }

    // Every round settles its own Think row (deepseek-harness parity): a
    // tool-call round finalizes this step's thinking so the next round's
    // reasoning opens a FRESH row below the tool rows, keeping the timeline
    // interleaved (think → tools → think → tools → reply) instead of one
    // ever-scrolling Think row stranded above the whole tool pile.
    if (this.thinkingOpen) {
      this.thinkingOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'thinking', content: this.thinkingBuf })
      this.thinkingBuf = ''
    }

    if (visibleText.length > 0) {
      this.deferredAssistantText = null
      this.openText(actions)
      this.textBuf = visibleText
      this.turnSawFinalText = true
    }
    if (convertStreamedTextToThinking) {
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: commentary, metadata: { isThinking: true } })
      this.textBuf = ''
    } else if (this.textOpen && visibleText.length === 0) {
      // Commentary was held or folded; close the leaked visible placeholder
      // so a tiny summary cannot linger between thinking rounds.
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: '' })
      this.textBuf = ''
    } else if (this.textOpen) {
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: this.textBuf })
      this.textBuf = ''
    }

    this.rawTextBuf = ''
    this.reasoningFromDeltas = false
    this.reasoningBlockLive = false
    this.resetStepHoldState()
    this.turnSawStreamedText = false
  }

  /** Reset the per-step post-reasoning hold state at every step boundary. */
  private resetStepHoldState(): void {
    this.reasoningSeenThisStep = false
    this.streamedTextFoldedIntoThinking = false
    this.foldedThinkingBase = ''
  }

  /**
   * Finalize one assistant message while the text slot rides as the thinking
   * display (commentary converted at block-start tool-call — the effort-"off"
   * native route). The assembled message text is authoritative for this
   * round. Every round settles its own Think row: a tool-call round finalizes
   * the riding display with this round's commentary so the next round streams
   * into a FRESH bubble that converts again; the pure reply (no tool call)
   * settles the display and re-opens a body bubble for the reply text, which
   * must NOT enter the thinking display.
   */
  private finalizeRidingText(
    actions: DshMapperAction[],
    blocks: Array<{ type: string; text?: string }> | undefined,
    visibleText: string,
    reasoning: string,
  ): void {
    const split = splitThinkTaggedContent(visibleText || this.rawTextBuf)
    const settles = !hasToolCallIn(blocks)
    const combined = settles
      ? ''
      : joinThinking([reasoning, split.text])
    this.textRidesThinking = false
    this.thinkingOpen = false
    this.thinkingBuf = ''
    actions.push({
      kind: 'messageFinalize',
      slot: 'text',
      content: combined,
      metadata: { isThinking: true },
    })
    if (!settles) return
    if (split.text.length > 0) {
      this.openText(actions)
      this.textBuf = split.text
      this.turnSawFinalText = true
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: this.textBuf })
      this.textBuf = ''
    }
  }

  private withRoute(usage: Partial<DshUsageSnapshot> | undefined): DshUsageSnapshot | null {
    if (usage === undefined) return null
    return {
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      provider: this.provider,
      model: this.model,
    }
  }
}
