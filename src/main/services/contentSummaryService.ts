import type {
  ChainContentHistoryStore,
  MetabotChainReadRecord,
  MetabotChainWriteRecord,
} from '../chainContentHistoryStore';
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';

/**
 * Content summary service ("链上内容异步摘要") — the background drain behind
 * the chain content history ledger's `summary_status = 'pending'` rows.
 *
 * Long text payloads (published pins from metabot_chain_writes, read excerpts
 * from metabot_chain_reads) get a 2-4 sentence LLM gist so the dream pipeline
 * and future UI can consume a compact memory instead of the full text. Short
 * content never lands here (the store marks it 'skipped' at write time).
 *
 * The summarizer LLM is abstracted behind the SummarizerProvider interface:
 * the default OrchestratorSummarizerProvider routes through the same
 * orchestrator chat-completion helper the dream pipeline uses, but a future
 * IDBots small-parameter or locally-embedded model only needs a new provider
 * implementation — the scheduler and the store bookkeeping stay untouched.
 *
 * Scheduling follows the MetawebStudyService startSchedule/runTick pattern
 * with cost gates on top: a global on/off switch, a per-tick item budget, and
 * a per-bot daily summary cap so a backlog can never stampede the LLM.
 */

const TICK_MS = 30 * 60 * 1000;
/** Total summaries (writes + reads combined) attempted per tick. */
export const CONTENT_SUMMARY_MAX_PER_TICK = 10;
/** Default per-bot daily summary budget (both kinds combined). */
export const CONTENT_SUMMARY_DEFAULT_DAILY_CAP = 40;
/** Summaries are short; 60s is generous even for a slow provider. */
const SUMMARY_LLM_TIMEOUT_MS = 60_000;
const SUMMARY_MAX_TOKENS = 512;
/** Stored summaries are capped so a chatty model cannot bloat the ledger. */
const SUMMARY_MAX_CHARS = 500;

export interface SummarizerInput {
  kind: 'write' | 'read';
  metabotId: number;
  /** Read records carry the pin title; write records pass null. */
  title: string | null;
  path: string | null;
  /** Truncated stored text: contentText for writes, contentExcerpt for reads. */
  content: string;
}

/**
 * The swappable summarizer seam. Implementations must resolve with the plain
 * summary text (no prefixes); throwing marks the row's attempt as failed.
 */
export interface SummarizerProvider {
  summarize(input: SummarizerInput): Promise<string>;
}

/**
 * Same injection seam as dreamService's DreamPerformChat: main.ts passes
 * performChatCompletionForOrchestrator, tests pass a mock. The provider never
 * imports the concrete completion helper directly.
 */
export type SummaryPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    fallbackLlmId?: string | null;
    /** Provider key the primary/fallback brain model was picked from. */
    llmProvider?: string | null;
    fallbackLlmProvider?: string | null;
    /** Per-attempt timeout: primary and fallback each get a fresh window. */
    attemptTimeoutMs?: number;
    attemptTimeoutKind?: 'total' | 'idle';
    throwOnEmptyContent?: boolean;
    thinking?: 'enabled' | 'disabled';
    webSearch?: boolean;
  }
) => Promise<string>;

/** The bot's brain pair (model ids + provider hints) for summary calls. */
export interface SummaryBrainPair {
  llmId: string | null;
  llmProvider: string | null;
  fallbackLlmId: string | null;
  fallbackLlmProvider: string | null;
}

/**
 * The bot's brain pair for summary calls; null when the bot row is gone.
 * main.ts implements this over MetabotStore.getMetabotById.
 */
export type ResolveBotLlm = (
  metabotId: number,
) => SummaryBrainPair | null;

export interface OrchestratorSummarizerProviderDeps {
  performChat: SummaryPerformChat;
  /** cowork_config lookup (main.ts: dreamStore.getCoworkConfigValue). */
  getConfigValue: (key: string) => string | null;
  resolveBotLlm: ResolveBotLlm;
  llmTimeoutMs?: number;
}

