/**
 * Shared Group Task worker-session helpers (P1-3 invite immediate wake-up).
 *
 * The invite-wakeup problem: after a member joins (local join or OpenTeam
 * invite ACCEPT), the worker session used to be created LAZILY on the first
 * daemon reply — with no group context preloaded, and nothing visible to the
 * host until the worker actually answered. These helpers create the cowork
 * session EAGERLY (within the join/invite call, i.e. well under a minute)
 * and inject the group context (goal + acceptance + roster + recent
 * transcript) so the invited bot can answer immediately with full context.
 *
 * Used by: groupTaskService (create/join/invite), groupTaskDaemon
 * (its per-turn session lookup delegates here so there is exactly ONE
 * session-creation code path), and openTeamGuestService (invitee-side host).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CoworkStore, CoworkSession } from '../coworkStore';
import type { GroupTask, GroupTaskStore } from '../groupTaskStore';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';

/** Group Task conversation channel (same value the daemon uses). */
export const GROUP_TASK_CONVERSATION_CHANNEL = 'metaweb_group_task';

/**
 * fix-v2 P1-5: every DSH session-log corruption signature the runtime can
 * raise, matched loosely so all drivers route them to session rebuild instead
 * of the blind retry ladder:
 * - 'corrupt session log: seq gap in committed region ...' (read-time scanner,
 *   the two-writer overlap from a driver handoff race, task #57);
 * - 'append seq mismatch for "<id>": expected ... got ...' (write-time cursor
 *   check, dsh-session-persistence);
 * - 'corrupt session log: unparsable committed event ...' (torn tail).
 * Deliberately NOT matched: SessionFormatUnsupportedError and the
 * zstd/plaintext encoding-mismatch family — those have their own heal path.
 */
export function isCorruptSessionLogError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /corrupt session log|append seq mismatch|seq gap in committed region/i.test(message);
}

/**
 * One-line, length-capped corruption signature for alert text. The runtime
 * error message carries the forensic detail (gap line, expected/got seq
 * values); alerts must quote it so post-mortems see WHERE the log broke
 * without opening the session file.
 */
