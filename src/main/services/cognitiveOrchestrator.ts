/**
 * Cognitive Orchestrator daemon: goal-oriented multi-agent group chat orchestration.
 * Phase 1: Attention filter (mention + probability/cooldown).
 * Task 12.2: Context assembly, LLM reply, /protocols/simplegroupchat broadcast.
 */

import type { Database } from 'sql.js';

const TICK_INTERVAL_MS = 10_000;
const LOG_EVERY_N_TICKS = 6; // log summary every ~1 min when no trigger

let tickCount = 0;

export interface GroupChatTaskRow {
  id: number;
  group_id: string;
  metabot_id: number;
  is_active: number;
  reply_on_mention: number;
  random_reply_probability: number;
  cooldown_seconds: number;
  context_message_count: number;
  discussion_background: string | null;
  participation_goal: string | null;
  supervisor_metaid: string | null;
  allowed_skills: string | null;
  original_prompt: string | null;
  start_time: string | null;
  last_replied_at: string | null;
  last_processed_msg_id: number;
}

export interface GroupChatMessageRow {
  id: number;
  group_id: string;
  content: string | null;
  sender_name: string | null;
  [k: string]: unknown;
}

/** MetaBot persona for prompt assembly and LLM selection */
export interface MetabotInfo {
  id: number;
  name: string;
  role: string;
  soul: string;
  llm_id: string | null;
  globalmetaid: string | null;
  metaid?: string;
}

type GetMetabotByIdFn = (id: number) => MetabotInfo | null;
type SaveDbFn = () => void;
/** (systemPrompt, userMessage, llmId?) => reply text */
export type PerformChatCompletionFn = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null
) => Promise<string>;
/** (metabotId, groupId, nickName, content) => void; signs and broadcasts via create-pin */
export type BroadcastGroupChatFn = (
  metabotId: number,
  groupId: string,
  nickName: string,
  content: string
) => Promise<void>;

let tickIntervalId: ReturnType<typeof setInterval> | null = null;
/** Task IDs currently in LLM/broadcast pipeline; skip them in tick to avoid duplicate triggers */
const thinkingTasks = new Set<number>();