function buildSummaryPrompt(input: SummarizerInput): { system: string; user: string } {
  const system = [
    'You write compact memory notes for a MetaBot about its own on-chain activity.',
    'Summarize the central idea in 2-4 sentences, in the SAME language as the content.',
    'Output only the summary text: no commentary, no evaluation, no prefix like "Summary:".',
  ].join('\n');
  const context = [
    input.title ? `title: ${input.title}` : null,
    input.path ? `path: ${input.path}` : null,
  ].filter(Boolean).join(', ');
  const lead = input.kind === 'write'
    ? `You published the following content on-chain${context ? ` (${context})` : ''}:`
    : `You read the following on-chain content${context ? ` (${context})` : ''}:`;
  const closing = input.kind === 'write'
    ? 'Summarize what you published.'
    : 'Summarize the central idea of what you read.';
  const user = `${lead}\n\n<content>\n${input.content}\n</content>\n\n${closing}`;
  return { system, user };
}

/**
 * Default provider: one bounded orchestrator chat completion per item.
 * LLM selection mirrors the dream pipeline — cowork_config override
 * (`contentSummaryLlmId`) → the bot's own brain pair (model + provider hint),
 * with the bot's fallback pair as the retry brain (both suppressed while the
 * global override is in effect).
 */
export class OrchestratorSummarizerProvider implements SummarizerProvider {
  constructor(private readonly deps: OrchestratorSummarizerProviderDeps) {}

  private resolveSummaryBrain(metabotId: number): SummaryBrainPair {
    const override = this.deps.getConfigValue('contentSummaryLlmId')?.trim();
    if (override) {
      return { llmId: override, llmProvider: null, fallbackLlmId: null, fallbackLlmProvider: null };
    }
    return this.deps.resolveBotLlm(metabotId)
      ?? { llmId: null, llmProvider: null, fallbackLlmId: null, fallbackLlmProvider: null };
  }

  private async callSummaryLlm(
    systemPrompt: string,
    userMessage: string,
    brain: SummaryBrainPair,
  ): Promise<string> {
    return await this.deps.performChat(systemPrompt, userMessage, brain.llmId, {
      // Per-attempt window: the fallback brain gets its own fresh timeout
      // instead of inheriting the primary's spent signal.
      attemptTimeoutMs: this.deps.llmTimeoutMs ?? SUMMARY_LLM_TIMEOUT_MS,
      // Streaming transport: attemptTimeoutMs bounds stream SILENCE (idle),
      // not the whole generation — long summaries survive while bytes flow
      // (the 2026-11-20 ABS relay handoff).
      attemptTimeoutKind: 'idle',
      maxTokens: SUMMARY_MAX_TOKENS,
      llmProvider: brain.llmProvider,
      fallbackLlmId: brain.fallbackLlmId,
      fallbackLlmProvider: brain.fallbackLlmProvider,
      // Summaries are short plain-text output; reasoning and a stray
      // built-in web search only burn budget (same posture as dreams).
      thinking: 'disabled',
      webSearch: false,
      // Empty content must fail inside runWithLlmFallback so a configured
      // fallback brain gets a chance before the attempt fails.
      throwOnEmptyContent: true,
    });
  }

  async summarize(input: SummarizerInput): Promise<string> {
    const { system, user } = buildSummaryPrompt(input);
    const raw = await this.callSummaryLlm(
      system,
      user,
      this.resolveSummaryBrain(input.metabotId),
    );
    // Surrogate-safe cap: LLM text can carry lone surrogates that corrupt the
    // sqlite write downstream (see libs/llmSafeText).
    const summary = truncateUtf16Units(stripLoneSurrogates(raw).trim(), SUMMARY_MAX_CHARS);
    if (!summary) throw new Error('LLM returned an empty summary');
    return summary;
  }
}

export interface ContentSummaryServiceDeps {
  store: ChainContentHistoryStore;
  provider: SummarizerProvider;
  /** cowork_config lookup: contentSummaryEnabled / contentSummaryDailyCap. */
  getConfigValue: (key: string) => string | null;
  tickIntervalMs?: number;
  now?: () => Date;
}

