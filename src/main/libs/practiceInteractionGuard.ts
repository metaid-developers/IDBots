/**
 * Practice-session tool policy (Dream-RSI self-curriculum, design 2026-10-10
 * §3.4/§3.5).
 *
 * A practice session is an unattended cowork session materialized from a dream
 * practice proposal. Three layers cooperate:
 *
 *  1. The inline tool allowlists below restrict what the session can SEE (the
 *     coworkRunner filters its inline surface by them, same pattern as the
 *     surf/study allowlists) — chain writes, wallet, purchases and
 *     scheduled-task creation are never registered.
 *  2. evaluatePracticeToolCall is the single counting guard every tool call
 *     (kernel or inline) funnels through: read tools are free, side-effecting
 *     calls are hard-capped per risk class (0 for read_only), and the whole
 *     run is capped at PRACTICE_MAX_TOOL_CALLS_PER_RUN evaluated calls — the
 *     host-side proxy for the design's 60-iteration budget (the DSH kernel has
 *     no per-turn iteration knob).
 *  3. The practice run's wall-clock budget is resolved per practice task
 *     category (resolvePracticeRunWatchdogMs: shipped tiers → store/config
 *     overrides, clamped) and the scheduler stops the session past it. Every
 *     tier ships at the historical 20 minutes, so the default is unchanged.
 *
 * The counters live on the session marker object (ActiveSession.practiceSession)
 * so a per-turn tool-surface rebuild cannot reset them mid-run (same lesson as
 * the surf guard's P2.1).
 */

import type { DreamPracticeProposal } from './dreamPrompt';

/** Hard cap on evaluated tool calls per practice run (the 60-iteration proxy). */
export const PRACTICE_MAX_TOOL_CALLS_PER_RUN = 60;
/**
 * Built-in wall-clock budget per practice run; the scheduler stops the session
 * past it. This stays the DEFAULT for every practice task category (2026-11-18:
 * changing the shipped default would silently alter every existing run) — the
 * tier ladder below is resolved per category, and a store/config value can lift
 * one category without touching the rest.
 */
export const PRACTICE_RUN_WATCHDOG_MS = 20 * 60 * 1000;

/**
 * Practice task category: the proposal's risk class doubles as the task
 * category the watchdog budget is keyed on (read_only / interact_local /
 * chain_write — a chain_write practice run executes the read_only posture, so
 * it starts from the same budget).
 */
export type PracticeRunWatchdogCategory = DreamPracticeProposal['riskClass'];

/**
 * Shipped tier ladder — the single place the host's per-category budgets live.
 * Every tier ships at the historical 20 minutes so behaviour is unchanged
 * until an operator (or a store value) lifts a category; a category's entry can
 * be changed here in one line without touching the others.
 */
export const PRACTICE_RUN_WATCHDOG_TIERS_MS: Readonly<Record<PracticeRunWatchdogCategory, number>> = {
  read_only: PRACTICE_RUN_WATCHDOG_MS,
  interact_local: PRACTICE_RUN_WATCHDOG_MS,
  chain_write: PRACTICE_RUN_WATCHDOG_MS,
};

/**
 * KV-store key backing the per-category overrides (app settings store, the
 * same `getStore()` the host settings use). Accepted shapes:
 *   - number                        → global budget for every category
 *   - { defaultMs?: number,
 *       categories?: { <category>?: number } } → per-category budgets
 * Anything else (missing, malformed, non-finite, <= 0) is ignored.
 */
export const PRACTICE_RUN_WATCHDOG_SETTING_KEY = 'practice_run_watchdog_ms';

/** A corrupt/absent config must never disable the watchdog entirely. */
export const PRACTICE_RUN_WATCHDOG_MIN_MS = 60_000;
/** …nor turn an unattended practice run into a multi-day zombie. */
export const PRACTICE_RUN_WATCHDOG_MAX_MS = 6 * 60 * 60_000;

/** Structured override shape accepted from the store (see the setting key). */
export type PracticeRunWatchdogOverrides = {
  defaultMs?: number;
  categories?: Partial<Record<PracticeRunWatchdogCategory, number>>;
};

const clampWatchdogMs = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(PRACTICE_RUN_WATCHDOG_MAX_MS, Math.max(PRACTICE_RUN_WATCHDOG_MIN_MS, Math.floor(value)));
};

/**
 * An explicitly injected budget (deps wiring / tests) is honoured as-is when it
 * is a positive finite number: it is a deliberate caller decision, not untrusted
 * store config, and shrinking it is exactly how the watchdog is exercised.
 */
const readExplicitBudget = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
};

