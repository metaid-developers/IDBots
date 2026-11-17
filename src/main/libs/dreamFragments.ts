import type {
  DreamActivityMessage,
  DreamChainReadActivity,
  DreamChainWriteActivity,
  DreamDayActivity,
  DreamGroupChatActivity,
  DreamGroupTaskEvaluation,
  DreamSessionActivity,
  DreamStudioDecisionActivity,
  DreamStudioDelegationActivity,
  DreamTaskRunActivity,
} from '../dreamStore';
import { estimateCoworkTextTokens } from './coworkContextBudget';

/** A resumable, chronologically ordered slice of one day's activity. */
export interface DreamActivityChunk {
  fragmentKey: string;
  sessionId: string;
  title: string;
  sessionType: string;
  peerName: string | null;
  isOrder: boolean;
  isStudioOwner?: boolean;
  autoOrigin?: string | null;
  priorContextMessages?: DreamActivityMessage[];
  chunkIndex: number;
  messages: DreamActivityMessage[];
  taskRuns: DreamTaskRunActivity[];
  orderCount: number;
  groupTasks: DreamGroupTaskEvaluation[];
  sourceMessageCount: number;
  sourceCharCount: number;
  estimatedInputTokens: number;
}

export interface DreamFragmentSummary {
  fragmentKey: string;
  sessionId: string;
  title: string;
  chunkIndex: number;
  output: unknown;
}

const MESSAGE_FRAME_TOKENS = 8;
const SESSION_FRAME_TOKENS = 32;

export function estimateDreamMessageTokens(message: DreamActivityMessage): number {
  return estimateCoworkTextTokens(message.content) + MESSAGE_FRAME_TOKENS;
}

function groupChatsToSessions(chats: DreamGroupChatActivity[]): DreamSessionActivity[] {
  return chats
    .filter((chat) => chat.messages.length > 0)
    .map((chat) => ({
      sessionId: `group-chat:${chat.taskId}`,
      title: `链上群聊:${chat.title}`,
      sessionType: 'group_chat',
      peerName: null,
      isOrder: false,
      messages: chat.messages.map((message) => ({
        type: 'user' as const,
        content: `${message.senderName}: ${message.content}`,
        createdAt: message.occurredAt,
      })),
    }));
}

export function estimateDreamActivityTokens(activity: DreamDayActivity): number {
  let tokens = 32 + estimateCoworkTextTokens(
    activity.taskRuns.map((run) => `${run.taskName} ${run.status}`).join(' ')
  );
  tokens += estimateCoworkTextTokens(
    (activity.groupTasks ?? [])
      .map((task) => `${task.title} ${task.goal} ${task.rating ?? ''} ${task.ratingComment ?? ''}`)
      .join(' ')
  );
  for (const session of [...activity.sessions, ...groupChatsToSessions(activity.groupChats ?? [])]) {
    tokens += SESSION_FRAME_TOKENS + estimateCoworkTextTokens(`${session.title} ${session.peerName ?? ''}`);
    for (const prior of session.priorContextMessages ?? []) {
      tokens += estimateDreamMessageTokens(prior);
    }
    for (const message of session.messages) {
      tokens += estimateDreamMessageTokens(message);
    }
  }
  tokens += estimateCoworkTextTokens(
    (activity.studioDelegations ?? [])
      .map((item) => `${item.ownerIntent} ${item.status} ${item.workerNames.join(' ')}`)
      .join(' '),
  );
  tokens += estimateCoworkTextTokens(
    (activity.studioDecisions ?? [])
      .map((item) => `${item.title} ${item.status} ${item.question} ${item.resolutionNote ?? ''}`)
      .join(' '),
  );
  // Chain content history lines render directly (summary or stored text as
  // the gist), so the estimate mirrors what buildDreamPrompt will emit.
  tokens += estimateCoworkTextTokens(
    (activity.chainWrites ?? [])
      .map((write) => `${write.pinId} ${write.path ?? ''} ${write.summary ?? write.contentText ?? ''}`)
      .join(' ')
  );
  tokens += estimateCoworkTextTokens(
    (activity.chainReads ?? [])
      .map((read) => `${read.pinId} ${read.title ?? ''} ${read.path ?? ''} ${read.summary ?? read.contentExcerpt ?? ''}`)
      .join(' ')
  );
  return tokens;
}

function splitContentByTokenBudget(content: string, maxTokens: number): string[] {
  const chars = Array.from(content);
  if (chars.length === 0) return [''];
  const parts: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    let low = 1;
    let high = chars.length - offset;
    let best = 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = chars.slice(offset, offset + middle).join(' ');
      if (estimateCoworkTextTokens(candidate) + MESSAGE_FRAME_TOKENS <= maxTokens) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    parts.push(chars.slice(offset, offset + best).join(''));
    offset += best;
  }
  return parts;
}

function messageParts(message: DreamActivityMessage, maxTokens: number): DreamActivityMessage[] {
  if (estimateDreamMessageTokens(message) <= maxTokens) return [message];
  return splitContentByTokenBudget(message.content, Math.max(64, maxTokens)).map((content) => ({
    ...message,
    content,
  }));
}

