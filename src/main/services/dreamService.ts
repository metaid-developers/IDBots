import { createHash } from 'node:crypto';
import type { CoworkStore } from '../coworkStore';
import type { DreamDayActivity, DreamStore } from '../dreamStore';
import type { MetaIDExperienceStore } from '../metaidExperienceStore';
import type { MetaIDImpressionStore } from '../metaidImpressionStore';
import type { MetaIDKnowledgeStore } from '../metaidKnowledgeStore';
import {
  DREAM_LOOKBACK_DAYS,
  DREAM_VERSION,
  buildDreamFragmentPrompt,
  buildDreamPrompt,
  computeDueDreamDates,
  getDayBoundsMs,
  parseDreamOutput,
  validateSelfIdentity,
  type DreamKnowledgeExisting,
  type DreamOutput,
} from '../libs/dreamPrompt';
import {
  CAPABILITY_VALIDATION_MAX_DRAFTS,
  CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE,
  CAPABILITY_VALIDATION_SUMMARY_DAYS,
  CAPABILITY_PROMOTION_MAX_PER_NIGHT,
  CAPABILITY_PROMOTION_MIN_SCORE,
  CAPABILITY_REVIEW_INTERVAL_DAYS,
  CAPABILITY_REVIEW_MAX_PER_NIGHT,
  buildCapabilityValidationPrompt,
  parseCapabilityValidationOutput,
} from '../libs/capabilityValidationPrompt';
import {
  buildCounterfactualReplayPrompt,
  extractNegativeDecisionPoints,
  hasExplicitHumanFeedback,
  parseCounterfactualReplayOutput,
  pickCounterfactualLesson,
} from '../libs/counterfactualReplayPrompt';
import { extractImplicitSignals } from '../libs/implicitSignals';
import {
  WEEKLY_DREAM_MIN_DAYS,
  buildWeeklyDreamPrompt,
  getPreviousIsoWeekRange,
  parseWeeklyDreamOutput,
  type WeeklyDreamTelemetryDigest,
} from '../libs/weeklyDreamPrompt';
import {
  chunkDreamActivity,
  estimateDreamActivityTokens,
  summariesToActivity,
  type DreamActivityChunk,
  type DreamFragmentSummary,
} from '../libs/dreamFragments';
import { formatBotWorkspaceDate } from '../libs/botWorkspace';
import { resolveAutomationModelOverride, resolveCurrentModelLimits } from '../libs/claudeSettings';
import { budgetAssumesThinking } from '../libs/modelThinking';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';
import { metabotBrainOptions } from './llmFallback';
import { classifyDreamError, DREAM_RETRY_MAX_ATTEMPTS, DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS, isTransientDreamLlmError } from '../libs/dreamRetryPolicy';
import {
  applyMetaIDDreamImpressionUpdates,
  buildMetaIDDreamImpressionContext,
} from './metaidDreamImpressionService';

/**
 * 2026-10-08 stale-binding rung ④: fingerprints for the quota/config error
 * family that means "every configured brain rung is unusable" when the dream
 * ladder exhausts. ASCII upstream fingerprints only — the terminal error must
 * read「未配置任何可用的模型」, not a raw 429 (the avalanche read like a
 * provider blip when it was a stale binding). Parse/empty-content/auth errors
 * keep their own semantics and are NOT rewritten.
 */
const DREAM_LADDER_QUOTA_ERROR_FINGERPRINT = /insufficient[ _-]?(credits?|quota|balance|funds)|quota[ _-]?exceeded|billing[ _-]?limit|usagelimit/i;
const DREAM_LADDER_CONFIG_ERROR_FINGERPRINT = /llm config not available|llm base url not available|did not resolve to an enabled provider|provider selection is required|config resolution failure/i;
const isDreamLadderExhaustedQuotaError = (error: unknown): boolean => {
  const text = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return DREAM_LADDER_QUOTA_ERROR_FINGERPRINT.test(text) || DREAM_LADDER_CONFIG_ERROR_FINGERPRINT.test(text);
};

/**
 * Dream consolidation service — the nightly "做梦" pipeline.
 *
 * During the nightly window (00:00–06:00 local), each enabled MetaBot reviews
 * its previous day's experiences with its own LLM and produces: a daily
 * summary row, dream-origin memories (self-selected important items + work
 * reviews), and the protected self-identity entry. Missed days (app was off)
 * are caught up on the next start, bounded to the last DREAM_LOOKBACK_DAYS.
 *
 * Design follows the privateChatDaemon module-singleton pattern with an
 * injectable performChat for tests. All runs execute serially through one
 * queue; metabot_dream_runs rows are the idempotency anchor.
 */

const DREAM_TICK_INTERVAL_MS = 60_000;
const DREAM_LLM_TIMEOUT_MS = 180_000;
// Final-synthesis (and self-identity expansion) calls get a much wider window
// than fragments: they carry a ~30K-token prompt (23 fragment summaries + 60
// knowledge entries + impressions on a busy day) and emit the full dream JSON
// under a 32K ceiling. Fragment calls measured fine inside 180s (each ≤80s,
// first-try green), but the 2026-09-23 midday force-dream hit the 180s wall
// on BOTH the primary and the fallback brain in the same run (each aborted at
// exactly 180s while every fragment passed). 10 minutes is sized from the
// worst LEGITIMATE case, not the average: prefill on a 30K+ prompt (30-90s,
// uncached) + 6-8K tokens of dream JSON at heavily-throttled flash-tier speed
// (~20-25 tok/s → 250-400s) + proxy/TLS overhead ≈ 8-10 minutes. Only a call
// exceeding that is genuinely stalled (or the provider unusable) and SHOULD
// abort to the fallback / run-level retry — the timeout's actual job. The
// nightly cost is bounded arithmetic: ~20 bots × one synthesis each, worst
// case 10 min per synthesis = 200 min, still inside the 6-hour nightly window
// with fragments (≤80s each) and post-dream passes (4K ceilings) alongside.
const DREAM_SYNTHESIS_TIMEOUT_MS = 600_000;
// The requested ceiling is clamped to the selected model's declared limit
// (DeepSeek V4 declares 32K, unknown models now share that 32K default). The dream JSON is
// far smaller in practice; the headroom only matters so a long day is never
// truncated mid-JSON, and it costs nothing on short days.
const DREAM_LLM_TARGET_MAX_TOKENS = 32_768;
const DREAM_FRAGMENT_MAX_TOKENS = 4_096;
// Fragment ceiling when either brain may think despite the disabled toggle
// (GLM-5.x always-thinking, unknown families): reasoning rides the same
// output budget, so the fragment needs headroom for low-effort reasoning
// plus the summary JSON (see resolveDreamBudgets).
const DREAM_FRAGMENT_MAX_TOKENS_THINKING = 16_384;
const DREAM_CONTEXT_RESERVE_TOKENS = 8_000;
const DREAM_FAST_PATH_MAX_TOKENS = 96_000;
const DREAM_CHUNK_MAX_TOKENS = 64_000;
const DREAM_STATUS_CHANNEL = 'metabot:dreamStatusChanged';

const EVALUATION_LABELS: Record<string, string> = {
  warming: '升温',
  stable: '持平',
  cooling: '降温',
};

export interface DreamMetabotLike {
  id: number;
  name: string;
  role?: string | null;
  soul?: string | null;
  llm_id?: string | null;
  llm_provider?: string | null;
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  globalmetaid?: string | null;
  enabled?: boolean;
}

/** The resolved brain pair for one dream run (global dreamLlmId override already applied). */
interface DreamBrainPair {
  llmId: string | null;
  /** Provider key the primary brain model was picked from (id-collision disambiguation). */
  llmProvider: string | null;
  fallbackLlmId: string | null;
  fallbackLlmProvider: string | null;
  /**
   * 2026-10-08 stale-binding ladder: when a dreamLlmId override is active,
   * `llmId` above IS the override and the bot's OWN primary brain rides here
   * as the intermediate rung (Boss's unified order: override → bot primary →
   * bot fallback → "no usable model" error). Null/absent = no override; the
   * pair above already IS the bot brain (rungs collapse to primary+fallback).
   */
  botPrimaryRung?: { llmId: string | null; llmProvider: string | null } | null;
}

export interface DreamMetabotStoreLike {
  listMetabots(): DreamMetabotLike[];
}

export type DreamPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    llmProvider?: string | null;
    /** Per-attempt timeout: primary and fallback each get a fresh window. */
    attemptTimeoutMs?: number;
    throwOnEmptyContent?: boolean;
    thinking?: 'enabled' | 'disabled';
    webSearch?: boolean;
  }
) => Promise<string>;

export interface DreamServiceDeps {
  coworkStore: CoworkStore;
  metabotStore: DreamMetabotStoreLike;
  dreamStore: DreamStore;
  performChat?: DreamPerformChat;
  emitToRenderer?: (channel: string, payload: unknown) => void;
  metaidExperienceStore?: MetaIDExperienceStore;
  metaidImpressionStore?: MetaIDImpressionStore;
  metaidKnowledgeStore?: MetaIDKnowledgeStore;
  /**
   * Pre-dream MetaWeb surf ("做梦前自动冲浪"): called once per dream run
   * before the prompt is built; the host wiring owns the enable check, the
   * recency dedupe, the timeout, and failure isolation (a surf failure must
   * never fail the dream — it returns null). The returned report markdown is
   * folded into the dream prompt as its own section.
   */
  surfBeforeDream?: (metabotId: number) => Promise<{ reportMarkdown: string | null } | null>;
  tickIntervalMs?: number;
  llmTimeoutMs?: number;
  /**
   * Delays before each in-run transient LLM re-drive (default
   * DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS). Tests inject tiny values; pass an
   * empty array to disable in-run retries entirely.
   */
  transientRetryDelaysMs?: readonly number[];
  now?: () => Date;
}

