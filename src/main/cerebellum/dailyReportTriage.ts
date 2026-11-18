/**
 * Cerebellum (小脑) daily-report triage — which sessions deserve narration in
 * the owner's daily briefing.
 *
 * The deterministic collector already guarantees the must-include sections
 * (pending follow-ups, owner-sourced orchestrations). For the remaining
 * human-participating sessions this gate asks ONE batched /v1/systemone
 * question per candidate: is this session worth mentioning to the owner? A
 * true verdict lifts the session into the prose; the selection policy takes
 * the top-k verdicts (k ≤ 12) merged with the deterministic must-includes,
 * which bypass the cerebellum entirely.
 *
 * Pure and Electron-free: the caller injects the fetch implementation, which
 * in the app MUST come from resolveCerebellumCallContext() — bare Node fetch
 * is region-blocked (HTTP 451). Fail-open null, exactly like every other
 * cerebellum decision: on timeout/quota/malformed payload (or below the 80%
 * answer-coverage floor) the caller falls back to plain recency order.
 *
 * Never throws. JEV payloads carry text-free state only through the host —
 * titles and message excerpts leave the machine only as capped state fields,
 * never through logs.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/**
 * Local UTF-16-unit prefix cut (same semantics as truncateUtf16Units in
 * libs/llmSafeText, inlined so this module stays free of runtime imports —
 * unit tests load it directly with Node type stripping).
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

export const CEREBELLUM_DAILY_REPORT_TRIAGE_TIMEOUT_MS = 2500;

/**
 * Fraction of candidates that must come back with a usable noul before the
 * batch verdict is trusted at all — below the floor the whole call degrades
 * to null (fail-open) rather than half-narrating the day.
 */
export const CEREBELLUM_DAILY_REPORT_MIN_ANSWER_COVERAGE = 0.8;

/** Noul probability at or above which a session is worth narrating. */
export const CEREBELLUM_DAILY_REPORT_THRESHOLD = 0.5;

export const CEREBELLUM_DAILY_REPORT_TITLE_MAX_CHARS = 200;
export const CEREBELLUM_DAILY_REPORT_ASSISTANT_MAX_CHARS = 1500;
export const CEREBELLUM_DAILY_REPORT_USER_MAX_CHARS = 500;

export const dailyReportTriageQuestionId = (index: number): string => `reportworthy_${index}`;

/**
 * English instructions; the state carries the session title and recent
 * messages in their original language. The question id pins the candidate
 * index inside the batch.
 */
export const CEREBELLUM_DAILY_REPORT_TRIAGE_INSTRUCTIONS =
  'Is the session at `candidates[i]` worth mentioning in the human owner\'s daily briefing? ' +
  'Count it as reportworthy when the session produced a result, decision, or progress the owner would care about ' +
  '(delivered work, answers to the owner\'s requests, notable findings, blocked items needing attention). ' +
  'Do NOT count pure bot-to-bot plumbing — status pings, handoffs, retries, A2A chatter — unless it produced a ' +
  'result the owner would care about. Judge intent, not keywords; the text may be in ANY language. ' +
  'Answer `reportworthy_i` for candidates[i] in the SAME order.';

export const CEREBELLUM_DAILY_REPORT_TRIAGE_CRITERIA = {
  true: 'The session delivered owner-relevant work: a finished result, a real answer, progress on the owner\'s request, or a blocker the owner should know about.',
  false: 'The session is bot plumbing or routine chatter with no owner-relevant outcome worth a briefing mention.',
} as const;

export interface DailyReportTriageCandidateState {
  session_title: string;
  last_assistant_message: string;
  last_user_message: string;
}

export interface CerebellumDailyReportTriageRequest {
  state: {
    candidates: DailyReportTriageCandidateState[];
  };
  model: string;
  questions: Record<
    string,
    {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    }
  >;
}

export function buildDailyReportTriageRequest(input: {
  candidates: ReadonlyArray<{
    sessionTitle: string;
    lastAssistantText: string;
    lastUserText: string;
  }>;
  model: string;
}): CerebellumDailyReportTriageRequest {
  const candidates = input.candidates.map((candidate) => ({
    session_title: truncateUtf16Prefix(
      collapseWhitespace(candidate.sessionTitle),
      CEREBELLUM_DAILY_REPORT_TITLE_MAX_CHARS,
    ),
    last_assistant_message: truncateUtf16Prefix(
      collapseWhitespace(candidate.lastAssistantText),
      CEREBELLUM_DAILY_REPORT_ASSISTANT_MAX_CHARS,
    ),
    last_user_message: truncateUtf16Prefix(
      collapseWhitespace(candidate.lastUserText),
      CEREBELLUM_DAILY_REPORT_USER_MAX_CHARS,
    ),
  }));
  const questions: CerebellumDailyReportTriageRequest['questions'] = {};
  candidates.forEach((_candidate, index) => {
    questions[dailyReportTriageQuestionId(index)] = {
      type: 'noul',
      instructions: CEREBELLUM_DAILY_REPORT_TRIAGE_INSTRUCTIONS,
      criteria: { ...CEREBELLUM_DAILY_REPORT_TRIAGE_CRITERIA },
    };
  });
  return { state: { candidates }, model: input.model, questions };
}

