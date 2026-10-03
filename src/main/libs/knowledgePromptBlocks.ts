/**
 * Knowledge prompt blocks — the hot layer for the knowledge-point anchored
 * memory (经验/知识点).
 *
 * Pure builders mirroring experiencePromptBlocks.ts. The hot block injects a
 * bounded slice of the bot's most relevant knowledge points (know-how AND
 * pitfalls) so they proactively guide new work instead of waiting for an
 * explicit recall. The recall tool's result formatting lives here too.
 *
 * Kept store-agnostic: callers pass already-loaded entry views, so the runner
 * stays the only place that touches the store.
 */

import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';

export const KNOWLEDGE_PROMPT_MAX_ITEMS = 8;
export const KNOWLEDGE_PROMPT_MAX_CHARS = 2400;
const KNOWLEDGE_ENTRY_MAX_CHARS = 500;
const KNOWLEDGE_TOPIC_MAX_CHARS = 120;
const RECALL_ENTRY_MAX_CHARS = 600;

export interface KnowledgePromptEntry {
  topic: string;
  summary: string;
  kind: 'know_how' | 'pitfall' | 'principle';
  category?: string | null;
  version?: number;
  /** Cold-channel recall only: entry is status='archived', render the marker. */
  archived?: boolean;
}

const KIND_LABEL: Record<KnowledgePromptEntry['kind'], string> = {
  know_how: '做法',
  pitfall: '坑',
  principle: '原则',
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function truncate(value: unknown, maxLength: number): string {
  // Stored knowledge rows may already carry the pre-fix lone-surrogate
  // pollution — sanitize on render as well as cutting surrogate-safe.
  const text = stripLoneSurrogates(typeof value === 'string' ? value.trim() : '');
  return text.length > maxLength ? `${truncateUtf16Units(text, maxLength).trim()}…` : text;
}

/**
 * Hot layer: a bounded slice of the bot's reusable knowledge points (mix of
 * know-how and pitfalls), newest-first, dropped when over the char budget.
 * Injected so prior knowledge actively constrains new work instead of sitting
 * in storage.
 */
export function buildKnowledgeBlock(
  entries: KnowledgePromptEntry[],
  maxItems: number = KNOWLEDGE_PROMPT_MAX_ITEMS,
  maxChars: number = KNOWLEDGE_PROMPT_MAX_CHARS,
): string {
  const items = (entries ?? [])
    .slice(0, Math.max(1, maxItems))
    .map((entry) => ({
      topic: truncate(entry.topic, KNOWLEDGE_TOPIC_MAX_CHARS),
      summary: truncate(entry.summary, KNOWLEDGE_ENTRY_MAX_CHARS),
      kind: entry.kind === 'pitfall' ? 'pitfall' : entry.kind === 'principle' ? 'principle' : 'know_how',
      category: typeof entry.category === 'string' && entry.category.trim() ? entry.category.trim() : null,
    }))
    .filter((entry) => entry.topic && entry.summary);
  if (items.length === 0) return '';

  const lines: string[] = ['<knowledge>'];
  let used = lines.join('\n').length;
  let included = 0;
  for (const entry of items) {
    const tag = entry.kind === 'pitfall' ? 'pitfall' : entry.kind === 'principle' ? 'principle' : 'know_how';
    const categoryAttr = entry.category ? ` category="${escapeXml(entry.category)}"` : '';
    const line = `  <${tag}${categoryAttr} topic="${escapeXml(entry.topic)}">${escapeXml(entry.summary)}</${tag}>`;
    if (included > 0 && used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
    included += 1;
  }
  if (included === 0) return '';
  lines.push('</knowledge>');
  lines.push(
    '<instruction>',
    'The &lt;knowledge&gt; block lists reusable knowledge points you distilled from past work — know-how,',
    'pitfalls (坑, things that backfired and must be avoided), and principles. When a new task resembles one',
    'of them, reuse the approach that worked and sidestep the pitfalls you already hit. These are guidance',
    'from your own experience, not facts about the current user — keep them current by revising them with the',
    'knowledge_upsert tool when you learn something better.',
    '</instruction>',
  );
  const rendered = lines.join('\n');
  return rendered.length <= maxChars
    ? rendered
    : `${truncateUtf16Units(rendered, Math.max(0, maxChars - 1)).trim()}…`;
}

/** Plain-text rendering of recall results for the knowledge_recall tool response. */
export function formatKnowledgeRecallResults(entries: KnowledgePromptEntry[]): string {
  if (!entries || entries.length === 0) {
    return 'No knowledge points found for the given query. You have not distilled a reusable point about this yet — if the current task taught you something worth reusing, save it with knowledge_upsert.';
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const label = KIND_LABEL[entry.kind === 'pitfall' ? 'pitfall' : entry.kind === 'principle' ? 'principle' : 'know_how'];
    const category = typeof entry.category === 'string' && entry.category.trim() ? `[${entry.category}] ` : '';
    const versionSuffix = typeof entry.version === 'number' && entry.version > 1 ? ` (v${entry.version})` : '';
    const archivedMark = entry.archived === true ? ' (archived)' : '';
    const topic = truncate(entry.topic, KNOWLEDGE_TOPIC_MAX_CHARS);
    const summary = truncate(entry.summary, RECALL_ENTRY_MAX_CHARS);
    lines.push(`- 【${label}】${category}${topic}${versionSuffix}${archivedMark}: ${summary}`);
  }
  lines.push('');
  lines.push('These are reusable knowledge points from your own past work. Apply the know-how, avoid the pitfalls (坑), and revise any entry with knowledge_upsert when you learn something better.');
  return lines.join('\n');
}

/** Human-readable confirmation for the knowledge_upsert tool response. */
export function formatKnowledgeUpsertResult(input: {
  topic: string;
  created: boolean;
  revised: boolean;
  version: number;
  kind: string;
}): string {
  const verb = input.created ? 'Saved new knowledge point' : input.revised ? 'Updated knowledge point' : 'Knowledge point already up to date';
  return `${verb}: 「${truncate(input.topic, KNOWLEDGE_TOPIC_MAX_CHARS)}」 (kind=${input.kind}, version=${input.version}).`;
}
