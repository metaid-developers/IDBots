import type { CoworkMessage } from '@/types/cowork';
import { splitThinkTaggedContent } from '@/services/coworkAssistantText';
import {
  buildConversationTurns,
  buildDisplayItems,
  getVisibleAssistantItems,
} from '@/services/coworkConversationProjection';
import { quotaKindFromErrorText } from './quotaCodes';

export type ChatDiagnosticKind =
  | 'compaction'
  | 'compactBoundary'
  | 'permissionDenied'
  | 'rateLimit'
  | 'conversationReset'
  | 'emptyTerminal'
  | 'replyTruncated'
  | 'turnStalled'
  | 'turnInterrupted'
  | 'steerInterrupted'
  | 'routeFallback'
  | 'turnFailed';

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  text: string;
  streaming: boolean;
  diagnostic: ChatDiagnosticKind | null;
  /**
   * Weak one-line cause rendered under a `turnFailed` bubble's friendly copy:
   * the first line of the raw error (content, else metadata.error), whitespace
   * collapsed and cut to DIAGNOSTIC_REASON_MAX_CHARS. Null for every other
   * diagnostic kind — their localized copy already names the cause.
   */
  diagnosticReason: string | null;
  message: CoworkMessage;
}

/** Hard cap for the reason line so a stack or an HTML error page never floods the bubble. */
export const DIAGNOSTIC_REASON_MAX_CHARS = 120;

/**
 * Identifiers an owner can act on when the raw error has no usable first line
 * (blank line then a stack, JSON wrapper first line, …). Deliberately narrow:
 * transport errno names, auth words, and HTTP 4xx/5xx status codes.
 */
const DIAGNOSTIC_ERROR_TOKEN = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|EACCES|ENOMEM|ENOSPC|UNAUTHORIZED|FORBIDDEN|TOO_MANY_REQUESTS|INTERNAL_SERVER_ERROR|BAD_GATEWAY|SERVICE_UNAVAILABLE|GATEWAY_TIMEOUT|HTTP[ _-]?[45]\d{2}|[45]\d{2})\b/;

const FOLLOW_UP_CONTRACT_END = 'The tag routes this session between the owner\'s Follow-Up list and the autonomous fold; a missing or wrong tag costs the owner attention they did not owe.';
const FOLLOW_UP_TAG_LINE = /^\s*\[FOLLOW_UP:\s*(?:none|owner\s+—\s*[^\n]+)\]\s*$/gimu;

export function stripScheduledTaskProtocol(text: string): string {
  let visible = text;
  if (visible.includes('[Scheduled task lifecycle]') && visible.includes('[End-of-run follow-up contract]')) {
    const contractEnd = visible.indexOf(FOLLOW_UP_CONTRACT_END);
    if (contractEnd >= 0) visible = visible.slice(contractEnd + FOLLOW_UP_CONTRACT_END.length).trimStart();
  }
  return visible.replace(FOLLOW_UP_TAG_LINE, '').trimEnd();
}

function normalizeReasonLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

export function truncateDiagnosticReason(text: string): string {
  if (text.length <= DIAGNOSTIC_REASON_MAX_CHARS) return text;
  return `${text.slice(0, DIAGNOSTIC_REASON_MAX_CHARS - 1)}…`;
}

/**
 * Compact cause for a terminal `turnFailed` row. Priority: the first line of
 * the raw error (content first, then metadata.error) → a recognizable error
 * token from the full text → the first non-empty line → null. Never throws on
 * empty input; the friendly localized one-liner stays the bubble's main copy.
 */
export function extractTurnFailureReason(
  content: string | null | undefined,
  metadataError: string | null | undefined,
): string | null {
  const contentText = typeof content === 'string' && content.trim().length > 0 ? content : null;
  const metadataText = typeof metadataError === 'string' && metadataError.trim().length > 0 ? metadataError : null;
  const primary = contentText ?? metadataText;
  if (!primary) return null;
  const firstLine = normalizeReasonLine(primary.split(/\r?\n/, 1)[0] ?? '');
  if (firstLine) return truncateDiagnosticReason(firstLine);
  const combined = `${contentText ?? ''}\n${metadataText ?? ''}`;
  const token = DIAGNOSTIC_ERROR_TOKEN.exec(combined);
  if (token) return truncateDiagnosticReason(token[0]);
  const fallbackLine = combined
    .split(/\r?\n/)
    .map(normalizeReasonLine)
    .find((line) => line.length > 0);
  return fallbackLine ? truncateDiagnosticReason(fallbackLine) : null;
}

