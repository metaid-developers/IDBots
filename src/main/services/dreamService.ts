import { createHash } from 'node:crypto';
import type { CapabilityFalsifiedHypothesis, CoworkStore, CoworkUserMemory } from '../coworkStore';
import type {
  DreamDayActivity,
  DreamInputDropCounters,
  DreamStore,
  MetabotPrediction,
  PromptLayerSnapshot,
  StudioContinuitySnapshot,
} from '../dreamStore';
import { countDreamInputDrops, createDreamInputDropCounters } from '../dreamStore';
import type { MetaIDExperienceStore } from '../metaidExperienceStore';
import type { MetaIDImpressionStore } from '../metaidImpressionStore';
import type { MetaIDKnowledgeEntry, MetaIDKnowledgeStore } from '../metaidKnowledgeStore';
import {
  DREAM_LOOKBACK_DAYS,
  DREAM_VERSION,
  buildDreamFragmentPrompt,
  buildDreamPrompt,
  isSelfIdentityInjectionAttempt,
  computeDueDreamDates,
  extractSelfIdentityFromRetry,
  getDayBoundsMs,
  parseDreamOutput,
  validateSelfIdentity,
  PRACTICE_PROPOSALS_MAX_PER_NIGHT,
  type DreamKnowledgeExisting,
  type DreamOutput,
  type DreamPracticeOutcome,
} from '../libs/dreamPrompt';
import {
  buildPracticeRunPrompt,
  computePracticeRunAtMs,
  PRACTICE_OUTCOME_MAX_CHARS,
} from '../libs/practiceInteractionGuard';
import {
  CAPABILITY_VALIDATION_MAX_DRAFTS,
  CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE,
  CAPABILITY_VALIDATION_SUMMARY_DAYS,
  CAPABILITY_PROMOTION_MIN_SCORE,
  CAPABILITY_REVIEW_INTERVAL_DAYS,
  CAPABILITY_REVIEW_MAX_PER_NIGHT,
  DISPUTED_AUTO_REJECT_DAYS,
  buildCapabilityValidationPrompt,
  parseCapabilityValidationOutput,
} from '../libs/capabilityValidationPrompt';
import { promotionBudgetForNight } from '../libs/promotionBudget';
import {
  FALSIFIED_PROMPT_MAX_ITEMS,
  FALSIFIED_RETENTION_DAYS,
  citedDiaryDates,
  combinePanelOutcomes,
  findSimilarFalsified,
  hasPostOriginCitation,
  joinPanelRationales,
  resolveCapabilityGateConfig,
  type CapabilityGateConfig,
  type GateOutcome,
} from '../libs/capabilityGateRegularizers';
import {
  RECONCILE_MAX_CONFLICT_CANDIDATES,
  RECONCILE_MAX_DRAFTS_PER_NIGHT,
  buildCapabilityReconciliationPrompt,
  parseCapabilityReconciliationOutput,
  type ReconciliationConflictCandidate,
} from '../libs/capabilityReconciliationPrompt';
import { titleHasHardInstanceMarker, type CapabilityScope } from '../libs/capabilitySpecificity';
import { tokenizeKnowledgeBaseText } from '../libs/knowledgeBaseText';
import {
  buildChainEvidenceDigest,
  chainRefKeysOf,
  collectChainEvidenceRefs,
  renderChainEvidenceDigest,
  type ChainEvidenceDigest,
  type ChainEvidenceVerifierDeps,
} from '../libs/chainEvidence';
import {
  buildCounterfactualReplayPrompt,
  COUNTERFACTUAL_MAX_POINTS,
  extractNegativeDecisionPoints,
  hasExplicitHumanFeedback,
  parseCounterfactualReplayOutput,
  pickCounterfactualLesson,
  pickCounterfactualWorkflowUpgrade,
} from '../libs/counterfactualReplayPrompt';
import {
  buildPositiveReplayPrompt,
  extractPositiveDecisionPoints,
  parsePositiveReplayOutput,
  pickPositiveLesson,
  POSITIVE_REPLAY_MAX_POINTS,
} from '../libs/positiveReplayPrompt';
import { extractImplicitSignals } from '../libs/implicitSignals';
import {
  buildExamScoringPrompt,
  buildExamSessionPrompt,
  buildMetabotExam,
  EXAM_MIN_DATA_DAYS,
  EXAM_RUN_INTERVAL_DAYS,
  parseExamScores,
  type ExamQuestion,
  type MetabotExam,
} from '../libs/metabotExam';
import {
  PREDICTION_CALIBRATION_WINDOW_DAYS,
  judgeNumericExpectation,
  renderPredictionCalibrationDigest,
  shiftDateKey,
} from '../libs/predictionLedger';
import {
  detectEvolutionStall,
  judgeExplorationCompliance,
  listUnderExploredComponents,
  orderPracticeProposalsForApproval,
  renderExplorationDirective,
  type ExplorationStall,
  type PracticeComponent,
} from '../libs/evolutionExploration';
import {
  ROLLBACK_BASELINE_DAYS,
  ROLLBACK_NEGATIVE_FLOOR,
  buildRollbackNotice,
  countNegativeSignalsForDay,
  evaluatePromptLayerRollback,
} from '../libs/promptLayerRollback';
import { formatParseFailureExcerpt } from '../libs/parseFailureExcerpt';
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
import { buildProcedureBlock, PROCEDURE_PROMPT_MAX_ITEMS } from '../libs/procedurePromptBlocks';
import {
  buildHotLayerUsageAuditPrompt,
  parseHotLayerUsageAuditOutput,
  sampleUsageAuditExcerpts,
  selectUsageAuditItems,
  USAGE_AUDIT_ITEM_GIST_CHARS,
  USAGE_AUDIT_MAX_ITEMS_TOTAL,
  type UsageAuditItem,
} from '../libs/hotLayerUsageAudit';
import {
  HOT_LAYER_REENTRY_MIN_APPLIED_NIGHTS,
  HOT_LAYER_REENTRY_WINDOW_DAYS,
  HOT_LAYER_UTILITY_WINDOW_DAYS,
  selectHotLayerDemotions,
  selectHotLayerReentries,
} from '../libs/hotLayerPruning';
import { buildProvenTechniquesBlock } from '../libs/experiencePromptBlocks';
import { resolveAutomationModelOverride, resolveCurrentModelLimits } from '../libs/claudeSettings';
import { budgetAssumesThinking } from '../libs/modelThinking';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';
import { metabotBrainOptions } from './llmFallback';
import { extractFinalAssistantReply } from './orchestratorCoworkBridge';
import { truncateUtf16Units } from '../libs/llmSafeText';
import {
  classifyDreamError,
  DREAM_RETRY_MAX_ATTEMPTS,
  DREAM_MIN_CALL_WINDOW_MS,
  DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS,
  isTimeoutError,
  isTransientDreamLlmError,
  remainingRunBudgetMs,
  resolveDreamAttemptTimeoutMs,
} from '../libs/dreamRetryPolicy';
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
// Adaptive escalation (2026-10-08, dream-consolidation-timeout fix): the fixed
// 10-min window was still too small on burst days — legitimate consolidation
// calls measured 8-38 minutes and the 10-06/07 cycle lost 4/7 runs to
// `aborted due to timeout` with every failed run pinned at exactly the 30-min
// run budget. Synthesis/self-identity calls now take a tiered per-attempt
// window from the run's attempt count (see resolveDreamAttemptTimeoutMs);
// DREAM_SYNTHESIS_TIMEOUT_MS survives as the first-attempt tier so tests and
// external wiring keep their anchor.
const DREAM_SYNTHESIS_TIMEOUT_MS = 600_000;
// Sentinel thrown when the run-level wall expires before a full-JSON call can
// legitimately start: retryable by design, never terminal.
const DREAM_RUN_BUDGET_EXHAUSTED = 'dream run budget exhausted before synthesis window';
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

/**
 * RSI P0 retention-gate result for one run (telemetry + prompt notice).
 * `rolledBackDate` is the dream date whose prompt layer was rolled back.
 */
interface RetentionGateResult {
  evaluated: boolean;
  rolledBack: boolean;
  rolledBackDate: string | null;
  negativeSignals: number;
  baselineMedian: number | null;
  baselineDays: number;
  reason: string | null;
  notice: string | null;
}

const EMPTY_RETENTION_GATE_RESULT: RetentionGateResult = {
  evaluated: false,
  rolledBack: false,
  rolledBackDate: null,
  negativeSignals: 0,
  baselineMedian: null,
  baselineDays: 0,
  reason: null,
  notice: null,
};

/** RSI P0 prediction reconciliation counters for one run. */
interface PredictionReconciliationResult {
  checked: number;
  resolved: number;
  hit: number;
  miss: number;
  partial: number;
  expired: number;
}

const EMPTY_PREDICTION_RECONCILIATION: PredictionReconciliationResult = {
  checked: 0,
  resolved: 0,
  hit: 0,
  miss: 0,
  partial: 0,
  expired: 0,
};

/** RRSI P5 scope telemetry (design §6.5 P5.2): verdict mix over tonight's
 * reconciled drafts plus the host hard-marker overrides. */
interface ReconciliationScopeCounts {
  general: number;
  situational: number;
  scorerFitted: number;
  hardMarkerOverrides: number;
}

const ZERO_RECONCILIATION_SCOPE: ReconciliationScopeCounts = {
  general: 0,
  situational: 0,
  scorerFitted: 0,
  hardMarkerOverrides: 0,
};

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
  /**
   * Pre-dream surf hook. `skippedReason` (dream review P3) is set when the
   * host skipped the surf on purpose (e.g. a stale model binding) — the run
   * telemetry records it as surfSkipped so the nightly skip is auditable.
   */
  surfBeforeDream?: (metabotId: number) => Promise<{ reportMarkdown: string | null; skippedReason?: string | null } | null>;
  /**
   * Fresh-install deferral (see libs/installAgeGate): returns a one-line
   * reason while background automation must stay off (a brand-new install's
   * first 24h), else null. Deferred ticks do not enqueue anything, so no due
   * date is retried in a loop while the window lasts. Absent → never deferred.
   */
  backgroundDeferral?: () => string | null;
  /**
   * Self-curriculum materialization (design 2026-10-10 §3.4): creates the
   * one-shot ScheduledTask for an approved practice proposal (main.ts wires
   * ScheduledTaskStore.createTask + Scheduler.reschedule). Optional: without
   * it, approved proposals simply stay approved (tests, headless runs).
   */
  /**
   * Dream review P2-1: runs one frozen-exam session in a read_only isolated
   * cowork turn and returns the answer text. Wired in main.ts on
   * runOrchestratorSkillTurn with the practice read_only guard; absent →
   * exams are skipped (tests, slim harnesses).
   */
  runExamSession?: (input: { metabotId: number; userMessage: string }) => Promise<string>;
  createPracticeScheduledTask?: (input: {
    metabotId: number;
    name: string;
    description: string;
    prompt: string;
    scheduleAtMs: number;
  }) => { id: string };
  /**
   * Chain-grounded verification for the replay gate (design 2026-10-10 §5.2):
   * read-only verifiers behind the evidence digest. Entirely optional — with
   * no dep wired, no digest is built and the gate judges exactly as before;
   * individual verifier failures degrade the ref to UNVERIFIED, never to a
   * dream-run failure.
   */
  chainEvidence?: ChainEvidenceVerifierDeps;
  /**
   * RSI P0 prediction reconciliation: reception counts (likes/comments) for
   * the bot's own pins, batched per run. Wire it to the same R3 interactions
   * aggregation the surf reception column uses. Absent/throwing → reception
   * predictions stay pending (and expire past their deadline).
   */
  fetchPredictionReception?: (input: {
    metabotId: number;
    pinIds: string[];
    /** Unix seconds lower bound for the interactions scan. */
    sinceTs: number;
  }) => Promise<Array<{ pinId: string; likes: number; comments: number }> | null>;
  /**
   * RSI P0 prediction reconciliation: review outcome of the bot's own MetaTask
   * submission on subjectRef "rootPinId:nodeId" from the local projection.
   * Absent/null → not observable (stays pending).
   */
  getMetataskSubmissionOutcome?: (input: {
    metabotId: number;
    subjectRef: string;
  }) => { outcome: 'pass' | 'fail' | 'pending'; detail?: string } | null;
  tickIntervalMs?: number;
  llmTimeoutMs?: number;
  /**
   * RRSI P1 gate regularizers (design §6.1): dual-panel agreement and the
   * prospective rule default to ON; this override exists so tests whose
   * subject is downstream of the gate can pin the legacy single-panel
   * behavior. Production wiring never sets it.
   */
  capabilityGate?: Partial<CapabilityGateConfig>;
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

/**
 * Fresh-gate panel classification (RRI P1, design §6.1 P1.2): a validated
 * verdict above the promote threshold is 'promote', a rejected verdict is
 * 'demote', everything else (and a missing verdict) degrades toward 'hold'.
 */
function classifyGateVerdict(verdict: { verdict: string; score: number } | null): GateOutcome | null {
  if (!verdict) return null;
  if (verdict.verdict === 'validated' && verdict.score >= CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE) {
    return 'promote';
  }
  if (verdict.verdict === 'rejected') return 'demote';
  return 'hold';
}

/**
 * Re-review panel classification (RRI P1, design §6.1 P1.2): validated is a
 * score refresh ('promote'); only a rejected verdict BELOW the promotion line
 * demotes — everything else (and a missing verdict) holds.
 */
