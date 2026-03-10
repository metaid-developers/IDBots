/**
 * Assign or update a group chat task (group_chat_tasks).
 * Used by metabot-chat skill and IPC/RPC. If an active task already exists for
 * (metabot_id, group_id), UPDATE it; otherwise INSERT.
 */

import type { Database } from 'sql.js';
import type { MetabotStore } from '../metabotStore';

export interface AssignGroupChatTaskParams {
  target_metabot_name: string;
  group_id: string;
  reply_on_mention?: boolean;
  random_reply_probability?: number;
  cooldown_seconds?: number;
  context_message_count?: number;
  discussion_background?: string;
  participation_goal?: string;
  /** Boss identity: use globalmetaid for user identification. */
  supervisor_globalmetaid?: string;
  /**
   * @deprecated All skills are allowed by default; this field is stored but no longer used for filtering.
   */
  allowed_skills?: string[] | string | null;
  /** Original user instruction for reference; stored in group_chat_tasks.original_prompt. */
  original_prompt?: string | null;
}

export interface AssignGroupChatTaskResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Resolve MetaBot id by name (case-insensitive trim match).
 */
function getMetabotIdByName(metabotStore: MetabotStore, name: string): number | null {
  const list = metabotStore.listMetabots();
  const normalized = name.trim().toLowerCase();
  const found = list.find((m) => m.name.trim().toLowerCase() === normalized);
  return found?.id ?? null;
}

/**
 * Assign or update group_chat_tasks row. If (metabot_id, group_id) already has is_active=1, UPDATE; else INSERT.
 */
export function assignGroupChatTask(
  db: Database,
  saveDb: () => void,
  metabotStore: MetabotStore,
  params: AssignGroupChatTaskParams
): AssignGroupChatTaskResult {
  const metabotId = getMetabotIdByName(metabotStore, params.target_metabot_name);
  if (metabotId == null) {
    return { success: false, message: '', error: '未找到指定的 MetaBot' };
  }

  const group_id = params.group_id?.trim() ?? '';
  if (!group_id) {
    return { success: false, message: '', error: 'group_id is required' };
  }

  const reply_on_mention = params.reply_on_mention !== false ? 1 : 0;
  const random_reply_probability = Math.max(0, Math.min(1, params.random_reply_probability ?? 0.1));
  const cooldown_seconds = Math.max(0, Math.floor(params.cooldown_seconds ?? 15));
  const context_message_count = Math.max(1, Math.min(500, Math.floor(params.context_message_count ?? 30)));
  const discussion_background = params.discussion_background?.trim() ?? null;
  const participation_goal = params.participation_goal?.trim() ?? null;
  const supervisor_globalmetaid = params.supervisor_globalmetaid?.trim() ?? null;

  let allowed_skills: string | null = null;
  if (params.allowed_skills != null) {
    if (Array.isArray(params.allowed_skills)) {
      allowed_skills = JSON.stringify(params.allowed_skills.filter((s) => typeof s === 'string' && s.trim()));
    } else if (typeof params.allowed_skills === 'string' && params.allowed_skills.trim()) {
      try {
        const parsed = JSON.parse(params.allowed_skills) as unknown;
        allowed_skills = Array.isArray(parsed) ? JSON.stringify(parsed.map(String).filter(Boolean)) : params.allowed_skills.trim();
      } catch {
        allowed_skills = params.allowed_skills.trim();
      }
    }
  }
  const original_prompt = params.original_prompt?.trim() ?? null;

  const existing = db.exec(
    'SELECT id FROM group_chat_tasks WHERE metabot_id = ? AND group_id = ? AND is_active = 1 LIMIT 1',
    [metabotId, group_id]
  );

  const metabot = metabotStore.getMetabotById(metabotId);
  const botName = metabot?.name ?? params.target_metabot_name;

  if (existing[0]?.values?.length) {
    const taskId = existing[0].values[0][0] as number;
    db.run(
      `UPDATE group_chat_tasks SET
        reply_on_mention = ?, random_reply_probability = ?, cooldown_seconds = ?,
        context_message_count = ?, discussion_background = ?, participation_goal = ?, supervisor_globalmetaid = ?,
        allowed_skills = ?, original_prompt = ?
       WHERE id = ?`,
      [
        reply_on_mention,
        random_reply_probability,
        cooldown_seconds,
        context_message_count,
        discussion_background,
        participation_goal,
        supervisor_globalmetaid,
        allowed_skills,
        original_prompt,
        taskId,
      ]
    );
    saveDb();
    return {
      success: true,
      message: `Success! Task updated for [${botName}] in group [${group_id.slice(0, 12)}…].`,
    };
  }

  const maxIdResult = db.exec(
    'SELECT COALESCE(MAX(id), 0) AS max_id FROM group_chat_messages WHERE group_id = ?',
    [group_id]
  );
  const initialLastProcessed =
    maxIdResult[0]?.values?.[0]?.[0] != null ? Number(maxIdResult[0].values[0][0]) : 0;

  db.run(
    `INSERT INTO group_chat_tasks (
      group_id, metabot_id, is_active, reply_on_mention, random_reply_probability,
      cooldown_seconds, context_message_count, discussion_background, participation_goal, supervisor_globalmetaid,
      allowed_skills, original_prompt, last_processed_msg_id
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      group_id,
      metabotId,
      reply_on_mention,
      random_reply_probability,
      cooldown_seconds,
      context_message_count,
      discussion_background,
      participation_goal,
      supervisor_globalmetaid,
      allowed_skills,
      original_prompt,
      initialLastProcessed,
    ]
  );
  saveDb();
  return {
    success: true,
    message: `Success! Task assigned to [${botName}] for group [${group_id.slice(0, 12)}…].`,
  };
}
