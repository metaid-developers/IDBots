import type { TeamCultureStore } from '../teamCultureStore';
import { normalizeTeamCultureKind, type TeamCultureDistillationOutcome, type TeamCultureKind } from '../teamCultureStore';
import type { GroupTaskStore } from '../groupTaskStore';
import { resolveSystemBrainOptions, type MetabotBrainOptions } from './llmFallback';
import type { Metabot } from '../types/metabot';

/**
 * Task-close culture distillation — the write side of the shared culture
 * base. When a group task closes as done, the acceptance summary (goal,
 * per-deliverable verdicts, plan changes, conclusion, outcome) is offered to
 * an LLM which may propose a SMALL number of team-level culture entries
 * (glossary terms the team had to align on, conventions that measurably
 * helped or whose violation cost rework, cross-member lessons). Proposals
 * land through the store's normal upsert channel, so everything the
 * governance model promises holds automatically: fingerprint dedupe,
 * owner-entry protection, per-kind caps with emergent displacement, and full
 * revision history. The acceptance summary — previously stored but never fed
 * into any memory — finally becomes fleet knowledge.
 */

export interface CultureDistillationTaskInput {
  taskId: number;
  title: string;
  goal: string;
  status: string;
  summary: {
    conclusion: string | null;
    outcome: string | null;
    planChanges: string[];
    deliverables: Array<{ status: string; authorName: string | null }>;
    members: Array<{ name: string | null; role: string }>;
  } | null;
}

export interface CultureDistillationCounts {
  applied: number;
  protectedEntries: number;
  capacitySkipped: number;
  /** Distilled conventions stored pending owner approval (never injected until approved). */
  pendingConventions: number;
}

/**
 * One distillation pass's verdict. 'not-done' is returned for cancelled/
 * summary-less tasks but never persisted — the recorded outcomes (see
 * TeamCultureDistillationRecord) are the ones worth surfacing in settings.
 */
export interface CultureDistillationResult extends CultureDistillationCounts {
  outcome: TeamCultureDistillationOutcome | 'not-done';
  error?: string | null;
}

const MAX_PROPOSALS_PER_KIND = 3;
const DISTILLATION_LLM_TIMEOUT_MS = 120_000;

export function buildCultureDistillationPrompt(input: {
  title: string;
  goal: string;
  summary: NonNullable<CultureDistillationTaskInput['summary']>;
  existingTopics: string[];
  archivedTopics: string[];
}): string {
  const deliverableLines = input.summary.deliverables.map(
    (deliverable) => `- ${deliverable.authorName ?? 'unknown'}: ${deliverable.status}`,
  );
  const memberNames = input.summary.members.map((member) => member.name).filter(Boolean).join(', ');
  const lines = [
    'You are distilling team-culture entries from a finished group task. The culture base is a tiny, shared, low-entropy layer injected into EVERY future group task of this fleet — earn your slot in it.',
    '',
    'Rules:',
    '- Propose ONLY team-level items: terms the team had to align on during this task, conventions that measurably helped (or whose violation caused rework), and lessons every member should carry into future tasks.',
    '- Do NOT restate the task narrative, do NOT praise individuals, do NOT propose single-bot knowledge (that belongs to the bot\'s private knowledge store).',
    `- At most ${MAX_PROPOSALS_PER_KIND} entries per kind. If nothing qualifies, return empty arrays — silence is a valid answer.`,
    '- Topics are short stable labels (2-6 words); text is one precise sentence.',
    '- Existing culture topics are listed below; never propose a duplicate of those.',
    '- Archived topics below were deliberately retired — NEVER re-propose them in any wording.',
    '- Output ONLY a JSON object, no prose around it.',
    '',
    'Output JSON shape:',
    '{"glossary": [{"term": "...", "definition": "..."}], "conventions": [{"topic": "...", "text": "..."}], "lessons": [{"topic": "...", "text": "..."}]}',
    '',
    `Task: ${input.title}`,
    `Goal: ${input.goal}`,
    `Chair conclusion: ${input.summary.conclusion ?? '(none)'}`,
    `Plan changes: ${input.summary.planChanges.length > 0 ? input.summary.planChanges.join(' | ') : '(none)'}`,
    `Deliverable verdicts: ${deliverableLines.length > 0 ? deliverableLines.join(' ; ') : '(none)'}`,
    `Members: ${memberNames || '(unknown)'}`,
    `Existing culture topics: ${input.existingTopics.length > 0 ? input.existingTopics.join(' ; ') : '(none)'}`,
    `Archived (retired, do NOT revive): ${input.archivedTopics.length > 0 ? input.archivedTopics.join(' ; ') : '(none)'}`,
  ];
  return lines.join('\n');
}