interface DreamQueueItem {
  metabotId: number;
  date: string;
  /** Version-repair run: refreshes the day's records but never touches identity. */
  isRepair: boolean;
}

function dreamRunKey(metabotId: number, date: string): string {
  return `${metabotId}:${date}`;
}

/** Separator set the diary uses inside composite references (「A=B」「甲→乙」). */
const DIARY_REF_SPLIT_RE = /[·→+=|/\\、，,。：:；;！!？?（）()\[\]【】""'']+\s*|\s+/;

/**
 * Whether a diary 「」 span is anchored in the day's raw record text. Anchors,
 * in order of strength:
 *  1. the full span appears verbatim (a quoted catchphrase: 「屌丝」 found in
 *     the messages);
 *  2. a separator-delimited fragment of ≥4 chars appears verbatim (composites
 *     the diary condenses from real records: 「密文相同=同载荷铁证」 anchors
 *     through 密文相同 in a chain-read excerpt);
 *  3. any contiguous window of ≥ max(4, ⌈span/2⌉) chars appears verbatim
 *     (condensed CJK claims like 「十一枚应为十枚」 whose wording tracks the
 *     original dispute without matching it whole).
 * Deliberately fail-safe toward "grounded": this counter feeds a trust proxy,
 * so a stray anchor (a fabricated phrase sharing a generic run with real text)
 * undercounts rather than crying hallucination. Window scans are bounded by
 * the 40-char span cap, so a huge day costs at most a few hundred substring
 * searches over the joined record text.
 */
function diarySpanAnchoredInText(span: string, rawText: string): boolean {
  if (!rawText || !span) return false;
  if (rawText.includes(span)) return true;
  for (const fragment of span.split(DIARY_REF_SPLIT_RE)) {
    const trimmed = fragment.trim();
    if (trimmed.length >= 4 && rawText.includes(trimmed)) return true;
  }
  const windowLen = Math.max(4, Math.ceil(span.length / 2));
  if (windowLen >= span.length) return false;
  for (let start = 0; start + windowLen <= span.length; start += 1) {
    if (rawText.includes(span.slice(start, start + windowLen))) return true;
  }
  return false;
}

export class DreamService {
  private readonly performChat: DreamPerformChat;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: DreamQueueItem[] = [];
  private processing = false;
  /** Completion signals let manual callers wait even when another queue drain is already active. */
  private runCompletions = new Map<string, Promise<void>>();
  private runCompletionResolvers = new Map<string, () => void>();
  // Instances are live once constructed (runNow works without start());
  // stop() halts queue draining and future ticks.
  private stopped = false;
  private dreamingBots = new Set<number>();
  /** botId → local date key of the night a version repair was last scheduled. */
  private lastRepairNight = new Map<number, string>();

  constructor(private deps: DreamServiceDeps) {
    this.performChat = deps.performChat ?? performChatCompletionForOrchestrator;
  }

