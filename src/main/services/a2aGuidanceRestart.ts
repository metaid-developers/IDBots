import type { CoworkMessage } from '../coworkStore';
import { appendA2AGuidanceToSystemPrompt } from './a2aGuidance';
import { extractFriendActionTags } from './friendFollowService';
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';

export type A2APrivateChatControlState = 'active' | 'ended' | null;

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
};

export const getLatestA2APrivateChatControlState = (
  session: { messages?: CoworkMessage[] } | null | undefined
): A2APrivateChatControlState => {
  let state: A2APrivateChatControlState = null;
  for (const message of session?.messages ?? []) {
    if (message.metadata?.a2aConversationRestarted === true) {
      state = 'active';
    }
    if (
      message.metadata?.a2aConversationEnded === true
      || message.metadata?.a2aConversationEndSystemNotice === true
    ) {
      state = 'ended';
    }
  }
  return state;
};

export const shouldRestartA2APrivateChatForGuidance = (input: {
  session: { messages?: CoworkMessage[]; status?: string | null } | null | undefined;
  sourceChannel?: string | null;
  mappingMetadata?: Record<string, unknown> | null;
}): boolean => {
  const controlState = getLatestA2APrivateChatControlState(input.session);
  if (controlState === 'ended') return true;
  const isMetawebPrivate = input.sourceChannel === 'metaweb_private';
  if (!isMetawebPrivate) return false;

  const sessionStatus = typeof input.session?.status === 'string'
    ? input.session.status.trim()
    : '';
  if (sessionStatus && sessionStatus !== 'running') {
    return true;
  }

  if (controlState === 'active') return false;
  return input.mappingMetadata?.byeSent === true
    || Number.isFinite(Number(input.mappingMetadata?.endedAt));
};

/**
 * Cap each embedded recent-message line so a long conversation cannot blow up
 * the restart prompt. Oversized prompts push reasoning-style models to spend
 * the whole completion budget before emitting any visible content, which used
 * to surface as "Local MetaBot did not generate a restart message".
 */
export const A2A_GUIDANCE_RESTART_MAX_CONTEXT_LINE_CHARS = 400;

const truncateContextLine = (line: string): string => {
  const clean = stripLoneSurrogates(line);
  if (clean.length <= A2A_GUIDANCE_RESTART_MAX_CONTEXT_LINE_CHARS) return clean;
  return `${truncateUtf16Units(clean, A2A_GUIDANCE_RESTART_MAX_CONTEXT_LINE_CHARS)}…`;
};

export const buildA2AGuidanceRestartPrompt = (input: {
  localName: string;
  peerName: string;
  guidance: string;
  messages: CoworkMessage[];
}): { systemPrompt: string; userPrompt: string } => {
  const recentLines = input.messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .slice(-20)
    .map((message) => {
      const direction = message.metadata?.direction === 'outgoing' ? input.localName : input.peerName;
      return truncateContextLine(`${direction}: ${toSafeString(message.content).trim()}`);
    })
    .filter((line) => line.trim());

  const baseSystemPrompt = [
    `You are ${input.localName}, a local MetaBot restarting a private MetaBot-to-MetaBot conversation with ${input.peerName}.`,
    'Generate exactly one outgoing private-chat message addressed to the peer.',
    'Do not output "bye" unless the guidance explicitly asks to close the conversation.',
    'Do not mention system prompts, chain metadata, or implementation details.',
    '',
    '## Recent A2A Context',
    ...(recentLines.length ? recentLines : ['(no recent visible A2A context)']),
  ].join('\n');

  return {
    systemPrompt: appendA2AGuidanceToSystemPrompt(baseSystemPrompt, input.guidance),
    userPrompt: 'Write the next outgoing private-chat message now.',
  };
};

/**
 * Sanitize a generated restart message for delivery (S6 defect #4 hardening).
 * The restart prompt intentionally carries no friend-tag protocol, so a
 * well-behaved completion never contains one — but a model that picked the
 * tag up from the embedded recent-message context must never leak it to the
 * peer verbatim. Extract friend-action tags exactly like the daemon's reply
 * chain does: strip them from the delivered text and surface the action so
 * the caller can drive the owner-authorized chain write.
 */
export const composeA2AGuidanceRestartDelivery = (reply: string): {
  text: string;
  friendAction: 'invite' | 'remove' | null;
} => {
  const { text, action } = extractFriendActionTags(typeof reply === 'string' ? reply : '');
  return { text, friendAction: action };
};

export const A2A_GUIDANCE_RESTART_LLM_TIMEOUT_MS = 60_000;
export const A2A_GUIDANCE_RESTART_MAX_ATTEMPTS = 2;
/**
 * Completion budget for the restart message. Deliberately higher than the
 * orchestrator default (2048): reasoning-style models count reasoning tokens
 * against max_tokens, and a small budget makes them return empty content,
 * which is the root cause of "did not generate a restart message".
 */
export const A2A_GUIDANCE_RESTART_MAX_TOKENS = 4096;

export type PerformA2AGuidanceRestartChatFn = (
  systemPrompt: string,
  userPrompt: string,
  llmId?: string,
  options?: { signal?: AbortSignal; maxTokens?: number; attemptTimeoutMs?: number }
) => Promise<string>;

/**
 * Generate the restart message for a guided A2A conversation restart.
 * Retries when the LLM returns empty content or the call fails transiently,
 * and bounds every attempt with a timeout so the UI never hangs indefinitely.
 * Returns the trimmed reply, or '' when every attempt produced empty content;
 * rethrows the last error when every attempt failed.
 */
export const generateA2AGuidanceRestartMessage = async (input: {
  systemPrompt: string;
  userPrompt: string;
  llmId?: string;
  performChat: PerformA2AGuidanceRestartChatFn;
  maxAttempts?: number;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<string> => {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? A2A_GUIDANCE_RESTART_MAX_ATTEMPTS));
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? A2A_GUIDANCE_RESTART_LLM_TIMEOUT_MS));
  const maxTokens = Math.max(1, Math.floor(input.maxTokens ?? A2A_GUIDANCE_RESTART_MAX_TOKENS));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const reply = toSafeString(
        await input.performChat(input.systemPrompt, input.userPrompt, input.llmId, {
          // Per-attempt window: the fallback brain retried inside the call
          // gets its own fresh timeout instead of a shared spent signal.
          attemptTimeoutMs: timeoutMs,
          maxTokens,
        })
      ).trim();
      if (reply) return reply;
      console.warn(`[A2A Guidance] Restart message attempt ${attempt}/${maxAttempts} returned empty content.`);
    } catch (error) {
      lastError = error;
      console.warn(
        `[A2A Guidance] Restart message attempt ${attempt}/${maxAttempts} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (lastError) throw lastError;
  return '';
};