export function parseCultureDistillationOutput(raw: string): {
  glossary: Array<{ term: string; definition: string }>;
  conventions: Array<{ topic: string; text: string }>;
  lessons: Array<{ topic: string; text: string }>;
} | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const pick = (value: unknown, keyA: string, keyB: string): string => {
        if (!value || typeof value !== 'object') return '';
        const record = value as Record<string, unknown>;
        return typeof record[keyA] === 'string' ? record[keyA] : (typeof record[keyB] === 'string' ? record[keyB] : '');
      };
      const mapList = (value: unknown, keyA: string, keyB: string) =>
        (Array.isArray(value) ? value : [])
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry) => ({ first: pick(entry, keyA, keyB), second: pick(entry, keyB, keyA) }))
          .filter((pair) => pair.first.trim() && pair.second.trim())
          .slice(0, MAX_PROPOSALS_PER_KIND);
      return {
        glossary: mapList(parsed.glossary, 'term', 'definition').map((pair) => ({ term: pair.first, definition: pair.second })),
        conventions: mapList(parsed.conventions, 'topic', 'text').map((pair) => ({ topic: pair.first, text: pair.second })),
        lessons: mapList(parsed.lessons, 'topic', 'text').map((pair) => ({ topic: pair.first, text: pair.second })),
      };
    } catch {
      // Try the next candidate slice.
    }
  }
  return null;
}

export type CultureDistillationPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    thinking?: 'enabled' | 'disabled';
    webSearch?: boolean;
    /** Provider key the brain model was picked from (id-collision disambiguation). */
    llmProvider?: string | null;
    /** Secondary brain retried once when the primary brain errors mid-call. */
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    /** Per-attempt timeout: primary and fallback each get a fresh window. */
    attemptTimeoutMs?: number;
    attemptTimeoutKind?: 'total' | 'idle';
  },
) => Promise<string>;

