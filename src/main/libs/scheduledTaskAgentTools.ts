import { z } from 'zod';
import type { SurfSessionWriteState } from './surfInteractionGuard';

/**
 * Inline `create_scheduled_task` tool — the surf-session handoff for work the
 * bot decided to UNDERTAKE but cannot execute inside the read+interact surf
 * surface (Step 1 of the broadcast-collaboration loop: CLAIM during surf, EXECUTE
 * later as a scheduled full cowork session with coding tools, skills and
 * publishing available).
 *
 * The tool is registered ONLY for surf sessions (see coworkRunner
 * buildSessionInlineTools) — interactive sessions already create tasks through
 * the metabot-schedule skill + CLI over Bash. The per-run cap lives on the
 * session marker (SurfSessionWriteState.tasksScheduled), so a per-turn tool
 * surface rebuild cannot reset it mid-run (same lesson as the interaction
 * budget, review P2.1).
 */

/**
 * Hard cap of scheduled tasks one surf run may create. Raised 2→4 (P1b,
 * 2026-10-11): the surf-creativity push lets a bot hand off BOTH commitments
 * it made tonight (CLAIMed CTA work, promised deliveries) AND concrete
 * opportunities it found while surfing — the old cap of 2 starved the second
 * class entirely.
 */
export const SURF_SCHEDULED_TASK_CAP = 4;

const MAX_TASK_NAME_CHARS = 80;
const MAX_TASK_PROMPT_CHARS = 4000;

/** Schedule shape accepted from the session (mirrors scheduledTaskStore.Schedule). */
export interface ScheduledTaskAgentSchedule {
  type: 'at' | 'interval' | 'cron';
  /** type 'at': local wall-clock datetime `YYYY-MM-DDTHH:mm:ss` (no trailing Z). */
  datetime?: string;
  /** type 'interval': every <value> <unit> (normalized to intervalMs for the store). */
  unit?: 'minutes' | 'hours' | 'days';
  value?: number;
  intervalMs?: number;
  /** type 'cron': 5-field cron expression in local time. */
  expression?: string;
}

export interface ScheduledTaskAgentCreateInput {
  metabotId: number | null;
  name: string;
  description: string;
  prompt: string;
  schedule: ScheduledTaskAgentSchedule;
  /**
   * Chat session the task's prompt is injected into at fire time (the tool
   * resolves the caller-facing "current" against its session closure before it
   * reaches this layer). Absent/null = run in a new session each time.
   */
  targetSessionId?: string | null;
  /**
   * REQUIRED for recurring (interval/cron) tasks: the death clause. Natural
   * language, covering both the watched condition and the upstream lifecycle
   * it serves. Enforced at this seam — a recurring loop without one is how
   * probes outlive the orders they were created for.
   */
  exitCondition?: string | null;
  /** Total fire budget for recurring tasks; null/undefined = default 50. */
  maxFires?: number | null;
  /** Provenance: the session this task was created from (stamped by the tool). */
  originSessionId?: string | null;
  /** Provenance: creation context tag (stamped by the tool). */
  originContext?: string | null;
}

export interface ScheduledTaskAgentCreated {
  id: string;
  name: string;
  nextRunAtMs: number | null;
}

/**
 * Control surface the host (main.ts) provides: creates the task in
 * scheduledTaskStore, reschedules the daemon, and returns the created record.
 * The host owns workingDirectory/systemPrompt/defaults — the session only
 * supplies name, prompt and schedule. Implementations MUST throw when the
 * schedule never fires (past 'at' datetime, unparsable cron) — a silently
 * dead task is the worst outcome (the store computes nextRunAtMs=null for
 * both cases).
 */
export interface ScheduledTaskAgentControl {
  createTask(input: ScheduledTaskAgentCreateInput): ScheduledTaskAgentCreated;
}

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

const INTERVAL_UNIT_MS: Record<'minutes' | 'hours' | 'days', number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

