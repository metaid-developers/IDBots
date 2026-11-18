// Studio chapter-card generation (Phase 1 slice 2, owner ruling 方案 B).
//
// A chapter close condenses the chapter's owner/assistant messages into ONE
// durable card: a short title, a markdown summary, and the structured fields
// the chapter index and conversation_recall surface later (decisions,
// artifacts, open loops). The card is written ONCE at close time with an
// idle-time LLM call (owner constraint: idle-time tokens are free game,
// per-turn context is not) and never recursively re-summarized — unlike the
// kernel's compaction checkpoints, which merge on every compaction.

import type { CoworkMessage } from '../coworkStore';

/** Bounded card fields — everything beyond the caps is truncated, never dropped silently into huge context. */
export interface StudioChapterCard {
  title: string;
  summaryMarkdown: string;
  decisions: string[];
  artifacts: string[];
  openLoops: string[];
}

export const STUDIO_CHAPTER_CARD_TITLE_MAX_CHARS = 80;
export const STUDIO_CHAPTER_CARD_SUMMARY_MAX_CHARS = 1_500;
const ITEM_MAX_CHARS = 200;
const ITEMS_MAX = 10;
/** Transcript budget for the LLM call — same window the A2A episode handoff uses. */
const CHAPTER_CARD_TRANSCRIPT_MAX_CHARS = 24_000;
/** Budget for the LLM card; on expiry or malformed output the deterministic digest is used. */
export const STUDIO_CHAPTER_CARD_TIMEOUT_MS = 90_000;

export function buildStudioChapterCardSystemPrompt(): string {
  return [
    'You are closing one chapter of a long-running human-assistant conversation and writing its durable chapter card.',
    'The conversation continues in the SAME session, but its earlier history will be compacted away — this card becomes the primary memory of the chapter.',
    'Respond with ONE JSON object and nothing else, using this exact shape:',
    '{"title": string, "summary": string, "decisions": string[], "artifacts": string[], "open_loops": string[]}',
    'Rules:',
    '- title: up to 12 words, in the conversation language, naming the chapter\'s main topic (not "对话"/"conversation").',
    '- summary: plain markdown, under 200 words. Facts and outcomes only — what was asked, what was done, what was decided. No narration, no pleasantries.',
    '- decisions: every conclusion, ruling, or agreed direction the owner made or confirmed in this chapter (one short sentence each).',
    '- artifacts: files, reports, pin:// metaapp:// metafile:// or IDBots:// references, task ids — anything produced or handed over, with its location.',
    '- open_loops: promises and pending items that are NOT done — owed answers, owner approvals still waiting, agreed next steps. This field matters most: losing an open loop re-creates a deadlock after compaction.',
    '- Write values in the conversation language; keep every identifier (paths, pins, ids, numbers) verbatim.',
  ].join('\n');
}

/** Owner/assistant transcript of one chapter, newest-capped like the A2A handoff. */
export function buildStudioChapterCardUserPrompt(messages: CoworkMessage[]): string {
  const lines = messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .filter((message) => String(message.content ?? '').trim().length > 0)
    .map((message) => `${message.type === 'user' ? 'Owner' : 'Assistant'}: ${String(message.content ?? '').replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n').slice(-CHAPTER_CARD_TRANSCRIPT_MAX_CHARS);
}

function clipItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length > 0)
    .slice(0, ITEMS_MAX)
    .map((item) => (item.length > ITEM_MAX_CHARS ? `${item.slice(0, ITEM_MAX_CHARS)}…` : item));
}

/**
 * Parse the LLM card response. Accepts bare JSON or a fenced ```json block;
 * returns null for anything else (the caller then uses the deterministic
 * digest — a malformed card must never block closing a chapter).
 */
export function parseStudioChapterCardResponse(text: unknown): StudioChapterCard | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let raw = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw);
  if (fenced) raw = fenced[1]!.trim();
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const summary = String(record.summary ?? '').trim();
  const title = String(record.title ?? '').trim();
  if (!title && !summary) return null;
  return {
    title: title.slice(0, STUDIO_CHAPTER_CARD_TITLE_MAX_CHARS),
    summaryMarkdown: summary.slice(0, STUDIO_CHAPTER_CARD_SUMMARY_MAX_CHARS),
    decisions: clipItems(record.decisions),
    artifacts: clipItems(record.artifacts),
    openLoops: clipItems(record.open_loops),
  };
}

/** Deterministic digest when the LLM card fails or times out — a chapter still closes. */
export function buildStudioChapterCardFallback(messages: CoworkMessage[]): StudioChapterCard {
  const usable = messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .filter((message) => String(message.content ?? '').trim().length > 0);
  const clip = (text: string): string => {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
  };
  if (usable.length === 0) {
    return {
      title: 'Chapter',
      summaryMarkdown: '[Chapter card — fallback] The closed chapter contained no readable conversation messages.',
      decisions: [],
      artifacts: [],
      openLoops: [],
    };
  }
  const opening = usable[0]!;
  const title = clip(opening.type === 'user' ? opening.content : (usable.find((message) => message.type === 'user')?.content ?? 'Chapter'))
    .slice(0, STUDIO_CHAPTER_CARD_TITLE_MAX_CHARS);
  const tail = usable.slice(-6);
  const summary = [
    `[Chapter card — fallback, generated without LLM] ${usable.length} messages.`,
    `Opening — ${opening.type === 'user' ? 'Owner' : 'Assistant'}: ${clip(opening.content)}`,
    'Latest exchanges:',
    ...tail.map((message) => `- ${message.type === 'user' ? 'Owner' : 'Assistant'}: ${clip(message.content)}`),
  ].join('\n').slice(0, STUDIO_CHAPTER_CARD_SUMMARY_MAX_CHARS);
  return { title, summaryMarkdown: summary, decisions: [], artifacts: [], openLoops: [] };
}

/** Serialize the card for cowork_session_chapters.content_json. */
export function studioChapterCardToJson(card: StudioChapterCard): string {
  return JSON.stringify({
    decisions: card.decisions,
    artifacts: card.artifacts,
    open_loops: card.openLoops,
  });
}