export class ContentSummaryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy lock: one drain at a time across manual + interval ticks. */
  private running = false;

  constructor(private readonly deps: ContentSummaryServiceDeps) {}

  startSchedule(): void {
    if (this.timer) return;
    // First tick immediately so a fresh backlog does not wait 30 minutes.
    void this.runTick().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.runTick().catch(() => undefined);
    }, this.deps.tickIntervalMs ?? TICK_MS);
  }

  stopSchedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** '0' / 'false' in cowork_config turns the drain off; anything else is on. */
  private isEnabled(): boolean {
    const raw = this.deps.getConfigValue('contentSummaryEnabled');
    if (raw == null) return true;
    const normalized = raw.trim().toLowerCase();
    return normalized !== '0' && normalized !== 'false';
  }

  private resolveDailyCap(): number {
    const raw = this.deps.getConfigValue('contentSummaryDailyCap');
    const parsed = raw == null ? Number.NaN : Number(raw.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : CONTENT_SUMMARY_DEFAULT_DAILY_CAP;
  }

  /**
   * Drain pending summaries: up to MAX_PER_TICK rows (writes first, then
   * reads), each gated by the per-bot daily cap (both kinds combined, counted
   * from local midnight). One item's failure is recorded on that row and never
   * interrupts the rest of the batch.
   */
  async runTick(): Promise<{ done: number; failed: number; skipped: number }> {
    if (this.running) return { done: 0, failed: 0, skipped: 0 };
    if (!this.isEnabled()) return { done: 0, failed: 0, skipped: 0 };
    this.running = true;
    try {
      const maxPerTick = CONTENT_SUMMARY_MAX_PER_TICK;
      const dailyCap = this.resolveDailyCap();
      const nowDate = this.deps.now?.() ?? new Date();
      const dayStartMs = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
      const pending: Array<{ kind: 'write' | 'read'; record: MetabotChainWriteRecord | MetabotChainReadRecord }> = [
        ...this.deps.store.listPendingSummaries('write', maxPerTick)
          .map((record) => ({ kind: 'write' as const, record })),
        ...this.deps.store.listPendingSummaries('read', maxPerTick)
          .map((record) => ({ kind: 'read' as const, record })),
      ].slice(0, maxPerTick);

      // metabotId → summaries already completed today (both kinds), cached per
      // bot and incremented in-loop so in-tick successes count against the cap.
      const dailyCounts = new Map<number, number>();
      let done = 0;
      let failed = 0;
      let skipped = 0;
      for (const item of pending) {
        const metabotId = item.record.metabotId;
        let dailyCount = dailyCounts.get(metabotId);
        if (dailyCount === undefined) {
          try {
            dailyCount = this.deps.store.countSummariesSince('write', metabotId, dayStartMs)
              + this.deps.store.countSummariesSince('read', metabotId, dayStartMs);
          } catch (countError) {
            // An unhealthy store must not kill the batch — leave the row
            // pending for a later tick.
            console.error('[ContentSummary] failed to read daily summary count:', countError instanceof Error ? countError.message : String(countError));
            continue;
          }
          dailyCounts.set(metabotId, dailyCount);
        }
        if (dailyCount >= dailyCap) {
          skipped += 1;
          continue;
        }
        const content = item.kind === 'write'
          ? (item.record as MetabotChainWriteRecord).contentText
          : (item.record as MetabotChainReadRecord).contentExcerpt;
        if (!content?.trim()) {
          // Pending rows always carry content by construction; a blank row is
          // a store anomaly — leave it alone rather than burning an attempt.
          console.warn(`[ContentSummary] skip ${item.kind}#${item.record.id}: empty content on a pending row`);
          continue;
        }
        const input: SummarizerInput = {
          kind: item.kind,
          metabotId,
          title: item.kind === 'read' ? (item.record as MetabotChainReadRecord).title : null,
          path: item.record.path ?? null,
          content,
        };
        try {
          const summary = await this.deps.provider.summarize(input);
          const summarizedAtMs = (this.deps.now?.() ?? new Date()).getTime();
          this.deps.store.applySummarySuccess(item.kind, item.record.id, summary, summarizedAtMs);
          dailyCounts.set(metabotId, dailyCount + 1);
          done += 1;
        } catch (error) {
          console.warn(
            `[ContentSummary] summarize failed for ${item.kind}#${item.record.id}:`,
            error instanceof Error ? error.message : String(error),
          );
          try {
            this.deps.store.applySummaryFailure(item.kind, item.record.id);
          } catch (bookkeepingError) {
            console.error('[ContentSummary] failed to record summary failure:', bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError));
          }
          failed += 1;
        }
      }
      return { done, failed, skipped };
    } finally {
      this.running = false;
    }
  }
}
