import type { CoworkMessage } from '../coworkStore';
import type { CoworkModelLimits } from './coworkModelLimits';
import {
  estimateCoworkTextTokens,
  shouldIncludeCoworkContextMessage,
} from './coworkContextBudget';

const DEFAULT_RECENT_MESSAGES = 16;
const DEFAULT_SUMMARY_CHARS = 12_000;
const DEFAULT_RECENT_TAIL_TOKENS = 24_000;
const MESSAGE_CONTENT_MAX_CHARS = 4_000;

export interface BuildCoworkCompactedPromptInput {
  messages: CoworkMessage[];
  currentPrompt: string;
  modelLimits: Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>;
  maxRecentMessages?: number;
  maxSummaryChars?: number;
  maxRecentTailTokens?: number;
}

export interface CoworkCompactedPrompt {
  prompt: string;
  estimatedTokens: number;
  recentMessages: number;
  summarizedMessages: number;
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 16) {
    return value.slice(0, Math.max(0, maxChars));
  }
  return `${value.slice(0, maxChars - 16).trimEnd()}... [truncated]`;
}

function roleLabel(message: Pick<CoworkMessage, 'type' | 'metadata'>): string {
  if (message.type === 'tool_use') {
    const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : 'tool';
    return `tool_use:${toolName}`;
  }
  if (message.type === 'tool_result') {
    const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : 'tool';
    return `tool_result:${toolName}`;
  }
  return message.type;
}

function formatMessageLine(message: CoworkMessage, maxChars = MESSAGE_CONTENT_MAX_CHARS): string {
  const content = truncateText(normalizeContent(message.content), maxChars);
  return `- ${roleLabel(message)}: ${content}`;
}

function filterHistory(messages: CoworkMessage[], currentPrompt: string): CoworkMessage[] {
  const trimmedPrompt = currentPrompt.trim();
  const filteredFromNewest: CoworkMessage[] = [];
  let removedCurrentPrompt = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!shouldIncludeCoworkContextMessage(message)) {
      continue;
    }
    if (
      !removedCurrentPrompt
      && trimmedPrompt
      && message.type === 'user'
      && message.content.trim() === trimmedPrompt
    ) {
      removedCurrentPrompt = true;
      continue;
    }
    filteredFromNewest.push(message);
  }

  return filteredFromNewest.reverse();
}

function selectRecentTail(
  history: CoworkMessage[],
  maxRecentMessages: number,
  maxRecentTailTokens: number
): { recent: CoworkMessage[]; firstRecentIndex: number } {
  const selectedFromNewest: CoworkMessage[] = [];
  let totalTokens = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (selectedFromNewest.length >= maxRecentMessages) {
      break;
    }
    const message = history[index];
    const messageTokens = estimateCoworkTextTokens(formatMessageLine(message));
    if (totalTokens + messageTokens > maxRecentTailTokens) {
      if (selectedFromNewest.length === 0) {
        selectedFromNewest.push(message);
      }
      break;
    }
    selectedFromNewest.push(message);
    totalTokens += messageTokens;
  }

  const recent = selectedFromNewest.reverse();
  const firstRecent = recent[0];
  const firstRecentIndex = firstRecent ? history.findIndex((message) => message.id === firstRecent.id) : history.length;
  return {
    recent,
    firstRecentIndex: firstRecentIndex >= 0 ? firstRecentIndex : history.length,
  };
}

function buildSummaryLines(messages: CoworkMessage[], maxSummaryChars: number): string {
  if (messages.length === 0) {
    return '- No earlier messages outside the recent tail.';
  }

  const lines: string[] = [];
  let totalChars = 0;
  let omitted = 0;

  for (const message of messages) {
    const line = formatMessageLine(message, 800);
    const nextTotal = totalChars + line.length + 1;
    if (nextTotal > maxSummaryChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    totalChars = nextTotal;
  }

  if (omitted > 0) {
    lines.push(`- ... [truncated ${omitted} earlier message(s)]`);
  }

  return lines.length > 0 ? lines.join('\n') : `- ... [truncated ${messages.length} earlier message(s)]`;
}

function buildRecentTailLines(messages: CoworkMessage[], maxRecentTailTokens: number): string {
  if (messages.length === 0) {
    return '- No recent messages are available.';
  }

  const maxCharsPerMessage = Math.max(200, Math.floor((maxRecentTailTokens * 4) / Math.max(1, messages.length)));
  return messages
    .map((message) => formatMessageLine(message, Math.min(MESSAGE_CONTENT_MAX_CHARS, maxCharsPerMessage)))
    .join('\n');
}

export function buildCoworkCompactedPrompt(input: BuildCoworkCompactedPromptInput): CoworkCompactedPrompt {
  const usableInputTokens = Math.max(1, input.modelLimits.contextWindow - input.modelLimits.maxOutputTokens);
  const maxRecentMessages = Math.max(1, Math.floor(input.maxRecentMessages ?? DEFAULT_RECENT_MESSAGES));
  const maxSummaryChars = Math.max(80, Math.floor(input.maxSummaryChars ?? Math.min(DEFAULT_SUMMARY_CHARS, usableInputTokens)));
  const maxRecentTailTokens = Math.max(
    16,
    Math.floor(input.maxRecentTailTokens ?? Math.min(DEFAULT_RECENT_TAIL_TOKENS, Math.floor(usableInputTokens * 0.35)))
  );

  const history = filterHistory(input.messages, input.currentPrompt);
  const { recent, firstRecentIndex } = selectRecentTail(history, maxRecentMessages, maxRecentTailTokens);
  const summaryMessages = history.slice(0, firstRecentIndex);

  const summary = buildSummaryLines(summaryMessages, maxSummaryChars);
  const recentTail = buildRecentTailLines(recent, maxRecentTailTokens);
  const currentRequest = input.currentPrompt.trim() || '(empty current request)';

  const prompt = [
    '[IDBots compacted cowork context]',
    'The underlying SDK conversation was reset because the prior session approached or exceeded the model context window.',
    'Use only the compacted summary, recent tail, and current request below. Do not assume hidden access to the old SDK session.',
    '',
    '<session_summary>',
    summary,
    '</session_summary>',
    '',
    '<recent_tail>',
    recentTail,
    '</recent_tail>',
    '',
    '<current_user_request>',
    currentRequest,
    '</current_user_request>',
  ].join('\n');

  return {
    prompt,
    estimatedTokens: estimateCoworkTextTokens(prompt),
    recentMessages: recent.length,
    summarizedMessages: summaryMessages.length,
  };
}
