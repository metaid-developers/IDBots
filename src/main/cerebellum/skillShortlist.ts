/**
 * Cerebellum (小脑) skill shortlist — roadmap #2 of the cerebellum system.
 *
 * One JEV Choice question ranks the ENTIRE enabled skill catalog against the
 * current user message ("which skill best matches this request?"), and the
 * top-3 ride the per-turn volatile tail as a <skill_shortlist> block next to
 * the untouched full catalog. On a large roster the model misloads skills far
 * less when pointed at a shortlist first (TypeSafe cookbook: wrong-loads
 * 16.8% -> 7.3% on a 182-skill roster: wide Choice rank -> top-3 re-read ->
 * one-line suggestion).
 *
 * The full <available_skills> catalog block itself is NEVER modified here —
 * it stays byte-stable so its content-hash dedup keeps it out of subsequent
 * turns and the cacheable system-prompt head never moves. The shortlist is a
 * SEPARATE small volatile block that changes with the user message.
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. In the app this MUST be
 * session.defaultSession.fetch: the Electron net stack follows the system
 * proxy, while bare Node fetch is region-blocked (HTTP 451) for some users.
 *
 * Failure contract: rankSkillsWithCerebellum NEVER throws and returns null
 * on HTTP errors, network errors, abort/timeout, malformed payloads, blank
 * user text, and pools below CEREBELLUM_SKILL_SHORTLIST_MIN_POOL — the
 * caller then injects no shortlist and the turn behaves exactly as before.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/**
 * Same hard abort deadline as every other cerebellum call site: one shot,
 * then the turn proceeds without a shortlist.
 */
export const CEREBELLUM_SKILL_SHORTLIST_TIMEOUT_MS = 2500;

/** JEV Choice hard limit: up to 255 options per question. */
export const CEREBELLUM_SKILL_MAX_OPTIONS = 255;

/** How many ranked skills ride the shortlist block (cookbook: top-3). */
export const CEREBELLUM_SKILL_SHORTLIST_TOP_K = 3;

/**
 * Below this pool size the one-line catalog is scannable by the model itself
 * and a cerebellum round-trip is not worth its latency.
 */
export const CEREBELLUM_SKILL_SHORTLIST_MIN_POOL = 12;

/** Per-option description cap inside the choice `criteria` map (tokens). */
export const CEREBELLUM_SKILL_OPTION_MAX_DESCRIPTION_CHARS = 320;

/**
 * Total char budget across ALL option labels in the criteria map. Typical
 * rosters (dozens of skills × ~350 chars) never reach it; this is a
 * protective backstop for pathological catalogs, in the same spirit as the
 * memoryRank state budget.
 */
export const CEREBELLUM_SKILL_OPTIONS_TOTAL_MAX_CHARS = 24000;

export interface CerebellumSkillCandidate {
  id: string;
  name: string;
  description: string;
}

export interface CerebellumSkillRankEntry {
  id: string;
  probability: number;
}

/**
 * Choice instructions (ONE tunable place). English per TypeSafe's
 * English-primary guidance; the user's original (often Chinese) message
 * stays in `state.current_message` (the shared turn-bundle state field).
 * Options live in the question's `criteria` map (JEV choice shape: option
 * name -> description), keyed by skill id.
 */
export const CEREBELLUM_SKILL_RANK_INSTRUCTIONS =
  'Which ONE skill listed in `criteria` is the best match for handling the user\'s request at ' +
  '`current_message`? Judge by the capability and trigger conditions each option describes — not by ' +
  'shared keywords or name similarity. The user may write in any language. If no skill truly ' +
  'fits, still pick the closest one: only the ranking order is used downstream.';

export const CEREBELLUM_SKILL_RANK_QUESTION_ID = 'best_skill';

export interface CerebellumSkillChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface CerebellumSkillShortlistRequest {
  state: {
    current_message: string;
  };
  model: string;
  questions: Record<string, CerebellumSkillChoiceQuestion>;
}

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
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function buildSkillOptionLabel(skill: CerebellumSkillCandidate): string {
  const description = String(skill.description ?? '').replace(/\s+/g, ' ').trim();
  const capped = truncateUtf16Prefix(description, CEREBELLUM_SKILL_OPTION_MAX_DESCRIPTION_CHARS);
  return capped ? `${skill.name}: ${capped}` : skill.name;
}

/**
 * The Choice question alone, reusable by the per-turn decision bundle: the
 * bundle merges this question with the other turn-scoped decisions (memory
 * rank, remote-service rank, block gate, knowledge rank) into ONE
 * /v1/systemone request keyed by disjoint question ids.
 */