function chunkSession(
  session: DreamSessionActivity,
  maxInputTokens: number,
  taskRuns: DreamTaskRunActivity[],
  orderCount: number,
  groupTasks: DreamGroupTaskEvaluation[],
): DreamActivityChunk[] {
  const chunks: DreamActivityChunk[] = [];
  let current: DreamActivityMessage[] = [];
  let currentTokens = SESSION_FRAME_TOKENS + estimateCoworkTextTokens(`${session.title} ${session.peerName ?? ''}`);

  const flush = (): void => {
    if (current.length === 0) return;
    const chunkIndex = chunks.length;
    chunks.push({
      fragmentKey: `session:${session.sessionId}:${chunkIndex}`,
      sessionId: session.sessionId,
      title: session.title,
      sessionType: session.sessionType,
      peerName: session.peerName,
      isOrder: session.isOrder,
      ...(session.isStudioOwner ? { isStudioOwner: true } : {}),
      ...(session.autoOrigin ? { autoOrigin: session.autoOrigin } : {}),
      ...(chunkIndex === 0 && session.priorContextMessages?.length
        ? { priorContextMessages: session.priorContextMessages }
        : {}),
      chunkIndex,
      messages: current,
      taskRuns: chunkIndex === 0 ? taskRuns : [],
      orderCount: chunkIndex === 0 ? orderCount : 0,
      groupTasks: chunkIndex === 0 ? groupTasks : [],
      sourceMessageCount: current.length,
      sourceCharCount: current.reduce((sum, message) => sum + message.content.length, 0),
      estimatedInputTokens: currentTokens,
    });
    current = [];
    currentTokens = SESSION_FRAME_TOKENS + estimateCoworkTextTokens(`${session.title} ${session.peerName ?? ''}`);
  };

  for (const originalMessage of session.messages) {
    for (const message of messageParts(originalMessage, Math.max(64, maxInputTokens - currentTokens))) {
      const messageTokens = estimateDreamMessageTokens(message);
      if (current.length > 0 && currentTokens + messageTokens > maxInputTokens) {
        flush();
      }
      current.push(message);
      currentTokens += messageTokens;
      if (currentTokens >= maxInputTokens) flush();
    }
  }
  flush();
  return chunks;
}

/**
 * Split a day without dropping messages. A single oversized message is split
 * into continuation segments, so even pathological sessions remain resumable.
 */
export function chunkDreamActivity(activity: DreamDayActivity, maxInputTokens: number): DreamActivityChunk[] {
  const budget = Math.max(256, Math.floor(maxInputTokens));
  const chunks: DreamActivityChunk[] = [];
  const sessions = [
    ...activity.sessions.filter((session) => session.messages.length > 0),
    ...groupChatsToSessions(activity.groupChats ?? []),
  ];
  const groupTasks = activity.groupTasks ?? [];

  for (const session of sessions) {
    const sessionChunks = chunkSession(
      session,
      budget,
      chunks.length === 0 ? activity.taskRuns : [],
      chunks.length === 0 ? activity.orderCount : 0,
      chunks.length === 0 ? groupTasks : [],
    );
    chunks.push(...sessionChunks);
  }

  if (chunks.length === 0 && (activity.taskRuns.length > 0 || activity.orderCount > 0 || groupTasks.length > 0)) {
    chunks.push({
      fragmentKey: 'tasks:0',
      sessionId: '__dream_tasks__',
      title: '定时任务与服务订单',
      sessionType: 'dream_tasks',
      peerName: null,
      isOrder: false,
      chunkIndex: 0,
      messages: [],
      taskRuns: activity.taskRuns,
      orderCount: activity.orderCount,
      groupTasks,
      sourceMessageCount: 0,
      sourceCharCount: activity.taskRuns.reduce((sum, run) => sum + run.taskName.length, 0),
      estimatedInputTokens: 32 + estimateCoworkTextTokens(activity.taskRuns.map((run) => run.taskName).join(' ')),
    });
  } else if (chunks.length > 0 && activity.taskRuns.length > 0 && chunks[0].taskRuns.length === 0) {
    chunks[0].taskRuns = activity.taskRuns;
    chunks[0].orderCount = activity.orderCount;
    chunks[0].groupTasks = groupTasks;
  }

  return chunks;
}

export function chunkToActivity(chunk: DreamActivityChunk): DreamDayActivity {
  return {
    sessions: chunk.messages.length > 0
      ? [{
        sessionId: chunk.sessionId,
        title: chunk.title,
        sessionType: chunk.sessionType,
        peerName: chunk.peerName,
        isOrder: chunk.isOrder,
        messages: chunk.messages,
      }]
      : [],
    taskRuns: chunk.taskRuns,
    orderCount: chunk.orderCount,
    groupTasks: chunk.groupTasks ?? [],
  };
}

export function summariesToActivity(
  summaries: DreamFragmentSummary[],
  taskRuns: DreamTaskRunActivity[],
  orderCount: number,
  groupTasks: DreamGroupTaskEvaluation[] = [],
  chainWrites: DreamChainWriteActivity[] = [],
  chainReads: DreamChainReadActivity[] = [],
  studioDelegations: DreamStudioDelegationActivity[] = [],
  studioDecisions: DreamStudioDecisionActivity[] = [],
): DreamDayActivity {
  return {
    sessions: summaries.map((summary) => ({
      sessionId: summary.fragmentKey,
      title: `分块摘要:${summary.title}#${summary.chunkIndex + 1}`,
      sessionType: 'dream_fragment',
      peerName: null,
      isOrder: false,
      messages: [{
        type: 'assistant',
        content: JSON.stringify({
          fragment_key: summary.fragmentKey,
          source_session_id: summary.sessionId,
          source_session_title: summary.title,
          chunk_index: summary.chunkIndex,
          summary: summary.output,
        }),
        createdAt: 0,
      }],
    })),
    taskRuns,
    orderCount,
    groupTasks,
    // Chain content is day-level evidence that never enters per-chunk
    // summarization; carry it into the synthesis activity so busy days
    // (fragment mode) keep the bot's own publications and reads in the dream.
    chainWrites,
    chainReads,
    ...(studioDelegations.length > 0 ? { studioDelegations } : {}),
    ...(studioDecisions.length > 0 ? { studioDecisions } : {}),
  };
}
