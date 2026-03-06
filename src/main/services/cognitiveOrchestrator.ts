/**
 * Cognitive Orchestrator daemon: goal-oriented multi-agent group chat orchestration.
 * Phase 1: Attention filter (mention + probability/cooldown).
 * Task 12.2: Context assembly, LLM reply, /protocols/simplegroupchat broadcast.
 * Task 12.4: Cowork-style skill list + Read/Bash only (no per-skill OpenAI tools).
 */

import type { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  chatCompletionWithTools,
  type ChatMessage,
  type OpenAITool,
  type ToolCallResult,
} from './cognitiveChatCompletion';

const TICK_INTERVAL_MS = 10_000;
const LOG_EVERY_N_TICKS = 6; // log summary every ~1 min when no trigger
/** Max tool-call rounds for Read/Bash loop (allow multiple Read + Bash steps). */
const MAX_TOOL_CALLS = 10;
const READ_FILE_MAX_CHARS = 80_000;
const BASH_TIMEOUT_MS = 60_000;

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
  /** @deprecated use supervisor_globalmetaid */
  supervisor_metaid?: string | null;
  /** Boss identity: use globalmetaid for user identification. */
  supervisor_globalmetaid: string | null;
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
  /** @deprecated use sender_global_metaid for user identity */
  sender_metaid?: string | null;
  /** Sender identity: use globalmetaid for user identification. */
  sender_global_metaid?: string | null;
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

/** Optional override for tool-loop LLM (e.g. test mock). Same signature as chatCompletionWithTools. */
export type ChatWithToolsFn = (
  messages: ChatMessage[],
  options: { llmId?: string | null; tools?: OpenAITool[] }
) => Promise<{ content?: string; tool_calls?: ToolCallResult[] }>;

/** Build skill-list prompt for given ids (from SkillManager.buildAutoRoutingPromptForSkillIds). */
export type GetSkillsPromptForIdsFn = (skillIds: string[]) => string | null;

/** Run one skill turn via CoworkRunner (reuse Cowork Read/Bash logic). When provided and useToolLoop, used instead of in-orchestrator Read/Bash loop. */
export type RunSkillTurnViaCoworkFn = (params: {
  systemPrompt: string;
  userMessage: string;
  cwd: string;
}) => Promise<string>;

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

/** Fetch recent messages for context (ASC by id). Uses sender_global_metaid for Boss check. */
function getRecentMessages(
  db: Database,
  groupId: string,
  limit: number
): GroupChatMessageRow[] {
  const result = db.exec(
    `SELECT id, group_id, content, sender_name, sender_global_metaid FROM group_chat_messages
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

/**
 * Build system prompt per SDD. Task 12.4: inject Boss (supervisor) authority.
 * When supervisorMetaid is set and latest message is from Boss, LLM must prioritize and use tools.
 */
function buildSystemPrompt(
  name: string,
  role: string,
  soul: string,
  discussionBackground: string | null,
  participationGoal: string | null,
  contextLines: string[],
  supervisorMetaid: string | null,
  latestMessageSenderMetaid: string | null
): string {
  const background = discussionBackground?.trim() || '无特定背景';
  const goal = participationGoal?.trim() || '自然地参与聊天';
  const contextBlock =
    contextLines.length > 0
      ? contextLines.join('\n')
      : '(No recent messages)';

  const bossBlock =
    supervisorMetaid && supervisorMetaid.trim()
      ? `[Status]
当前群聊中，GlobalMetaID 为 ${supervisorMetaid} 的用户是你的最高长官 (Boss)。
如果当前最新消息是由 Boss (${supervisorMetaid}) 发出的，你必须以最高优先级执行其要求，并优先调用 Tools 来完成任务。

`
      : '';

  const isLatestFromBoss =
    !!supervisorMetaid &&
    !!latestMessageSenderMetaid &&
    String(supervisorMetaid).trim() === String(latestMessageSenderMetaid).trim();
  if (process.env.NODE_ENV === 'development' && supervisorMetaid) {
    console.log('[Orchestrator] Supervisor (Boss) globalmetaid:', supervisorMetaid, '; latest message from:', latestMessageSenderMetaid, '; isLatestFromBoss:', isLatestFromBoss);
  }

  return `[System Role]
你是名为 ${name} 的 Web3 数字生命。你的人设是: ${role}
${soul}
${bossBlock}[Current Mission]
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

/** Parse allowed_skills JSON from task (e.g. \'["mock_get_weather"]\'). */
function parseAllowedSkills(allowedSkillsJson: string | null): string[] {
  if (allowedSkillsJson == null || allowedSkillsJson.trim() === '') return [];
  try {
    const arr = JSON.parse(allowedSkillsJson) as unknown;
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Cowork-style: only Read and Bash tools (no per-skill OpenAI tools). */
const READ_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read the contents of a file. Use for reading SKILL.md or other skill files. Pass absolute path to the file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file (must be under SKILLs root).' },
      },
      required: ['file_path'],
    },
  },
};