/** Read one category budget out of a store value of either accepted shape. */
const readConfiguredBudget = (
  overrides: unknown,
  category: PracticeRunWatchdogCategory | null | undefined,
): number | null => {
  if (typeof overrides === 'number') return clampWatchdogMs(overrides);
  if (!overrides || typeof overrides !== 'object') return null;
  const record = overrides as PracticeRunWatchdogOverrides;
  if (category && record.categories && typeof record.categories === 'object') {
    const perCategory = clampWatchdogMs(record.categories[category]);
    if (perCategory !== null) return perCategory;
  }
  return clampWatchdogMs(record.defaultMs);
};

/**
 * Resolve the wall-clock budget for one practice run (tiered + configurable):
 *
 *   1. `explicitMs` — a caller-injected budget (deps wiring / tests). Deliberate
 *      and narrowest, so it wins.
 *   2. the store/config value for THIS category,
 *   3. the store/config default,
 *   4. the shipped tier for the category (`PRACTICE_RUN_WATCHDOG_TIERS_MS`),
 *   5. `PRACTICE_RUN_WATCHDOG_MS` as the last resort.
 *
 * Every store/config candidate is clamped to [1 minute, 6 hours] (a corrupt
 * value must neither disable the watchdog nor create a multi-day zombie);
 * an explicit injected budget is honoured as-is when positive. Invalid
 * candidates are skipped instead of coerced (a NaN would otherwise arm an
 * immediate timeout, and 0 would arm a timeout that never waits).
 */
export function resolvePracticeRunWatchdogMs(input: {
  category?: PracticeRunWatchdogCategory | null;
  overrides?: unknown;
  explicitMs?: number | null;
}): number {
  const category = input.category ?? null;
  const explicit = readExplicitBudget(input.explicitMs);
  if (explicit !== null) return explicit;
  const configured = readConfiguredBudget(input.overrides, category);
  if (configured !== null) return configured;
  if (category && PRACTICE_RUN_WATCHDOG_TIERS_MS[category]) return PRACTICE_RUN_WATCHDOG_TIERS_MS[category];
  return PRACTICE_RUN_WATCHDOG_MS;
}
/** Side-effecting tool calls allowed per interact_local practice run. */
export const PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET = 10;
/** Max characters of one practice outcome rendered into the dream prompt. */
export const PRACTICE_OUTCOME_MAX_CHARS = 1500;

/**
 * Inline tools a read_only practice session may see: chain/metaweb reads,
 * chain-history and memory-surface recall, local conversation reads and
 * read-only local analysis. No chain writes, no wallet, no service purchases,
 * no scheduled-task creation, no UI-driving browser tools — the tools are not
 * registered at all (absence beats a deny rule).
 *
 * The knowledge_base_* reads only mount when the memory-write gate opens the
 * KB bundle (practice sessions run memoryReadOnly, so today they stay
 * unmounted); they are listed so the allowlist states the intended policy.
 */
export const PRACTICE_READ_ONLY_INLINE_TOOLS: ReadonlySet<string> = new Set([
  // Local conversation/session recall.
  'conversation_search',
  'conversation_recall',
  'recent_chats',
  'idbots_session_read_all',
  'idbots_session_read_latest',
  // Chain / MetaWeb reads.
  'chain_history_recall',
  'search_metaweb',
  'read_metaweb_pin',
  'read_metaweb_pins_batch',
  'metaweb_pin_versions',
  'omni_read',
  'search_qa',
  'list_latest_questions',
  'get_question_answers',
  'search_social_posts',
  'social_post_detail',
  'social_post_comments',
  'metaprotocol_registry',
  // Identity / directory reads.
  'search_metaids',
  'metaid_profile',
  'list_online_services',
  'list_online_bots',
  'search_metaapps',
  'check_metafile_route',
  // Memory-surface reads.
  'experience_recall',
  'knowledge_recall',
  'procedure_recall',
  'knowledge_base_list',
  'knowledge_base_query',
  // Local read-only analysis.
  'describe_image',
  'describe_video',
  'describe_audio',
  'media_info',
  'project_query',
]);

/**
 * interact_local (owner-approved) adds local write tools on top of the
 * read_only surface — still no chain writes. Kernel-level file writes
 * (Edit/Write/Bash) are not inline tools; they are allowed and counted by the
 * guard instead.
 */
export const PRACTICE_INTERACT_LOCAL_INLINE_TOOLS: ReadonlySet<string> = new Set([
  ...PRACTICE_READ_ONLY_INLINE_TOOLS,
  'knowledge_base_add_document',
  'knowledge_base_learn',
  'knowledge_upsert',
  'procedure_save',
]);

