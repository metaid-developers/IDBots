import path from 'node:path';
import { z } from 'zod';
import type { TwinTodoItem, TwinTodoStatus, TwinTodoStore } from '../twinTodoStore';

type ToolFactory = <Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<z.ZodObject<Schema>>, extra: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>,
) => unknown;

export interface TwinTodoSessionDefaults {
  sessionId: string | null;
  projectKey: string | null;
}

export interface TwinTodoToolsControl {
  isEnabledForSession(sessionId: string): boolean;
  resolveMetabotId(sessionId: string): number | null;
  resolveSessionDefaults(sessionId: string): TwinTodoSessionDefaults;
  store(): TwinTodoStore;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function inferProjectKeyFromWorkspace(
  projectId?: string | null,
  cwd?: string | null,
): string | null {
  const trimmedProject = typeof projectId === 'string' ? projectId.trim() : '';
  if (trimmedProject) return trimmedProject.slice(0, 64);
  const trimmedCwd = typeof cwd === 'string' ? cwd.trim() : '';
  if (!trimmedCwd) return null;
  const normalized = trimmedCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  // Date-stamped bot scratch workspaces (`/project/bots/1/2026-11-17`) are not named projects.
  if (/\/bots\/\d+\/\d{4}-\d{2}-\d{2}$/i.test(normalized)) return null;
  const worktreeIdx = normalized.indexOf('/.worktrees/');
  if (worktreeIdx > 0) {
    const repoRoot = normalized.slice(0, worktreeIdx);
    const repoBase = path.posix.basename(repoRoot);
    return repoBase ? repoBase.slice(0, 64) : null;
  }
  const base = path.posix.basename(normalized);
  return base && base !== '.' && base !== '/' ? base.slice(0, 64) : null;
}

export function formatCompactTwinTodoLine(item: TwinTodoItem): string {
  const mark = item.status === 'done' ? '✓' : '·';
  const tags: string[] = [];
  if (item.taskId) tags.push(`task=${item.taskId}`);
  if (item.projectKey) tags.push(`proj=${item.projectKey}`);
  if (item.sessionId) tags.push(`chat=${item.sessionId.slice(0, 8)}`);
  const meta = tags.length > 0 ? ` (${tags.join(', ')})` : '';
  const note = item.note ? ` — ${item.note}` : '';
  return `${mark} [${item.id}] ${item.title}${meta}${note}`;
}

/**
 * Ultra-compact volatile reminder block injected only when open pending todos
 * exist (zero tokens when empty). Kept short by design so Twin Bot never
 * forgets lightweight follow-ups without paying heavy prompt overhead.
 */
export function formatCompactTwinTodosPromptBlock(
  items: TwinTodoItem[],
  maxItems: number = 12,
): string {
  const pending = items.filter((item) => item.status === 'pending');
  if (pending.length === 0) return '';
  const shown = pending.slice(0, Math.max(1, maxItems));
  const overflow = pending.length - shown.length;
  return [
    `<twin_pending_todos count="${pending.length}">`,
    'Your internal memory todo reminders (hidden from the owner UI; keep crisp — mark completed via twin_todo as soon as done, and advance ready items without forgetting):',
    ...shown.map((item) => formatCompactTwinTodoLine(item)),
    ...(overflow > 0 ? [`… +${overflow} more (call twin_todo action="list" to inspect all)`] : []),
    '</twin_pending_todos>',
  ].join('\n');
}

const ADD_ITEM_SCHEMA = z.object({
  title: z.string().min(1).describe('Ultra-concise 1-line reminder (prefer <= 40 chars).'),
  taskId: z.string().optional().describe('Optional linked task id (e.g. ltt_... or orchestration taskId); omit for standalone todos.'),
  sessionId: z.string().optional().describe('Optional origin demand conversation id (defaults to the current/origin session).'),
  projectKey: z.string().optional().describe('Optional project identifier/repo name (auto-inferred when omitted).'),
  note: z.string().optional().describe('Optional short trigger/condition note (<= 140 chars), e.g. "after branch merges".'),
});

export function buildTwinTodoAgentTools(params: {
  tool: ToolFactory;
  control: TwinTodoToolsControl;
  sessionId: string;
  readOnly?: boolean;
}): unknown[] {
  const { tool, control, sessionId, readOnly = false } = params;
  if (!control.isEnabledForSession(sessionId)) {
    return [];
  }

  const actionEnum = readOnly
    ? z.enum(['list'])
    : z.enum(['list', 'add', 'complete', 'update', 'remove', 'clear_done']);

  const todoTool = tool(
    'twin_todo',
    'Manage YOUR lightweight persistent internal memory todo list (NOT shown to the human in UI or Task Progress HUD — strictly your own cross-turn anti-forgetting checklist, lighter than Long-Term/Managed Tasks). Every todo item records pending/done state and may optionally link to a task (`taskId`), demand conversation (`sessionId`, auto-filled), and project (`projectKey`, auto-filled). Turn discipline: (1) at turn start, if the owner mentions lightweight requests, deferred follow-ups ("after X finishes do Y", "remember to..."), or multi-point side items that do not warrant a heavy owner-facing Task Card, add concise reminders (`action="add"`); (2) whenever an item finishes or becomes obsolete during a turn, immediately update its status (`action="complete"` with `id` or `ids`); (3) call `action="list"` anytime you need to recall open todos (optionally filtered by `taskId`, `projectKey`, or `includeDone=true`). Keep titles short and token-lean.',
    {
      action: actionEnum,
      id: z.string().optional().describe('Single todo id (e.g. "td_a1b2c3") for complete/update/remove.'),
      ids: z.array(z.string().min(1)).optional().describe('Batch todo ids for complete/remove.'),
      title: z.string().optional().describe('Short 1-line reminder for add/update.'),
      items: z.array(ADD_ITEM_SCHEMA).optional().describe('Optional batch of todos to add in one call.'),
      status: z.enum(['pending', 'done']).optional().describe('Target status when action="update".'),
      taskId: z.string().optional().describe('Optional task id to link (add/update) or filter by (list/clear_done).'),
      sessionId: z.string().optional().describe('Optional demand conversation id to link or filter by.'),
      projectKey: z.string().optional().describe('Optional project name/id to link or filter by.'),
      note: z.string().optional().describe('Optional brief trigger or completion note.'),
      includeDone: z.boolean().optional().describe('Include completed todos when action="list" (default false).'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      const metabotId = control.resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult('twin_todo unavailable: no MetaBot bound to this session.', true);
      }
      const store = control.store();
      const defaults = control.resolveSessionDefaults(sessionId);

      if (args.action === 'list') {
        const rows = store.list({
          metabotId,
          includeDone: args.includeDone === true,
          taskId: args.taskId,
          sessionId: args.sessionId,
          projectKey: args.projectKey,
          limit: args.limit ?? 50,
        });
        if (rows.length === 0) {
          return textResult(args.includeDone ? 'No todos recorded.' : 'No pending todos.');
        }
        return textResult([
          `${args.includeDone ? 'Todos' : 'Pending todos'} (${rows.length}):`,
          ...rows.map((item) => formatCompactTwinTodoLine(item)),
        ].join('\n'));
      }

      if (readOnly) {
        return textResult('twin_todo is read-only in this session.', true);
      }

      if (args.action === 'add') {
        const inputs = Array.isArray(args.items) && args.items.length > 0
          ? args.items
          : (args.title?.trim() ? [{
              title: args.title,
              taskId: args.taskId,
              sessionId: args.sessionId,
              projectKey: args.projectKey,
              note: args.note,
            }] : []);
        if (inputs.length === 0) {
          return textResult('twin_todo add requires `title` or non-empty `items`.', true);
        }
        const addedLines: string[] = [];
        for (const entry of inputs) {
          const created = store.add({
            metabotId,
            title: entry.title,
            taskId: entry.taskId ?? args.taskId ?? null,
            sessionId: entry.sessionId ?? args.sessionId ?? defaults.sessionId,
            projectKey: entry.projectKey ?? args.projectKey ?? defaults.projectKey,
            note: entry.note ?? null,
          });
          addedLines.push(`${created.reused ? 'Updated existing' : 'Added'} ${formatCompactTwinTodoLine(created.item)}`);
        }
        return textResult(addedLines.join('\n'));
      }

      if (args.action === 'complete') {
        const targetIds = [
          ...(args.id ? [args.id] : []),
          ...(Array.isArray(args.ids) ? args.ids : []),
        ];
        if (targetIds.length === 0) {
          return textResult('twin_todo complete requires `id` or `ids`.', true);
        }
        const completed = store.completeMany(metabotId, targetIds, args.note);
        if (completed.length === 0) {
          return textResult(`No matching todo found for: ${targetIds.join(', ')}`, true);
        }
        const remaining = store.list({ metabotId, includeDone: false, limit: 20 });
        return textResult([
          `Completed (${completed.length}): ${completed.map((c) => `[${c.id}] ${c.title}`).join('; ')}`,
          remaining.length > 0
            ? `Remaining pending (${remaining.length}):\n${remaining.map((r) => formatCompactTwinTodoLine(r)).join('\n')}`
            : 'All pending todos are now complete.',
        ].join('\n'));
      }

      if (args.action === 'update') {
        if (!args.id?.trim()) {
          return textResult('twin_todo update requires `id`.', true);
        }
        const updated = store.update(metabotId, args.id, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.status !== undefined ? { status: args.status as TwinTodoStatus } : {}),
          ...(args.taskId !== undefined ? { taskId: args.taskId || null } : {}),
          ...(args.sessionId !== undefined ? { sessionId: args.sessionId || null } : {}),
          ...(args.projectKey !== undefined ? { projectKey: args.projectKey || null } : {}),
          ...(args.note !== undefined ? { note: args.note || null } : {}),
        });
        if (!updated) {
          return textResult(`Todo not found: ${args.id}`, true);
        }
        return textResult(`Updated ${formatCompactTwinTodoLine(updated)}`);
      }

      if (args.action === 'remove') {
        const targetIds = [
          ...(args.id ? [args.id] : []),
          ...(Array.isArray(args.ids) ? args.ids : []),
        ];
        if (targetIds.length === 0) {
          return textResult('twin_todo remove requires `id` or `ids`.', true);
        }
        const count = store.removeMany(metabotId, targetIds);
        return textResult(`Removed ${count} todo(s).`);
      }

      if (args.action === 'clear_done') {
        const cleared = store.clearDone(metabotId, args.taskId);
        return textResult(`Cleared ${cleared} completed todo(s).`);
      }

      return textResult(`Unsupported twin_todo action: ${String(args.action)}`, true);
    },
  );

  return [todoTool];
}
