/**
 * Cerebellum (小脑) session follow-up gate — the classifier behind the
 * "Follow-Up Tasks" (待跟进任务) sidebar bucket.
 *
 * Bot-created sessions (auto_origin set) fold into the collapsed "Autonomous
 * Tasks" group by default. This gate re-judges every completed turn: one cheap
 * JEV Noul reads the session title plus the turn's final assistant message and
 * decides whether the session now ends by waiting on the owner. A true verdict
 * lifts the session into Follow-Up (pending / 'cerebellum'); a false verdict
 * settles a previous cerebellum verdict back into the Autonomous fold; a null
 * verdict (disabled, timeout, quota, malformed payload, blank input) changes
 * nothing — fail-open, exactly like every other cerebellum decision.
 *
 * Solo event-scoped call on turn completion (like groupReplyGate), not part of
 * the per-turn decision bundle. Pure and Electron-free: the caller injects the
 * fetch implementation, which in the app MUST come from
 * resolveCerebellumCallContext() — bare Node fetch is region-blocked (HTTP 451)
 * and a bare Electron net fetch against a free-relay config 401s.
 *
 * Never throws.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/**
 * Local UTF-16-unit prefix cut (same semantics as truncateUtf16Units in
 * libs/llmSafeText, inlined so this module stays free of runtime imports —
 * unit tests load it directly with Node type stripping, which requires
 * extension-ful ESM specifiers; type-only imports are erased and safe).
 */