export interface PracticeSessionState {
  riskClass: DreamPracticeProposal['riskClass'];
  /** Hard ceiling of side-effecting tool calls for this run (0 for read_only). */
  sideEffectBudget: number;
  /** Side-effecting calls allowed through so far (attempts count). */
  sideEffectsUsed: number;
  /** Every evaluated tool call, read or not — the iteration-cap counter. */
  toolCallsUsed: number;
}

/**
 * chain_write proposals never execute in this iteration (owner decision §8.4);
 * if a session ever starts with that class it runs with the read_only posture.
 */
export function createPracticeSessionState(
  riskClass: DreamPracticeProposal['riskClass'],
): PracticeSessionState {
  return {
    riskClass,
    sideEffectBudget: riskClass === 'interact_local' ? PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET : 0,
    sideEffectsUsed: 0,
    toolCallsUsed: 0,
  };
}

export type PracticeToolVerdict =
  | { allow: true; countedSideEffect: boolean }
  | { allow: false; reason: string };

/**
 * The practice run's single tool-call choke point. `kernelReadOnly` is the
 * runner's READ_ONLY_TOOL_NAMES verdict for kernel tools; inline read tools
 * are classified by the allowlist. Denied calls still count toward the
 * iteration cap so a model retrying a denied tool cannot spin forever.
 */
export function evaluatePracticeToolCall(
  state: PracticeSessionState,
  toolName: string,
  options: { kernelReadOnly: boolean },
): PracticeToolVerdict {
  state.toolCallsUsed += 1;
  if (state.toolCallsUsed > PRACTICE_MAX_TOOL_CALLS_PER_RUN) {
    return {
      allow: false,
      reason: `Practice run iteration budget exhausted (${PRACTICE_MAX_TOOL_CALLS_PER_RUN} tool calls). Stop calling tools and write the final practice report now.`,
    };
  }
  const name = String(toolName ?? '').trim().toLowerCase();
  const isRead = options.kernelReadOnly || PRACTICE_READ_ONLY_INLINE_TOOLS.has(name);
  if (isRead) {
    return { allow: true, countedSideEffect: false };
  }
  if (state.riskClass !== 'interact_local') {
    return {
      allow: false,
      reason: `Tool "${toolName}" makes a side effect, which a ${state.riskClass} practice session cannot perform. Finish with read-only tools and write the final practice report.`,
    };
  }
  if (state.sideEffectsUsed >= state.sideEffectBudget) {
    return {
      allow: false,
      reason: `Practice run side-effect budget exhausted (${state.sideEffectBudget} allowed for interact_local). Stop making changes and write the final practice report now.`,
    };
  }
  state.sideEffectsUsed += 1;
  return { allow: true, countedSideEffect: true };
}

/**
 * The fixed practice-run footer (design §3.4): every materialized practice
 * prompt ends with the report contract so the session's last message carries a
 * structured outcome the next dream can consume.
 */
export function buildPracticeRunPrompt(proposal: {
  prompt: string;
  targetRefs: string[];
}): string {
  const refs = proposal.targetRefs.length > 0 ? proposal.targetRefs.join('", "') : '';
  return [
    proposal.prompt.trim(),
    '',
    '---',
    'Practice run contract (host-injected):',
    '- This is an unattended practice session with a restricted tool surface. Do not attempt chain writes, payments, wallet operations, or scheduled-task creation.',
    '- Work the task above, then make your FINAL message end with one fenced ```json practice report:',
    '  {',
    '    "outcome": "success | partial | failed",',
    '    "evidence_observed": "the observable result this practice was designed to produce — what actually happened",',
    `    "what_this_means_for": { "${refs}": "one sentence per cited target ref: what this outcome implies for it" }`,
    '  }',
  ].join('\n');
}

/**
 * Where in the night study window (00:00–06:00 local, owner decision §8.3) a
 * materialized practice run fires. The run goes a few minutes after the dream
 * pipeline finishes plus a deterministic per-(bot, proposal) jitter; when that
 * lands past the window end, it moves to the next window's start + jitter.
 */
export function computePracticeRunAtMs(input: {
  nowMs: number;
  metabotId: number;
  proposalId: number;
}): number {
  const now = new Date(input.nowMs);
  const windowStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const windowEndMs = windowStartMs + 6 * 60 * 60 * 1000;
  const jitterMs = ((Math.abs(Math.floor(input.metabotId)) * 7 + Math.abs(Math.floor(input.proposalId)) * 11) % 30) * 60 * 1000;
  const earliestMs = input.nowMs + 5 * 60 * 1000;
  const targetMs = earliestMs + jitterMs;
  if (targetMs < windowEndMs) {
    return targetMs;
  }
  return windowStartMs + 86_400_000 + jitterMs;
}
