import type { CoworkMessage } from '../coworkStore';
import type { CoworkModelLimits } from './coworkModelLimits';

export const COWORK_CONTEXT_SOFT_THRESHOLD_RATIO = 0.82;
const MESSAGE_FRAME_TOKEN_OVERHEAD = 4;

type CoworkContextMessage = Pick<CoworkMessage, 'type' | 'content' | 'metadata'>;

export interface CoworkContextBudgetInput {
  messages: CoworkContextMessage[];
  modelLimits: Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>;
  currentPrompt?: string;
  systemPrompt?: string;
  softThresholdRatio?: number;
}

export interface CoworkContextBudget {
  estimatedTokens: number;
  usableInputTokens: number;
  softThresholdTokens: number;
  includedMessages: number;
  shouldCompact: boolean;
}

function countCjkCodepoints(value: string): number {
  let count = 0;
  for (const char of value) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)) {
      count += 1;
    }
  }
  return count;
}

export function estimateCoworkTextTokens(value: string): number {
  if (!value) return 0;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;

  const cjkChars = countCjkCodepoints(normalized);
  const nonCjkChars = Math.max(0, [...normalized].length - cjkChars);
  return Math.max(1, cjkChars + Math.ceil(nonCjkChars / 4));
}

export function shouldIncludeCoworkContextMessage(message: CoworkContextMessage): boolean {
  if (message.metadata?.isThinking === true) {
    return false;
  }
  if (message.metadata?.excludeFromSandboxHistory === true) {
    return false;
  }
  if (message.metadata?.isDelegationInternal === true) {
    return false;
  }
  if (message.type === 'system') {
    return false;
  }
  return Boolean(message.content?.trim());
}

export function estimateCoworkMessageTokens(message: CoworkContextMessage): number {
  if (!shouldIncludeCoworkContextMessage(message)) {
    return 0;
  }
  return estimateCoworkTextTokens(message.content) + MESSAGE_FRAME_TOKEN_OVERHEAD;
}

function isCurrentPromptAlreadyPresent(messages: CoworkContextMessage[], currentPrompt: string): boolean {
  const trimmedPrompt = currentPrompt.trim();
  if (!trimmedPrompt) return false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!shouldIncludeCoworkContextMessage(message)) {
      continue;
    }
    if (message.type !== 'user') {
      return false;
    }
    return message.content.trim() === trimmedPrompt;
  }

  return false;
}

function clampSoftThresholdRatio(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return COWORK_CONTEXT_SOFT_THRESHOLD_RATIO;
  }
  return Math.max(0.1, Math.min(0.98, Number(value)));
}

export function getCoworkContextBudget(input: CoworkContextBudgetInput): CoworkContextBudget {
  const usableInputTokens = Math.max(1, Math.floor(input.modelLimits.contextWindow - input.modelLimits.maxOutputTokens));
  const softThresholdRatio = clampSoftThresholdRatio(input.softThresholdRatio);
  const softThresholdTokens = Math.max(1, Math.floor(usableInputTokens * softThresholdRatio));

  let estimatedTokens = input.systemPrompt ? estimateCoworkTextTokens(input.systemPrompt) : 0;
  let includedMessages = 0;

  for (const message of input.messages) {
    const messageTokens = estimateCoworkMessageTokens(message);
    if (messageTokens <= 0) {
      continue;
    }
    estimatedTokens += messageTokens;
    includedMessages += 1;
  }

  const currentPrompt = input.currentPrompt?.trim() ?? '';
  if (currentPrompt && !isCurrentPromptAlreadyPresent(input.messages, currentPrompt)) {
    estimatedTokens += estimateCoworkTextTokens(currentPrompt) + MESSAGE_FRAME_TOKEN_OVERHEAD;
  }

  return {
    estimatedTokens,
    usableInputTokens,
    softThresholdTokens,
    includedMessages,
    shouldCompact: estimatedTokens >= softThresholdTokens,
  };
}

export function isContextWindowExceededError(message: string): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();

  if (
    normalized.includes('reasoning_content')
    && (
      normalized.includes('thinking mode')
      || normalized.includes('deepseek thinking request is missing')
    )
  ) {
    return false;
  }

  return [
    /\b413\b/,
    /payload too large/,
    /request entity too large/,
    /context (?:length|window).*exceed/,
    /maximum context (?:length|window)/,
    /input too long/,
    /prompt too long/,
    /too many tokens/,
    /token limit/,
    /tokens.*exceed/,
  ].some((pattern) => pattern.test(normalized));
}