function parseMentionArray(mentionJson: string | null): string[] {
  if (mentionJson == null || mentionJson === '') return [];
  try {
    const arr = JSON.parse(mentionJson);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function contentContainsBotName(content: string | null, botName: string): boolean {
  if (content == null || content === '' || botName === '') return false;
  const lower = content.toLowerCase().trim();
  const nameLower = botName.toLowerCase().trim();
  return lower.includes(nameLower);
}

function mentionContainsMetaId(mentionJson: string | null, globalMetaId: string | null, metaId: string | undefined): boolean {
  const ids = parseMentionArray(mentionJson);
  if (ids.length === 0) return false;
  const target = (globalMetaId ?? metaId ?? '').trim();
  if (target === '') return false;
  return ids.some((id) => String(id).trim() === target);
}

/** Fetch recent messages for context (ASC by id). */
function getRecentMessages(
  db: Database,
  groupId: string,
  limit: number
): GroupChatMessageRow[] {
  const result = db.exec(
    `SELECT id, group_id, content, sender_name FROM group_chat_messages
     WHERE group_id = ? ORDER BY id DESC LIMIT ?`,
    [groupId, limit]
  );
  if (!result[0]?.values?.length) return [];
  const cols = result[0].columns as string[];
  const rows = result[0].values as unknown[][];
  const out = rows.map((row) =>
    cols.reduce((acc, c, i) => {
      acc[c] = row[i];
      return acc;
    }, {} as Record<string, unknown>)
  ) as GroupChatMessageRow[];
  out.reverse();
  return out;
}

/** Build system prompt per SDD (Chinese in template for LLM instruction). */
function buildSystemPrompt(
  name: string,
  role: string,
  soul: string,
  discussionBackground: string | null,
  participationGoal: string | null,
  contextLines: string[]
): string {
  const background = discussionBackground?.trim() || '无特定背景';
  const goal = participationGoal?.trim() || '自然地参与聊天';
  const contextBlock =
    contextLines.length > 0
      ? contextLines.join('\n')
      : '(No recent messages)';
  return `[System Role]
你是名为 ${name} 的 Web3 数字生命。你的人设是: ${role}
${soul}

[Current Mission]
你正在参与一个群聊。
讨论背景 (Background): ${background}
你的目标 (Goal): ${goal}

[Strict Rules]
1. 必须完全沉浸在人设中，绝不能承认自己是 AI 或语言模型。
2. 根据上下文和你的目标进行回复。如果有人问你问题，请直接回答；如果是闲聊，请符合你的人设。
3. 你的回复将直接发送到群聊，**只输出你回复的文本内容，不要包含任何前缀、解释或动作描写**。

[Chat Context (Recent Messages)]
${contextBlock}
`;
}

/** Assemble user message: last N messages as context; model should reply. */
function buildUserMessage(): string {
  return '请根据以上群聊上下文，以你的人设回复一条消息。只输出回复内容，不要解释。';
}

/**
 * Run the reply pipeline: context -> prompt -> LLM -> broadcast -> update state.
 * Must be wrapped in try/catch and finally(thinkingTasks.delete).
 */
async function runReplyPipeline(
  task: GroupChatTaskRow,
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn
): Promise<void> {
  const metabot = getMetabotById(task.metabot_id);
  if (!metabot) {
    console.error('[Orchestrator] MetaBot not found for task', task.id);
    return;
  }

  const limit = Math.max(1, task.context_message_count ?? 30);
  const messages = getRecentMessages(db, task.group_id, limit);
  const contextLines = messages.map((m) => {
    const sender = (m.sender_name ?? 'Unknown').trim() || 'Unknown';
    const content = (m.content ?? '').trim() || '(empty)';
    return `${sender}: ${content}`;
  });

  const systemPrompt = buildSystemPrompt(
    metabot.name,
    metabot.role ?? '',
    metabot.soul ?? '',
    task.discussion_background,
    task.participation_goal,
    contextLines
  );
  const userMessage = buildUserMessage();

  if (process.env.NODE_ENV === 'development') {
    console.log('[Orchestrator] Assembled system prompt (first 500 chars):', systemPrompt.slice(0, 500));
  }

  let replyText: string;
  try {
    replyText = await performChatCompletion(systemPrompt, userMessage, metabot.llm_id ?? undefined);
  } catch (err) {
    console.error('[Orchestrator] LLM call failed:', err instanceof Error ? err.message : err);
    return;
  }

  const trimmed = (replyText ?? '').trim();
  if (!trimmed) {
    console.warn('[Orchestrator] LLM returned empty reply; skip broadcast');
    return;
  }

  try {
    await broadcastGroupChat(task.metabot_id, task.group_id, metabot.name, trimmed);
  } catch (err) {
    console.error('[Orchestrator] Broadcast failed:', err instanceof Error ? err.message : err);
    return;
  }

  const nowIso = new Date().toISOString();
  db.run('UPDATE group_chat_tasks SET last_replied_at = ? WHERE id = ?', [nowIso, task.id]);
  saveDb();
  console.log('[Orchestrator] Reply sent successfully for task', task.id, 'group', task.group_id);
}

/**
 * Run one orchestrator cycle: fetch active tasks, get new messages per task,
 * apply attention filter; on trigger, enqueue async pipeline and update last_processed_msg_id.
 */
async function tick(
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn
): Promise<void> {
  tickCount += 1;
  const taskRows = db.exec(
    'SELECT * FROM group_chat_tasks WHERE is_active = 1'
  );
  const taskCount = taskRows[0]?.values?.length ?? 0;
  if (taskCount === 0) {
    if (tickCount % LOG_EVERY_N_TICKS === 1) {
      console.log('[Orchestrator] tick: no active tasks');
    }
    return;
  }

  const columns = taskRows[0].columns as (keyof GroupChatTaskRow)[];
  const rows = taskRows[0].values as unknown[][];
  const tickLog: string[] = [];

  for (const row of rows) {
    const task = columns.reduce((acc, col, i) => {
      acc[col] = row[i];
      return acc;
    }, {} as Record<string, unknown>) as unknown as GroupChatTaskRow;

    if (thinkingTasks.has(task.id)) continue;

    // If last_processed_msg_id is ahead of max(id) for this group (e.g. after table recreate), reset so we don't skip messages
    const maxIdResult = db.exec(
      'SELECT COALESCE(MAX(id), 0) AS max_id FROM group_chat_messages WHERE group_id = ?',
      [task.group_id]
    );
    const maxIdInGroup =
      maxIdResult[0]?.values?.[0]?.[0] != null ? Number(maxIdResult[0].values[0][0]) : 0;
    let effectiveLastProcessed = task.last_processed_msg_id ?? 0;
    if (maxIdInGroup > 0 && effectiveLastProcessed > maxIdInGroup) {
      effectiveLastProcessed = 0;
      db.run('UPDATE group_chat_tasks SET last_processed_msg_id = 0 WHERE id = ?', [task.id]);
      saveDb();
      if (tickCount % LOG_EVERY_N_TICKS === 1) {
        console.log(
          `[Orchestrator] task ${task.id} group ${task.group_id.slice(0, 12)}…: reset last_processed_msg_id (was ${task.last_processed_msg_id}, max in table ${maxIdInGroup})`
        );
      }
    }

    const newMsgResult = db.exec(
      `SELECT id, group_id, content, mention FROM group_chat_messages
       WHERE group_id = ? AND id > ? AND is_processed = 0
       ORDER BY id ASC`,
      [task.group_id, effectiveLastProcessed]
    );

    const newMsgCount = newMsgResult[0]?.values?.length ?? 0;
    if (tickCount % LOG_EVERY_N_TICKS === 1) {
      tickLog.push(`task${task.id}: last=${effectiveLastProcessed} new=${newMsgCount}`);
    }

    if (!newMsgResult[0]?.values?.length) {
      db.run(
        'UPDATE group_chat_tasks SET last_processed_msg_id = ? WHERE id = ?',
        [effectiveLastProcessed, task.id]
      );
      continue;
    }

    const msgColumns = newMsgResult[0].columns as string[];
    const msgRows = newMsgResult[0].values as unknown[][];
    const metabot = getMetabotById(task.metabot_id);
    const botName = metabot?.name ?? '';
    const botGlobalMetaId = metabot?.globalmetaid ?? null;
    const botMetaId = metabot?.metaid ?? null;

    let maxProcessedId = effectiveLastProcessed;
    const now = Date.now();
    const lastRepliedAtMs = task.last_replied_at
      ? new Date(task.last_replied_at).getTime()
      : 0;
    const cooldownMs = (task.cooldown_seconds ?? 15) * 1000;

    for (const msgRow of msgRows) {
      const msg = msgColumns.reduce((acc, col, i) => {
        acc[col] = msgRow[i];
        return acc;
      }, {} as Record<string, unknown>) as { id: number; content: string | null; mention: string | null };

      const msgId = msg.id as number;
      if (msgId > maxProcessedId) maxProcessedId = msgId;

      let shouldReply = false;
      let reason = '';

      const isMention =
        task.reply_on_mention === 1 &&
        (contentContainsBotName(msg.content ?? null, botName) ||
          mentionContainsMetaId(msg.mention ?? null, botGlobalMetaId, botMetaId));

      if (isMention) {
        shouldReply = true;
        reason = 'Mention';
      } else if (
        (task.random_reply_probability ?? 0) > 0 &&
        Math.random() < (task.random_reply_probability ?? 0)
      ) {
        if (now - lastRepliedAtMs > cooldownMs) {
          shouldReply = true;
          reason = 'Probability';
        }
      }

      if (shouldReply) {
        console.log(
          `[Orchestrator] 🎯 TRIGGER FIRED for Bot ${task.metabot_id} in Group ${task.group_id}. Reason: ${reason}.`
        );
        thinkingTasks.add(task.id);
        runReplyPipeline(
          task,
          db,
          saveDb,
          getMetabotById,
          performChatCompletion,
          broadcastGroupChat
        ).finally(() => {
          thinkingTasks.delete(task.id);
        });
        break;
      }
    }

    db.run(
      'UPDATE group_chat_tasks SET last_processed_msg_id = ? WHERE id = ?',
      [maxProcessedId, task.id]
    );
  }

  if (tickCount % LOG_EVERY_N_TICKS === 1 && tickLog.length > 0) {
    console.log('[Orchestrator] tick:', taskCount, 'tasks,', tickLog.join('; '));
  }

  saveDb();
}

/**
 * Start the Cognitive Orchestrator daemon. Runs tick every 10 seconds.
 * performChatCompletion and broadcastGroupChat are injected for LLM and chain send.
 */
export function startOrchestrator(
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn
): void {
  stopOrchestrator();
  tickCount = 0;
  console.log('[Orchestrator] daemon started (tick every', TICK_INTERVAL_MS / 1000, 's)');
  tickIntervalId = setInterval(() => {
    tick(db, saveDb, getMetabotById, performChatCompletion, broadcastGroupChat).catch((err) => {
      console.error('[Orchestrator] tick error:', err);
    });
  }, TICK_INTERVAL_MS);
}

/**
 * Stop the daemon and clear the interval.
 */
export function stopOrchestrator(): void {
  if (tickIntervalId != null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
  thinkingTasks.clear();
}

/** Export for test script: run a single tick with injected deps */
export async function runTickOnce(
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn
): Promise<void> {
  await tick(db, saveDb, getMetabotById, performChatCompletion, broadcastGroupChat);
}