export function buildSkillChoiceQuestions(
  skills: readonly CerebellumSkillCandidate[],
): Record<string, CerebellumSkillChoiceQuestion> {
  // An empty pool makes NO question: a choice question with zero options in
  // `criteria` fails the JEV schema outright (422 "Dictionary should have at
  // least 1 item") and would take the whole merged turn-decision request
  // down with it. The bundle spreads this builder unconditionally, so an
  // empty roster must simply contribute nothing here.
  if (skills.length === 0) {
    return {};
  }
  const criteria: Record<string, string> = {};
  let totalLabelChars = 0;
  for (const skill of skills) {
    const label = buildSkillOptionLabel(skill);
    // Total-payload backstop: typical rosters never reach it; a pathological
    // catalog must not push one Choice question past the JEV cost budget.
    // Catalog order stays intact — overflowing tail options are simply absent.
    if (Object.keys(criteria).length > 0 && totalLabelChars + label.length > CEREBELLUM_SKILL_OPTIONS_TOTAL_MAX_CHARS) {
      break;
    }
    criteria[String(skill.id)] = label;
    totalLabelChars += label.length;
  }
  return {
    [CEREBELLUM_SKILL_RANK_QUESTION_ID]: {
      type: 'choice',
      instructions: CEREBELLUM_SKILL_RANK_INSTRUCTIONS,
      criteria,
    },
  };
}

export function buildSkillShortlistRequest(input: {
  currentUserText: string;
  skills: CerebellumSkillCandidate[];
  model: string;
}): CerebellumSkillShortlistRequest {
  return {
    state: {
      current_message: String(input.currentUserText ?? '').replace(/\s+/g, ' ').trim(),
    },
    model: input.model,
    questions: buildSkillChoiceQuestions(input.skills.slice(0, CEREBELLUM_SKILL_MAX_OPTIONS)),
  };
}

/**
 * Extract the skill ranking from a /v1/systemone payload. The probabilities
 * map is keyed by option name (skill id); unknown keys are skipped, values
 * are clamped to [0,1]. When the probabilities map is unusable but the
 * top-level `choice` names a known skill, that single entry becomes the
 * ranking. Returns null on any other unusable shape.
 */
export function parseSkillShortlistAnswers(
  payload: unknown,
  skills: readonly CerebellumSkillCandidate[],
): CerebellumSkillRankEntry[] | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answer = (payload as { answers?: unknown }).answers as Record<string, unknown> | undefined;
  if (!answer || typeof answer !== 'object') {
    return null;
  }
  const gate = answer[CEREBELLUM_SKILL_RANK_QUESTION_ID];
  if (!gate || typeof gate !== 'object') {
    return null;
  }
  const record = gate as Record<string, unknown>;
  const knownIds = new Set(skills.map((skill) => String(skill.id)));

  const probabilities = record.probabilities;
  if (probabilities && typeof probabilities === 'object') {
    const entries: CerebellumSkillRankEntry[] = [];
    for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
      if (!knownIds.has(key) || typeof value !== 'number' || !Number.isFinite(value)) {
        continue;
      }
      entries.push({ id: key, probability: Math.max(0, Math.min(1, value)) });
    }
    if (entries.length > 0) {
      entries.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
      return entries;
    }
  }

  const choice = record.choice;
  if (typeof choice === 'string' && knownIds.has(choice)) {
    return [{ id: choice, probability: 1 }];
  }
  return null;
}

/**
 * Render the volatile <skill_shortlist> block. The catalog is untouched;
 * this block only points the model at the ranked few first. Entry
 * probabilities are deliberately NOT rendered — the ordering and the
 * suggestion line carry the signal without anchoring the model on
 * calibrated-but-not-per-case numbers.
 */
export function buildSkillShortlistBlock(
  entries: ReadonlyArray<CerebellumSkillCandidate & { probability: number }>,
): string {
  const lines = entries.slice(0, CEREBELLUM_SKILL_SHORTLIST_TOP_K).map(
    (entry) => `- \`${entry.name}\`: ${String(entry.description ?? '').replace(/\s+/g, ' ').trim()}`,
  );
  const best = entries[0];
  return [
    '<skill_shortlist>',
    'Fast-decision ranking of the skill catalog for this turn (best first). Consider these',
    'candidates before scanning <available_skills>; when the suggested skill fits the request,',
    `load it with skill_tool read_skill instead of searching the catalog.`,
    ...lines,
    ...(best ? [`Suggested skill: \`${best.name}\`.`] : []),
    '</skill_shortlist>',
  ].join('\n');
}

/**
 * Ask the cerebellum to rank the whole catalog against the current user
 * message. Returns the ranking sorted best-first (full list — callers take
 * the top-K they need), or null on any failure. Never throws.
 */
export async function rankSkillsWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  skills: CerebellumSkillCandidate[];
  timeoutMs?: number;
}): Promise<CerebellumSkillRankEntry[] | null> {
  const { config, fetchImpl } = input;
  if (!String(input.currentUserText ?? '').trim()) {
    return null;
  }
  const skills = input.skills.slice(0, CEREBELLUM_SKILL_MAX_OPTIONS);
  if (skills.length < CEREBELLUM_SKILL_SHORTLIST_MIN_POOL) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_SKILL_SHORTLIST_TIMEOUT_MS),
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSkillShortlistRequest({
        currentUserText: input.currentUserText,
        skills,
        model: config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseSkillShortlistAnswers(await response.json(), skills);
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller injects no shortlist and the turn proceeds as before.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
