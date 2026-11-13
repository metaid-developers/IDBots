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
 *  3. PRACTICE_RUN_WATCHDOG_MS is the wall-clock budget the scheduler enforces
 *     by stopping the session.
 *
 * The counters live on the session marker object (ActiveSession.practiceSession)
 * so a per-turn tool-surface rebuild cannot reset them mid-run (same lesson as
 * the surf guard's P2.1).
 */

import type { DreamPracticeProposal } from './dreamPrompt';

/** Hard cap on evaluated tool calls per practice run (the 60-iteration proxy). */
export const PRACTICE_MAX_TOOL_CALLS_PER_RUN = 60;
/** Wall-clock budget per practice run; the scheduler stops the session past it. */
export const PRACTICE_RUN_WATCHDOG_MS = 20 * 60 * 1000;
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