/**
 * Normalize + validate the session-supplied schedule into the store's
 * Schedule shape. Throws with actionable guidance on anything that would
 * never fire; the tool handler converts that into a non-fatal error result.
 */
function normalizeSchedule(args: {
  scheduleType: 'at' | 'interval' | 'cron';
  at?: string;
  intervalValue?: number;
  intervalUnit?: 'minutes' | 'hours' | 'days';
  cron?: string;
}): ScheduledTaskAgentSchedule {
  if (args.scheduleType === 'at') {
    const raw = (args.at ?? '').trim();
    if (!raw) {
      throw new Error('scheduleType "at" needs the `at` field: local wall-clock datetime like "2026-09-14T09:00:00" (no trailing Z).');
    }
    const targetMs = new Date(raw).getTime();
    if (!Number.isFinite(targetMs)) {
      throw new Error(`Could not parse \`at\` datetime "${raw}" — use local wall-clock format YYYY-MM-DDTHH:mm:ss (no trailing Z).`);
    }
    if (targetMs <= Date.now() + 30 * 1000) {
      throw new Error(`The \`at\` datetime "${raw}" is in the past (or under 30s away) — the task would never fire. Pick a future time.`);
    }
    return { type: 'at', datetime: raw };
  }
  if (args.scheduleType === 'interval') {
    const unit = args.intervalUnit;
    const value = Math.floor(args.intervalValue ?? NaN);
    if (!unit || !(unit in INTERVAL_UNIT_MS)) {
      throw new Error('scheduleType "interval" needs `intervalUnit`: one of "minutes" | "hours" | "days".');
    }
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('scheduleType "interval" needs a positive integer `intervalValue`.');
    }
    return { type: 'interval', unit, value, intervalMs: value * INTERVAL_UNIT_MS[unit] };
  }
  const expression = (args.cron ?? '').trim();
  if (!expression) {
    throw new Error('scheduleType "cron" needs the `cron` field: a 5-field cron expression in local time, e.g. "0 9 * * *".');
  }
  return { type: 'cron', expression };
}

/**
 * Build the inline create_scheduled_task tool. `surfState` is the surf session
 * marker: when present the per-run cap is enforced and created tasks are
 * recorded on the marker (ground truth for the run stats — receipts over
 * self-report, same philosophy as the chain-write receipts).
 */
