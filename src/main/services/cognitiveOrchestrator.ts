/**
 * Cognitive Orchestrator daemon: goal-oriented multi-agent group chat orchestration.
 * Phase 1: Attention filter (mention + probability/cooldown).
 * Task 12.2: Context assembly, LLM reply, /protocols/simplegroupchat broadcast.
 * Task 12.4: Cowork-style skill list + Read/Bash only (no per-skill OpenAI tools).
 * Issue #40: every reply gets a durable delivery obligation (groupChatOutbox)
 * BEFORE the broadcast; a failed send is retried by the outbox drain and the
 * task cursor only advances once the obligation reaches a terminal state.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import { isSqliteWasmBoundsError } from '../sqliteRecovery';
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  chatCompletionWithTools,
  type ChatMessage,
  type OpenAITool,
  type ToolCallResult,
} from './cognitiveChatCompletion';
import {
  ensureGroupChatOutboxSchema,
  enqueueGroupChatSend,
  findGroupChatSendByTrigger,
  listPendingGroupChatSends,
  lowestPendingTriggerMsgId,
  markGroupChatSendFailed,
  markGroupChatSendSubmitted,
} from './groupChatOutbox';
import { toLlmEffortLevel } from '../libs/llmEffort';
import { copyRespondingPlaceholder } from '../libs/groupTaskCopy';
import { getMetaidRpcBase, getMetaidRpcToken } from './metaidRpcEndpoint';
import { getEnhancedEnv } from '../libs/coworkUtil';
import { buildMetabotPersonaPrompt } from '../libs/metabotPersonaPrompt';
import { isPathWithin } from '../libs/runtimePaths';
import {
  buildMinimalSelfCognitionBlocks,
  RECENT_SUMMARIES_PROMPT_DAYS,
} from '../libs/experiencePromptBlocks';
import type { MemoryUsageClass } from '../memory/memoryScope';

const TICK_INTERVAL_MS = 10_000;
const LOG_EVERY_N_TICKS = 6; // log summary every ~1 min when no trigger
/** Max tool-call rounds for Read/Bash loop (allow multiple Read + Bash steps). */
const MAX_TOOL_CALLS = 10;
const READ_FILE_MAX_CHARS = 80_000;
/**
 * fix-v2 (B3): skill scripts that talk to the chain are LONG operations —
 * group-task create does on-chain group creation + indexing waits + member
 * joins and routinely exceeds a minute (task #55: the 60s SIGTERM killed the
 * create call although the task itself was created fine). 180s covers the
 * slow GLM-era chain cadence without leaving a genuinely wedged script
 * running forever.
 */
const BASH_TIMEOUT_MS = 180_000;

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
  /** Provider key the brain model was picked from. */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain (off/low/high/max). */
  llm_effort?: string | null;
  /** Optional fallback brain; retried once when the primary LLM fails. */
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  globalmetaid: string | null;
  metaid?: string;
  /** Human owner GlobalMetaID (metabots.boss_global_metaid); privileged for Boss skill path when sender matches. */
  boss_global_metaid?: string | null;
  /** Skills allowed for ordinary chat skill turns. */
  allow_chat_skills?: string[];
  /** Optional persona facts rendered by the shared persona builder. */
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility field; use bio. */
  background?: string | null;
  mvc_address?: string | null;
}

type GetMetabotByIdFn = (id: number) => MetabotInfo | null;
type SaveDbFn = () => void;
/** (systemPrompt, userMessage, llmId?, options?) => reply text */
export type PerformChatCompletionFn = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    llmProvider?: string | null;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    effort?: 'off' | 'low' | 'high' | 'max' | null;
    fallbackEffort?: 'off' | 'low' | 'high' | 'max' | null;
    thinking?: 'enabled' | 'disabled';
  }
) => Promise<string>;
/**
 * Transport ACK for one group-chat broadcast. pinId is returned by
 * groupChatTransport.sendGroupChatMessage once the pin is signed and
 * broadcast (issue #40: previously this value was discarded and the
 * fire-and-forget path had no ACK at all).
 */
export interface GroupChatBroadcastAck {
  pinId?: string;
}
/** (metabotId, groupId, nickName, content) => ack; signs and broadcasts via create-pin */
export type BroadcastGroupChatFn = (
  metabotId: number,
  groupId: string,
  nickName: string,
  content: string
) => Promise<GroupChatBroadcastAck | void>;

/**
 * pinId from a broadcast ack; tolerates legacy in-tree callers/test doubles
 * that still return nothing. Returns null when no ACK pinId is available.
 */
function ackPinId(ack: unknown): string | null {
  if (ack && typeof ack === 'object' && typeof (ack as GroupChatBroadcastAck).pinId === 'string') {
    return (ack as GroupChatBroadcastAck).pinId ?? null;
  }
  return null;
}

