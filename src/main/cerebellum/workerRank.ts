/**
 * Cerebellum (小脑) worker assignment ranking — roadmap #13.
 *
 * The chair planning turn decomposes a group-task goal and names who does
 * each seat. This module asks one JEV Choice question over the worker roster
 * (role, bio, and the twin's distilled impression) and returns a best-first
 * ranking. The chair still writes the plan; the hint only orders fit.
 * Null means "no hint" — the planning directive stays exactly as before.
 *
 * Pure and Electron-free. Never throws.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

export const CEREBELLUM_WORKER_RANK_TIMEOUT_MS = 2500;
export const CEREBELLUM_WORKER_RANK_MAX_OPTIONS = 255;
/** How many ranked workers the planning hint shows. */
export const CEREBELLUM_WORKER_RANK_TOP_K = 3;
/**
 * Below two workers there is nothing to choose. A single seated worker
 * stays on the existing "assign that one member" rule.
 */
export const CEREBELLUM_WORKER_RANK_MIN_POOL = 2;
export const CEREBELLUM_WORKER_RANK_DESCRIPTION_MAX_CHARS = 320;
export const CEREBELLUM_WORKER_RANK_GOAL_MAX_CHARS = 1200;
export const CEREBELLUM_WORKER_RANK_QUESTION_ID = 'best_worker';

/**
 * English instructions. The task goal stays in `state.task_goal`.
 * Keep byte-synced with scripts/cerebellum-worker-rank-eval.mjs, which
 * builds the body through buildWorkerRankRequest.
 */
export const CEREBELLUM_WORKER_RANK_INSTRUCTIONS =
  'Which ONE worker listed in `criteria` is the best fit for the group-task goal at `task_goal`? ' +
  'Judge by the role, skills, and distilled impression each option describes — not by name similarity. ' +
  'The goal may be in any language. If several workers could share the work, still pick the single best lead: ' +
  'only the ranking order is used downstream.';

export interface CerebellumWorkerCandidate {
  id: string;
  name: string;
  description: string;
}

export interface CerebellumWorkerRankEntry {
  id: string;
  probability: number;
}

export interface CerebellumWorkerRankRequest {
  state: { task_goal: string };
  model: string;
  questions: {
    best_worker: {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    };
  };
}

function truncateUtf16Prefix(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function collapse(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildWorkerOptionLabel(worker: CerebellumWorkerCandidate): string {
  const description = truncateUtf16Prefix(collapse(worker.description), CEREBELLUM_WORKER_RANK_DESCRIPTION_MAX_CHARS);
  const name = collapse(worker.name) || worker.id;
  return description ? `${name}: ${description}` : name;
}

export function buildWorkerRankRequest(input: {
  taskText: string;
  workers: readonly CerebellumWorkerCandidate[];
  model: string;
}): CerebellumWorkerRankRequest {
  const workers = input.workers.slice(0, CEREBELLUM_WORKER_RANK_MAX_OPTIONS);
  const criteria: Record<string, string> = {};
  for (const worker of workers) {
    const id = collapse(worker.id);
    if (!id || criteria[id]) continue;
    criteria[id] = buildWorkerOptionLabel(worker);
  }
  return {
    state: {
      task_goal: truncateUtf16Prefix(collapse(input.taskText), CEREBELLUM_WORKER_RANK_GOAL_MAX_CHARS),
    },
    model: input.model,
    questions: {
      [CEREBELLUM_WORKER_RANK_QUESTION_ID]: {
        type: 'choice',
        instructions: CEREBELLUM_WORKER_RANK_INSTRUCTIONS,
        criteria,
      },
    },
  };
}

export function parseWorkerRankAnswers(
  payload: unknown,
  workers: readonly CerebellumWorkerCandidate[],
): CerebellumWorkerRankEntry[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const gate = (answers as Record<string, unknown>)[CEREBELLUM_WORKER_RANK_QUESTION_ID];
  if (!gate || typeof gate !== 'object') return null;
  const record = gate as Record<string, unknown>;
  const knownIds = new Set(workers.map((worker) => collapse(worker.id)).filter(Boolean));

  const probabilities = record.probabilities;
  if (probabilities && typeof probabilities === 'object') {
    const entries: CerebellumWorkerRankEntry[] = [];
    for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
      if (!knownIds.has(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
      entries.push({ id: key, probability: Math.max(0, Math.min(1, value)) });
    }
    if (entries.length > 0) {
      entries.sort((left, right) => right.probability - left.probability || left.id.localeCompare(right.id));
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
 * Plain-text hint appended to the chair planning directive. Probabilities
 * are omitted. An empty ranking returns '' so the directive stays unchanged.
 */
export function buildWorkerAssignmentHint(
  entries: ReadonlyArray<{ name: string; description?: string }>,
): string {
  const lines = entries
    .slice(0, CEREBELLUM_WORKER_RANK_TOP_K)
    .map((entry, index) => {
      const name = collapse(entry.name);
      if (!name) return '';
      const description = collapse(entry.description);
      return description
        ? `${index + 1}. ${name} — ${description}`
        : `${index + 1}. ${name}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return '';
  return [
    '[Cerebellum worker fit order — a hint for seat assignment, not an order to give every subtask to the first name]',
    'Best fit for this task goal, first:',
    ...lines,
    'Assign each subtask to the single best-matching member by exact name. Do not pile every subtask on the first name, and do not assign task work to the chair.',
  ].join('\n');
}

/** Empty hint leaves the directive byte-identical. */
export function appendWorkerFitHint(directive: string, hint: string | null | undefined): string {
  const trimmed = collapse(hint).length > 0 ? String(hint).trim() : '';
  if (!trimmed) return directive;
  return `${directive}\n\n${trimmed}`;
}

export async function rankWorkersWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  taskText: string;
  workers: readonly CerebellumWorkerCandidate[];
  timeoutMs?: number;
}): Promise<CerebellumWorkerRankEntry[] | null> {
  if (!collapse(input.taskText)) return null;
  const workers = input.workers
    .map((worker) => ({ ...worker, id: collapse(worker.id) }))
    .filter((worker) => worker.id)
    .slice(0, CEREBELLUM_WORKER_RANK_MAX_OPTIONS);
  if (workers.length < CEREBELLUM_WORKER_RANK_MIN_POOL) return null;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_WORKER_RANK_TIMEOUT_MS),
  );
  try {
    const response = await input.fetchImpl(`${input.config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildWorkerRankRequest({
        taskText: input.taskText,
        workers,
        model: input.config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseWorkerRankAnswers(await response.json(), workers);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
