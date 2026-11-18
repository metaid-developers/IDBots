// Studio chapter auto-close triggers (Phase 1 slice 3, owner ruling
// 三者叠加: budget + task boundary + manual). Pure decision logic — the
// runner feeds it the turn-end state and acts on the verdict, so the policy
// is unit-testable without a live session.
//
// Budget trigger: a Studio working set that outgrows the budget closes its
// chapter at the NEXT turn boundary (never mid-turn) — the 2026-11-18
// post-mortem session ran a full day to 530K tokens with zero compaction and
// degraded on every flash-tier axis. The budget is the SMALLER of a fixed
// working-set cap and a fraction of the route's real context window, so a
// 128K-window model triggers proportionally earlier instead of never.
//
// Task-boundary trigger: when a task completes to done in the owning
// conversation, the chapter closes with it (章节 = 任务) — but only when the
// chapter actually has substance, or a burst of tiny tasks would churn
// chapters (each close costs an LLM card + a compaction + a cache reset).

/**
 * Fixed working-set cap for Studio chapters. Chosen from the incident
 * forensics: flash-tier attention degrades well before provider compaction
 * thresholds fire (0.8 × 1M), and the ME-billed relay prices each turn by
 * input size — ~260K keeps per-turn cost bounded and quality in the
 * comfortable zone.
 */
export const STUDIO_CHAPTER_BUDGET_TOKENS = 260_000;

/** Budget as a fraction of the route's declared context window for smaller windows. */
export const STUDIO_CHAPTER_BUDGET_WINDOW_RATIO = 0.55;

/**
 * Minimum auto-close interval per session: when a close (or its compaction)
 * fails, the usage can stay above budget and every subsequent turn would
 * re-trigger — the interval bounds the retry storm and the divider spam.
 */
export const STUDIO_CHAPTER_AUTOCLOSE_MIN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * A task boundary alone only closes a chapter with at least this many
 * substantive messages — otherwise the budget trigger catches it later and
 * tiny chapters are not worth a compaction.
 */
export const STUDIO_TASK_BOUNDARY_MIN_MESSAGES = 6;

/** Windows below this are too small to benefit from chaptering (kernel compaction owns them). */
const MIN_CHAPTERABLE_WINDOW_TOKENS = 48_000;

/**
 * The budget threshold for one route's context window: the smaller of the
 * fixed cap and the window ratio. Null when the window is unknown or too
 * small to chapter.
 */
export function studioChapterBudgetThreshold(contextWindow: number | null | undefined): number | null {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow < MIN_CHAPTERABLE_WINDOW_TOKENS) {
    return null;
  }
  return Math.min(STUDIO_CHAPTER_BUDGET_TOKENS, Math.floor(contextWindow * STUDIO_CHAPTER_BUDGET_WINDOW_RATIO));
}

export interface StudioChapterAutoCloseInput {
  isStudioOwnerSession: boolean;
  /** Real per-session context usage as the host measured it last turn; estimator values must pass isRealUsage=false. */
  usage: { usedTokens: number; contextWindow: number; isRealUsage: boolean } | null;
  /** A task completed to done in this conversation since the last evaluation. */
  pendingTaskBoundary: boolean;
  /** Substantive user/assistant messages in the ACTIVE chapter so far. */
  chapterMessageCount: number;
  /** Epoch ms of this session's last AUTO chapter close, or null. */
  lastAutoCloseAt: number | null;
  now: number;
}

export type StudioChapterAutoCloseDecision =
  | { reason: 'task_boundary' }
  | { reason: 'budget'; usedTokens: number; threshold: number }
  | null;

/**
 * The turn-end verdict. Task boundary wins over budget when both fire (the
 * close reason names the sharper boundary); a boundary on an insubstantial
 * chapter falls through to the budget check instead of forcing a compaction.
 */
export function resolveStudioChapterAutoClose(input: StudioChapterAutoCloseInput): StudioChapterAutoCloseDecision {
  if (!input.isStudioOwnerSession) return null;
  if (input.lastAutoCloseAt != null && input.now - input.lastAutoCloseAt < STUDIO_CHAPTER_AUTOCLOSE_MIN_INTERVAL_MS) {
    return null;
  }
  if (input.pendingTaskBoundary && input.chapterMessageCount >= STUDIO_TASK_BOUNDARY_MIN_MESSAGES) {
    return { reason: 'task_boundary' };
  }
  if (input.usage && input.usage.isRealUsage) {
    const threshold = studioChapterBudgetThreshold(input.usage.contextWindow);
    if (threshold != null && input.usage.usedTokens >= threshold) {
      return { reason: 'budget', usedTokens: input.usage.usedTokens, threshold };
    }
  }
  return null;
}