/** Core distillation step: gather → prompt → parse → apply via the store. */
export async function runCultureDistillation(input: {
  task: CultureDistillationTaskInput;
  cultureStore: TeamCultureStore;
  performChat: CultureDistillationPerformChat;
  /**
   * The task chair's brain pair (provider hint + fallback brain). When absent
   * or unconfigured the call falls back to the app default model — which used
   * to be the ONLY route: a dead/exhausted default provider (e.g. the
   * 2026-09-04 metaid-free 429 free_quota_exhausted) silently zeroed the
   * culture base even though every bot had a working brain.
   */
  brain?: MetabotBrainOptions | null;
}): Promise<CultureDistillationResult> {
  const counts: CultureDistillationCounts = { applied: 0, protectedEntries: 0, capacitySkipped: 0, pendingConventions: 0 };
  if (input.task.status !== 'done' || !input.task.summary) {
    return { ...counts, outcome: 'not-done' };
  }
  const memberCount = input.task.summary.members.length;
  if (memberCount < 2) {
    return { ...counts, outcome: 'few-members' };
  }
  const existingTopics = input.cultureStore
    .listCulture({ status: 'active', limit: 200 })
    .map((entry) => entry.topic);
  const archivedTopics = input.cultureStore
    .listCulture({ status: 'archived', limit: 200 })
    .map((entry) => entry.topic);
  let raw: string;
  const brainLabel = input.brain?.llmId
    ? ` (brain ${input.brain.llmProvider ? `${input.brain.llmProvider}/` : ''}${input.brain.llmId})`
    : '';
  try {
    raw = await input.performChat(
      'You are a team-culture distillation assistant. Respond only with the requested JSON object.',
      buildCultureDistillationPrompt({
        title: input.task.title,
        goal: input.task.goal,
        summary: input.task.summary,
        existingTopics,
        archivedTopics,
      }),
      input.brain?.llmId ?? undefined,
      {
        thinking: 'disabled',
        // Per-attempt window: the fallback brain gets its own fresh timeout
        // instead of inheriting the primary's spent signal.
        attemptTimeoutMs: DISTILLATION_LLM_TIMEOUT_MS,
        attemptTimeoutKind: 'idle',
        // Same JSON contract as deep-consolidation: a stray built-in web
        // search derails the output into prose the parser must drop.
        webSearch: false,
        llmProvider: input.brain?.llmProvider ?? undefined,
        fallbackLlmId: input.brain?.fallbackLlmId ?? undefined,
        fallbackLlmProvider: input.brain?.fallbackLlmProvider ?? undefined,
      },
    );
  } catch (error) {
    // LLM failures used to vanish into a console.warn; carry the message so
    // the close-out hook can record it into the visible distillation log.
    // Name the brain (like deep-consolidation does): a quota-exhausted or
    // removed model is only actionable when the log says WHICH one failed.
    const message = error instanceof Error ? error.message : String(error);
    return { ...counts, outcome: 'llm-error', error: `${message}${brainLabel}` };
  }
  const parsed = parseCultureDistillationOutput(raw);
  if (!parsed) {
    return { ...counts, outcome: 'unparseable' };
  }
  const proposals: Array<{ kind: TeamCultureKind; topic: string; text: string }> = [
    ...parsed.glossary.map((item) => ({ kind: 'glossary' as const, topic: item.term, text: item.definition })),
    ...parsed.conventions.map((item) => ({ kind: 'convention' as const, topic: item.topic, text: item.text })),
    ...parsed.lessons.map((item) => ({ kind: 'team_lesson' as const, topic: item.topic, text: item.text })),
  ];
  if (proposals.length === 0) {
    // Empty arrays are a valid answer: nothing team-level worth carrying.
    return { ...counts, outcome: 'empty' };
  }
  for (const proposal of proposals) {
    // release-review P2: a store write that fails MID-APPLY used to throw
    // straight out of here and land in the close-out hook's console.warn —
    // the partial writes (and the failure itself) left no distillation
    // record, which is exactly the invisible-failure mode this log exists
    // to prevent. Capture the error with the counts so far and let the hook
    // record an 'apply-error' row.
    try {
      const result = input.cultureStore.upsertCulture({
        kind: normalizeTeamCultureKind(proposal.kind),
        topic: proposal.topic,
        text: proposal.text,
        origin: 'distillation',
        // Conventions steer every future task's prompt — task content is an
        // untrusted injection surface, so distilled conventions land pending
        // and only join injection after the owner approves them. Glossary
        // terms and lessons stay low-risk and auto-activate.
        pendingApproval: proposal.kind === 'convention',
        taskId: input.task.taskId,
      });
      if (result.protected) counts.protectedEntries += 1;
      else if (result.capacitySkipped) counts.capacitySkipped += 1;
      else if (result.created || result.revised) {
        counts.applied += 1;
        if (proposal.kind === 'convention' && result.entry?.pendingApproval) {
          counts.pendingConventions += 1;
        }
      }
    } catch (error) {
      return {
        ...counts,
        outcome: 'apply-error',
        error: `${error instanceof Error ? error.message : String(error)} (after ${counts.applied} applied; proposal topic: ${proposal.topic})`,
      };
    }
  }
  return { ...counts, outcome: 'applied' };
}

// --- task-close wiring -------------------------------------------------------

let cultureStoreProvider: (() => TeamCultureStore) | null = null;
let performChatProvider: CultureDistillationPerformChat | null = null;
let groupTaskStoreProvider: (() => GroupTaskStore) | null = null;
let systemBrainMetabotsProvider: (() => Array<Partial<Pick<Metabot,
  'metabot_type' | 'llm_id' | 'llm_provider' | 'llm_effort' | 'fallback_llm_id' | 'fallback_llm_provider' | 'fallback_llm_effort'
>>>) | null = null;