  start(): void {
    this.stopTimer();
    this.stopped = false;
    const resetCount = this.deps.dreamStore.resetStaleRunningRuns();
    if (resetCount > 0) {
      console.warn(`[DreamService] Reset ${resetCount} stale running dream run(s) from previous session`);
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickIntervalMs ?? DREAM_TICK_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getDreamingBotIds(): number[] {
    return Array.from(this.dreamingBots);
  }

  isDreaming(metabotId: number): boolean {
    return this.dreamingBots.has(metabotId);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private candidateDates(): string[] {
    const now = this.now();
    const dates: string[] = [];
    for (let daysAgo = 1; daysAgo <= DREAM_LOOKBACK_DAYS; daysAgo++) {
      dates.push(formatBotWorkspaceDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)));
    }
    return dates;
  }

  /** Scan all enabled bots for due dream dates and drain the queue. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    let bots: DreamMetabotLike[] = [];
    try {
      bots = this.deps.metabotStore.listMetabots().filter((bot) => bot && bot.enabled !== false);
    } catch (error) {
      console.warn('[DreamService] Failed to list metabots:', error);
      return;
    }
    const dates = this.candidateDates();
    const nightKey = formatBotWorkspaceDate(now);
    for (const bot of bots) {
      try {
        const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(bot.id);
        if (!policy.dreamEnabled) continue;
        const runStates = this.deps.dreamStore.getRunStates(bot.id, dates);
        const { dueDates, repairDates } = computeDueDreamDates({ now, metabotId: bot.id, runStates });
        for (const date of dueDates) {
          this.enqueue(bot.id, date);
        }
        // Algorithm-version repair: at most one stale date per bot per night,
        // newest first — the window converges over a few nights without a
        // nightly rewrite of the whole lookback range.
        if (repairDates.length > 0 && this.lastRepairNight.get(bot.id) !== nightKey) {
          if (this.enqueue(bot.id, repairDates[0], { isRepair: true })) {
            this.lastRepairNight.set(bot.id, nightKey);
          }
        }
      } catch (error) {
        console.warn(`[DreamService] Due-scan failed for metabot ${bot.id}:`, error);
      }
    }
    await this.processQueue();
  }

  /** Manual trigger (dream:runNow IPC): bypasses window and policy gates. */
  async runNow(metabotId: number, date?: string): Promise<{ metabotId: number; date: string }> {
    const targetDate = date?.trim() || formatBotWorkspaceDate(
      new Date(this.now().getFullYear(), this.now().getMonth(), this.now().getDate() - 1)
    );
    const key = dreamRunKey(metabotId, targetDate);
    if (!this.dreamingBots.has(metabotId)) {
      this.enqueue(metabotId, targetDate, { toFront: true });
    }
    const completion = this.runCompletions.get(key);
    if (!completion) {
      throw new Error(`Dream is already running for metabot ${metabotId}`);
    }
    void this.processQueue();
    await completion;
    return { metabotId, date: targetDate };
  }

  private enqueue(metabotId: number, date: string, options: { toFront?: boolean; isRepair?: boolean } = {}): boolean {
    if (this.dreamingBots.has(metabotId)) return false;
    const existingIndex = this.queue.findIndex((item) => item.metabotId === metabotId && item.date === date);
    if (existingIndex >= 0) {
      if (options.toFront && existingIndex > 0) {
        const [existing] = this.queue.splice(existingIndex, 1);
        this.queue.unshift(existing);
      }
      return false;
    }
    const item: DreamQueueItem = { metabotId, date, isRepair: options.isRepair ?? false };
    const key = dreamRunKey(metabotId, date);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    this.runCompletions.set(key, completion);
    this.runCompletionResolvers.set(key, resolveCompletion);
    if (options.toFront) {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }
    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.runDream(item.metabotId, item.date, item.isRepair);
        } finally {
          const key = dreamRunKey(item.metabotId, item.date);
          this.runCompletionResolvers.get(key)?.();
          this.runCompletionResolvers.delete(key);
          this.runCompletions.delete(key);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Resolve the brain rungs for this run, per call (NEVER cached — the 429
   * stale-binding post-mortem: validity is judged by THIS run's failures, and
   * no "failed before" memory may skip a rung). Boss's unified order:
   * ① global dreamLlmId override → ② the bot's own primary brain → ③ the
   * bot's fallback brain → ④ error (semantics: "no usable model configured",
   * not a raw 429).
   *
   * The override branch previously DROPPED the fallback pair and the provider
   * hint (2026-10-08 findings): an overridden dream had a single rung (one
   * dead model = a dead run), and a bare glm-* override id could resolve onto
   * the wrong provider's gateway. The override now carries an explicit
   * `dreamLlmProvider` hint (read live from cowork_config) and keeps the
   * bot's own pair as rungs ②+③.
   */
  private resolveDreamBrain(metabot: DreamMetabotLike): DreamBrainPair {
    const override = this.deps.dreamStore.getCoworkConfigValue('dreamLlmId')?.trim();
    const brain = metabotBrainOptions(metabot);
    if (override) {
      const overrideProvider = this.deps.dreamStore.getCoworkConfigValue('dreamLlmProvider')?.trim() || null;
      const botPrimaryDiffers = brain.llmId != null && brain.llmId !== override;
      return {
        llmId: override,
        llmProvider: overrideProvider,
        fallbackLlmId: brain.fallbackLlmId,
        fallbackLlmProvider: brain.fallbackLlmProvider,
        botPrimaryRung: botPrimaryDiffers ? { llmId: brain.llmId, llmProvider: brain.llmProvider } : null,
      };
    }
    return {
      llmId: brain.llmId,
      llmProvider: brain.llmProvider,
      fallbackLlmId: brain.fallbackLlmId,
      fallbackLlmProvider: brain.fallbackLlmProvider,
    };
  }

  private buildDreamImpressionSubjects(
    metabot: DreamMetabotLike,
    date: string,
  ) {
    if (!this.deps.metaidExperienceStore || !this.deps.metaidImpressionStore || !metabot.globalmetaid) return [];
    const { startMs, endMs } = getDayBoundsMs(date);
    return buildMetaIDDreamImpressionContext({
      experienceStore: this.deps.metaidExperienceStore,
      impressionStore: this.deps.metaidImpressionStore,
      observerGlobalMetaID: metabot.globalmetaid,
      fromTime: startMs,
      toTime: endMs,
    });
  }

  /**
   * Compact view of the bot's current knowledge points, handed to the dream
   * prompt so the model can decide create-vs-revise: reusing an existing topic
   * rewrites it (version bump), a fresh topic creates a new entry. Failure here
   * never blocks the dream run — the prompt simply proceeds without the list.
   */
  private buildExistingKnowledge(metabot: DreamMetabotLike): DreamKnowledgeExisting[] {
    if (!this.deps.metaidKnowledgeStore) return [];
    try {
      return this.deps.metaidKnowledgeStore.listKnowledgeForDream(metabot.id).map((entry) => ({
        topic: entry.topic,
        summary: entry.summary,
        kind: entry.kind,
        category: entry.category,
        version: entry.version,
      }));
    } catch (error) {
      console.warn(`[DreamService] Failed to load existing knowledge for metabot ${metabot.id}:`, error);
      return [];
    }
  }

  private emitDreaming(metabotId: number, dreaming: boolean): void {
    try {
      this.deps.emitToRenderer?.(DREAM_STATUS_CHANNEL, { metabotId, dreaming });
    } catch (error) {
      console.warn('[DreamService] Failed to emit dream status:', error);
    }
  }

  private async callDreamLlm(
    systemPrompt: string,
    userMessage: string,
    brain: DreamBrainPair,
    maxTokens?: number,
    attemptTimeoutMs?: number,
  ): Promise<string> {
    // In-run transient retry: a sub-minute transport/gateway flap (proxy TLS
    // jitter, a 502 burst, one stalled attempt window) must not fail the whole
    // run when both brains happen to catch it — re-drive the primary→fallback
    // pair a bounded number of times with fresh per-attempt timeouts. Terminal
    // errors (4xx, quota, auth) and parse failures are never retried here; the
    // run-level backoff still owns genuine outages. The 2026-09-28 nightly run
    // died at its 54th fragment on one net::ERR_SSL_PROTOCOL_ERROR that this
    // loop now absorbs.
    //
    // 2026-10-08 stale-binding ladder (Boss's unified resolution order):
    // ① dreamLlmId override (if set) → ② the bot's own primary brain →
    // ③ the bot's fallback brain → ④ terminal "no usable model configured"
    // error. Error-type dispatch: transient network failures NEVER degrade to
    // the next rung (they retry in place via the loop below); quota/config
    // failures degrade immediately to the next rung (a dead target will not
    // heal mid-run, so no in-rung retries). Degradation is per-call state
    // only — the next run re-resolves from rung ①, nothing is anchored.
    const delays = this.deps.transientRetryDelaysMs ?? DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS;
    const baseAttemptOptions = {
      // Each attempt (primary, then fallback) gets its own fresh timeout
      // window — a primary that burns the full budget must not leave the
      // fallback retry a dead shared signal. Callers emitting the full dream
      // JSON (synthesis, self-identity) pass the wider window; fragments and
      // post-dream passes keep the lean default.
      attemptTimeoutMs: attemptTimeoutMs ?? this.deps.llmTimeoutMs ?? DREAM_LLM_TIMEOUT_MS,
      maxTokens: maxTokens ?? this.resolveDreamBudgets(brain).maxOutputTokens,
      // DeepSeek automation models default to reasoning mode. Dream prompts
      // need the output budget for the final JSON, not hidden reasoning.
      thinking: 'disabled' as const,
      // Dream prompts summarize the bot's own day — a stray built-in
      // web search both wastes the fragment budget and drags outside
      // noise into the diary JSON.
      webSearch: false as const,
      // Empty content must fail inside runWithLlmFallback so a configured
      // secondary provider gets a chance before the dream attempt fails.
      throwOnEmptyContent: true as const,
    };
    const driveLadder = async (): Promise<string> => {
      const overrideRung = brain.botPrimaryRung?.llmId ? brain : null;
      if (overrideRung) {
        try {
          // Rung ①: the override alone — the bot's primary brain is the NEXT
          // rung, not an in-rung fallback.
          return await this.performChat(systemPrompt, userMessage, overrideRung.llmId, {
            ...baseAttemptOptions,
            llmProvider: overrideRung.llmProvider,
            fallbackLlmId: null,
            fallbackLlmProvider: null,
          });
        } catch (overrideError) {
          if (isTransientDreamLlmError(overrideError)) throw overrideError;
          const message = overrideError instanceof Error ? overrideError.message : String(overrideError);
          console.warn(
            `[DreamService] dreamLlmId override '${overrideRung.llmId}' failed (${message}); `
            + `degrading to the bot's own primary brain for this call.`,
          );
        }
      }
      // Rungs ②→③: the bot's own primary brain with its fallback pair —
      // performChat embeds the primary→fallback retry (runWithLlmFallback).
      const primaryLlmId = brain.botPrimaryRung?.llmId ?? brain.llmId;
      const primaryProvider = brain.botPrimaryRung ? brain.botPrimaryRung.llmProvider : brain.llmProvider;
      return await this.performChat(systemPrompt, userMessage, primaryLlmId, {
        ...baseAttemptOptions,
        llmProvider: primaryProvider,
        fallbackLlmId: brain.fallbackLlmId,
        fallbackLlmProvider: brain.fallbackLlmProvider,
      });
    };
    for (let round = 0; ; round += 1) {
      try {
        return await driveLadder();
      } catch (error) {
        if (round >= delays.length || !isTransientDreamLlmError(error)) {
          // Boss's rung ④: when every configured rung died on quota/config
          // errors, the failure semantics are "no usable model is configured"
          // — NOT a raw 429 (the 2026-10-08 avalanche read like a provider
          // blip when it was a stale binding). Quota/parse/empty-content
          // shapes keep their own meaning; only the all-rungs-dead quota/
          // config family gets the explicit prefix, original text preserved.
          if (isDreamLadderExhaustedQuotaError(error)) {
            const original = error instanceof Error ? error.message : String(error);
            throw new Error(`未配置任何可用的模型（dream 降级链 override→主脑→备用 全部无效）：${original}`);
          }
          throw error;
        }
        const delayMs = delays[round];
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[DreamService] transient LLM failure on round ${round + 1}/${delays.length + 1}; `
          + `re-driving primary→fallback in ${delayMs}ms:`,
          message,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private resolveDreamBudgets(brain: DreamBrainPair): {
    maxOutputTokens: number;
    fastPathInputTokens: number;
    fragmentInputTokens: number;
    fragmentOutputTokens: number;
  } {
    const effectiveModelId = resolveAutomationModelOverride(brain.llmId) ?? brain.llmId;
    const limits = resolveCurrentModelLimits(effectiveModelId);
    const maxOutputTokens = Math.max(1, Math.min(DREAM_LLM_TARGET_MAX_TOKENS, limits.maxOutputTokens));
    const usableInputTokens = Math.max(16_000, limits.contextWindow - maxOutputTokens - DREAM_CONTEXT_RESERVE_TOKENS);
    // Fragment output ceiling: reasoning shares the provider's output budget,
    // so the lean 4K ceiling is only safe when thinking can actually be turned
    // off (DeepSeek, GLM-4.x). GLM-5.x always thinks and unknown model families
    // may default to thinking — those get reasoning headroom, or the fragment
    // dies as stop_reason=max_tokens with empty content (the 2026-09-20
    // zhipu glm-5.3-flash outage). The fallback brain must be covered too: the
    // fallback attempt reuses this ceiling, and a mixed pair (deepseek primary
    // + glm-5 fallback) would otherwise hand the fallback a guaranteed
    // truncation. Ceilings only — billing is by actual tokens used.
    const fallbackModelId = resolveAutomationModelOverride(brain.fallbackLlmId) ?? brain.fallbackLlmId;
    const eitherBrainMayThink =
      budgetAssumesThinking(effectiveModelId, 'disabled')
      || budgetAssumesThinking(fallbackModelId, 'disabled');
    const fragmentCeiling = eitherBrainMayThink
      ? DREAM_FRAGMENT_MAX_TOKENS_THINKING
      : DREAM_FRAGMENT_MAX_TOKENS;
    return {
      maxOutputTokens,
      fastPathInputTokens: Math.min(DREAM_FAST_PATH_MAX_TOKENS, Math.floor(usableInputTokens * 0.5)),
      fragmentInputTokens: Math.min(DREAM_CHUNK_MAX_TOKENS, Math.floor(usableInputTokens * 0.35)),
      fragmentOutputTokens: Math.min(fragmentCeiling, maxOutputTokens),
    };
  }

  private async getOrCreateDreamFragment(
    metabot: DreamMetabotLike,
    date: string,
    chunk: DreamActivityChunk,
    brain: DreamBrainPair,
    fragmentOutputTokens: number,
  ): Promise<DreamFragmentSummary> {
    // Cache key mixes in the fragment prompt builder's own source so editing
    // the template invalidates stale summaries automatically — previously only
    // a manual DREAM_VERSION bump did that.
    const contentHash = createHash('sha256')
      .update(JSON.stringify(chunk))
      .update('\n--prompt--\n')
      .update(buildDreamFragmentPrompt.toString())
      .digest('hex');
    const existing = this.deps.dreamStore.getDreamFragment(metabot.id, date, chunk.fragmentKey);
    if (
      existing?.status === 'completed' &&
      existing.contentHash === contentHash &&
      existing.dreamVersion === DREAM_VERSION &&
      existing.llmId === brain.llmId &&
      existing.summaryJson
    ) {
      let cachedOutput: DreamOutput | null = null;
      try {
        const stored = JSON.parse(existing.summaryJson) as Partial<DreamOutput>;
        if (stored && typeof stored === 'object' && typeof stored.dailySummary === 'string') {
          cachedOutput = stored as DreamOutput;
        }
      } catch {
        // Older/manual rows may contain the provider's snake_case JSON shape.
      }
      if (!cachedOutput) {
        const cached = parseDreamOutput(existing.summaryJson);
        if (cached.ok) cachedOutput = cached.output;
      }
      if (cachedOutput) {
        return {
          fragmentKey: chunk.fragmentKey,
          sessionId: chunk.sessionId,
          title: chunk.title,
          chunkIndex: chunk.chunkIndex,
          output: cachedOutput,
        };
      }
    }

    this.deps.dreamStore.beginDreamFragment({
      metabotId: metabot.id,
      dreamDate: date,
      fragmentKey: chunk.fragmentKey,
      sessionId: chunk.sessionId,
      chunkIndex: chunk.chunkIndex,
      contentHash,
      sourceMessageCount: chunk.sourceMessageCount,
      sourceCharCount: chunk.sourceCharCount,
      estimatedInputTokens: chunk.estimatedInputTokens,
      llmId: brain.llmId,
      dreamVersion: DREAM_VERSION,
    });
    try {
      const prompt = buildDreamFragmentPrompt({
        botName: metabot.name,
        role: metabot.role,
        soul: metabot.soul,
        date,
        chunk,
      });
      const output = await this.generateAndParse(
        prompt.system,
        prompt.user,
        brain,
        fragmentOutputTokens,
      );
      this.deps.dreamStore.finishDreamFragment(
        metabot.id,
        date,
        chunk.fragmentKey,
        'completed',
        JSON.stringify(output),
        null,
      );
      return {
        fragmentKey: chunk.fragmentKey,
        sessionId: chunk.sessionId,
        title: chunk.title,
        chunkIndex: chunk.chunkIndex,
        output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.dreamStore.finishDreamFragment(
        metabot.id,
        date,
        chunk.fragmentKey,
        'failed',
        null,
        message,
      );
      throw error;
    }
  }

  /** Latest weekly long-dream review rendered as one prompt block; '' when none. */
  private buildWeeklyReviewText(metabotId: number): string {
    try {
      const weekly = this.deps.dreamStore.getLatestWeeklySummary(metabotId);
      if (!weekly) return '';
      const lines = [
        `${weekly.weekStart} ~ ${weekly.weekEnd}: ${weekly.summaryText}`,
        ...weekly.patterns.map((pattern) => `跨天模式: ${pattern}`),
      ];
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private async prepareDreamPromptAndOutput(
    metabot: DreamMetabotLike,
    date: string,
    activity: DreamDayActivity,
    brain: DreamBrainPair,
    impressionSubjects: ReturnType<DreamService['buildDreamImpressionSubjects']>,
    existingKnowledge: DreamKnowledgeExisting[],
    surfReport?: string | null,
  ): Promise<{
    prompt: { system: string; user: string };
    output: DreamOutput;
    meta: { estimatedInputTokens: number; fragmentCount: number };
  }> {
    const budgets = this.resolveDreamBudgets(brain);
    const estimatedTokens = estimateDreamActivityTokens(activity);
    // The weekly long-dream review rides every nightly dream as cross-day
    // context (P2b) — reference, not constraint.
    const weeklyReview = this.buildWeeklyReviewText(metabot.id);
    if (estimatedTokens <= budgets.fastPathInputTokens) {
      const prompt = buildDreamPrompt({
        botName: metabot.name,
        role: metabot.role,
        soul: metabot.soul,
        date,
        activity,
        activityTokenBudget: budgets.fastPathInputTokens,
        impressionSubjects,
        existingKnowledge,
        surfReport,
        weeklyReview,
      });
      const output = await this.generateAndParse(
        prompt.system,
        prompt.user,
        brain,
        budgets.maxOutputTokens,
        DREAM_SYNTHESIS_TIMEOUT_MS,
      );
      return { prompt, output, meta: { estimatedInputTokens: estimatedTokens, fragmentCount: 0 } };
    }

    const chunks = chunkDreamActivity(activity, budgets.fragmentInputTokens);
    if (chunks.length === 0) {
      const prompt = buildDreamPrompt({
        botName: metabot.name,
        role: metabot.role,
        soul: metabot.soul,
        date,
        activity,
        activityTokenBudget: budgets.fastPathInputTokens,
        impressionSubjects,
        existingKnowledge,
        surfReport,
        weeklyReview,
      });
      const output = await this.generateAndParse(
        prompt.system,
        prompt.user,
        brain,
        budgets.maxOutputTokens,
        DREAM_SYNTHESIS_TIMEOUT_MS,
      );
      return { prompt, output, meta: { estimatedInputTokens: estimatedTokens, fragmentCount: 0 } };
    }

    const summaries: DreamFragmentSummary[] = [];
    for (const chunk of chunks) {
      summaries.push(await this.getOrCreateDreamFragment(
        metabot,
        date,
        chunk,
        brain,
        budgets.fragmentOutputTokens,
      ));
    }

    const synthesisActivity = summariesToActivity(
      summaries,
      activity.taskRuns,
      activity.orderCount,
      activity.groupTasks,
      activity.chainWrites ?? [],
      activity.chainReads ?? [],
    );
    const prompt = buildDreamPrompt({
      botName: metabot.name,
      role: metabot.role,
      soul: metabot.soul,
      date,
      activity: synthesisActivity,
      activityTokenBudget: budgets.fastPathInputTokens,
      sourceMode: 'fragment_summaries',
      impressionSubjects,
      existingKnowledge,
      surfReport,
      weeklyReview,
    });
    const output = await this.generateAndParse(
      prompt.system,
      prompt.user,
      brain,
      budgets.maxOutputTokens,
      DREAM_SYNTHESIS_TIMEOUT_MS,
    );
    return { prompt, output, meta: { estimatedInputTokens: estimatedTokens, fragmentCount: chunks.length } };
  }

  private async runDream(metabotId: number, date: string, isRepair = false): Promise<void> {
    if (this.dreamingBots.has(metabotId)) return;
    const metabot = this.deps.metabotStore.listMetabots().find((bot) => bot.id === metabotId) ?? null;
    if (!metabot) {
      console.warn(`[DreamService] Skip dream for unknown metabot ${metabotId}`);
      return;
    }

    this.dreamingBots.add(metabotId);
    this.emitDreaming(metabotId, true);
    const runStartedAtMs = Date.now();
    const brain = this.resolveDreamBrain(metabot);
    const currentRun = this.deps.dreamStore.beginRun(metabotId, date, brain.llmId, DREAM_VERSION);
    try {
      // Pre-dream surf ("做梦前自动冲浪"): the bot browses MetaWeb first so
      // tonight's dream can fold what it learned into long-term memory. The
      // wiring owns enable/recency/timeout/failure isolation; a null or
      // throwing surf never blocks the dream.
      let surfReport: string | null = null;
      if (this.deps.surfBeforeDream) {
        try {
          const surf = await this.deps.surfBeforeDream(metabotId);
          surfReport = surf?.reportMarkdown?.trim() || null;
        } catch (error) {
          console.warn(
            `[DreamService] Pre-dream surf failed for metabot ${metabotId}; dreaming without it: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const { startMs, endMs } = getDayBoundsMs(date);
      const activity = this.deps.dreamStore.getActivityForDate(metabotId, startMs, endMs);
      // Mechanical implicit-signal collection: structural facts only, attached
      // before prompt building so the dream itself judges what they mean.
      activity.implicitSignals = extractImplicitSignals(activity);
      const impressionSubjects = this.buildDreamImpressionSubjects(metabot, date);
      const existingKnowledge = this.buildExistingKnowledge(metabot);
      if (
        activity.sessions.length === 0
        && activity.taskRuns.length === 0
        && activity.groupTasks.length === 0
        && (activity.groupChats?.length ?? 0) === 0
        && (activity.chainWrites?.length ?? 0) === 0
        && (activity.chainReads?.length ?? 0) === 0
        && impressionSubjects.length === 0
        && !surfReport
      ) {
        // Nothing happened that day — no LLM call, no summary, still recorded.
        this.deps.dreamStore.finishRun(metabotId, date, 'completed');
        // Pending capability drafts can still be validated against older
        // diaries even when today added no new activity.
        const validation = await this.validateCapabilityDraftsAfterDream(metabot, brain, date);
        const promotion = this.promoteCapabilityDraftsToProcedures(metabot, date);
        // Empty days have no negative decision points, so the replay no-ops.
        const replay = await this.runCounterfactualReplayAfterDream(metabot, brain, date, activity);
        const weeklyLongDream = await this.maybeRunWeeklyLongDream(metabot, brain, date);
        this.deps.dreamStore.updateRunTelemetry(metabotId, date, {
          emptyDay: true,
          estimatedActivityTokens: 0,
          implicitSignals: 0,
          validation,
          replay,
          weeklyLongDream,
          capabilityUtilization: this.buildCapabilityUtilizationTelemetry(metabotId),
          promotedCount: promotion.promoted,
          hasExplicitFeedback: hasExplicitHumanFeedback(activity),
          durationMs: Date.now() - runStartedAtMs,
        });
        return;
      }

      const prepared = await this.prepareDreamPromptAndOutput(
        metabot,
        date,
        activity,
        brain,
        impressionSubjects,
        existingKnowledge,
        surfReport,
      );
      let output = prepared.output;
      // Repair runs discard selfIdentity in writeDreamResults, so skip the
      // expansion retry instead of burning an extra LLM call on it.
      if (!isRepair) {
        output = await this.ensureSelfIdentity(
          output,
          prepared.prompt.system,
          prepared.prompt.user,
          brain,
          this.resolveDreamBudgets(brain).maxOutputTokens,
          DREAM_SYNTHESIS_TIMEOUT_MS,
        );
      }
      const writeResult = this.writeDreamResults(metabotId, date, output, activity, brain.llmId, isRepair, impressionSubjects, metabot.globalmetaid);
      this.deps.dreamStore.finishRun(metabotId, date, 'completed');
      console.log(`[DreamService] Dream completed for metabot ${metabotId} date ${date}${isRepair ? ' (version repair)' : ''}`);
      const validation = await this.validateCapabilityDraftsAfterDream(metabot, brain, date);
      // P1 periodic re-review runs between the fresh-draft gate and the
      // promotion pass: a just-demoted draft must not harden tonight.
      const reReview = await this.reReviewValidatedCapabilityDrafts(metabot, brain, date);
      const promotion = this.promoteCapabilityDraftsToProcedures(metabot, date);
      const replay = await this.runCounterfactualReplayAfterDream(metabot, brain, date, activity);
      const weeklyLongDream = await this.maybeRunWeeklyLongDream(metabot, brain, date);
      const diaryRefs = this.auditDiaryRefs(output.dailySummary, activity, surfReport);
      // P2a telemetry: the dream policy becomes tunable once it is measurable.
      this.deps.dreamStore.updateRunTelemetry(metabotId, date, {
        emptyDay: false,
        fastPath: prepared.meta.fragmentCount === 0,
        fragmentCount: prepared.meta.fragmentCount,
        estimatedActivityTokens: prepared.meta.estimatedInputTokens,
        outputChars: JSON.stringify(output).length,
        implicitSignals: activity.implicitSignals?.length ?? 0,
        diaryUnmatchedRefs: diaryRefs.unmatched,
        // Denominator for the diary-trust ratio (renderer trend panel). Runs
        // written before 2026-09-23 have no total recorded — their ratio is
        // genuinely not measurable and renders as a gap.
        diaryTotalRefs: diaryRefs.total,
        validation,
        replay,
        weeklyLongDream,
        capabilityUtilization: this.buildCapabilityUtilizationTelemetry(metabotId),
        promotedCount: promotion.promoted,
        // P1 periodic re-review (audit): how many validated drafts faced the
        // verdict panel again tonight and how many were demoted off the
        // injection roster (promoted procedures archived alongside).
        reReviewed: reReview.reReviewed,
        demoted: reReview.demoted,
        // Cross-night semantic dedup (audit P1): how many of tonight's memory
        // writes merged into an older row instead of inserting a variant.
        dedupMerged: writeResult.dedupMerged,
        // P1: any explicit human feedback today (thumbs up/down, acceptance
        // rating) — separates "zero negative because good" from "no data".
        hasExplicitFeedback: hasExplicitHumanFeedback(activity),
        durationMs: Date.now() - runStartedAtMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // H-80: deterministic provider rejections (HTTP 4xx passthrough, quota,
      // auth) can never succeed on retry, and a retryable failure must not
      // back off forever — both leave the auto-retry queue as terminal-failed;
      // only transient errors below the attempt cap stay in the backoff class.
      if (classifyDreamError(message) === 'terminal' || currentRun.attemptCount >= DREAM_RETRY_MAX_ATTEMPTS) {
        console.warn(
          `[DreamService] Dream terminally failed for metabot ${metabotId} date ${date} `
          + `(attempt ${currentRun.attemptCount}, no further auto-retry):`,
          message,
        );
        this.deps.dreamStore.finishRun(metabotId, date, 'terminal-failed', message);
      } else {
        console.warn(`[DreamService] Dream failed for metabot ${metabotId} date ${date}:`, message);
        this.deps.dreamStore.finishRun(metabotId, date, 'failed', message);
      }
    } finally {
      this.dreamingBots.delete(metabotId);
      this.emitDreaming(metabotId, false);
    }
  }

  /** First attempt + one retry when the output is not parseable JSON. */
  private async generateAndParse(
    system: string,
    user: string,
    brain: DreamBrainPair,
    maxTokens?: number,
    attemptTimeoutMs?: number,
  ): Promise<DreamOutput> {
    const firstRaw = await this.callDreamLlm(system, user, brain, maxTokens, attemptTimeoutMs);
    const first = parseDreamOutput(firstRaw);
    if (first.ok) return first.output;
    const firstError = (first as { ok: false; error: string }).error;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次输出无法解析:${firstError}。请严格只输出一个 JSON 对象,不要输出任何其他文字。)`,
      brain,
      maxTokens,
      attemptTimeoutMs,
    );
    const retry = parseDreamOutput(retryRaw);
    if (retry.ok) return retry.output;
    throw new Error(`dream output unparseable after retry: ${(retry as { ok: false; error: string }).error}`);
  }

  /** One retry when self_identity is missing or under the 200-char minimum. */
  private async ensureSelfIdentity(
    output: DreamOutput,
    system: string,
    user: string,
    brain: DreamBrainPair,
    maxTokens?: number,
    attemptTimeoutMs?: number,
  ): Promise<DreamOutput> {
    const validation = validateSelfIdentity(output.selfIdentity);
    if (validation.valid) return output;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次的 self_identity ${output.selfIdentity ? `只有 ${validation.charCount} 个非空白字符` : '缺失'}。请重新输出完整 JSON,其中 self_identity 不少于 200 个非空白字符,认真写一段「我是谁」。)`,
      brain,
      maxTokens,
      attemptTimeoutMs,
    );
    const retry = parseDreamOutput(retryRaw);
    if (retry.ok && validateSelfIdentity(retry.output.selfIdentity).valid) {
      return retry.output;
    }
    // Keep the original output rather than failing the whole run over length.
    console.warn('[DreamService] self_identity still below minimum after retry; keeping best effort output');
    return output.selfIdentity ? output : (retry.ok ? retry.output : output);
  }

  /**
   * Dream-RSI P2 utilization rollup for the run telemetry: validated draft
   * count, cumulative injections, and drafts injected within the last 24h —
   * the "are dream-distilled techniques actually being used" evidence. Null on
   * failure so telemetry writing never breaks the dream run.
   */
  private buildCapabilityUtilizationTelemetry(
    metabotId: number,
  ): { validatedDrafts: number; totalInjections: number; activeDraftsLast24h: number } | null {
    try {
      return this.deps.coworkStore.getCapabilityDraftUtilization(
        metabotId,
        Date.now() - 24 * 60 * 60 * 1000,
      );
    } catch (error) {
      console.warn(
        `[DreamService] Capability utilization telemetry unavailable for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Dream-RSI P0 replay gate: after a dream completes, validate pending
   * capability drafts against the bot's own recorded history (recent dream
   * diaries). One LLM call per run, only when drafts are pending; a 'validated'
   * verdict must also clear the score threshold, and a weak or unparseable
   * verdict leaves the draft untouched. Runs after finishRun and never
   * affects the dream run's recorded outcome.
   */
  private async validateCapabilityDraftsAfterDream(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
  ): Promise<{ checked: number; validated: number; rejected: number }> {
    const zero = { checked: 0, validated: 0, rejected: 0 };
    try {
      const pending = this.deps.coworkStore.listCapabilityDrafts(metabot.id, {
        status: 'draft',
        limit: CAPABILITY_VALIDATION_MAX_DRAFTS,
      });
      if (pending.length === 0) return zero;
      const recentSummaries = this.deps.dreamStore.listDailySummaries(
        metabot.id,
        CAPABILITY_VALIDATION_SUMMARY_DAYS,
      );
      const prompt = buildCapabilityValidationPrompt({
        botName: metabot.name,
        date,
        drafts: pending.map((draft) => ({
          id: draft.id,
          dreamDate: draft.dreamDate,
          title: draft.title,
          description: draft.description,
          capabilityType: draft.capabilityType,
        })),
        recentSummaries: recentSummaries.map((summary) => ({
          summaryDate: summary.summaryDate,
          summaryText: summary.summaryText,
        })),
      });
      const raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 4096);
      const parsed = parseCapabilityValidationOutput(raw, new Set(pending.map((draft) => draft.id)));
      if (!parsed.ok) {
        console.warn(`[DreamService] Capability validation parse failed for metabot ${metabot.id}: ${(parsed as { ok: false; error: string }).error}`);
        return { ...zero, checked: pending.length };
      }
      // Grounding gate: a verdict whose rationale cites a diary date that was
      // never provided as evidence is a hallucinated citation — drop it.
      const evidenceDates = new Set([date, ...recentSummaries.map((summary) => summary.summaryDate)]);
      const groundedVerdicts = parsed.verdicts.filter((verdict) => {
        const citedDates = verdict.rationale.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
        return citedDates.every((cited) => evidenceDates.has(cited));
      });
      const droppedUngrounded = parsed.verdicts.length - groundedVerdicts.length;
      if (droppedUngrounded > 0) {
        console.warn(
          `[DreamService] Dropped ${droppedUngrounded} capability verdict(s) citing unrecorded diary dates for metabot ${metabot.id}`,
        );
      }
      let validated = 0;
      let rejected = 0;
      for (const verdict of groundedVerdicts) {
        const promote = verdict.verdict === 'validated' && verdict.score >= CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE;
        const demote = verdict.verdict === 'rejected';
        if (!promote && !demote) continue;
        this.deps.coworkStore.updateCapabilityDraftValidation({
          id: verdict.id,
          metabotId: metabot.id,
          status: promote ? 'validated' : 'rejected',
          validationScore: verdict.score,
          validationNotes: verdict.rationale,
        });
        if (promote) validated += 1;
        else rejected += 1;
      }
      if (validated > 0 || rejected > 0) {
        console.log(
          `[DreamService] Capability validation for metabot ${metabot.id}: validated=${validated}, rejected=${rejected}, checked=${pending.length}`,
        );
      }
      return { checked: pending.length, validated, rejected };
    } catch (error) {
      console.warn(
        `[DreamService] Capability validation failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * Dream-RSI P1 periodic re-review: VALIDATED drafts whose last verdict-panel
   * contact is older than CAPABILITY_REVIEW_INTERVAL_DAYS face the SAME verdict
   * prompt and evidence pool as the fresh-draft gate (oldest contact first,
   * capped per night). A validated technique was previously a lifetime
   * appointment — now it must keep surviving the bot's recorded history.
   *   - verdict=rejected below the promotion line → status 'rejected'; when
   *     the draft had been promoted, its procedure is archived too, so the
   *     demotion closes the loop instead of leaving a hardened lesson behind.
   *   - every other outcome (validated / keep_draft / a rejected verdict too
   *     weak to demote) → last_reviewed_at refreshes, and a maintained
   *     validated verdict also takes the panel's fresh score.
   * Runs after the fresh-draft gate, BEFORE the promotion pass (a just-
   * demoted draft must not harden tonight), and never affects the dream run's
   * recorded outcome.
   */
  private async reReviewValidatedCapabilityDrafts(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
  ): Promise<{ reReviewed: number; demoted: number }> {
    const zero = { reReviewed: 0, demoted: 0 };
    try {
      const pending = this.deps.coworkStore.listReReviewableCapabilityDrafts(metabot.id, {
        olderThanMs: Date.now() - CAPABILITY_REVIEW_INTERVAL_DAYS * 86_400_000,
        limit: CAPABILITY_REVIEW_MAX_PER_NIGHT,
      });
      if (pending.length === 0) return zero;
      const recentSummaries = this.deps.dreamStore.listDailySummaries(
        metabot.id,
        CAPABILITY_VALIDATION_SUMMARY_DAYS,
      );
      const prompt = buildCapabilityValidationPrompt({
        botName: metabot.name,
        date,
        drafts: pending.map((draft) => ({
          id: draft.id,
          dreamDate: draft.dreamDate,
          title: draft.title,
          description: draft.description,
          capabilityType: draft.capabilityType,
        })),
        recentSummaries: recentSummaries.map((summary) => ({
          summaryDate: summary.summaryDate,
          summaryText: summary.summaryText,
        })),
      });
      const raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 4096);
      const parsed = parseCapabilityValidationOutput(raw, new Set(pending.map((draft) => draft.id)));
      if (!parsed.ok) {
        console.warn(`[DreamService] Capability re-review parse failed for metabot ${metabot.id}: ${(parsed as { ok: false; error: string }).error}`);
        return { ...zero, reReviewed: pending.length };
      }
      // Same grounding gate as the fresh-draft validation pass.
      const evidenceDates = new Set([date, ...recentSummaries.map((summary) => summary.summaryDate)]);
      const groundedVerdicts = parsed.verdicts.filter((verdict) => {
        const citedDates = verdict.rationale.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
        return citedDates.every((cited) => evidenceDates.has(cited));
      });
      const droppedUngrounded = parsed.verdicts.length - groundedVerdicts.length;
      if (droppedUngrounded > 0) {
        console.warn(
          `[DreamService] Dropped ${droppedUngrounded} capability re-review verdict(s) citing unrecorded diary dates for metabot ${metabot.id}`,
        );
      }
      const byId = new Map(pending.map((draft) => [draft.id, draft]));
      let demoted = 0;
      for (const verdict of groundedVerdicts) {
        const draft = byId.get(verdict.id);
        if (!draft) continue;
        const demote = verdict.verdict === 'rejected' && verdict.score < CAPABILITY_PROMOTION_MIN_SCORE;
        if (demote) {
          this.deps.coworkStore.updateCapabilityDraftValidation({
            id: verdict.id,
            metabotId: metabot.id,
            status: 'rejected',
            validationScore: verdict.score,
            validationNotes: verdict.rationale,
          });
          demoted += 1;
          // Loop closure: a demoted technique must not survive as hardened
          // procedure memory either. The procedure's title is the draft's
          // (the promotion pass writes it that way).
          if (draft.promotedProcedureId && this.deps.metaidKnowledgeStore) {
            try {
              this.deps.metaidKnowledgeStore.archiveProcedureByTitle(metabot.id, draft.title);
            } catch (error) {
              console.warn(
                `[DreamService] Archiving promoted procedure for demoted draft #${draft.id} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          continue;
        }
        // The row survives the panel: refresh the review bookkeeping (a
        // maintained validated verdict also takes the fresh score).
        this.deps.coworkStore.markCapabilityDraftReviewed({
          id: verdict.id,
          metabotId: metabot.id,
          validationScore: verdict.verdict === 'validated' ? verdict.score : null,
          validationNotes: verdict.rationale,
        });
      }
      console.log(
        `[DreamService] Capability re-review for metabot ${metabot.id}: reReviewed=${pending.length}, demoted=${demoted}`,
      );
      return { reReviewed: pending.length, demoted };
    } catch (error) {
      console.warn(
        `[DreamService] Capability re-review failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * Dream-RSI P2 promotion pass: top validated drafts harden into procedure
   * memory (metaid_knowledge_procedures) so a learned lesson has lasting
   * effect beyond the <proven_techniques> prompt hint. A draft qualifies only
   * when its verdict is at least one night old (validated_at earlier than the
   * dream date's day start — the pragmatic stand-in for the full P1 re-review
   * mechanism: calendar distance instead of a second validation panel), scores
   * >= CAPABILITY_PROMOTION_MIN_SCORE, and was never promoted; at most
   * CAPABILITY_PROMOTION_MAX_PER_NIGHT per night per bot. The procedure keeps
   * the draft's title as its own (upsert-by-fingerprint dedupes against
   * existing procedures), the trigger mirrors the title, and the actionable
   * description becomes the single ordered step; the draft rows back-link to
   * the procedure id for provenance (procedures have no generic sources
   * table). Runs synchronously after the validation gate and never affects
   * the dream run's outcome.
   */
  private promoteCapabilityDraftsToProcedures(
    metabot: DreamMetabotLike,
    date: string,
  ): { promoted: number } {
    const zero = { promoted: 0 };
    try {
      if (!this.deps.metaidKnowledgeStore) return zero;
      const { startMs } = getDayBoundsMs(date);
      const candidates = this.deps.coworkStore.listPromotableCapabilityDrafts(metabot.id, {
        minScore: CAPABILITY_PROMOTION_MIN_SCORE,
        validatedBeforeMs: startMs,
        limit: CAPABILITY_PROMOTION_MAX_PER_NIGHT,
      });
      let promoted = 0;
      for (const draft of candidates) {
        try {
          const result = this.deps.metaidKnowledgeStore.upsertProcedure({
            metabotId: metabot.id,
            title: draft.title,
            triggerText: draft.title,
            steps: [draft.description],
            tags: ['capability-draft', draft.capabilityType],
            origin: 'dream',
          });
          const marked = this.deps.coworkStore.markCapabilityDraftPromoted({
            id: draft.id,
            metabotId: metabot.id,
            procedureId: result.entry.id,
          });
          if (marked) promoted += 1;
        } catch (error) {
          // A single bad draft never aborts the rest of the batch.
          console.warn(
            `[DreamService] Capability draft #${draft.id} promotion failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (promoted > 0) {
        console.log(`[DreamService] Promoted ${promoted} capability draft(s) into procedure memory for metabot ${metabot.id}`);
      }
      return { promoted };
    } catch (error) {
      console.warn(
        `[DreamService] Capability promotion pass failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * Dream-RSI P1 counterfactual replay: replay the day's negative-outcome
   * decision points (thumbs-down replies, poorly rated task work), imagine
   * alternative actions, and score them against the recorded outcome. Only a
   * lesson whose best alternative clearly beats the recorded action is written
   * as a dream-origin value_boundary — simulation-validated, not post-hoc
   * narration. Runs after finishRun and never affects the run's outcome;
   * no negative points means no LLM call.
   */
  private async runCounterfactualReplayAfterDream(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
    activity: DreamDayActivity,
  ): Promise<{ points: number; lessons: number; pointsByKind: Record<string, number> }> {
    const zero = { points: 0, lessons: 0, pointsByKind: {} as Record<string, number> };
    try {
      const points = extractNegativeDecisionPoints(activity);
      if (points.length === 0) return { ...zero, pointsByKind: {} };
      const pointsByKind: Record<string, number> = {};
      for (const point of points) {
        pointsByKind[point.kind] = (pointsByKind[point.kind] ?? 0) + 1;
      }
      const prompt = buildCounterfactualReplayPrompt({
        botName: metabot.name,
        date,
        points,
      });
      const raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 4096);
      const parsed = parseCounterfactualReplayOutput(raw, new Set(points.map((point) => point.id)));
      if (!parsed.ok) {
        console.warn(`[DreamService] Counterfactual replay parse failed for metabot ${metabot.id}: ${(parsed as { ok: false; error: string }).error}`);
        return { points: points.length, lessons: 0, pointsByKind };
      }
      const seenLessons = new Set<string>();
      let written = 0;
      for (const result of parsed.results) {
        const lesson = pickCounterfactualLesson(result);
        if (!lesson || seenLessons.has(lesson)) continue;
        seenLessons.add(lesson);
        this.deps.coworkStore.createUserMemory({
          metabotId: metabot.id,
          text: `${lesson}(源自:反事实重放 ${date})`,
          scopeKind: 'owner',
          scopeKey: 'owner:self',
          usageClass: 'value_boundary',
          origin: 'dream',
          isExplicit: true,
          forceNew: true,
          source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
        });
        written += 1;
      }
      if (written > 0) {
        console.log(
          `[DreamService] Counterfactual replay for metabot ${metabot.id} date ${date}: points=${points.length}, lessons=${written}`,
        );
      }
      return { points: points.length, lessons: written, pointsByKind };
    } catch (error) {
      console.warn(
        `[DreamService] Counterfactual replay failed for metabot ${metabot.id} date ${date}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * P2b weekly "long dream": once per closed ISO week, replay the week's daily
   * diaries plus the week's run telemetry as one history pool and distill
   * cross-day patterns. Runs at most once per week (UNIQUE(metabot_id,
   * week_start) is the idempotency anchor), needs at least WEEKLY_DREAM_MIN_DAYS
   * diaries, and never affects the nightly run's outcome.
   */
  private async maybeRunWeeklyLongDream(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
  ): Promise<boolean> {
    try {
      const range = getPreviousIsoWeekRange(date);
      if (!range) return false;
      if (this.deps.dreamStore.getWeeklySummary(metabot.id, range.weekStart)) return false;
      const weekSummaries = this.deps.dreamStore
        .listDailySummaries(metabot.id, 14)
        .filter((summary) => summary.summaryDate >= range.weekStart && summary.summaryDate <= range.weekEnd);
      if (weekSummaries.length < WEEKLY_DREAM_MIN_DAYS) return false;

      const weekRuns = this.deps.dreamStore.listRunsInRange(metabot.id, range.weekStart, range.weekEnd);
      const numberField = (run: (typeof weekRuns)[number], key: string, sub: string): number => {
        const bag = run.telemetry?.[key];
        const value = bag && typeof bag === 'object' ? (bag as Record<string, unknown>)[sub] : undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const telemetry: WeeklyDreamTelemetryDigest = {
        completedRuns: weekRuns.filter((run) => run.status === 'completed').length,
        totalEstimatedActivityTokens: weekRuns.reduce(
          (sum, run) => sum + (Number(run.telemetry?.estimatedActivityTokens) || 0),
          0,
        ),
        draftsChecked: weekRuns.reduce((sum, run) => sum + numberField(run, 'validation', 'checked'), 0),
        draftsValidated: weekRuns.reduce((sum, run) => sum + numberField(run, 'validation', 'validated'), 0),
        draftsRejected: weekRuns.reduce((sum, run) => sum + numberField(run, 'validation', 'rejected'), 0),
        replayPoints: weekRuns.reduce((sum, run) => sum + numberField(run, 'replay', 'points'), 0),
        replayLessons: weekRuns.reduce((sum, run) => sum + numberField(run, 'replay', 'lessons'), 0),
      };
      const pendingDrafts = this.deps.coworkStore
        .listCapabilityDrafts(metabot.id, { status: 'draft', limit: 10 })
        .map((draft) => ({ title: draft.title, dreamDate: draft.dreamDate }));

      const prompt = buildWeeklyDreamPrompt({
        botName: metabot.name,
        weekStart: range.weekStart,
        weekEnd: range.weekEnd,
        summaries: weekSummaries.map((summary) => ({
          summaryDate: summary.summaryDate,
          summaryText: summary.summaryText,
        })),
        telemetry,
        pendingDrafts,
      });
      const raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 4096);
      const parsed = parseWeeklyDreamOutput(raw);
      if (!parsed.ok) {
        console.warn(`[DreamService] Weekly long dream parse failed for metabot ${metabot.id}: ${(parsed as { ok: false; error: string }).error}`);
        return false;
      }
      this.deps.dreamStore.upsertWeeklySummary({
        metabotId: metabot.id,
        weekStart: range.weekStart,
        weekEnd: range.weekEnd,
        summaryText: parsed.summary,
        patterns: parsed.focusForNextWeek
          ? [...parsed.patterns, `下周焦点: ${parsed.focusForNextWeek}`]
          : parsed.patterns,
        llmId: brain.llmId,
      });
      console.log(
        `[DreamService] Weekly long dream for metabot ${metabot.id}: week ${range.weekStart}~${range.weekEnd}, days=${weekSummaries.length}, patterns=${parsed.patterns.length}`,
      );
      return true;
    } catch (error) {
      console.warn(
        `[DreamService] Weekly long dream failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Grounding telemetry (F2): audit 「」-quoted spans in the diary against the
   * day's records. A span is GROUNDED when it matches either
   *  (a) a real record TITLE — session titles, peer names, group task / chat
   *      titles, chain-read titles — fuzzily (containment either way), or
   *  (b) the day's RAW RECORD TEXT — session message bodies, group-chat
   *      messages, chain-write content, chain-read excerpts/summaries, group
   *      task goals, and the pre-dream surf report — via the anchor rules in
   *      {@link diarySpanAnchoredInText}.
   * Before 2026-09-23 only (a) with four title kinds counted as matched, so
   * every quoted dialogue catchphrase, chain-read concept and surf phrase was
   * scored as a hallucination — the twin bot's rising "日记幻觉引用" trend was
   * almost entirely that false positive (spot audit of 2026-09-20/21: 9 of 15
   * "unmatched" spans were verbatim record text). Telemetry-only — a proxy for
   * hallucinated references, never a gate.
   */
  private auditDiaryRefs(
    summaryText: string,
    activity: DreamDayActivity,
    surfReport?: string | null,
  ): { total: number; unmatched: number } {
    const knownNames = new Set<string>();
    const rawChunks: string[] = [];
    for (const session of activity.sessions) {
      if (session.title.trim()) knownNames.add(session.title.trim());
      if (session.peerName?.trim()) knownNames.add(session.peerName.trim());
      for (const message of session.messages) {
        if (message.content) rawChunks.push(message.content);
      }
    }
    for (const task of activity.groupTasks ?? []) {
      if (task.title.trim()) knownNames.add(task.title.trim());
      if (task.goal?.trim()) rawChunks.push(task.goal.trim());
    }
    for (const chat of activity.groupChats ?? []) {
      if (chat.title.trim()) knownNames.add(chat.title.trim());
      for (const message of chat.messages) {
        if (message.content) rawChunks.push(message.content);
      }
    }
    for (const write of activity.chainWrites ?? []) {
      const text = (write.contentText || write.summary || '').trim();
      if (text) rawChunks.push(text);
    }
    for (const read of activity.chainReads ?? []) {
      if (read.title?.trim()) knownNames.add(read.title.trim());
      const text = (read.contentExcerpt || read.summary || '').trim();
      if (text) rawChunks.push(text);
    }
    if (surfReport?.trim()) rawChunks.push(surfReport.trim());
    const rawText = rawChunks.join('\n');

    let total = 0;
    let unmatched = 0;
    for (const match of summaryText.matchAll(/「([^」]{2,40})」/g)) {
      const span = (match[1] ?? '').trim();
      if (!span) continue;
      total += 1;
      const known = [...knownNames].some((name) => span === name || span.includes(name) || name.includes(span));
      if (!known && !diarySpanAnchoredInText(span, rawText)) unmatched += 1;
    }
    return { total, unmatched };
  }

  private writeDreamResults(
    metabotId: number,
    date: string,
    output: DreamOutput,
    activity: DreamDayActivity,
    llmId: string | null,
    isRepair: boolean,
    impressionSubjects: ReturnType<DreamService['buildDreamImpressionSubjects']>,
    observerGlobalMetaID?: string | null,
  ): { dedupMerged: number } {
    this.deps.dreamStore.upsertDailySummary({
      metabotId,
      summaryDate: date,
      summaryText: output.dailySummary,
      sections: output.sections,
      stats: {
        sessionCount: activity.sessions.length,
        orderSessionCount: activity.sessions.filter((session) => session.isOrder).length,
        orderCount: activity.orderCount,
        taskRunCount: activity.taskRuns.length,
        groupTaskEvaluationCount: activity.groupTasks.filter((task) => task.phase !== 'active').length,
        groupTaskActiveCount: activity.groupTasks.filter((task) => task.phase === 'active').length,
        groupChatCount: activity.groupChats?.length ?? 0,
        groupChatMessageCount: (activity.groupChats ?? []).reduce((sum, chat) => sum + chat.messages.length, 0),
        chainWriteCount: activity.chainWrites?.length ?? 0,
        chainReadCount: activity.chainReads?.length ?? 0,
        messageCount: activity.sessions.reduce((sum, session) => sum + session.messages.length, 0),
        activityCharCount: activity.sessions.reduce(
          (sum, session) => sum + session.messages.reduce((sessionSum, message) => sessionSum + message.content.length, 0),
          0,
        ),
        estimatedActivityTokens: estimateDreamActivityTokens(activity),
      },
      sessionRefs: activity.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        sessionType: session.sessionType,
        isOrder: session.isOrder,
      })),
      llmId,
    });

    // Idempotent per-date batch: replace the day's dream memories wholesale so
    // retries and version repairs never pile duplicates into the store.
    const removed = this.deps.coworkStore.softDeleteDreamMemoriesForDate(metabotId, date);
    if (removed > 0) {
      console.log(`[DreamService] Replaced ${removed} existing dream memories for metabot ${metabotId} date ${date}`);
    }

    // Cross-night dedup counter (audit P1): writes that landed on an older
    // semantically-equivalent row refresh it instead of inserting a variant.
    // Surfaces in the run telemetry as dedupMerged.
    let dedupMerged = 0;

    for (const text of new Set(output.importantMemories)) {
      const write = this.deps.coworkStore.createDreamUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'profile_fact',
        origin: 'dream',
        isExplicit: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
      if (write.merged) dedupMerged += 1;
    }

    const seenLessons = new Set<string>();
    let unsourcedLessons = 0;
    for (const lesson of output.valueLessons) {
      // P1b evidence gate: a value lesson must cite the concrete evidence it
      // was distilled from. Unsourced rules are post-hoc rationalization risk
      // and are dropped instead of entering the code-of-conduct hot layer.
      const source = lesson.source?.trim();
      if (!source) {
        unsourcedLessons += 1;
        continue;
      }
      const text = `${lesson.rule}(源自:${source})`;
      if (seenLessons.has(text)) continue;
      seenLessons.add(text);
      const write = this.deps.coworkStore.createDreamUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'value_boundary',
        origin: 'dream',
        isExplicit: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
      if (write.merged) dedupMerged += 1;
    }
    if (unsourcedLessons > 0) {
      console.warn(
        `[DreamService] Dropped ${unsourcedLessons} unsourced value lesson(s) for metabot ${metabotId} date ${date} (evidence gate)`,
      );
    }

    const seenReviews = new Set<string>();
    for (const review of output.workReviews) {
      const text = [
        `工作:${review.subject}`,
        `对象:${review.counterparty || '未知'}`,
        `评价:${EVALUATION_LABELS[review.evaluation] ?? EVALUATION_LABELS.stable}`,
        review.note ? `依据:${review.note}` : '',
      ].filter(Boolean).join(';');
      if (seenReviews.has(text)) continue;
      seenReviews.add(text);
      const write = this.deps.coworkStore.createDreamUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'work_review',
        origin: 'dream',
        isExplicit: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
      if (write.merged) dedupMerged += 1;
    }

    // Self-identity only moves forward in time: version repairs never touch
    // it, and a normal run for a date older than the identity's current
    // source date must not regress it either.
    if (output.selfIdentity && !isRepair) {
      const latestIdentityDate = this.deps.coworkStore.getDreamIdentityLatestDate(metabotId);
      if (latestIdentityDate && date < latestIdentityDate) {
        console.log(`[DreamService] Skip self-identity update for metabot ${metabotId}: date ${date} older than current source ${latestIdentityDate}`);
      } else {
        const existing = this.deps.coworkStore.listUserMemories({
          metabotId,
          scopeKind: 'owner',
          scopeKey: 'owner:self',
          usageClass: 'self_identity',
          status: 'all',
          limit: 1,
        })[0];
        if (existing) {
          this.deps.coworkStore.updateUserMemory({
            id: existing.id,
            metabotId,
            text: output.selfIdentity,
            usageClass: 'self_identity',
            allowProtected: true,
            source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
          });
        } else {
          this.deps.coworkStore.createUserMemory({
            metabotId,
            text: output.selfIdentity,
            scopeKind: 'owner',
            scopeKey: 'owner:self',
            usageClass: 'self_identity',
            origin: 'dream',
            isExplicit: true,
            confidence: 0.9,
            forceNew: true,
            source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
          });
        }
      }
    }

    const impressionUpdates = Array.isArray(output.impressionUpdates) ? output.impressionUpdates : [];
    if (this.deps.metaidImpressionStore && observerGlobalMetaID && impressionUpdates.length > 0) {
      try {
        const result = applyMetaIDDreamImpressionUpdates({
          impressionStore: this.deps.metaidImpressionStore,
          observerGlobalMetaID,
          dreamDate: date,
          dreamVersion: DREAM_VERSION,
          modelId: llmId,
          subjects: impressionSubjects,
          updates: impressionUpdates,
        });
        if (result.accepted > 0 || result.rejected > 0) {
          console.log(
            `[DreamService] Impression updates for metabot ${metabotId}: accepted=${result.accepted}, created=${result.created}, rejected=${result.rejected}, rebuilt=${result.rebuilt}`,
          );
        }
      } catch (error) {
        // Impression consolidation must never fail the dream run. The prior
        // snapshot stays intact and the bounded diagnostic excludes private
        // content and raw LLM output.
        console.warn(
          `[DreamService] MetaID impression consolidation failed for metabot ${metabotId} date ${date}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const knowledgeUpdates = Array.isArray(output.knowledgeUpdates) ? output.knowledgeUpdates : [];
    if (this.deps.metaidKnowledgeStore && knowledgeUpdates.length > 0) {
      let created = 0;
      let revised = 0;
      for (const update of knowledgeUpdates) {
        try {
          const result = this.deps.metaidKnowledgeStore.upsertKnowledge({
            metabotId,
            topic: update.topic,
            summary: update.summary,
            kind: update.kind,
            category: update.category ?? null,
            origin: 'dream',
            sourceDreamDate: date,
            sources: [
              ...(update.episodeIds ?? []).map((episodeId) => ({ episodeId, sourceChannel: 'experience' })),
              ...(update.evidenceIds ?? []).map((evidenceId) => ({ evidenceId, sourceChannel: 'experience' })),
            ],
          });
          if (result.created) created += 1;
          if (result.revised) revised += 1;
        } catch (error) {
          // A single bad entry never aborts the rest of the batch.
          console.warn(
            `[DreamService] Knowledge upsert failed for metabot ${metabotId} date ${date} topic "${update.topic}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (created > 0 || revised > 0) {
        console.log(
          `[DreamService] Knowledge updates for metabot ${metabotId}: created=${created}, revised=${revised}`,
        );
      }
    }

    // L3b procedural-memory channel (SDD R4.2/R4.3): each capability learning
    // the model distilled today becomes a 'draft' row in capability_drafts.
    // This never touches the existing skill tables — validation/promotion into
    // real skills is a later phase. A failure here must not fail the dream run.
    const capabilityLearnings = Array.isArray(output.capabilityLearnings) ? output.capabilityLearnings : [];
    if (capabilityLearnings.length > 0) {
      try {
        const inserted = this.deps.coworkStore.insertCapabilityDrafts(
          metabotId,
          date,
          capabilityLearnings,
        );
        if (inserted > 0) {
          console.log(
            `[DreamService] Capability drafts for metabot ${metabotId} date ${date}: inserted=${inserted}`,
          );
        }
      } catch (error) {
        console.warn(
          `[DreamService] Capability draft persistence failed for metabot ${metabotId} date ${date}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { dedupMerged };
  }
}

let dreamServiceInstance: DreamService | null = null;

export function startDreamService(deps: DreamServiceDeps): DreamService {
  stopDreamService();
  dreamServiceInstance = new DreamService(deps);
  dreamServiceInstance.start();
  return dreamServiceInstance;
}

export function stopDreamService(): void {
  dreamServiceInstance?.stop();
  dreamServiceInstance = null;
}

export function getDreamService(): DreamService | null {
  return dreamServiceInstance;
}