function classifyReReviewVerdict(verdict: { verdict: string; score: number } | null): GateOutcome | null {
  if (!verdict) return null;
  if (verdict.verdict === 'validated') return 'promote';
  if (verdict.verdict === 'rejected' && verdict.score < CAPABILITY_PROMOTION_MIN_SCORE) return 'demote';
  return 'hold';
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
  /** One-line "deferred" log latch (see tick); reset once the window elapses. */
  private deferralLogged = false;

  constructor(private deps: DreamServiceDeps) {
    this.performChat = deps.performChat ?? performChatCompletionForOrchestrator;
  }

  /**
   * Dream review P3: the gate config resolved for THIS pass — persisted
   * cowork_config knob (panels only; the prospective data-leak guard stays
   * unconditionally on) under an explicit deps.capabilityGate test override.
   * Resolved per pass (not cached on the service) so a config change takes
   * effect the same night.
   */
  private resolveGateConfig(): CapabilityGateConfig {
    let persisted: { panels: 1 | 2 } | null = null;
    try {
      persisted = this.deps.coworkStore.getCapabilityGateConfig?.() ?? null;
    } catch (error) {
      console.warn(
        `[DreamService] Capability gate config read failed; using defaults: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return resolveCapabilityGateConfig(persisted ? { ...persisted, ...this.deps.capabilityGate } : this.deps.capabilityGate);
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
    // Fresh-install deferral: skip the whole scan on a machine whose install
    // is younger than the window. Skipping before the due-date scan is what
    // keeps a deferred night from re-enqueueing (and re-surfing) on every
    // tick: nothing is queued, so nothing retries.
    const deferredReason = this.deps.backgroundDeferral?.() ?? null;
    if (deferredReason) {
      if (!this.deferralLogged) {
        this.deferralLogged = true;
        console.log(`[DreamService] Dreaming deferred: ${deferredReason}`);
      }
      return;
    }
    this.deferralLogged = false;
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
        metabot.id,
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
    /** Per-attempt window for the full-JSON synthesis calls. Adaptive by the
     * run's attempt count (resolveDreamAttemptTimeoutMs); the fixed constant
     * remains the default anchor for tests/legacy callers. */
    attemptTimeoutMs: number = DREAM_SYNTHESIS_TIMEOUT_MS,
    /** Practice runs executed during the dreamed day (design §3.4), rendered
     * as the prompt's practice-outcomes section. */
    practiceOutcomes?: DreamPracticeOutcome[],
    /** RSI P0 prompt inputs: prediction calibration digest + retention-gate
     * rollback notice (both rendered as their own sections when non-empty).
     * RRSI P1 adds the falsified-hypothesis list (design §6.1 P1.3); P4 adds
     * the exploration directive for stalled bots (design §6.4). */
    dreamExtras?: {
      predictionCalibration?: string | null;
      rollbackNotice?: string | null;
      falsifiedHypotheses?: Array<{ title: string; reason: string }>;
      explorationDirective?: string | null;
      previousStudioContinuity?: StudioContinuitySnapshot | null;
    },
    /** Silent-drop counters for prompt-building and parse caps (telemetry). */
    dropCounters?: DreamInputDropCounters,
  ): Promise<{
    prompt: { system: string; user: string };
    output: DreamOutput;
    meta: { estimatedInputTokens: number; fragmentCount: number };
  }> {
    const budgets = this.resolveDreamBudgets(brain);
    const estimatedTokens = estimateDreamActivityTokens(activity);
    // Dream review P0: a bot whose practice pipeline is disabled never sees
    // the practice_proposals output contract — default installs stop paying
    // the output tokens for proposals that would be discarded at write time.
    const practiceEnabled = this.isPracticePipelineEnabled(metabot.id);
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
        practiceOutcomes,
        predictionCalibration: dreamExtras?.predictionCalibration,
        rollbackNotice: dreamExtras?.rollbackNotice,
        falsifiedHypotheses: dreamExtras?.falsifiedHypotheses,
        explorationDirective: dreamExtras?.explorationDirective,
        practiceEnabled,
        previousStudioContinuity: dreamExtras?.previousStudioContinuity,
      }, dropCounters);
      const output = await this.generateAndParse(
        metabot.id,
        prompt.system,
        prompt.user,
        brain,
        budgets.maxOutputTokens,
        attemptTimeoutMs,
        dropCounters,
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
        practiceOutcomes,
        predictionCalibration: dreamExtras?.predictionCalibration,
        rollbackNotice: dreamExtras?.rollbackNotice,
        falsifiedHypotheses: dreamExtras?.falsifiedHypotheses,
        explorationDirective: dreamExtras?.explorationDirective,
        practiceEnabled,
        previousStudioContinuity: dreamExtras?.previousStudioContinuity,
      }, dropCounters);
      const output = await this.generateAndParse(
        metabot.id,
        prompt.system,
        prompt.user,
        brain,
        budgets.maxOutputTokens,
        attemptTimeoutMs,
        dropCounters,
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
      activity.studioDelegations ?? [],
      activity.studioDecisions ?? [],
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
      practiceOutcomes,
      predictionCalibration: dreamExtras?.predictionCalibration,
      rollbackNotice: dreamExtras?.rollbackNotice,
      falsifiedHypotheses: dreamExtras?.falsifiedHypotheses,
      explorationDirective: dreamExtras?.explorationDirective,
      practiceEnabled,
      previousStudioContinuity: dreamExtras?.previousStudioContinuity,
    }, dropCounters);
    const output = await this.generateAndParse(
      metabot.id,
      prompt.system,
      prompt.user,
      brain,
      budgets.maxOutputTokens,
      attemptTimeoutMs,
      dropCounters,
    );
    return { prompt, output, meta: { estimatedInputTokens: estimatedTokens, fragmentCount: chunks.length } };
  }

  /**
   * Adaptive full-JSON call window for this run: the attempt tier
   * (10/20/38 min by attempt count) clamped to the remaining run-level
   * budget, floored at 60s so a near-exhausted run still gets a real
   * (small) window instead of an instant abort. When the run wall has
   * burned past the point where a legitimate synthesis could still START
   * (< DREAM_MIN_CALL_WINDOW_MS left), throws the retryable budget
   * sentinel: the date yields to the scheduler for a cross-window retry
   * instead of queuing another doomed timeout inside this run.
   */
  private resolveSynthesisTimeoutMs(runStartedAtMs: number, attemptCount: number): number {
    const remaining = remainingRunBudgetMs(runStartedAtMs);
    if (remaining < DREAM_MIN_CALL_WINDOW_MS) {
      throw new Error(
        `${DREAM_RUN_BUDGET_EXHAUSTED} (remaining ${Math.max(0, Math.round(remaining / 1000))}s, attempt ${attemptCount})`,
      );
    }
    return Math.max(60_000, Math.min(resolveDreamAttemptTimeoutMs(attemptCount), remaining));
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
    // Review M1: the brain resolution and beginRun used to run OUTSIDE the
    // try — a throwing beginRun (sick store mid-recovery) never reached the
    // finally, leaving the bot in dreamingBots forever (every later enqueue
    // returned false) and escaped as an unhandled rejection. Both live inside
    // the try now; currentRun stays null until beginRun succeeds.
    let currentRun: ReturnType<DreamStore['beginRun']> | null = null;
    try {
      const brain = this.resolveDreamBrain(metabot);
      currentRun = this.deps.dreamStore.beginRun(metabotId, date, brain.llmId, DREAM_VERSION);
      // Pre-dream surf ("做梦前自动冲浪"): the bot browses MetaWeb first so
      // tonight's dream can fold what it learned into long-term memory. The
      // wiring owns enable/recency/timeout/failure isolation; a null or
      // throwing surf never blocks the dream.
      let surfReport: string | null = null;
      let surfSkippedReason: string | null = null;
      if (this.deps.surfBeforeDream) {
        try {
          const surf = await this.deps.surfBeforeDream(metabotId);
          surfReport = surf?.reportMarkdown?.trim() || null;
          surfSkippedReason = surf?.skippedReason?.trim() || null;
        } catch (error) {
          console.warn(
            `[DreamService] Pre-dream surf failed for metabot ${metabotId}; dreaming without it: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // Cost attribution (nightly-token audit 2026-10-25): durationMs below
      // used to fold the pre-dream surf wait into the dream's own duration,
      // making dream telemetry unreadable for token-cost analysis. The split
      // keeps the legacy total and adds the two components.
      const surfEndedAtMs = Date.now();
      const { startMs, endMs } = getDayBoundsMs(date);
      const dropCounters = createDreamInputDropCounters();
      const activity = this.deps.dreamStore.getActivityForDate(metabotId, startMs, endMs, dropCounters, {
        dreamDate: date,
        honorSessionCursors: !isRepair,
      });
      // Mechanical implicit-signal collection: structural facts only, attached
      // before prompt building so the dream itself judges what they mean.
      activity.implicitSignals = extractImplicitSignals(activity, dropCounters);
      // RSI P0 retention gate: if yesterday (the dreamed date) carried a
      // negative-feedback spike, deterministically roll back the previous
      // dream night's prompt layer BEFORE tonight's snapshot/synthesis. Repair
      // runs never roll back (their date is not "yesterday's" evidence).
      const retentionGate = isRepair
        ? EMPTY_RETENTION_GATE_RESULT
        : this.evaluatePromptLayerRetentionGate(metabot, date, activity);
      // RSI P0 prediction reconciliation: resolve pending predictions against
      // observed outcomes BEFORE synthesis, so the calibration digest is part
      // of tonight's prompt input.
      const predictions = await this.reconcilePredictionsBeforeDream(metabot, date);
      const predictionCalibration = this.buildPredictionCalibrationDigest(metabotId);
      // RRSI P4: evaluate the exploration stall once per run, before the
      // empty-day branch, so both paths share the same verdict.
      const exploration = this.evaluateExplorationState(metabotId, date);
      const impressionSubjects = this.buildDreamImpressionSubjects(metabot, date);
      const existingKnowledge = this.buildExistingKnowledge(metabot);
      if (
        activity.sessions.length === 0
        && activity.taskRuns.length === 0
        && activity.groupTasks.length === 0
        && (activity.groupChats?.length ?? 0) === 0
        && (activity.chainWrites?.length ?? 0) === 0
        && (activity.chainReads?.length ?? 0) === 0
        && (activity.serviceRatings?.length ?? 0) === 0
        && (activity.studioDelegations?.length ?? 0) === 0
        && (activity.studioDecisions?.length ?? 0) === 0
        && impressionSubjects.length === 0
        && !surfReport
      ) {
        // Nothing happened that day — no LLM call, no summary, still recorded.
        this.deps.dreamStore.finishRun(metabotId, date, 'completed');
        // Pending capability drafts can still be validated against older
        // diaries even when today added no new activity.
        const validation = await this.validateCapabilityDraftsAfterDream(metabot, brain, date, activity);
        // Memory reconciliation (design §4.2) sits between validation and
        // promotion on every path — a just-validated draft must survive the
        // memory-bank check before it can harden.
        const reconciliation = await this.reconcileValidatedCapabilityDrafts(metabot, brain, date, validation.validatedIds);
        const promotion = this.promoteCapabilityDraftsToProcedures(metabot, date);
        // Empty days have no negative decision points, so the replay no-ops.
        const replay = await this.runCounterfactualReplayAfterDream(metabot, brain, date, activity, dropCounters);
        // Same for the positive replay: no thumbs-up, no LLM call.
        const positiveReplay = await this.runPositiveReplayAfterDream(metabot, brain, date, activity, dropCounters);
        const weeklyLongDream = await this.maybeRunWeeklyLongDream(metabot, brain, date);
        // Self-curriculum (design §3.4): pending read_only proposals from
        // earlier nights still approve + materialize on an empty day.
        const practicePipeline = this.processPracticeProposalsAfterDream(metabot, { stalled: exploration.stall.stalled, underExplored: exploration.underExplored });
        if (countDreamInputDrops(dropCounters) > 0) {
          console.warn(
            `[DreamService] Dream input drops for metabot ${metabotId} date ${date}: ${JSON.stringify(dropCounters)}`,
          );
        }
        this.deps.dreamStore.updateRunTelemetry(metabotId, date, {
          emptyDay: true,
          estimatedActivityTokens: 0,
          implicitSignals: 0,
          validation,
          replay,
          positiveReplay,
          // Dream review P3: a deliberate pre-dream surf skip (e.g. stale
          // model binding) is auditable in the telemetry blob.
          surfSkipped: surfSkippedReason,
          inputDrops: dropCounters,
          weeklyLongDream,
          capabilityUtilization: this.buildCapabilityUtilizationTelemetry(metabotId),
          promotedCount: promotion.promoted,
          promotionBudget: { nights: promotion.nights, budget: promotion.budget, candidates: promotion.candidates, promoted: promotion.promoted },
          hotLayer: this.buildHotLayerTelemetry(metabotId, date),
          hasExplicitFeedback: hasExplicitHumanFeedback(activity),
          reconciliation,
          chainEvidence: validation.chainEvidence,
          practiceProposals: this.buildPracticeProposalTelemetry(metabotId, {
            proposed: 0,
            autoApproved: practicePipeline.autoApproved,
          }),
          practiceRuns: { completed: 0, failed: 0 },
          // RRSI P4: no dream prompt was sent, so nothing was directed at or
          // complied with — but the stall verdict itself is still recorded.
          exploration: {
            stalled: exploration.stall.stalled,
            reason: exploration.stall.reason,
            underExplored: exploration.underExplored,
            directed: false,
            complied: null,
          },
          predictions,
          // RRSI P5: the internal vs external prediction split rides the
          // empty-day telemetry too (design §6.5 P5.3).
          predictionOod: this.buildPredictionOodTelemetry(metabotId),
          promptLayerRollback: retentionGate,
          durationMs: Date.now() - runStartedAtMs,
          surfMs: surfEndedAtMs - runStartedAtMs,
          dreamMs: Date.now() - surfEndedAtMs,
        });
        return;
      }

      // Self-curriculum loop closure (design §3.4): collect the practice runs
      // executed during the dreamed day (and backfill their outcome summaries)
      // before the prompt is built, so tonight's curriculum sees them.
      const practiceOutcomes = this.collectPracticeOutcomesForDream(metabotId, startMs, endMs);
      // RRSI P1: the falsified-hypothesis section rides the dream prompt
      // (design §6.1 P1.3); a ledger failure never blocks the dream.
      let falsifiedHypotheses: Array<{ title: string; reason: string }> = [];
      try {
        falsifiedHypotheses = this.deps.coworkStore.listFalsifiedHypotheses(metabotId, {
          sinceMs: Date.now() - FALSIFIED_RETENTION_DAYS * 86_400_000,
          limit: FALSIFIED_PROMPT_MAX_ITEMS,
        }).map(({ title, reason }) => ({ title, reason }));
      } catch (error) {
        console.warn(
          `[DreamService] Falsified ledger read for the dream prompt failed for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        falsifiedHypotheses = [];
      }
      let previousStudioContinuity: StudioContinuitySnapshot | null = null;
      try {
        const currentContinuity = this.deps.dreamStore.getStudioContinuity(metabotId);
        if (currentContinuity && currentContinuity.dreamDate < date) {
          previousStudioContinuity = currentContinuity;
        }
      } catch {
        previousStudioContinuity = null;
      }
      const prepared = await this.prepareDreamPromptAndOutput(
        metabot,
        date,
        activity,
        brain,
        impressionSubjects,
        existingKnowledge,
        surfReport,
        this.resolveSynthesisTimeoutMs(runStartedAtMs, currentRun.attemptCount),
        practiceOutcomes.outcomes,
        {
          predictionCalibration,
          rollbackNotice: retentionGate.notice,
          falsifiedHypotheses,
          explorationDirective: exploration.directive,
          previousStudioContinuity,
        },
        dropCounters,
      );
      let output = prepared.output;
      // Repair runs discard selfIdentity in writeDreamResults, so skip the
      // expansion retry instead of burning an extra LLM call on it.
      if (!isRepair) {
        output = await this.ensureSelfIdentity(
          metabotId,
          output,
          prepared.prompt.system,
          prepared.prompt.user,
          brain,
          this.resolveDreamBudgets(brain).maxOutputTokens,
          this.resolveSynthesisTimeoutMs(runStartedAtMs, currentRun.attemptCount),
        );
      }
      const writeResult = this.writeDreamResults(metabotId, date, output, activity, brain.llmId, isRepair, impressionSubjects, metabot.globalmetaid);
      if (countDreamInputDrops(dropCounters) > 0) {
        console.warn(
          `[DreamService] Dream input drops for metabot ${metabotId} date ${date}: ${JSON.stringify(dropCounters)}`,
        );
      }
      this.deps.dreamStore.finishRun(metabotId, date, 'completed');
      console.log(`[DreamService] Dream completed for metabot ${metabotId} date ${date}${isRepair ? ' (version repair)' : ''}`);
      const validation = await this.validateCapabilityDraftsAfterDream(metabot, brain, date, activity);
      // P1 periodic re-review runs between the fresh-draft gate and the
      // promotion pass: a just-demoted draft must not harden tonight.
      const reReview = await this.reReviewValidatedCapabilityDrafts(metabot, brain, date);
      // P1 memory reconciliation (design §4.2): tonight's newly validated
      // drafts face the whole memory bank before any promotion can harden.
      const reconciliation = await this.reconcileValidatedCapabilityDrafts(metabot, brain, date, validation.validatedIds);
      const promotion = this.promoteCapabilityDraftsToProcedures(metabot, date);
      // RRSI P3: the usage audit compares the day's exposed hot-layer items
      // with sampled assistant replies and fills hot_layer_usage verdicts.
      const usageAudit = await this.runHotLayerUsageAudit(metabot, brain, date, activity);
      // RRSI P3: prune hot-layer items that keep being shown but never used.
      // Runs even when the audit was skipped — older audited nights still count.
      const hotLayerPruning = this.pruneHotLayerAfterDream(metabot, date);
      // Dream review P1: knowledge entries the audit keeps seeing unused cool
      // out of the <knowledge> hot pool (recall keeps them).
      const knowledgeCooling = this.coolHotKnowledgeAfterDream(metabot, date);
      const replay = await this.runCounterfactualReplayAfterDream(metabot, brain, date, activity, dropCounters);
      // Dream review P0: positive replay — praised replies reinforce through
      // the same draft pipeline, counted like the negative path below.
      const positiveReplay = await this.runPositiveReplayAfterDream(metabot, brain, date, activity, dropCounters);
      const weeklyLongDream = await this.maybeRunWeeklyLongDream(metabot, brain, date);
      // Dream review P2-1: the frozen exam follows the weekly rhythm (own
      // weekly gate caps it at one run per bot per week). Best-effort.
      const exam = await this.maybeRunMetabotExam(metabot, brain, date);
      // Self-curriculum (design §3.4, after the replay per §3.1): auto-approve
      // + materialize tonight's pending read_only practice proposals.
      const practicePipeline = this.processPracticeProposalsAfterDream(metabot, { stalled: exploration.stall.stalled, underExplored: exploration.underExplored });
      // RRSI P4: did tonight's proposals answer the exploration directive?
      // (A directive was sent iff one was rendered for this run.)
      const explorationCompliance = judgeExplorationCompliance({
        directed: exploration.directive != null,
        underExplored: exploration.underExplored,
        proposals: output.practiceProposals ?? [],
      });
      const diaryRefs = this.auditDiaryRefs(output.dailySummary, activity, surfReport);
      // P2a telemetry: the dream policy becomes tunable once it is measurable.
      this.deps.dreamStore.updateRunTelemetry(metabotId, date, {
        emptyDay: false,
        exam,
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
        positiveReplay,
        // Dream review P3: a deliberate pre-dream surf skip (e.g. stale
        // model binding) is auditable in the telemetry blob.
        surfSkipped: surfSkippedReason,
        inputDrops: dropCounters,
        selfIdentityRefused: writeResult.selfIdentityRefused,
        weeklyLongDream,
        capabilityUtilization: this.buildCapabilityUtilizationTelemetry(metabotId),
        promotedCount: promotion.promoted,
        promotionBudget: { nights: promotion.nights, budget: promotion.budget, candidates: promotion.candidates, promoted: promotion.promoted },
        // RRSI P3: which exposed items the bot actually applied that day
        // (design §6.3 P3.1). Non-empty path only — an empty day has no
        // replies to judge against.
        usageAudit,
        // RRSI P3: L1 pruning outcome (design §6.3 P3.3) — never deletes
        // anything; demotion changes a status or an eligibility flag only.
        hotLayerPruning,
        knowledgeCooling,
        hotLayer: this.buildHotLayerTelemetry(metabotId, date),
        // P1 periodic re-review (audit): how many validated drafts faced the
        // verdict panel again tonight and how many were demoted off the
        // injection roster (promoted procedures archived alongside).
        reReviewed: reReview.reReviewed,
        demoted: reReview.demoted,
        // RRSI P1: the re-review's own panel-agreement counters (design
        // §6.1 P1.2 — the empty-day path never runs the re-review).
        reReviewPanels: reReview.panels,
        // Cross-night semantic dedup (audit P1): how many of tonight's memory
        // writes merged into an older row instead of inserting a variant.
        dedupMerged: writeResult.dedupMerged,
        // RRSI P1: the checked capability-draft insert funnel (duplicates of
        // live drafts and re-proposals of recently falsified hypotheses).
        capabilityDraftInsert: writeResult.capabilityDraftInsert,
        // P1: any explicit human feedback today (thumbs up/down, acceptance
        // rating) — separates "zero negative because good" from "no data".
        hasExplicitFeedback: hasExplicitHumanFeedback(activity),
        // §6 memory reconciliation funnel: how tonight's newly validated
        // drafts survived the memory-bank check.
        reconciliation,
        // §6 chain-grounded verification: the digest's fact counts (null when
        // no chain refs were collected or no verifier deps are wired).
        chainEvidence: validation.chainEvidence,
        // §6 self-curriculum telemetry: tonight's proposal funnel + the
        // practice runs consumed from the dreamed day.
        practiceProposals: this.buildPracticeProposalTelemetry(metabotId, {
          proposed: output.practiceProposals?.length ?? 0,
          autoApproved: practicePipeline.autoApproved,
        }),
        practiceRuns: { completed: practiceOutcomes.completed, failed: practiceOutcomes.failed },
        // RRSI P4 structured exploration (design §6.4): stall verdict, the
        // directive's under-explored targets, and whether tonight's proposals
        // actually answered it.
        exploration: {
          stalled: exploration.stall.stalled,
          reason: exploration.stall.reason,
          underExplored: exploration.underExplored,
          directed: exploration.directive != null,
          complied: explorationCompliance,
        },
        predictions,
        // RRSI P5: the internal vs external prediction hit-rate gap (design
        // §6.5 P5.3) — the dream prompt digest text itself is unchanged.
        predictionOod: this.buildPredictionOodTelemetry(metabotId),
        promptLayerRollback: retentionGate,
        durationMs: Date.now() - runStartedAtMs,
        surfMs: surfEndedAtMs - runStartedAtMs,
        dreamMs: Date.now() - surfEndedAtMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!currentRun) {
        // The failure happened BEFORE beginRun produced an attempt row
        // (brain resolution or the beginRun write itself). There is no
        // attempt count to classify against — record a plain failed row
        // (finishRun upserts) and let the scheduler retry per policy.
        console.warn(`[DreamService] Dream aborted before run start for metabot ${metabotId} date ${date}:`, message);
        this.deps.dreamStore.finishRun(metabotId, date, 'failed', message);
      } else {
        // Timeout-class failures (attempt aborts, the run-budget sentinel) never
        // become terminal no matter how many attempts a date has burned: a
        // timeout says the window was too small, and the next scheduled window
        // — with the wider adaptive tier and the ≥10-min consecutive-timeout
        // backoff — can genuinely fix it. Only deterministic provider
        // rejections (H-80) and the retry cap on OTHER retryable errors end in
        // terminal-failed.
        const timeoutClass = isTimeoutError(message);
        if (!timeoutClass && (classifyDreamError(message) === 'terminal' || currentRun.attemptCount >= DREAM_RETRY_MAX_ATTEMPTS)) {
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
      }
    } finally {
      this.dreamingBots.delete(metabotId);
      this.emitDreaming(metabotId, false);
    }
  }

  /**
   * First attempt + one retry when the output is not parseable JSON. Every
   * parse failure leaves ONE forensic log line carrying the raw output's
   * head/tail excerpt (issue #22: the raw text used to be discarded, so
   * failures could be counted but never located afterwards).
   */
  private async generateAndParse(
    metabotId: number,
    system: string,
    user: string,
    brain: DreamBrainPair,
    maxTokens?: number,
    attemptTimeoutMs?: number,
    dropCounters?: DreamInputDropCounters,
  ): Promise<DreamOutput> {
    const firstRaw = await this.callDreamLlm(system, user, brain, maxTokens, attemptTimeoutMs);
    const first = parseDreamOutput(firstRaw, dropCounters);
    if (first.ok) return first.output;
    const firstError = (first as { ok: false; error: string }).error;
    console.warn(
      `[DreamService] Dream output parse failed (attempt 1/2) for metabot ${metabotId}: ${firstError}; raw output (${firstRaw.length} chars): ${formatParseFailureExcerpt(firstRaw)}`,
    );

    const retryRaw = await this.callDreamLlm(
      system,
      `${user}\n\n(上一次输出无法解析:${firstError}。请严格只输出一个 JSON 对象,不要输出任何其他文字。)`,
      brain,
      maxTokens,
      attemptTimeoutMs,
    );
    const retry = parseDreamOutput(retryRaw, dropCounters);
    if (retry.ok) return retry.output;
    console.warn(
      `[DreamService] Dream output unparseable after retry for metabot ${metabotId}: ${(retry as { ok: false; error: string }).error}; raw output (${retryRaw.length} chars): ${formatParseFailureExcerpt(retryRaw)}`,
    );
    throw new Error(`dream output unparseable after retry: ${(retry as { ok: false; error: string }).error}`);
  }

  /** One retry when self_identity is missing or under the 200-char minimum. */
  private async ensureSelfIdentity(
    metabotId: number,
    output: DreamOutput,
    system: string,
    _user: string,
    brain: DreamBrainPair,
    _maxTokens?: number,
    attemptTimeoutMs?: number,
  ): Promise<DreamOutput> {
    const validation = validateSelfIdentity(output.selfIdentity);
    if (validation.valid) return output;

    // Token-waste fix: the retry used to re-send the ENTIRE dream prompt
    // (30-50k+ input tokens) just to repair one short field. Only the
    // identity text is missing, so a compact targeted call under the same
    // system prompt (persona context) suffices; the already-parsed dream
    // output is kept and only self_identity is patched.
    const retryRaw = await this.callDreamLlm(
      system,
      `(昨晚梦境输出中的 self_identity ${output.selfIdentity ? `只有 ${validation.charCount} 个非空白字符` : '缺失'}。请只用第一人称认真写一段「我是谁」的自我描述:你是谁、你的性格与立场、你在积累什么。不少于 200 个非空白字符。只输出这段文字本身,不要 JSON、不要解释、不要标题。)`,
      brain,
      1024,
      attemptTimeoutMs,
    );
    const retryText = extractSelfIdentityFromRetry(retryRaw);
    if (retryText && validateSelfIdentity(retryText).valid) {
      return { ...output, selfIdentity: retryText };
    }
    // Keep the original output rather than failing the whole run over length.
    // The repair output is forensic evidence too (#22): keep its excerpt.
    console.warn(
      `[DreamService] self_identity still below minimum after retry for metabot ${metabotId}; keeping best effort output; repair output (${retryRaw.length} chars): ${formatParseFailureExcerpt(retryRaw)}`,
    );
    return output;
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
   * RRSI P2 cost telemetry (ΔC, design §6.2 P2.5): render the blocks the host
   * would inject RIGHT NOW and record their sizes plus the hot-layer counts.
   * Empty days report it too — the footprint exists whether or not the bot
   * dreamed. Null on failure so telemetry never breaks the dream run.
   */
  private buildHotLayerTelemetry(
    metabotId: number,
    date: string,
  ): {
    hotProcedures: number;
    probationProcedures: number;
    injectableTechniques: number;
    procedureBlockChars: number;
    techniqueBlockChars: number;
    exposedItems: number;
  } | null {
    try {
      const knowledge = this.deps.metaidKnowledgeStore;
      const hotProcedures = knowledge ? knowledge.listHotProcedures(metabotId, { limit: 200 }).length : 0;
      const probationProcedures = knowledge
        ? knowledge.listProcedures({ metabotId, status: 'active', limit: 500 })
          .filter((entry) => entry.hotEligible === false && entry.hotReason === 'probation').length
        : 0;
      const injectableTechniques = this.deps.coworkStore.listInjectableTechniques(metabotId, 50).length;
      const procedureBlockChars = knowledge
        ? buildProcedureBlock(knowledge.listHotProcedures(metabotId, { limit: PROCEDURE_PROMPT_MAX_ITEMS })).length
        : 0;
      const techniqueBlockChars = buildProvenTechniquesBlock(
        this.deps.coworkStore.listInjectableTechniques(metabotId, 5),
      ).length;
      const exposedItems = this.deps.coworkStore.countHotLayerExposures(metabotId, date);
      return { hotProcedures, probationProcedures, injectableTechniques, procedureBlockChars, techniqueBlockChars, exposedItems };
    } catch (error) {
      console.warn(
        `[DreamService] Hot-layer telemetry unavailable for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
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
   *
   * Disputed drafts (design §4.3) re-enter here with their conflict evidence
   * attached (rendered as 存疑待裁决); the disputed-timeout sweep runs first,
   * auto-rejecting anything stale past DISPUTED_AUTO_REJECT_DAYS.
   * Returns the ids of tonight's newly validated drafts — the reconciliation
   * pass consumes exactly that set.
   */
  private async validateCapabilityDraftsAfterDream(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
    /** Day activity: the chain writes/reads whose pin ids join the digest. */
    activity?: DreamDayActivity,
  ): Promise<{
    checked: number;
    validated: number;
    rejected: number;
    validatedIds: number[];
    chainEvidence: ChainEvidenceDigest['counts'] | null;
    deferredSameNight: number;
    prospectiveDowngraded: number;
    panels: { agreed: number; disagreed: number; incomplete: number };
    /** Dream review P3: how many gate panels this pass actually ran. */
    panelsUsed: 1 | 2;
  }> {
    const zero = {
      checked: 0,
      validated: 0,
      rejected: 0,
      validatedIds: [] as number[],
      chainEvidence: null,
      deferredSameNight: 0,
      prospectiveDowngraded: 0,
      panels: { agreed: 0, disagreed: 0, incomplete: 0 },
      panelsUsed: 2 as const,
    };
    try {
      const gate = this.resolveGateConfig();
      // Disputed-timeout sweep (design §4.4): an unresolved dispute older than
      // the auto-reject window demotes to 'rejected'; the existing purge
      // (rejected + old) removes the corpse later.
      const staleDisputed = this.deps.coworkStore.listStaleDisputedCapabilityDrafts(metabot.id, {
        olderThanMs: Date.now() - DISPUTED_AUTO_REJECT_DAYS * 86_400_000,
      });
      for (const stale of staleDisputed) {
        this.deps.coworkStore.updateCapabilityDraftValidation({
          id: stale.id,
          metabotId: metabot.id,
          status: 'rejected',
          validationScore: stale.validationScore,
          validationNotes: `disputed ${DISPUTED_AUTO_REJECT_DAYS} nights without resolution — auto-rejected (reconciliation timeout)`,
        });
      }
      if (staleDisputed.length > 0) {
        console.warn(
          `[DreamService] Auto-rejected ${staleDisputed.length} stale disputed capability draft(s) for metabot ${metabot.id}`,
        );
      }

      // Prospective selection (design §6.1 P1.1): tonight's own distillations
      // wait until a later diary exists; only older drafts (plus disputed
      // re-entries) face the panel.
      const disputed = this.deps.coworkStore.listCapabilityDrafts(metabot.id, { status: 'disputed' });
      const freshAll = this.deps.coworkStore.listCapabilityDrafts(metabot.id, { status: 'draft' });
      const fresh = gate.prospective ? freshAll.filter((draft) => draft.dreamDate < date) : freshAll;
      const deferredSameNight = freshAll.length - fresh.length;
      const pending = [...disputed, ...fresh].slice(0, CAPABILITY_VALIDATION_MAX_DRAFTS);
      if (pending.length === 0) {
        return deferredSameNight > 0 ? { ...zero, deferredSameNight } : zero;
      }
      const recentSummaries = this.deps.dreamStore.listDailySummaries(
        metabot.id,
        CAPABILITY_VALIDATION_SUMMARY_DAYS,
      );
      // Grounding set = the diary dates actually shown to the panel (the bare
      // dreamed date is deliberately absent: an empty day has no diary to cite).
      const evidenceDates = new Set(recentSummaries.map((summary) => summary.summaryDate));

      // Chain-grounded evidence digest (design §5.2): the host collects the
      // pin/txid refs from tonight's drafts and the day's chain activity and
      // verifies each against chain state. Built once per pass (cached for
      // the night); absent deps or per-ref failures degrade to UNVERIFIED,
      // never to a dream-run failure.
      let chainDigest: ChainEvidenceDigest | null = null;
      const chainRefs = collectChainEvidenceRefs({
        chainWrites: activity?.chainWrites ?? [],
        chainReads: activity?.chainReads ?? [],
        drafts: pending.map((draft) => ({
          id: draft.id,
          text: `${draft.title}\n${draft.description}\n${draft.validationNotes ?? ''}`,
        })),
      });
      if (chainRefs.length > 0 && this.deps.chainEvidence) {
        try {
          chainDigest = await buildChainEvidenceDigest(chainRefs, this.deps.chainEvidence);
        } catch (error) {
          console.warn(
            `[DreamService] Chain evidence digest failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          chainDigest = null;
        }
      }
      const chainRefsByDraftId = new Map<number, string[]>();
      for (const ref of chainRefs) {
        for (const draftId of ref.sourceDraftIds) {
          const list = chainRefsByDraftId.get(draftId) ?? [];
          list.push(ref.kind === 'pin' ? `pin://${ref.id}` : `txid:${ref.id}`);
          chainRefsByDraftId.set(draftId, list);
        }
      }

      // Falsified-history context (design §6.1 P1.3): each pending draft shows
      // its most similar ledger entry so the panel judges with it in view.
      let ledger: CapabilityFalsifiedHypothesis[] = [];
      try {
        ledger = this.deps.coworkStore.listFalsifiedHypotheses(metabot.id, {
          sinceMs: Date.now() - FALSIFIED_RETENTION_DAYS * 86_400_000,
        });
      } catch (error) {
        console.warn(
          `[DreamService] Falsified ledger unavailable for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const similarByDraftId = new Map<number, { title: string; reason: string; falsifiedDate: string }>();
      for (const draft of pending) {
        const similar = findSimilarFalsified(draft.title, ledger);
        if (similar) {
          similarByDraftId.set(draft.id, {
            title: similar.title,
            reason: similar.reason,
            falsifiedDate: formatBotWorkspaceDate(new Date(similar.falsifiedAt)),
          });
        }
      }

      const draftInputs = (drafts: typeof pending) => drafts.map((draft) => ({
        id: draft.id,
        dreamDate: draft.dreamDate,
        title: draft.title,
        description: draft.description,
        capabilityType: draft.capabilityType,
        conflictNote: draft.status === 'disputed' ? draft.validationNotes : null,
        chainRefs: chainRefsByDraftId.get(draft.id) ?? [],
        similarFalsified: similarByDraftId.get(draft.id) ?? null,
      }));
      const summaryInputs = recentSummaries.map((summary) => ({
        summaryDate: summary.summaryDate,
        summaryText: summary.summaryText,
      }));
      const promptA = buildCapabilityValidationPrompt({
        botName: metabot.name,
        date,
        drafts: draftInputs(pending),
        recentSummaries: summaryInputs,
        chainEvidence: chainDigest ? renderChainEvidenceDigest(chainDigest) : null,
        prospective: gate.prospective,
      });
      const rawA = await this.callDreamLlm(promptA.system, promptA.user, brain, 4096);
      const parsedA = parseCapabilityValidationOutput(rawA, new Set(pending.map((draft) => draft.id)));
      if (parsedA.ok === false) {
        console.warn(`[DreamService] Capability validation parse failed for metabot ${metabot.id}: ${parsedA.error}`);
        return {
          ...zero,
          checked: pending.length,
          deferredSameNight,
          chainEvidence: chainDigest ? chainDigest.counts : null,
          panels: { agreed: 0, disagreed: 0, incomplete: pending.length },
        };
      }

      // Panel B (design §6.1 P1.2): the same call with the drafts reversed —
      // a throw or parse failure degrades to an empty verdict list (every
      // draft becomes incomplete), never to a dream-run failure. With a
      // single panel, panel B is panel A.
      let verdictsB: typeof parsedA.verdicts = gate.panels === 1 ? parsedA.verdicts : [];
      if (gate.panels === 2) {
        const promptB = buildCapabilityValidationPrompt({
          botName: metabot.name,
          date,
          drafts: draftInputs([...pending].reverse()),
          recentSummaries: summaryInputs,
          chainEvidence: chainDigest ? renderChainEvidenceDigest(chainDigest) : null,
          prospective: gate.prospective,
        });
        try {
          const rawB = await this.callDreamLlm(promptB.system, promptB.user, brain, 4096);
          const parsedB = parseCapabilityValidationOutput(rawB, new Set(pending.map((draft) => draft.id)));
          verdictsB = parsedB.ok ? parsedB.verdicts : [];
        } catch (error) {
          console.warn(
            `[DreamService] Capability validation panel B failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          verdictsB = [];
        }
      }

      const draftById = new Map(pending.map((draft) => [draft.id, draft]));
      const knownChainRefs = chainDigest ? new Set(chainDigest.knownRefIds) : null;
      const downgradedIds = new Set<number>();
      const panelA = this.groundPanelVerdicts(parsedA.verdicts, draftById, evidenceDates, knownChainRefs, downgradedIds, gate.prospective);
      const panelB = this.groundPanelVerdicts(verdictsB, draftById, evidenceDates, knownChainRefs, downgradedIds, gate.prospective);

      const panels = { agreed: 0, disagreed: 0, incomplete: 0 };
      let validated = 0;
      let rejected = 0;
      const validatedIds: number[] = [];
      for (const draft of pending) {
        const verdictA = panelA.get(draft.id) ?? null;
        const verdictB = panelB.get(draft.id) ?? null;
        const { outcome, agreement } = combinePanelOutcomes(classifyGateVerdict(verdictA), classifyGateVerdict(verdictB));
        panels[agreement] += 1;
        if (outcome === 'hold') continue;
        const scoreA = verdictA?.score ?? 0;
        const scoreB = verdictB?.score ?? 0;
        const joinedNotes = joinPanelRationales(verdictA?.rationale ?? '', verdictB?.rationale ?? '');
        this.deps.coworkStore.updateCapabilityDraftValidation({
          id: draft.id,
          metabotId: metabot.id,
          status: outcome === 'promote' ? 'validated' : 'rejected',
          validationScore: Math.min(scoreA, scoreB),
          validationNotes: joinedNotes,
        });
        if (outcome === 'promote') {
          validated += 1;
          validatedIds.push(draft.id);
        } else {
          rejected += 1;
          // Agreed demotion closes the loop into the falsified ledger (design
          // §6.1 P1.3); a ledger failure never undoes the verdict.
          try {
            this.deps.coworkStore.recordFalsifiedHypothesis({
              metabotId: metabot.id,
              title: draft.title,
              description: draft.description,
              reason: verdictA?.rationale ?? '',
              source: 'validation',
              sourceDraftId: draft.id,
            });
          } catch (error) {
            console.warn(
              `[DreamService] Falsified ledger write failed for metabot ${metabot.id} draft #${draft.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          // RRSI P2: an agreed rejection of a probation ticket flips its
          // procedure out of the hot layer — never archives an agent record.
          if (draft.sourceProcedureId && this.deps.metaidKnowledgeStore) {
            try {
              this.deps.metaidKnowledgeStore.setProcedureHotEligibility(draft.sourceProcedureId, {
                eligible: false,
                reason: 'gate_rejected',
                sourcePass: 'validation',
              });
            } catch (error) {
              console.warn(
                `[DreamService] Gate-reject flip failed for procedure ${draft.sourceProcedureId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
      if (validated > 0 || rejected > 0 || panels.disagreed > 0 || panels.incomplete > 0) {
        console.log(
          `[DreamService] Capability validation for metabot ${metabot.id}: validated=${validated}, rejected=${rejected}, checked=${pending.length}, agreed/disagreed/incomplete=${panels.agreed}/${panels.disagreed}/${panels.incomplete}`,
        );
      }
      return {
        checked: pending.length,
        validated,
        rejected,
        validatedIds,
        chainEvidence: chainDigest ? chainDigest.counts : null,
        deferredSameNight,
        prospectiveDowngraded: downgradedIds.size,
        panels,
        panelsUsed: gate.panels,
      };
    } catch (error) {
      console.warn(
        `[DreamService] Capability validation failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * Shared per-panel verdict grounding (RRSI P1, design §6.1): the date
   * filter, the chain filter, then the prospective downgrade of validated
   * verdicts lacking a post-origin diary citation. Surviving (possibly
   * downgraded) verdicts are keyed by draft id; downgraded ids are recorded
   * in `downgradedIds` for telemetry.
   */
  private groundPanelVerdicts(
    verdicts: Array<{ id: number; verdict: string; score: number; rationale: string }>,
    draftById: Map<number, { id: number; dreamDate: string }>,
    evidenceDates: ReadonlySet<string>,
    knownChainRefs: ReadonlySet<string> | null,
    downgradedIds: Set<number>,
    /** Dream review P3: the prospective guard is never configurable off. */
    prospective: boolean,
  ): Map<number, { id: number; verdict: string; score: number; rationale: string }> {
    const grounded = new Map<number, { id: number; verdict: string; score: number; rationale: string }>();
    let droppedUngrounded = 0;
    let droppedChain = 0;
    for (const verdict of verdicts) {
      // Date grounding: a rationale citing a diary date that was never
      // provided as evidence is a hallucinated citation — drop it.
      if (!citedDiaryDates(verdict.rationale).every((cited) => evidenceDates.has(cited))) {
        droppedUngrounded += 1;
        continue;
      }
      // Chain grounding: with a digest in play, a rationale citing a pin id /
      // txid that was never collected tonight is a hallucinated citation.
      if (knownChainRefs) {
        const citedRefs = chainRefKeysOf(verdict.rationale);
        if (!citedRefs.every((cited) => knownChainRefs.has(cited))) {
          droppedChain += 1;
          continue;
        }
      }
      // Prospective downgrade: a validated verdict must cite a diary date
      // strictly later than the draft's origin date.
      if (
        prospective
        && verdict.verdict === 'validated'
      ) {
        const draft = draftById.get(verdict.id);
        if (
          draft
          && !hasPostOriginCitation({
            rationale: verdict.rationale,
            draftDreamDate: draft.dreamDate,
            evidenceDates,
          })
        ) {
          downgradedIds.add(verdict.id);
          grounded.set(verdict.id, { ...verdict, verdict: 'keep_draft' });
          continue;
        }
      }
      grounded.set(verdict.id, verdict);
    }
    if (droppedUngrounded > 0 || droppedChain > 0) {
      console.warn(
        `[DreamService] Dropped ${droppedUngrounded} ungrounded + ${droppedChain} chain-ungrounded capability verdict(s)`,
      );
    }
    return grounded;
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
  ): Promise<{
    reReviewed: number;
    demoted: number;
    panels: { agreed: number; disagreed: number; incomplete: number };
    /** Dream review P3: how many gate panels this pass actually ran. */
    panelsUsed: 1 | 2;
  }> {
    const zero = {
      reReviewed: 0,
      demoted: 0,
      panels: { agreed: 0, disagreed: 0, incomplete: 0 },
      panelsUsed: 2 as const,
    };
    try {
      const gate = this.resolveGateConfig();
      const pending = this.deps.coworkStore.listReReviewableCapabilityDrafts(metabot.id, {
        olderThanMs: Date.now() - CAPABILITY_REVIEW_INTERVAL_DAYS * 86_400_000,
        limit: CAPABILITY_REVIEW_MAX_PER_NIGHT,
      });
      if (pending.length === 0) return zero;
      const recentSummaries = this.deps.dreamStore.listDailySummaries(
        metabot.id,
        CAPABILITY_VALIDATION_SUMMARY_DAYS,
      );
      // Same grounding set as the fresh gate: the diary dates actually shown.
      const evidenceDates = new Set(recentSummaries.map((summary) => summary.summaryDate));
      const draftInputs = (drafts: typeof pending) => drafts.map((draft) => ({
        id: draft.id,
        dreamDate: draft.dreamDate,
        title: draft.title,
        description: draft.description,
        capabilityType: draft.capabilityType,
      }));
      const summaryInputs = recentSummaries.map((summary) => ({
        summaryDate: summary.summaryDate,
        summaryText: summary.summaryText,
      }));
      const promptA = buildCapabilityValidationPrompt({
        botName: metabot.name,
        date,
        drafts: draftInputs(pending),
        recentSummaries: summaryInputs,
        prospective: gate.prospective,
      });
      const rawA = await this.callDreamLlm(promptA.system, promptA.user, brain, 4096);
      const parsedA = parseCapabilityValidationOutput(rawA, new Set(pending.map((draft) => draft.id)));
      if (parsedA.ok === false) {
        console.warn(`[DreamService] Capability re-review parse failed for metabot ${metabot.id}: ${parsedA.error}`);
        return {
          reReviewed: pending.length,
          demoted: 0,
          panels: { agreed: 0, disagreed: 0, incomplete: pending.length },
          panelsUsed: gate.panels,
        };
      }
      // Panel B mirrors the fresh gate: drafts reversed, failures degrade to
      // an empty verdict list, single-panel configs reuse panel A.
      let verdictsB: typeof parsedA.verdicts = gate.panels === 1 ? parsedA.verdicts : [];
      if (gate.panels === 2) {
        const promptB = buildCapabilityValidationPrompt({
          botName: metabot.name,
          date,
          drafts: draftInputs([...pending].reverse()),
          recentSummaries: summaryInputs,
          prospective: gate.prospective,
        });
        try {
          const rawB = await this.callDreamLlm(promptB.system, promptB.user, brain, 4096);
          const parsedB = parseCapabilityValidationOutput(rawB, new Set(pending.map((draft) => draft.id)));
          verdictsB = parsedB.ok ? parsedB.verdicts : [];
        } catch (error) {
          console.warn(
            `[DreamService] Capability re-review panel B failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          verdictsB = [];
        }
      }

      const draftById = new Map(pending.map((draft) => [draft.id, draft]));
      const downgradedIds = new Set<number>();
      const panelA = this.groundPanelVerdicts(parsedA.verdicts, draftById, evidenceDates, null, downgradedIds, gate.prospective);
      const panelB = this.groundPanelVerdicts(verdictsB, draftById, evidenceDates, null, downgradedIds, gate.prospective);

      const panels = { agreed: 0, disagreed: 0, incomplete: 0 };
      let demoted = 0;
      for (const draft of pending) {
        const verdictA = panelA.get(draft.id) ?? null;
        const verdictB = panelB.get(draft.id) ?? null;
        const { outcome, agreement } = combinePanelOutcomes(classifyReReviewVerdict(verdictA), classifyReReviewVerdict(verdictB));
        panels[agreement] += 1;
        // Incomplete: a transient failure retries the next night — the review
        // clock is NOT refreshed, so the draft stays selected.
        if (agreement === 'incomplete') continue;
        const scoreA = verdictA?.score ?? 0;
        const scoreB = verdictB?.score ?? 0;
        const joinedNotes = joinPanelRationales(verdictA?.rationale ?? '', verdictB?.rationale ?? '');
        if (outcome === 'demote') {
          this.deps.coworkStore.updateCapabilityDraftValidation({
            id: draft.id,
            metabotId: metabot.id,
            status: 'rejected',
            validationScore: Math.min(scoreA, scoreB),
            validationNotes: joinedNotes,
          });
          demoted += 1;
          // Loop closure: a demoted technique must not survive as hardened
          // procedure memory either. The procedure's title is the draft's
          // (the promotion pass writes it that way). RRSI P2: a probation
          // procedure (agent-authored) only leaves the hot layer with a
          // 'demoted' note — it is never archived.
          if (draft.promotedProcedureId && this.deps.metaidKnowledgeStore) {
            try {
              if (draft.sourceProcedureId) {
                this.deps.metaidKnowledgeStore.setProcedureHotEligibility(draft.sourceProcedureId, {
                  eligible: false,
                  reason: 'demoted',
                  sourcePass: 're_review',
                });
              } else {
                this.deps.metaidKnowledgeStore.archiveProcedureByTitle(metabot.id, draft.title);
              }
            } catch (error) {
              console.warn(
                `[DreamService] Demoting the promoted procedure for draft #${draft.id} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          // An AGREED demotion also lands in the falsified ledger (design
          // §6.1 P1.3); a ledger failure never undoes the demotion.
          try {
            this.deps.coworkStore.recordFalsifiedHypothesis({
              metabotId: metabot.id,
              title: draft.title,
              description: draft.description,
              reason: verdictA?.rationale ?? '',
              source: 're_review',
              sourceDraftId: draft.id,
            });
          } catch (error) {
            console.warn(
              `[DreamService] Falsified ledger write failed for metabot ${metabot.id} draft #${draft.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }
        // The row survives the panel: refresh the review bookkeeping (an
        // agreed maintained verdict also takes the panels' fresh score; a
        // disagreement records itself in the notes).
        this.deps.coworkStore.markCapabilityDraftReviewed({
          id: draft.id,
          metabotId: metabot.id,
          validationScore: outcome === 'promote' ? Math.min(scoreA, scoreB) : null,
          validationNotes: agreement === 'disagreed' ? `panels disagreed — ${joinedNotes}` : joinedNotes,
        });
      }
      console.log(
        `[DreamService] Capability re-review for metabot ${metabot.id}: reReviewed=${pending.length}, demoted=${demoted}, agreed/disagreed/incomplete=${panels.agreed}/${panels.disagreed}/${panels.incomplete}`,
      );
      return { reReviewed: pending.length, demoted, panels, panelsUsed: gate.panels };
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
   * >= CAPABILITY_PROMOTION_MIN_SCORE, and was never promoted. Per-night the
   * pass promotes at most the annealed budget (RRSI P2, design §6.2 P2.1):
   * promotionBudgetForNight over the bot's completed non-empty nights — up to
   * 3 for a fresh bot, annealing to 1 after 60 active nights. The candidate
   * query reads up to 50 rows so the telemetry can report how many were
   * actually eligible. The procedure keeps the draft's title as its own
   * (upsert-by-fingerprint dedupes against existing procedures), the trigger
   * mirrors the title, and the actionable description becomes the single
   * ordered step; the draft rows back-link to the procedure id for provenance
   * (procedures have no generic sources table). Runs synchronously after the
   * validation gate and never affects the dream run's recorded outcome.
   */
  private promoteCapabilityDraftsToProcedures(
    metabot: DreamMetabotLike,
    date: string,
  ): { promoted: number; nights: number; budget: number; candidates: number } {
    const zero = { promoted: 0, nights: 0, budget: 0, candidates: 0 };
    try {
      if (!this.deps.metaidKnowledgeStore) return zero;
      const { startMs } = getDayBoundsMs(date);
      // RRSI P2: the nightly budget anneals with the bot's dream history; a
      // count failure degrades to "no history" (the max budget), never skips
      // the pass.
      let nights = 0;
      try {
        nights = this.deps.dreamStore.countNonEmptyDreamNights(metabot.id, date);
      } catch (error) {
        console.warn(
          `[DreamService] Non-empty-night count failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const budget = promotionBudgetForNight(nights);
      const candidates = this.deps.coworkStore.listPromotableCapabilityDrafts(metabot.id, {
        minScore: CAPABILITY_PROMOTION_MIN_SCORE,
        validatedBeforeMs: startMs,
        limit: 50,
      });
      let promoted = 0;
      for (const draft of candidates.slice(0, budget)) {
        try {
          // RRSI P2: promoting a probation ticket only flips its procedure
          // hot — the agent-authored body is never rewritten, and a missing
          // or archived source rejects the ticket with a note (no ledger row:
          // nothing was falsified).
          if (draft.sourceProcedureId) {
            // RRSI P5: a situational probation verdict never hardens its
            // source hot — the procedure becomes recall-only instead (design
            // §6.5 P5.2), still counted against the night's budget.
            const flipped = this.deps.metaidKnowledgeStore.setProcedureHotEligibility(draft.sourceProcedureId, {
              eligible: draft.scope !== 'situational',
              reason: draft.scope === 'situational' ? 'situational' : null,
              sourcePass: 'promotion',
            });
            if (!flipped) {
              this.deps.coworkStore.updateCapabilityDraftValidation({
                id: draft.id,
                metabotId: metabot.id,
                status: 'rejected',
                validationNotes: 'source procedure no longer active',
              });
              continue;
            }
            const marked = this.deps.coworkStore.markCapabilityDraftPromoted({
              id: draft.id,
              metabotId: metabot.id,
              procedureId: draft.sourceProcedureId,
            });
            if (marked) promoted += 1;
            continue;
          }
          // Design §4.4: a reconciled draft carries its applicability
          // conditions into the procedure's trigger and its residual
          // uncertainty into the pitfalls — the conditions under which the
          // lesson was observed survive the hardening.
          const result = this.deps.metaidKnowledgeStore.upsertProcedure({
            metabotId: metabot.id,
            title: draft.title,
            triggerText: draft.conditionsText
              ? truncateUtf16Units(`${draft.title}(适用条件:${draft.conditionsText})`, 500)
              : draft.title,
            steps: [draft.description],
            pitfalls: draft.uncertaintyText ? [`Untested: ${draft.uncertaintyText}`] : [],
            tags: ['capability-draft', draft.capabilityType],
            origin: 'dream',
          });
          // RRSI P5: a newly created situational procedure hardens
          // recall-only (hot_reason = 'situational'); when the upsert merged
          // into an existing same-title procedure, its hot standing stays
          // untouched — a situational lesson must not demote a general
          // procedure that shares its title (plan P5 Task 3).
          if (draft.scope === 'situational' && result.created) {
            this.deps.metaidKnowledgeStore.setProcedureHotEligibility(result.entry.id, {
              eligible: false,
              reason: 'situational',
              sourcePass: 'promotion',
            });
          }
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
      return { promoted, nights, budget, candidates: candidates.length };
    } catch (error) {
      console.warn(
        `[DreamService] Capability promotion pass failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * RRSI P3 usage audit (design §6.3 P3.1): after promotion, one bounded LLM
   * call compares the day's exposed hot-layer items with sampled assistant
   * replies and writes applied/evidence verdicts into hot_layer_usage. Only
   * audited rows count as evidence — an exposure never judged (no replies to
   * sample, item source gone, parse failure, item missing from the verdict
   * list) neither earns nor loses standing. Best-effort: any failure returns
   * the zero result and never fails the dream run.
   */
  /**
   * RRSI P3 usage audit (design §6.3 P3.1), extended by dream review P1
   * (2026-10-23) to ALL hot-layer kinds: techniques, procedures, knowledge
   * hot-layer entries and injected value_boundary / work_review memories.
   * One bounded LLM call compares the day's exposed items with sampled
   * assistant replies (≤40 excerpts) and writes applied/evidence verdicts into
   * hot_layer_usage. Only audited rows count as evidence — an exposure never
   * judged (no replies to sample, item source gone, parse failure, item
   * missing from the verdict list) neither earns nor loses standing. Applied
   * 'memory' verdicts additionally stamp user_memories.last_applied_at — the
   * "was actually used" signal (injection touches last_used_at). Best-effort:
   * any failure returns the zero result and never fails the dream run.
   */
  private async runHotLayerUsageAudit(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
    activity: DreamDayActivity,
  ): Promise<{
    ran: boolean;
    items: number;
    applied: number;
    excerpts: number;
    parseFailed: boolean;
    knowledgeItems: number;
    knowledgeApplied: number;
    memoryItems: number;
    memoryApplied: number;
  }> {
    const zero = {
      ran: false, items: 0, applied: 0, excerpts: 0, parseFailed: false,
      knowledgeItems: 0, knowledgeApplied: 0, memoryItems: 0, memoryApplied: 0,
    };
    try {
      const exposures = this.deps.dreamStore.listHotLayerExposures(metabot.id, date);
      if (exposures.length === 0) return zero;
      const excerpts = sampleUsageAuditExcerpts(activity.sessions ?? []);
      if (excerpts.length === 0) return zero;
      const techniqueProcedureItems: UsageAuditItem[] = [];
      const knowledgeItems: UsageAuditItem[] = [];
      const memoryItems: UsageAuditItem[] = [];
      let memoryById: Map<string, CoworkUserMemory> | null = null;
      // The pools form from a wide slice so an extreme technique/procedure
      // day cannot crowd knowledge/memory out of the pools themselves before
      // the per-kind quotas below ever see them (review Minor 4).
      for (const exposure of selectUsageAuditItems(exposures, USAGE_AUDIT_MAX_ITEMS_TOTAL * 4)) {
        if (exposure.kind === 'technique') {
          const draft = this.deps.coworkStore.getCapabilityDraft(metabot.id, Number(exposure.itemId));
          if (!draft) continue;
          techniqueProcedureItems.push({
            ref: `technique:${exposure.itemId}`,
            kind: 'technique',
            itemId: exposure.itemId,
            title: draft.title,
            gist: truncateUtf16Units(draft.description, USAGE_AUDIT_ITEM_GIST_CHARS),
          });
        } else if (exposure.kind === 'procedure') {
          const procedure = this.deps.metaidKnowledgeStore?.getProcedure(exposure.itemId) ?? null;
          if (!procedure) continue;
          techniqueProcedureItems.push({
            ref: `procedure:${exposure.itemId}`,
            kind: 'procedure',
            itemId: exposure.itemId,
            title: procedure.title,
            gist: truncateUtf16Units(`${procedure.triggerText};${procedure.steps[0] ?? ''}`, USAGE_AUDIT_ITEM_GIST_CHARS),
          });
        } else if (exposure.kind === 'knowledge') {
          const knowledge = this.deps.metaidKnowledgeStore?.getKnowledge(exposure.itemId) ?? null;
          if (!knowledge || knowledge.status !== 'active') continue;
          knowledgeItems.push({
            ref: `knowledge:${exposure.itemId}`,
            kind: 'knowledge',
            itemId: exposure.itemId,
            title: knowledge.topic,
            gist: truncateUtf16Units(`${knowledge.topic};${knowledge.summary}`, USAGE_AUDIT_ITEM_GIST_CHARS),
          });
        } else if (exposure.kind === 'memory') {
          // Two bounded lookups total (not per exposure): the guidance
          // classes the exposure ledger records for kind 'memory'.
          if (!memoryById) {
            memoryById = new Map();
            for (const usageClass of ['value_boundary', 'work_review'] as const) {
              for (const entry of this.deps.coworkStore.listUserMemories({
                metabotId: metabot.id,
                usageClass,
                status: 'all',
                limit: 500,
              })) {
                memoryById.set(entry.id, entry);
              }
            }
          }
          const memory = memoryById.get(exposure.itemId);
          if (!memory) continue;
          memoryItems.push({
            ref: `memory:${exposure.itemId}`,
            kind: 'memory',
            itemId: exposure.itemId,
            title: truncateUtf16Units(memory.text, 40),
            gist: truncateUtf16Units(memory.text, USAGE_AUDIT_ITEM_GIST_CHARS),
          });
        }
      }
      // One shared call. Review Minor 4 (audit starvation): a busy bot can
      // expose far more than the cap in techniques/procedures alone, which
      // under a pure technique-first fill would starve knowledge/memory of
      // EVERY audit. Reserve up to 4 slots per new kind when their pools are
      // non-empty and let techniques/procedures take the remainder (legacy
      // priority inside each band).
      const knowledgeCap = knowledgeItems.length > 0 ? Math.min(4, knowledgeItems.length) : 0;
      const memoryCap = memoryItems.length > 0 ? Math.min(4, memoryItems.length) : 0;
      const techniqueProcedureCap = Math.max(
        0,
        USAGE_AUDIT_MAX_ITEMS_TOTAL - knowledgeCap - memoryCap,
      );
      const items = [
        ...techniqueProcedureItems.slice(0, techniqueProcedureCap),
        ...knowledgeItems.slice(0, knowledgeCap),
        ...memoryItems.slice(0, memoryCap),
      ].slice(0, USAGE_AUDIT_MAX_ITEMS_TOTAL);
      if (items.length === 0) return zero;
      const prompt = buildHotLayerUsageAuditPrompt({ date, items, excerpts });
      const raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 2048);
      const parsed = parseHotLayerUsageAuditOutput(
        raw,
        new Set(items.map((item) => item.ref)),
        new Set(excerpts.map((excerpt) => excerpt.label)),
      );
      const byKindCounts = {
        knowledgeItems: items.filter((item) => item.kind === 'knowledge').length,
        memoryItems: items.filter((item) => item.kind === 'memory').length,
        knowledgeApplied: 0,
        memoryApplied: 0,
      };
      if (parsed.ok === false) {
        return {
          ran: true, items: items.length, applied: 0, excerpts: excerpts.length, parseFailed: true,
          ...byKindCounts,
        };
      }
      const channelByLabel = new Map(excerpts.map((excerpt) => [excerpt.label, excerpt.channel]));
      const mapped: Array<{
        kind: 'technique' | 'procedure' | 'knowledge' | 'memory';
        itemId: string;
        applied: boolean;
        evidence: { labels: string[]; channels: Array<'owner' | 'external'> };
      }> = [];
      let applied = 0;
      for (const verdict of parsed.verdicts) {
        const item = items.find((entry) => entry.ref === verdict.ref);
        if (!item) continue;
        const channels: Array<'owner' | 'external'> = [];
        for (const label of verdict.labels) {
          const channel = channelByLabel.get(label);
          if ((channel === 'owner' || channel === 'external') && !channels.includes(channel)) {
            channels.push(channel);
          }
        }
        if (verdict.applied) {
          applied += 1;
          if (item.kind === 'knowledge') byKindCounts.knowledgeApplied += 1;
          if (item.kind === 'memory') byKindCounts.memoryApplied += 1;
        }
        mapped.push({ kind: item.kind, itemId: item.itemId, applied: verdict.applied, evidence: { labels: verdict.labels, channels } });
      }
      this.deps.dreamStore.recordHotLayerUsageVerdicts(metabot.id, date, mapped, this.now().getTime());
      // The "was actually used" stamp: applied guidance memories move off the
      // injection clock onto the applied clock for hygiene decay + eviction.
      const appliedMemoryIds = mapped
        .filter((verdict) => verdict.kind === 'memory' && verdict.applied)
        .map((verdict) => verdict.itemId);
      if (appliedMemoryIds.length > 0) {
        this.deps.coworkStore.touchUserMemoriesLastApplied(metabot.id, appliedMemoryIds);
      }
      return {
        ran: true, items: items.length, applied, excerpts: excerpts.length, parseFailed: false,
        ...byKindCounts,
      };
    } catch (error) {
      console.warn(
        `[DreamService] Usage audit failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * RRSI P3 L1 pruning (design §6.3 P3.3): after the usage audit, demote the
   * worst-earning hot-layer items — past their 14-day grace, ≥5 audited hot
   * nights in the trailing 30 days, applied on none. A technique moves to the
   * 'dormant' draft status; a procedure becomes recall-only with
   * hot_reason 'unused'. At most 2 demotions per night across BOTH kinds
   * (one shared candidate list). Nothing is deleted. The reference clock is
   * the dreamed date's day end, so a repair re-run judges identically.
   * Best-effort: any failure returns the zero result.
   */
  private pruneHotLayerAfterDream(
    metabot: DreamMetabotLike,
    date: string,
  ): { demotedTechniques: number; demotedProcedures: number; reentered: number } {
    const zero = { demotedTechniques: 0, demotedProcedures: 0, reentered: 0 };
    try {
      const refMs = getDayBoundsMs(date).endMs;
      const sinceDate = shiftDateKey(date, -(HOT_LAYER_UTILITY_WINDOW_DAYS - 1));
      // RRSI P3 re-entry (design §6.3 P3.3), before demotion: an `unused`
      // procedure applied again on ≥2 audited nights within the re-entry
      // window turns hot with a fresh hot_since (the grace period restarts).
      // Only hot_reason 'unused' ever re-enters through usage evidence.
      const reenteredIds = new Set<string>();
      let reentered = 0;
      // Review Minor 1: cooled knowledge re-enters the hot pool under the
      // SAME rule as unused procedures — ≥2 applied nights within the
      // trailing 14-day window (recall exposure rows now feed appliedNights
      // via the knowledge_recall ledger).
      const knowledgeReentryCandidates = this.deps.metaidKnowledgeStore
        ? this.deps.metaidKnowledgeStore.listCooledKnowledge(metabot.id)
        : [];
      if (knowledgeReentryCandidates.length > 0) {
        const knowledgeReentryStats = this.deps.dreamStore.listHotLayerUsageStats(metabot.id, {
          kind: 'knowledge',
          sinceDate: shiftDateKey(date, -(HOT_LAYER_REENTRY_WINDOW_DAYS - 1)),
          untilDate: date,
        });
        for (const entry of knowledgeReentryCandidates) {
          if ((knowledgeReentryStats.get(entry.id)?.appliedNights ?? 0) >= HOT_LAYER_REENTRY_MIN_APPLIED_NIGHTS) {
            const flipped = this.deps.metaidKnowledgeStore?.setKnowledgeHotEligibility(entry.id, {
              eligible: true,
              atMs: this.now().getTime(),
            });
            if (flipped) reentered += 1;
          }
        }
      }
      const reentryCandidates = this.deps.metaidKnowledgeStore
        ? this.deps.metaidKnowledgeStore.listUnusedProcedures(metabot.id)
        : [];
      if (reentryCandidates.length > 0) {
        const reentryStats = this.deps.dreamStore.listHotLayerUsageStats(metabot.id, {
          kind: 'procedure',
          sinceDate: shiftDateKey(date, -(HOT_LAYER_REENTRY_WINDOW_DAYS - 1)),
          untilDate: date,
        });
        const reentries = selectHotLayerReentries(
          reentryCandidates.map((entry) => ({
            entry,
            key: entry.id,
            kind: 'procedure' as const,
            hotSinceMs: entry.hotSince ?? entry.createdAt,
            appliedNights: reentryStats.get(entry.id)?.appliedNights ?? 0,
            exposedNights: reentryStats.get(entry.id)?.exposedNights ?? 0,
          })),
          { minAppliedNights: HOT_LAYER_REENTRY_MIN_APPLIED_NIGHTS },
        );
        for (const candidate of reentries) {
          const flipped = this.deps.metaidKnowledgeStore?.setProcedureHotEligibility(candidate.entry.id, {
            eligible: true,
            reason: null,
            atMs: this.now().getTime(),
            sourcePass: 'pruning',
          });
          if (flipped) {
            reentered += 1;
            reenteredIds.add(candidate.entry.id);
          }
        }
      }
      const techniqueCandidates = this.deps.coworkStore
        .listCapabilityDrafts(metabot.id, { status: 'validated' })
        .filter((draft) => draft.promotedAt === null)
        .map((draft) => ({
          draft,
          key: `technique:${draft.id}`,
          kind: 'technique' as const,
          hotSinceMs: draft.validatedAt ?? draft.createdAt,
          appliedNights: 0,
          exposedNights: 0,
        }));
      const techniqueStats = this.deps.dreamStore.listHotLayerUsageStats(metabot.id, {
        kind: 'technique', sinceDate, untilDate: date,
      });
      for (const candidate of techniqueCandidates) {
        const stats = techniqueStats.get(String(candidate.draft.id));
        candidate.appliedNights = stats?.appliedNights ?? 0;
        candidate.exposedNights = stats?.exposedNights ?? 0;
      }
      const procedureCandidates = (this.deps.metaidKnowledgeStore
        ? this.deps.metaidKnowledgeStore.listHotProcedures(metabot.id, { limit: 200, nowMs: refMs })
        : []
      )
        .filter((entry) => !reenteredIds.has(entry.id))
        .map((entry) => ({
          entry,
          key: `procedure:${entry.id}`,
          kind: 'procedure' as const,
          hotSinceMs: entry.hotSince ?? entry.createdAt,
          appliedNights: 0,
          exposedNights: 0,
        }));
      const procedureStats = this.deps.dreamStore.listHotLayerUsageStats(metabot.id, {
        kind: 'procedure', sinceDate, untilDate: date,
      });
      for (const candidate of procedureCandidates) {
        const stats = procedureStats.get(candidate.entry.id);
        candidate.appliedNights = stats?.appliedNights ?? 0;
        candidate.exposedNights = stats?.exposedNights ?? 0;
      }
      const demotions = selectHotLayerDemotions([...techniqueCandidates, ...procedureCandidates], { nowMs: refMs });
      let demotedTechniques = 0;
      let demotedProcedures = 0;
      for (const candidate of demotions) {
        if (candidate.kind === 'technique') {
          const marked = this.deps.coworkStore.markCapabilityDraftDormant({
            id: candidate.draft.id,
            metabotId: metabot.id,
            atMs: this.now().getTime(),
            note: `dormant ${date}: shown on ${candidate.exposedNights} audited nights, applied on none`,
          });
          if (marked) demotedTechniques += 1;
        } else {
          const flipped = this.deps.metaidKnowledgeStore?.setProcedureHotEligibility(candidate.entry.id, {
            eligible: false,
            reason: 'unused',
            sourcePass: 'pruning',
          });
          if (flipped) demotedProcedures += 1;
        }
      }
      return { demotedTechniques, demotedProcedures, reentered };
    } catch (error) {
      console.warn(
        `[DreamService] Hot-layer pruning failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * Dream review P1 — knowledge hot-layer cooling, mirroring the
   * technique/procedure pruning above: an ACTIVE knowledge entry past its
   * 14-day grace (updated_at as the hot-entry proxy — knowledge rows carry no
   * hot_since) with ≥5 audited hot exposure nights in the trailing 30-day
   * window and zero applied nights leaves the proactive <knowledge> injection
   * pool (hot_eligible = 0). Nothing is deleted and recall keeps returning the
   * entry. At most 2 coolings per night. The reference clock is the dreamed
   * date's day end. Best-effort: any failure returns the zero result.
   */
  private coolHotKnowledgeAfterDream(
    metabot: DreamMetabotLike,
    date: string,
  ): { cooled: number } {
    const zero = { cooled: 0 };
    try {
      if (!this.deps.metaidKnowledgeStore) return zero;
      const refMs = getDayBoundsMs(date).endMs;
      const sinceDate = shiftDateKey(date, -(HOT_LAYER_UTILITY_WINDOW_DAYS - 1));
      const stats = this.deps.dreamStore.listHotLayerUsageStats(metabot.id, {
        kind: 'knowledge',
        sinceDate,
        untilDate: date,
      });
      if (stats.size === 0) return zero;
      const candidates: Array<{
        entry: MetaIDKnowledgeEntry;
        key: string;
        kind: 'knowledge';
        hotSinceMs: number;
        appliedNights: number;
        exposedNights: number;
      }> = [];
      for (const [itemId, itemStats] of stats) {
        const entry = this.deps.metaidKnowledgeStore.getKnowledge(itemId);
        if (!entry || entry.status !== 'active') continue;
        if (entry.hotEligible === false) continue;
        candidates.push({
          entry,
          key: `knowledge:${itemId}`,
          kind: 'knowledge',
          hotSinceMs: entry.updatedAt ?? entry.createdAt,
          appliedNights: itemStats.appliedNights,
          exposedNights: itemStats.exposedNights,
        });
      }
      const cooled = selectHotLayerDemotions(candidates, { nowMs: refMs });
      let cooledCount = 0;
      for (const candidate of cooled) {
        const flipped = this.deps.metaidKnowledgeStore.setKnowledgeHotEligibility(candidate.entry.id, {
          eligible: false,
          atMs: this.now().getTime(),
        });
        if (flipped) {
          cooledCount += 1;
          console.log(
            `[DreamService] Knowledge "${candidate.entry.topic}" cooled out of the hot pool for metabot ${metabot.id}: ${candidate.exposedNights} audited hot nights, applied on none`,
          );
        }
      }
      return { cooled: cooledCount };
    } catch (error) {
      console.warn(
        `[DreamService] Knowledge cooling failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * Dream review P2-1 (design 2026-10-10 §P2.5): the frozen per-bot exam —
   * the comparable "is the bot getting sharper" signal. Runs at most once
   * per bot per week, only after the bot has ≥14 days of dream data, inside
   * a read_only isolated session (no writes possible). The paper is built
   * from the bot's own sediment and hash-frozen; re-runs score the SAME
   * paper until the sediment changes enough to change the hash. Best-effort:
   * any failure lands on the run row and never blocks the dream run.
   */
  private async maybeRunMetabotExam(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
  ): Promise<{ ran: boolean; score: number | null; questions: number; scoredCount: number }> {
    const zero = { ran: false, score: null as number | null, questions: 0, scoredCount: 0 };
    try {
      if (!this.deps.runExamSession) return zero;
      const dreamStore = this.deps.dreamStore;
      // Weekly cap: one exam run per bot per 7 days, counted from the last
      // START (a crashed run still consumed its week's budget).
      const latestRun = dreamStore.getLatestExamRun(metabot.id);
      if (latestRun && this.now().getTime() - latestRun.startedAt < EXAM_RUN_INTERVAL_DAYS * 86_400_000) {
        return zero;
      }
      // Data gate: younger than 14 days of dream data → nothing to examine.
      const summaries = dreamStore.listDailySummaries(metabot.id, 400);
      if (summaries.length === 0) return zero;
      const oldestSummary = summaries[summaries.length - 1];
      if (!oldestSummary || !oldestSummary.summaryDate) return zero;
      const [year, month, day] = date.split('-').map((part) => Number(part));
      const dateMs = new Date(year, (month || 1) - 1, (day || 1)).getTime();
      const oldestMs = new Date(oldestSummary.summaryDate + 'T00:00:00').getTime();
      if (!Number.isFinite(oldestMs) || (dateMs - oldestMs) / 86_400_000 < EXAM_MIN_DATA_DAYS) {
        return zero;
      }

      // Assemble the sediment and build (or reuse) the frozen paper.
      // Review M6a: the sediment pool must order by a STABLE key — the
      // generic listUserMemories sorts by COALESCE(last_used_at, updated_at),
      // and last_used_at moves on every injection, which would reorder the
      // pool between runs and flip the paper's hash without any real change.
      const valueBoundaries = dreamStore.listExamSedimentMemories(metabot.id, 'value_boundary', 20);
      const workReviews = dreamStore.listExamSedimentMemories(metabot.id, 'work_review', 20);
      const knowledgeEntries = (this.deps.metaidKnowledgeStore
        ? this.deps.metaidKnowledgeStore.listKnowledge({ metabotId: metabot.id, status: 'active', limit: 20 })
        : []
      ).map((entry) => ({ id: entry.id, topic: entry.topic, summary: entry.summary, updatedAt: entry.updatedAt }));
      const built = buildMetabotExam({
        valueBoundaries,
        workReviews,
        knowledgeEntries,
        feedbackEvents: dreamStore.listFeedbackEventsWithComments(metabot.id),
        groupTaskComments: dreamStore.listGroupTaskReviewComments(metabot.id),
      });
      if (!built) return zero;
      const nowMs = this.now().getTime();
      const frozen = dreamStore.freezeExam(metabot.id, built.contentHash, built.questions, nowMs);
      if (!frozen) return zero;
      // Same hash → keep the frozen paper's questions (never rebuild).
      const active = dreamStore.getActiveExam(metabot.id);
      const questions = (active?.questions ?? built.questions) as ExamQuestion[];
      const exam: MetabotExam = { contentHash: frozen.contentHash, questions };
      if (questions.length === 0) return zero;

      // Answer pass: read_only isolated session; scoring pass: the brain model
      // judges against the frozen rubric.
      const runId = dreamStore.createExamRun(metabot.id, frozen.id, nowMs);
      try {
        const answers = await this.deps.runExamSession({
          metabotId: metabot.id,
          userMessage: buildExamSessionPrompt({ botName: metabot.name, exam }),
        });
        const scoring = buildExamScoringPrompt({ botName: metabot.name, exam, answers });
        const raw = await this.callDreamLlm(scoring.system, scoring.user, brain, 4096);
        const parsed = parseExamScores(raw, new Set(questions.map((question) => question.id)));
        if (!parsed.ok) throw new Error(`exam scoring parse failed: ${(parsed as { ok: false; error: string }).error}`);
        dreamStore.finishExamRun({
          id: runId,
          status: 'done',
          finishedAt: this.now().getTime(),
          totalScore: parsed.total,
          scoredCount: parsed.scoredCount,
          questionScores: parsed.scores,
        });
        // Review M6b: a PARTIAL verdict (scorer skipped questions) is not a
        // low score — report it as score:null so the trend gaps instead of
        // dipping, and carry scoredCount for the audit trail.
        const complete = parsed.scoredCount >= parsed.expectedCount;
        console.log(
          `[DreamService] Frozen exam for metabot ${metabot.id} (${date}): score=${complete ? parsed.total.toFixed(2) : 'partial'}, `
          + `scored=${parsed.scoredCount}/${parsed.expectedCount}, hash=${frozen.contentHash.slice(0, 8)}`,
        );
        return {
          ran: true,
          score: complete ? parsed.total : null,
          questions: questions.length,
          scoredCount: parsed.scoredCount,
        };
      } catch (error) {
        dreamStore.finishExamRun({
          id: runId,
          status: 'failed',
          finishedAt: this.now().getTime(),
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(
          `[DreamService] Frozen exam run failed for metabot ${metabot.id} date ${date}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { ran: true, score: null, questions: questions.length, scoredCount: 0 };
      }
    } catch (error) {
      console.warn(
        `[DreamService] Frozen exam pass failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * Memory reconciliation pass (design 2026-10-10 §4.2/§4.3): between
   * validation and promotion, tonight's newly validated drafts are checked
   * against the WHOLE memory bank. The host computes conflict candidates
   * (token overlap against active procedures and other validated drafts); the
   * LLM judges keep/narrow/merge/dispute; the host executes the verdicts by
   * fixed template (annotate / template-narrow / merge-by-reference /
   * suspend) — the model never edits the store directly.
   */
  private async reconcileValidatedCapabilityDrafts(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
    validatedIds: number[],
  ): Promise<{
    considered: number;
    kept: number;
    narrowed: number;
    merged: number;
    disputed: number;
    scope: { general: number; situational: number; scorerFitted: number; hardMarkerOverrides: number };
  }> {
    const zero = { considered: 0, kept: 0, narrowed: 0, merged: 0, disputed: 0, scope: ZERO_RECONCILIATION_SCOPE };
    let tonight: Array<{
      id: number;
      dreamDate: string;
      title: string;
      description: string;
      capabilityType: string;
      validationScore: number | null;
      scope: CapabilityScope | null;
    }> = [];
    try {
      if (validatedIds.length === 0) return zero;
      // Re-read the rows: only still-validated drafts reconcile (a demotion
      // between the gate and this pass drops the draft out).
      tonight = this.deps.coworkStore.listCapabilityDrafts(metabot.id, { status: 'validated' })
        .filter((draft) => validatedIds.includes(draft.id))
        .sort((left, right) => (right.validationScore ?? 0) - (left.validationScore ?? 0))
        .slice(0, RECONCILE_MAX_DRAFTS_PER_NIGHT);
      if (tonight.length === 0) return zero;
      const recentSummaries = this.deps.dreamStore.listDailySummaries(
        metabot.id,
        CAPABILITY_VALIDATION_SUMMARY_DAYS,
      );
      const conflictsByDraftId = new Map<number, ReconciliationConflictCandidate[]>();
      for (const draft of tonight) {
        conflictsByDraftId.set(draft.id, this.buildReconciliationConflictCandidates(metabot.id, draft));
      }
      const prompt = buildCapabilityReconciliationPrompt({
        botName: metabot.name,
        date,
        drafts: tonight.map((draft) => ({
          id: draft.id,
          dreamDate: draft.dreamDate,
          title: draft.title,
          description: draft.description,
          capabilityType: draft.capabilityType,
          validationScore: draft.validationScore,
        })),
        conflictsByDraftId,
        recentSummaries: recentSummaries.map((summary) => ({
          summaryDate: summary.summaryDate,
          summaryText: summary.summaryText,
        })),
      });
      const raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 4096);
      const parsed = parseCapabilityReconciliationOutput(raw, new Set(tonight.map((draft) => draft.id)));
      if (!parsed.ok) {
        console.warn(`[DreamService] Reconciliation parse failed for metabot ${metabot.id}: ${(parsed as { ok: false; error: string }).error}`);
        // The host marker rule still runs — a parse failure never shields a
        // marker-titled draft from becoming situational (plan P5 Task 3).
        return {
          ...zero,
          considered: tonight.length,
          scope: this.applyHardMarkerScopeRule(
            metabot.id,
            tonight.map((draft) => ({ id: draft.id, title: draft.title, stillValidated: true, verdictScope: null, storedScope: draft.scope })),
          ),
        };
      }
      const byId = new Map(tonight.map((draft) => [draft.id, draft]));
      const counts = { ...zero, considered: tonight.length };
      // RRSI P5: per-draft effective state for the host marker rule and the
      // scope telemetry — verdictScope is written only by keep/narrow.
      const scopeState = new Map<number, { stillValidated: boolean; verdictScope: CapabilityScope | null; storedScope: CapabilityScope | null }>();
      for (const draft of tonight) {
        scopeState.set(draft.id, { stillValidated: true, verdictScope: null, storedScope: draft.scope });
      }
      for (const verdict of parsed.verdicts) {
        const draft = byId.get(verdict.id);
        if (!draft) continue;
        // RRSI P5 scorer_fitted (design §6.5 P5.2): a lesson that only
        // restates how to get a good rating never keeps/narrows — it moves to
        // disputed and the existing disputed flow re-judges it the next night.
        // No falsified-ledger row: nothing was falsified, only reclassified.
        if ((verdict.action === 'keep' || verdict.action === 'narrow') && verdict.scope === 'scorer_fitted') {
          this.deps.coworkStore.updateCapabilityDraftValidation({
            id: draft.id,
            metabotId: metabot.id,
            status: 'disputed',
            validationScore: draft.validationScore,
            validationNotes: `reconciliation scorer_fitted ${date}${verdict.note ? ` — ${verdict.note}` : ''}`,
          });
          this.deps.coworkStore.setCapabilityDraftScope({ id: draft.id, metabotId: metabot.id, scope: 'scorer_fitted' });
          scopeState.set(draft.id, { stillValidated: false, verdictScope: 'scorer_fitted', storedScope: 'scorer_fitted' });
          counts.disputed += 1;
          continue;
        }
        switch (verdict.action) {
          case 'keep':
            this.deps.coworkStore.setCapabilityDraftConditions({
              id: draft.id,
              metabotId: metabot.id,
              conditionsText: verdict.conditions,
              uncertaintyText: verdict.uncertainty,
            });
            this.deps.coworkStore.setCapabilityDraftScope({ id: draft.id, metabotId: metabot.id, scope: verdict.scope });
            scopeState.set(draft.id, { stillValidated: true, verdictScope: verdict.scope, storedScope: verdict.scope });
            counts.kept += 1;
            break;
          case 'narrow':
            this.deps.coworkStore.narrowCapabilityDraft({
              id: draft.id,
              metabotId: metabot.id,
              conditionsText: verdict.conditions,
              uncertaintyText: verdict.uncertainty,
            });
            this.deps.coworkStore.setCapabilityDraftScope({ id: draft.id, metabotId: metabot.id, scope: verdict.scope });
            scopeState.set(draft.id, { stillValidated: true, verdictScope: verdict.scope, storedScope: verdict.scope });
            counts.narrowed += 1;
            break;
          case 'merge': {
            // Grounding gate: the merge target must come from the candidates
            // the host actually presented to the model.
            const targetRef = verdict.conflictsWith.find((ref) => ref.startsWith('procedure:')) ?? '';
            const candidateRefs = new Set((conflictsByDraftId.get(draft.id) ?? []).map((candidate) => candidate.ref));
            const targetId = targetRef.slice('procedure:'.length);
            if (!targetRef || !targetId || !candidateRefs.has(targetRef)) {
              console.warn(
                `[DreamService] Dropped merge verdict for draft #${draft.id}: target ${targetRef || '(none)'} was not a presented candidate`,
              );
              continue;
            }
            if (this.deps.metaidKnowledgeStore) {
              const appended = this.deps.metaidKnowledgeStore.appendProcedurePitfall(
                targetId,
                `Merged dream draft #${draft.id} (${draft.dreamDate}): ${draft.title}`,
              );
              if (!appended) {
                console.warn(
                  `[DreamService] Merge verdict for draft #${draft.id}: pitfall append on ${targetRef} failed (missing/archived/full)`,
                );
              }
            }
            this.deps.coworkStore.updateCapabilityDraftValidation({
              id: draft.id,
              metabotId: metabot.id,
              status: 'rejected',
              validationScore: draft.validationScore,
              validationNotes: `merged into ${targetRef}${verdict.note ? ` — ${verdict.note}` : ''}`,
            });
            scopeState.set(draft.id, { stillValidated: false, verdictScope: null, storedScope: draft.scope });
            counts.merged += 1;
            break;
          }
          case 'dispute':
            this.deps.coworkStore.updateCapabilityDraftValidation({
              id: draft.id,
              metabotId: metabot.id,
              status: 'disputed',
              validationScore: draft.validationScore,
              validationNotes: [
                `reconciliation dispute ${date}`,
                verdict.note || '',
                verdict.conflictsWith.length > 0 ? `conflicts: ${verdict.conflictsWith.join(', ')}` : '',
              ].filter(Boolean).join(' — '),
            });
            scopeState.set(draft.id, { stillValidated: false, verdictScope: null, storedScope: draft.scope });
            counts.disputed += 1;
            break;
        }
      }
      // RRSI P5: run the host marker rule over tonight's drafts (after the
      // verdict loop) and fold its counts into the telemetry.
      const scope = this.applyHardMarkerScopeRule(
        metabot.id,
        tonight.map((draft) => ({
          id: draft.id,
          title: draft.title,
          stillValidated: scopeState.get(draft.id)?.stillValidated ?? true,
          verdictScope: scopeState.get(draft.id)?.verdictScope ?? null,
          storedScope: scopeState.get(draft.id)?.storedScope ?? draft.scope,
        })),
      );
      if (counts.kept + counts.narrowed + counts.merged + counts.disputed > 0) {
        console.log(
          `[DreamService] Reconciliation for metabot ${metabot.id}: considered=${counts.considered}, kept=${counts.kept}, narrowed=${counts.narrowed}, merged=${counts.merged}, disputed=${counts.disputed}`,
        );
      }
      return { ...counts, scope };
    } catch (error) {
      console.warn(
        `[DreamService] Reconciliation failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ...zero,
        scope: this.applyHardMarkerScopeRule(
          metabot.id,
          tonight.map((draft) => ({ id: draft.id, title: draft.title, stillValidated: true, verdictScope: null, storedScope: draft.scope })),
        ),
      };
    }
  }

  /**
   * RRSI P5 host marker rule (design §6.5 P5.1): any tonight draft that is
   * still validated and whose stored scope is not already situational /
   * scorer_fitted becomes situational when its TITLE carries a hard instance
   * marker — even when the panel said general, and even when the LLM call or
   * its parse failed. Also produces the scope telemetry counts over tonight's
   * drafts after the rule ran (drafts without a scope verdict are not
   * counted). Best-effort: never throws.
   */
  private applyHardMarkerScopeRule(
    metabotId: number,
    drafts: ReadonlyArray<{
      id: number;
      title: string;
      stillValidated: boolean;
      verdictScope: CapabilityScope | null;
      storedScope: CapabilityScope | null;
    }>,
  ): { general: number; situational: number; scorerFitted: number; hardMarkerOverrides: number } {
    const counts = { ...ZERO_RECONCILIATION_SCOPE };
    try {
      for (const draft of drafts) {
        if (
          draft.stillValidated
          && draft.storedScope !== 'situational'
          && draft.storedScope !== 'scorer_fitted'
          && titleHasHardInstanceMarker(draft.title)
        ) {
          this.deps.coworkStore.setCapabilityDraftScope({ id: draft.id, metabotId, scope: 'situational' });
          counts.situational += 1;
          counts.hardMarkerOverrides += 1;
          continue;
        }
        if (draft.verdictScope === 'general') counts.general += 1;
        else if (draft.verdictScope === 'situational') counts.situational += 1;
        else if (draft.verdictScope === 'scorer_fitted') counts.scorerFitted += 1;
      }
      return counts;
    } catch (error) {
      console.warn(
        `[DreamService] Hard marker scope rule failed for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ...ZERO_RECONCILIATION_SCOPE };
    }
  }

  /**
   * Host-computed conflict candidates for one draft (design §4.3): active
   * procedures via the store's own tokenized coverage scoring (the
   * listProcedures query path), plus other validated drafts whose
   * title/description shares a precision token with the draft title. Top
   * RECONCILE_MAX_CONFLICT_CANDIDATES, procedures first.
   */
  private buildReconciliationConflictCandidates(
    metabotId: number,
    draft: { id: number; title: string; sourceProcedureId?: string | null },
  ): ReconciliationConflictCandidate[] {
    const candidates: ReconciliationConflictCandidate[] = [];
    if (this.deps.metaidKnowledgeStore) {
      try {
        // RRSI P2: a probation draft never conflicts with (or merges into)
        // its own source procedure — same title by construction.
        const procedures = this.deps.metaidKnowledgeStore.listProcedures({
          metabotId,
          status: 'active',
          query: draft.title,
          limit: RECONCILE_MAX_CONFLICT_CANDIDATES,
        }).filter((procedure) => procedure.id !== draft.sourceProcedureId);
        for (const procedure of procedures) {
          candidates.push({
            ref: `procedure:${procedure.id}`,
            kind: 'procedure',
            title: procedure.title,
            excerpt: [procedure.triggerText, ...procedure.steps].filter(Boolean).join(' / '),
          });
        }
      } catch (error) {
        console.warn(
          `[DreamService] Reconciliation procedure candidates failed for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      const terms = [...new Set(tokenizeKnowledgeBaseText(draft.title))].filter((term) => term.length >= 2);
      if (terms.length > 0) {
        const others = this.deps.coworkStore.listCapabilityDrafts(metabotId, { status: 'validated' })
          .filter((other) => other.id !== draft.id);
        for (const other of others) {
          const haystack = `${other.title}\n${other.description}`.toLowerCase();
          if (terms.some((term) => haystack.includes(term))) {
            candidates.push({
              ref: `draft:${other.id}`,
              kind: 'draft',
              title: other.title,
              excerpt: other.description,
            });
          }
        }
      }
    } catch (error) {
      console.warn(
        `[DreamService] Reconciliation draft candidates failed for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return candidates.slice(0, RECONCILE_MAX_CONFLICT_CANDIDATES);
  }

  /**
   * Self-curriculum consumption pass (design 2026-10-10 §3.4): the practice
   * runs that executed during the dreamed day, each proposal's outcome_summary
   * backfilled from the practice session's final report (minimal version: the
   * last assistant message, truncated). Runs BEFORE prompt building so the
   * outcomes ride tonight's curriculum decision; never fails the dream run.
   */
  private collectPracticeOutcomesForDream(
    metabotId: number,
    dayStartMs: number,
    dayEndMs: number,
  ): { outcomes: DreamPracticeOutcome[]; completed: number; failed: number } {
    const zero = { outcomes: [] as DreamPracticeOutcome[], completed: 0, failed: 0 };
    try {
      const rows = this.deps.coworkStore.listDreamPracticeOutcomesForDay(metabotId, dayStartMs, dayEndMs);
      const outcomes: DreamPracticeOutcome[] = [];
      for (const row of rows) {
        let summary = row.outcomeSummary;
        if (!summary && row.runSessionId) {
          try {
            const session = this.deps.coworkStore.getSession(row.runSessionId);
            const reply = session ? extractFinalAssistantReply(session.messages).replyText : '';
            if (reply.trim()) {
              summary = truncateUtf16Units(reply.trim(), PRACTICE_OUTCOME_MAX_CHARS);
              this.deps.coworkStore.updateDreamPracticeProposalOutcome({
                id: row.id,
                metabotId,
                outcomeSummary: summary,
              });
            }
          } catch (error) {
            console.warn(
              `[DreamService] Practice outcome backfill failed for proposal #${row.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        outcomes.push({
          title: row.title,
          status: row.status === 'completed' ? 'completed' : 'failed',
          expectedEvidence: row.expectedEvidence,
          outcomeSummary: summary,
        });
      }
      return {
        outcomes,
        completed: outcomes.filter((outcome) => outcome.status === 'completed').length,
        failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      };
    } catch (error) {
      console.warn(
        `[DreamService] Practice outcome collection failed for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * The self-curriculum pipeline's compound enable gate (design §3.4): both
   * practiceTasksEnabled AND practiceAutoApproveReadOnly must be on. Both
   * default OFF, so default installs skip the nightly proposal ask and the
   * proposal persistence entirely instead of paying tokens and dead rows for
   * a pipeline that would never run. A policy read failure falls back to
   * enabled (previous behavior) so a store hiccup never silently rewrites the
   * contract.
   */
  private isPracticePipelineEnabled(metabotId: number): boolean {
    try {
      const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(metabotId);
      return Boolean(policy.practiceTasksEnabled && policy.practiceAutoApproveReadOnly);
    } catch (error) {
      console.warn(
        `[DreamService] Practice policy read failed for metabot ${metabotId}; treating practice as enabled: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  /**
   * Self-curriculum approval + materialization (design §3.4, owner decisions
   * §8): with the per-bot practiceTasksEnabled flag ON and
   * practiceAutoApproveReadOnly on, pending read_only proposals auto-approve
   * (oldest first, capped at the same 2/night as generation) and materialize
   * into one-shot ScheduledTasks inside the night study window.
   * interact_local / chain_write proposals stay pending for the owner —
   * chain_write never executes in this iteration. Feature OFF (the default)
   * is a zero-side-effect no-op. Never fails the dream run.
   *
   * RRSI P4 (design §6.4): while stalled, the read-only drain puts proposals
   * in under-explored components first — an ordering-only novelty bonus, no
   * extra approvals and no loosened risk rules.
   */
  private processPracticeProposalsAfterDream(
    metabot: DreamMetabotLike,
    exploration: { stalled: boolean; underExplored: readonly PracticeComponent[] },
  ): { autoApproved: number; materialized: number } {
    const zero = { autoApproved: 0, materialized: 0 };
    try {
      const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(metabot.id);
      if (!policy.practiceTasksEnabled || !policy.practiceAutoApproveReadOnly) return zero;
      const createTask = this.deps.createPracticeScheduledTask;
      if (!createTask) return zero;
      const pending = orderPracticeProposalsForApproval(
        this.deps.coworkStore.listDreamPracticeProposals(metabot.id, { status: 'pending' })
          // Oldest first: the backlog drains before fresh proposals. The 2/night
          // cap counts auto-approvals, so non-read_only rows are filtered out
          // before slicing instead of consuming slots.
          .reverse()
          .filter((proposal) => proposal.riskClass === 'read_only'),
        { stalled: exploration.stalled, underExplored: exploration.underExplored },
      ).slice(0, PRACTICE_PROPOSALS_MAX_PER_NIGHT);
      let autoApproved = 0;
      let materialized = 0;
      for (const proposal of pending) {
        if (!this.deps.coworkStore.approveDreamPracticeProposal({ id: proposal.id, metabotId: metabot.id })) {
          continue;
        }
        autoApproved += 1;
        try {
          const task = createTask({
            metabotId: metabot.id,
            name: `[Practice] ${proposal.title}`.slice(0, 80),
            description: proposal.rationale ?? '',
            prompt: buildPracticeRunPrompt(proposal),
            scheduleAtMs: computePracticeRunAtMs({
              nowMs: Date.now(),
              metabotId: metabot.id,
              proposalId: proposal.id,
            }),
          });
          const marked = this.deps.coworkStore.markDreamPracticeProposalScheduled({
            id: proposal.id,
            metabotId: metabot.id,
            scheduledTaskId: task.id,
          });
          if (marked) {
            materialized += 1;
          }
        } catch (error) {
          // A single bad proposal never aborts the rest of the batch; the row
          // stays approved and can be retried by a later pass.
          console.warn(
            `[DreamService] Practice proposal #${proposal.id} materialization failed for metabot ${metabot.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (autoApproved > 0 || materialized > 0) {
        console.log(
          `[DreamService] Practice proposals for metabot ${metabot.id}: autoApproved=${autoApproved}, materialized=${materialized}`,
        );
      }
      return { autoApproved, materialized };
    } catch (error) {
      console.warn(
        `[DreamService] Practice proposal pipeline failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * §6 telemetry snapshot for the practice pipeline: tonight's proposed /
   * auto-approved counts plus the current status totals. Reads trigger the
   * lazy TTL sweep, so `expired` reflects tonight's expirations.
   */
  private buildPracticeProposalTelemetry(
    metabotId: number,
    counts: { proposed: number; autoApproved: number },
  ): { proposed: number; autoApproved: number; pendingOwner: number; rejected: number; expired: number } | null {
    try {
      const countByStatus = (status: 'pending' | 'rejected' | 'expired') =>
        this.deps.coworkStore.listDreamPracticeProposals(metabotId, { status }).length;
      return {
        proposed: counts.proposed,
        autoApproved: counts.autoApproved,
        pendingOwner: countByStatus('pending'),
        rejected: countByStatus('rejected'),
        expired: countByStatus('expired'),
      };
    } catch (error) {
      console.warn(
        `[DreamService] Practice proposal telemetry unavailable for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
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
    dropCounters?: DreamInputDropCounters,
  ): Promise<{ points: number; lessons: number; pointsByKind: Record<string, number> }> {
    const zero = { points: 0, lessons: 0, pointsByKind: {} as Record<string, number> };
    try {
      const points = extractNegativeDecisionPoints(activity, COUNTERFACTUAL_MAX_POINTS, dropCounters);
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
      const workflowDrafts: Array<{
        title: string;
        description: string;
        capabilityType: 'workflow';
        origin: string;
      }> = [];
      const seenWorkflowTitles = new Set<string>();
      let written = 0;
      for (const result of parsed.results) {
        const lesson = pickCounterfactualLesson(result);
        if (lesson && !seenLessons.has(lesson)) {
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
        const upgrade = pickCounterfactualWorkflowUpgrade(result);
        if (upgrade && !seenWorkflowTitles.has(upgrade.title.toLowerCase())) {
          seenWorkflowTitles.add(upgrade.title.toLowerCase());
          workflowDrafts.push({
            title: upgrade.title,
            description: upgrade.description,
            capabilityType: 'workflow',
            origin: 'studio_replay',
          });
        }
      }
      if (workflowDrafts.length > 0) {
        try {
          this.deps.coworkStore.insertCapabilityDraftsChecked(metabot.id, date, workflowDrafts);
        } catch (error) {
          console.warn(
            `[DreamService] Replay workflow draft insert failed for metabot ${metabot.id} date ${date}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
   * Dream review P0: positive replay — the 👍-symmetric counterpart of the
   * counterfactual replay. Replays the day's praised decision points (thumbs-up
   * replies, commented ones first, ≤3/day), asks the bot's own LLM what exactly
   * was praiseworthy and should be repeated, and keeps a lesson only when it
   * clears the conservative quality gate (repeatable + substantive beyond
   * generic flattery + grounded in the quoted reply). Passing lessons become
   * capability_drafts with origin 'positive_replay' — status 'draft', flowing
   * through the EXISTING validation/promotion pipeline instead of going
   * straight to the hot layer. Runs after finishRun and never affects the
   * run's outcome; no praised points means no LLM call.
   */
  private async runPositiveReplayAfterDream(
    metabot: DreamMetabotLike,
    brain: DreamBrainPair,
    date: string,
    activity: DreamDayActivity,
    dropCounters?: DreamInputDropCounters,
  ): Promise<{ points: number; lessons: number }> {
    const zero = { points: 0, lessons: 0 };
    try {
      const points = extractPositiveDecisionPoints(activity, POSITIVE_REPLAY_MAX_POINTS, dropCounters);
      if (points.length === 0) return zero;
      const prompt = buildPositiveReplayPrompt({
        botName: metabot.name,
        date,
        points,
      });
      const raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 4096);
      const parsed = parsePositiveReplayOutput(raw, new Set(points.map((point) => point.id)));
      if (!parsed.ok) {
        console.warn(`[DreamService] Positive replay parse failed for metabot ${metabot.id}: ${(parsed as { ok: false; error: string }).error}`);
        return { points: points.length, lessons: 0 };
      }
      const pointById = new Map(points.map((point) => [point.id, point]));
      const lessons: Array<{ title: string; description: string }> = [];
      const seenLessons = new Set<string>();
      for (const result of parsed.results) {
        const point = pointById.get(result.id);
        if (!point) continue;
        const lesson = pickPositiveLesson(result, point);
        if (!lesson || seenLessons.has(lesson)) continue;
        seenLessons.add(lesson);
        lessons.push({
          title: `值得重复的回复做法:${lesson.slice(0, 40)}`,
          description: [
            `${lesson}`,
            '',
            `来源:正向重放 ${date}(人类点赞,评语:${point.outcome.replace(/\s+/g, ' ').slice(0, 200)})`,
            `被赞回复:${point.botAction.slice(0, 300)}`,
          ].join('\n'),
        });
      }
      if (lessons.length === 0) return { points: points.length, lessons: 0 };
      // The checked insert dedupes against live drafts and re-proposals of
      // recently falsified hypotheses — same guarantees as the dream output's
      // own capability_learnings.
      const insert = this.deps.coworkStore.insertCapabilityDraftsChecked(
        metabot.id,
        date,
        lessons.map((lesson) => ({ ...lesson, capabilityType: 'workflow', origin: 'positive_replay' })),
      );
      if (insert.inserted > 0) {
        console.log(
          `[DreamService] Positive replay for metabot ${metabot.id} date ${date}: points=${points.length}, lessons=${insert.inserted}`,
        );
      }
      return { points: points.length, lessons: insert.inserted };
    } catch (error) {
      console.warn(
        `[DreamService] Positive replay failed for metabot ${metabot.id} date ${date}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return zero;
    }
  }

  /**
   * RSI P0 retention gate, evaluated at the START of a normal dream run
   * (before tonight's snapshot and synthesis): yesterday's negative-signal
   * count (thumbs-down + accepted tasks rated ≤2 + reask/unanswered_burst
   * implicit signals) is compared against the trailing baseline; only when the
   * absolute floor AND the baseline comparison both hold — and an 'active'
   * snapshot of a strictly earlier dream date exists (never rolled back) — is
   * that night's prompt layer deterministically rolled back. At most one date
   * per run; self_identity is never part of a snapshot, so it can never roll.
   */
  private evaluatePromptLayerRetentionGate(
    metabot: DreamMetabotLike,
    date: string,
    activity: DreamDayActivity,
  ): RetentionGateResult {
    try {
      const negativeToday = countNegativeSignalsForDay(activity);
      const snapshot = this.deps.dreamStore.getActivePromptLayerSnapshot(metabot.id);
      const base: RetentionGateResult = { ...EMPTY_RETENTION_GATE_RESULT, evaluated: true, negativeSignals: negativeToday };
      // The snapshot must predate the dreamed date — otherwise the write it
      // covers is tonight's own rewrite, which replaces the layer anyway.
      if (!snapshot || snapshot.dreamDate >= date || negativeToday < ROLLBACK_NEGATIVE_FLOOR) {
        return base;
      }
      // Baseline: daily negative counts over the trailing window, counted only
      // for days with any activity (an idle day carries no signal opportunity).
      const [year, month, day] = date.split('-').map((part) => Number(part));
      const baselineDailyNegatives: number[] = [];
      for (let daysAgo = 1; daysAgo <= ROLLBACK_BASELINE_DAYS; daysAgo += 1) {
        const dayKey = formatBotWorkspaceDate(new Date(year, (month || 1) - 1, (day || 1) - daysAgo));
        const bounds = getDayBoundsMs(dayKey);
        const dayActivity = this.deps.dreamStore.getActivityForDate(metabot.id, bounds.startMs, bounds.endMs);
        const hasActivity =
          dayActivity.sessions.length > 0
          || dayActivity.taskRuns.length > 0
          || dayActivity.groupTasks.length > 0
          || (dayActivity.groupChats?.length ?? 0) > 0
          || (dayActivity.chainWrites?.length ?? 0) > 0
          || (dayActivity.chainReads?.length ?? 0) > 0;
        if (!hasActivity) continue;
        dayActivity.implicitSignals = extractImplicitSignals(dayActivity);
        baselineDailyNegatives.push(countNegativeSignalsForDay(dayActivity));
      }
      const verdict = evaluatePromptLayerRollback({
        negativeToday,
        baselineDailyNegatives,
      });
      if (!verdict.triggered) {
        return { ...base, baselineMedian: verdict.baselineMedian, baselineDays: baselineDailyNegatives.length };
      }
      const applied = this.applyPromptLayerRollback(metabot, snapshot, verdict.reason ?? 'negative-feedback spike');
      return {
        ...base,
        rolledBack: applied,
        rolledBackDate: applied ? snapshot.dreamDate : null,
        baselineMedian: verdict.baselineMedian,
        baselineDays: baselineDailyNegatives.length,
        reason: verdict.reason,
        notice: applied ? buildRollbackNotice(snapshot.dreamDate) : null,
      };
    } catch (error) {
      // The retention gate must never fail a dream run.
      console.warn(
        `[DreamService] Prompt-layer retention gate failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ...EMPTY_RETENTION_GATE_RESULT };
    }
  }

  /**
   * The deterministic rollback itself (no LLM): tombstone the rolled-back
   * date's dream-memory batch and restore the snapshotted prior rows
   * (coworkStore.rollbackDreamMemoriesForDate), archive the procedures that
   * night promoted into the active set (the diff against the snapshot's
   * promoted ids — mirroring the capability re-review's archive path), reject
   * that date's capability drafts so tonight's validation/promotion skips
   * them, then mark the snapshot rolled_back. Returns false when the snapshot
   * state changed underfoot (already superseded/rolled back).
   */
  private applyPromptLayerRollback(
    metabot: DreamMetabotLike,
    snapshot: PromptLayerSnapshot,
    reason: string,
  ): boolean {
    try {
      const rollback = this.deps.coworkStore.rollbackDreamMemoriesForDate(
        metabot.id,
        snapshot.dreamDate,
        snapshot.payload.memories,
      );
      // Procedures promoted by the rolled-back night: active now but absent
      // from the snapshot's promoted set. Defensive union: procedures whose
      // source draft was created on the rolled-back date. RRSI P2: an
      // agent-authored procedure only leaves the hot layer with a 'rollback'
      // note — never archived; dream-origin procedures keep the archive.
      const archivedProcedures = new Set<string>();
      if (this.deps.metaidKnowledgeStore) {
        const agentSourced = new Set(
          this.deps.coworkStore.listCapabilityDrafts(metabot.id)
            .filter((draft) => draft.sourceProcedureId)
            .map((draft) => draft.sourceProcedureId as string),
        );
        const snapshotIds = new Set(snapshot.payload.promotedProcedureIds);
        const promotedSince = this.deps.dreamStore
          .listActivePromotedProcedureIds(metabot.id)
          .filter((id) => !snapshotIds.has(id));
        const draftPromotedIds = this.deps.coworkStore
          .listCapabilityDrafts(metabot.id)
          .filter((draft) => draft.dreamDate === snapshot.dreamDate && draft.promotedProcedureId)
          .map((draft) => draft.promotedProcedureId as string);
        for (const procedureId of [...new Set([...promotedSince, ...draftPromotedIds])]) {
          try {
            if (agentSourced.has(procedureId)) {
              // It left the active hot set, so it counts in the same log and
              // rollback note as an archive — but the record survives.
              if (this.deps.metaidKnowledgeStore.setProcedureHotEligibility(procedureId, { eligible: false, reason: 'rollback', sourcePass: 'rollback' })) {
                archivedProcedures.add(procedureId);
              }
              continue;
            }
            const entry = this.deps.metaidKnowledgeStore.getProcedure(procedureId);
            if (entry && entry.status === 'active'
              && this.deps.metaidKnowledgeStore.archiveProcedureByTitle(metabot.id, entry.title)) {
              archivedProcedures.add(procedureId);
            }
          } catch (error) {
            console.warn(
              `[DreamService] Rollback procedure archive failed for metabot ${metabot.id} procedure ${procedureId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      // Drafts created on the rolled-back date must not face tonight's
      // validation/promotion: reject them with the rollback note.
      let rejectedDrafts = 0;
      for (const draft of this.deps.coworkStore.listCapabilityDrafts(metabot.id)) {
        if (draft.dreamDate !== snapshot.dreamDate) continue;
        if (draft.status !== 'draft' && draft.status !== 'disputed' && draft.status !== 'validated') continue;
        if (this.deps.coworkStore.updateCapabilityDraftValidation({
          id: draft.id,
          metabotId: metabot.id,
          status: 'rejected',
          validationScore: draft.validationScore,
          validationNotes: `prompt layer ${snapshot.dreamDate} rolled back (negative-feedback spike) — treat that day's lessons with suspicion`,
        })) {
          rejectedDrafts += 1;
        }
        // RRSI P2: a rejected probation ticket also pulls its procedure out
        // of the hot layer so the recall status reflects the bad day; a later
        // agent re-save reopens probation.
        if (draft.sourceProcedureId && this.deps.metaidKnowledgeStore) {
          try {
            this.deps.metaidKnowledgeStore.setProcedureHotEligibility(draft.sourceProcedureId, {
              eligible: false,
              reason: 'rollback',
              sourcePass: 'rollback',
            });
          } catch (error) {
            console.warn(
              `[DreamService] Rollback eligibility flip failed for procedure ${draft.sourceProcedureId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      const marked = this.deps.dreamStore.markPromptLayerSnapshotRolledBack(
        snapshot.id,
        `${reason}; restored ${rollback.restored}/${snapshot.payload.memories.length} memories, removed ${rollback.removed}, archived ${archivedProcedures.size} procedures, rejected ${rejectedDrafts} drafts`,
      );
      if (!marked) {
        console.warn(`[DreamService] Prompt-layer rollback for metabot ${metabot.id} snapshot ${snapshot.id} lost the status race; store already moved on`);
        return false;
      }
      console.log(
        `[DreamService] Rolled back the ${snapshot.dreamDate} prompt layer for metabot ${metabot.id}: ${reason} `
        + `(memories restored=${rollback.restored} removed=${rollback.removed} skippedMissing=${rollback.skippedMissing}, `
        + `procedures archived=${archivedProcedures.size}, drafts rejected=${rejectedDrafts})`,
      );
      return true;
    } catch (error) {
      console.warn(
        `[DreamService] Prompt-layer rollback failed for metabot ${metabot.id} date ${snapshot.dreamDate}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * RSI P0 prediction reconciliation, run BEFORE synthesis so the calibration
   * digest is prompt input. Deterministic resolution per action type:
   *  - buzz_post / metaweb_comment: reception counts (likes/comments) on the
   *    bot's own pin via fetchPredictionReception; an early hit resolves
   *    immediately (reception only grows), otherwise the verdict waits for the
   *    deadline and lands as partial/miss on the final tally.
   *  - metatask_submission: the local projection's review outcome for
   *    "rootPinId:nodeId" (pass → hit, fail → miss).
   *  - service_delivery: the order's final status (completed → hit;
   *    failed/refunded → miss).
   * Not-yet-observable stays pending; past resolve_deadline without an
   * observable outcome is expired. Never fails the dream run.
   */
  private async reconcilePredictionsBeforeDream(
    metabot: DreamMetabotLike,
    date: string,
  ): Promise<PredictionReconciliationResult> {
    const counters = { ...EMPTY_PREDICTION_RECONCILIATION };
    try {
      const pending = this.deps.dreamStore.listPendingPredictions(metabot.id);
      if (pending.length === 0) return counters;
      counters.checked = pending.length;
      const nowMs = Date.now();

      // Reception predictions share one batched interactions fetch (the same
      // R3 aggregation that feeds the surf reception column).
      const receptionPinByPrediction = new Map<string, string>();
      for (const prediction of pending) {
        if (prediction.actionType !== 'buzz_post' && prediction.actionType !== 'metaweb_comment') continue;
        let pinId = prediction.subjectRef;
        if (!pinId) {
          const ownWrite = this.deps.dreamStore.findOwnChainWriteForPrediction(metabot.id, prediction.actionType, prediction.createdAt);
          pinId = ownWrite?.pinId ?? null;
        }
        if (pinId) receptionPinByPrediction.set(prediction.id, pinId);
      }
      let receptionByPinId: Map<string, { likes: number; comments: number }> | null = null;
      if (receptionPinByPrediction.size > 0 && this.deps.fetchPredictionReception) {
        try {
          const rows = await this.deps.fetchPredictionReception({
            metabotId: metabot.id,
            pinIds: [...new Set(receptionPinByPrediction.values())],
            sinceTs: Math.floor(Math.min(...pending.map((prediction) => prediction.createdAt)) / 1000),
          });
          receptionByPinId = new Map((rows ?? []).map((row) => [row.pinId, { likes: row.likes, comments: row.comments }]));
        } catch (error) {
          console.warn(
            `[DreamService] Prediction reception fetch failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          receptionByPinId = null;
        }
      }

      for (const prediction of pending) {
        try {
          this.reconcileOnePrediction(metabot, prediction, {
            nowMs,
            receptionPinByPrediction,
            receptionByPinId,
            counters,
          });
        } catch (error) {
          // One bad row never aborts the rest of the ledger.
          console.warn(
            `[DreamService] Prediction ${prediction.id} reconciliation failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // Ledger hygiene: resolved rows older than 90 days are bookkeeping dead
      // weight (the calibration window reads only the trailing 30).
      try {
        this.deps.dreamStore.pruneResolvedPredictions({ cutoffMs: nowMs - 90 * 86_400_000 });
      } catch (error) {
        console.warn(
          `[DreamService] Prediction ledger prune failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (counters.resolved > 0) {
        console.log(
          `[DreamService] Prediction reconciliation for metabot ${metabot.id} date ${date}: `
          + `checked=${counters.checked}, resolved=${counters.resolved} (hit=${counters.hit}, partial=${counters.partial}, miss=${counters.miss}, expired=${counters.expired})`,
        );
      }
      return counters;
    } catch (error) {
      console.warn(
        `[DreamService] Prediction reconciliation failed for metabot ${metabot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ...EMPTY_PREDICTION_RECONCILIATION };
    }
  }

  private reconcileOnePrediction(
    metabot: DreamMetabotLike,
    prediction: MetabotPrediction,
    context: {
      nowMs: number;
      receptionPinByPrediction: Map<string, string>;
      receptionByPinId: Map<string, { likes: number; comments: number }> | null;
      counters: PredictionReconciliationResult;
    },
  ): void {
    const pastDeadline = context.nowMs >= getDayBoundsMs(prediction.resolveDeadline).endMs;
    const expire = (why: string) => this.settlePrediction(prediction, 'expired',
      `deadline ${prediction.resolveDeadline} passed with no observable outcome (${why})`, null, context.counters);

    if (prediction.actionType === 'buzz_post' || prediction.actionType === 'metaweb_comment') {
      const pinId = context.receptionPinByPrediction.get(prediction.id) ?? null;
      if (!pinId || !context.receptionByPinId) {
        if (pastDeadline) expire(pinId ? 'reception fetch unavailable' : 'no matching own chain write found');
        return;
      }
      const counts = context.receptionByPinId.get(pinId) ?? { likes: 0, comments: 0 };
      const metric = String(prediction.expectation.metric ?? 'interactions');
      const observed = metric === 'likes' ? counts.likes : metric === 'comments' ? counts.comments : counts.likes + counts.comments;
      const outcomeText = `observed ${observed} ${metric} on ${pinId} (expected >= ${String(prediction.expectation.value)})`;
      const outcomeJson = { metric, observed, likes: counts.likes, comments: counts.comments, resolvedSubjectRef: pinId };
      if (judgeNumericExpectation(prediction.expectation, observed) === 'hit') {
        this.settlePrediction(prediction, 'hit', outcomeText, outcomeJson, context.counters);
      } else if (pastDeadline) {
        this.settlePrediction(prediction, judgeNumericExpectation(prediction.expectation, observed), outcomeText, outcomeJson, context.counters);
      }
      return;
    }

    if (prediction.actionType === 'metatask_submission') {
      if (!prediction.subjectRef || !this.deps.getMetataskSubmissionOutcome) {
        if (pastDeadline) expire(prediction.subjectRef ? 'projection unavailable' : 'no subject_ref');
        return;
      }
      const outcome = this.deps.getMetataskSubmissionOutcome({ metabotId: metabot.id, subjectRef: prediction.subjectRef });
      if (!outcome || outcome.outcome === 'pending') {
        if (pastDeadline) expire('submission still unreviewed in the local projection');
        return;
      }
      const status = outcome.outcome === 'pass' ? 'hit' : 'miss';
      this.settlePrediction(prediction, status,
        `submission review outcome: ${outcome.outcome}${outcome.detail ? ` (${outcome.detail})` : ''}`,
        { outcome: outcome.outcome }, context.counters);
      return;
    }

    if (prediction.actionType === 'service_delivery') {
      const status = prediction.subjectRef ? this.deps.dreamStore.getServiceOrderStatus(prediction.subjectRef) : null;
      if (!status) {
        if (pastDeadline) expire(prediction.subjectRef ? 'order not found' : 'no subject_ref');
        return;
      }
      if (status === 'completed') {
        this.settlePrediction(prediction, 'hit', `order ${prediction.subjectRef} final status: completed`, { orderStatus: status }, context.counters);
      } else if (status === 'failed' || status === 'refunded') {
        this.settlePrediction(prediction, 'miss', `order ${prediction.subjectRef} final status: ${status}`, { orderStatus: status }, context.counters);
      } else if (pastDeadline) {
        expire(`order still ${status}`);
      }
    }
  }

  private settlePrediction(
    prediction: MetabotPrediction,
    status: 'hit' | 'miss' | 'partial' | 'expired',
    outcomeText: string,
    outcomeJson: Record<string, unknown> | null,
    counters: PredictionReconciliationResult,
  ): void {
    const updated = this.deps.dreamStore.resolvePrediction(prediction.id, {
      status,
      resolvedBy: 'dream',
      outcomeText,
      outcomeJson,
    });
    if (!updated) return;
    counters.resolved += 1;
    counters[status] += 1;
  }

  /** The trailing-window calibration digest for tonight's dream prompt ('' when empty). */
  private buildPredictionCalibrationDigest(metabotId: number): string {
    try {
      const calibration = this.deps.dreamStore.listPredictionCalibration(metabotId, PREDICTION_CALIBRATION_WINDOW_DAYS);
      return renderPredictionCalibrationDigest(calibration);
    } catch (error) {
      console.warn(
        `[DreamService] Prediction calibration digest unavailable for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }

  /**
   * RRSI P5 OOD split (design §6.5 P5.3): the internal vs external hit-rate
   * buckets and their gap over the calibration window. A growing gap is the
   * local signature of scorer fitting. Null on failure — telemetry writing
   * never breaks the dream run.
   */
  private buildPredictionOodTelemetry(
    metabotId: number,
  ): {
    internal: { resolved: number; hit: number; hitRate: number | null };
    external: { resolved: number; hit: number; hitRate: number | null };
    gap: number | null;
  } | null {
    try {
      const calibration = this.deps.dreamStore.listPredictionCalibration(metabotId, PREDICTION_CALIBRATION_WINDOW_DAYS);
      const toBucket = (bucket: { resolved: number; hit: number; hitRate: number | null }) => ({
        resolved: bucket.resolved,
        hit: bucket.hit,
        hitRate: bucket.hitRate,
      });
      const internal = toBucket(calibration.bySourceClass.internal);
      const external = toBucket(calibration.bySourceClass.external);
      const gap = internal.hitRate != null && external.hitRate != null
        ? Math.round((internal.hitRate - external.hitRate) * 10_000) / 10_000
        : null;
      return { internal, external, gap };
    } catch (error) {
      console.warn(
        `[DreamService] Prediction OOD telemetry unavailable for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * RRSI P4 structured exploration (design §6.4): decide from the telemetry
   * rollup and recent proposals whether the bot's self-improvement stalled,
   * and render the directive that steers tonight's practice toward the
   * under-explored components. Reads only nights strictly before `date`, so
   * re-running the same night is deterministic; a failure never blocks the
   * dream (falls back to not-stalled).
   */
  private evaluateExplorationState(
    metabotId: number,
    date: string,
  ): { stall: ExplorationStall; underExplored: PracticeComponent[]; directive: string | null } {
    const notStalled: ExplorationStall = { stalled: false, reason: null, dominantComponent: null };
    try {
      const nights = this.deps.dreamStore
        .listDreamTelemetryDailyRange(metabotId, shiftDateKey(date, -21), shiftDateKey(date, -1))
        .map((row) => ({
          dreamDate: row.dreamDate,
          emptyDay: row.emptyDay,
          validated: row.validationValidated ?? 0,
          promoted: row.promotedCount ?? 0,
        }));
      const proposals = this.deps.coworkStore
        .listDreamPracticeProposals(metabotId, { limit: 200 })
        .map((row) => ({ dreamDate: row.dreamDate, component: row.component }));
      const stall = detectEvolutionStall({ date, nights, proposals });
      const underExplored = stall.stalled
        ? listUnderExploredComponents({ date, proposals, dominantComponent: stall.dominantComponent })
        : [];
      const directive = stall.stalled
        ? renderExplorationDirective({ reason: stall.reason ?? 'no_acceptance', underExplored, dominantComponent: stall.dominantComponent })
        : null;
      return { stall, underExplored, directive };
    } catch (error) {
      console.warn(
        `[DreamService] Exploration evaluation failed for metabot ${metabotId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { stall: notStalled, underExplored: [], directive: null };
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
        console.warn(
          `[DreamService] Weekly long dream parse failed for metabot ${metabot.id}: ${(parsed as { ok: false; error: string }).error}; raw output (${raw.length} chars): ${formatParseFailureExcerpt(raw)}`,
        );
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
    for (const del of activity.studioDelegations ?? []) {
      if (del.ownerIntent.trim()) {
        knownNames.add(del.ownerIntent.trim());
        rawChunks.push(del.ownerIntent.trim());
      }
    }
    for (const dec of activity.studioDecisions ?? []) {
      if (dec.title.trim()) knownNames.add(dec.title.trim());
      if (dec.resolutionNote?.trim()) rawChunks.push(dec.resolutionNote.trim());
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
  ): {
    dedupMerged: number;
    capabilityDraftInsert: { inserted: number; skippedDuplicate: number; skippedFalsified: number };
    /** Dream review P0: a self-identity update was refused by the injection screen. */
    selfIdentityRefused: boolean;
  } {
    // RSI P0 retention gate: snapshot the CURRENT dream-origin prompt layer
    // immediately before tonight's writes, so a later negative-feedback spike
    // can deterministically restore exactly this state. Never fails the write.
    try {
      this.deps.dreamStore.capturePromptLayerSnapshot(metabotId, date);
    } catch (error) {
      console.warn(
        `[DreamService] Prompt-layer snapshot failed for metabot ${metabotId} date ${date}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

    // Evidence ledger: each dream write carries the excerpt it was distilled
    // from as its source quote (important memory `source`, value lesson
    // `source`, work review `note`), so the belief layer can later be judged
    // by evidence instead of wording. Outputs built without the item list
    // (repairs, hand-built fixtures) fall back to the bare strings.
    const importantMemoryItems = output.importantMemoryItems
      ?? output.importantMemories.map((text) => ({ text, source: null }));
    const seenImportant = new Set<string>();
    for (const item of importantMemoryItems) {
      if (seenImportant.has(item.text)) continue;
      seenImportant.add(item.text);
      const write = this.deps.coworkStore.createDreamUserMemory({
        metabotId,
        text: item.text,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'profile_fact',
        origin: 'dream',
        isExplicit: true,
        occurredAt: Date.parse(`${date}T00:00:00.000Z`),
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date, quote: item.source ?? undefined },
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
        occurredAt: Date.parse(`${date}T00:00:00.000Z`),
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date, quote: source },
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
        occurredAt: Date.parse(`${date}T00:00:00.000Z`),
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date, quote: review.note || undefined },
      });
      if (write.merged) dedupMerged += 1;
    }

    // Self-identity only moves forward in time: version repairs never touch
    // it, and a normal run for a date older than the identity's current
    // source date must not regress it either.
    // Dream review P0: before anything else, the injection screen refuses a
    // newly generated identity that carries prompt-override phrasing (or is
    // empty after trimming) — the identity rides every prompt, so a bad row
    // must never replace the previous one. Refusals keep the old identity and
    // are marked in the run telemetry.
    let selfIdentityRefused = false;
    if (output.selfIdentity && !isRepair) {
      if (isSelfIdentityInjectionAttempt(output.selfIdentity)) {
        selfIdentityRefused = true;
        console.warn(
          `[DreamService] Refusing self-identity update for metabot ${metabotId} date ${date}: prompt-override pattern or empty text; keeping the previous identity`,
        );
      } else {
        const latestIdentityDate = this.deps.coworkStore.getDreamIdentityLatestDate(metabotId);
        if (latestIdentityDate && date < latestIdentityDate) {
          console.log(`[DreamService] Skip self-identity update for metabot ${metabotId}: date ${date} older than current source ${latestIdentityDate}`);
        } else {
          const allIdentityRows = this.deps.coworkStore.listUserMemories({
            metabotId,
            scopeKind: 'owner',
            scopeKey: 'owner:self',
            usageClass: 'self_identity',
            status: 'all',
            limit: 50,
          });
          const liveIdentityRows = allIdentityRows.filter((row) => row.status !== 'deleted');
          const canonical = liveIdentityRows[0] ?? allIdentityRows[0];
          if (canonical) {
            this.deps.coworkStore.updateUserMemory({
              id: canonical.id,
              metabotId,
              text: output.selfIdentity,
              status: 'created',
              usageClass: 'self_identity',
              allowProtected: true,
              source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: date },
            });
            for (const staleDuplicate of liveIdentityRows.slice(1)) {
              if (staleDuplicate.id === canonical.id) continue;
              this.deps.coworkStore.deleteUserMemory({
                id: staleDuplicate.id,
                metabotId,
                scopeKind: 'owner',
                scopeKey: 'owner:self',
                allowProtected: true,
              });
            }
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
    }

    // Advance per-session dream cursors monotonically so multi-day Studio
    // conversations record the exact message boundary covered by this date.
    try {
      this.deps.dreamStore.advanceSessionCursorsForDate(metabotId, date, activity.sessions);
    } catch (error) {
      console.warn(
        `[DreamService] Advancing session dream cursors failed for metabot ${metabotId} date ${date}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Persist nightly Studio continuity crystal (distilled workstreams,
    // standing owner rulings, and collaboration playbook for long Studio chats).
    if (output.studioContinuity && !isRepair) {
      try {
        const sc = output.studioContinuity;
        const summaryParts: string[] = [];
        if (sc.activeWorkstreams.length > 0) {
          summaryParts.push(`Active: ${sc.activeWorkstreams.join(' | ')}`);
        }
        if (sc.standingRulings.length > 0) {
          summaryParts.push(`Rulings: ${sc.standingRulings.join(' | ')}`);
        }
        if (sc.collaborationPlaybook.length > 0) {
          summaryParts.push(`Playbook: ${sc.collaborationPlaybook.join(' | ')}`);
        }
        this.deps.dreamStore.upsertStudioContinuity({
          metabotId,
          dreamDate: date,
          activeWorkstreams: sc.activeWorkstreams,
          standingRulings: sc.standingRulings,
          collaborationPlaybook: sc.collaborationPlaybook,
          summaryMarkdown: summaryParts.join('\n'),
          llmId,
        });
      } catch (error) {
        console.warn(
          `[DreamService] Studio continuity crystal write failed for metabot ${metabotId} date ${date}: ${error instanceof Error ? error.message : String(error)}`,
        );
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
    // RRSI P1: the checked insert also skips duplicates of live drafts and of
    // hypotheses falsified within FALSIFIED_BLOCK_DAYS (design §6.1 P1.3).
    const capabilityLearnings = Array.isArray(output.capabilityLearnings) ? output.capabilityLearnings : [];
    const capabilityDraftInsert = { inserted: 0, skippedDuplicate: 0, skippedFalsified: 0 };
    if (capabilityLearnings.length > 0) {
      try {
        const result = this.deps.coworkStore.insertCapabilityDraftsChecked(
          metabotId,
          date,
          capabilityLearnings,
        );
        capabilityDraftInsert.inserted = result.inserted;
        capabilityDraftInsert.skippedDuplicate = result.skippedDuplicate;
        capabilityDraftInsert.skippedFalsified = result.skippedFalsified;
        if (result.inserted > 0 || result.skippedDuplicate > 0 || result.skippedFalsified > 0) {
          console.log(
            `[DreamService] Capability drafts for metabot ${metabotId} date ${date}: inserted=${result.inserted}, skippedDuplicate=${result.skippedDuplicate}, skippedFalsified=${result.skippedFalsified}`,
          );
        }
      } catch (error) {
        console.warn(
          `[DreamService] Capability draft persistence failed for metabot ${metabotId} date ${date}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Self-curriculum (Dream-RSI exploration P0, design 2026-10-10 §3.2): each
    // practice proposal becomes a 'pending' dream_practice_proposals row;
    // approval and materialization are a separate pipeline stage. A failure
    // here must not fail the dream run.
    // Dream review P0: when the bot's practice pipeline is disabled the
    // proposals are dead rows (nothing approves or materializes them), so
    // they are dropped at the gate instead of persisted.
    const practiceProposals = Array.isArray(output.practiceProposals) ? output.practiceProposals : [];
    // Review Minor 7: repair re-dreams re-run writeDreamResults for a date the
    // original night already proposed — proposals have no batch-replace
    // semantics (unlike the day's memories), so persisting here would pile
    // duplicate rows into the approval pipeline. Repairs keep the original
    // night's proposals untouched.
    if (practiceProposals.length > 0 && !isRepair && this.isPracticePipelineEnabled(metabotId)) {
      try {
        const inserted = this.deps.coworkStore.insertDreamPracticeProposals(
          metabotId,
          date,
          practiceProposals,
        );
        if (inserted > 0) {
          console.log(
            `[DreamService] Practice proposals for metabot ${metabotId} date ${date}: inserted=${inserted}`,
          );
        }
      } catch (error) {
        console.warn(
          `[DreamService] Practice proposal persistence failed for metabot ${metabotId} date ${date}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (practiceProposals.length > 0) {
      console.log(
        `[DreamService] Dropped ${practiceProposals.length} practice proposal(s) for metabot ${metabotId} date ${date}: practice pipeline disabled`,
      );
    }

    return { dedupMerged, capabilityDraftInsert, selfIdentityRefused };
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
