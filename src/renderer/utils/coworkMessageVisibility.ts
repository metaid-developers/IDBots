/**
 * Visibility rules for cowork transcript items.
 *
 * Diagnostic system messages (truncation, empty-terminal, stall) are stored
 * with empty `content` plus a metadata flag; the renderer localizes them.
 * They must remain renderable, or a turn that dies during thinking vanishes
 * from the timeline with no error and no prompt — the 2026-09-14 stall
 * (sessions e6af1710, 572751a8, 10b02949).
 */

import type { CoworkMessage, CoworkMessageMetadata } from '../types/cowork';

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const DIAGNOSTIC_METADATA_FLAGS = [
  'emptyTerminalTurn',
  'replyTruncatedTurn',
  'dshTurnStalled',
  'dshTurnInterrupted',
  'sdkConversationReset',
  'sdkRateLimit',
  'sdkPermissionDenied',
  'sdkCompactBoundary',
  'steerInterruptAcknowledged',
  'dshRouteFallback',
  // DSH compaction checkpoints store an empty body plus metadata only —
  // without this flag the localized one-line notice is filtered out before
  // its render branch can run.
  'compaction',
] as const;

/** True when metadata carries a localized system diagnostic (content may be empty). */
export function isDiagnosticSystemMetadata(metadata: CoworkMessageMetadata | undefined | null): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return DIAGNOSTIC_METADATA_FLAGS.some((flag) => Boolean(metadata[flag]));
}

/**
 * Whether an assistant or system message should appear in the cowork
 * transcript. Finalized thinking is hidden (it collapses after streaming);
 * empty diagnostic flags stay visible.
 */
export function isRenderableAssistantOrSystemMessage(message: Pick<CoworkMessage, 'content' | 'metadata'>): boolean {
  if (hasText(message.content) || hasText(message.metadata?.error)) {
    return true;
  }
  // An outbound-IM echo (im_send_message) is delivery evidence, and an
  // attachment-only send carries an intentionally EMPTY body — its bubbles are
  // the images/files. Without this branch the row would be filtered out before
  // the receipt renderer ever sees it.
  if (message.metadata?.imOutboundSend === true) {
    return true;
  }
  if (isDiagnosticSystemMetadata(message.metadata)) {
    return true;
  }
  if (message.metadata?.isThinking) {
    return Boolean(message.metadata?.isStreaming);
  }
  return false;
}
