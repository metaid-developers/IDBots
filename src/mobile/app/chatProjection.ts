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
  message: CoworkMessage;
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
  // the phone. Recognized quota rows keep their raw transcript record — the
  // relay machine code stays visible in the bubble, which the recharge card
  // copy and the tests agree on.
  const diagnostic: ChatDiagnosticKind | null = metadataDiagnostic
    ?? (role === 'error' && quotaKindFromErrorText(errorText) === null ? 'turnFailed' : null);
  const rawText = diagnostic ? '' : errorText;
  const text = role === 'assistant' ? splitThinkTaggedContent(rawText).text : rawText;
  if (!diagnostic && !text.trim()) return null;
  return {
    id: message.id,
    role,
    text,
    streaming: message.metadata?.isStreaming === true,
    diagnostic,
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
