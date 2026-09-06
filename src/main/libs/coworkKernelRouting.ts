// Kernel routing for local cowork: DSH is the only kernel. The Claude Agent
// SDK local path is retired so dual-kernel fallback cannot hide DSH bugs.
//
// OpenAI-compatible, Responses, and Anthropic Messages (`apiType: 'anthropic'`)
// all go to DSH. pi-ai maps anthropic → anthropic-messages. A session that
// already ran on DSH stays on DSH (its handle is stored with the `dsh:`
// prefix in cowork_sessions.claudeSessionId).

import { truncateUtf16Units } from './llmSafeText';

export const DSH_SESSION_PREFIX = 'dsh:'

export type CoworkKernelChoice = 'dsh'

export interface KernelRoutingInput {
  /** Resolved provider apiType for this turn ('anthropic' | 'openai' | 'responses'). */
  apiType?: string | null;
  /** Stored session handle (claudeSessionId) — `dsh:` prefix pins the kernel. */
  sessionHandle?: string | null;
}

export function isDshSessionHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.startsWith(DSH_SESSION_PREFIX);
}

export function dshSessionIdOf(handle: string | null | undefined): string | null {
  return isDshSessionHandle(handle) ? handle.slice(DSH_SESSION_PREFIX.length) : null;
}

export function makeDshSessionHandle(dshSessionId: string): string {
  return DSH_SESSION_PREFIX + dshSessionId;
}

/** Map an IDBots provider apiType onto the DSH hub/runtime apiFormat. */
export function dshApiFormatOf(apiType?: string | null): 'openai' | 'responses' | 'anthropic' {
  if (apiType === 'responses') return 'responses';
  if (apiType === 'anthropic') return 'anthropic';
  return 'openai';
}

/**
 * Every local apiType is DSH-eligible. Anthropic Messages rides pi-ai's
 * anthropic-messages adapter (0.1.1-rc.2).
 */
export function isDshEligibleApiType(apiType?: string | null): boolean {
  return apiType === 'openai' || apiType === 'responses' || apiType === 'anthropic';
}

export function resolveKernelChoice(input: KernelRoutingInput): CoworkKernelChoice {
  // Stickiness first: a session that already ran on DSH keeps its kernel
  // (its handle only makes sense to the DSH runtime).
  if (isDshSessionHandle(input.sessionHandle)) return 'dsh';
  return 'dsh';
}

const HANDOFF_MAX_CHARS = 3500;
const HANDOFF_LINE_CHARS = 500;

export type SessionHistoryHandoffReason = 'legacy-handle' | 'branched-session';

const SESSION_HANDOFF_HEADERS: Record<SessionHistoryHandoffReason, string> = {
  'legacy-handle':
    '[Session handoff] This conversation started on a previous kernel. The UI still shows those messages, but this kernel does not have that transcript. Recent turns:',
  'branched-session':
    '[Session handoff] This conversation was branched from an earlier session. The UI still shows the branched messages, but this kernel starts without that transcript. Recent turns from the branched history:',
};

/**
 * Compact UI-history digest for a kernel turn that starts without the
 * transcript those messages lived in: a session whose stored handle predates
 * the unified DSH kernel (legacy-handle), or the first turn of a session
 * branched from another one (branched-session — the branch copies UI history
 * only, the parent's kernel transcript is not inherited). Without this digest
 * the UI looks like a continuation while the model starts empty.
 */
export function buildSessionHistoryHandoff(
  messages: Array<{ type?: string; content?: string }>,
  reason: SessionHistoryHandoffReason = 'legacy-handle'
): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    const text = String(message.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const role = message.type === 'user' ? 'User' : 'Assistant';
    const clipped = text.length > HANDOFF_LINE_CHARS ? `${truncateUtf16Units(text, HANDOFF_LINE_CHARS - 1)}…` : text;
    const line = `${role}: ${clipped}`;
    if (used + line.length + 1 > HANDOFF_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return [
    SESSION_HANDOFF_HEADERS[reason],
    ...lines,
    'Continue from this context. Do not claim you remember anything that is not in this handoff or the current user message.',
  ].join('\n');
}