/** Optional override for tool-loop LLM (e.g. test mock). Same signature as chatCompletionWithTools. */
export type ChatWithToolsFn = (
  messages: ChatMessage[],
  options: { llmId?: string | null; fallbackLlmId?: string | null; tools?: OpenAITool[] }
) => Promise<{ content?: string; tool_calls?: ToolCallResult[] }>;

/** Build skill-list prompt for given ids (from SkillManager.buildAutoRoutingPromptForSkillIds). */
export type ChatSkillsRoutingPromptInput = {
  metabotId?: number | null;
  widened?: boolean;
};

export type ChatSkillsRoutingPromptResult = {
  prompt: string | null;
  activeSkillIds: string[];
};

export type GetChatSkillsRoutingPromptFn = (
  input: ChatSkillsRoutingPromptInput
) => ChatSkillsRoutingPromptResult;

/** Run one skill turn via CoworkRunner (reuse Cowork Read/Bash logic). When provided and useToolLoop, used instead of in-orchestrator Read/Bash loop. */
export type RunSkillTurnViaCoworkFn = (params: {
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  metabotId?: number;
  groupId?: string | null;
  triggerReason?: string;
  supervisorGlobalmetaid?: string | null;
  latestMessageSenderGlobalmetaid?: string | null;
  activeSkillIds?: string[];
}) => Promise<string>;

/** Narrow memory read (owner scope, created status) for the direct-path minimal self-cognition pack. */
export type OrchestratorListUserMemoriesFn = (
  metabotId: number,
  input: { usageClass?: MemoryUsageClass; limit: number },
) => Array<{ text: string }>;

/** Recent dream summaries (newest first) for the direct-path minimal self-cognition pack. */
export type OrchestratorListDailySummariesFn = (
  metabotId: number,
  limit: number,
) => Array<{ summaryDate: string; summaryText: string }>;

let tickIntervalId: ReturnType<typeof setInterval> | null = null;
/** sql.js Database must not be used concurrently; skip overlapping orchestrator ticks. */
let orchestratorPollTickRunning = false;
let orchestratorGeneration = 0;
let orchestratorActiveTickPromise: Promise<void> | null = null;
/** Task IDs currently in LLM/broadcast pipeline; skip them in tick to avoid duplicate triggers */
const thinkingTasks = new Set<number>();

/**
 * Task keys of group-chat auto-reply pipelines currently in flight.
 *
 * Consumed by the sleep guard (src/main/sleepGuardWorkSources.ts): the skill
 * branch of a reply runs inside a cowork session, but the plain branch is a
 * session-less reasoning completion, so the pipeline itself must count as work
 * for as long as it runs. Always empty while the orchestrator is stopped.
 */
export function getActiveGroupChatReplyTaskIds(): string[] {
  return Array.from(thinkingTasks, (taskId) => String(taskId));
}