export function setTeamCultureDistillationDeps(deps: {
  getTeamCultureStore: () => TeamCultureStore;
  getGroupTaskStore: () => GroupTaskStore;
  performChat: CultureDistillationPerformChat;
  /** Metabot lister used to resolve the Twin Bot system brain. */
  listMetabots?: () => Array<Partial<Pick<Metabot,
    'metabot_type' | 'llm_id' | 'llm_provider' | 'llm_effort' | 'fallback_llm_id' | 'fallback_llm_provider' | 'fallback_llm_effort'
  >>>;
}): void {
  cultureStoreProvider = deps.getTeamCultureStore;
  groupTaskStoreProvider = deps.getGroupTaskStore;
  performChatProvider = deps.performChat;
  systemBrainMetabotsProvider = deps.listMetabots ?? null;
}

/**
 * Fire-and-forget hook for closeGroupTask: best-effort, never throws into
 * the close flow. Cancelled tasks are skipped — their lessons are usually
 * noise; only completed (done) tasks with a recorded acceptance summary and
 * at least two members distill.
 *
 * Every done-close verdict (including the skip reasons) is persisted to the
 * culture store's distillation log, so the settings culture tab can show why
 * recent closes did or did not land entries — previously every failure mode
 * here was a console.warn nobody saw, which read as "the feature is dead".
 */
export function distillTeamCultureFromTaskClose(
  taskId: number,
  status: string,
  title: string,
  goal: string,
): void {
  void (async () => {
    try {
      if (!cultureStoreProvider || !performChatProvider || !groupTaskStoreProvider) return;
      // Cancelled closes are routine and noisy — never distilled, never logged.
      if (status !== 'done') return;
      const cultureStore = cultureStoreProvider();
      const record = (
        outcome: TeamCultureDistillationOutcome,
        counts?: CultureDistillationCounts,
        error?: string | null,
      ): void => {
        try {
          cultureStore.recordCultureDistillation({
            at: Date.now(),
            taskId,
            taskTitle: title,
            outcome,
            applied: counts?.applied ?? 0,
            pendingConventions: counts?.pendingConventions ?? 0,
            error: error ?? null,
          });
        } catch (logError) {
          console.warn(
            `[TeamCulture] Failed to record the distillation outcome for task ${taskId}: ` +
              `${logError instanceof Error ? logError.message : String(logError)}`,
          );
        }
      };
      // Master switch gates BOTH the distillation LLM spend and injection.
      if (!cultureStore.getCultureConfig().enabled) {
        record('disabled');
        return;
      }
      const groupTaskStore = groupTaskStoreProvider();
      const summaryRow = groupTaskStore.getLatestAcceptanceSummary(taskId);
      if (!summaryRow) {
        // The single most common "why is the culture base empty" cause: the
        // task never went through the review ceremony, so there is nothing to
        // distill from.
        record('no-summary');
        return;
      }
      // Ride the Twin Bot system brain (primary + fallback + efforts) —
      // culture distillation is a fleet-level automation, not one bot's act.
      // Distilling over the bare app default model meant one exhausted
      // free-tier provider zeroed the whole culture base while every bot
      // brain was healthy (2026-09-04 metaid-free 429 outage).
      const brain = resolveSystemBrainOptions(systemBrainMetabotsProvider?.());
      const result = await runCultureDistillation({
        task: {
          taskId,
          title,
          goal,
          status,
          summary: {
            conclusion: summaryRow.conclusion,
            outcome: summaryRow.outcome ?? null,
            planChanges: summaryRow.planChanges ?? [],
            deliverables: (summaryRow.deliverables ?? []).map((deliverable) => ({
              status: deliverable.status,
              authorName: deliverable.authorName,
            })),
            members: (summaryRow.members ?? []).map((member) => ({
              name: member.name,
              role: member.role,
            })),
          },
        },
        cultureStore: cultureStore,
        performChat: performChatProvider,
        brain,
      });
      if (result.outcome !== 'not-done') {
        record(result.outcome, result, result.error);
      }
      if (result.applied > 0) {
        console.log(
          `[TeamCulture] Distilled ${result.applied} culture entr(ies) from task ${taskId}` +
            ` (protected: ${result.protectedEntries}, capacity-skipped: ${result.capacitySkipped}` +
            `, pending approval: ${result.pendingConventions})`,
        );
      } else {
        console.log(
          `[TeamCulture] Distillation for task ${taskId}: ${result.outcome}` +
            (result.error ? ` — ${result.error}` : ''),
        );
      }
    } catch (error) {
      console.warn(
        `[TeamCulture] Distillation failed for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
}
