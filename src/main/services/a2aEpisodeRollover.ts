import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';
import type { CoworkMessage, CoworkStore } from '../coworkStore';

/**
 * Episode rollover for long-lived A2A private-chat threads.
 *
 * Background: A2A reply turns run inside the mapped cowork session, and the
 * session context grows without bound — the 2026-09-16 stall investigation
 * found a 249-turn / 8,973-message session whose turns degraded into
 * reasoning-only completions (9 of the last 19 turns) while fresh sessions
 * stayed clean. The thread/episode tables already model generations; this
 * module re-introduces the rollover policy that used to exist before it was
 * retired for UX reasons ("keep A2A chats in one session"): when the mapped
 * session exceeds the message threshold, close its episode (with an LLM
 * handoff summary), create the successor session, and re-point the
 * conversation mapping. The UI aggregates all episodes of a thread as ONE
 * conversation, so the owner's mental model stays a single bot-2-bot chat.
 */

/** Rollover threshold in total session messages (all message types). */
export const A2A_EPISODE_ROLLOVER_MESSAGE_THRESHOLD = 1000;

/** Budget for the LLM handoff summary; on expiry a deterministic digest is used. */
const A2A_EPISODE_SUMMARY_TIMEOUT_MS = 90_000;

const A2A_EPISODE_HANDOFF_SUMMARY_MAX_CHARS = 2_500;

type PerformChatFn = (
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
    attemptTimeoutMs?: number;
    attemptTimeoutKind?: 'total' | 'idle';
  },
) => Promise<string>;

export interface A2AEpisodeRolloverResult {
  sessionId: string;
  previousSessionId: string;
  episodeIndex: number;
  summary: string;
}

function safeParseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatEpisodeTimestamp(timestamp: number | null | undefined): string {
  if (!Number.isFinite(Number(timestamp))) return '';
  return new Date(Number(timestamp)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function buildA2AEpisodeHandoffSummarySystemPrompt(): string {
  return [
    'You are writing a handoff summary for one episode of an ongoing bot-to-bot private chat.',
    'The conversation continues in a fresh session that will ONLY see this summary of the episode you are closing.',
    'Write in the same language as the conversation. Keep it under 400 words, plain text, no markdown headings.',
    'Cover, in this order:',
    '1. Topics discussed and conclusions reached (facts and decisions only, no narration).',
    '2. OPEN COMMITTMENTS: anything either side promised but has not yet delivered — owed answers, pending verifications, agreed next steps. This section is the most important: losing an owed answer re-creates a conversation deadlock.',
    '3. Working style and preferences observed for the peer bot, plus any standing context worth carrying (identifiers, on-chain references, agreed vocabulary).',
  ].join('\n');
}

/** Deterministic digest used when the LLM summary fails or times out. */
export function buildA2AEpisodeFallbackSummary(messages: CoworkMessage[]): string {
  const usable = messages.filter((message) => String(message.content ?? '').trim().length > 0);
  if (usable.length === 0) {
    return '[Handoff summary — fallback] The closed episode contained no readable conversation messages.';
  }
  const clip = (text: string): string => {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
  };
  const span = usable.length;
  const opening = usable[0]!;
  const tail = usable.slice(-6);
  const lines = [
    `[Handoff summary — fallback, generated without LLM] ${span} messages from ${formatEpisodeTimestamp(opening.timestamp)} to ${formatEpisodeTimestamp(usable[usable.length - 1]!.timestamp)}.`,
    `Opening — ${opening.type === 'user' ? 'Peer' : 'Local'}: ${clip(opening.content)}`,
    'Latest exchanges:',
    ...tail.map((message) => `- ${message.type === 'user' ? 'Peer' : 'Local'}: ${clip(message.content)}`),
  ];
  return lines.join('\n').slice(0, A2A_EPISODE_HANDOFF_SUMMARY_MAX_CHARS);
}

export async function generateA2AEpisodeHandoffSummary(params: {
  performChat: PerformChatFn;
  llmId?: string | null;
  llmProvider?: string | null;
  fallbackLlmId?: string | null;
  fallbackLlmProvider?: string | null;
  effort?: 'off' | 'low' | 'high' | 'max' | null;
  fallbackEffort?: 'off' | 'low' | 'high' | 'max' | null;
  messages: CoworkMessage[];
  emitLog: (msg: string) => void;
}): Promise<string> {
  const transcript = params.messages
    .map((message) => `${message.type === 'user' ? 'Peer' : 'Local'}: ${String(message.content ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('\n')
    .slice(-24_000);
  const fallback = () => buildA2AEpisodeFallbackSummary(params.messages);
  try {
    const summaryPromise = params.performChat(
      buildA2AEpisodeHandoffSummarySystemPrompt(),
      transcript,
      params.llmId ?? undefined,
      {
        llmProvider: params.llmProvider,
        fallbackLlmId: params.fallbackLlmId,
        fallbackLlmProvider: params.fallbackLlmProvider,
        effort: params.effort,
        fallbackEffort: params.fallbackEffort,
        thinking: 'disabled',
        // Streaming transport: 45s bounds stream silence, not the whole
        // generation (outer 90s race still bounds the await).
        attemptTimeoutMs: 45_000,
        attemptTimeoutKind: 'idle',
      },
    );
    const summary = await Promise.race([
      summaryPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('episode summary timeout')), A2A_EPISODE_SUMMARY_TIMEOUT_MS);
      }),
    ]);
    const trimmed = String(summary ?? '').trim();
    if (!trimmed) return fallback();
    return trimmed.slice(0, A2A_EPISODE_HANDOFF_SUMMARY_MAX_CHARS);
  } catch (error) {
    params.emitLog(
      `[PrivateChat] Episode handoff summary LLM failed (${error instanceof Error ? error.message : String(error)}); using deterministic digest.`
    );
    return fallback();
  }
}

/**
 * Close the mapped episode and open its successor when the session has grown
 * past the message threshold. Returns null when no rollover applies (below
 * threshold, blocking service orders, or a store-level failure — the caller
 * then simply continues on the existing session).
 */
export async function maybeRollOverPrivateChatEpisode(params: {
  coworkStore: Pick<
    CoworkStore,
    | 'getSessionMessageCount'
    | 'hasBlockingServiceOrdersForSession'
    | 'getSessionWithoutMessages'
    | 'getRecentPrivateA2AMessages'
    | 'createSession'
    | 'registerA2AEpisode'
    | 'updateA2AEpisodeSummary'
    | 'getConversationMapping'
    | 'upsertConversationMapping'
    | 'updateConversationMappingMetadata'
    | 'getConfig'
  >;
  sessionId: string;
  externalConversationId: string;
  metabotId: number;
  localGlobalMetaId: string;
  peerGlobalMetaId: string;
  peerName?: string | null;
  peerAvatar?: string | null;
  performChat: PerformChatFn;
  llmId?: string | null;
  llmProvider?: string | null;
  fallbackLlmId?: string | null;
  fallbackLlmProvider?: string | null;
  effort?: 'off' | 'low' | 'high' | 'max' | null;
  fallbackEffort?: 'off' | 'low' | 'high' | 'max' | null;
  emitLog: (msg: string) => void;
}): Promise<A2AEpisodeRolloverResult | null> {
  const { coworkStore, sessionId } = params;
  let messageCount = 0;
  try {
    messageCount = coworkStore.getSessionMessageCount(sessionId);
  } catch {
    return null;
  }
  if (messageCount < A2A_EPISODE_ROLLOVER_MESSAGE_THRESHOLD) return null;
  // Lesson from the retired rotation: never move a conversation while paid
  // service orders still reference the session — order flows resolve their
  // working session by id and must keep replying in place.
  if (coworkStore.hasBlockingServiceOrdersForSession(sessionId)) {
    params.emitLog(
      `[PrivateChat] Episode rollover deferred for ${params.externalConversationId.slice(0, 30)}…: blocking service orders pin the session.`
    );
    return null;
  }
  const oldSession = coworkStore.getSessionWithoutMessages(sessionId);
  if (!oldSession) return null;

  const summary = await generateA2AEpisodeHandoffSummary({
    performChat: params.performChat,
    llmId: params.llmId,
    llmProvider: params.llmProvider,
    fallbackLlmId: params.fallbackLlmId,
    fallbackLlmProvider: params.fallbackLlmProvider,
    effort: params.effort,
    fallbackEffort: params.fallbackEffort,
    messages: coworkStore.getRecentPrivateA2AMessages(sessionId, 200),
    emitLog: params.emitLog,
  });

  const workspace = resolveSessionWorkingDirectory(coworkStore.getConfig().workingDirectory, params.metabotId);
  const newSession = coworkStore.createSession(
    oldSession.title,
    workspace,
    '',
    'local',
    [],
    params.metabotId,
    'a2a',
    params.peerGlobalMetaId,
    params.peerName ?? null,
    params.peerAvatar ?? null,
  );
  const episode = coworkStore.registerA2AEpisode({
    sessionId: newSession.id,
    localMetabotId: params.metabotId,
    localGlobalMetaId: params.localGlobalMetaId,
    peerGlobalMetaId: params.peerGlobalMetaId,
    previousSessionId: sessionId,
    previousCloseReason: 'rollover',
    startedAt: newSession.createdAt,
  });
  coworkStore.updateA2AEpisodeSummary(sessionId, summary);

  const existingMapping = coworkStore.getConversationMapping('metaweb_private', params.externalConversationId, params.metabotId);
  const preservedMetadata = safeParseJsonRecord(existingMapping?.metadataJson);
  const mappingMetadata = {
    ...preservedMetadata,
    peerGlobalMetaId: params.peerGlobalMetaId,
    peerName: params.peerName ?? null,
    peerAvatar: params.peerAvatar ?? null,
    a2aConversationId: params.externalConversationId,
    a2aThreadId: episode.threadId,
    episodeIndex: episode.episodeIndex,
    episodeStartedAt: newSession.createdAt,
    previousEpisodeSessionId: sessionId,
  };
  coworkStore.upsertConversationMapping({
    channel: 'metaweb_private',
    externalConversationId: params.externalConversationId,
    metabotId: params.metabotId,
    coworkSessionId: newSession.id,
    metadataJson: JSON.stringify(mappingMetadata),
  });
  coworkStore.updateConversationMappingMetadata('cowork_ui', newSession.id, params.metabotId, {
    a2aConversationId: params.externalConversationId,
    a2aThreadId: episode.threadId,
    episodeIndex: episode.episodeIndex,
    episodeStartedAt: newSession.createdAt,
    previousEpisodeSessionId: sessionId,
    peerGlobalMetaId: params.peerGlobalMetaId,
  });

  params.emitLog(
    `[PrivateChat] Episode rollover for ${params.externalConversationId.slice(0, 30)}…: session ${sessionId.slice(0, 8)}… (${messageCount} messages) closed as episode ${episode.episodeIndex - 1}; continuing in ${newSession.id.slice(0, 8)}… with handoff summary.`
  );
  return {
    sessionId: newSession.id,
    previousSessionId: sessionId,
    episodeIndex: episode.episodeIndex,
    summary,
  };
}

/**
 * Continuity block appended to the system prompt of every turn in a session
 * whose episode has closed predecessors, so the successor "remembers" the
 * earlier parts of the thread through the handoff summaries.
 */
export function buildA2AEpisodeContinuityPromptBlock(
  previousEpisodes: Array<{ episodeIndex: number; summary: string | null; endedAt: number | null }>,
): string {
  const usable = previousEpisodes
    .filter((episode) => typeof episode.summary === 'string' && episode.summary.trim().length > 0)
    .slice(-2);
  if (usable.length === 0) return '';
  const sections = usable.map((episode) => {
    const stamp = formatEpisodeTimestamp(episode.endedAt);
    return [
      `### Episode ${episode.episodeIndex}${stamp ? ` (closed ${stamp})` : ''}`,
      String(episode.summary).trim(),
    ].join('\n');
  });
  return [
    '## Previous Episodes of This Conversation (handoff summaries)',
    'Earlier parts of this ongoing conversation ran in previous episodes that are no longer in your message history. The handoff summaries below are your memory of them; treat their facts, conclusions, and especially any OPEN COMMITTMENTS as your own.',
    ...sections,
  ].join('\n');
}