function parseMentionArray(mentionJson: string | null): string[] {
  if (mentionJson == null || mentionJson === '') return [];
  try {
    const arr = JSON.parse(mentionJson);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function rethrowSqliteWasmBoundsError(error: unknown): void {
  if (isSqliteWasmBoundsError(error)) {
    throw error;
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
 * Group-chat channel framing for the STABLE system prompt. Persona facts and
 * chat history are deliberately absent: the persona comes from the shared
 * metabotPersonaPrompt builder (one identity across channels), and recent
 * chat history rides the user message (see buildChatHistoryBlock) so the
 * system prompt stays byte-stable across turns — it leads the provider's
 * cacheable prefix, and any per-turn change there (history, timestamps) is a
 * full-prefix cache miss.
 */
export function buildGroupChatChannelPrompt(
  discussionBackground: string | null,
  participationGoal: string | null,
  supervisorMetaid: string | null,
  ownerGlobalMetaid: string | null
): string {
  const background = discussionBackground?.trim() || 'Free participation, no specific background.';
  const goal = participationGoal?.trim() || 'Participate in the group chat freely; reply naturally from context or invoke skills.';

  const sup = (supervisorMetaid ?? '').trim();
  const own = (ownerGlobalMetaid ?? '').trim();
  const ownerDistinct = own !== '' && own !== sup;

  const authorityLines: string[] = [];
  if (sup) {
    authorityLines.push(
      `- The user with GlobalMetaID ${sup} is your Boss (highest authority in this group). When the latest message is from your Boss, execute their request with top priority and prefer calling Tools to complete the task.`,
    );
  }
  if (ownerDistinct) {
    authorityLines.push(
      `- The user with GlobalMetaID ${own} is your configured owner (a human). When the latest message is from your owner, execute their request with the same top priority as your Boss.`,
    );
  }

  return [
    '## Group Chat Channel',
    'You are a MetaBot participating in a group chat on MetaWeb.',
    `- Background: ${background}`,
    `- Goal: ${goal}`,
    ...(authorityLines.length > 0 ? ['', '### Authority', ...authorityLines] : []),
    '',
    '### Reply Protocol',
    '1. Stay in character per your persona block; answer questions directly and keep casual chat in persona.',
    '2. Reply in the language of the recent chat messages whenever it is clear.',
    '3. Your reply is posted to the group verbatim: output ONLY the reply text — no prefixes, explanations, or action descriptions.',
  ].join('\n');
}

/**
 * Recent chat history as a user-message block (the volatile turn tail). Kept
 * out of the system prompt on purpose: history changes every turn and would
 * bust the provider's prefix cache.
 */
export function buildChatHistoryBlock(contextLines: string[]): string {
  if (contextLines.length === 0) {
    return '[Chat Context (Recent Messages)]\n(No recent messages)';
  }
  return ['[Chat Context (Recent Messages)]', ...contextLines].join('\n');
}

/** Trigger reason for this reply (used to tailor user message). */
export type TriggerReason = 'Mention' | 'Boss' | 'Probability';

/** Assemble the trigger instruction that follows the chat history block. */
function buildUserMessage(triggerReason: TriggerReason): string {
  switch (triggerReason) {
    case 'Mention':
      return 'You were @-mentioned in the group chat. Reply directly based on the chat context above. Output only your reply text, no explanations.';
    case 'Boss':
      return 'Your Boss just sent a message. Treat it with top priority: understand and execute the request; if a skill applies, follow its SKILL.md and reply to the group with a concise summary. Output only the reply or execution result, no explanations.';
    case 'Probability':
      return 'Based on the chat context above, participate naturally in character with one reply. Output only your reply text, no explanations.';
    default:
      return 'Based on the chat context above, reply with one message in character. Output only your reply text, no explanations.';
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
    description: 'Run a shell command. Use to run skill scripts (e.g. node <skill_dir>/scripts/xxx.js --key value). Commands run with cwd = SKILLs root and have SKILLS_ROOT, IDBOTS_METABOT_ID set.',
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
      return isPathWithin(r, realPath);
    });
    if (!underSomeRoot) {
      console.error('[Orchestrator] [Read] Path escapes SKILLs roots:', filePath);
      return `Error: path must be under SKILLs root.`;
    }
    const content = stripLoneSurrogates(fs.readFileSync(realPath, 'utf-8'));
    if (content.length > READ_FILE_MAX_CHARS) {
      return truncateUtf16Units(content, READ_FILE_MAX_CHARS) + '\n...[truncated to ' + READ_FILE_MAX_CHARS + ' chars]';
    }
    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Orchestrator] [Read] failed:', filePath, msg);
    return `Error reading file: ${msg}`;
  }
}

function stripWrappingQuotes(value: string): { value: string; quote: '"' | '\'' | null } {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === '\'') && first === last) {
      return { value: trimmed.slice(1, -1), quote: first };
    }
  }
  return { value: trimmed, quote: null };
}

function quoteCommandToken(raw: string, preferredQuote: '"' | '\'' | null): string {
  if (preferredQuote != null) {
    if (preferredQuote === '"') {
      return `"${raw.replace(/"/g, '\\"')}"`;
    }
    // Use double-quote fallback to avoid brittle single-quote escaping rules across shells.
    return `"${raw.replace(/"/g, '\\"')}"`;
  }
  if (/\s/.test(raw)) {
    return `"${raw.replace(/"/g, '\\"')}"`;
  }
  return raw;
}

function resolveTsScriptFallback(scriptToken: string, cwd: string): string | null {
  const parsedToken = stripWrappingQuotes(scriptToken);
  const scriptPath = parsedToken.value;
  if (!scriptPath.toLowerCase().endsWith('.ts')) {
    return null;
  }

  const absoluteScript = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(cwd, scriptPath);
  const scriptDir = path.dirname(absoluteScript);
  const scriptBase = path.basename(absoluteScript, '.ts');

  const candidates = [
    path.join(scriptDir, `${scriptBase}.js`),
    path.join(scriptDir, 'dist', `${scriptBase}.js`),
  ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    return null;
  }

  const renderedPath = path.isAbsolute(scriptPath)
    ? match
    : path.relative(cwd, match) || '.';
  return quoteCommandToken(renderedPath, parsedToken.quote);
}

