/**
 * Cerebellum (小脑) remote-service shortlist — roadmap #16 of the cerebellum
 * system.
 *
 * One JEV Choice question ranks the discovered on-chain service directory
 * (ProviderDiscoveryService.availableServices, rendered by
 * buildRemoteServicesPrompt) against the current user message ("which remote
 * service best matches this request?"), and the top-3 ride the per-turn
 * volatile tail as a <remote_service_shortlist> block next to the untouched
 * full <available_remote_services> block. Isomorphic to the skill shortlist
 * (roadmap #2): on a growing directory the model mispicks services far less
 * when pointed at a shortlist first (wide Choice rank -> top-3 re-read ->
 * one-line suggestion).
 *
 * The full <available_remote_services> block itself is NEVER modified here —
 * it stays byte-stable; the shortlist is a SEPARATE small volatile block that
 * changes with the user message. The shortlist also rides ONLY when the
 * remote-services block itself rides this turn (the volatile block gate owns
 * that surface).
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. In the app this MUST come from
 * resolveCerebellumCallContext(): the Electron net stack follows the system
 * proxy, while bare Node fetch is region-blocked (HTTP 451) for some users,
 * and the free relay needs its key-retry wrapper.
 *
 * Failure contract: rankRemoteServicesWithCerebellum NEVER throws and returns
 * null on HTTP errors, network errors, abort/timeout, malformed payloads,
 * blank user text, and pools below CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL
 * — the caller then injects no shortlist and the turn behaves exactly as
 * before.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/**
 * Same hard abort deadline as every other cerebellum call site: one shot,
 * then the turn proceeds without a shortlist.
 */
export const CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TIMEOUT_MS = 1500;

/** JEV Choice hard limit: up to 255 options per question. */
export const CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS = 255;

/** How many ranked services ride the shortlist block (cookbook: top-3). */
export const CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TOP_K = 3;

/**
 * Below this pool size the one-page directory is scannable by the model
 * itself and a cerebellum round-trip is not worth its latency (same
 * threshold the skill shortlist uses).
 */
export const CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL = 12;

/** Per-option description cap inside the choice `criteria` map (tokens). */
export const CEREBELLUM_REMOTE_SERVICE_OPTION_MAX_DESCRIPTION_CHARS = 320;

/** Total char budget across all service option labels in `criteria`. */
export const CEREBELLUM_REMOTE_SERVICE_OPTIONS_TOTAL_MAX_CHARS = 12000;

export interface CerebellumRemoteServiceCandidate {
  /** Service pin id — the same identifier the delegation protocol uses. */
  id: string;
  name: string;
  description: string;
}

export interface CerebellumRemoteServiceRankEntry {
  id: string;
  probability: number;
}

/**
 * Choice instructions (ONE tunable place). English per TypeSafe's
 * English-primary guidance; the user's original (often Chinese) message
 * stays in `state.current_message` (the shared turn-bundle state field).
 * Options live in the question's `criteria` map (JEV choice shape: option
 * name -> description), keyed by service pin id. Kept wording-close to
 * CEREBELLUM_SKILL_RANK_INSTRUCTIONS so the two shortlists tune together.
 */
export const CEREBELLUM_REMOTE_SERVICE_RANK_INSTRUCTIONS =
  'Which ONE on-chain service listed in `criteria` is the best match for fulfilling the user\'s ' +
  'request at `current_message`? Judge by the capability each option\'s description declares — not ' +
  'by shared keywords or name similarity. The user may write in any language. If no service ' +
  'truly fits, still pick the closest one: only the ranking order is used downstream.';

export const CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID = 'best_service';

export interface CerebellumRemoteServiceChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface CerebellumRemoteServiceShortlistRequest {
  state: {
    current_message: string;
  };
  model: string;
  questions: Record<string, CerebellumRemoteServiceChoiceQuestion>;
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

export function buildRemoteServiceOptionLabel(service: CerebellumRemoteServiceCandidate): string {
  const description = String(service.description ?? '').replace(/\s+/g, ' ').trim();
  const capped = truncateUtf16Prefix(description, CEREBELLUM_REMOTE_SERVICE_OPTION_MAX_DESCRIPTION_CHARS);
  return capped ? `${service.name}: ${capped}` : service.name;
}

/**
 * The Choice question alone, reusable by the per-turn decision bundle: the
 * bundle merges this question with the other turn-scoped decisions (memory
 * rank, skill rank, block gate, knowledge rank) into ONE /v1/systemone
 * request keyed by disjoint question ids.
 */
export function buildRemoteServiceChoiceQuestions(
  services: readonly CerebellumRemoteServiceCandidate[],
): Record<string, CerebellumRemoteServiceChoiceQuestion> {
  // An empty pool makes NO question: a choice question with zero options in
  // `criteria` fails the JEV schema outright (422 "Dictionary should have at
  // least 1 item") and would take the whole merged turn-decision request
  // down with it. The bundle spreads this builder unconditionally, so an
  // empty directory must simply contribute nothing here.
  if (services.length === 0) {
    return {};
  }
  const criteria: Record<string, string> = {};
  let totalChars = 0;
  for (const service of services) {
    const label = buildRemoteServiceOptionLabel(service);
    if (Object.keys(criteria).length > 0 && totalChars + label.length > CEREBELLUM_REMOTE_SERVICE_OPTIONS_TOTAL_MAX_CHARS) {
      break;
    }
    criteria[String(service.id)] = label;
    totalChars += label.length;
  }
  return {
    [CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID]: {
      type: 'choice',
      instructions: CEREBELLUM_REMOTE_SERVICE_RANK_INSTRUCTIONS,
      criteria,
    },
  };
}

export function buildRemoteServiceShortlistRequest(input: {
  currentUserText: string;
  services: CerebellumRemoteServiceCandidate[];
  model: string;
}): CerebellumRemoteServiceShortlistRequest {
  return {
    state: {
      current_message: String(input.currentUserText ?? '').replace(/\s+/g, ' ').trim(),
    },
    model: input.model,
    questions: buildRemoteServiceChoiceQuestions(input.services.slice(0, CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS)),
  };
}

/**
 * Extract the service ranking from a /v1/systemone payload. The
 * probabilities map is keyed by option name (service pin id); unknown keys
 * are skipped, values are clamped to [0,1]. When the probabilities map is
 * unusable but the top-level `choice` names a known service, that single
 * entry becomes the ranking. Returns null on any other unusable shape.
 */
export function parseRemoteServiceShortlistAnswers(
  payload: unknown,
  services: readonly CerebellumRemoteServiceCandidate[],
): CerebellumRemoteServiceRankEntry[] | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answer = (payload as { answers?: unknown }).answers as Record<string, unknown> | undefined;
  if (!answer || typeof answer !== 'object') {
    return null;
  }
  const gate = answer[CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID];
  if (!gate || typeof gate !== 'object') {
    return null;
  }
  const record = gate as Record<string, unknown>;
  const knownIds = new Set(services.map((service) => String(service.id)));

  const probabilities = record.probabilities;
  if (probabilities && typeof probabilities === 'object') {
    const entries: CerebellumRemoteServiceRankEntry[] = [];
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
 * Render the volatile <remote_service_shortlist> block. The directory block
 * is untouched; this block only points the model at the ranked few first.
 * Entry probabilities are deliberately NOT rendered — the ordering and the
 * suggestion line carry the signal without anchoring the model on
 * calibrated-but-not-per-case numbers.
 */
export function buildRemoteServiceShortlistBlock(
  entries: ReadonlyArray<CerebellumRemoteServiceCandidate & { probability: number }>,
): string {
  const lines = entries.slice(0, CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TOP_K).map(
    (entry) => `- \`${entry.name}\`: ${String(entry.description ?? '').replace(/\s+/g, ' ').trim()}`,
  );
  const best = entries[0];
  return [
    '<remote_service_shortlist>',
    'Fast-decision ranking of the on-chain service directory for this turn (best first).',
    'Consider these services first when no local skill fits the request; check each full',
    'entry in <available_remote_services> for price, rating, and provider before',
    'presenting or delegating.',
    ...lines,
    ...(best ? [`Suggested service: \`${best.name}\`.`] : []),
    '</remote_service_shortlist>',
  ].join('\n');
}

/**
 * Ask the cerebellum to rank the discovered service directory against the
 * current user message. Returns the ranking sorted best-first (full list —
 * callers take the top-K they need), or null on any failure. Never throws.
 */
export async function rankRemoteServicesWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  services: CerebellumRemoteServiceCandidate[];
  timeoutMs?: number;
}): Promise<CerebellumRemoteServiceRankEntry[] | null> {
  const { config, fetchImpl } = input;
  if (!String(input.currentUserText ?? '').trim()) {
    return null;
  }
  const services = input.services.slice(0, CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS);
  if (services.length < CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TIMEOUT_MS),
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildRemoteServiceShortlistRequest({
        currentUserText: input.currentUserText,
        services,
        model: config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseRemoteServiceShortlistAnswers(await response.json(), services);
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller injects no shortlist and the turn proceeds as before.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
