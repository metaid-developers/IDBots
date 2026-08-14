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
  chunkDreamActivity,
  estimateDreamActivityTokens,
  summariesToActivity,
  type DreamActivityChunk,
  type DreamFragmentSummary,
} from '../libs/dreamFragments';
import { formatBotWorkspaceDate } from '../libs/botWorkspace';
import { resolveAutomationModelOverride, resolveCurrentModelLimits } from '../libs/claudeSettings';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';
import { normalizeMetabotLlmId } from './llmFallback';
import {
  applyMetaIDDreamImpressionUpdates,
  buildMetaIDDreamImpressionContext,
} from './metaidDreamImpressionService';

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
// The requested ceiling is clamped to the selected model's declared limit
// (DeepSeek V4 declares 32K, unknown models stay at 8192). The dream JSON is
// far smaller in practice; the headroom only matters so a long day is never
// truncated mid-JSON, and it costs nothing on short days.
const DREAM_LLM_TARGET_MAX_TOKENS = 32_768;
const DREAM_FRAGMENT_MAX_TOKENS = 4_096;
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
  fallback_llm_id?: string | null;
  globalmetaid?: string | null;
  enabled?: boolean;
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
    throwOnEmptyContent?: boolean;
    thinking?: 'enabled' | 'disabled';
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
  tickIntervalMs?: number;
  llmTimeoutMs?: number;
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

  /** Global override via cowork_config.dreamLlmId → the bot's own llm_id → app default (null). */
  private resolveDreamLlmId(metabot: DreamMetabotLike): string | null {
    const override = this.deps.dreamStore.getCoworkConfigValue('dreamLlmId');
    if (override?.trim()) return override.trim();
    const own = typeof metabot.llm_id === 'string' ? metabot.llm_id.trim() : '';
    return own || null;
  }

  /** The bot's fallback llm_id; skipped when the global dreamLlmId override is in effect. */
  private resolveDreamFallbackLlmId(metabot: DreamMetabotLike): string | null {
    const override = this.deps.dreamStore.getCoworkConfigValue('dreamLlmId');
    if (override?.trim()) return null;
    return normalizeMetabotLlmId(metabot.fallback_llm_id);
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
    llmId: string | null,
    fallbackLlmId: string | null = null,
    maxTokens?: number,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deps.llmTimeoutMs ?? DREAM_LLM_TIMEOUT_MS);
    try {
      return await this.performChat(systemPrompt, userMessage, llmId, {
        signal: controller.signal,
        maxTokens: maxTokens ?? this.resolveDreamBudgets(llmId).maxOutputTokens,
        fallbackLlmId,
        // DeepSeek automation models default to reasoning mode. Dream prompts
        // need the output budget for the final JSON, not hidden reasoning.
        thinking: 'disabled',
        // Empty content must fail inside runWithLlmFallback so a configured
        // secondary provider gets a chance before the dream attempt fails.
        throwOnEmptyContent: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveDreamBudgets(llmId: string | null): {
    maxOutputTokens: number;
    fastPathInputTokens: number;
    fragmentInputTokens: number;
    fragmentOutputTokens: number;
  } {
    const effectiveModelId = resolveAutomationModelOverride(llmId) ?? llmId;
    const limits = resolveCurrentModelLimits(effectiveModelId);
    const maxOutputTokens = Math.max(1, Math.min(DREAM_LLM_TARGET_MAX_TOKENS, limits.maxOutputTokens));
    const usableInputTokens = Math.max(16_000, limits.contextWindow - maxOutputTokens - DREAM_CONTEXT_RESERVE_TOKENS);
    return {
      maxOutputTokens,
      fastPathInputTokens: Math.min(DREAM_FAST_PATH_MAX_TOKENS, Math.floor(usableInputTokens * 0.5)),
      fragmentInputTokens: Math.min(DREAM_CHUNK_MAX_TOKENS, Math.floor(usableInputTokens * 0.35)),
      fragmentOutputTokens: Math.min(DREAM_FRAGMENT_MAX_TOKENS, maxOutputTokens),
    };
  }

  private async getOrCreateDreamFragment(
    metabot: DreamMetabotLike,
    date: string,
    chunk: DreamActivityChunk,
    llmId: string | null,
    fallbackLlmId: string | null,
    fragmentOutputTokens: number,
  ): Promise<DreamFragmentSummary> {
    const contentHash = createHash('sha256')
      .update(JSON.stringify(chunk))
      .digest('hex');
    const existing = this.deps.dreamStore.getDreamFragment(metabot.id, date, chunk.fragmentKey);
    if (
      existing?.status === 'completed' &&
      existing.contentHash === contentHash &&
      existing.dreamVersion === DREAM_VERSION &&
      existing.llmId === llmId &&
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
      llmId,
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
        llmId,
        fallbackLlmId,
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

  private async prepareDreamPromptAndOutput(
    metabot: DreamMetabotLike,
    date: string,
    activity: DreamDayActivity,
    llmId: string | null,
    fallbackLlmId: string | null,
    impressionSubjects: ReturnType<DreamService['buildDreamImpressionSubjects']>,
    existingKnowledge: DreamKnowledgeExisting[],
  ): Promise<{ prompt: { system: string; user: string }; output: DreamOutput }> {
    const budgets = this.resolveDreamBudgets(llmId);
    const estimatedTokens = estimateDreamActivityTokens(activity);
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
      });
      const output = await this.generateAndParse(
        prompt.system,
        prompt.user,
        llmId,
        fallbackLlmId,
        budgets.maxOutputTokens,
      );
      return { prompt, output };
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
      });
      const output = await this.generateAndParse(prompt.system, prompt.user, llmId, fallbackLlmId, budgets.maxOutputTokens);
      return { prompt, output };
    }

    const summaries: DreamFragmentSummary[] = [];
    for (const chunk of chunks) {
      summaries.push(await this.getOrCreateDreamFragment(
        metabot,
        date,
        chunk,
        llmId,
        fallbackLlmId,
        budgets.fragmentOutputTokens,
      ));
    }

    const synthesisActivity = summariesToActivity(summaries, activity.taskRuns, activity.orderCount, activity.groupTasks);
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
    });
    const output = await this.generateAndParse(
      prompt.system,
      prompt.user,
      llmId,
      fallbackLlmId,
      budgets.maxOutputTokens,
    );
    return { prompt, output };
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
    const llmId = this.resolveDreamLlmId(metabot);
    const fallbackLlmId = this.resolveDreamFallbackLlmId(metabot);
    this.deps.dreamStore.beginRun(metabotId, date, llmId, DREAM_VERSION);
    try {
      const { startMs, endMs } = getDayBoundsMs(date);
      const activity = this.deps.dreamStore.getActivityForDate(metabotId, startMs, endMs);
      const impressionSubjects = this.buildDreamImpressionSubjects(metabot, date);
      const existingKnowledge = this.buildExistingKnowledge(metabot);
      if (
        activity.sessions.length === 0
        && activity.taskRuns.length === 0
        && activity.groupTasks.length === 0
        && (activity.groupChats?.length ?? 0) === 0
        && impressionSubjects.length === 0
      ) {
        // Nothing happened that day — no LLM call, no summary, still recorded.
        this.deps.dreamStore.finishRun(metabotId, date, 'completed');
        return;
      }

      const prepared = await this.prepareDreamPromptAndOutput(
        metabot,
        date,
        activity,
        llmId,
        fallbackLlmId,
        impressionSubjects,
        existingKnowledge,
      );
      let output = prepared.output;
      // Repair runs discard selfIdentity in writeDreamResults, so skip the
      // expansion retry instead of burning an extra LLM call on it.
      if (!isRepair) {
        output = await this.ensureSelfIdentity(
          output,
          prepared.prompt.system,
          prepared.prompt.user,
          llmId,
          fallbackLlmId,
          this.resolveDreamBudgets(llmId).maxOutputTokens,
        );
      }
      this.writeDreamResults(metabotId, date, output, activity, llmId, isRepair, impressionSubjects, metabot.globalmetaid);
      this.deps.dreamStore.finishRun(metabotId, date, 'completed');
      console.log(`[DreamService] Dream completed for metabot ${metabotId} date ${date}${isRepair ? ' (version repair)' : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DreamService] Dream failed for metabot ${metabotId} date ${date}:`, message);
      this.deps.dreamStore.finishRun(metabotId, date, 'failed', message);
    } finally {
      this.dreamingBots.delete(metabotId);
      this.emitDreaming(metabotId, false);
    }
  }

  /** First attempt + one retry when the output is not parseable JSON. */
  private async generateAndParse(
    system: string,
    user: string,
    llmId: string | null,
    fallbackLlmId: string | null = null,
    maxTokens?: number,
  ): Promise<DreamOutput> {
    const firstRaw = await this.callDreamLlm(system, user, llmId, fallbackLlmId, maxTokens);
    const first = parseDreamOutput(firstRaw);
    if (first.ok) return first.output;
    const firstError = (first as { ok: false; error: string }).error;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次输出无法解析:${firstError}。请严格只输出一个 JSON 对象,不要输出任何其他文字。)`,
      llmId,
      fallbackLlmId,
      maxTokens,
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
    llmId: string | null,
    fallbackLlmId: string | null = null,
    maxTokens?: number,
  ): Promise<DreamOutput> {
    const validation = validateSelfIdentity(output.selfIdentity);
    if (validation.valid) return output;

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次的 self_identity ${output.selfIdentity ? `只有 ${validation.charCount} 个非空白字符` : '缺失'}。请重新输出完整 JSON,其中 self_identity 不少于 200 个非空白字符,认真写一段「我是谁」。)`,
      llmId,
      fallbackLlmId,
      maxTokens,
    );
    const retry = parseDreamOutput(retryRaw);
    if (retry.ok && validateSelfIdentity(retry.output.selfIdentity).valid) {
      return retry.output;
    }
    // Keep the original output rather than failing the whole run over length.
    console.warn('[DreamService] self_identity still below minimum after retry; keeping best effort output');
    return output.selfIdentity ? output : (retry.ok ? retry.output : output);
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
  ): void {
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

    for (const text of new Set(output.importantMemories)) {
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'profile_fact',
        origin: 'dream',
        isExplicit: true,
        forceNew: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
    }

    const seenLessons = new Set<string>();
    for (const lesson of output.valueLessons) {
      const text = lesson.source ? `${lesson.rule}(源自:${lesson.source})` : lesson.rule;
      if (seenLessons.has(text)) continue;
      seenLessons.add(text);
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'value_boundary',
        origin: 'dream',
        isExplicit: true,
        forceNew: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
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
      this.deps.coworkStore.createUserMemory({
        metabotId,
        text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'work_review',
        origin: 'dream',
        isExplicit: true,
        forceNew: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
      });
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