/**
 * Extract the per-candidate nouls from one batch payload. Returns an array
 * aligned with the candidate indexes (null per missing/unusable answer);
 * clamps out-of-range values into 0..1.
 */
export function parseDailyReportTriageAnswers(
  payload: unknown,
  candidateCount: number,
): Array<number | null> {
  const results: Array<number | null> = Array.from({ length: candidateCount }, () => null);
  if (!payload || typeof payload !== 'object') return results;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return results;
  for (let index = 0; index < candidateCount; index += 1) {
    const answer = (answers as Record<string, unknown>)[dailyReportTriageQuestionId(index)];
    if (!answer || typeof answer !== 'object') continue;
    const noul = (answer as { noul?: unknown }).noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) continue;
    results[index] = Math.max(0, Math.min(1, noul));
  }
  return results;
}

/** true when the fraction of usable answers clears the coverage floor. */
export function dailyReportTriageCoverageOk(
  answers: ReadonlyArray<number | null>,
  floor: number = CEREBELLUM_DAILY_REPORT_MIN_ANSWER_COVERAGE,
): boolean {
  if (answers.length === 0) return false;
  const usable = answers.filter((value) => value !== null).length;
  return usable / answers.length >= floor;
}

/**
 * Ask the cerebellum which sessions deserve briefing narration. Returns a
 * sessionId → noul map when the batch answered enough candidates; null on any
 * failure (empty pool, HTTP/network error, abort/timeout, malformed payload,
 * coverage below the floor). Never throws.
 */
export async function classifyDailyReportTriagedSessions(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  candidates: ReadonlyArray<{
    sessionId: string;
    sessionTitle: string;
    lastAssistantText: string;
    lastUserText: string;
  }>;
  timeoutMs?: number;
  threshold?: number;
}): Promise<Map<string, number> | null> {
  const candidates = input.candidates.filter((candidate) => collapseWhitespace(candidate.sessionTitle));
  if (candidates.length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_DAILY_REPORT_TRIAGE_TIMEOUT_MS),
  );
  try {
    const response = await input.fetchImpl(`${input.config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildDailyReportTriageRequest({
        candidates: candidates.map(({ sessionTitle, lastAssistantText, lastUserText }) => ({
          sessionTitle,
          lastAssistantText,
          lastUserText,
        })),
        model: input.config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const answers = parseDailyReportTriageAnswers(await response.json(), candidates.length);
    if (!dailyReportTriageCoverageOk(answers)) return null;
    const threshold = input.threshold ?? CEREBELLUM_DAILY_REPORT_THRESHOLD;
    const verdicts = new Map<string, number>();
    candidates.forEach((candidate, index) => {
      const noul = answers[index];
      if (noul !== null && noul >= threshold) {
        verdicts.set(candidate.sessionId, noul);
      }
    });
    return verdicts;
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller narrates by plain recency order instead.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Selection policy (pure) ────────────────────────────────────────────────

export const DAILY_REPORT_MAX_NARRATED_SESSIONS = 12;

/**
 * Merge the deterministic must-includes with the cerebellum verdicts into
 * the final narration set, ordered must-includes first. `candidates` must be
 * recency-ordered and pre-filtered (no must-includes among them). When the
 * cerebellum gave no verdict (null), narration falls back to the first
 * `maxNarrated` candidates in recency order — the report always ships.
 */
export function selectDailyReportNarration(input: {
  mustIncludeSessionIds: ReadonlyArray<string>;
  candidates: ReadonlyArray<{ sessionId: string }>;
  verdicts: ReadonlyMap<string, number> | null;
  maxNarrated: number;
}): string[] {
  const maxNarrated = Math.max(0, Math.floor(input.maxNarrated));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const sessionId of input.mustIncludeSessionIds) {
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    selected.push(sessionId);
  }
  const room = () => maxNarrated - selected.length;
  if (room() <= 0) return selected;

  if (input.verdicts) {
    const scored = input.candidates
      .filter((candidate) => candidate.sessionId && !seen.has(candidate.sessionId) && input.verdicts?.has(candidate.sessionId))
      .map((candidate) => ({ sessionId: candidate.sessionId, noul: input.verdicts?.get(candidate.sessionId) ?? 0 }))
      .sort((a, b) => b.noul - a.noul);
    for (const entry of scored) {
      if (room() <= 0) break;
      seen.add(entry.sessionId);
      selected.push(entry.sessionId);
    }
    return selected;
  }

  for (const candidate of input.candidates) {
    if (room() <= 0) break;
    if (!candidate.sessionId || seen.has(candidate.sessionId)) continue;
    seen.add(candidate.sessionId);
    selected.push(candidate.sessionId);
  }
  return selected;
}