export function buildScheduledTaskAgentTools(deps: {
  tool: SdkToolFactory;
  control: ScheduledTaskAgentControl;
  resolveMetabotId: (sessionId: string) => number | undefined;
  sessionId: string;
  surfState?: SurfSessionWriteState;
}): unknown[] {
  const { tool, control, resolveMetabotId, sessionId, surfState } = deps;

  // Surf sessions are hidden from the session list and stopped once the run
  // ends, so a task that "continues this conversation" would re-feed the whole
  // surf transcript (49k-char prompt + every deep read) as the prefix of an
  // invisible work session — 45% of scheduled-task fires in the 2026-10 audit
  // week went that way. In a surf session every task therefore runs in a NEW
  // session unless the model names another specific session; the legacy
  // continue-this-conversation default stays for non-surf registrations.
  const sessionPlacement = surfState
    ? 'Every task runs LATER in a NEW session (this surf session is unattended and ends tonight). Pass a session UUID only to run the task inside a specific other chat session.'
    : 'One-shot tasks (scheduleType "at") run in THIS conversation by default; recurring tasks run in a new session each time. Pass sessionId to override.';
  const sessionIdDescription = surfState
    ? 'Optional: a specific chat session UUID the task should run in. Omit (or pass null) to run in a new session — the default for every task created while surfing. "current" is treated as omitted: this surf session is unattended and ends tonight. If the session is missing or archived at run time, the task runs in a new session instead.'
    : "Which chat session the task runs in. Pass 'current' to run in THIS conversation, or a session UUID to run in that session. Omit to use the default: this conversation for one-shot 'at' tasks, a new session for recurring tasks. Pass null to deliberately run a one-shot task in a new session (opt out of the default). If the session is missing or archived at run time, the task runs in a new session instead.";

  const createScheduledTask = tool(
    'create_scheduled_task',
    `Create one scheduled task for THIS bot — a prompt the bot executes later, unattended, as a FULL work session (coding tools, skills, publishing — all available there, unlike this surf session). Hand off work you decided to undertake but cannot do here. The prompt must be fully self-contained: what to do, the source pinId/thread, and the exact delivery step. Prefer scheduleType "at" (one-time). Every run must end its final message with a follow-up tag — \`[FOLLOW_UP: none]\` or \`[FOLLOW_UP: owner — <what the owner must decide, approve, or provide>]\` — so keep that requirement in the prompt you write. ${sessionPlacement}`,
    {
      name: z.string().min(1).describe(`Short task name, at most ${MAX_TASK_NAME_CHARS} chars`),
      prompt: z.string().min(1).describe(`Self-contained runtime instructions for the future work session, at most ${MAX_TASK_PROMPT_CHARS} chars: what to do, source pinIds/threads, delivery step`),
      scheduleType: z.enum(['at', 'interval', 'cron']).describe('"at" = one-time (default choice), "interval" = recurring, "cron" = cron expression'),
      at: z.string().optional().describe('For scheduleType "at": local wall-clock datetime YYYY-MM-DDTHH:mm:ss (no trailing Z), must be in the future'),
      intervalValue: z.number().optional().describe('For scheduleType "interval": positive integer count'),
      intervalUnit: z.enum(['minutes', 'hours', 'days']).optional().describe('For scheduleType "interval": the unit'),
      cron: z.string().optional().describe('For scheduleType "cron": 5-field cron expression in local time'),
      sessionId: z.union([z.string(), z.null()]).optional().describe(sessionIdDescription),
      exitCondition: z.string().optional().describe('REQUIRED for recurring (interval/cron) tasks: when this task has done its job and must retire itself — cover BOTH the watched condition AND the upstream work it serves, e.g. "Retire once the endpoint is confirmed live AND order-x is delivered; if order-x is already closed, retire on the next fire."'),
      maxFires: z.number().int().positive().optional().describe('Total fire budget for recurring tasks (default 50). Raise it only for standing routines with a real reason to outlive the default.'),
    },
    async (args: {
      name?: string;
      prompt?: string;
      scheduleType?: 'at' | 'interval' | 'cron';
      at?: string;
      intervalValue?: number;
      intervalUnit?: 'minutes' | 'hours' | 'days';
      cron?: string;
      sessionId?: string | null;
      exitCondition?: string | null;
      maxFires?: number | null;
    }) => {
      try {
        if (surfState) {
          const used = surfState.tasksScheduled ?? 0;
          if (used >= SURF_SCHEDULED_TASK_CAP) {
            return textResult(
              `Scheduled-task budget exhausted for this surf run (${SURF_SCHEDULED_TASK_CAP} tasks max). Only schedule concrete commitments and concrete found opportunities — one task per deliverable; everything else belongs in the final report's "notes" for the next surf.`,
              true,
            );
          }
        }
        const metabotId = resolveMetabotId(sessionId) ?? null;
        if (metabotId == null) {
          return textResult('Cannot create a scheduled task: this session is not bound to a MetaBot.', true);
        }
        const name = String(args.name ?? '').trim();
        if (!name) return textResult('`name` is required.', true);
        if (name.length > MAX_TASK_NAME_CHARS) {
          return textResult(`Task name is ${name.length} chars — over the ${MAX_TASK_NAME_CHARS}-char cap. Shorten it.`, true);
        }
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) return textResult('`prompt` is required — the future session only sees what you write here.', true);
        if (prompt.length > MAX_TASK_PROMPT_CHARS) {
          return textResult(`Task prompt is ${prompt.length} chars — over the ${MAX_TASK_PROMPT_CHARS}-char cap. Condense it to the essential instructions + pinIds.`, true);
        }
        const scheduleType = args.scheduleType;
        if (!scheduleType) {
          return textResult('`scheduleType` is required: "at" (one-time, preferred), "interval" or "cron".', true);
        }
        const schedule = normalizeSchedule({
          scheduleType,
          at: args.at,
          intervalValue: args.intervalValue,
          intervalUnit: args.intervalUnit,
          cron: args.cron,
        });
        // Recurring tasks must be born with a death clause (lifecycle
        // discipline, 2026-10-24): refuse and teach — the model reading this
        // error can fix the call in one round.
        const exitCondition = String(args.exitCondition ?? '').trim();
        if (schedule.type !== 'at' && !exitCondition) {
          return textResult(
            'Recurring (interval/cron) tasks require `exitCondition`: state when this task has done its job and must retire itself — cover BOTH the watched condition AND the upstream work it serves. Example: exitCondition: "Retire once the video endpoint is confirmed live AND order-x is delivered; if order-x is already closed, retire on the next fire." Retry with the field added.',
            true,
          );
        }
        let maxFires: number | null = null;
        if (args.maxFires !== undefined && args.maxFires !== null) {
          const raw = Number(args.maxFires);
          if (!Number.isInteger(raw) || raw <= 0) {
            return textResult('`maxFires` must be a positive integer (total fire budget), or omitted for the default of 50.', true);
          }
          maxFires = raw;
        }
        // `sessionId: "current"` resolves HERE, against the surf session this
        // run belongs to — the literal must never reach the host/store. An
        // explicit null is the deliberate opt-out: it is forwarded as null so
        // the one-shot default below cannot claim it (the store maps a null
        // binding to "no binding" on create).
        let targetSessionId: string | null | undefined;
        if (args.sessionId === null) {
          targetSessionId = null;
        } else {
          const requestedSessionId = args.sessionId?.trim();
          targetSessionId = requestedSessionId
            ? (requestedSessionId === 'current' ? sessionId : requestedSessionId)
            : undefined;
          if (surfState) {
            // Surf session: never bind to the hidden, soon-stopped surf
            // session itself — neither by the one-shot default nor via
            // "current". Only a different, explicitly named session binds.
            if (targetSessionId === undefined || targetSessionId === sessionId) {
              targetSessionId = null;
            }
          } else if (targetSessionId === undefined && scheduleType === 'at') {
            // Default: a one-shot task created inside a session belongs to that
            // session (the follow-up continues this conversation). Recurring
            // tasks keep the fresh-session-per-run default so they cannot bloat
            // one context with every repeat.
            targetSessionId = sessionId;
          }
        }
        const created = control.createTask({
          metabotId,
          name,
          description: 'Auto-created by a MetaWeb surf session (work undertaken while surfing).',
          prompt,
          schedule,
          targetSessionId,
          exitCondition: exitCondition || null,
          maxFires,
          originSessionId: sessionId,
          originContext: 'surf',
        });
        if (surfState) {
          surfState.tasksScheduled = (surfState.tasksScheduled ?? 0) + 1;
          (surfState.scheduledTaskIds ??= []).push(created.id);
        }
        const nextRun = created.nextRunAtMs ? new Date(created.nextRunAtMs).toLocaleString() : 'unscheduled';
        const remaining = surfState
          ? ` Tasks remaining this surf run: ${SURF_SCHEDULED_TASK_CAP - (surfState.tasksScheduled ?? 0)}.`
          : '';
        return textResult(
          `Scheduled task created: "${created.name}" (id ${created.id}), next run: ${nextRun}. It will execute unattended as a full work session.${remaining}`,
        );
      } catch (error) {
        return textResult(`create_scheduled_task failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  return [createScheduledTask];
}