/**
 * Clipboard payload for the bubble's "copy diagnostics" affordance: timestamp,
 * session id when the surface knows one, the diagnostic kind, and the FULL raw
 * error text (not the 120-char excerpt shown in the bubble).
 */
export function formatDiagnosticCopy(view: ChatMessageView, sessionId?: string | null): string {
  const rawError = view.message.content?.trim().length
    ? view.message.content
    : (view.message.metadata?.error ?? view.message.content ?? '');
  const timestamp = typeof view.message.timestamp === 'number' && Number.isFinite(view.message.timestamp)
    ? new Date(view.message.timestamp).toISOString()
    : 'unknown';
  const lines = [
    'DSH mobile chat diagnostic',
    `time: ${timestamp}`,
  ];
  if (sessionId) lines.push(`session: ${sessionId}`);
  lines.push(`diagnostic: ${view.diagnostic ?? 'none'}`);
  lines.push('error:', rawError.trim().length > 0 ? rawError : '(empty)');
  return lines.join('\n');
}

export function chatDiagnosticKind(message: CoworkMessage): ChatDiagnosticKind | null {
  const metadata = message.metadata ?? {};
  if (metadata.sdkCompactBoundary && typeof metadata.sdkCompactBoundary === 'object') return 'compactBoundary';
  if (metadata.compaction === true && metadata.isError !== true) return 'compaction';
  if (metadata.sdkPermissionDenied && typeof metadata.sdkPermissionDenied === 'object') return 'permissionDenied';
  if (metadata.sdkRateLimit && typeof metadata.sdkRateLimit === 'object') return 'rateLimit';
  if (metadata.sdkConversationReset === true) return 'conversationReset';
  if (metadata.emptyTerminalTurn === true) return 'emptyTerminal';
  if (metadata.replyTruncatedTurn === true) return 'replyTruncated';
  if (metadata.dshTurnStalled === true) return 'turnStalled';
  if (metadata.dshTurnInterrupted === true) return 'turnInterrupted';
  if (metadata.steerInterruptAcknowledged === true) return 'steerInterrupted';
  if (metadata.dshRouteFallback) return 'routeFallback';
  return null;
}

function projectMessage(message: CoworkMessage, role: ChatMessageView['role']): ChatMessageView | null {
  const metadataDiagnostic = chatDiagnosticKind(message);
  const errorText = message.content || message.metadata?.error || '';
  // Terminal error rows that NEITHER a structured diagnostic flag NOR the
  // relay-quota fallback recognizes carry no machine-readable classification
  // at all (persisted `Error:` rows store text only). They collapse into the
  // localized turnFailed one-liner instead of surfacing raw upstream copy on
  // the phone — but the raw cause is kept as a bounded `diagnosticReason`
  // (and full text via formatDiagnosticCopy) so a repeated failure can name
  // itself instead of dead-ending on the friendly sentence. Recognized quota
  // rows keep their raw transcript record — the relay machine code stays
  // visible in the bubble, which the recharge card copy and the tests agree on.
  const diagnostic: ChatDiagnosticKind | null = metadataDiagnostic
    ?? (role === 'error' && quotaKindFromErrorText(errorText) === null ? 'turnFailed' : null);
  const rawText = diagnostic ? '' : errorText;
  const visibleText = role === 'user' || role === 'assistant' ? stripScheduledTaskProtocol(rawText) : rawText;
  const text = role === 'assistant' ? splitThinkTaggedContent(visibleText).text : visibleText;
  const diagnosticReason = diagnostic === 'turnFailed'
    ? extractTurnFailureReason(message.content, message.metadata?.error)
    : null;
  if (!diagnostic && !text.trim()) return null;
  return {
    id: message.id,
    role,
    text,
    streaming: message.metadata?.isStreaming === true,
    diagnostic,
    diagnosticReason,
    message,
  };
}

export function projectChatMessages(messages: CoworkMessage[]): ChatMessageView[] {
  const turns = buildConversationTurns(buildDisplayItems(messages));
  const views: ChatMessageView[] = [];
  for (const turn of turns) {
    if (turn.userMessage) {
      const user = projectMessage(turn.userMessage, 'user');
      if (user) views.push(user);
    }
    for (const item of getVisibleAssistantItems(turn.assistantItems, true)) {
      if (item.type !== 'assistant' && item.type !== 'system') continue;
      const message = item.message;
      const role = item.type === 'system'
        ? (message.content.startsWith('Error:') || message.metadata?.isError ? 'error' : 'system')
        : 'assistant';
      const view = projectMessage(message, role);
      if (view) views.push(view);
    }
  }
  return views;
}
