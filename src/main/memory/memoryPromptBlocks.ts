import type { MemoryUserMemory } from './memoryBackend';
import { normalizeScopeChannel } from './memoryScope';

export type MemoryPromptEntryLike = Pick<MemoryUserMemory, 'text' | 'usageClass' | 'visibility'>;

export interface RankedScopedMemoryEntry extends MemoryPromptEntryLike {
  block: 'owner' | 'contact' | 'conversation' | 'ownerOperationalPreference';
  relevanceScore: number;
}

export interface ScopedMemoryPromptSelection {
  ownerMemories: RankedScopedMemoryEntry[];
  contactMemories: RankedScopedMemoryEntry[];
  conversationMemories: RankedScopedMemoryEntry[];
  ownerOperationalPreferences: RankedScopedMemoryEntry[];
}

export interface RankScopedMemoryEntriesInput {
  requestChannel?: string | null;
  ownerEntries?: MemoryPromptEntryLike[];
  contactEntries?: MemoryPromptEntryLike[];
  conversationEntries?: MemoryPromptEntryLike[];
  currentUserText?: string;
  maxOwnerEntries?: number;
  maxScopedEntries?: number;
  maxOwnerOperationalPreferences?: number;
}

export interface BuildScopedMemoryPromptBlocksInput extends RankScopedMemoryEntriesInput {
  channel?: string | null;
}

function normalizePromptText(value?: string | null): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isExternalChannel(channel?: string | null): boolean {
  const normalized = normalizeScopeChannel(channel);
  return Boolean(normalized && normalized !== 'cowork_ui');
}

function tokenizePromptText(value?: string): string[] {
  const normalized = normalizePromptText(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(/[\s,，、|/\\;；:.!?]+/g).filter((token) => token.length >= 2);
}

function scoreEntryForPrompt(entry: MemoryPromptEntryLike, currentUserText?: string): number {
  const normalizedText = normalizePromptText(entry.text);
  if (!normalizedText) {
    return 0;
  }

  const tokens = tokenizePromptText(currentUserText);
  let score = 1;
  for (const token of tokens) {
    if (normalizedText.includes(token)) {
      score += 3;
    }
  }
  if (currentUserText && normalizedText.includes(normalizePromptText(currentUserText))) {
    score += 6;
  }
  return score;
}

function rankEntries(
  entries: MemoryPromptEntryLike[] | undefined,
  block: RankedScopedMemoryEntry['block'],
  currentUserText?: string,
  limit = 12
): RankedScopedMemoryEntry[] {
  return [...(entries ?? [])]
    .filter((entry) => normalizePromptText(entry.text))
    .map((entry) => ({
      ...entry,
      block,
      relevanceScore: scoreEntryForPrompt(entry, currentUserText),
    }))
    .sort((left, right) => {
      if (right.relevanceScore !== left.relevanceScore) {
        return right.relevanceScore - left.relevanceScore;
      }
      return normalizePromptText(left.text).localeCompare(normalizePromptText(right.text));
    })
    .slice(0, limit);
}

export function selectScopedMemoryPromptEntries(input: RankScopedMemoryEntriesInput): ScopedMemoryPromptSelection {
  const channel = input.requestChannel ?? input.currentUserText ?? null;
  const scopedLimit = Math.max(1, input.maxScopedEntries ?? 12);
  const ownerLimit = Math.max(1, input.maxOwnerEntries ?? scopedLimit);
  const ownerOperationalLimit = Math.max(1, input.maxOwnerOperationalPreferences ?? 3);

  if (!isExternalChannel(channel)) {
    return {
      ownerMemories: rankEntries(input.ownerEntries, 'owner', input.currentUserText, ownerLimit),
      contactMemories: [],
      conversationMemories: [],
      ownerOperationalPreferences: [],
    };
  }

  const safeOwnerOperationalEntries = (input.ownerEntries ?? []).filter((entry) =>
    entry.usageClass === 'operational_preference' && entry.visibility === 'external_safe'
  );
  const contactMemories = rankEntries(input.contactEntries, 'contact', input.currentUserText, scopedLimit);
  const conversationMemories = contactMemories.length > 0
    ? []
    : rankEntries(input.conversationEntries, 'conversation', input.currentUserText, scopedLimit);

  return {
    ownerMemories: [],
    contactMemories,
    conversationMemories,
    ownerOperationalPreferences: rankEntries(
      safeOwnerOperationalEntries,
      'ownerOperationalPreference',
      input.currentUserText,
      ownerOperationalLimit
    ),
  };
}

export function rankScopedMemoryEntries(input: RankScopedMemoryEntriesInput): RankedScopedMemoryEntry[] {
  const selection = selectScopedMemoryPromptEntries(input);
  return [
    ...selection.ownerMemories,
    ...selection.contactMemories,
    ...selection.conversationMemories,
    ...selection.ownerOperationalPreferences,
  ];
}

function renderPromptBlock(tagName: string, entries: RankedScopedMemoryEntry[]): string {
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map((entry) => `- ${escapeXml(entry.text)}`);
  return `<${tagName}>\n${lines.join('\n')}\n</${tagName}>`;
}

export function buildScopedMemoryPromptBlocks(input: BuildScopedMemoryPromptBlocksInput): string {
  const selection = selectScopedMemoryPromptEntries({
    ...input,
    requestChannel: input.channel ?? input.requestChannel,
  });

  return [
    renderPromptBlock('ownerMemories', selection.ownerMemories),
    renderPromptBlock('contactMemories', selection.contactMemories),
    renderPromptBlock('conversationMemories', selection.conversationMemories),
    renderPromptBlock('ownerOperationalPreferences', selection.ownerOperationalPreferences),
  ]
    .filter(Boolean)
    .join('\n');
}