function normalizeTsNodeCommand(command: string, cwd: string): string {
  const rules: Array<{
    regex: RegExp;
    prefix: string;
  }> = [
    {
      regex: /\bnpx\s+ts-node\s+((?:"[^"]+"|'[^']+'|\S+\.ts))/i,
      prefix: 'node ',
    },
    {
      regex: /\bts-node\s+((?:"[^"]+"|'[^']+'|\S+\.ts))/i,
      prefix: 'node ',
    },
    {
      regex: /\bnode\s+((?:"[^"]+"|'[^']+'|\S+\.ts))/i,
      prefix: 'node ',
    },
  ];

  for (const rule of rules) {
    const match = command.match(rule.regex);
    if (!match || !match[1]) continue;
    const scriptReplacement = resolveTsScriptFallback(match[1], cwd);
    if (!scriptReplacement) continue;
    return command.replace(rule.regex, `${rule.prefix}${scriptReplacement}`);
  }

  return command;
}

function resolveShellCommand(command: string, cwd: string): { command: string; cwd: string } {
  const cdPrefixMatch = command.match(/^\s*cd\s+((?:"[^"]+"|'[^']+'|[^\s&]+))\s*&&\s*([\s\S]+)$/i);
  if (!cdPrefixMatch) {
    return {
      command: normalizeTsNodeCommand(command, cwd),
      cwd,
    };
  }

  const parsedCd = stripWrappingQuotes(cdPrefixMatch[1]);
  const nextCommand = cdPrefixMatch[2];
  const nextCwd = path.isAbsolute(parsedCd.value)
    ? path.resolve(parsedCd.value)
    : path.resolve(cwd, parsedCd.value);

  if (!fs.existsSync(nextCwd)) {
    return {
      command: normalizeTsNodeCommand(command, cwd),
      cwd,
    };
  }

  return {
    command: normalizeTsNodeCommand(nextCommand, nextCwd),
    cwd: nextCwd,
  };
}

function runBashOnce(
  command: string,
  cwd: string,
  metabotId?: number
): Promise<{ code: number; output: string }> {
  return (async (): Promise<{ code: number; output: string }> => {
    const resolved = resolveShellCommand(command, cwd);
    const baseEnv = await getEnhancedEnv('local');
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      SKILLS_ROOT: cwd,
      IDBOTS_SKILLS_ROOT: cwd,
      IDBOTS_RPC_URL: getMetaidRpcBase(),
      IDBOTS_RPC_TOKEN: getMetaidRpcToken(),
    };
    if (metabotId != null) {
      env.IDBOTS_METABOT_ID = String(metabotId);
    }

    return await new Promise<{ code: number; output: string }>((resolvePromise) => {
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
      const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', resolved.command] : ['-c', resolved.command];
      const child = spawn(shell, shellArgs, {
        cwd: resolved.cwd,
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
        resolvePromise({
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
        resolvePromise({ code: code ?? -1, output: code === 0 ? (out || 'Done.') : `Exit code ${code}\n${out}` });
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        resolvePromise({ code: -1, output: `Error: ${err.message}` });
      });
    });
  })().catch((error) => {
    rethrowSqliteWasmBoundsError(error);
    const message = error instanceof Error ? error.message : String(error);
    return { code: -1, output: `Error: ${message}` };
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
 * Run the reply pipeline: context -> prompt -> LLM (with optional tool loop) ->
 * durable outbox obligation -> broadcast -> update state.
 * Boss turns can use all enabled skills; other chat turns use the MetaBot chat allowlist.
 * Must be wrapped in try/catch and finally(thinkingTasks.delete).
 */
async function runReplyPipeline(
  task: GroupChatTaskRow,
  /** group_chat_messages.id of the message that triggered this reply (outbox key). */
  triggerMsgId: number,
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn,
  options?: OrchestratorOptions,
  triggerReason: TriggerReason = 'Probability'
): Promise<void> {
  const {
    getChatSkillsRoutingPrompt,
    skillsRoot,
    skillsRoots,
    chatWithToolsOverride,
    runSkillTurnViaCowork,
    listUserMemories,
    listDailySummaries,
    getEffectiveMemoryPolicy,
  } = options ?? {};
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
  const ownerGlobalMetaid = (metabot.boss_global_metaid ?? '').trim() || null;
  const supTrim = (supervisorGlobalmetaid ?? '').trim();
  const latestTrim = (latestMessageSenderGlobalmetaid ?? '').trim();
  const isLatestFromPrivileged = !!(
    latestTrim &&
    ((supTrim !== '' && latestTrim === supTrim) ||
      (ownerGlobalMetaid != null && ownerGlobalMetaid !== '' && latestTrim === ownerGlobalMetaid))
  );

  // Stable prompt spine: shared persona + group-chat channel framing. Chat
  // history rides the user message (below), never the system prompt.
  const personaPrompt = buildMetabotPersonaPrompt(metabot);
  const channelPrompt = buildGroupChatChannelPrompt(
    task.discussion_background,
    task.participation_goal,
    supervisorGlobalmetaid,
    ownerGlobalMetaid
  );

  const chatSkillRouting =
    getChatSkillsRoutingPrompt && allowedRoots.length > 0
      ? getChatSkillsRoutingPrompt({
          metabotId: metabot.id,
          // Baseline: bundled + assigned skills. Boss-triggered turns widen
          // to the bot's FULL visible set, additionally unlocking global
          // external skills.
          widened: triggerReason === 'Boss',
        })
      : null;
  // The legacy task.allowed_skills fallback is gone: under the per-bot
  // assignment model the bot's assignment rows are the only routing source —
  // resolving legacy ids against the full registry would leak every enabled
  // skill into a Boss turn (review B-followup).
  const skillsPrompt = chatSkillRouting?.prompt ?? null;
  const activeSkillIds = chatSkillRouting?.activeSkillIds ?? [];
  const useToolLoop = Boolean(skillsPrompt);

  const skillsSection = useToolLoop
    ? `${skillsPrompt}\n\nAfter using Read/Bash to run a skill, reply with a concise summary to the group (do not paste full skill output).`
    : '';

  // Cowork skill turns inject the shared persona themselves (the session
  // carries metabotId and coworkRunner renders the same persona block), so
  // the cowork prompt carries only channel framing + skills — a second
  // persona copy here would double the identity and invite layer conflicts.
  const coworkSystemPrompt = [channelPrompt, skillsSection]
    .filter((section) => section.trim())
    .join('\n\n');

  // Minimal self-cognition pack (dream-written self-identity + recent dream
  // summaries) for the DIRECT paths: without it the direct system prompt
  // carries persona facts but none of the bot's dream-distilled "who am I",
  // so the same bot answered differently here than in cowork turns. The
  // cowork skill path is excluded — coworkRunner injects the full experience
  // block into the turn tail, and a copy here would double it. Gated on the
  // bot's memory policy (parity with the group-task/private-chat paths).
  const buildSelfCognitionSection = (): string => {
    if (!listUserMemories && !listDailySummaries) return '';
    if (getEffectiveMemoryPolicy?.(metabot.id)?.memoryEnabled === false) return '';
    try {
      return buildMinimalSelfCognitionBlocks({
        identityText: listUserMemories?.(metabot.id, { usageClass: 'self_identity', limit: 1 })?.[0]?.text ?? null,
        summaries: listDailySummaries?.(metabot.id, RECENT_SUMMARIES_PROMPT_DAYS) ?? [],
      });
    } catch {
      return '';
    }
  };
  const selfCognitionSection = buildSelfCognitionSection();

  // Direct LLM paths (in-orchestrator tool loop, plain completion) have no
  // coworkRunner to inject the persona, so it leads the system prompt, with
  // the self-cognition pack right behind it (identity cluster before the
  // channel framing).
  const directSystemPrompt = [personaPrompt, selfCognitionSection, channelPrompt, skillsSection]
    .filter((section) => section.trim())
    .join('\n\n');

  const userMessage = [buildChatHistoryBlock(contextLines), buildUserMessage(triggerReason)]
    .filter((part) => part.trim())
    .join('\n\n');

  let replyText: string;

  if (useToolLoop && allowedRoots.length > 0) {
    if (runSkillTurnViaCowork) {
      // Use the last root (typically project/bundled SKILLs) so cwd contains the skill scripts; first root is often userData which may be empty in dev.
      // NOTE: intentionally NOT routed through the per-bot dated workspace
      // (libs/botWorkspace) — this cwd exists so the agent can execute skill
      // scripts in place. Artifacts produced here land in the SKILLs tree;
      // revisit when skill execution is decoupled from the workspace.
      const cwdForCowork = allowedRoots.length > 1 ? allowedRoots[allowedRoots.length - 1]! : allowedRoots[0]!;
      try {
        if (isLatestFromPrivileged) {
          await broadcastGroupChat(task.metabot_id, task.group_id, metabot.name, copyRespondingPlaceholder());
        }
        console.log('[Orchestrator] Using Cowork for skill turn');
        replyText = await runSkillTurnViaCowork({
          systemPrompt: coworkSystemPrompt,
          userMessage,
          cwd: cwdForCowork,
          metabotId: task.metabot_id,
          groupId: task.group_id,
          triggerReason,
          supervisorGlobalmetaid,
          latestMessageSenderGlobalmetaid,
          activeSkillIds,
        });
      } catch (err) {
        rethrowSqliteWasmBoundsError(err);
        console.error('[Orchestrator] runSkillTurnViaCowork failed:', err instanceof Error ? err.message : err);
        return;
      }
    } else {
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: directSystemPrompt },
        { role: 'user', content: userMessage },
      ];
      const tools: OpenAITool[] = [READ_TOOL, BASH_TOOL];
      let round = 0;
      let lastContent: string | undefined;
      let lastToolCalls: ToolCallResult[] | undefined;

      while (round < MAX_TOOL_CALLS) {
        round++;
        const chatWithTools = chatWithToolsOverride ?? chatCompletionWithTools;
        let result: Awaited<ReturnType<typeof chatCompletionWithTools>>;
        try {
          result = await chatWithTools(chatMessages, {
            llmId: metabot.llm_id ?? undefined,
            llmProvider: metabot.llm_provider ?? undefined,
            fallbackLlmId: metabot.fallback_llm_id ?? undefined,
            fallbackLlmProvider: metabot.fallback_llm_provider ?? undefined,
            effort: toLlmEffortLevel(metabot.llm_effort) ?? undefined,
            fallbackEffort: toLlmEffortLevel(metabot.fallback_llm_effort) ?? undefined,
            tools,
            // Default to thinking-on for DeepSeek reasoning turns; non-DeepSeek
            // models ignore this (resolveThinkingForModel drops it).
            thinking: 'enabled',
          });
        } catch (err) {
          rethrowSqliteWasmBoundsError(err);
          console.error('[Orchestrator] chatCompletionWithTools failed:', err instanceof Error ? err.message : err);
          return;
        }

        lastContent = result.content?.trim();
        lastToolCalls = result.tool_calls;

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
                observation = executeRead(filePath, allowedRoots);
              } else if (tc.name === 'Bash') {
                const command = typeof args.command === 'string' ? args.command : '';
                observation = await executeBash(command, allowedRoots, task.metabot_id);
              } else {
                observation = `Unknown tool: ${tc.name}`;
              }
            } catch (err) {
              rethrowSqliteWasmBoundsError(err);
              observation = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
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
    try {
      replyText = await performChatCompletion(directSystemPrompt, userMessage, metabot.llm_id ?? undefined, {
        llmProvider: metabot.llm_provider ?? undefined,
        fallbackLlmId: metabot.fallback_llm_id ?? undefined,
        fallbackLlmProvider: metabot.fallback_llm_provider ?? undefined,
        effort: toLlmEffortLevel(metabot.llm_effort) ?? undefined,
        fallbackEffort: toLlmEffortLevel(metabot.fallback_llm_effort) ?? undefined,
        thinking: 'enabled',
      });
    } catch (err) {
      rethrowSqliteWasmBoundsError(err);
      console.error('[Orchestrator] LLM call failed:', err instanceof Error ? err.message : err);
      return;
    }
  }

  const trimmed = (replyText ?? '').trim();
  if (!trimmed) {
    console.warn('[Orchestrator] LLM returned empty reply; skip broadcast');
    return;
  }

  // Issue #40: persist the delivery obligation BEFORE the first send. A failed
  // broadcast must leave a durable retry record, not just a log line.
  // (group_id, metabot_id, trigger_msg_id) is UNIQUE: THIS bot can never
  // enqueue a second obligation for the same triggering message, while every
  // OTHER bot of the group still owes its own reply for that message (rework
  // N1: the old group-level key swallowed the second bot's reply).
  const outboxId = enqueueGroupChatSend(db, {
    metabotId: task.metabot_id,
    groupId: task.group_id,
    triggerMsgId,
    nickName: metabot.name,
    content: trimmed,
  });
  saveDb();

  try {
    const ack = await broadcastGroupChat(task.metabot_id, task.group_id, metabot.name, trimmed);
    // ACK: the transport returns the pinId; record it on the obligation so the
    // delivery is auditable (a future CONFIRMED phase can read it back).
    markGroupChatSendSubmitted(db, outboxId, ackPinId(ack));
    saveDb();
  } catch (err) {
    rethrowSqliteWasmBoundsError(err);
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Orchestrator] Broadcast failed:', message);
    // Durable retry record: the obligation stays PENDING (or becomes ABANDONED
    // after GROUP_CHAT_OUTBOX_MAX_ATTEMPTS); tick()'s drain re-broadcasts the
    // SAME text without re-running the LLM.
    const outcome = markGroupChatSendFailed(db, outboxId, message);
    saveDb();
    console.error(
      `[Orchestrator] Reply for message ${triggerMsgId} kept in outbox (state=${outcome.state}, attempts=${outcome.attempts})`
    );
    return;
  }

  const nowIso = new Date().toISOString();
  db.run('UPDATE group_chat_tasks SET last_replied_at = ? WHERE id = ?', [nowIso, task.id]);
  saveDb();
}

/**
 * Retry PENDING group-chat sends whose backoff elapsed (issue #40). Runs at the
 * start of each task's tick, before new messages are read, so a reply whose
 * broadcast failed is re-sent from the outbox (same stored text) instead of
 * re-running the LLM. Returns the lowest trigger message id still pending AFTER
 * the drain for THIS task's bot — the per-task cursor floor that keeps the
 * failed reply's trigger message "unconsumed" until its obligation is terminal.
 * (The retry scan stays group-wide: every row is self-contained — it carries its
 * own metabot_id, nickname and text — so re-sending another bot's row only
 * advances that row's own obligation and never writes into this bot's rows; the
 * returned floor is still computed per (group, bot) for THIS task.)
 */
async function drainPendingGroupChatSends(
  db: Database,
  saveDb: SaveDbFn,
  broadcastGroupChat: BroadcastGroupChatFn,
  task: GroupChatTaskRow
): Promise<number | null> {
  ensureGroupChatOutboxSchema(db);
  const pending = listPendingGroupChatSends(db, task.group_id);
  if (pending.length === 0) return null;

  const now = Date.now();
  for (const row of pending) {
    if (Number(row.next_attempt_at) > now) continue;
    try {
      const ack = await broadcastGroupChat(row.metabot_id, row.group_id, row.nick_name ?? '', row.content);
      markGroupChatSendSubmitted(db, row.id, ackPinId(ack));
      saveDb();
      console.log(
        `[Orchestrator] Outbox retry delivered reply for message ${row.trigger_msg_id} (pin=${ackPinId(ack) ?? 'n/a'})`
      );
    } catch (err) {
      rethrowSqliteWasmBoundsError(err);
      const message = err instanceof Error ? err.message : String(err);
      const outcome = markGroupChatSendFailed(db, row.id, message);
      saveDb();
      console.error(
        `[Orchestrator] Outbox retry failed for message ${row.trigger_msg_id} (state=${outcome.state}, attempts=${outcome.attempts}): ${message}`
      );
    }
  }

  return lowestPendingTriggerMsgId(listPendingGroupChatSends(db, task.group_id, task.metabot_id));
}

/**
 * Run one orchestrator cycle: fetch active tasks, get new messages per task,
 * apply attention filter; on trigger, enqueue async pipeline and update last_processed_msg_id.
 */
/** Optional: skill-list prompt and SKILLs root(s). */
export interface OrchestratorOptions {
  getChatSkillsRoutingPrompt?: GetChatSkillsRoutingPromptFn;
  skillsRoot?: string;
  /** Multiple roots (userData + bundled); preferred over skillsRoot for Read/Bash. */
  skillsRoots?: string[];
  chatWithToolsOverride?: ChatWithToolsFn;
  /** When set, skill turn runs via CoworkRunner (same Read/Bash as Cowork) instead of in-orchestrator loop. */
  runSkillTurnViaCowork?: RunSkillTurnViaCoworkFn;
  /**
   * Memory/dream reads for the minimal self-cognition pack injected into the
   * DIRECT reply paths (in-orchestrator tool loop and plain completion). The
   * cowork skill path is excluded on purpose: coworkRunner already injects the
   * full experience block into the turn tail. Unwired = no pack injected.
   */
  listUserMemories?: OrchestratorListUserMemoriesFn;
  listDailySummaries?: OrchestratorListDailySummariesFn;
  /**
   * Per-bot memory policy (parity with the group-task/private-chat paths):
   * memoryEnabled=false gates the self-cognition pack off. Unwired = enabled.
   */
  getEffectiveMemoryPolicy?: (metabotId: number) => { memoryEnabled: boolean } | null | undefined;
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
    }

    // Issue #40: retry due PENDING sends for this group BEFORE reading new
    // messages, then keep the remaining pending floor — a failed reply's
    // trigger message must stay "unconsumed" until its obligation is terminal.
    const pendingFloor = await drainPendingGroupChatSends(db, saveDb, broadcastGroupChat, task);

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

    const supervisorGlobalmetaid = (task.supervisor_globalmetaid ?? task.supervisor_metaid ?? '').trim() || null;
    const ownerGlobalMetaid = (metabot?.boss_global_metaid ?? '').trim() || null;
    const isFromSupervisor = (senderGlobalMetaId: string | null, senderMetaId: string | null) =>
      !!supervisorGlobalmetaid &&
      ((senderGlobalMetaId && senderGlobalMetaId === supervisorGlobalmetaid) ||
        (senderMetaId && senderMetaId === supervisorGlobalmetaid));
    const isFromMetabotOwner = (senderGlobalMetaId: string | null) =>
      !!ownerGlobalMetaid && !!senderGlobalMetaId && senderGlobalMetaId === ownerGlobalMetaid;
    const isPrivilegedBoss = (senderGlobalMetaId: string | null, senderMetaId: string | null) =>
      isFromSupervisor(senderGlobalMetaId, senderMetaId) || isFromMetabotOwner(senderGlobalMetaId);

    for (let msgIndex = 0; msgIndex < msgRows.length; msgIndex++) {
      const msgRow = msgRows[msgIndex];
      const isLastNewMessage = msgIndex === msgRows.length - 1;
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
      let reason: 'Mention' | 'Boss' | 'Probability' = 'Probability';

      const isMention =
        task.reply_on_mention === 1 &&
        (contentContainsBotName(msg.content ?? null, botName) ||
          mentionContainsMetaId(msg.mention ?? null, botGlobalMetaId, botMetaId ?? undefined));

      if (isMention) {
        shouldReply = true;
        reason = isPrivilegedBoss(senderGlobalMetaId, senderMetaId) ? 'Boss' : 'Mention';
      } else if (isLastNewMessage && (task.random_reply_probability ?? 0) > 0 && now - lastRepliedAtMs > cooldownMs) {
        if (Math.random() < (task.random_reply_probability ?? 0)) {
          shouldReply = true;
          reason = isPrivilegedBoss(senderGlobalMetaId, senderMetaId) ? 'Boss' : 'Probability';
        }
      }

      if (shouldReply) {
        // Issue #40: never re-run the LLM for a message whose reply is already
        // a durable obligation (pending retry, or already submitted/abandoned).
        // Scoped to THIS bot (rework N1): another bot's obligation on the same
        // trigger message must not block this bot's own reply. The cursor
        // floor below keeps the message unconsumed while the obligation is
        // still pending.
        if (findGroupChatSendByTrigger(db, task.group_id, task.metabot_id, msgId)) {
          break;
        }
        if (pendingFloor != null && msgId > pendingFloor) {
          // An older reply is still awaiting (re)delivery. Keep reply ordering:
          // defer this message instead of replying out of order.
          break;
        }
        thinkingTasks.add(task.id);
        try {
          await runReplyPipeline(
            task,
            msgId,
            db,
            saveDb,
            getMetabotById,
            performChatCompletion,
            broadcastGroupChat,
            options,
            reason,
          );
        } finally {
          thinkingTasks.delete(task.id);
        }
        break;
      }
    }

    // Issue #40: the cursor only advances past messages whose reply reached a
    // terminal delivery outcome. A still-PENDING obligation for THIS bot pins
    // the cursor just below its trigger message, so the outbox drain retries
    // the SAME reply (no LLM re-run) before later messages move on. Other bots'
    // obligations in the same group never pin this task's cursor.
    let nextCursor = maxProcessedId;
    const pendingFloorAfter = lowestPendingTriggerMsgId(
      listPendingGroupChatSends(db, task.group_id, task.metabot_id)
    );
    if (pendingFloorAfter != null) {
      const cap = Math.max(pendingFloorAfter - 1, effectiveLastProcessed);
      if (cap < nextCursor) nextCursor = cap;
    }
    db.run(
      'UPDATE group_chat_tasks SET last_processed_msg_id = ? WHERE id = ?',
      [nextCursor, task.id]
    );
  }

  saveDb();
}

/**
 * Start the Cognitive Orchestrator daemon. Runs tick every 10 seconds.
 * performChatCompletion and broadcastGroupChat are injected for LLM and chain send.
 * options.getChatSkillsRoutingPrompt and options.skillsRoots enable Cowork-style skill routing/Read-Bash.
 */
export function startOrchestrator(
  db: Database,
  saveDb: SaveDbFn,
  getMetabotById: GetMetabotByIdFn,
  performChatCompletion: PerformChatCompletionFn,
  broadcastGroupChat: BroadcastGroupChatFn,
  options?: OrchestratorOptions,
  onWasmBoundsError?: () => void,
): void {
  void stopOrchestrator();
  const activeGeneration = ++orchestratorGeneration;
  tickCount = 0;
  tickIntervalId = setInterval(() => {
    if (activeGeneration !== orchestratorGeneration) return;
    if (orchestratorPollTickRunning) return;
    orchestratorPollTickRunning = true;
    const activeTick = tick(db, saveDb, getMetabotById, performChatCompletion, broadcastGroupChat, options)
      .catch((err) => {
        console.error('[Orchestrator] tick error:', err);
        if (isSqliteWasmBoundsError(err)) {
          void stopOrchestrator();
          onWasmBoundsError?.();
        }
      })
      .finally(() => {
        if (activeGeneration === orchestratorGeneration) {
          orchestratorPollTickRunning = false;
        }
        if (orchestratorActiveTickPromise === activeTick) {
          orchestratorActiveTickPromise = null;
        }
      });
    orchestratorActiveTickPromise = activeTick;
    void activeTick;
  }, TICK_INTERVAL_MS);
}

/**
 * Stop the daemon and clear the interval.
 */
export async function stopOrchestrator(options?: { waitForTick?: boolean }): Promise<void> {
  orchestratorGeneration += 1;
  if (tickIntervalId != null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
  orchestratorPollTickRunning = false;
  thinkingTasks.clear();
  if (options?.waitForTick && orchestratorActiveTickPromise) {
    await orchestratorActiveTickPromise.catch(() => undefined);
  }
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