function truncateUtf16Prefix(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  // High surrogate whose pair was cut off would produce a lone surrogate.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function collapseWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export const CEREBELLUM_SESSION_FOLLOW_UP_TIMEOUT_MS = 1500;

/**
 * Noul probability at or above which the completed turn counts as waiting on
 * the owner. Recall-biased by owner decision (2026-10-23): for follow-up
 * triage a false positive costs the user one glance, a false negative costs a
 * missed incident — so the bar sits at P >= 0.35 instead of the cookbook 0.5,
 * and obvious high-severity reports never even reach the Noul (see
 * hasForceFollowUpSignal below).
 */
export const CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD = 0.35;

/**
 * High-precision severity markers that force a follow-up verdict WITHOUT
 * asking the cerebellum (recall safety net — "rather over-flag than miss").
 * Applied to the turn's final assistant message only. Keep this list tight:
 * every entry must be near-zero false-positive in bot report prose.
 */
export const CEREBELLUM_SESSION_FOLLOW_UP_FORCE_PATTERNS: readonly RegExp[] = [
  /\bCRITICAL\b/,
  /(?<![无不非])需(?:要)?人工(?:处置|处理|介入|干预|确认|决策)/,
  /(?<![无不非])(?:待|需(?:要)?|请)你?(?:拍板|定夺)/,
  /(?<![无不非])(?:待|等待)(?:你|您|owner)(?:的)?(?:处理|确认|决策|批准|回复)/,
  /\baction required\b/i,
  /\bneeds? (?:your|human|manual) (?:approval|decision|attention|intervention)\b/i,
];

/** True when the text carries an unambiguous "human must act" signal. */
export function hasForceFollowUpSignal(text: string): boolean {
  return CEREBELLUM_SESSION_FOLLOW_UP_FORCE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * End-of-run follow-up declaration tag, written by the bot under the
 * scheduled-task contract (scheduler.buildScheduledTaskFollowUpContract).
 * The firing bot knows who actually owns the open ends of its run, so its
 * explicit declaration beats the Noul on the exact runs where the classifier
 * misfires most (owner-directed prose vs third-party-owned tails). Parsed
 * from the turn's final assistant message; the LAST occurrence wins.
 */
export const CEREBELLUM_SESSION_FOLLOW_UP_TAG_PATTERN =
  /\[FOLLOW_UP:\s*(owner|none)\b([^\]]*)\]/gi;

export type SessionFollowUpDeclaration = 'owner' | 'none';

/**
 * Extract the bot's follow-up declaration from the final assistant message.
 * Returns 'owner' / 'none', or null when the message carries no tag (falls
 * back to the deterministic severity net + Noul as before).
 */
export function parseFollowUpDeclaration(text: string): SessionFollowUpDeclaration | null {
  if (!text) return null;
  let verdict: SessionFollowUpDeclaration | null = null;
  for (const match of text.matchAll(CEREBELLUM_SESSION_FOLLOW_UP_TAG_PATTERN)) {
    verdict = match[1].toLowerCase() === 'owner' ? 'owner' : 'none';
  }
  return verdict;
}

/** What the turn-end gate should do with a completed auto-origin turn. */
export type SessionFollowUpAction = 'park' | 'clear' | 'noul';

/**
 * Deterministic precedence for the turn-end gate:
 *   1. 'owner' declaration → park (the bot says the owner is owed follow-up);
 *   2. severity force signal → park (the recall net outranks a 'none' tag —
 *      a CRITICAL report is owed the owner even if the bot mis-tagged it);
 *   3. 'none' declaration → clear (skip the Noul entirely);
 *   4. otherwise → ask the Noul.
 */
export function resolveFollowUpAction(input: {
  declaration: SessionFollowUpDeclaration | null;
  forceSignal: boolean;
}): SessionFollowUpAction {
  if (input.declaration === 'owner') return 'park';
  if (input.forceSignal) return 'park';
  if (input.declaration === 'none') return 'clear';
  return 'noul';
}

/** Caller-authored dimensions, hard-capped like every cerebellum state field. */
export const CEREBELLUM_SESSION_FOLLOW_UP_TITLE_MAX_CHARS = 200;
export const CEREBELLUM_SESSION_FOLLOW_UP_MESSAGE_MAX_CHARS = 1500;
export const CEREBELLUM_SESSION_FOLLOW_UP_TASK_NAME_MAX_CHARS = 120;

export const CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID = 'needs_human_followup';

/**
 * English instructions; the state carries the session title and the assistant
 * reply in their original language. Keep this byte-synced with
 * scripts/cerebellum-session-follow-up-eval.mjs if such an eval script gets
 * added — that script must build the request through
 * buildSessionFollowUpRequest.
 */
export const CEREBELLUM_SESSION_FOLLOW_UP_INSTRUCTIONS =
  'Does the assistant reply at `last_assistant_message` — the final message of a turn in the session at ' +
  '`session_title` — end by asking the human owner to decide, approve, choose, or reply? ' +
  'Count it as needing follow-up when the reply ends with a question directed at the user, a request for ' +
  'approval or a decision, or warnings/recommendations that require the owner\'s decision before proceeding. ' +
  'A monitoring, inspection, patrol, or health-check report that lists UNRESOLVED failures, outages, ' +
  'severity-marked items (CRITICAL/WARN), or recommends manual operations (investigate, restart, clean up, ' +
  'expand capacity, approve) ALWAYS counts as needing follow-up — the owner must triage it even when the ' +
  'reply does not end with a literal question. ' +
  'Do NOT count a final report where every finding is resolved or explicitly informational, a clean ' +
  'all-clear summary, or a bot-to-bot handoff that completes the task with no human action needed. ' +
  'The text may be in ANY language; judge the intent, not keywords. When in doubt, prefer follow-up.';

export const CEREBELLUM_SESSION_FOLLOW_UP_CRITERIA = {
  true: 'The turn ends asking the human to decide, approve, choose, or reply — e.g. it ends with a question to the user, a request for approval, warnings/recommendations that require the owner\'s decision, or a monitoring/inspection report with unresolved failures or manual-operation suggestions.',
  false: 'The turn is a final report or bot-to-bot handoff where the task is complete: every finding is resolved or informational, and no human action is needed.',
} as const;

export interface CerebellumSessionFollowUpRequest {
  state: {
    session_title: string;
    last_assistant_message: string;
    /** Present only for scheduled-task runs (the firing task's name). */
    task_name?: string;
  };
  model: string;
  questions: {
    needs_human_followup: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
  };
}

export function buildSessionFollowUpRequest(input: {
  sessionTitle: string;
  lastAssistantText: string;
  taskName?: string;
  model: string;
}): CerebellumSessionFollowUpRequest {
  const taskName = collapseWhitespace(input.taskName);
  const request: CerebellumSessionFollowUpRequest = {
    state: {
      session_title: truncateUtf16Prefix(
        collapseWhitespace(input.sessionTitle),
        CEREBELLUM_SESSION_FOLLOW_UP_TITLE_MAX_CHARS,
      ),
      last_assistant_message: truncateUtf16Prefix(
        collapseWhitespace(input.lastAssistantText),
        CEREBELLUM_SESSION_FOLLOW_UP_MESSAGE_MAX_CHARS,
      ),
    },
    model: input.model,
    questions: {
      [CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID]: {
        type: 'noul',
        instructions: CEREBELLUM_SESSION_FOLLOW_UP_INSTRUCTIONS,
        criteria: { ...CEREBELLUM_SESSION_FOLLOW_UP_CRITERIA },
      },
    },
  };
  if (taskName) {
    request.state.task_name = truncateUtf16Prefix(taskName, CEREBELLUM_SESSION_FOLLOW_UP_TASK_NAME_MAX_CHARS);
  }
  return request;
}

/**
 * Extract the follow-up noul (0..1) from a /v1/systemone payload. Returns null
 * on any unusable shape (no answers object, missing question, non-numeric
 * noul); out-of-range values clamp into 0..1.
 */
export function parseSessionFollowUpAnswer(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const answer = (answers as Record<string, unknown>)[CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID];
  if (!answer || typeof answer !== 'object') return null;
  const noul = (answer as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) return null;
  return Math.max(0, Math.min(1, noul));
}

/** true when the noul clears the follow-up threshold. */
export function sessionFollowUpFromNoul(
  noul: number,
  threshold: number = CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD,
): boolean {
  return noul >= threshold;
}

/**
 * Ask the cerebellum whether the completed turn leaves the session waiting on
 * the owner. Returns true (needs follow-up), false (settles back, noul <
 * threshold), or null (no verdict — blank assistant text, HTTP/network error,
 * abort/timeout, malformed payload). A high-severity keyword hit short-
 * circuits to true without spending a JEV call. Never throws.
 */
export async function classifySessionFollowUpWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  sessionTitle: string;
  lastAssistantText: string;
  taskName?: string;
  timeoutMs?: number;
  threshold?: number;
}): Promise<boolean | null> {
  if (!collapseWhitespace(input.lastAssistantText)) return null;

  // Recall safety net: an unambiguous "human must act" marker never waits on
  // the Noul — the owner would rather over-flag than miss an incident.
  if (hasForceFollowUpSignal(input.lastAssistantText)) return true;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_SESSION_FOLLOW_UP_TIMEOUT_MS),
  );
  try {
    const response = await input.fetchImpl(`${input.config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSessionFollowUpRequest({
        sessionTitle: input.sessionTitle,
        lastAssistantText: input.lastAssistantText,
        taskName: input.taskName,
        model: input.config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const noul = parseSessionFollowUpAnswer(await response.json());
    if (noul === null) return null;
    return sessionFollowUpFromNoul(noul, input.threshold ?? CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD);
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller leaves the follow-up state exactly as it was.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