const BASH_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'Bash',
    description: 'Run a shell command. Use to run skill scripts (e.g. npx ts-node <skill_dir>/scripts/xxx.ts --key value). Commands run with cwd = SKILLs root and have SKILLS_ROOT, IDBOTS_METABOT_ID set.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run (cwd is SKILLs root).' },
        description: { type: 'string', description: 'Optional human-readable description of what the command does.' },
      },
      required: ['command'],
    },
  },
};

function executeRead(filePath: string, allowedRoots: string[]): string {
  if (allowedRoots.length === 0) {
    return 'Error: no SKILLs roots configured.';
  }
  try {
    const normalized = path.normalize(filePath);
    const firstRoot = path.resolve(allowedRoots[0]);
    const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(firstRoot, normalized);
    const realPath = fs.realpathSync(resolved);
    const underSomeRoot = allowedRoots.some((root) => {
      const r = path.resolve(root);
      return realPath === r || realPath.startsWith(r + path.sep);
    });
    if (!underSomeRoot) {
      console.error('[Orchestrator] [Read] Path escapes SKILLs roots:', filePath);
      return `Error: path must be under SKILLs root.`;
    }
    const content = fs.readFileSync(realPath, 'utf-8');
    if (content.length > READ_FILE_MAX_CHARS) {
      return content.slice(0, READ_FILE_MAX_CHARS) + '\n...[truncated to ' + READ_FILE_MAX_CHARS + ' chars]';
    }
    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Orchestrator] [Read] failed:', filePath, msg);
    return `Error reading file: ${msg}`;
  }
}

function runBashOnce(
  command: string,
  cwd: string,
  metabotId?: number
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SKILLS_ROOT: cwd,
      IDBOTS_SKILLS_ROOT: cwd,
      IDBOTS_RPC_URL: 'http://127.0.0.1:31200',
    };
    if (metabotId != null) {
      env.IDBOTS_METABOT_ID = String(metabotId);
    }
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    const child = spawn(shell, shellArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({
        code: -1,
        output:
          (stdout ? stdout + '\n' : '') +
          (stderr ? stderr + '\n' : '') +
          `[Command timed out after ${BASH_TIMEOUT_MS / 1000}s]`,
      });
    }, BASH_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const out = (stdout?.trim() ?? '') + (stderr?.trim() ? '\n' + stderr.trim() : '');
      resolve({ code: code ?? -1, output: code === 0 ? (out || 'Done.') : `Exit code ${code}\n${out}` });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, output: `Error: ${err.message}` });
    });
  });
}

async function executeBash(
  command: string,
  allowedRoots: string[],
  metabotId?: number
): Promise<string> {
  if (allowedRoots.length === 0) {
    return 'Error: no SKILLs roots configured.';
  }
  let lastOutput = '';
  for (const root of allowedRoots) {
    const cwd = path.resolve(root);
    if (!fs.existsSync(cwd)) continue;
    const result = await runBashOnce(command, cwd, metabotId);
    lastOutput = result.output;
    if (result.code === 0) {
      return result.output;
    }
  }
  return lastOutput || 'Error: command failed in all roots.';
}

/**
 * Run the reply pipeline: context -> prompt -> LLM (with optional tool loop) -> broadcast -> update state.
 * Task 12.4: When allowed_skills is set, inject tools and run multi-turn hook loop.
 * Must be wrapped in try/catch and finally(thinkingTasks.delete).
 */