export function corruptSessionLogSignature(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

/** Sanitize a conversation id into one safe workspace folder name. */
function groupTaskWorkspaceSegment(externalConversationId: string): string {
  const segment = externalConversationId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return segment || 'task';
}

/**
 * fix-v2 (B4): per-task workspace under the per-bot dated directory —
 * `<base>/bots/<botId>/<date>/group-task-<taskId>`. The dated per-bot folder
 * alone let PREVIOUS tasks' files (old skill trees, stale attachments) leak
 * into a new task's chair session context (tasks #54/#55 both hit it); one
 * folder per task keeps episodes isolated. A recreated session for the SAME
 * task resolves the SAME folder, so mid-task rebuilds keep their artifacts.
 */
export function resolveGroupTaskSessionWorkspace(
  baseCwd: string,
  externalConversationId: string,
): string {
  const workspaceRoot = path.join(baseCwd, groupTaskWorkspaceSegment(externalConversationId));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

/** Minimal task shape the session helpers need (GroupTask or a guest subset). */
export interface GroupTaskSessionTaskLike {
  id: number;
  title: string;
  groupId: string | null;
}

/** Metadata stamped on the conversation mapping (display/debug only). */
export interface GroupTaskSessionOptions {
  channel?: string;
  externalConversationId?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  /** Runtime-causal parent: the chat session that initiated the group task. */
  parentSessionId?: string | null;
}

/**
 * Find or create the cowork session bound to a (task, bot) conversation
 * mapping. Same mapping convention as the daemon's historical lazy path:
 * channel 'metaweb_group_task', externalConversationId 'group-task:<taskId>'.
 * Returns { session, created } so callers can decide whether to inject
 * context (fresh sessions only).
 */
export function ensureGroupTaskSession(
  coworkStore: CoworkStore,
  task: GroupTaskSessionTaskLike,
  botId: number,
  botName: string,
  opts?: GroupTaskSessionOptions,
): { session: CoworkSession; created: boolean } {
  const channel = opts?.channel ?? GROUP_TASK_CONVERSATION_CHANNEL;
  const externalConversationId = opts?.externalConversationId ?? `group-task:${task.id}`;
  const existing = coworkStore.getConversationMapping(channel, externalConversationId, botId);
  if (existing) {
    const session = coworkStore.getSession(existing.coworkSessionId);
    if (session) return { session, created: false };
  }
  const config = coworkStore.getConfig();
  const botWorkspaceCwd = resolveSessionWorkingDirectory(
    (config.workingDirectory ?? '').trim() || process.cwd(),
    botId,
  );
  // fix-v2 (B4): one workspace folder per task — previous episodes' files no
  // longer leak into this task's sessions.
  const workspaceRoot = resolveGroupTaskSessionWorkspace(botWorkspaceCwd, externalConversationId);
  const session = coworkStore.createSession(
    opts?.title ?? `Group Task #${task.id} (${botName})`,
    workspaceRoot,
    '',
    config.executionMode || 'local',
    [],
    botId,
    'group_task',
    null,
    null,
    null,
    'default',
    null,
    null,
    null,
    null,
    null,
    opts?.parentSessionId ?? null,
  );
  coworkStore.upsertConversationMapping({
    channel,
    externalConversationId,
    metabotId: botId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify(opts?.metadata ?? { taskId: task.id, groupId: task.groupId }),
  });
  return { session, created: true };
}

/** Roster line for the injected context snapshot (name + role). */
export interface GroupTaskContextMember {
  name: string | null;
  role: 'chair' | 'worker';
}

/** One recent transcript row for the injected context snapshot. */
export interface GroupTaskContextMessage {
  senderName: string | null;
  content: string | null;
}

/**
 * fix-v2 (B6): the authoritative task ledger for a context snapshot — task
 * status, the recorded status trail, and every deliverable row (kind, uri,
 * ledger status, on-chain confirmation, author). A session (re)created
 * mid-task must rebuild its task knowledge from this host state, not from
 * the truncated recent-message window alone: task #55's rebuilt chair
 * session lost every earlier acceptance and misreported "waiting for owner
 * acceptance" while the task was still executing.
 */
export function buildGroupTaskLedgerLines(
  store: GroupTaskStore,
  task: GroupTaskSessionTaskLike & { status?: string | null },
): string[] {
  const lines: string[] = [];
  const status = (task.status ?? '').trim();
  if (status) lines.push(`- Status: ${status}`);
  try {
    const events = store.listStatusEvents(task.id);
    if (events.length > 0) {
      const trail = events.map((event) => `${event.fromStatus} -> ${event.toStatus}`).join(', ');
      lines.push(`- Status trail: ${trail}`);
    }
  } catch {
    // best-effort ledger read
  }
  try {
    const deliverables = store.listDeliverables(task.id);
    if (deliverables.length === 0) {
      lines.push('- Deliverables: none recorded on the ledger yet');
    } else {
      lines.push(`- Deliverables on the ledger (${deliverables.length}):`);
      for (const deliverable of deliverables) {
        lines.push(
          `  - [${deliverable.kind ?? 'text'}] ${deliverable.uri ?? '(no uri)'} ` +
          `(${deliverable.status}, ${deliverable.confirmation}) by ${deliverable.sourceSenderName ?? 'unknown'}`,
        );
      }
    }
  } catch {
    // best-effort ledger read
  }
  return lines;
}

/**
 * Inject the group context (goal, acceptance, ledger, roster, recent
 * transcript) into the member's session as one clearly-marked [SYSTEM] user
 * message. Only injects into sessions that have no messages yet —
 * re-injection would duplicate the context on every eager-join retry.
 */
export function injectGroupTaskContext(input: {
  coworkStore: CoworkStore;
  sessionId: string;
  task: {
    title: string;
    goal: string;
    acceptanceCriteria?: string | null;
  };
  members: GroupTaskContextMember[];
  recentMessages: GroupTaskContextMessage[];
  recentCount?: number;
  /** fix-v2 (B6): authoritative host task-ledger lines (status/deliverables). */
  ledgerLines?: string[];
}): void {
  const session = input.coworkStore.getSession(input.sessionId);
  if (!session || session.messages.length > 0) return;
  const recentCount = Math.max(1, Math.min(50, Math.trunc(input.recentCount ?? 20)));
  const membersText = input.members.length > 0
    ? input.members.map((member) => `- ${member.name ?? '(unnamed)'} [${member.role}]`).join('\n')
    : '- (chair only)';
  const recent = input.recentMessages.slice(-recentCount);
  const logLines = recent.length > 0
    ? recent.map((message) => `${message.senderName ?? 'Unknown'}: ${message.content ?? ''}`)
    : ['(no messages yet)'];
  const acceptance = (input.task.acceptanceCriteria ?? '').trim() || '(none specified)';
  const ledgerLines = (input.ledgerLines ?? []).filter((line) => line.trim());
  const ledgerSection = ledgerLines.length > 0
    ? ['', 'Task ledger (authoritative host state — trust it over the message window):', ...ledgerLines]
    : [];
  const snapshot = [
    '[SYSTEM group context snapshot — injected by the host at join time, not a group participant message]',
    `Task: ${input.task.title}`,
    `Goal: ${input.task.goal}`,
    `Acceptance criteria: ${acceptance}`,
    ...ledgerSection,
    '',
    'Roster:',
    membersText,
    '',
    `Recent group log (last ${recentCount} messages):`,
    ...logLines,
  ].join('\n');
  input.coworkStore.addMessage(input.sessionId, {
    type: 'user',
    content: snapshot,
    metadata: { origin: 'group_task' },
  });
}

/**
 * Guest-side variant (OpenTeam invitee host): the invitee has no local
 * GroupTask row, so the session binds to the on-chain group id
 * (externalConversationId 'openteam:<groupId>') and the injected context is
 * task title + recent transcript.
 *
 * R11 (P6, OpenTeam chat scenario 2026-09): this session is the LOG MIRROR —
 * eagerly created at invite-accept for context injection and A2A visibility,
 * with every guest turn's user+assistant pair written back into it by the
 * daemon. The model NEVER runs a turn on it (skill turns run in the separate
 * per-group guest session, externalConversationId 'openteam-guest:<groupId>'
 * in openTeamGuestDaemon). New sessions carry the explicit mirror title and
 * metadata so post-mortems cannot misread the pair as "one prompt, two model
 * turns" (session 289bc3f2 vs 54612951 in the 2026-09-08 incident); existing
 * mappings keep their id and are untouched.
 */
export function ensureOpenTeamGuestSession(
  coworkStore: CoworkStore,
  botId: number,
  botName: string,
  membership: { groupId: string; taskTitle?: string | null },
): { session: CoworkSession; created: boolean } {
  return ensureGroupTaskSession(
    coworkStore,
    { id: -1, title: membership.taskTitle?.trim() || 'OpenTeam group task', groupId: membership.groupId },
    botId,
    botName,
    {
      externalConversationId: `openteam:${membership.groupId}`,
      metadata: { groupId: membership.groupId, openTeam: true, role: 'log-mirror' },
      title: `OpenTeam Group Task (${botName}) [log mirror]`,
    },
  );
}

/** Inject the guest context snapshot into the invitee's session. */
export function injectOpenTeamGuestContext(input: {
  coworkStore: CoworkStore;
  sessionId: string;
  taskTitle?: string | null;
  inviterGlobalmetaid?: string | null;
  /** R1: group mode ('task' | 'chat'); defaults to 'task'. */
  groupMode?: 'task' | 'chat';
  recentMessages: GroupTaskContextMessage[];
  recentCount?: number;
}): void {
  const session = input.coworkStore.getSession(input.sessionId);
  if (!session || session.messages.length > 0) return;
  const recentCount = Math.max(1, Math.min(50, Math.trunc(input.recentCount ?? 20)));
  const inviter = (input.inviterGlobalmetaid ?? '').trim();
  const recent = input.recentMessages.slice(-recentCount);
  const logLines = recent.length > 0
    ? recent.map((message) => `${message.senderName ?? 'Unknown'}: ${message.content ?? ''}`)
    : ['(no messages yet)'];
  const chatMode = input.groupMode === 'chat';
  const snapshot = [
    '[SYSTEM OpenTeam context snapshot — injected by the host at invite-accept time, not a group participant message]',
    `You were invited${inviter ? ` by \`${inviter}\`` : ''} to an external group ${chatMode ? 'CHAT' : 'task'}: "${input.taskTitle?.trim() || '(untitled)'}".`,
    chatMode
      ? 'This is a free-form conversation — no deliverables, no task protocol. Your replies come from your own machine as a remote teammate.'
      : 'Your replies come from your own machine as a remote teammate.',
    '',
    `Recent group log (last ${recentCount} messages):`,
    ...logLines,
  ].join('\n');
  input.coworkStore.addMessage(input.sessionId, {
    type: 'user',
    content: snapshot,
    metadata: { origin: 'group_task' },
  });
}

/** Convenience: full eager-session setup for one local group-task member. */
export function ensureGroupTaskMemberReady(input: {
  coworkStore: CoworkStore;
  groupTaskStore: GroupTaskStore;
  task: GroupTask;
  botId: number;
  botName: string;
  recentCount?: number;
}): { sessionId: string; created: boolean } {
  const { session, created } = ensureGroupTaskSession(
    input.coworkStore,
    input.task,
    input.botId,
    input.botName,
  );
  if (created) {
    seedGroupTaskSessionContext({ ...input, sessionId: session.id });
  }
  return { sessionId: session.id, created };
}

/**
 * Seed a freshly created (task, bot) session with the group context snapshot
 * (roster + ledger + recent transcript). Shared by the eager-join path and the
 * corrupt-log rebuild below so both produce the same starting context.
 */
function seedGroupTaskSessionContext(input: {
  coworkStore: CoworkStore;
  groupTaskStore: GroupTaskStore;
  task: GroupTask;
  botId: number;
  sessionId: string;
  recentCount?: number;
}): void {
  const members = input.groupTaskStore.listMembers(input.task.id);
  const recentMessages = input.task.groupId
    ? input.groupTaskStore.listGroupChatMessages(input.task.groupId, { limit: input.recentCount ?? 20 })
    : [];
  injectGroupTaskContext({
    coworkStore: input.coworkStore,
    sessionId: input.sessionId,
    task: {
      title: input.task.title,
      goal: input.task.goal,
      acceptanceCriteria: input.task.acceptanceCriteria,
    },
    members: members.map((member) => ({ name: member.name, role: member.role })),
    recentMessages,
    recentCount: input.recentCount,
    ledgerLines: buildGroupTaskLedgerLines(input.groupTaskStore, input.task),
  });
}

/**
 * fix/group-task-duration (task #57): force-replace the (task, bot) cowork
 * session with a FRESH one seeded from the host ledger, repointing the
 * conversation mapping. Used when the underlying DSH session log is corrupt
 * ("seq gap in committed region") — every turn on that session fails fast
 * forever, so without a rebuild the task turns into a permanent zombie. The
 * old session row stays in place for post-mortem; the new session resolves
 * the SAME per-task workspace, so mid-task artifacts survive the rebuild.
 */
export function rebuildGroupTaskSession(input: {
  coworkStore: CoworkStore;
  groupTaskStore: GroupTaskStore;
  task: GroupTask;
  botId: number;
  botName: string;
  recentCount?: number;
}): { sessionId: string } {
  const channel = GROUP_TASK_CONVERSATION_CHANNEL;
  const externalConversationId = `group-task:${input.task.id}`;
  const config = input.coworkStore.getConfig();
  const botWorkspaceCwd = resolveSessionWorkingDirectory(
    (config.workingDirectory ?? '').trim() || process.cwd(),
    input.botId,
  );
  const workspaceRoot = resolveGroupTaskSessionWorkspace(botWorkspaceCwd, externalConversationId);
  // Preserve the runtime-causal parent across rebuilds: the corrupt session's
  // parent (if any) carries over, per the宁缺毋错 rule (no guessing).
  const replacedMapping = input.coworkStore.getConversationMapping(
    channel,
    externalConversationId,
    input.botId,
  );
  const replacedParent = replacedMapping
    ? input.coworkStore.getSession(replacedMapping.coworkSessionId)?.parentSessionId ?? null
    : null;
  const session = input.coworkStore.createSession(
    `Group Task #${input.task.id} (${input.botName}) [rebuilt]`,
    workspaceRoot,
    '',
    config.executionMode || 'local',
    [],
    input.botId,
    'group_task',
    null,
    null,
    null,
    'default',
    null,
    null,
    null,
    null,
    null,
    replacedParent,
  );
  input.coworkStore.upsertConversationMapping({
    channel,
    externalConversationId,
    metabotId: input.botId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({
      taskId: input.task.id,
      groupId: input.task.groupId,
      rebuiltFromCorruptLog: true,
    }),
  });
  seedGroupTaskSessionContext({ ...input, sessionId: session.id });
  return { sessionId: session.id };
}