async function runReplyPipeline(
  task: GroupChatTaskRow,
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn,
  options?: {
    getSkillsPromptForIds?: GetSkillsPromptForIdsFn;
    skillsRoot?: string;
    skillsRoots?: string[];
    chatWithToolsOverride?: ChatWithToolsFn;
    runSkillTurnViaCowork?: RunSkillTurnViaCoworkFn;
  }
): Promise<void> {
  const { getSkillsPromptForIds, skillsRoot, skillsRoots, chatWithToolsOverride, runSkillTurnViaCowork } = options ?? {};
  const allowedRoots = skillsRoots?.length ? skillsRoots : skillsRoot ? [skillsRoot] : [];
  const metabot = getMetabotById(task.metabot_id);
  if (!metabot) {
    console.error('[Orchestrator] MetaBot not found for task', task.id);
    return;
  }

  const limit = Math.max(1, task.context_message_count ?? 30);
  const recentRows = getRecentMessages(db, task.group_id, limit);
  const contextLines = recentRows.map((m) => {
    const sender = (m.sender_name ?? 'Unknown').trim() || 'Unknown';
    const content = (m.content ?? '').trim() || '(empty)';
    return `${sender}: ${content}`;
  });

  const latestMessageSenderGlobalmetaid =
    recentRows.length > 0
      ? (recentRows[recentRows.length - 1].sender_global_metaid ?? null)
      : null;

  const supervisorGlobalmetaid = task.supervisor_globalmetaid ?? task.supervisor_metaid ?? null;
  const isLatestFromBoss = !!(
    supervisorGlobalmetaid &&
    latestMessageSenderGlobalmetaid &&
    String(supervisorGlobalmetaid).trim() === String(latestMessageSenderGlobalmetaid).trim()
  );
  console.log('[Orchestrator] [DEBUG] Boss (supervisor_globalmetaid):', supervisorGlobalmetaid ?? '(none)');
  console.log('[Orchestrator] [DEBUG] Latest message sender globalmetaid:', latestMessageSenderGlobalmetaid ?? '(none)');
  console.log('[Orchestrator] [DEBUG] Is latest message from Boss?', isLatestFromBoss);

  let systemPrompt = buildSystemPrompt(
    metabot.name,
    metabot.role ?? '',
    metabot.soul ?? '',
    task.discussion_background,
    task.participation_goal,
    contextLines,
    supervisorGlobalmetaid,
    latestMessageSenderGlobalmetaid ?? null
  );

  const allowedSkillsRaw = task.allowed_skills ?? '';
  const allowedSkills = parseAllowedSkills(allowedSkillsRaw);
  const skillsPrompt =
    allowedSkills.length > 0 && getSkillsPromptForIds && allowedRoots.length > 0
      ? getSkillsPromptForIds(allowedSkills)
      : null;
  const useToolLoop = Boolean(skillsPrompt);

  if (useToolLoop) {
    systemPrompt += '\n\n' + skillsPrompt! + '\n\nAfter using Read/Bash to run a skill, reply with a concise summary to the group (do not paste full skill output).';
  }

  const userMessage = buildUserMessage();

  console.log('[Orchestrator] [DEBUG] System prompt (first 600 chars, log only; full length', systemPrompt.length, '):', systemPrompt.slice(0, 600));
  console.log('[Orchestrator] [DEBUG] allowed_skills raw:', allowedSkillsRaw);
  console.log('[Orchestrator] [DEBUG] allowed_skills parsed:', JSON.stringify(allowedSkills));
  console.log('[Orchestrator] [DEBUG] Use Read/Bash tool loop?', useToolLoop);

  let replyText: string;

  if (useToolLoop && allowedRoots.length > 0) {
    if (runSkillTurnViaCowork) {
      const hasSkillsBlock = systemPrompt.includes('<available_skills>');
      const skillsSnippet = systemPrompt.includes('<available_skills>')
        ? systemPrompt.slice(systemPrompt.indexOf('<available_skills>'), systemPrompt.indexOf('</available_skills>') + '</available_skills>'.length).slice(0, 600)
        : '(none)';
      console.log('[Orchestrator] [DEBUG] Using Cowork for skill turn (runSkillTurnViaCowork).');
      console.log('[Orchestrator] [DEBUG] systemPrompt length:', systemPrompt.length, 'has <available_skills>:', hasSkillsBlock, 'snippet:', skillsSnippet);
      // Use the last root (typically project/bundled SKILLs) so cwd contains the skill scripts; first root is often userData which may be empty in dev.
      const cwdForCowork = allowedRoots.length > 1 ? allowedRoots[allowedRoots.length - 1]! : allowedRoots[0]!;
      console.log('[Orchestrator] [DEBUG] Cowork cwd (chosen root):', cwdForCowork, 'all roots:', allowedRoots);
      try {
        if (isLatestFromBoss) {
          await broadcastGroupChat(task.metabot_id, task.group_id, metabot.name, '响应中…');
        }
        replyText = await runSkillTurnViaCowork({
          systemPrompt,
          userMessage,
          cwd: cwdForCowork,
        });
      } catch (err) {
        console.error('[Orchestrator] runSkillTurnViaCowork failed:', err instanceof Error ? err.message : err);
        return;
      }
    } else {
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];
      const tools: OpenAITool[] = [READ_TOOL, BASH_TOOL];
      let round = 0;
      let lastContent: string | undefined;
      let lastToolCalls: ToolCallResult[] | undefined;

      while (round < MAX_TOOL_CALLS) {
        round++;
        console.log('[Orchestrator] [DEBUG] Tool loop round', round, 'messages count:', chatMessages.length);
        const chatWithTools = chatWithToolsOverride ?? chatCompletionWithTools;
        let result: Awaited<ReturnType<typeof chatCompletionWithTools>>;
        try {
          result = await chatWithTools(chatMessages, {
            llmId: metabot.llm_id ?? undefined,
            tools,
          });
        } catch (err) {
          console.error('[Orchestrator] chatCompletionWithTools failed:', err instanceof Error ? err.message : err);
          return;
        }

        lastContent = result.content?.trim();
        lastToolCalls = result.tool_calls;

        if (result.tool_calls?.length) {
          console.log('[Orchestrator] [DEBUG] LLM returned tool_calls (count=', result.tool_calls.length, '):', result.tool_calls.map((tc) => tc.name).join(', '));
          for (const tc of result.tool_calls) {
            console.log('[Orchestrator] LLM tool_calls:', tc.name, 'arguments:', tc.arguments);
          }
        } else {
          console.log('[Orchestrator] [DEBUG] LLM returned content only (no tool_calls). Final reply length:', lastContent?.length ?? 0);
        }

        if (lastToolCalls?.length) {
          chatMessages.push({
            role: 'assistant',
            content: lastContent ?? undefined,
            tool_calls: lastToolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });
          for (const tc of lastToolCalls) {
            let observation: string;
            try {
              const args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
              if (tc.name === 'Read') {
                const filePath = typeof args.file_path === 'string' ? args.file_path : '';
                console.log('[Orchestrator] [HOOK] Executing Read:', filePath);
                observation = executeRead(filePath, allowedRoots);
              } else if (tc.name === 'Bash') {
                const command = typeof args.command === 'string' ? args.command : '';
                console.log('[Orchestrator] [HOOK] Executing Bash:', command.slice(0, 120));
                observation = await executeBash(command, allowedRoots, task.metabot_id);
              } else {
                observation = `Unknown tool: ${tc.name}`;
              }
            } catch (err) {
              observation = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
            console.log('[Orchestrator] [HOOK] Tool result for', tc.name, ':', observation.slice(0, 200));
            chatMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: observation,
            });
          }
        } else {
          break;
        }
      }

      replyText = (lastContent ?? '').trim();
      if (!replyText && lastToolCalls?.length) {
        console.warn('[Orchestrator] Max tool rounds reached or LLM did not return final content; using last content if any');
      }
    }
  } else {
    console.log('[Orchestrator] [DEBUG] No tool loop: one-shot reply.');
    try {
      replyText = await performChatCompletion(systemPrompt, userMessage, metabot.llm_id ?? undefined);
    } catch (err) {
      console.error('[Orchestrator] LLM call failed:', err instanceof Error ? err.message : err);
      return;
    }
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
/** Optional: skill-list prompt for allowed_skills, SKILLs root(s), and test override. */
export interface OrchestratorOptions {
  getSkillsPromptForIds?: GetSkillsPromptForIdsFn;
  skillsRoot?: string;
  /** Multiple roots (userData + bundled); preferred over skillsRoot for Read/Bash. */
  skillsRoots?: string[];
  chatWithToolsOverride?: ChatWithToolsFn;
  /** When set, skill turn runs via CoworkRunner (same Read/Bash as Cowork) instead of in-orchestrator loop. */
  runSkillTurnViaCowork?: RunSkillTurnViaCoworkFn;
}

async function tick(
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn,
  options?: OrchestratorOptions
): Promise<void> {
  tickCount += 1;
  const taskRows = db.exec(
    'SELECT * FROM group_chat_tasks WHERE is_active = 1'
  );
  const taskCount = taskRows[0]?.values?.length ?? 0;

  if (taskCount === 0) {
    if (tickCount % LOG_EVERY_N_TICKS === 1) {
      const totalResult = db.exec('SELECT COUNT(*) AS n FROM group_chat_tasks');
      const total = totalResult[0]?.values?.[0]?.[0] ?? 0;
      console.log(
        '[Orchestrator] tick: no active tasks (total rows in group_chat_tasks:',
        total,
        '; if you edited the DB file on disk, restart the app to load changes)'
      );
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
      `SELECT id, group_id, content, mention, sender_global_metaid, sender_metaid FROM group_chat_messages
       WHERE group_id = ? AND id > ? AND is_processed = 0
       ORDER BY id ASC`,
      [task.group_id, effectiveLastProcessed]
    );

    const newMsgCount = newMsgResult[0]?.values?.length ?? 0;
    if (tickCount % LOG_EVERY_N_TICKS === 1) {
      tickLog.push(`task${task.id}: last=${effectiveLastProcessed} new=${newMsgCount}`);
    }

    if (!newMsgResult[0]?.values?.length) {
      if (tickCount % LOG_EVERY_N_TICKS === 1) {
        const diag = db.exec(
          `SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS max_id,
           SUM(CASE WHEN id > ? AND is_processed = 0 THEN 1 ELSE 0 END) AS unprocessed_after_last
           FROM group_chat_messages WHERE group_id = ?`,
          [effectiveLastProcessed, task.group_id]
        );
        const total = diag[0]?.values?.[0]?.[0] ?? 0;
        const maxId = diag[0]?.values?.[0]?.[1] ?? 0;
        const unprocessedAfter = diag[0]?.values?.[0]?.[2] ?? 0;
        console.log(
          `[Orchestrator] [DEBUG] task ${task.id} group_id=${task.group_id.slice(0, 20)}…: no new messages to process. ` +
            `last_processed=${effectiveLastProcessed} total_msgs=${total} max_id=${maxId} unprocessed_after_last=${unprocessedAfter}`
        );
      }
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
      }, {} as Record<string, unknown>) as { id: number; content: string | null; mention: string | null; sender_global_metaid?: string | null; sender_metaid?: string | null };

      const msgId = msg.id as number;
      if (msgId > maxProcessedId) maxProcessedId = msgId;

      const senderGlobalMetaId = (msg.sender_global_metaid ?? '').trim() || null;
      const senderMetaId = (msg.sender_metaid ?? '').trim() || null;
      const isFromThisBot =
        (botGlobalMetaId && senderGlobalMetaId && senderGlobalMetaId === botGlobalMetaId) ||
        (botMetaId && senderMetaId && senderMetaId === botMetaId);
      if (isFromThisBot) continue;

      let shouldReply = false;
      let reason = '';

      const isMention =
        task.reply_on_mention === 1 &&
        (contentContainsBotName(msg.content ?? null, botName) ||
          mentionContainsMetaId(msg.mention ?? null, botGlobalMetaId, botMetaId ?? undefined));

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
          broadcastGroupChat,
          options
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
 * options.getSkillsPromptForIds and options.skillsRoot enable Cowork-style Read/Bash skill use for allowed_skills.
 */
export function startOrchestrator(
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn,
  options?: OrchestratorOptions
): void {
  stopOrchestrator();
  tickCount = 0;
  console.log('[Orchestrator] daemon started (tick every', TICK_INTERVAL_MS / 1000, 's)');
  tickIntervalId = setInterval(() => {
    tick(db, saveDb, getMetabotById, performChatCompletion, broadcastGroupChat, options).catch((err) => {
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

/** Export for test script: run a single tick with injected deps. Pass options.chatWithToolsOverride to mock tool-loop LLM. */
export async function runTickOnce(
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn,
  options?: OrchestratorOptions
): Promise<void> {
  await tick(db, saveDb, getMetabotById, performChatCompletion, broadcastGroupChat, options);
}
