import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { MessageExtensionContext } from './MessageExtensionContext';
import { InlineMetaAppActorContext } from './InlineMetaAppActorContext';
import type { InlineMetaAppActor } from './inlineMetaAppBridge';
import { buildLocalMetabotActorId } from '../../features/botBrowser/botBrowserIntent';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { isMobileRuntime } from '../../services/isMobileRuntime';
import type { ModelEffortValue } from '../ModelEffortPicker';
import { convertLegacyEffortLevel, LLM_EFFORT_DEFAULT_SENTINEL } from '../../services/modelCatalog';
import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkExecutionMode,
  CoworkServiceOrderSummary,
  CoworkPermissionResult,
  CoworkQuotedSelectionRole,
} from '../../types/cowork';
import type { Skill } from '../../types/skill';
import type { SettingsOpenOptions } from '../Settings';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import CoworkQuoteActionBar, {
  QUOTE_ACTION_BAR_HEIGHT,
  QUOTE_ACTION_BAR_WIDTH,
} from './CoworkQuoteActionBar';
import CoworkMessageActionsMenu from './CoworkMessageActionsMenu';
import CoworkSentQuoteBlock from './CoworkSentQuoteBlock';
import {
  buildTranscriptMessageIdsByOrdinal,
  buildTranscriptMessagePositions,
  createMessageQuotedSelection,
  createPendingQuotedSelection,
  createQuotedSelection,
  findTranscriptMessageElement,
  parseSentQuoteBlock,
  parseSentSelectionQuoteBlock,
  readQuotedJumpMessageId,
  resolveQuoteActionBarAnchorRect,
  type PendingQuotedSelection,
  type SentSelectionQuoteLabelSet,
} from './coworkQuotedSelections';
import CoworkPermissionPanel from './CoworkPermissionPanel';
import CoworkConversationSearch, { type CoworkConversationSearchHandle } from './CoworkConversationSearch';
import A2AApprovalBar from './A2AApprovalBar';
import { a2aApprovalOf } from './permissionPromptLayout';
import { buildSessionComposerCommands } from './composerCommandCatalog';
import PermissionModeSelector from './PermissionModeSelector';
import SubagentPanel from './SubagentPanel';
import TodoPanel from './TodoPanel';
import UsageStatsChip from './UsageStatsChip';
import LongTermTaskOriginChip from '../longTermTasks/LongTermTaskOriginChip';
import ManualCompactButton from './ManualCompactButton';
import A2AMessageItem from './A2AMessageItem';
import FriendBadge from './FriendBadge';
import UserMessageOriginBadge from './UserMessageOriginBadge';
import MessageFeedbackControls from './MessageFeedbackControls';
import FeedbackNudgeHint from './FeedbackNudgeHint';
import { ThinkingBlock, splitThinkTaggedContent } from './ThinkingBlock';
import { AssistantActivityIndicator } from './AssistantActivityIndicator';
import { drawTurnAckPhrase, findTailTurnAck } from './turnAckPhrases';
import { shouldHideA2AInternalMessage, lastA2AErrorDetail } from './a2aInternalMessageFilter';
import {
  getTodoListSummaryText,
  isTaskCreateToolName,
  isTaskListToolName,
  isTaskUpdateToolName,
  isTodoWriteToolName,
  parseLegacyTaskListItems,
  parseTaskCreateItem,
  parseTaskUpdatePatch,
  parseTodoWriteItems,
  type TodoListItem,
  type TodoStatus,
} from './coworkTodoList';
import MarkdownContent from '../MarkdownContent';
import { detectTradeActivity } from '../chat/tradeActivity';
import TradeActivityBadge from '../chat/TradeActivityBadge';
import MarkdownViewerPanel from './MarkdownViewerPanel';
import {
  CheckIcon,
  InformationCircleIcon,
  PuzzlePieceIcon,
  EllipsisHorizontalIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  DocumentDuplicateIcon,
  ShareIcon,
  ArchiveBoxIcon,
  ExclamationTriangleIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  StopCircleIcon,
  XMarkIcon,
  PaperAirplaneIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { FolderIcon } from '@heroicons/react/24/solid';
import { coworkService } from '../../services/cowork';
import { configService } from '../../services/config';
import { useChatExperienceMode } from '../../hooks/useChatExperienceMode';
import { projectsService } from '../../services/projects';
import { fetchMetaidInfoByGlobalId, resolveMetaidAvatarSource } from '../../services/metabotInfoService';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { getCompactFolderName } from '../../utils/path';
import { buildCompactedNoticeText, extractCompactedCounts, formatCompactTokens } from './compactedNotice';
import { isQuotaExhaustedErrorLive } from './quotaErrorBanner';
import { isRenderableAvatarSource as isSharedRenderableAvatarSource } from '../../utils/avatarSource';
import {
  hasSupportedImageExtension,
  stripHashAndQuery,
} from '../../utils/localImage';
import {
  mapSandboxGuestPathsInText,
  normalizeLocalPath,
  resolveLocalPathAgainstCwd,
  stripFileProtocol,
} from '../../utils/localPath';
import { ImagePreviewStrip, UserMessageBody } from './UserAttachmentBody';
import { scrollEventMovesAnchor, placePopoverAbove, useAnchorMoveWatcher, type PopoverPlacement } from '../../utils/anchoredPopover';
import {
  buildPrivateA2ASessionDisplayId,
  getCoworkSessionTitleClassName,
  shouldShowA2AServiceSessionId,
} from './coworkSessionPresentation.js';
import { isAssistantTurnComplete, findDeliveryAssistantIndex, shouldShowAssistantBubbleActions, splitOutboundImReceipts } from './assistantTurnPresentation.js';
import { isAssistantModeOwnerChatSession } from './assistantModeSessionGate';
import { readOutboundImReceiptBubble } from './outboundImReceiptBubble.js';
import { reuseStableTurns } from './conversationTurnReuse.js';
import TurnNavigator, { buildTurnNavigatorItems, type TurnNavigatorItem } from './TurnNavigator';
import LocalFileLink from '../ui/LocalFileLink';
import {
  buildRefundStatusDismissKey,
  getRefundCardVariant,
  shouldShowRefundStatusCard,
} from './coworkServiceOrderPresentation.js';
import {
  buildConversationTurns,
  buildDisplayItems,
  getToolResultDisplay,
  getVisibleAssistantItems,
  hasRenderableAssistantContent,
  shouldHideControlMessage,
  type AssistantTurnItem,
  type ConversationTurn,
  type ToolGroupItem,
} from '../../services/coworkConversationProjection';
import NftAvatarFrame from '../metabots/NftAvatarFrame';

export { buildConversationTurns, buildDisplayItems } from '../../services/coworkConversationProjection';
export type { ConversationTurn } from '../../services/coworkConversationProjection';

interface CoworkSessionDetailProps {
  onManageSkills?: () => void;
  onContinue: (
    prompt: string,
    skillPrompt?: string,
    quotedMessageIds?: string[],
  ) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  submitError?: string | null;
  focusedOrderTxid?: string | null;
  onFocusedOrderConsumed?: (orderTxid: string) => void;
  onNavigateHome?: () => void;
  isSidebarCollapsed?: boolean;
  onNewChat?: () => void;
  onOpenBotInBrowser?: (input: {
    globalMetaId: string;
    name?: string | null;
    avatar?: string | null;
  }) => void;
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  updateBadge?: React.ReactNode;
}

const AUTO_SCROLL_THRESHOLD = 120;
const REFUND_STATUS_DISMISS_STORAGE_KEY = 'idbots.cowork.dismissedRefundStatusCards.v1';
/** In-app markdown viewer sidebar: width fraction of the session area. */
const MARKDOWN_VIEWER_WIDTH_STORAGE_KEY = 'idbots.cowork.markdownViewerWidth';
const MARKDOWN_VIEWER_DEFAULT_FRACTION = 0.25;
const MARKDOWN_VIEWER_MAX_FRACTION = 0.5;
const MARKDOWN_VIEWER_MIN_WIDTH_PX = 280;
const MARKDOWN_FILE_RE = /\.(md|markdown)$/i;
// .html/.htm reports open in the same sidebar as a sandboxed iframe preview.
const HTML_FILE_RE = /\.html?$/i;

const clampMarkdownViewerWidth = (width: number, containerWidth: number): number => {
  const maxWidth = Math.max(MARKDOWN_VIEWER_MIN_WIDTH_PX, containerWidth * MARKDOWN_VIEWER_MAX_FRACTION);
  return Math.min(Math.max(width, MARKDOWN_VIEWER_MIN_WIDTH_PX), maxWidth);
};

const loadPersistedMarkdownViewerFraction = (): number => {
  try {
    const raw = window.localStorage.getItem(MARKDOWN_VIEWER_WIDTH_STORAGE_KEY);
    if (!raw) return MARKDOWN_VIEWER_DEFAULT_FRACTION;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return MARKDOWN_VIEWER_DEFAULT_FRACTION;
    return Math.min(parsed, MARKDOWN_VIEWER_MAX_FRACTION);
  } catch {
    return MARKDOWN_VIEWER_DEFAULT_FRACTION;
  }
};
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const ORDER_TAG_TXID_RE = /^\[(?:ORDER_STATUS|DELIVERY|NeedsRating):([0-9a-f]{64})(?:\s+[^\]]*)?\]/i;
const ORDER_END_TAG_TXID_RE = /^\[ORDER_END:([0-9a-f]{64})(?:\s+[^\]]*)?\]/i;
const ORDER_START_CONTENT_RE = /^\[ORDER\]/i;
const ORDER_END_CONTENT_RE = /^\[ORDER_END(?::[0-9a-fA-F]{64})?(?:\s+[A-Za-z0-9_-]+)?\]/i;
const STEER_STATUS_TRANSLATION_KEYS: Record<string, string> = {
  queued: 'coworkSteerStatusQueued',
  delivered: 'coworkSteerStatusDelivered',
  settled: 'coworkSteerStatusSettled',
  failed: 'coworkSteerStatusFailed',
  cancelled: 'coworkSteerStatusCancelled',
};

// The quote-jump highlight: the app's own gold accent as a brief ring around
// the one message that was jumped to — never a background recolour of the
// transcript.
//
// The ring deliberately uses the SOLID accent token: the `/40` opacity
// modifier does not compile for var()-based claude tokens in this Tailwind
// build (no <alpha-value> placeholder, so the utility is silently dropped and
// the ring falls back to Tailwind's default blue). `ring-claude-accent` is the
// only form that renders the intended colour; same token, no new colour or
// variable.
// Exported (owner ruling 2026-11-11, chat-window four-item fix ③): the Bot
// Internet panel's locator jump lights the SAME ring via the SAME helper —
// reuse, not a parallel mechanism.
export const QUOTE_JUMP_HIGHLIGHT_CLASSES = ['ring-1', 'ring-claude-accent'];

// Rail-jump landing cue. Same ring as the quote jump (that cue is right — it is
// what marks "the message you were sent to"), but the ring target is the message
// bubble, not the turn wrapper, so it never draws a rule across the transcript.
const TURN_NAVIGATOR_HIGHLIGHT_MS = 2500;

// How long the quote-jump ring stays lit. Same 2.5s window as the rail jump:
// both are "you were taken here" cues, so they age out together. Exported for
// the panel locator jump (fix ③), which must age out identically.
export const QUOTE_JUMP_HIGHLIGHT_MS = 2500;

/**
 * Paint a transient accent ring on `element`, clearing whatever the previous
 * jump lit first. Shared by the turn-rail jump and the quote jump so both
 * follow one contract:
 *
 * - Clear EVERY ring in `container`, not just the one the previous timer was
 *   going to un-ring. Clearing only the timer orphans the element it was
 *   going to un-ring, so rapid jumps stacked rings and the earlier ones
 *   stayed lit for good (verified live: three jumps in a row left two rings
 *   still on).
 * - Clear the pending timer, then light the new ring: remove-then-add is what
 *   restarts the full window on a repeated jump to the same element.
 * - `ms` later, un-ring and drop the timer. The caller owns the timer ref and
 *   its unmount cleanup.
 *
 * The ring is a static style, so no reflow trick is needed to make it visible.
 */
// Exported (fix ③): the panel locator jump shares this exact helper so every
// "you were taken here" ring on either surface follows one contract.
export const transientHighlight = (
  timerRef: { current: number | null },
  container: HTMLElement,
  element: HTMLElement,
  ms: number,
): void => {
  container
    .querySelectorAll<HTMLElement>(`.${QUOTE_JUMP_HIGHLIGHT_CLASSES[1]}`)
    .forEach((lit) => lit.classList.remove(...QUOTE_JUMP_HIGHLIGHT_CLASSES));
  if (timerRef.current != null) {
    window.clearTimeout(timerRef.current);
  }
  element.classList.add(...QUOTE_JUMP_HIGHLIGHT_CLASSES);
  timerRef.current = window.setTimeout(() => {
    element.classList.remove(...QUOTE_JUMP_HIGHLIGHT_CLASSES);
    timerRef.current = null;
  }, ms);
};

// The label sets the sent-selection-block parser matches against: every
// shipped dictionary, so a quote block written under one language still gets
// its clean display after the app language is switched (the transcript renders
// a sent block in the language it was written in).
const SENT_QUOTE_LABEL_LANGUAGES = ['zh', 'en'] as const;

export const buildSentSelectionQuoteLabelSets = (botName?: string | null): SentSelectionQuoteLabelSet[] => {
  const name = (botName ?? '').trim();
  const fill = (language: (typeof SENT_QUOTE_LABEL_LANGUAGES)[number], key: string): string => {
    const template = i18nService.tIn(language, key);
    return name
      ? template.replace('{name}', name)
      : template.replace('{name}', i18nService.tIn(language, 'coworkQuoteSentReplySourceAssistantFallback'));
  };
  return SENT_QUOTE_LABEL_LANGUAGES.map((language) => ({
    header: i18nService.tIn(language, 'coworkQuoteBlockHeader'),
    item: i18nService.tIn(language, 'coworkQuoteBlockItem'),
    sourceLabel: {
      user: i18nService.tIn(language, 'coworkQuoteSourceUser'),
      assistant: i18nService.tIn(language, 'coworkQuoteSourceAssistant'),
      other: i18nService.tIn(language, 'coworkQuoteSourceOther'),
    },
    displayLabel: {
      user: i18nService.tIn(language, 'coworkQuoteSentSourceUser'),
      assistant: fill(language, 'coworkQuoteSentSourceAssistant'),
      other: fill(language, 'coworkQuoteSentSourceOther'),
    },
  }));
};

/**
 * The speaker names a whole-message reply shows in the transcript, WeChat-style
 * (`你：` / `<bot 名>：`): the assistant speaks in the session bot's own name,
 * the owner is "你". `{name}` in the labels is filled with `botName`. The
 * prompt body keeps the generated `#<ordinal> <side>：` label; see
 * parseSentQuoteBlock.
 */
export const buildSentQuoteDisplaySources = (
  botName?: string | null,
): Record<CoworkQuotedSelectionRole, string> => {
  const name = (botName ?? '').trim();
  const fill = (template: string): string => (
    name ? template.replace('{name}', name) : template.replace('{name}', i18nService.t('coworkQuoteSentReplySourceAssistantFallback'))
  );
  return {
    user: i18nService.t('coworkQuoteSentReplySourceUser'),
    assistant: fill(i18nService.t('coworkQuoteSentReplySourceAssistant')),
    other: fill(i18nService.t('coworkQuoteSentReplySourceOther')),
  };
};

const readDismissedRefundStatusKeys = (): Set<string> => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REFUND_STATUS_DISMISS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
  } catch {
    return new Set();
  }
};

const persistDismissedRefundStatusKeys = (keys: Set<string>): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(REFUND_STATUS_DISMISS_STORAGE_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    // Ignore storage failures; dismissal can still apply for the current renderer state.
  }
};

const sanitizeExportFileName = (value: string): string => {
  const sanitized = value.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'cowork-session';
};

const formatExportTimestamp = (value: Date): string => {
  const pad = (num: number): string => String(num).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
};

type CaptureRect = { x: number; y: number; width: number; height: number };

const MAX_EXPORT_CANVAS_HEIGHT = 32760;
const MAX_EXPORT_SEGMENTS = 240;

const waitForNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

const loadImageFromBase64 = (pngBase64: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured image'));
    img.src = `data:image/png;base64,${pngBase64}`;
  });

const domRectToCaptureRect = (rect: DOMRect): CaptureRect => ({
  x: Math.max(0, Math.round(rect.x)),
  y: Math.max(0, Math.round(rect.y)),
  width: Math.max(0, Math.round(rect.width)),
  height: Math.max(0, Math.round(rect.height)),
});

// PushPinIcon component for pin/unpin functionality
const PushPinIcon: React.FC<React.SVGProps<SVGSVGElement> & { slashed?: boolean }> = ({
  slashed,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="rotate(45 12 12)">
      <path d="M9 3h6l-1 5 2 2v2H8v-2l2-2-1-5z" />
      <path d="M12 12v9" />
    </g>
    {slashed && <path d="M5 5L19 19" />}
  </svg>
);

const formatUnknown = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getStringArray = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const lines = value.filter((item) => typeof item === 'string') as string[];
  return lines.length > 0 ? lines.join('\n') : null;
};

const ORDER_PREFIX = '[ORDER]';
const DELIVERY_PREFIX = '[DELIVERY]';
const NON_TEXT_SERVICE_OUTPUT_TYPES = ['image', 'video', 'audio', 'other'];

type GigSquareOrderPayload = {
  txid?: string;
  serviceName?: string;
  prompt?: string;
};

type GigSquareDeliveryPayload = {
  serviceName?: string;
  result?: string;
};

const parseGigSquarePayload = (content: string, prefix: string): Record<string, unknown> | null => {
  const trimmed = content.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const jsonPart = trimmed.slice(prefix.length).trim();
  if (!jsonPart) return null;
  try {
    const parsed = JSON.parse(jsonPart);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const formatShortHash = (value: string): string => {
  if (!value) return '';
  if (value.length <= 20) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
};

/**
 * Nearest transcript block around a selected node. Message turns already carry
 * `data-export-role` ('user-message' / 'assistant-block'), so the quote can
 * name its own source and hang its action bar off a real, moving element —
 * without injecting any marker node into the transcript.
 */
const quoteTranscriptBlockOf = (node: Node | null | undefined): HTMLElement | null => {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement;
  return element?.closest('[data-export-role]') ?? null;
};

const formatMessageTimestamp = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
};

const formatWorkedDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0s';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const isRenderableAvatarSource = (value: string | null | undefined): boolean =>
  isSharedRenderableAvatarSource(value);

const getRefundFailureReasonLabel = (failureReason?: string | null): string | null => {
  if (failureReason === 'first_response_timeout') {
    return i18nService.t('coworkRefundReasonFirstResponseTimeout');
  }
  if (failureReason === 'delivery_timeout') {
    return i18nService.t('coworkRefundReasonDeliveryTimeout');
  }
  return null;
};

const RefundStatusCard: React.FC<{
  summary: CoworkServiceOrderSummary;
  onProcessRefund?: () => void;
  isProcessingRefund?: boolean;
  refundActionError?: string | null;
  onDismiss?: () => void;
}> = ({
  summary,
  onProcessRefund,
  isProcessingRefund = false,
  refundActionError = null,
  onDismiss,
}) => {
  const handleCopyValue = useCallback((value: string) => {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }
    void navigator.clipboard.writeText(value).catch(() => {});
  }, []);
  const variant = getRefundCardVariant(summary);
  if (!variant) return null;

  const isSuccess = variant === 'refunded';
  const canProcessRefund = variant === 'seller-action' && Boolean(onProcessRefund);
  const title = isSuccess
    ? i18nService.t('coworkRefundCardRefundedTitle')
    : variant === 'seller-action'
      ? i18nService.t('coworkRefundCardSellerPendingTitle')
      : i18nService.t('coworkRefundCardBuyerPendingTitle');
  const body = isSuccess
    ? i18nService.t('coworkRefundCardRefundedBody')
    : variant === 'seller-action'
      ? i18nService.t('coworkRefundCardSellerPendingBody')
      : i18nService.t('coworkRefundCardBuyerPendingBody');
  const failureReasonLabel = getRefundFailureReasonLabel(summary.failureReason);
  const Icon = isSuccess ? CheckIcon : ExclamationTriangleIcon;

  return (
    <div className="px-4 pb-3 shrink-0">
      <div
        className={`max-w-[clamp(680px,64%,920px)] mx-auto rounded-2xl border px-4 py-3 ${
          isSuccess
            ? 'border-emerald-500/30 bg-emerald-500/10'
            : 'border-orange-500/30 bg-orange-500/10'
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 rounded-full p-1.5 ${
              isSuccess ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
            }`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {title}
            </div>
            <div className="mt-1 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {body}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {failureReasonLabel && (
                <span>
                  {i18nService.t('coworkRefundCardFailureReason')}: {failureReasonLabel}
                </span>
              )}
              {summary.refundRequestPinId && (
                <span className="inline-flex items-center gap-1">
                  {i18nService.t('coworkRefundCardRequestPin')}: {formatShortHash(summary.refundRequestPinId)}
                  <button
                    type="button"
                    onClick={() => handleCopyValue(summary.refundRequestPinId!)}
                    className="inline-flex h-4 w-4 items-center justify-center rounded text-current hover:bg-black/10 dark:hover:bg-white/10"
                    title={i18nService.t('copyToClipboard')}
                    aria-label={i18nService.t('copyToClipboard')}
                  >
                    <DocumentDuplicateIcon className="h-3 w-3" />
                  </button>
                </span>
              )}
              {summary.refundTxid && (
                <span className="inline-flex items-center gap-1">
                  {i18nService.t('coworkRefundCardRefundTx')}: {formatShortHash(summary.refundTxid)}
                  <button
                    type="button"
                    onClick={() => handleCopyValue(summary.refundTxid!)}
                    className="inline-flex h-4 w-4 items-center justify-center rounded text-current hover:bg-black/10 dark:hover:bg-white/10"
                    title={i18nService.t('copyToClipboard')}
                    aria-label={i18nService.t('copyToClipboard')}
                  >
                    <DocumentDuplicateIcon className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>
            {canProcessRefund && (
              <div className="mt-3 flex flex-col items-start gap-2">
                <button
                  type="button"
                  onClick={onProcessRefund}
                  disabled={isProcessingRefund}
                  className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isProcessingRefund
                    ? i18nService.t('coworkRefundCardProcessingAction')
                    : i18nService.t('coworkRefundCardProcessAction')}
                </button>
                {refundActionError && (
                  <div className="text-[11px] text-red-600 dark:text-red-400">
                    {refundActionError}
                  </div>
                )}
              </div>
            )}
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-black/10 hover:text-claude-text dark:hover:bg-white/10 dark:hover:text-claude-darkText"
              title={i18nService.t('close')}
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};


const getTodoLabels = () => ({
  items: i18nService.t('coworkTodoItems'),
  completed: i18nService.t('coworkTodoCompleted'),
  inProgress: i18nService.t('coworkTodoInProgress'),
  pending: i18nService.t('coworkTodoPending'),
});

const getToolInputSummary = (
  toolName: string | undefined,
  toolInput?: Record<string, unknown>
): string | null => {
  if (!toolName || !toolInput) return null;
  const input = toolInput as Record<string, unknown>;
  if (isTodoWriteToolName(toolName)) {
    const items = parseTodoWriteItems(input);
    return items ? getTodoListSummaryText(items, getTodoLabels()) : null;
  }

  if (isTaskCreateToolName(toolName)) {
    const item = parseTaskCreateItem(input);
    return item ? item.primaryText : null;
  }

  if (isTaskUpdateToolName(toolName)) {
    const patch = parseTaskUpdatePatch(input);
    return patch ? (patch.primaryText ?? patch.id) : null;
  }

  if (isTaskListToolName(toolName)) {
    const items = parseLegacyTaskListItems(input);
    return items ? getTodoListSummaryText(items, getTodoLabels()) : null;
  }

  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string'
        ? input.command
        : getStringArray(input.commands);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return typeof input.file_path === 'string' ? input.file_path : null;
    case 'Glob':
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : null;
    case 'Task':
      return typeof input.description === 'string' ? input.description : null;
    case 'WebFetch':
      return typeof input.url === 'string' ? input.url : null;
    default:
      return null;
  }
};

const formatToolInput = (
  toolName: string | undefined,
  toolInput?: Record<string, unknown>
): string | null => {
  if (!toolInput) return null;
  const summary = getToolInputSummary(toolName, toolInput);
  if (summary && summary.trim()) {
    return summary;
  }
  return formatUnknown(toolInput);
};

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const IMAGE_LINK_DESTINATION_PATTERN = /\[[^\]]*]\(([^)\r\n]+)\)/g;
const IMAGE_CANDIDATE_PATTERN = /(?:^|[\s"'`([{<:：])((?:file:\/\/[^\s"'`)\]}>]+|[A-Za-z]:\\[^\s"'`<>|]+|\/[^\s"'`<>|]+|\.{1,2}[\\/][^\s"'`<>|]+|[^\s"'`<>|]+)\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s"'`)\]}>，。,；;:：!?])/gi;

const trimImageCandidateToken = (value: string): string => {
  let token = value.trim();
  if (!token) return token;

  if (token.startsWith('<') && token.endsWith('>')) {
    token = token.slice(1, -1);
  }

  token = token.replace(/^[\s"'`([{<]+/, '');
  token = token.replace(/[\s"'`)\]}>，。,；;:：!?]+$/, '');
  return token.trim();
};

const isLocalImagePathCandidate = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!hasSupportedImageExtension(trimmed)) return false;

  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return true;
  return scheme[1].toLowerCase() === 'file';
};

const normalizeImageCandidatePath = (value: string): string | null => {
  const trimmed = trimImageCandidateToken(value);
  if (!trimmed) return null;
  if (!isLocalImagePathCandidate(trimmed)) return null;
  return trimmed;
};

const extractImagePaths = (
  value: string,
  resolveLocalFilePath?: (href: string, text: string) => string | null
): string[] => {
  if (!value) return [];

  const candidates: string[] = [];
  const pushCandidate = (candidate: string) => {
    const normalized = normalizeImageCandidatePath(candidate);
    if (normalized) {
      candidates.push(normalized);
    }
  };

  IMAGE_LINK_DESTINATION_PATTERN.lastIndex = 0;
  let linkMatch: RegExpExecArray | null = null;
  while ((linkMatch = IMAGE_LINK_DESTINATION_PATTERN.exec(value)) !== null) {
    if (typeof linkMatch[1] === 'string') {
      pushCandidate(linkMatch[1]);
    }
  }

  IMAGE_CANDIDATE_PATTERN.lastIndex = 0;
  let pathMatch: RegExpExecArray | null = null;
  while ((pathMatch = IMAGE_CANDIDATE_PATTERN.exec(value)) !== null) {
    if (typeof pathMatch[1] === 'string') {
      pushCandidate(pathMatch[1]);
    }
  }

  const dedupedPaths: string[] = [];
  const seenPaths = new Set<string>();

  for (const candidate of candidates) {
    const resolvedPath = resolveLocalFilePath
      ? resolveLocalFilePath(candidate, candidate)
      : null;
    const normalizedCandidatePath = normalizeLocalPath(candidate);
    const fallbackPath = normalizedCandidatePath?.isAbsolute ? normalizedCandidatePath.path : null;
    const absolutePath = (resolvedPath ?? fallbackPath)?.trim();
    if (!absolutePath) continue;

    const normalizedPath = stripFileProtocol(stripHashAndQuery(absolutePath));
    if (!normalizedPath || !hasSupportedImageExtension(normalizedPath)) {
      continue;
    }
    if (seenPaths.has(normalizedPath)) continue;

    seenPaths.add(normalizedPath);
    dedupedPaths.push(normalizedPath);
  }

  return dedupedPaths;
};

export const normalizeOrderFocusTxid = (value: unknown): string | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

export const resolveMessageOrderTxid = (message: Pick<CoworkMessage, 'content' | 'metadata'>): string | null => {
  const metadataTxid = normalizeOrderFocusTxid(message.metadata?.orderTxid);
  if (metadataTxid) return metadataTxid;
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  return normalizeOrderFocusTxid(
    content.match(ORDER_TAG_TXID_RE)?.[1]
      || content.match(ORDER_END_TAG_TXID_RE)?.[1]
      || null
  );
};

export const findFocusedOrderMessageId = (
  messages: Pick<CoworkMessage, 'id' | 'content' | 'metadata'>[],
  focusedOrderTxid?: string | null,
): string | null => {
  const normalizedFocus = normalizeOrderFocusTxid(focusedOrderTxid);
  if (!normalizedFocus) return null;
  const match = messages.find((message) => resolveMessageOrderTxid(message) === normalizedFocus);
  return match?.id ?? null;
};

export const buildOrderFocusRequestKey = (
  sessionId: unknown,
  focusedOrderTxid?: string | null,
): string | null => {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const normalizedFocus = normalizeOrderFocusTxid(focusedOrderTxid);
  return normalizedSessionId && normalizedFocus ? `${normalizedSessionId}:${normalizedFocus}` : null;
};

export const shouldRunOrderFocusRequest = (
  lastConsumedFocusKey: string | null,
  sessionId: unknown,
  focusedOrderTxid?: string | null,
): boolean => {
  const focusKey = buildOrderFocusRequestKey(sessionId, focusedOrderTxid);
  return Boolean(focusKey && focusKey !== lastConsumedFocusKey);
};

export const resolveAutoScrollBehavior = (
  previousSessionId: string | null,
  currentSessionId: string | null,
  options?: { streaming?: boolean },
): ScrollBehavior => {
  // Streaming follow must be instant. Overlapping `behavior: 'smooth'`
  // animations (and the scroll events they emit) fight layout growth from
  // the next chunk — the whole transcript appears to jitter. Session switch
  // already jumps; only discrete same-session arrivals stay smooth.
  if (options?.streaming) return 'auto';
  return previousSessionId && currentSessionId && previousSessionId === currentSessionId
    ? 'smooth'
    : 'auto';
};

export const pinScrollToBottom = (element: HTMLElement | null): void => {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
};

/**
 * Whether a follow-effect run is the arrival of the reply a pending quote
 * reply is waiting for.
 *
 * The one-shot flag is set at send time, when the submission carries a quote
 * block: the owner may be parked at the quoted message on purpose (the
 * confirmation window), so the follow gate (`shouldAutoScroll`) stays closed
 * and the "back to bottom" button stays available while the turn runs — but
 * the reply must still pull the view down once it arrives. "Arrival" is the
 * transcript's tail turning into an assistant message: the user-message echo
 * that lands right after the send must not consume the flag, or the view
 * would leave the quoted message the moment the send goes through.
 */
export const shouldFollowPendingQuoteReply = (
  messages: Array<{ type?: string }> | undefined,
  pendingQuoteReplyFollow: boolean,
): boolean => {
  if (!pendingQuoteReplyFollow) return false;
  const last = messages?.[messages.length - 1];
  return last?.type === 'assistant';
};

export const buildAutoScrollFollowSignal = (
  messages: Array<{ id: string; content: string; metadata?: { isStreaming?: boolean } }> | undefined,
  isStreaming: boolean,
): string => {
  if (!messages?.length) return '';
  if (!isStreaming) {
    const last = messages[messages.length - 1];
    return `${last.id}:${last.content}`;
  }
  const live = messages.filter((message) => message.metadata?.isStreaming);
  const source = live.length > 0 ? live : messages.slice(-1);
  return source.map((message) => `${message.id}:${message.content.length}`).join('|');
};

const getToolResultLineCount = (result: string): number => {
  if (!result) return 0;
  return result.split('\n').length;
};

const TodoWriteInputView: React.FC<{ items: TodoListItem[] }> = ({ items }) => {
  const getStatusCheckboxClass = (status: TodoStatus): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 border-green-500 text-green-500';
      case 'in_progress':
        return 'bg-transparent border-blue-500';
      case 'pending':
      case 'unknown':
      default:
        return 'bg-transparent dark:border-claude-darkTextSecondary/60 border-claude-textSecondary/60';
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.key}
          className="flex items-start gap-2"
        >
          <span className={`mt-0.5 h-4 w-4 rounded-[4px] border flex-shrink-0 inline-flex items-center justify-center ${getStatusCheckboxClass(item.status)}`}>
            {item.status === 'completed' && <CheckIcon className="h-3 w-3 stroke-[2.5]" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-xs whitespace-pre-wrap break-words leading-5 ${
              item.status === 'completed'
                ? 'dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/80'
                : 'dark:text-claude-darkText text-claude-text'
            }`}>
              {item.primaryText}
            </div>
            {item.secondaryText && (
              <div className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 whitespace-pre-wrap break-words leading-5 mt-0.5">
                {item.secondaryText}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * One delivered `im_send_message` (a proactive send), drawn the way the owner
 * reads a chat: the sent body VERBATIM in a normal outgoing bubble, then one
 * entry per attachment — an image thumbnail for pictures, a file entry for
 * everything else. No direction/channel/time header, no target line, no
 * 摘要/结果 fields, no 200-char cut: those live in the row's metadata now.
 *
 * Failures never reach this component — their audited card (reason visible) is
 * the message.
 */
const OutboundImReceiptMessage: React.FC<{
  view: {
    body: string;
    attachments: Array<{ path: string; name: string; kind: string }>;
    fallbackNote: string | null;
  };
  onOpenLocalFile?: (filePath: string, event: React.MouseEvent) => boolean | void;
}> = ({ view, onOpenLocalFile }) => {
  const openFile = async (filePath: string, event: React.MouseEvent) => {
    if (onOpenLocalFile?.(filePath, event) === true) {
      return;
    }
    try {
      await window.electron.shell.openPath(filePath);
    } catch (error) {
      console.error('Failed to open the sent attachment:', filePath, error);
    }
  };

  return (
    <div className="space-y-1 py-1">
      {view.body ? (
        <div className="w-fit max-w-[min(720px,82%)]">
          <div
            className="assistant-bubble rounded-[22px] px-[16px] py-[10px] dark:text-claude-darkText text-claude-text shadow-subtle"
          >
            {/* Same markdown pipeline as every other bubble; whitespace-pre-wrap
                keeps the sent line breaks exactly as they went out. */}
            <MarkdownContent
              content={view.body}
              emojiImages
              className="prose dark:prose-invert max-w-none whitespace-pre-wrap [overflow-wrap:anywhere]"
              onOpenLocalFile={onOpenLocalFile}
              chatExperienceMode="assistant"
            />
          </div>
        </div>
      ) : null}
      {view.attachments.map((attachment) => (
        <div key={attachment.path} className="w-fit max-w-[min(720px,82%)]">
          {attachment.kind === 'image' ? (
            // Existing image-message display: the thumbnail strip, one picture.
            <ImagePreviewStrip imagePaths={[attachment.path]} inline />
          ) : (
            // Existing file display: a file entry (name + type icon + open menu).
            <div className="assistant-bubble rounded-[22px] px-[16px] py-[10px] text-sm dark:text-claude-darkText text-claude-text">
              <LocalFileLink
                filePath={attachment.path}
                title={attachment.path}
                className="inline-flex items-center gap-1 text-claude-accent hover:text-claude-accentHover underline decoration-claude-accent/50 hover:decoration-claude-accent"
                onOpen={(_path, event) => openFile(attachment.path, event)}
              >
                {attachment.name}
              </LocalFileLink>
            </div>
          )}
        </div>
      ))}
      {view.fallbackNote ? (
        <div className="w-fit max-w-[min(720px,82%)]">
          <div className="assistant-bubble rounded-[22px] px-[16px] py-[10px] text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {view.fallbackNote}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const ToolCallGroup: React.FC<{
  group: ToolGroupItem;
  isLastInSequence?: boolean;
  mapDisplayText?: (value: string) => string;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  showImagePreviews?: boolean;
}> = ({
  group,
  isLastInSequence = true,
  mapDisplayText,
  resolveLocalFilePath,
  showImagePreviews = true,
}) => {
  const { toolUse, toolResult } = group;
  const toolName = typeof toolUse.metadata?.toolName === 'string' ? toolUse.metadata.toolName : 'Tool';
  const toolInput = toolUse.metadata?.toolInput;
  const isTodoWriteTool = isTodoWriteToolName(toolName);
  const todoItems = isTodoWriteTool ? parseTodoWriteItems(toolInput) : null;
  const isTaskCreateTool = isTaskCreateToolName(toolName);
  const taskCreateItem = isTaskCreateTool ? parseTaskCreateItem(toolInput) : null;
  const isTaskUpdateTool = isTaskUpdateToolName(toolName);
  const taskUpdatePatch = isTaskUpdateTool ? parseTaskUpdatePatch(toolInput) : null;
  const taskUpdateItem: TodoListItem | null = taskUpdatePatch ? {
    key: `update-${taskUpdatePatch.id}`,
    id: taskUpdatePatch.id,
    toolUseId: null,
    primaryText: taskUpdatePatch.primaryText ?? taskUpdatePatch.id ?? '',
    secondaryText: taskUpdatePatch.secondaryText ?? null,
    status: taskUpdatePatch.status ?? 'unknown',
    owner: taskUpdatePatch.owner ?? null,
    source: 'taskupdate',
  } : null;
  const isLegacyTaskListTool = isTaskListToolName(toolName) && !isTaskCreateTool && !isTaskUpdateTool;
  const taskItems = isLegacyTaskListTool ? parseLegacyTaskListItems(toolInput) : null;
  const mapText = mapDisplayText ?? ((value: string) => value);
  const toolInputDisplayRaw = formatToolInput(toolName, toolInput);
  const toolInputDisplay = toolInputDisplayRaw ? mapText(toolInputDisplayRaw) : null;
  const toolInputSummaryRaw = getToolInputSummary(toolName, toolInput) ?? toolInputDisplayRaw;
  const toolInputSummary = toolInputSummaryRaw ? mapText(toolInputSummaryRaw) : null;
  const toolResultDisplayRaw = toolResult ? getToolResultDisplay(toolResult) : '';
  const toolResultDisplay = mapText(toolResultDisplayRaw);
  const isToolError = Boolean(toolResult?.metadata?.isError || toolResult?.metadata?.error);
  const [isExpanded, setIsExpanded] = useState(false);
  const resultLineCount = getToolResultLineCount(toolResultDisplay);
  const imagePreviewPaths = useMemo(() => {
    if (!showImagePreviews || !toolResultDisplay) {
      return [];
    }
    return extractImagePaths(toolResultDisplay, resolveLocalFilePath);
  }, [resolveLocalFilePath, showImagePreviews, toolResultDisplay]);

  // Check if this is a Bash-like tool that should show terminal style
  const isBashTool = toolName === 'Bash';

  return (
    <div className="relative py-1">
      {/* Vertical connecting line to next tool group */}
      {!isLastInSequence && (
        <div className="absolute left-[3.5px] top-[14px] bottom-[-8px] w-px dark:bg-claude-darkTextSecondary/30 bg-claude-textSecondary/30" />
      )}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-start gap-2 text-left group relative z-10"
      >
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
          !toolResult
            ? 'bg-blue-500 animate-pulse'
            : isToolError
              ? 'bg-red-500'
              : 'bg-green-500'
        }`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {toolName}
            </span>
            {toolInputSummary && (
              <code className="text-xs dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 font-mono truncate max-w-[400px]">
                {toolInputSummary}
              </code>
            )}
          </div>
          {toolResult && resultLineCount > 0 && !isTodoWriteTool && !isTaskCreateTool && !isTaskUpdateTool && !isLegacyTaskListTool && (
            <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-0.5">
              {resultLineCount} {resultLineCount === 1 ? 'line' : 'lines'} of output
            </div>
          )}
          {!toolResult && (
            <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-0.5">
              {i18nService.t('coworkToolRunning')}
            </div>
          )}
        </div>
      </button>
      {isExpanded && (
        <div className="ml-4 mt-2">
          {isBashTool ? (
            // Terminal-style display for Bash commands
            <div className="rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border">
              {/* Terminal header */}
              <div className="flex items-center gap-1.5 px-3 py-1.5 dark:bg-claude-darkSurface bg-claude-surfaceInset">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                <span className="ml-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium">Terminal</span>
              </div>
              {/* Terminal content */}
              <div className="dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-3 py-3 max-h-72 overflow-y-auto font-mono text-xs">
                {toolInputDisplay && (
                  <div className="dark:text-claude-darkText text-claude-text">
                    <span className="text-claude-accent select-none">$ </span>
                    <span className="whitespace-pre-wrap break-words">{toolInputDisplay}</span>
                  </div>
                )}
                {toolResult && toolResultDisplay && (
                  <div className={`mt-1.5 whitespace-pre-wrap break-words ${
                    isToolError ? 'text-red-400' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
                  }`}>
                    {toolResultDisplay}
                  </div>
                )}
                {!toolResult && (
                  <div className="dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-1.5 italic">
                    {i18nService.t('coworkToolRunning')}
                  </div>
                )}
              </div>
            </div>
          ) : isTodoWriteTool && todoItems ? (
            <TodoWriteInputView items={todoItems} />
          ) : isTaskCreateTool && taskCreateItem ? (
            <TodoWriteInputView items={[taskCreateItem]} />
          ) : isTaskUpdateTool && taskUpdateItem ? (
            <TodoWriteInputView items={[taskUpdateItem]} />
          ) : isLegacyTaskListTool && taskItems ? (
            <TodoWriteInputView items={taskItems} />
          ) : (
            // Standard display for other tools with input/output labels
            <div className="space-y-2">
              {toolInputDisplay && (
                <div>
                  <div className="text-[10px] font-medium dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolInput')}
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    <pre className="text-xs dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words font-mono">
                      {toolInputDisplay}
                    </pre>
                  </div>
                </div>
              )}
              {toolResult && (
                <div>
                  <div className="text-[10px] font-medium dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolResult')}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <pre className={`text-xs whitespace-pre-wrap break-words font-mono ${
                      isToolError ? 'text-red-500' : 'dark:text-claude-darkText text-claude-text'
                    }`}>
                      {toolResultDisplay}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {imagePreviewPaths.length > 0 && (
        <ImagePreviewStrip imagePaths={imagePreviewPaths} />
      )}
    </div>
  );
};


// Copy button component: the user bubble's hover row (below the bubble) —
// copies the message text and flips to a green check for two seconds. This is
// the pre-actions-menu affordance the owner asked back (2026-10-28): the
// "⋯" menu keeps copy too, the two coexist. The direct copy needs no menu
// round-trip, which is what the user side had before the 2026-10-19 hover
// redesign folded it away.
const CopyButton: React.FC<{
  content: string;
  visible: boolean;
}> = ({ content, visible }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-1.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      title={i18nService.t('copyToClipboard')}
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 text-green-500"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary"
          aria-hidden="true"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
        </svg>
      )}
    </button>
  );
};

// Message timestamp on the turn-end line, sharing the hover-visibility
// logic and visual style of the action row it sits in.
// hover-visibility logic and visual style.
const MessageTimestamp: React.FC<{
  timestamp: number;
  visible: boolean;
}> = ({ timestamp, visible }) => {
  const label = formatMessageTimestamp(timestamp);
  if (!label) return null;
  return (
    <span
      className={`text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary select-none whitespace-nowrap transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      aria-hidden="true"
    >
      {label}
    </span>
  );
};

const GigSquareOrderCard: React.FC<{ payload: GigSquareOrderPayload }> = ({ payload }) => {
  const txid = typeof payload.txid === 'string' ? payload.txid : '';
  const serviceName = typeof payload.serviceName === 'string' ? payload.serviceName : '';
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';

  return (
    <div className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted px-4 py-3 shadow-subtle">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-claude-accent">
          {i18nService.t('gigSquareOrderTitle')}
        </div>
        <span className="text-[10px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
          ORDER
        </span>
      </div>
      <div className="mt-2 space-y-2">
        <div className="flex items-center justify-between text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
          <span>{i18nService.t('gigSquareOrderService')}</span>
          <span className="font-medium text-claude-text dark:text-claude-darkText">
            {serviceName || '-'}
          </span>
        </div>
        {prompt && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('gigSquareOrderPrompt')}
            </div>
            <div className="mt-1 text-sm dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words">
              {prompt}
            </div>
          </div>
        )}
        {txid && (
          <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('gigSquareOrderTx')}: {formatShortHash(txid)}
          </div>
        )}
      </div>
    </div>
  );
};

const GigSquareDeliveryCard: React.FC<{ payload: GigSquareDeliveryPayload }> = ({ payload }) => {
  const serviceName = typeof payload.serviceName === 'string' ? payload.serviceName : '';
  const result = typeof payload.result === 'string' ? payload.result : '';

  return (
    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10 px-4 py-3 shadow-subtle">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-emerald-500">
          {i18nService.t('gigSquareDeliveryTitle')}
        </div>
        <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          DELIVERY
        </span>
      </div>
      <div className="mt-2 space-y-2">
        <div className="flex items-center justify-between text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
          <span>{i18nService.t('gigSquareOrderService')}</span>
          <span className="font-medium text-claude-text dark:text-claude-darkText">
            {serviceName || '-'}
          </span>
        </div>
        {result && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('gigSquareDeliveryResult')}
            </div>
            <div className="mt-1 text-sm dark:text-claude-darkText text-claude-text">
              <MarkdownContent content={result} className="max-w-none" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const renderGigSquareCard = (content: string): React.ReactNode | null => {
  const orderPayload = parseGigSquarePayload(content, ORDER_PREFIX);
  if (orderPayload) {
    return <GigSquareOrderCard payload={orderPayload as GigSquareOrderPayload} />;
  }
  const deliveryPayload = parseGigSquarePayload(content, DELIVERY_PREFIX);
  if (deliveryPayload) {
    return <GigSquareDeliveryCard payload={deliveryPayload as GigSquareDeliveryPayload} />;
  }
  return null;
};

const UserMessageItem: React.FC<{
  message: CoworkMessage;
  skills: Skill[];
  sessionType?: string;
  sessionTitle?: string;
  /** The session bot's name — the speaker a sent quote names for the assistant. */
  botName?: string | null;
  /** Quotes this whole message into the composer slot (the reply entry). */
  onQuoteReply?: (message: CoworkMessage, text: string) => void;
  /** Jumps back to the message a sent quote block answers (id anchor when the
   * submitting message recorded one, else the block label's ordinal). */
  onJumpToQuoteBlock?: (ordinal: number, messageIdAnchor?: string) => void;
  /** Resolves an attachment path to an absolute one, so images can be read. */
  resolveLocalFilePath?: (href: string, text: string) => string | null;
}> = ({ message, skills, sessionType, sessionTitle, botName, onQuoteReply, onJumpToQuoteBlock, resolveLocalFilePath }) => {
  const [isHovered, setIsHovered] = useState(false);
  const isSteerMessage = message.metadata?.interactionKind === 'steer';
  const steerStatusKey = isSteerMessage
    ? STEER_STATUS_TRANSLATION_KEYS[String(message.metadata?.steerStatus)] ?? null
    : null;

  // Get skills used for this message
  const messageSkillIds = (message.metadata as CoworkMessageMetadata)?.skillIds || [];
  const messageSkills = messageSkillIds
    .map(id => skills.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  // A sent message body can open with the generated reply block ("#<ordinal>
  // <side>: …"); split it off so it renders as the jump-back control while the
  // rest of the body renders exactly as before. Hand-written blockquotes — not
  // at the body's head, or without the label — never match.
  const sentQuote = parseSentQuoteBlock(message.content, buildSentQuoteDisplaySources(botName));
  // A body can also open with the generated selection block ("从对话中引用的
  // 片段…" header + "引自{source}：" lines): split that off too, so it renders
  // in the same quote-bar language as the reply block instead of as a wall of
  // system-prompt-voiced markdown. Display-only — the header and the machine
  // label stay in the submitted prompt body verbatim (the model reads them).
  const sentSelectionQuote = sentQuote
    ? null
    : parseSentSelectionQuoteBlock(message.content, buildSentSelectionQuoteLabelSets(botName));

  const gigSquareCard = renderGigSquareCard(message.content);
  if (gigSquareCard) {
    return (
      <div
        className="py-2 px-4"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
          <div className="pl-4 sm:pl-8 md:pl-12">
            <div className="flex items-start gap-3 flex-row-reverse">
              <div className="w-full min-w-0 flex flex-col items-end">
                <UserMessageOriginBadge
                  message={message}
                  sessionType={sessionType}
                  sessionTitle={sessionTitle}
                />
                <div className="w-fit max-w-[min(720px,82%)]">
                  {gigSquareCard}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="py-2 px-4"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
        <div className="pl-4 sm:pl-8 md:pl-12">
          <div className="flex items-start gap-3 flex-row-reverse">
            <div className="w-full min-w-0 flex flex-col items-end">
              <UserMessageOriginBadge
                message={message}
                sessionType={sessionType}
                sessionTitle={sessionTitle}
              />
              {/* The id also rides the bubble: the quote-jump ring wraps the
                  innermost data-message-id mount, so it hugs this bubble's
                  own outline — w-fit width, its 22px radius. */}
              <div className="relative w-fit max-w-[min(720px,82%)]">
                <div
                  className="cowork-user-bubble rounded-[22px] px-[16px] py-[10px] dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text"
                  data-message-id={message.id}
                >
                  {sentQuote ? (
                    <>
                      <CoworkSentQuoteBlock
                        block={sentQuote.block}
                        onJump={onJumpToQuoteBlock
                          ? () => onJumpToQuoteBlock(
                            sentQuote.ordinal,
                            readQuotedJumpMessageId(message.metadata) ?? undefined,
                          )
                          : undefined}
                      />
                      {sentQuote.rest ? (
                        <UserMessageBody
                          content={sentQuote.rest}
                          resolveLocalFilePath={resolveLocalFilePath}
                        />
                      ) : null}
                    </>
                  ) : sentSelectionQuote ? (
                    // Same quote bar as the reply block — gold rule, source line,
                    // excerpt — just without a jump target (a hand-picked
                    // selection carries no message position).
                    <>
                      <CoworkSentQuoteBlock block={sentSelectionQuote.block} />
                      {sentSelectionQuote.rest ? (
                        <UserMessageBody
                          content={sentSelectionQuote.rest}
                          resolveLocalFilePath={resolveLocalFilePath}
                        />
                      ) : null}
                    </>
                  ) : (
                    <UserMessageBody
                      content={message.content}
                      resolveLocalFilePath={resolveLocalFilePath}
                    />
                  )}
                </div>
                {/* Menu button positioned on the left side of the bubble, symmetrical to bot messages */}
                <div className="absolute z-10 right-full top-1 mr-1">
                  <CoworkMessageActionsMenu
                    visible={isHovered}
                    text={message.content}
                    onQuote={() => onQuoteReply?.(message, message.content)}
                  />
                </div>
                {/* Metadata badges below the bubble */}
                <div className="flex items-center justify-end gap-1.5 mt-1">
                  {isSteerMessage && (
                    <>
                      <span className="inline-flex items-center rounded-md bg-claude-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-claude-accent">
                        {i18nService.t('coworkSteerLabel')}
                      </span>
                      {steerStatusKey && (
                        <span className={`text-[10px] ${message.metadata?.steerStatus === 'failed'
                          ? 'text-red-500 dark:text-red-400'
                          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
                        }`}>
                          {i18nService.t(steerStatusKey)}
                        </span>
                      )}
                    </>
                  )}
                  {messageSkills.map(skill => (
                    <div
                      key={skill.id}
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-claude-accent/5 dark:bg-claude-accent/10"
                      title={skill.description}
                    >
                      <PuzzlePieceIcon className="h-2.5 w-2.5 text-claude-accent/70" />
                      <span className="text-[10px] font-medium text-claude-accent/70 max-w-[60px] truncate">
                        {skill.name}
                      </span>
                    </div>
                  ))}
                  {/* Restored hover row (owner, 2026-10-28): the sent time and a
                      direct copy button, the same below-the-bubble pair this row
                      carried before the 2026-10-19 actions-menu redesign folded
                      them into the "⋯". The menu stays; the two coexist. Visible
                      on hover in every session state — running included. */}
                  <MessageTimestamp
                    timestamp={message.timestamp}
                    visible={isHovered}
                  />
                  <CopyButton
                    content={message.content}
                    visible={isHovered}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const AssistantMessageItem: React.FC<{
  message: CoworkMessage;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showCopyButton?: boolean;
  onOpenLocalFile?: (filePath: string, event: React.MouseEvent) => boolean | void;
  /** Copies the conversation up to and including this message into a new session. */
  onBranch?: (message: CoworkMessage) => void | Promise<void>;
  /** Quotes this whole message into the composer slot (the reply entry). */
  onQuoteReply?: (message: CoworkMessage, text: string) => void;
  /** Assistant mode drops the embedded thinking segment (raw reasoning is
   * never shown) and renders only the visible reply text. */
  isAssistantMode?: boolean;
  /** True on the turn's last bubble: that is the only place the timestamp and
   * the feedback thumbs render, so a turn's narration segments do not each
   * carry a near-duplicate clock. */
  isTurnEnd?: boolean;
  /** Session id of the conversation this bubble renders — scope for the
   * session-bound hostStamp structural check (source-signing slice). */
  sessionId?: string;
}> = ({
  message,
  resolveLocalFilePath,
  mapDisplayText,
  showCopyButton = false,
  onOpenLocalFile,
  onBranch,
  onQuoteReply,
  isAssistantMode = false,
  isTurnEnd = false,
  sessionId = undefined,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const gigSquareCard = renderGigSquareCard(message.content);
  const thinkSplit = splitThinkTaggedContent(displayContent);
  // S4 chat trade marker: this message announces an NFT trade (nft-card
  // fence with a trade action) → a trade chip rides the bubble footer /
  // professional turn-end row, same family as the messenger chips. The p2p
  // chip needs a hostStamp bound to THIS session (source-signing slice).
  const tradeActivity = detectTradeActivity(displayContent, { sessionId });
  const renderExtension = React.useContext(MessageExtensionContext);

  if (gigSquareCard) {
    return (
      <div className="relative">
        {gigSquareCard}
      </div>
    );
  }

  const replyContent = thinkSplit.thinking ? thinkSplit.text : displayContent;
  const thinkingMessage: CoworkMessage = {
    ...message,
    content: thinkSplit.thinking,
    metadata: {
      ...message.metadata,
      isThinking: true,
      isStreaming: Boolean(message.metadata?.isStreaming) && !thinkSplit.text,
    },
  };

  return (
    <div
      className="relative"
      data-message-id={message.id}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {thinkSplit.thinking && !isAssistantMode ? (
        <div className="mb-3">
          <ThinkingBlock
            message={thinkingMessage}
            mapDisplayText={mapDisplayText}
          />
        </div>
      ) : null}
      {replyContent ? (
        isAssistantMode ? (
          // Assistant mode wraps the reply (narration and final answer alike)
          // in a chat bubble shaped like the user bubble, differentiated
          // purely by background color (no border) via the theme-adaptive
          // neutral-gray .assistant-bubble fill. The w-fit wrapper shares the
          // user bubble's max width (max-w-[min(720px,82%)]) so the bubble
          // hugs short messages and never stretches to the full column.
          // EVERY bubble carries its own hover-action toolbar — narration
          // bubbles included — so each single message is individually
          // replyable, the same per-message actions the professional row
          // gives every assistant message. The toolbar hangs below the
          // bubble's bottom edge (never overlapping its text) and overlays
          // the inter-bubble gap instead of adding layout, so consecutive
          // bubbles keep the container's uniform space-y-1 rhythm in every
          // state (an in-flow row used to add ~32px under each bubble once
          // the turn completed, and the old in-bubble overlay covered reply
          // text); z-10 keeps the strip above the next bubble's rounded top.
          <div className="relative w-fit max-w-[min(720px,82%)]">
            {/* The id also rides the bubble: the quote-jump ring wraps the
                innermost data-message-id mount, so it hugs this bubble's
                own outline — w-fit width, its 22px radius. */}
            <div
              className="assistant-bubble rounded-[22px] px-[16px] py-[10px] dark:text-claude-darkText text-claude-text shadow-subtle"
              data-message-id={message.id}
            >
              {/* emojiImages: same display-only Twemoji pipeline as the user
                  bubble — assistant narration renders catalog emoji identically. */}
              <MarkdownContent
                content={replyContent}
                emojiImages
                className="prose dark:prose-invert max-w-none"
                resolveLocalFilePath={resolveLocalFilePath}
                onOpenLocalFile={onOpenLocalFile}
                chatExperienceMode={isAssistantMode ? 'assistant' : 'professional'}
              />
            </div>
            {tradeActivity && (
              // Trade chip right under the bubble: the message announced an
              // NFT trade (same slot family as the A2A meta-row chip).
              <div className="mt-0.5 px-1">
                <TradeActivityBadge kind={tradeActivity.kind} variant="chip" />
              </div>
            )}
            {shouldShowAssistantBubbleActions({ isAssistantMode, showCopyButton }) && (
              // Hover design (owner, 2026-10-19): a single "⋯" beside the bubble
              // opens quote / copy / branch — the old inline strip is gone, so a
              // turn split into many narration segments no longer stacks a full
              // action row under every one of them. The turn-end line keeps only
              // the timestamp and the feedback thumbs, which is what makes
              // "did I react to this?" visible without opening a menu.
              <>
                <div className="absolute z-10 left-full top-1 ml-1">
                  <CoworkMessageActionsMenu
                    visible={isHovered}
                    text={replyContent}
                    onQuote={() => onQuoteReply?.(message, replyContent)}
                    onBranch={onBranch ? () => void onBranch(message) : undefined}
                  />
                </div>
                {isTurnEnd && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <MessageTimestamp
                      timestamp={message.timestamp}
                      visible={isHovered}
                    />
                    <MessageFeedbackControls
                      messageId={message.id}
                      visible={isHovered}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          // Professional mode: bare full-width text, actions in a flow row.
          <div className="dark:text-claude-darkText text-claude-text">
            {tradeActivity && (
              // Trade chip above the text: the message announced an NFT trade.
              <div className="mb-1">
                <TradeActivityBadge kind={tradeActivity.kind} variant="chip" />
              </div>
            )}
            {/* Professional mode shares the display-only Twemoji pipeline. */}
            <MarkdownContent
              content={replyContent}
              emojiImages
              className="prose dark:prose-invert max-w-none"
              resolveLocalFilePath={resolveLocalFilePath}
              onOpenLocalFile={onOpenLocalFile}
              chatExperienceMode={isAssistantMode ? 'assistant' : 'professional'}
            />
          </div>
        )
      ) : null}
      {renderExtension?.(message)}
      {!isAssistantMode && showCopyButton && (
        // Professional mode renders one bubble per turn, so this row IS the
        // turn end: timestamp + feedback only. The "⋯" rides at the message's
        // top-right (the item root is the positioning context).
        <>
          <div className="absolute z-10 left-full top-1 ml-1">
            <CoworkMessageActionsMenu
              visible={isHovered}
              text={replyContent}
              onQuote={() => onQuoteReply?.(message, replyContent)}
              onBranch={onBranch ? () => void onBranch(message) : undefined}
            />
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <MessageTimestamp
              timestamp={message.timestamp}
              visible={isHovered}
            />
            <MessageFeedbackControls
              messageId={message.id}
              visible={isHovered}
            />
          </div>
        </>
      )}
    </div>
  );
};

const A2AGuidanceControls = React.memo(({
  sessionId,
  isConversationEnded,
  isEnding,
  endError,
  resendError,
  onEndConversation,
}: {
  sessionId: string;
  isConversationEnded: boolean;
  isEnding: boolean;
  endError: string | null;
  resendError: string | null;
  onEndConversation: () => void;
}) => {
  const sessionIdRef = useRef(sessionId);
  const [a2aGuidanceOpen, setA2AGuidanceOpen] = useState(false);
  const [guidanceText, setGuidanceText] = useState('');
  const [isSubmittingA2AGuidance, setIsSubmittingA2AGuidance] = useState(false);
  const [a2aGuidanceStatus, setA2AGuidanceStatus] = useState<string | null>(null);
  const [a2aGuidanceError, setA2AGuidanceError] = useState<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    setA2AGuidanceOpen(false);
    setGuidanceText('');
    setIsSubmittingA2AGuidance(false);
    setA2AGuidanceStatus(null);
    setA2AGuidanceError(null);
  }, [sessionId]);

  const handleSubmitA2AGuidance = useCallback(async (event?: React.FormEvent) => {
    event?.preventDefault();
    const guidance = guidanceText.trim();
    const requestSessionId = sessionId;
    if (!requestSessionId || isSubmittingA2AGuidance) return;
    if (!guidance) {
      setA2AGuidanceError(i18nService.t('a2aGuidanceEmpty'));
      setA2AGuidanceStatus(null);
      return;
    }

    setIsSubmittingA2AGuidance(true);
    setA2AGuidanceError(null);
    setA2AGuidanceStatus(null);
    const result = await coworkService.queueA2AGuidance({
      sessionId: requestSessionId,
      guidance,
    });
    if (sessionIdRef.current !== requestSessionId) return;
    if (!result.success) {
      setA2AGuidanceError(result.error || i18nService.t('a2aGuidanceFailed'));
      setIsSubmittingA2AGuidance(false);
      return;
    }

    setGuidanceText('');
    setA2AGuidanceOpen(false);
    setA2AGuidanceStatus(
      result.mode === 'restart_started'
        ? i18nService.t('a2aGuidanceRestartStarted')
        : i18nService.t('a2aGuidanceQueued')
    );
    setIsSubmittingA2AGuidance(false);
  }, [guidanceText, isSubmittingA2AGuidance, sessionId]);

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={() => {
            setA2AGuidanceOpen((open) => !open);
            setA2AGuidanceError(null);
            setA2AGuidanceStatus(null);
          }}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border dark:border-claude-darkBorder border-claude-border px-3 text-xs font-medium dark:text-claude-darkText text-claude-text transition-colors hover:bg-claude-hover dark:hover:bg-claude-darkHover"
        >
          <PencilSquareIcon className="h-4 w-4" />
          {i18nService.t('a2aGuidance')}
        </button>
        {isConversationEnded ? (
          <span className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-500/30 px-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {i18nService.t('a2aSessionEnded')}
          </span>
        ) : (
          <button
            type="button"
            onClick={onEndConversation}
            disabled={isEnding}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-red-500/30 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-400"
          >
            <StopCircleIcon className="h-4 w-4" />
            {isEnding ? i18nService.t('a2aSessionEnding') : i18nService.t('a2aSessionEndConversation')}
          </button>
        )}
      </div>
      {a2aGuidanceOpen && (
        <form onSubmit={handleSubmitA2AGuidance} className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={guidanceText}
            onChange={(event) => setGuidanceText(event.target.value)}
            placeholder={i18nService.t('a2aGuidancePlaceholder')}
            aria-label={i18nService.t('a2aGuidancePlaceholder')}
            maxLength={2000}
            className="min-w-0 flex-1 rounded-md border dark:border-claude-darkBorder border-claude-border bg-transparent px-3 py-2 text-sm outline-none focus:border-claude-accent"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSubmittingA2AGuidance || !guidanceText.trim()}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-claude-accent px-3 text-xs font-medium text-claude-accentInk transition-colors hover:bg-claude-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <PaperAirplaneIcon className="h-4 w-4" />
              {isSubmittingA2AGuidance ? i18nService.t('a2aGuidanceSubmitting') : i18nService.t('a2aGuidanceSend')}
            </button>
            <button
              type="button"
              onClick={() => {
                setA2AGuidanceOpen(false);
                setGuidanceText('');
                setA2AGuidanceError(null);
              }}
              className="inline-flex h-9 items-center justify-center rounded-md border dark:border-claude-darkBorder border-claude-border px-3 text-xs font-medium dark:text-claude-darkText text-claude-text hover:bg-claude-hover dark:hover:bg-claude-darkHover"
            >
              {i18nService.t('a2aGuidanceCancel')}
            </button>
          </div>
        </form>
      )}
      {(a2aGuidanceError || a2aGuidanceStatus || endError || resendError) && (
        <p className={`text-right text-xs ${a2aGuidanceError || endError || resendError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {a2aGuidanceError || endError || resendError || a2aGuidanceStatus}
        </p>
      )}
    </>
  );
});

// Composer for A2A sessions whose peer is the local human owner: the human
// speaks as themselves over the encrypted on-chain private chat (same
// Enter-to-send contract as the group-task composer), replacing the
// guidance/end observer controls.
const A2AOwnerComposer = React.memo(({
  sessionId,
}: {
  sessionId: string;
}) => {
  const sessionIdRef = useRef(sessionId);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    setDraft('');
    setSending(false);
    setSendError(null);
  }, [sessionId]);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    const requestSessionId = sessionId;
    if (!requestSessionId || sending || !content) return;

    setSending(true);
    setSendError(null);
    const result = await coworkService.sendOwnerA2AMessage({
      sessionId: requestSessionId,
      content,
    });
    if (sessionIdRef.current !== requestSessionId) return;
    if (!result.success) {
      setSendError(result.error || i18nService.t('a2aOwnerChatFailed'));
      setSending(false);
      return;
    }

    setDraft('');
    setSending(false);
  }, [draft, sending, sessionId]);

  return (
    <>
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter inserts a newline; Enter during IME
            // composition confirms the candidate instead of sending.
            const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
            if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
              event.preventDefault();
              void handleSend();
            }
          }}
          rows={2}
          maxLength={2000}
          placeholder={i18nService.t('a2aOwnerChatPlaceholder')}
          aria-label={i18nService.t('a2aOwnerChatPlaceholder')}
          className="flex-1 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-2 text-sm leading-relaxed dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50 resize-none"
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!draft.trim() || sending}
          className="btn-idchat-primary-filled px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {sending ? i18nService.t('a2aOwnerChatSending') : i18nService.t('a2aOwnerChatSend')}
        </button>
      </div>
      {sendError && (
        <p className="text-right text-xs text-red-500">{sendError}</p>
      )}
    </>
  );
});

// Streaming activity bar shown between messages and input

/**
 * Turn-ack phrase for the live turn: scans the contiguous tail run of
 * runtime-status messages for the 'turnAck' signal and draws (memoized per
 * ack message id) from the per-session shuffle bag. null when no ack applies
 * — callers keep their existing status copy untouched.
 */
const useTurnAckPhrase = (messages: CoworkMessage[], sessionId: string | null): string | null => {
  const tailTurnAck = React.useMemo(() => findTailTurnAck(messages), [messages]);
  return React.useMemo(
    () => tailTurnAck
      ? drawTurnAckPhrase({
          sessionId,
          tier: tailTurnAck.tier,
          language: i18nService.getLanguage(),
          ackMessageId: tailTurnAck.messageId,
        })
      : null,
    // Draw once per ack message; language flips only re-draw for NEW acks
    // (remembered phrases stay in their drawn language), the right trade.
    [tailTurnAck?.messageId, tailTurnAck?.tier, sessionId],
  );
};

const StreamingActivityBar: React.FC<{ messages: CoworkMessage[]; fallbackText?: string; sessionId?: string | null }> = ({
  messages,
  fallbackText,
  sessionId = null,
}) => {
  // Turn acknowledgment (same contract as the assistant-mode indicator): a
  // 'turnAck' runtime-status signal in the contiguous tail run draws a tier
  // phrase from the shuffle bag while the first visible token is still
  // pending; a retry always outranks it, and tool-running text only applies
  // once the tail run ends.
  const ackPhrase = useTurnAckPhrase(messages, sessionId);
  // Walk messages backwards to find the latest tool_use without a paired tool_result
  const getStatusText = (): string => {
    // SDK runtime-status signals (api_retry / requesting / turnAck) take precedence over
    // tool-running text — they describe the transport layer, not the agent loop.
    let sawRequesting = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const status = msg.metadata?.sdkRuntimeStatus;
      if (typeof status !== 'string') break;
      if (status === 'api_retry') {
        const attempt = typeof msg.metadata?.retryAttempt === 'number' ? msg.metadata.retryAttempt : null;
        const max = typeof msg.metadata?.retryMax === 'number' ? msg.metadata.retryMax : null;
        if (attempt !== null && max !== null) {
          return i18nService.t('coworkRetrying').replace('{attempt}', String(attempt)).replace('{max}', String(max));
        }
        if (attempt !== null) {
          return i18nService.t('coworkRetryingSimple').replace('{attempt}', String(attempt));
        }
        return i18nService.t('coworkRetryingGeneric');
      }
      if (status === 'requesting') {
        sawRequesting = true;
      }
    }
    // A turnAck in the tail run outranks the generic "requesting" copy —
    // the calibrated tier promise is the point of the acknowledgment.
    if (ackPhrase) {
      return ackPhrase;
    }
    if (sawRequesting) {
      return i18nService.t('coworkRequesting');
    }

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      const id = msg.metadata?.toolUseId;
      if (typeof id === 'string') {
        if (msg.type === 'tool_result') toolResultIds.add(id);
        if (msg.type === 'tool_use') toolUseIds.add(id);
      }
    }
    // Walk backwards to find latest unresolved tool_use
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'tool_use') {
        const id = msg.metadata?.toolUseId;
        if (typeof id === 'string' && !toolResultIds.has(id)) {
          const toolName = typeof msg.metadata?.toolName === 'string' ? msg.metadata.toolName : null;
          if (toolName) {
            return `${i18nService.t('coworkToolRunning')} ${toolName}...`;
          }
        }
      }
    }
    return fallbackText || `${i18nService.t('coworkToolRunning')}`;
  };

  return (
    <div className="shrink-0 animate-fade-in px-4">
      <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
        <div className="streaming-bar" />
        <div className="py-1">
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {getStatusText()}
          </span>
        </div>
      </div>
    </div>
  );
};

const TypingDots: React.FC = () => (
  <div className="flex items-center space-x-1.5 py-1">
    <div className="w-2 h-2 rounded-full bg-claude-accent animate-bounce" style={{ animationDelay: '0ms' }} />
    <div className="w-2 h-2 rounded-full bg-claude-accent animate-bounce" style={{ animationDelay: '150ms' }} />
    <div className="w-2 h-2 rounded-full bg-claude-accent animate-bounce" style={{ animationDelay: '300ms' }} />
  </div>
);

const AssistantTurnBlock = React.memo(function AssistantTurnBlock({
  turn,
  resolveLocalFilePath,
  mapDisplayText,
  showTypingIndicator = false,
  showImagePreviews = true,
  sessionLive = false,
  isActiveTurn = false,
  onOpenLocalFile,
  onBranch,
  onQuoteReply,
  isAssistantMode = false,
  activityAvatar = null,
  runtimeStatusMessages = null,
  sessionId = null,
}: {
  turn: ConversationTurn;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showTypingIndicator?: boolean;
  showImagePreviews?: boolean;
  sessionLive?: boolean;
  /** This turn is the session's current in-flight turn (live session, last turn). */
  isActiveTurn?: boolean;
  onOpenLocalFile?: (filePath: string, event: React.MouseEvent) => boolean | void;
  onBranch?: (message: CoworkMessage) => void | Promise<void>;
  /** Quotes one whole message into the composer slot (the reply entry). */
  onQuoteReply?: (message: CoworkMessage, text: string) => void;
  /** Shuffle-bag scope for the assistant-mode indicator's turn-ack phrases. */
  sessionId?: string | null;
  /** Assistant mode: raw thinking and tool-call chrome are hidden entirely
   * (explicit owner_update progress arrives as ordinary chat bubbles), and
   * the "Worked for" collapse stays disabled so the visible list renders in order. */
  isAssistantMode?: boolean;
  /** Session bot avatar for the inline assistant-mode activity indicator. */
  activityAvatar?: string | null;
  /** Ephemeral SDK runtime-status messages (api_retry / requesting) hidden
   * from the transcript but still meaningful to the activity indicator's
   * status line. Passed only for the live last turn so memoized older turns
   * keep stable props. */
  runtimeStatusMessages?: CoworkMessage[] | null;
}) {
  const visibleAssistantItems = getVisibleAssistantItems(turn.assistantItems, isAssistantMode);
  // This turn's messages feed the inline assistant-mode activity indicator's
  // status derivation (an unresolved tool call reads as "working on it").
  // Derived from the turn itself so memoized older turns keep stable props.
  const activityMessages: CoworkMessage[] = [];
  for (const item of turn.assistantItems) {
    if (item.type === 'tool_group') {
      activityMessages.push(item.group.toolUse);
      if (item.group.toolResult) activityMessages.push(item.group.toolResult);
    } else {
      activityMessages.push(item.message);
    }
  }
  // Runtime-status signals are filtered out of the transcript before turns
  // are built, so they must be merged back in here — by timestamp, keeping
  // the indicator's backwards recency scan honest (a status message only
  // wins while it is genuinely the newest signal, same contract as
  // professional mode's StreamingActivityBar, which reads the raw message
  // list).
  if (runtimeStatusMessages && runtimeStatusMessages.length > 0) {
    activityMessages.push(...runtimeStatusMessages);
    activityMessages.sort((a, b) => a.timestamp - b.timestamp);
  }
  // Collapsed by default once a turn completes; the header expands to reveal
  // the working process (thinking, tool calls, intermediate notes).
  const [processExpanded, setProcessExpanded] = useState(false);

  const renderSystemMessage = (message: CoworkMessage) => {
    const meta = message.metadata ?? {};

    // A DELIVERED proactive send (im_send_message) is a normal outgoing chat
    // bubble: the body verbatim, then one entry per attachment. Failed and
    // partially delivered attempts keep the audited card below — there the
    // visible reason is the message. Legacy rows (no record version) also keep
    // the card: their `content` IS the card text.
    const outboundReceipt = readOutboundImReceiptBubble(message);
    if (outboundReceipt) {
      return (
        <OutboundImReceiptMessage
          view={outboundReceipt}
          onOpenLocalFile={onOpenLocalFile}
        />
      );
    }

    // Structured SDK event messages (previously silently dropped events are
    // now surfaced here: notification / informational / compact_boundary /
    // permission_denied / rate_limit_event / conversation_reset).
    let sdkIcon: string | null = null;
    let sdkTint = 'dark:text-claude-darkTextSecondary text-claude-textSecondary';
    let sdkContent = '';
    // Set by branches whose localized line must win over the stored body —
    // e.g. compaction checkpoints, where old transcripts still carry the full
    // internal summary blob in `content`.
    let sdkOverridesContent = false;

    if (meta.sdkNotification && typeof meta.sdkNotification === 'object') {
      sdkIcon = '🔔';
      sdkContent = message.content;
    } else if (meta.sdkInformational && typeof meta.sdkInformational === 'object') {
      const info = meta.sdkInformational as Record<string, unknown>;
      sdkIcon = info.level === 'warning' ? '⚠️' : 'ℹ️';
      if (info.level === 'warning') sdkTint = 'text-amber-600 dark:text-amber-400';
      sdkContent = message.content;
    } else if (meta.sdkCompactBoundary && typeof meta.sdkCompactBoundary === 'object') {
      const boundary = meta.sdkCompactBoundary as Record<string, unknown>;
      sdkIcon = '🧹';
      const triggerLabel = boundary.trigger === 'manual'
        ? i18nService.t('coworkSdkCompactBoundaryManual')
        : i18nService.t('coworkSdkCompactBoundaryAuto');
      const pre = typeof boundary.preTokens === 'number' ? formatCompactTokens(boundary.preTokens) : null;
      const post = typeof boundary.postTokens === 'number' ? formatCompactTokens(boundary.postTokens) : null;
      let text = i18nService.t('coworkSdkCompactBoundary');
      if (pre !== null && post !== null) {
        text += ` (${triggerLabel}, ${pre} → ${post})`;
      } else {
        text += ` (${triggerLabel})`;
      }
      sdkContent = text;
    } else if (meta.compaction === true && meta.isError !== true) {
      // DSH-route compaction checkpoint. The kernel's summary is LLM context,
      // not chat content — render one brief localized line and never fall back
      // to the stored body (old transcripts keep the full blob there).
      sdkIcon = '🧹';
      sdkOverridesContent = true;
      sdkContent = buildCompactedNoticeText(extractCompactedCounts(meta, message.content));
    } else if (meta.sdkPermissionDenied && typeof meta.sdkPermissionDenied === 'object') {
      const denied = meta.sdkPermissionDenied as Record<string, unknown>;
      sdkIcon = '🚫';
      sdkTint = 'text-red-600 dark:text-red-400';
      const tool = typeof denied.toolName === 'string' ? denied.toolName : null;
      sdkContent = message.content || (
        tool
          ? `${i18nService.t('coworkSdkPermissionDenied')}: ${tool}`
          : i18nService.t('coworkSdkPermissionDenied')
      );
    } else if (meta.sdkRateLimit && typeof meta.sdkRateLimit === 'object') {
      const limit = meta.sdkRateLimit as Record<string, unknown>;
      sdkIcon = '⚠️';
      sdkTint = 'text-amber-600 dark:text-amber-400';
      const label = limit.status === 'rejected'
        ? i18nService.t('coworkSdkRateLimitRejected')
        : i18nService.t('coworkSdkRateLimitWarning');
      const util = typeof limit.utilization === 'number' ? ` (${Math.round(limit.utilization * 100)}%)` : '';
      sdkContent = `${label}${util}`;
    } else if (meta.sdkConversationReset === true) {
      sdkIcon = '🔄';
      sdkContent = i18nService.t('coworkSdkConversationReset');
    } else if (meta.emptyTerminalTurn === true) {
      sdkIcon = '⚠️';
      sdkTint = 'text-amber-600 dark:text-amber-400';
      sdkContent = i18nService.t('coworkEmptyTerminalTurn');
    } else if (meta.replyTruncatedTurn === true) {
      sdkIcon = '✂️';
      sdkTint = 'text-amber-600 dark:text-amber-400';
      sdkContent = i18nService.t('coworkReplyTruncatedTurn');
    } else if (meta.dshTurnStalled === true) {
      sdkIcon = '⏱️';
      sdkTint = 'text-amber-600 dark:text-amber-400';
      sdkContent = i18nService.t('coworkDshTurnStalled');
    } else if (meta.dshTurnInterrupted === true) {
      sdkIcon = '⚠️';
      sdkTint = 'text-amber-600 dark:text-amber-400';
      sdkContent = i18nService.t('coworkDshTurnInterrupted');
    } else if (meta.steerInterruptAcknowledged === true) {
      // The CLI reported the interrupted turn via an internal diagnostic; the
      // steer was delivered and the task continues toward it.
      sdkIcon = '🧭';
      sdkContent = i18nService.t('coworkSteerInterruptAcknowledged').replace(
        '{text}',
        typeof meta.steerText === 'string' ? meta.steerText : ''
      );
    }

    const rawContent = !sdkOverridesContent && hasText(message.content)
      ? message.content
      : (sdkContent || (typeof message.metadata?.error === 'string' ? message.metadata.error : ''));
    const content = mapDisplayText ? mapDisplayText(rawContent) : rawContent;
    if (!content.trim() && !sdkIcon) return null;

    return (
      <div className="rounded-lg border dark:border-claude-darkBorder/70 border-claude-border/70 dark:bg-claude-darkBg/40 bg-claude-bg/60 px-3 py-2">
        <div className="flex items-start gap-2">
          {sdkIcon ? (
            <span className="text-sm mt-0.5 flex-shrink-0 leading-none">{sdkIcon}</span>
          ) : (
            <InformationCircleIcon className="h-4 w-4 mt-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0" />
          )}
          <div className={`text-xs whitespace-pre-wrap break-words leading-5 ${sdkTint}`}>
            {content}
          </div>
        </div>
      </div>
    );
  };

  const renderOrphanToolResult = (message: CoworkMessage) => {
    const toolResultDisplayRaw = getToolResultDisplay(message);
    const toolResultDisplay = mapDisplayText ? mapDisplayText(toolResultDisplayRaw) : toolResultDisplayRaw;
    const isToolError = Boolean(message.metadata?.isError || message.metadata?.error);
    const resultLineCount = getToolResultLineCount(toolResultDisplay);
    const imagePreviewPaths = showImagePreviews
      ? extractImagePaths(toolResultDisplay, resolveLocalFilePath)
      : [];
    return (
      <div className="py-1">
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
            isToolError ? 'bg-red-500' : 'bg-claude-darkTextSecondary/50'
          }`} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkToolResult')}
            </div>
            {resultLineCount > 0 && (
              <div className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-0.5">
                {resultLineCount} {resultLineCount === 1 ? 'line' : 'lines'} of output
              </div>
            )}
            <div className="mt-2 px-3 py-2 rounded-lg dark:bg-claude-darkSurface/50 bg-claude-surface/50 max-h-64 overflow-y-auto">
              <pre className={`text-xs whitespace-pre-wrap break-words font-mono ${
                isToolError ? 'text-red-500' : 'dark:text-claude-darkText text-claude-text'
              }`}>
                {toolResultDisplay || i18nService.t('coworkToolRunning')}
              </pre>
            </div>
            {imagePreviewPaths.length > 0 && (
              <ImagePreviewStrip imagePaths={imagePreviewPaths} />
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderVisibleItem = (
    item: AssistantTurnItem,
    index: number,
    allItems: AssistantTurnItem[],
  ): React.ReactNode => {
    if (item.type === 'assistant') {
      if (item.message.metadata?.isThinking) {
        const abandonedEmptyThink = !sessionLive
          && Boolean(item.message.metadata?.isStreaming)
          && !item.message.content?.trim();
        if (abandonedEmptyThink) {
          const interrupted = renderSystemMessage({
            ...item.message,
            type: 'system',
            metadata: { ...item.message.metadata, dshTurnInterrupted: true },
          });
          return interrupted ? <div key={item.message.id}>{interrupted}</div> : null;
        }
        if (isAssistantMode) {
          // Assistant mode filters thinking items out upstream
          // (isVisibleAssistantTurnItem); this guard covers direct renders so
          // raw reasoning can never leak back in.
          return null;
        }
        return (
          <ThinkingBlock
            key={item.message.id}
            message={item.message}
            mapDisplayText={mapDisplayText}
            live={sessionLive && Boolean(item.message.metadata?.isStreaming)}
          />
        );
      }
      // Check if there are any tool_group items after this assistant message
      const hasToolGroupAfter = allItems
        .slice(index + 1)
        .some(laterItem => laterItem.type === 'tool_group');

      return (
        <AssistantMessageItem
          key={item.message.id}
          message={item.message}
          resolveLocalFilePath={resolveLocalFilePath}
          mapDisplayText={mapDisplayText}
          showCopyButton={!hasToolGroupAfter}
          onOpenLocalFile={onOpenLocalFile}
          onBranch={onBranch}
          onQuoteReply={onQuoteReply}
          isAssistantMode={isAssistantMode}
          isTurnEnd={!isAssistantMode || index === visibleAssistantItems.length - 1}
          sessionId={sessionId ?? undefined}
        />
      );
    }

    if (item.type === 'tool_group') {
      const nextItem = allItems[index + 1];
      const isLastInSequence = !nextItem || nextItem.type !== 'tool_group';
      return (
        <ToolCallGroup
          key={`tool-${item.group.toolUse.id}`}
          group={item.group}
          isLastInSequence={isLastInSequence}
          mapDisplayText={mapDisplayText}
          resolveLocalFilePath={resolveLocalFilePath}
          showImagePreviews={showImagePreviews}
        />
      );
    }

    if (item.type === 'system') {
      const systemMessage = renderSystemMessage(item.message);
      if (!systemMessage) {
        return null;
      }
      return (
        <div key={item.message.id}>
          {systemMessage}
        </div>
      );
    }

    // Orphan tool_result: already filtered out of assistant-mode turns by
    // isVisibleAssistantTurnItem; guard here as well so the tool UI can never
    // leak back in through a direct renderVisibleItem call.
    if (isAssistantMode) {
      return null;
    }

    return (
      <div key={item.message.id}>
        {renderOrphanToolResult(item.message)}
      </div>
    );
  };

  // The final assistant text message is the delivery result; everything
  // before it (thinking, tool calls, intermediate notes) is the working
  // process. Once the turn completes, the process collapses behind a
  // "Worked for X" header so only the delivery stays visible.
  // The active turn of a running session stays expanded through inter-round
  // gaps (tool execution + next model roundtrip), even though nothing carries
  // isStreaming then — collapsing there is the glm-5.3 fold/unfold flash; see
  // isAssistantTurnComplete.
  const hasStreamingItem = visibleAssistantItems.some((item) => {
    const message = item.type === 'tool_group' ? item.group.toolUse : item.message;
    return Boolean(message.metadata?.isStreaming);
  });
  const isTurnComplete = isAssistantTurnComplete({ sessionLive, isActiveTurn, hasStreamingItem });
  const showInterruptedBanner = !sessionLive && (
    visibleAssistantItems.some((item) => {
      if (item.type === 'system') return item.message.metadata?.dshTurnInterrupted === true;
      if (item.type !== 'assistant') return false;
      return Boolean(item.message.metadata?.isStreaming)
        && Boolean(item.message.metadata?.isThinking)
        && !item.message.content?.trim();
    })
  );
  const deliveryIndex = findDeliveryAssistantIndex(visibleAssistantItems);
  const deliveryItem = deliveryIndex >= 0 ? visibleAssistantItems[deliveryIndex] : null;
  const deliveryMessage = deliveryItem && deliveryItem.type === 'assistant' ? deliveryItem.message : null;
  const processItems = deliveryMessage
    ? visibleAssistantItems.filter((_, index) => index !== deliveryIndex)
    : [];
  // Outbound-IM receipts (im_send_message) never fold into "Worked for X":
  // they are the proof of what went out to the phone, so they render below the
  // delivery bubble in every state. Only the real process chrome collapses.
  const { receipts: outboundReceiptItems, rest: collapsibleProcessItems } =
    splitOutboundImReceipts(processItems);
  const workedForMs = deliveryMessage && turn.userMessage
    ? Math.max(0, deliveryMessage.timestamp - turn.userMessage.timestamp)
    : 0;
  // Assistant mode never collapses the process: raw thinking and tool calls
  // are hidden entirely, so there is no "Worked for X" header to expand — the
  // visible list (narration bubbles and replies) renders in order.
  const showWorkedHeader = Boolean(
    !isAssistantMode
    && isTurnComplete
    && deliveryMessage
    && collapsibleProcessItems.length > 0
    && turn.userMessage
    && workedForMs > 0
  );

  return (
    <div className="px-4 py-2">
      <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
        <div className="flex items-start gap-3">
          {/* Assistant mode tightens the inter-item rhythm (space-y-1 = 4px,
              the effective gap — AssistantMessageItem's root carries no extra
              padding): a turn's consecutive bot bubbles (narration + final
              reply) read as one compact sequence. The inline activity
              indicator keeps its own py-2, so it still gets comfortable
              breathing room. Professional mode keeps space-y-3 (thinking
              blocks, tool groups, worked header). */}
          <div className={`flex-1 min-w-0 px-4 py-3 ${isAssistantMode ? 'space-y-1' : 'space-y-3'}`}>
            {showWorkedHeader ? (
              <>
                <button
                  type="button"
                  onClick={() => setProcessExpanded((expanded) => !expanded)}
                  className="w-full flex items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder/50 border-claude-border/50 px-3 py-2 text-left dark:hover:bg-claude-darkSurfaceHover/50 hover:bg-claude-surfaceHover/50 transition-colors"
                  aria-label={processExpanded ? i18nService.t('collapse') : i18nService.t('expand')}
                  aria-expanded={processExpanded}
                >
                  <ChevronRightIcon
                    className={`h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0 transition-transform duration-200 ${
                      processExpanded ? 'rotate-90' : ''
                    }`}
                  />
                  <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkWorkedFor')} {formatWorkedDuration(workedForMs)}
                  </span>
                </button>
                {processExpanded && (
                  <div className="space-y-3">
                    {collapsibleProcessItems.map((processItem) => (
                      renderVisibleItem(processItem, visibleAssistantItems.indexOf(processItem), visibleAssistantItems)
                    ))}
                  </div>
                )}
                <AssistantMessageItem
                  key={deliveryMessage!.id}
                  message={deliveryMessage!}
                  resolveLocalFilePath={resolveLocalFilePath}
                  mapDisplayText={mapDisplayText}
                  showCopyButton
                  onOpenLocalFile={onOpenLocalFile}
                  onBranch={onBranch}
                  onQuoteReply={onQuoteReply}
                  isAssistantMode={isAssistantMode}
                  isTurnEnd
                  sessionId={sessionId ?? undefined}
                />
                {/* Outbound-IM receipts always visible: never behind the fold. */}
                {outboundReceiptItems.map((item) => (
                  renderVisibleItem(item, visibleAssistantItems.indexOf(item), visibleAssistantItems)
                ))}
              </>
            ) : (
              visibleAssistantItems.map((item, index) => renderVisibleItem(item, index, visibleAssistantItems))
            )}
            {showTypingIndicator && (
              // Assistant mode: the bot-avatar activity indicator sits inline
              // at the reply position and is the mode's ONLY activity
              // indicator — visible through the whole running state (its
              // status line differentiates streaming vs working phases).
              isAssistantMode ? (
                <AssistantActivityIndicator
                  inline
                  messages={activityMessages}
                  avatar={activityAvatar}
                  sessionId={sessionId}
                />
              ) : (
                <TypingDots />
              )
            )}
            {showWorkedHeader && showInterruptedBanner && (
              renderSystemMessage({
                id: 'dsh-turn-interrupted',
                type: 'system',
                content: '',
                timestamp: Date.now(),
                metadata: { dshTurnInterrupted: true },
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

/** Divider card rendered where the A2A conversation crosses an episode boundary. */
const A2AEpisodeDividerCard: React.FC<{
  episodeIndex: number;
  summary: string | null;
}> = ({ episodeIndex, summary }) => {
  const title = i18nService.t('a2aEpisodeDividerTitle').replace('{index}', String(episodeIndex));
  return (
    <div className="mx-auto my-3 w-full max-w-2xl px-4">
      <div className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/10 dark:bg-claude-darkBg/60">
        <div className="flex items-center gap-3 font-mono text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
          <span className="whitespace-nowrap select-none">{title}</span>
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
        </div>
        {summary ? (
          <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {summary}
          </p>
        ) : null}
      </div>
    </div>
  );
};

const CoworkSessionDetail: React.FC<CoworkSessionDetailProps> = ({
  onManageSkills,
  onContinue,
  onStop,
  submitError,
  focusedOrderTxid,
  onFocusedOrderConsumed,
  onNavigateHome,
  isSidebarCollapsed,
  onNewChat,
  onOpenBotInBrowser,
  onRequestAppSettings,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  // Field-level subscriptions: a whole-slice selector re-rendered the entire
  // transcript on every composer keystroke because sessionDrafts/draftPrompt
  // live in the same cowork slice (one dispatch per keystroke).
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  // Review Minor 5: the feedback nudge waits for the session's feedback rows
  // to hydrate before judging "completely unrated" (no rated-session flash).
  const feedbackLoadedForNudge = useSelector(
    (state: RootState) => state.cowork.feedbackLoadedBySessionId[currentSession?.id ?? ''] === true,
  );
  const isStreaming = useSelector((state: RootState) => state.cowork.isStreaming);
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const pendingPermission = currentSession
    ? pendingPermissions.find((permission) => permission.sessionId === currentSession.id) ?? null
    : null;
  const [isRespondingToPermission, setIsRespondingToPermission] = useState(false);
  useEffect(() => {
    setIsRespondingToPermission(false);
  }, [pendingPermission?.requestId]);
  const handlePermissionResponse = useCallback(async (result: CoworkPermissionResult) => {
    if (!pendingPermission || isRespondingToPermission) return;
    setIsRespondingToPermission(true);
    // 2026-10-23 incident (session ab67c828): one failed respond IPC (dev-build
    // skew, channel rejection, uncloneable payload) rejected this await with no
    // catch, latching `responding` forever — the question wizard's every control
    // went disabled with no retry and no close, and a timeout:-1 ask left the
    // turn waiting on a modal nobody could answer. The flag must reset on every
    // settle path; an error may cost one click, never the whole modal.
    try {
      const success = await coworkService.respondToPermission(pendingPermission.requestId, result);
      if (!success) setIsRespondingToPermission(false);
    } catch (error) {
      console.error('Failed to respond to permission:', error);
      setIsRespondingToPermission(false);
    }
  }, [pendingPermission, isRespondingToPermission]);
  // Settle watchdog: the respond IPC normally settles in milliseconds; if it
  // never settles at all (pathological transport), re-enable the modal instead
  // of latching it disabled. A retried respond for an id main already resolved
  // is harmless (runner treats unknown ids as no-ops and broadcasts resolved).
  useEffect(() => {
    if (!isRespondingToPermission) return;
    const timer = window.setTimeout(() => setIsRespondingToPermission(false), 15000);
    return () => window.clearTimeout(timer);
  }, [isRespondingToPermission, pendingPermission?.requestId]);
  // Chat experience mode, FACE-scoped (总裁办公室裁定 2026-11-09 + owner
  // ruling 2026-11-12): 'assistant' (hides raw thinking and tool-call chrome;
  // explicit owner_update progress arrives as ordinary chat bubbles) applies
  // only on the Studio face for what it lists; the BotWorks face renders EVERY
  // session professionally — Studio projector sessions included (they open
  // here with their full thinking transcript). The turns of a marker session
  // still run the assistant prompt/effort chain (backend session-owned
  // execution, see assistantModeSessionGate). See useChatExperienceMode for
  // the cross-window reactivity contract.
  const chatExperienceMode = useChatExperienceMode();
  const isAssistantMode = isAssistantModeOwnerChatSession(chatExperienceMode, currentSession);
  // Legacy IM direct rows can still be stored as 'a2a'. The conversation
  // mapping is the display source of truth, so an IM row never renders the
  // A2A panels (peer profile, episode history, A2A errors).
  const isA2ASession = currentSession?.sessionType === 'a2a' && !currentSession?.imChannel;
  const a2aApprovalPermissions = useMemo(() => {
    if (!isA2ASession || !currentSession) return [];
    return pendingPermissions.filter((permission) => (
      permission.sessionId === currentSession.id && a2aApprovalOf(permission) !== null
    ));
  }, [isA2ASession, currentSession, pendingPermissions]);
  const isPrivateA2ASession = useMemo(() => (
    currentSession?.sessionType === 'a2a'
    && currentSession.messages.some((message) => message.metadata?.sourceChannel === 'metaweb_private')
  ), [currentSession?.sessionType, currentSession?.messages]);
  const isA2AConversationEnded = useMemo(() => {
    let ended = false;
    for (const message of currentSession?.messages ?? []) {
      if (message.metadata?.a2aConversationRestarted === true) {
        ended = false;
      }
      if (
        message.metadata?.a2aConversationEnded === true
        || message.metadata?.a2aConversationEndSystemNotice === true
      ) {
        ended = true;
      }
    }
    return ended;
  }, [currentSession?.messages]);
  // Explains a flipped-off auto-reply toggle in the transcript itself
  // (2026-10-29 kiop incident: with a2a_auto_reply_enabled=0 every peer reply
  // used to vanish, looking like messages lost in transit). Every processed
  // inbound A2A bubble stamps which way the bot's auto-reply policy went
  // (a2aAutoReplyActive vs autoReplySuppressed); the last marker wins, so the
  // banner clears itself as soon as a newer message was answered again — no
  // metabot-settings plumbing into the session view needed. Bubbles from
  // before the markers existed carry neither and stay neutral.
  const a2aAutoReplySuppressed = useMemo(() => {
    if (!isPrivateA2ASession) return false;
    let suppressed = false;
    for (const message of currentSession?.messages ?? []) {
      if (message.metadata?.a2aAutoReplyActive === true) suppressed = false;
      if (message.metadata?.autoReplySuppressed === true) suppressed = true;
    }
    return suppressed;
  }, [isPrivateA2ASession, currentSession?.messages]);
  // Quota call-to-action banner (REQ-A-25): follows the LIVE error state
  // (status 'error' + newest system error carries the quota code), never the
  // whole transcript — see quotaErrorBanner.ts for why. Covers both machine
  // codes: free_quota_exhausted (never had purchased quota) and the new C4
  // quota_exhausted (purchased pool used up).
  const quotaExhausted = useMemo(
    () => isQuotaExhaustedErrorLive(currentSession?.messages, currentSession?.status),
    [currentSession?.messages, currentSession?.status],
  );
  // Runtime split for the banner action (REQ-A-25): desktop keeps the
  // Settings > Models shortcut; the mobile web app offers recharge instead
  // (no Settings > Models surface exists there — see
  // services/isMobileRuntime.ts for the detection seam).
  const isMobile = useMemo(() => isMobileRuntime(), []);
  // Cause text for the A2A error banner: the newest system error message.
  // System bubbles are hidden in the A2A view, so without this the banner
  // says "something failed" without ever showing what.
  const a2aSessionErrorDetail = useMemo(() => (
    isA2ASession ? lastA2AErrorDetail(currentSession?.messages ?? []) : null
  ), [isA2ASession, currentSession?.messages]);
  const [isClearingA2AError, setIsClearingA2AError] = useState(false);
  const handleDismissA2AErrorBanner = useCallback(async () => {
    if (!currentSession || isClearingA2AError) return;
    setIsClearingA2AError(true);
    try {
      await coworkService.clearSessionError(currentSession.id);
    } finally {
      setIsClearingA2AError(false);
    }
  }, [currentSession, isClearingA2AError]);
  // Latest SDK prompt suggestion for the follow-up chips. The SDK emits at most
  // one per turn (after the result message); we surface the most recent one.
  const latestPromptSuggestion = useMemo(() => {
    const messages = currentSession?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const suggestion = messages[i]?.metadata?.promptSuggestion;
      if (typeof suggestion === 'string' && suggestion.trim()) {
        return suggestion.trim();
      }
    }
    return null;
  }, [currentSession?.messages]);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const currentModelId = useSelector((state: RootState) => state.model.selectedModel?.id);
  // Title of the session this conversation was branched from, resolved from the
  // session list for the "branched from" hint above the composer.
  const branchedFromTitle = useSelector((state: RootState) => {
    const parentId = currentSession?.parentSessionId;
    if (!parentId) return null;
    return state.cowork.sessions.find((session) => session.id === parentId)?.title ?? null;
  });
  // Per-session model override (picked in this conversation's model selector).
  // Optimistic local state on top of the persisted currentSession.model; reset
  // when switching sessions. Provider rides along so colliding model ids
  // (OpenCode vs DeepSeek both serving deepseek-v4-flash) stay disambiguated.
  const [sessionModelOverride, setSessionModelOverride] = useState<{
    modelId: string | null;
    providerKey: string | null;
  } | null>(null);
  useEffect(() => {
    setSessionModelOverride(null);
  }, [currentSession?.id]);
  // Current git branch of the session's working directory, shown next to the
  // folder chip when the directory is inside a git repository. Polled on a
  // short interval (plus window focus / tab re-visibility) so a branch switch
  // in the working directory — e.g. `git checkout feat/x` in a terminal — is
  // reflected in the header without reopening the session: the chip must show
  // the branch the agent is actually on. Same-value updates are skipped so an
  // unchanged branch never triggers a re-render.
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  // Project display name for a project-bound session (looked up from Settings >
  // Projects so the header can show the project name instead of its source dir).
  const [boundProject, setBoundProject] = useState<{ name: string; icon?: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    setBoundProject(null);
    if (!currentSession?.id) return;
    if (currentSession.projectId) {
      projectsService.loadProjects()
        .then((list) => {
          const project = list.find((p) => p.id === currentSession.projectId);
          if (active && project) setBoundProject({ name: project.name, icon: project.icon });
        })
        .catch(() => { if (active) setBoundProject(null); });
    }
    return () => { active = false; };
  }, [currentSession?.id, currentSession?.projectId]);
  useEffect(() => {
    let active = true;
    setGitBranch(null);
    if (!currentSession?.id || !currentSession.cwd) return;
    const cwd = currentSession.cwd;
    // In-flight guard: a probe that outlives the 3s interval (git hung on a
    // network drive despite the 2s main-process timeout) must not pile up
    // overlapping probes — skip while one is still settling.
    let probeInFlight = false;
    // Consecutive failures mean "not a git repo" (the normal case for
    // arbitrary working dirs). Stop the interval after three to avoid
    // spawning a failing `git` child every 3s forever; focus/visibility
    // refreshes still re-probe so a later `git init` is picked up.
    let consecutiveFailures = 0;
    const refresh = async () => {
      // Skip while the tab is hidden/backgrounded: the branch cannot change
      // through the UI here, and idle git probes waste nothing useful.
      if (!active || probeInFlight || document.visibilityState !== 'visible') return;
      probeInFlight = true;
      try {
        const branch = (await window.electron?.getGitBranch?.(cwd)) ?? null;
        if (active) setGitBranch((prev) => (prev === branch ? prev : branch));
        consecutiveFailures = branch === null ? consecutiveFailures + 1 : 0;
      } catch {
        if (active) setGitBranch(null);
        consecutiveFailures += 1;
      } finally {
        probeInFlight = false;
      }
    };
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const poll = () => {
      if (consecutiveFailures >= 3) return;
      void refresh();
    };
    const interval = window.setInterval(poll, 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [currentSession?.id, currentSession?.cwd]);
  const sessionModelId = sessionModelOverride
    ? sessionModelOverride.modelId
    : (currentSession?.model ?? null);
  const sessionModelProvider = sessionModelOverride
    ? sessionModelOverride.providerKey
    : (currentSession?.modelProvider ?? null);
  // Per-session effort picked in the composer's model+effort picker. Optimistic
  // local state on top of the persisted currentSession.effort; reset when
  // switching sessions. Holds the wire vocabulary: a canonical rung, or the
  // 'default' sentinel for the "Auto" rung (cerebellum picks per message,
  // degrading to the model default when no verdict lands — never the brain /
  // global rungs a plain null falls back to).
  const [sessionEffortOverride, setSessionEffortOverride] = useState<string | null>(null);
  useEffect(() => {
    setSessionEffortOverride(null);
  }, [currentSession?.id]);
  const handleSessionModelEffortChange = async (value: ModelEffortValue) => {
    if (!currentSession) return;
    setSessionModelOverride({
      modelId: value.modelId,
      providerKey: value.providerKey ?? null,
    });
    setSessionEffortOverride(value.effort ?? LLM_EFFORT_DEFAULT_SENTINEL);
    try {
      await window.electron?.cowork?.setSessionModel({
        sessionId: currentSession.id,
        model: value.modelId,
        modelProvider: value.providerKey ?? null,
        effort: value.effort ?? LLM_EFFORT_DEFAULT_SENTINEL,
      });
    } catch (modelError) {
      console.error('Failed to set session model:', modelError);
      setSessionModelOverride(null);
      setSessionEffortOverride(null);
    }
  };
  const [branchActionError, setBranchActionError] = useState<string | null>(null);
  // Branch in a new chat: copies the conversation up to and including the
  // assistant message into a fresh session and switches to it. The forked
  // session records its origin (parentSessionId) for the "branched from" hint.
  //
  // Read through a ref so the callback identity survives stream updates:
  // `currentSession` is replaced on every flush, and a new `onBranch` would
  // break AssistantTurnBlock's memo for the whole transcript.
  const branchRequestRef = useRef<{ sessionId: string | null; isStreaming: boolean }>({
    sessionId: null,
    isStreaming: false,
  });
  useEffect(() => {
    branchRequestRef.current = { sessionId: currentSession?.id ?? null, isStreaming };
  }, [currentSession?.id, isStreaming]);
  const handleBranchFromMessage = useCallback(async (msg: CoworkMessage) => {
    const { sessionId, isStreaming: streaming } = branchRequestRef.current;
    if (!sessionId || streaming) return;
    setBranchActionError(null);
    const forked = await coworkService.forkSession(sessionId, msg.id);
    if (!forked) {
      setBranchActionError(i18nService.t('coworkForkFailed'));
    }
  }, []);
  const detailRootRef = useRef<HTMLDivElement>(null);
  // In-app document viewer sidebar: .md/.markdown and .html/.htm file links
  // in assistant messages open in this right-hand panel instead of an
  // external app (markdown renders as text, HTML as a sandboxed preview).
  // The width is a fraction of the session area (default 1/4, clamped to at
  // most 1/2) and is persisted across sessions.
  const [markdownViewerPath, setMarkdownViewerPath] = useState<string | null>(null);
  const [markdownViewerFraction, setMarkdownViewerFraction] = useState<number>(loadPersistedMarkdownViewerFraction);
  const markdownViewerFractionRef = useRef(markdownViewerFraction);
  const markdownViewerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isMarkdownViewerResizing, setIsMarkdownViewerResizing] = useState(false);

  const handleOpenLocalFile = useCallback((filePath: string): boolean => {
    if (!MARKDOWN_FILE_RE.test(filePath) && !HTML_FILE_RE.test(filePath)) return false;
    setMarkdownViewerPath(filePath);
    return true;
  }, []);

  const handleMarkdownViewerResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const containerWidth = detailRootRef.current?.clientWidth ?? 0;
    if (containerWidth <= 0) return;
    markdownViewerResizeRef.current = {
      startX: event.clientX,
      startWidth: containerWidth * markdownViewerFractionRef.current,
    };
    setIsMarkdownViewerResizing(true);
  }, []);

  const handleMarkdownViewerResizeReset = useCallback(() => {
    markdownViewerFractionRef.current = MARKDOWN_VIEWER_DEFAULT_FRACTION;
    setMarkdownViewerFraction(MARKDOWN_VIEWER_DEFAULT_FRACTION);
    try {
      window.localStorage.setItem(MARKDOWN_VIEWER_WIDTH_STORAGE_KEY, String(MARKDOWN_VIEWER_DEFAULT_FRACTION));
    } catch {
      // Storage unavailable: keep the in-memory default.
    }
  }, []);

  useEffect(() => {
    if (!isMarkdownViewerResizing) return;
    const handleMouseMove = (event: MouseEvent) => {
      const resizeState = markdownViewerResizeRef.current;
      const containerWidth = detailRootRef.current?.clientWidth ?? 0;
      if (!resizeState || containerWidth <= 0) return;
      // The panel is pinned to the right edge: dragging left grows it.
      const nextWidth = resizeState.startWidth + (resizeState.startX - event.clientX);
      const nextFraction = clampMarkdownViewerWidth(nextWidth, containerWidth) / containerWidth;
      markdownViewerFractionRef.current = nextFraction;
      setMarkdownViewerFraction(nextFraction);
    };
    const handleMouseUp = () => {
      setIsMarkdownViewerResizing(false);
      markdownViewerResizeRef.current = null;
      try {
        window.localStorage.setItem(MARKDOWN_VIEWER_WIDTH_STORAGE_KEY, String(markdownViewerFractionRef.current));
      } catch {
        // Storage unavailable: the width stays session-local.
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isMarkdownViewerResizing]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const conversationSearchRef = useRef<CoworkConversationSearchHandle>(null);
  const [isConversationSearchOpen, setIsConversationSearchOpen] = useState(false);
  const supportsConversationSearch = currentSession?.sessionType !== 'a2a';
  const handleConversationSearchNavigate = useCallback(() => {
    setShouldAutoScroll(false);
  }, []);
  // Quoted-selection state: the pending selection (before it is added), the
  // element the floating bar hangs off, the live range it follows, and the
  // composer it is handed to.
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  const quoteActionBarRef = useRef<HTMLDivElement>(null);
  const quoteAnchorRef = useRef<HTMLElement | null>(null);
  const quoteLiveRangeRef = useRef<Range | null>(null);
  const [pendingQuoteSelection, setPendingQuoteSelection] = useState<PendingQuotedSelection | null>(null);
  const [quoteActionPlacement, setQuoteActionPlacement] = useState<PopoverPlacement | null>(null);
  const messageElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const consumedOrderFocusKeyRef = useRef<string | null>(null);
  const lastAutoScrollSessionIdRef = useRef<string | null>(null);
  const skipNextAutoScrollEffectRef = useRef(false);
  // One-shot: a submission that carries a quote block arms it; the arrival of
  // the reply consumes it (see the follow effect). `shouldAutoScroll` is never
  // touched on this path — the "back to bottom" button must stay available
  // while the owner waits parked at the quoted message.
  const pendingQuoteReplyFollowRef = useRef(false);
  const pinningScrollRef = useRef(false);
  const focusHighlightTimeoutRef = useRef<number | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const historyLoadInFlightRef = useRef(false);
  const [isLoadingEarlierMessages, setIsLoadingEarlierMessages] = useState(false);
  const [focusedOrderMessageId, setFocusedOrderMessageId] = useState<string | null>(null);
  const [liveExecutionMode, setLiveExecutionMode] = useState<{
    sessionId: string;
    mode: CoworkExecutionMode;
  } | null>(null);

  // Menu and action states
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const [isExportingImage, setIsExportingImage] = useState(false);

  // Rename states
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);
  const [sessionMetabot, setSessionMetabot] = useState<{ name: string; avatar: string | null; avatar_fallback?: string | null; llm_id: string | null; llm_provider?: string | null; llm_effort?: string | null; fallback_llm_id?: string | null; globalmetaid: string | null; metabot_type: string } | null>(null);
  // MetaApps embedded in this session's assistant bubbles act as the session
  // Bot (idbots-metabot-<id>, the actor id botBrowserBridgeService resolves to
  // that Bot's wallet). Name/globalMetaId ride along for the app's
  // browser.actor.current view; null when the session has no Bot.
  const inlineMetaAppActor = useMemo<InlineMetaAppActor | null>(() => {
    const metabotId = currentSession?.metabotId;
    const actorId = typeof metabotId === 'number' ? buildLocalMetabotActorId(metabotId) : '';
    if (!actorId) return null;
    return {
      actorId,
      name: sessionMetabot?.name || currentSession?.metabotName || '',
      globalMetaId: sessionMetabot?.globalmetaid || '',
    };
  }, [currentSession?.metabotId, currentSession?.metabotName, sessionMetabot?.name, sessionMetabot?.globalmetaid]);
  // Picker value: session pick wins, else the bound bot's brain (model id or
  // legacy provider key — the picker resolves legacy keys for display), else
  // nothing (global default). Effort mirrors the runtime tiering:
  // session pick > bot brain effort > model default; the persisted global
  // effort only fills in when the session has no bot brain at all. A
  // persisted 'default' sentinel (explicit Auto pick) converts to null and
  // displays as Auto instead of snapping to a fallback rung.
  // Assistant mode displays the Auto rung when the session carries no explicit
  // pick: the turn resolves through the cerebellum auto selector when
  // configured (casual off, correctness-risk escalates) and falls back to off
  // otherwise — the brain/global rungs are skipped either way.
  const sessionUsesBrainModel = sessionModelId == null && Boolean(sessionMetabot?.llm_id);
  const sessionModelEffortValue: ModelEffortValue = {
    modelId: sessionModelId ?? sessionMetabot?.llm_id ?? null,
    providerKey: sessionUsesBrainModel
      ? (sessionMetabot?.llm_provider ?? null)
      : sessionModelProvider,
    effort: (() => {
      if (sessionEffortOverride != null) return convertLegacyEffortLevel(sessionEffortOverride);
      if (currentSession?.effort) return convertLegacyEffortLevel(currentSession.effort);
      if (isAssistantMode) return null;
      if (sessionMetabot?.llm_effort) return convertLegacyEffortLevel(sessionMetabot.llm_effort);
      if (sessionMetabot?.llm_id || sessionMetabot?.fallback_llm_id) return null;
      return convertLegacyEffortLevel(configService.getConfig().coworkEffortLevel ?? null);
    })(),
  };
  // Whether any local Twin Bot exists yet. Drives the Welcome Bot's handoff
  // hint (no Twin → keep nudging) and its retirement banner (Twin exists →
  // offer to retire). Refreshed when a turn settles so a Twin created mid-chat
  // by the Welcome Bot flips the UI without a manual reload. `null` = not yet
  // loaded, so neither banner flashes before the roster resolves.
  const [hasTwinBot, setHasTwinBot] = useState<boolean | null>(null);
  const [isRetiringWelcome, setIsRetiringWelcome] = useState(false);
  const [retireWelcomeError, setRetireWelcomeError] = useState<string | null>(null);
  const [fetchedPeerAvatar, setFetchedPeerAvatar] = useState<string | null>(null);
  const [isProcessingRefund, setIsProcessingRefund] = useState(false);
  const [refundActionError, setRefundActionError] = useState<string | null>(null);
  const [dismissedRefundStatusKeys, setDismissedRefundStatusKeys] = useState<Set<string>>(() => readDismissedRefundStatusKeys());
  const [delegationBlocking, setDelegationBlocking] = useState(false);
  const [isEndingA2A, setIsEndingA2A] = useState(false);
  const [a2aEndError, setA2AEndError] = useState<string | null>(null);
  const [resendingDeliveryOrderTxid, setResendingDeliveryOrderTxid] = useState<string | null>(null);
  const [resendDeliveryError, setResendDeliveryError] = useState<string | null>(null);
  const serviceOrderOutputType = String(currentSession?.serviceOrderSummary?.outputType || '').trim().toLowerCase();
  const canResendDigitalDelivery = (
    isPrivateA2ASession
    && currentSession?.serviceOrderSummary?.role === 'seller'
    && NON_TEXT_SERVICE_OUTPUT_TYPES.includes(serviceOrderOutputType)
  );
  const visibleA2AMessages = useMemo(() => (
    currentSession?.messages.filter((message) => (
      !shouldHideControlMessage(message)
      && !shouldHideA2AInternalMessage(message, { chainBackedConversation: isPrivateA2ASession })
    )) ?? []
  ), [currentSession?.messages, isPrivateA2ASession]);
  // Episode metadata of the A2A thread — powers the divider cards shown where
  // the visible history crosses an episode rollover boundary.
  const [a2aThreadEpisodes, setA2aThreadEpisodes] = useState<Array<{
    episodeIndex: number;
    endedAt: number | null;
    closeReason: string | null;
    summary: string | null;
  }>>([]);
  useEffect(() => {
    if (!isPrivateA2ASession || !currentSession?.id) {
      setA2aThreadEpisodes([]);
      return;
    }
    let cancelled = false;
    void coworkService.getA2AEpisodes(currentSession.id).then((episodes) => {
      if (!cancelled) setA2aThreadEpisodes(episodes ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [isPrivateA2ASession, currentSession?.id]);
  const a2aEpisodeByIndex = useMemo(() => new Map(
    a2aThreadEpisodes.map((episode) => [episode.episodeIndex, episode]),
  ), [a2aThreadEpisodes]);
  const a2aPeerGlobalMetaId = useMemo(() => {
    if (currentSession?.sessionType !== 'a2a' || currentSession?.imChannel) return null;
    const sessionPeerGlobalMetaId = typeof currentSession.peerGlobalMetaId === 'string'
      ? currentSession.peerGlobalMetaId.trim()
      : '';
    if (sessionPeerGlobalMetaId) return sessionPeerGlobalMetaId;
    const firstIncomingMetadata = currentSession.messages.find(
      (message) => message.metadata?.direction === 'incoming'
    )?.metadata;
    return typeof firstIncomingMetadata?.senderGlobalMetaId === 'string'
      ? firstIncomingMetadata.senderGlobalMetaId.trim() || null
      : null;
  }, [currentSession?.sessionType, currentSession?.peerGlobalMetaId, currentSession?.messages]);

  // S5 friend badge: pair state between the session bot and the A2A peer
  // (S4 metaso provider behind the social:getPairRelationship IPC, main-side
  // 60s TTL cache + breaker). Refreshed when the transcript changes so a
  // just-accepted mutual /follow flips the badge once the indexer catches up.
  const [peerFriendStatus, setPeerFriendStatus] = useState<'confirmed' | 'not_confirmed' | 'unknown' | null>(null);
  const a2aTranscriptLength = currentSession?.messages?.length ?? 0;
  useEffect(() => {
    if (!isA2ASession || !a2aPeerGlobalMetaId || !sessionMetabot?.globalmetaid) {
      setPeerFriendStatus(null);
      return;
    }
    let cancelled = false;
    const observerGlobalMetaId = sessionMetabot.globalmetaid;
    void window.electron?.social?.getPairRelationship({
      observerGlobalMetaId,
      peerGlobalMetaId: a2aPeerGlobalMetaId,
    }).then((result) => {
      if (cancelled) return;
      setPeerFriendStatus(result?.success && result.relationship ? result.relationship.status : null);
    }).catch(() => {
      if (!cancelled) setPeerFriendStatus(null);
    });
    return () => {
      cancelled = true;
    };
  }, [isA2ASession, a2aPeerGlobalMetaId, sessionMetabot?.globalmetaid, a2aTranscriptLength]);
  const a2aPeerIsFriend = peerFriendStatus === 'confirmed';

  // Local user identity (Settings > Users). When the A2A peer IS the
  // configured local user, this session is a direct owner<->bot chat: the
  // local bot's bubbles move to the left, the human's read on the right, and
  // the guidance/end controls give way to a composer. Without a configured
  // identity we cannot tell, so the regular observer UI stays.
  const [ownerGlobalMetaId, setOwnerGlobalMetaId] = useState<string | null>(null);
  useEffect(() => {
    if (!isA2ASession) {
      setOwnerGlobalMetaId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.electron?.userIdentity?.get?.();
        if (cancelled) return;
        const gmid = result?.success && typeof result.identity?.globalmetaid === 'string'
          ? result.identity.globalmetaid.trim()
          : '';
        setOwnerGlobalMetaId(gmid || null);
      } catch {
        if (!cancelled) setOwnerGlobalMetaId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isA2ASession, currentSession?.id]);
  const isA2APeerOwner = Boolean(
    isPrivateA2ASession
    && ownerGlobalMetaId
    && a2aPeerGlobalMetaId
    && a2aPeerGlobalMetaId.toLowerCase() === ownerGlobalMetaId.toLowerCase()
  );
  const normalizedFocusedOrderTxid = normalizeOrderFocusTxid(focusedOrderTxid);
  const refundStatusDismissKey = useMemo(() => (
    buildRefundStatusDismissKey(currentSession?.id, currentSession?.serviceOrderSummary)
  ), [
    currentSession?.id,
    currentSession?.serviceOrderSummary?.role,
    currentSession?.serviceOrderSummary?.paymentTxid,
    currentSession?.serviceOrderSummary?.refundRequestPinId,
    currentSession?.serviceOrderSummary?.refundTxid,
    currentSession?.serviceOrderSummary?.servicePinId,
  ]);
  const shouldRenderRefundStatusCard = Boolean(
    isA2ASession
    && currentSession?.serviceOrderSummary
    && shouldShowRefundStatusCard(currentSession.serviceOrderSummary, {
      dismissKey: refundStatusDismissKey,
      dismissedKeys: dismissedRefundStatusKeys,
    })
  );
  const resolvedExecutionMode = liveExecutionMode?.sessionId === currentSession?.id
    ? liveExecutionMode.mode
    : currentSession?.executionMode;
  const steerDisabled = Boolean(isStreaming && resolvedExecutionMode !== 'local');

  useEffect(() => {
    if (!isStreaming || !currentSession?.id) {
      setLiveExecutionMode(null);
      return;
    }
    let cancelled = false;
    void window.electron?.cowork?.getSession?.(currentSession.id).then((result) => {
      if (cancelled || !result?.success || !result.session) return;
      setLiveExecutionMode({
        sessionId: currentSession.id,
        mode: result.session.executionMode,
      });
    }).catch(() => {
      // Keep auto/sandbox conservative until the main process can confirm local execution.
    });
    return () => {
      cancelled = true;
    };
  }, [currentSession?.id, currentSession?.messages.length, isStreaming]);

  // Fetch initial delegation blocking state when session changes
  useEffect(() => {
    if (!currentSession?.id) {
      setDelegationBlocking(false);
      return;
    }
    let cancelled = false;
    window.electron?.cowork?.isDelegationBlocking?.(currentSession.id)
      .then((blocking: boolean) => {
        if (!cancelled) setDelegationBlocking(!!blocking);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [currentSession?.id]);

  // Listen for delegation state changes from the main process
  useEffect(() => {
    const cleanup = window.electron?.cowork?.onDelegationStateChange?.((data) => {
      if (data.sessionId === currentSession?.id) {
        setDelegationBlocking(data.blocking);
      }
    });
    return () => { cleanup?.(); };
  }, [currentSession?.id]);

  // Fetch MetaBot when session has metabotId (for avatar/name and llm_id for model restriction)
  useEffect(() => {
    const metabotId = currentSession?.metabotId;
    if (metabotId == null || typeof metabotId !== 'number') {
      setSessionMetabot(null);
      return;
    }
    let cancelled = false;
    const fetchMetaBot = async () => {
      const result = await window.electron?.metabot?.get?.(metabotId);
      if (cancelled || !result?.success || !result.metabot) return;
      setSessionMetabot({
        name: result.metabot.name,
        avatar: result.metabot.avatar ?? null,
        llm_id: result.metabot.llm_id ?? null,
        llm_provider: result.metabot.llm_provider ?? null,
        llm_effort: result.metabot.llm_effort ?? null,
        fallback_llm_id: result.metabot.fallback_llm_id ?? null,
        globalmetaid: result.metabot.globalmetaid ?? null,
        metabot_type: result.metabot.metabot_type ?? 'worker',
      });
    };
    void fetchMetaBot();
    return () => { cancelled = true; };
  }, [currentSession?.metabotId]);

  // Track whether a local Twin Bot exists, refreshing whenever a turn settles
  // (isStreaming → false) so the Welcome Bot's handoff hint and retirement
  // banner react to a Twin created mid-conversation.
  useEffect(() => {
    let cancelled = false;
    const loadHasTwin = async () => {
      try {
        const result = await window.electron?.metabot?.list?.();
        if (cancelled || !result?.success || !result.list) return;
        setHasTwinBot(result.list.some((metabot) => metabot.metabot_type === 'twin'));
      } catch {
        // Keep the previous value; this is a best-effort UI hint.
      }
    };
    void loadHasTwin();
    return () => { cancelled = true; };
  }, [currentSession?.id, isStreaming]);

  const isWelcomeSession = sessionMetabot?.metabot_type === 'welcome';
  const showWelcomeRetirement = isWelcomeSession && hasTwinBot === true;
  const showWelcomeHandoff = isWelcomeSession && hasTwinBot === false;

  // Retire the Welcome Bot: delete it now that a Twin Bot exists and return to
  // the New Task home. Historical sessions are preserved (sessions do not
  // cascade-delete with the bot), and the free-quota provisioning gate keeps
  // the welcome bot from being recreated afterwards.
  const handleRetireWelcome = async () => {
    const metabotId = currentSession?.metabotId;
    if (metabotId == null || isRetiringWelcome) return;
    setIsRetiringWelcome(true);
    setRetireWelcomeError(null);
    try {
      const result = await window.electron.idbots.deleteMetaBot(metabotId);
      if (result?.success) {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('coworkWelcomeRetiredToast') }));
        onNavigateHome?.();
      } else {
        setRetireWelcomeError(result?.error || i18nService.t('coworkWelcomeRetireFailed'));
      }
    } catch (error) {
      setRetireWelcomeError(error instanceof Error ? error.message : i18nService.t('coworkWelcomeRetireFailed'));
    } finally {
      setIsRetiringWelcome(false);
    }
  };

  // Fetch peer avatar for A2A sessions when peerAvatar is missing or not directly renderable.
  // Falls back to senderGlobalMetaId from the first incoming message if peerGlobalMetaId is missing.
  useEffect(() => {
    if (currentSession?.sessionType !== 'a2a' || currentSession?.imChannel) {
      setFetchedPeerAvatar(null);
      return;
    }
    if (isRenderableAvatarSource(currentSession.peerAvatar)) {
      setFetchedPeerAvatar(null);
      return;
    }
    const firstIncomingMetadata = currentSession.messages.find(
      (m) => (m.metadata as Record<string, unknown>)?.direction === 'incoming'
    )?.metadata as Record<string, unknown> | undefined;
    const rawPeerAvatarCandidates = [
      currentSession.peerAvatar,
      typeof firstIncomingMetadata?.senderAvatar === 'string' ? firstIncomingMetadata.senderAvatar : null,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    // Resolve peer globalMetaId: prefer session-level, fall back to first incoming message.
    const peerGlobalMetaId = currentSession.peerGlobalMetaId
      ?? firstIncomingMetadata?.senderGlobalMetaId as string | undefined
      ?? null;
    if (!rawPeerAvatarCandidates.length && !peerGlobalMetaId) {
      setFetchedPeerAvatar(null);
      return;
    }
    let cancelled = false;
    const resolvePeerAvatar = async () => {
      for (const candidate of rawPeerAvatarCandidates) {
        try {
          const resolved = await resolveMetaidAvatarSource(candidate);
          if (cancelled) return;
          if (isRenderableAvatarSource(resolved)) {
            setFetchedPeerAvatar(resolved);
            return;
          }
        } catch {
          // Fall through to the next candidate or profile lookup.
        }
      }

      if (!peerGlobalMetaId) {
        if (!cancelled) setFetchedPeerAvatar(null);
        return;
      }

      try {
        const info = await fetchMetaidInfoByGlobalId(peerGlobalMetaId);
        if (!cancelled) setFetchedPeerAvatar(info.avatarUrl ?? null);
      } catch {
        if (!cancelled) setFetchedPeerAvatar(null);
      }
    };
    void resolvePeerAvatar();
    return () => { cancelled = true; };
  }, [currentSession?.id, currentSession?.peerGlobalMetaId, currentSession?.peerAvatar, currentSession?.sessionType, currentSession?.messages]);

  const resolvedPeerAvatar = isRenderableAvatarSource(currentSession?.peerAvatar)
    ? currentSession?.peerAvatar ?? null
    : fetchedPeerAvatar;

  useEffect(() => {
    setIsProcessingRefund(false);
    setRefundActionError(null);
    setIsEndingA2A(false);
    setA2AEndError(null);
    setResendingDeliveryOrderTxid(null);
    setResendDeliveryError(null);
  }, [
    currentSession?.id,
    currentSession?.serviceOrderSummary?.status,
    currentSession?.serviceOrderSummary?.refundRequestPinId,
    currentSession?.serviceOrderSummary?.refundTxid,
  ]);

  const handleProcessServiceRefund = useCallback(async () => {
    if (!currentSession?.id || isProcessingRefund) return;
    setIsProcessingRefund(true);
    setRefundActionError(null);
    const result = await coworkService.processServiceRefund(currentSession.id);
    if (!result.success) {
      setRefundActionError(result.error || i18nService.t('coworkRefundProcessFailed'));
      setIsProcessingRefund(false);
      return;
    }
    setIsProcessingRefund(false);
  }, [currentSession?.id, isProcessingRefund]);

  const handleDismissRefundStatusCard = useCallback(() => {
    if (!refundStatusDismissKey) return;
    setDismissedRefundStatusKeys((previous) => {
      if (previous.has(refundStatusDismissKey)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(refundStatusDismissKey);
      persistDismissedRefundStatusKeys(next);
      return next;
    });
  }, [refundStatusDismissKey]);

  const handleEndA2APrivateChat = useCallback(async () => {
    if (!currentSession?.id || isEndingA2A || isA2AConversationEnded) return;
    setIsEndingA2A(true);
    setA2AEndError(null);
    const result = await coworkService.endA2APrivateChat(currentSession.id);
    if (!result.success) {
      setA2AEndError(result.error || i18nService.t('a2aSessionEndFailed'));
      setIsEndingA2A(false);
      return;
    }
    setIsEndingA2A(false);
  }, [currentSession?.id, isA2AConversationEnded, isEndingA2A]);

  const handleResendDigitalDelivery = useCallback(async (rawOrderTxid: string) => {
    const orderTxid = String(rawOrderTxid || '').trim().toLowerCase();
    if (
      !currentSession?.id
      || resendingDeliveryOrderTxid
      || !canResendDigitalDelivery
      || !/^[0-9a-f]{64}$/.test(orderTxid)
    ) {
      return;
    }
    setResendingDeliveryOrderTxid(orderTxid);
    setResendDeliveryError(null);
    const result = await coworkService.resendA2ADeliveryArtifact({
      sessionId: currentSession.id,
      orderTxid,
    });
    if (!result.success) {
      setResendDeliveryError(result.error || i18nService.t('a2aResendDigitalDeliveryFailed'));
      setResendingDeliveryOrderTxid(null);
      return;
    }
    setResendingDeliveryOrderTxid(null);
  }, [canResendDigitalDelivery, currentSession?.id, resendingDeliveryOrderTxid]);

  // Reset rename value when session changes
  useEffect(() => {
    if (!isRenaming && currentSession) {
      setRenameValue(currentSession.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, currentSession?.title]);

  useLayoutEffect(() => {
    const sessionId = currentSession?.id ?? null;
    if (!sessionId) {
      lastAutoScrollSessionIdRef.current = null;
      return;
    }
    setShouldAutoScroll(true);
    messagesEndRef.current?.scrollIntoView({
      behavior: resolveAutoScrollBehavior(lastAutoScrollSessionIdRef.current, sessionId),
    });
    skipNextAutoScrollEffectRef.current = true;
    lastAutoScrollSessionIdRef.current = sessionId;
  }, [currentSession?.id]);

  useEffect(() => {
    historyLoadInFlightRef.current = false;
    setIsLoadingEarlierMessages(false);
  }, [currentSession?.id]);

  // Load persisted per-message feedback (thumbs up/down) when the session changes
  useEffect(() => {
    if (!currentSession?.id) return;
    void coworkService.loadSessionFeedback(currentSession.id);
  }, [currentSession?.id]);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !actionButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    // The capture listener hears every scroll in the app — including this
    // session's own transcript auto-pinning to the bottom on each streamed
    // chunk while it runs. That scroll never moves the header action button,
    // so it must not dismiss the menu; only scrolls that move the anchor (an
    // ancestor of it, or the document) do.
    const handleScroll = (event: Event) => {
      if (scrollEventMovesAnchor(event, actionButtonRef.current)) closeMenu();
    };
    const handleResize = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [menuPosition]);

  // Helper: truncate path for display
  const truncatePath = (path: string, maxLength = 20): string => {
    if (!path) return i18nService.t('noFolderSelected');
    return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
  };

  // Menu position calculator
  const calculateMenuPosition = (height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const menuWidth = 180;
    const padding = 8;
    const x = Math.min(
      Math.max(padding, rect.right - menuWidth),
      window.innerWidth - menuWidth - padding
    );
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - padding);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) {
      closeMenu();
      return;
    }
    const menuHeight = 160;
    const position = calculateMenuPosition(menuHeight);
    if (position) {
      setMenuPosition(position);
    }
  };

  const closeMenu = () => {
    setMenuPosition(null);
  };

  // ----- Quoted transcript selections ("reply to this specific part") -----
  //
  // Selecting text in the transcript floats a one-item bar ("add to
  // conversation"); adding the selection hands it to the composer as a
  // removable fragment, which then rides into the prompt body of the next
  // message. Placement reuses the repository's shared anchored-popover
  // helpers instead of hand-rolled positioning.
  const updateQuoteActionPlacement = useCallback(() => {
    const anchorRect = quoteAnchorRef.current?.getBoundingClientRect() ?? null;
    const liveRect = quoteLiveRangeRef.current?.getBoundingClientRect() ?? null;
    const rect = resolveQuoteActionBarAnchorRect(liveRect, anchorRect);
    if (!rect) return;
    const barRect = quoteActionBarRef.current?.getBoundingClientRect() ?? null;
    setQuoteActionPlacement(placePopoverAbove(
      rect,
      { width: barRect?.width ?? QUOTE_ACTION_BAR_WIDTH, height: barRect?.height ?? QUOTE_ACTION_BAR_HEIGHT },
      QUOTE_ACTION_BAR_WIDTH,
    ));
  }, []);

  // The bar is rendered before it can be measured, so re-place once it is in
  // the DOM and its real size is known. Keyed on the pending selection, not on
  // the placement itself (that state object is replaced by every placement,
  // which would make this effect its own trigger).
  useLayoutEffect(() => {
    if (!pendingQuoteSelection) return;
    updateQuoteActionPlacement();
  }, [pendingQuoteSelection, updateQuoteActionPlacement]);

  useAnchorMoveWatcher(quoteAnchorRef, pendingQuoteSelection !== null, updateQuoteActionPlacement);

  const captureQuoteSelection = useCallback(() => {
    const container = scrollContainerRef.current;
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPendingQuoteSelection(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setPendingQuoteSelection(null);
      return;
    }
    const block = quoteTranscriptBlockOf(range.commonAncestorContainer);
    // A whitespace-only selection is not a selection: it produces nothing.
    const pending = createPendingQuotedSelection(
      selection.toString(),
      block?.getAttribute('data-export-role') ?? null,
    );
    if (!pending) {
      setPendingQuoteSelection(null);
      return;
    }
    quoteLiveRangeRef.current = range;
    quoteAnchorRef.current = block ?? container;
    setPendingQuoteSelection(pending);
    updateQuoteActionPlacement();
  }, [updateQuoteActionPlacement]);

  const handleTranscriptSelectionEnd = useCallback(() => {
    captureQuoteSelection();
  }, [captureQuoteSelection]);

  const handleTranscriptSelectionKeyUp = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // Shift+arrow selections extend a selection without any mouse event.
    if (event.shiftKey) captureQuoteSelection();
  }, [captureQuoteSelection]);

  const handleAddQuoteToConversation = useCallback(() => {
    const pending = pendingQuoteSelection;
    setPendingQuoteSelection(null);
    quoteLiveRangeRef.current = null;
    quoteAnchorRef.current = null;
    if (!pending) return;
    const fragment = createQuotedSelection(pending.text, pending.role);
    if (!fragment) return;
    promptInputRef.current?.addQuotedSelection(fragment);
    promptInputRef.current?.focus();
    // The passage now lives in the composer; drop the browser selection so the
    // transcript does not keep showing a highlight for text that is already in.
    if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges();
  }, [pendingQuoteSelection]);

  // Dismiss the bar on Escape, and on a click that starts somewhere else (a
  // click INSIDE the transcript is followed by a fresh selection, which
  // re-captures on mouseup — dismissing first would only flicker).
  useEffect(() => {
    if (!pendingQuoteSelection) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && quoteActionBarRef.current?.contains(target)) return;
      if (target && scrollContainerRef.current?.contains(target)) return;
      setPendingQuoteSelection(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPendingQuoteSelection(null);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [pendingQuoteSelection]);

  // Open folder in Finder/Explorer
  const handleOpenFolder = useCallback(async () => {
    if (!currentSession?.cwd) return;
    try {
      await window.electron.shell.openPath(currentSession.cwd);
    } catch (error) {
      console.error('Failed to open folder:', error);
    }
  }, [currentSession?.cwd]);

  const handleCopyHeaderValue = useCallback((value: string) => {
    const normalized = value.trim();
    if (!normalized || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }
    void navigator.clipboard.writeText(normalized).catch(() => {});
  }, []);

  // Rename handlers
  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession) return;
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setRenameValue(currentSession.title);
    setMenuPosition(null);
  };

  const handleRenameSave = async (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    if (!currentSession) return;
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle && nextTitle !== currentSession.title) {
      await coworkService.renameSession(currentSession.id, nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    if (currentSession) {
      setRenameValue(currentSession.title);
    }
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  // Pin/unpin handler
  const handleTogglePin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession) return;
    await coworkService.setSessionPinned(currentSession.id, !currentSession.pinned);
    closeMenu();
  };

  // Archive is reversible (Settings → Archived Chats can restore), so a single
  // archive applies immediately without a confirmation step.
  const handleDeleteClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuPosition(null);
    if (!currentSession) return;
    await coworkService.archiveSession(currentSession.id);
    if (onNavigateHome) {
      onNavigateHome();
    }
  };

  const handleShareClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession || isExportingImage) return;
    closeMenu();
    setIsExportingImage(true);

    window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const scrollContainer = scrollContainerRef.current;
          if (!scrollContainer) {
            throw new Error('Capture target not found');
          }
          const initialScrollTop = scrollContainer.scrollTop;
          try {
            const scrollRect = domRectToCaptureRect(scrollContainer.getBoundingClientRect());
            if (scrollRect.width <= 0 || scrollRect.height <= 0) {
              throw new Error('Invalid capture area');
            }

            const scrollContentHeight = Math.max(scrollContainer.scrollHeight, scrollContainer.clientHeight);
            if (scrollContentHeight <= 0) {
              throw new Error('Invalid content height');
            }

            const toContentY = (viewportY: number): number => {
              const y = scrollContainer.scrollTop + (viewportY - scrollRect.y);
              return Math.max(0, Math.min(scrollContentHeight, y));
            };

            const userAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="user-message"]');
            const assistantAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="assistant-block"]');

            let contentStart = 0;
            let contentEnd = scrollContentHeight;

            if (userAnchors.length > 0) {
              contentStart = toContentY(userAnchors[0].getBoundingClientRect().top);
            } else if (assistantAnchors.length > 0) {
              contentStart = toContentY(assistantAnchors[0].getBoundingClientRect().top);
            }

            if (assistantAnchors.length > 0) {
              const lastAssistant = assistantAnchors[assistantAnchors.length - 1];
              contentEnd = toContentY(lastAssistant.getBoundingClientRect().bottom);
            } else if (userAnchors.length > 0) {
              const lastUser = userAnchors[userAnchors.length - 1];
              contentEnd = toContentY(lastUser.getBoundingClientRect().bottom);
            }

            const maxStart = Math.max(0, scrollContentHeight - 1);
            contentStart = Math.max(0, Math.min(maxStart, Math.round(contentStart)));
            contentEnd = Math.max(contentStart + 1, Math.min(scrollContentHeight, Math.round(contentEnd)));

            const outputHeight = contentEnd - contentStart;

            if (outputHeight > MAX_EXPORT_CANVAS_HEIGHT) {
              throw new Error(`Export image is too tall (${outputHeight}px)`);
            }

            const segmentsEstimate = Math.ceil(outputHeight / Math.max(1, scrollRect.height)) + 1;
            if (segmentsEstimate > MAX_EXPORT_SEGMENTS) {
              throw new Error('Export image is too long');
            }

            const canvas = document.createElement('canvas');
            canvas.width = scrollRect.width;
            canvas.height = outputHeight;
            const context = canvas.getContext('2d');
            if (!context) {
              throw new Error('Canvas context unavailable');
            }

            const captureAndLoad = async (rect: CaptureRect): Promise<HTMLImageElement> => {
              const chunk = await coworkService.captureSessionImageChunk({ rect });
              if (!chunk.success || !chunk.pngBase64) {
                throw new Error(chunk.error || 'Failed to capture image chunk');
              }
              return loadImageFromBase64(chunk.pngBase64);
            };

            scrollContainer.scrollTop = Math.min(contentStart, Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight));
            await waitForNextFrame();
            await waitForNextFrame();

            const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            let contentOffset = contentStart;
            while (contentOffset < contentEnd) {
              const targetScrollTop = Math.min(contentOffset, maxScrollTop);
              scrollContainer.scrollTop = targetScrollTop;
              await waitForNextFrame();
              await waitForNextFrame();

              const chunkImage = await captureAndLoad(scrollRect);
              const sourceYOffset = Math.max(0, contentOffset - targetScrollTop);
              const drawableHeight = Math.min(scrollRect.height - sourceYOffset, contentEnd - contentOffset);
              if (drawableHeight <= 0) {
                throw new Error('Failed to stitch export image');
              }
              const scaleY = chunkImage.naturalHeight / scrollRect.height;
              const sourceYInImage = Math.max(0, Math.round(sourceYOffset * scaleY));
              const sourceHeightInImage = Math.max(1, Math.min(
                chunkImage.naturalHeight - sourceYInImage,
                Math.round(drawableHeight * scaleY),
              ));

              context.drawImage(
                chunkImage,
                0,
                sourceYInImage,
                chunkImage.naturalWidth,
                sourceHeightInImage,
                0,
                contentOffset - contentStart,
                scrollRect.width,
                drawableHeight,
              );

              contentOffset += drawableHeight;
            }

            const pngDataUrl = canvas.toDataURL('image/png');
            const base64Index = pngDataUrl.indexOf(',');
            if (base64Index < 0) {
              throw new Error('Failed to encode export image');
            }

            const timestamp = formatExportTimestamp(new Date());
            const saveResult = await coworkService.saveSessionResultImage({
              pngBase64: pngDataUrl.slice(base64Index + 1),
              defaultFileName: sanitizeExportFileName(`${currentSession.title}-${timestamp}.png`),
            });
            if (saveResult.success && !saveResult.canceled) {
              window.dispatchEvent(new CustomEvent('app:showToast', {
                detail: i18nService.t('coworkExportImageSuccess'),
              }));
              return;
            }
            if (!saveResult.success) {
              throw new Error(saveResult.error || 'Failed to export image');
            }
          } finally {
            scrollContainer.scrollTop = initialScrollTop;
          }
        } catch (error) {
          console.error('Failed to export session image:', error);
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkExportImageFailed'),
          }));
        } finally {
          setIsExportingImage(false);
        }
      })();
    });
  };

  const loadEarlierMessages = useCallback(async () => {
    const sessionId = currentSession?.id;
    const history = currentSession?.messageHistory;
    const container = scrollContainerRef.current;
    // Every session kind opens on a bounded newest-messages window, so this
    // walks the transcript downwards for standard sessions exactly as it does
    // for A2A ones. NOTE: no cursor guard here. For A2A sessions a null
    // beforeSequence with hasMoreBefore=true is the episode-rollover state:
    // the current episode's window fits entirely, and the service pages into
    // the PREVIOUS episodes of the thread (first cross-episode page uses the
    // null-null cursor). Guarding on beforeSequence dead-ends the history
    // right after a rollover, and a non-A2A window carries its own cursor.
    if (
      !sessionId
      || !history?.hasMoreBefore
      || !container
      || historyLoadInFlightRef.current
    ) {
      return 0;
    }
    historyLoadInFlightRef.current = true;
    setIsLoadingEarlierMessages(true);
    const previousScrollHeight = container.scrollHeight;
    const previousScrollTop = container.scrollTop;
    try {
      const loadedCount = await coworkService.loadEarlierMessages(sessionId);
      if (loadedCount <= 0) return loadedCount;
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          const activeContainer = scrollContainerRef.current;
          if (activeContainer) {
            const addedHeight = activeContainer.scrollHeight - previousScrollHeight;
            activeContainer.scrollTop = previousScrollTop + Math.max(0, addedHeight);
          }
          resolve();
        });
      });
      return loadedCount;
    } finally {
      historyLoadInFlightRef.current = false;
      setIsLoadingEarlierMessages(false);
    }
  }, [currentSession?.id, currentSession?.messageHistory]);

  useEffect(() => {
    if (
      !isA2ASession
      || !currentSession?.id
      || visibleA2AMessages.length > 0
      || !currentSession.messageHistory?.hasMoreBefore
    ) {
      return;
    }
    void coworkService.loadEarlierMessages(currentSession.id);
  }, [
    isA2ASession,
    currentSession?.id,
    currentSession?.messageHistory?.hasMoreBefore,
    visibleA2AMessages.length,
  ]);

  // Rail-initiated "load earlier": same page fetch, different landing.
  //
  // loadEarlierMessages deliberately keeps the reading position fixed when new
  // history lands above (scrollTop += addedHeight). That is right for an
  // incidental scroll-to-top, but wrong when the reader explicitly asks for
  // older turns from the rail: the page lands above the viewport, the new marks
  // appear off-screen, and the click reads as "nothing happened". Here, after
  // the fetch grows the transcript, we bring the oldest rendered turn into view
  // so the newly loaded turns are where the reader is looking. The target is
  // resolved from the DOM rather than from the rail's item list, so this
  // callback does not depend on state declared later in the component.
  const handleTurnNavigatorLoadEarlier = useCallback(async () => {
    const container = scrollContainerRef.current;
    const beforeHeight = container?.scrollHeight ?? 0;
    await loadEarlierMessages();
    const activeContainer = scrollContainerRef.current;
    if (!activeContainer || activeContainer.scrollHeight <= beforeHeight) return;
    setShouldAutoScroll(false);
    // Wait for the prepended page to be laid out. loadEarlierMessages resolves
    // after its own one-frame scroll compensation, but the prepended messages
    // render on a later commit, so aiming immediately lands on stale geometry
    // and the browser then keeps that offset as the content grows. Two frames
    // puts us after that commit.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
    const settled = scrollContainerRef.current;
    if (!settled) return;
    const oldest = settled.querySelector<HTMLElement>('[data-message-id]');
    if (oldest) {
      oldest.scrollIntoView({ block: 'start' });
      return;
    }
    // No anchor to aim at: the prepended page sits directly above the previous
    // head, so the top is where the newly loaded turns begin.
    settled.scrollTop = 0;
  }, [loadEarlierMessages]);

  const handleMessagesScroll = useCallback(() => {
    if (pinningScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceToBottom <= AUTO_SCROLL_THRESHOLD;
    setShouldAutoScroll((prev) => (prev === isNearBottom ? prev : isNearBottom));
    if (container.scrollTop <= AUTO_SCROLL_THRESHOLD) {
      void loadEarlierMessages();
    }
  }, [loadEarlierMessages]);

  // DSH WebUI "back to bottom" button: instant jump, then resume follow mode.
  const handleScrollToBottomClick = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    pinningScrollRef.current = true;
    pinScrollToBottom(container);
    pinningScrollRef.current = false;
    setShouldAutoScroll(true);
  }, []);

  const autoScrollFollowSignal = buildAutoScrollFollowSignal(currentSession?.messages, isStreaming);

  const resolveLocalFilePath = useCallback(
    (href: string, text: string) => resolveLocalPathAgainstCwd(href, text, {
      cwd: currentSession?.cwd,
      executionMode: currentSession?.executionMode,
    }),
    [currentSession?.cwd, currentSession?.executionMode],
  );

  const mapDisplayText = useCallback((value: string): string => {
    if (currentSession?.executionMode !== 'sandbox') {
      return value;
    }
    return mapSandboxGuestPathsInText(value, currentSession?.cwd);
  }, [currentSession?.cwd, currentSession?.executionMode]);

  const clearFocusHighlightTimeout = useCallback(() => {
    if (focusHighlightTimeoutRef.current != null) {
      window.clearTimeout(focusHighlightTimeoutRef.current);
      focusHighlightTimeoutRef.current = null;
    }
  }, []);

  // Stick to the bottom when new messages arrive or streaming content grows.
  // useLayoutEffect runs before paint so the user never sees a frame where
  // the transcript has grown and the viewport has not yet followed.
  useLayoutEffect(() => {
    // A quote reply sent while the owner was parked at the quoted message
    // (the confirmation window) must still follow when its reply arrives: the
    // gate is closed on purpose during the wait, so the one-shot flag bypasses
    // it for exactly this run and is consumed here — the forced scroll lands
    // near the bottom, and the ordinary near-bottom mechanics take over from
    // there.
    const quoteReplyArrived = shouldFollowPendingQuoteReply(
      currentSession?.messages,
      pendingQuoteReplyFollowRef.current,
    );
    if (!shouldAutoScroll && !quoteReplyArrived) {
      return;
    }
    if (skipNextAutoScrollEffectRef.current) {
      skipNextAutoScrollEffectRef.current = false;
      return;
    }
    if (quoteReplyArrived) {
      pendingQuoteReplyFollowRef.current = false;
    }
    const sessionId = currentSession?.id ?? null;
    if (isStreaming) {
      const container = scrollContainerRef.current;
      if (!container) return;
      pinningScrollRef.current = true;
      pinScrollToBottom(container);
      pinningScrollRef.current = false;
      lastAutoScrollSessionIdRef.current = sessionId;
      return;
    }
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({
        behavior: resolveAutoScrollBehavior(lastAutoScrollSessionIdRef.current, sessionId),
        block: 'end',
      });
      lastAutoScrollSessionIdRef.current = sessionId;
    }
  }, [currentSession?.id, autoScrollFollowSignal, isStreaming, shouldAutoScroll]);

  // Send path for the one-shot follow above: a submission that carries a quote
  // block — a per-message reply or a hand-picked selection, both of which open
  // the composed body with their generated block — arms the flag. Every submit
  // re-decides it, so a later plain message clears a stale one. The quoted ids
  // ride through untouched (the persistence side anchors the sent blocks).
  const handlePromptSubmit = useCallback((
    prompt: string,
    skillPrompt?: string,
    quotedMessageIds?: string[],
  ) => {
    pendingQuoteReplyFollowRef.current = parseSentQuoteBlock(prompt) !== null
      || parseSentSelectionQuoteBlock(prompt, buildSentSelectionQuoteLabelSets()) !== null;
    return onContinue(prompt, skillPrompt, quotedMessageIds);
  }, [onContinue]);

  useEffect(() => {
    consumedOrderFocusKeyRef.current = null;
    clearFocusHighlightTimeout();
    setFocusedOrderMessageId(null);
  }, [currentSession?.id, clearFocusHighlightTimeout]);

  useEffect(() => {
    return () => {
      clearFocusHighlightTimeout();
    };
  }, [clearFocusHighlightTimeout]);

  useEffect(() => {
    if (!isA2ASession) {
      setFocusedOrderMessageId(null);
      return;
    }
    if (!normalizedFocusedOrderTxid) return;
    if (!shouldRunOrderFocusRequest(consumedOrderFocusKeyRef.current, currentSession?.id, normalizedFocusedOrderTxid)) {
      return;
    }
    const messageId = findFocusedOrderMessageId(visibleA2AMessages, normalizedFocusedOrderTxid);
    if (!messageId) return;
    const focusKey = buildOrderFocusRequestKey(currentSession?.id, normalizedFocusedOrderTxid);
    if (!focusKey) return;
    consumedOrderFocusKeyRef.current = focusKey;
    clearFocusHighlightTimeout();
    setFocusedOrderMessageId(messageId);
    setShouldAutoScroll(false);
    window.requestAnimationFrame(() => {
      messageElementRefs.current[messageId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    focusHighlightTimeoutRef.current = window.setTimeout(() => {
      setFocusedOrderMessageId((current) => (current === messageId ? null : current));
      focusHighlightTimeoutRef.current = null;
    }, 4000);
    onFocusedOrderConsumed?.(normalizedFocusedOrderTxid);
  }, [
    isA2ASession,
    normalizedFocusedOrderTxid,
    visibleA2AMessages,
    currentSession?.id,
    clearFocusHighlightTimeout,
    onFocusedOrderConsumed,
  ]);

  // Memoized on the messages array identity so unrelated re-renders keep
  // stable turn references (AssistantTurnBlock is memoized on its props).
  //
  // A live stream rewrites the messages array on every flush, which used to
  // rebuild every turn object and therefore re-render (and re-parse the
  // Markdown of) the whole transcript. The turns are a pure projection of their
  // messages, so unchanged turns are handed back by identity — only the
  // streaming turn is new.
  const sessionMessages = currentSession?.messages;
  const sessionId = currentSession?.id ?? null;
  const turnsCacheRef = useRef<{ sessionId: string | null; turns: ConversationTurn[] }>({
    sessionId: null,
    turns: [],
  });
  const turns = useMemo(() => {
    const cache = turnsCacheRef.current;
    if (cache.sessionId !== sessionId) {
      cache.sessionId = sessionId;
      cache.turns = [];
    }
    const rebuilt = buildConversationTurns(sessionMessages ? buildDisplayItems(sessionMessages) : []);
    const stable = reuseStableTurns(cache.turns, rebuilt);
    cache.turns = stable;
    return stable;
  }, [sessionMessages, sessionId]);

  // Turn navigator rail: one mark per turn, derived from the same grouped turns
  // the transcript renders. Preview text is plain text with block-level
  // whitespace collapsed, so a multi-paragraph message still reads as one line
  // (prompt) or a short excerpt (response) in the hover card.
  const turnNavigatorItems = useMemo(() => {
    const plainText = (content: string | null | undefined): string => {
      if (!content) return '';
      return content
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };
    return buildTurnNavigatorItems(turns, plainText);
  }, [turns]);

  // Which turn the reader is currently at, for the active mark. Read from the
  // scroll container rather than tracked as state so the rail never drives a
  // re-render of the transcript on scroll.
  const [turnNavigatorActiveId, setTurnNavigatorActiveId] = useState<string | null>(null);
  // One timer for the transient highlight ring (rail jump AND quote jump), so
  // a second jump restarts the window instead of letting the first one clear
  // the mark early. One ref for both: the helper clears every lit ring before
  // lighting the next, so two independent timers could only race to un-ring.
  const transientHighlightTimerRef = useRef<number | null>(null);
  // Clear the ring on unmount and on session switch: the timer holds the
  // element it will un-ring, so leaving it armed would keep a detached node
  // alive and could un-ring a same-id node in the next session.
  useEffect(() => () => {
    if (transientHighlightTimerRef.current != null) {
      window.clearTimeout(transientHighlightTimerRef.current);
      transientHighlightTimerRef.current = null;
    }
  }, [sessionId]);

  // Anchor the active mark to the last user message whose element has scrolled
  // to or above the reading position.
  //
  // Resolution goes through findTranscriptMessageElement — the same transcript
  // lookup the quote-jump path uses — NOT through messageElementRefs. That ref
  // is only populated on the A2A branch, so a standard session would resolve
  // nothing and the rail would neither track nor jump.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || turnNavigatorItems.length === 0) return;
    const resolveActive = () => {
      const containerTop = container.getBoundingClientRect().top;
      // A turn counts as "being read" once its start has entered the upper
      // quarter of the viewport. The band is deliberately generous: an 8px
      // threshold reported NO active turn at the very top of the transcript,
      // because the first message starts below the container's own padding.
      const band = container.clientHeight * 0.25;
      let found: string | null = null;
      for (const item of turnNavigatorItems) {
        if (!item.anchorId) continue;
        const element = findTranscriptMessageElement(container, item.anchorId);
        if (!element) continue;
        if (element.getBoundingClientRect().top - containerTop <= band) found = item.anchorId;
      }
      // At the very top no turn start may fall inside the band; the reader is
      // unambiguously at turn 1 then, so fall back rather than report nothing.
      if (!found) found = turnNavigatorItems[0]?.anchorId ?? null;
      setTurnNavigatorActiveId((current) => (current === found ? current : found));
    };
    // One resolution per animation frame: scroll fires far more often than the
    // rail can usefully repaint, and each pass queries the DOM per turn.
    let frame = 0;
    const scheduleResolve = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        resolveActive();
      });
    };
    resolveActive();
    container.addEventListener('scroll', scheduleResolve, { passive: true });
    return () => {
      container.removeEventListener('scroll', scheduleResolve);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [turnNavigatorItems, scrollContainerRef, sessionMessages]);

  const handleTurnNavigatorNavigate = useCallback((item: TurnNavigatorItem) => {
    if (!item.anchorId) return;
    // Both targets are resolved at CLICK time: a ref captured by an empty-dep
    // closure can predate the transcript mounting.
    const container = scrollContainerRef.current;
    if (!container) return;
    const selector = `[data-message-id="${CSS.escape(item.anchorId)}"]`;
    const matches = Array.from(container.querySelectorAll<HTMLElement>(selector));
    // A miss is not an error: the window may have trimmed the target, or the
    // session switched under the click. Say nothing rather than jump nowhere.
    if (matches.length === 0) return;

    // TWO elements, on purpose. The same id is on the enclosing turn wrapper
    // and on the message bubble inside it.
    //  - Scroll by the OUTERMOST one: it starts the turn, so the landing is the
    //    top of the turn the reader picked (the innermost sits mid-turn).
    //  - Ring the INNERMOST one: the accent ring hugs the element it is on, and
    //    on the wide short wrapper it reads as a stray gold rule across the
    //    transcript, while on the bubble it reads as "this message".
    // Using one element for both jobs is what made an earlier attempt either
    // land wrong or draw a line instead of a ring.
    const scrollTarget = matches[0];
    const ringTarget = matches.find((candidate) => !candidate.querySelector(selector))
      ?? matches[matches.length - 1];

    setShouldAutoScroll(false);

    // Paint the ring BEFORE the scroll. scrollIntoView() and
    // scrollTo({behavior:'smooth'}) are both inert on this transcript (measured:
    // the call returns without moving scrollTop), so the cue must not depend on
    // the scroll succeeding. transientHighlight also clears every lit ring and
    // restarts the window — see its contract near its definition.
    transientHighlight(
      transientHighlightTimerRef,
      container,
      ringTarget,
      TURN_NAVIGATOR_HIGHLIGHT_MS,
    );

    // Assign scrollTop rather than asking for a smooth scroll: behavior:'auto'
    // and a direct assignment land exactly where the smooth path does nothing.
    const containerRect = container.getBoundingClientRect();
    const elementRect = scrollTarget.getBoundingClientRect();
    const target = Math.max(0, container.scrollTop + (elementRect.top - containerRect.top));
    container.scrollTo({ top: target, behavior: 'auto' });
  }, []);

  // The per-message reply entry needs its target's transcript position at
  // click time. Kept in a ref (refreshed whenever the turns rebuild) so the
  // handler stays stable and never breaks AssistantTurnBlock's memo for the
  // whole transcript — same pattern as handleBranchFromMessage.
  const transcriptMessagePositionsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    transcriptMessagePositionsRef.current = buildTranscriptMessagePositions(turns);
  }, [turns]);

  // Readable notice shown beside the composer when a quote-jump target is not
  // in the rendered window.
  const [quoteJumpNotice, setQuoteJumpNotice] = useState<string | null>(null);

  const handleQuoteReplyMessage = useCallback((message: CoworkMessage, text: string) => {
    // A fresh quote supersedes any "target not loaded" notice from an earlier
    // jump attempt.
    setQuoteJumpNotice(null);
    const ordinal = transcriptMessagePositionsRef.current.get(message.id);
    // The entry mounts on exactly the messages `turns` carries — user bubbles
    // and every assistant bubble (narration included) — and this map is built
    // from those same turns, so every rendered entry resolves here. A miss
    // means the mount conditions drifted away from
    // buildTranscriptMessagePositions: surface it instead of a silent no-op
    // (the user-visible symptom would be "clicked 回复, nothing happened").
    if (!ordinal) {
      console.warn('[cowork] reply entry without a transcript position:', message.id);
      return;
    }
    const fragment = createMessageQuotedSelection({
      content: text,
      role: message.type === 'user' ? 'user' : message.type === 'assistant' ? 'assistant' : 'other',
      messageId: message.id,
      ordinal,
      streaming: message.metadata?.isStreaming === true,
    });
    if (!fragment) return;
    // Same slot as the "add to conversation" path: a reply replaces whatever
    // quote the composer held.
    promptInputRef.current?.addQuotedSelection(fragment);
    promptInputRef.current?.focus();
  }, []);

  // Jump back to a quoted message: scroll its transcript element into view and
  // ring it briefly, so "which message was I answering?" is one click, not a
  // hunt. The sent quote blocks in the transcript are the callers (see
  // handleJumpToSentQuoteBlock).
  //
  // The target can legitimately be outside the rendered window (the transcript
  // pages older messages in on demand), so a miss is not an error path — but it
  // must not fail silently either: the composer shows a readable notice beside
  // the input (same alert style as the submit / branch errors) telling the user
  // the message is not loaded and how to get it. A hit clears the notice.
  const handleJumpToQuotedMessage = useCallback((messageId: string) => {
    const container = scrollContainerRef.current;
    const element = findTranscriptMessageElement(container, messageId);
    if (!element) {
      setQuoteJumpNotice(i18nService.t('coworkQuoteJumpMissing'));
      console.info('[cowork] quote jump: target message is not in the rendered window; notice shown:', messageId);
      return;
    }
    setQuoteJumpNotice(null);
    // Ring BEFORE scrolling, deliberately. scrollIntoView on this transcript
    // container is inert (measured: scrollTo/scrollIntoView with smooth behavior
    // leaves scrollTop untouched, while an instant jump lands). Painting the
    // highlight first means the cue the reader came for does not depend on that
    // call succeeding — the jump and the mark are separate promises.
    // transientHighlight shares the rail jump's contract: every lit ring is
    // cleared first (so repeated jumps restart the full 2.5s window and never
    // stack rings), then this element is lit.
    transientHighlight(
      transientHighlightTimerRef,
      container,
      element,
      QUOTE_JUMP_HIGHLIGHT_MS,
    );
    // Center the target by assigning scrollTop. This transcript's smooth path
    // is inert: scrollIntoView({behavior:'smooth'}) returns without moving
    // scrollTop at all (measured — the ring painted correctly on an element
    // left 8957px outside the viewport, which is why a jump looked like "no
    // highlight": the highlight existed, the view never went to it). The same
    // fix as the turn-rail jump.
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const centred = container.scrollTop
      + (elementRect.top - containerRect.top)
      - (container.clientHeight - elementRect.height) / 2;
    container.scrollTo({ top: Math.max(0, centred), behavior: 'auto' });
  }, []);

  // Jump back from a *sent* quote block (a message body that opens with the
  // generated reply block). The metadata anchor (quotedMessageIds[0]) is the
  // durable target: message ids survive history paging and app restarts, while
  // the ordinal the block label carries is window-relative copy that shifts by
  // K the moment an older page of K messages loads — resolving it against the
  // current map would ring the wrong message. Messages sent before the anchor
  // existed (no metadata) keep the ordinal → id resolution. Either way a miss
  // is the same "not in the loaded window" story — the readable notice, never
  // a silent no-op.
  const handleJumpToSentQuoteBlock = useCallback((ordinal: number, messageIdAnchor?: string) => {
    if (messageIdAnchor) {
      handleJumpToQuotedMessage(messageIdAnchor);
      return;
    }
    const targetId = buildTranscriptMessageIdsByOrdinal(transcriptMessagePositionsRef.current).get(ordinal);
    if (!targetId) {
      setQuoteJumpNotice(i18nService.t('coworkQuoteJumpMissing'));
      console.info('[cowork] quote jump: quoted position is not in the rendered transcript window; notice shown:', ordinal);
      return;
    }
    handleJumpToQuotedMessage(targetId);
  }, [handleJumpToQuotedMessage]);

  // A window whose messages all render as nothing (the transcript hides control
  // and internal-signal messages) would strand the history: there is nothing to
  // scroll up, so the scroll handler never asks for the page below. Same safety
  // net the A2A window has; each page advances the cursor, and the loop ends when
  // a page fills the transcript or the cursor runs out.
  useEffect(() => {
    if (isA2ASession || !currentSession?.id || !currentSession.messageHistory?.hasMoreBefore) {
      return;
    }
    if (turns.length > 0) return;
    void coworkService.loadEarlierMessages(currentSession.id);
  }, [
    isA2ASession,
    currentSession?.id,
    currentSession?.messageHistory?.hasMoreBefore,
    turns.length,
  ]);

  if (!currentSession) {
    return null;
  }

  const showA2AServiceSessionId = shouldShowA2AServiceSessionId({
    sessionId: currentSession.id,
    sessionType: currentSession.sessionType,
    serviceOrderSummary: currentSession.serviceOrderSummary,
  });
  const privateA2ASessionDisplayId = buildPrivateA2ASessionDisplayId(
    sessionMetabot?.globalmetaid,
    currentSession.peerGlobalMetaId,
  );
  const showPrivateA2ASessionId = (
    isPrivateA2ASession
    && !showA2AServiceSessionId
    && Boolean(privateA2ASessionDisplayId)
  );

  const renderConversationTurns = () => {
    // Assistant mode's inline indicator covers the whole running state, not
    // just the streaming window — an empty transcript of a running session
    // still shows the reply-position indicator.
    const sessionRunning = isStreaming || currentSession?.status === 'running';
    // Transport-level status signals (api_retry / requesting) are dropped
    // from the transcript (shouldHideControlMessage) but belong in the live
    // indicator's status derivation. Sourced from the raw message list like
    // professional mode's StreamingActivityBar does.
    const runtimeStatusMessages = isAssistantMode && sessionRunning
      ? (currentSession?.messages ?? []).filter(
        (message) => typeof message.metadata?.sdkRuntimeStatus === 'string',
      )
      : null;
    if (turns.length === 0) {
      if (isAssistantMode ? !sessionRunning : !isStreaming) return null;
      return (
        <div data-export-role="assistant-block">
          <AssistantTurnBlock
            turn={{
              id: 'streaming-only',
              userMessage: null,
              assistantItems: [],
            }}
            resolveLocalFilePath={resolveLocalFilePath}
            showTypingIndicator
            showImagePreviews
            sessionLive={isStreaming || currentSession?.status === 'running'}
            isActiveTurn={currentSession?.status === 'running'}
            onOpenLocalFile={handleOpenLocalFile}
            isAssistantMode={isAssistantMode}
            activityAvatar={sessionMetabot?.avatar ?? currentSession.metabotAvatar ?? null}
            runtimeStatusMessages={runtimeStatusMessages}
            sessionId={currentSession?.id ?? null}
          />
        </div>
      );
    }

    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      // Assistant mode: the inline indicator is visible through the ENTIRE
      // running state — the pre-first-token wait, narration streaming, tool
      // runs, and hidden thinking alike. Hiding it while reply text streamed
      // left multi-minute tool windows looking idle (the 2026-10-13 twinbot
      // acceptance report: "cannot tell whether it is working"); the status
      // line itself differentiates the phases instead ("writing" while text
      // streams). Professional mode keeps the original TypingDots gate
      // byte-identical.
      const showTypingIndicator = isLastTurn && (isAssistantMode
        ? sessionRunning
        : isStreaming && !hasRenderableAssistantContent(turn, isAssistantMode));
      // Assistant mode filters tool UI out of the transcript, so a turn whose
      // items all filtered out must not leave an empty padded block behind.
      const showAssistantBlock = (isAssistantMode
        ? hasRenderableAssistantContent(turn, true)
        : turn.assistantItems.length > 0) || showTypingIndicator;

      return (
        <React.Fragment key={turn.id}>
          {turn.userMessage && (
            <div data-export-role="user-message" data-message-id={turn.userMessage.id}>
              <UserMessageItem
                message={turn.userMessage}
                skills={skills}
                sessionType={currentSession?.sessionType}
                sessionTitle={currentSession?.title}
                botName={currentSession?.metabotName}
                resolveLocalFilePath={resolveLocalFilePath}
                onQuoteReply={handleQuoteReplyMessage}
                onJumpToQuoteBlock={handleJumpToSentQuoteBlock}
              />
            </div>
          )}
          {showAssistantBlock && (
            <div data-export-role="assistant-block">
              <AssistantTurnBlock
                turn={turn}
                resolveLocalFilePath={resolveLocalFilePath}
                mapDisplayText={mapDisplayText}
                showTypingIndicator={showTypingIndicator}
                showImagePreviews
                sessionLive={isStreaming || currentSession?.status === 'running'}
                isActiveTurn={currentSession?.status === 'running' && isLastTurn}
                onOpenLocalFile={handleOpenLocalFile}
                // Streaming turns keep every hover affordance (owner,
                // 2026-10-28) — the "⋯", the timestamp, feedback. Only the
                // branch entry drops out, because forking from a message whose
                // turn is still being written is meaningless; the handler
                // carries the same guard as defense in depth.
                onBranch={isStreaming ? undefined : handleBranchFromMessage}
                onQuoteReply={handleQuoteReplyMessage}
                isAssistantMode={isAssistantMode}
                activityAvatar={sessionMetabot?.avatar ?? currentSession.metabotAvatar ?? null}
                runtimeStatusMessages={isLastTurn ? runtimeStatusMessages : null}
                sessionId={currentSession.id}
              />
            </div>
          )}
          {showWelcomeHandoff && hasRenderableAssistantContent(turn, isAssistantMode) && (
            <div className="px-4 pb-2">
              <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
                <div className="flex items-start gap-2.5 rounded-xl border border-claude-accent/20 bg-claude-accent/5 px-3.5 py-2.5">
                  <SparklesIcon className="h-4 w-4 mt-0.5 shrink-0 text-claude-accent" />
                  <p className="text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkWelcomeHandoffHint')}
                  </p>
                </div>
              </div>
            </div>
          )}
        </React.Fragment>
      );
    });
  };

  // Pixel width of the markdown viewer sidebar, derived from the stored
  // fraction and the live container width (falls back to the window before
  // the first layout measurement).
  const markdownViewerContainerWidth = detailRootRef.current?.clientWidth ?? 0;
  const markdownViewerWidthPx = markdownViewerContainerWidth > 0
    ? clampMarkdownViewerWidth(markdownViewerContainerWidth * markdownViewerFraction, markdownViewerContainerWidth)
    : Math.max(MARKDOWN_VIEWER_MIN_WIDTH_PX, Math.round(window.innerWidth * markdownViewerFraction));

  return (
    <InlineMetaAppActorContext.Provider value={inlineMetaAppActor}>
    <div ref={detailRootRef} className="relative flex-1 flex flex-col cowork-chat-surface h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 shrink-0">
        {/* Left side: Toggle buttons (when collapsed) + Title + Sandbox badge */}
        <div className="flex h-full items-center gap-2 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          {sessionMetabot && (
            <div className="non-draggable flex items-center gap-2 shrink-0">
              <NftAvatarFrame
                avatar={sessionMetabot.avatar}
                fallbackSource={sessionMetabot.avatar_fallback}
                frameClassName="w-7 h-7 rounded-full"
                imgClassName="border dark:border-claude-darkBorder border-claude-border"
                alt=""
                fallback={(
                  <div className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                    <span className="text-[10px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
                      {sessionMetabot.name.slice(0, 2) || '?'}
                    </span>
                  </div>
                )}
              />
              <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate max-w-[100px]">
                {sessionMetabot.name}
              </span>
            </div>
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameSave(e);
                }
                if (e.key === 'Escape') {
                  handleRenameCancel(e);
                }
              }}
              onBlur={handleRenameBlur}
              className="non-draggable min-w-0 max-w-[300px] rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
            />
          ) : (
            <h1
              className={`${getCoworkSessionTitleClassName({
                sessionType: currentSession.sessionType,
                serviceOrderStatus: currentSession.serviceOrderSummary?.status,
              })} min-w-0 max-w-[360px]`}
            >
              {currentSession.title || i18nService.t('coworkNewSession')}
            </h1>
          )}
          {currentSession.executionMode === 'sandbox' && (
            <span className="shrink-0 whitespace-nowrap inline-flex items-center rounded-full bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {i18nService.t('coworkSandboxBadge')}
            </span>
          )}
          {currentSession.executionMode === 'local' && !isA2ASession && (
            <span className="shrink-0 whitespace-nowrap inline-flex items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {i18nService.t('coworkLocalBadge')}
            </span>
          )}
          {isA2ASession && (
            <span className="shrink-0 whitespace-nowrap inline-flex items-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {i18nService.t('coworkOnChainBadge')}
            </span>
          )}
          {isA2ASession && a2aPeerIsFriend && (
            <FriendBadge />
          )}
          {/* 会话 → 所属长期任务（新一等实体看板）；0 关联时该组件不渲染任何东西 */}
          <LongTermTaskOriginChip sessionId={currentSession.id} />
          {normalizedFocusedOrderTxid && (
            <span className="non-draggable shrink-0 whitespace-nowrap inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-700 dark:text-amber-300">
              order {normalizedFocusedOrderTxid.slice(0, 8)}
            </span>
          )}
          {showA2AServiceSessionId && (
            <span className="non-draggable inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary opacity-75">
              <span className="shrink-0">sessionid:</span>
              <span className="min-w-0 max-w-[180px] truncate font-mono">
                {currentSession.id}
              </span>
              <button
                type="button"
                onClick={() => handleCopyHeaderValue(currentSession.id)}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-current hover:bg-black/10 dark:hover:bg-white/10"
                title={i18nService.t('copyToClipboard')}
                aria-label={i18nService.t('copyToClipboard')}
              >
                <DocumentDuplicateIcon className="h-3 w-3" />
              </button>
            </span>
          )}
          {showPrivateA2ASessionId && (
            <span className="non-draggable inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary opacity-75">
              <span className="shrink-0">sessionid:</span>
              <span className="min-w-0 max-w-[120px] truncate font-mono">
                {privateA2ASessionDisplayId}
              </span>
              <button
                type="button"
                onClick={() => handleCopyHeaderValue(privateA2ASessionDisplayId)}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-current hover:bg-black/10 dark:hover:bg-white/10"
                title={i18nService.t('copyToClipboard')}
                aria-label={i18nService.t('copyToClipboard')}
              >
                <DocumentDuplicateIcon className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>

        {/* Right side: Search + Folder + Menu */}
        <div className="non-draggable flex items-center gap-1">
          {supportsConversationSearch && (
            <button
              type="button"
              data-cowork-conversation-search-trigger
              onClick={() => conversationSearchRef.current?.open()}
              title={`${i18nService.t('coworkConversationSearch')} (${isMac ? '⌘F' : 'Ctrl+F'})`}
              aria-label={i18nService.t('coworkConversationSearch')}
              aria-expanded={isConversationSearchOpen}
              aria-controls="cowork-conversation-search"
              className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors active:scale-[0.96] ${
                isConversationSearchOpen
                  ? 'bg-claude-surfaceHover text-claude-text dark:bg-claude-darkSurfaceHover dark:text-claude-darkText'
                  : 'text-claude-textSecondary hover:bg-claude-surfaceHover hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText'
              }`}
            >
              <MagnifyingGlassIcon className="h-4 w-4" />
            </button>
          )}
          {/* Folder button */}
          <button
            type="button"
            onClick={handleOpenFolder}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
            aria-label={i18nService.t('coworkOpenFolder')}
          >
            {boundProject?.icon ? (
              <img src={boundProject.icon} alt="" className="h-4 w-4 rounded-sm object-cover" />
            ) : (
              <FolderIcon className="h-4 w-4" />
            )}
            <span className="max-w-[120px] truncate text-xs">
              {boundProject?.name ?? truncatePath(currentSession.cwd)}
            </span>
            {gitBranch && (
              <span className="max-w-[90px] truncate text-[10px] px-1.5 py-0.5 rounded-md dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {gitBranch}
              </span>
            )}
          </button>

          {/* Menu button */}
          <button
            ref={actionButtonRef}
            type="button"
            onClick={openMenu}
            className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            aria-label={i18nService.t('coworkSessionActions')}
          >
            <EllipsisHorizontalIcon className="h-5 w-5" />
          </button>
          <WindowTitleBar inline className="ml-1" />
        </div>
      </div>

      {supportsConversationSearch && (
        <CoworkConversationSearch
          ref={conversationSearchRef}
          rootRef={detailRootRef}
          containerRef={scrollContainerRef}
          sessionId={currentSession.id}
          enabled={supportsConversationSearch}
          contentVersion={currentSession.messages}
          hasMoreBefore={Boolean(currentSession.messageHistory?.hasMoreBefore)}
          isLoadingEarlierMessages={isLoadingEarlierMessages}
          loadEarlierMessages={loadEarlierMessages}
          onBeforeNavigate={handleConversationSearchNavigate}
          onOpenChange={setIsConversationSearchOpen}
        />
      )}

      {/* Floating Menu */}
      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover popover-enter overflow-hidden"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          role="menu"
        >
          <button
            type="button"
            onClick={handleRenameClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <PencilSquareIcon className="h-4 w-4" />
            {i18nService.t('renameConversation')}
          </button>
          <button
            type="button"
            onClick={handleTogglePin}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <PushPinIcon
              slashed={currentSession.pinned}
              className={`h-4 w-4 ${currentSession.pinned ? 'opacity-60' : ''}`}
            />
            {currentSession.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession')}
          </button>
          <button
            type="button"
            onClick={handleShareClick}
            disabled={isExportingImage}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ShareIcon className="h-4 w-4" />
            {i18nService.t('coworkShareSession')}
          </button>
          <button
            type="button"
            onClick={handleDeleteClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <ArchiveBoxIcon className="h-4 w-4" />
            {i18nService.t('archiveSession')}
          </button>
        </div>
      )}

      {/* Body row: chat column + optional markdown viewer sidebar */}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleMessagesScroll}
        onMouseUp={handleTranscriptSelectionEnd}
        onKeyUp={handleTranscriptSelectionKeyUp}
        className="flex-1 overflow-y-auto overflow-anchor-none min-h-0 pt-3"
      >
        {isLoadingEarlierMessages && (
          <div className="flex items-center justify-center gap-2 px-4 py-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            <span>Loading earlier messages…</span>
          </div>
        )}
        {isA2ASession ? (
          visibleA2AMessages.flatMap((msg, index, arr) => {
            const content = typeof msg.content === 'string' ? msg.content : '';
            const isOrderStart = ORDER_START_CONTENT_RE.test(content.trim());
            const isOrderEnd = ORDER_END_CONTENT_RE.test(content.trim());
            const items: Array<{ type: 'separator-start' | 'separator-end' | 'episode-end' | 'message'; key: string; message?: CoworkMessage; endedEpisodeIndex?: number }> = [];

            // Episode boundary: this message opens a newer episode than the
            // previous one (untagged messages belong to the current/newest
            // episode). Mark the ended episode with a divider card.
            const episodeIndexAt = (position: number): number | null => {
              const target = arr[position];
              if (!target) return null;
              return typeof target.metadata?.a2aEpisodeIndex === 'number'
                ? target.metadata.a2aEpisodeIndex
                : null;
            };
            const previousEpisodeIndex = episodeIndexAt(index - 1);
            const currentEpisodeIndex = episodeIndexAt(index);
            if (
              previousEpisodeIndex != null
              && (currentEpisodeIndex ?? Number.POSITIVE_INFINITY) > previousEpisodeIndex
            ) {
              items.push({
                type: 'episode-end',
                key: `episode-end-before-${msg.id}`,
                endedEpisodeIndex: previousEpisodeIndex,
              });
            }

            if (isOrderStart && index > 0) {
              items.push({ type: 'separator-start', key: `order-start-before-${msg.id}` });
            }
            items.push({ type: 'message', key: msg.id, message: msg });

            const nextMsg = arr[index + 1];
            const nextContent = nextMsg && typeof nextMsg.content === 'string' ? nextMsg.content : '';
            const nextIsOrderStart = nextContent ? ORDER_START_CONTENT_RE.test(nextContent.trim()) : false;
            if (isOrderEnd && !nextIsOrderStart) {
              items.push({ type: 'separator-end', key: `order-end-after-${msg.id}` });
            }

            return items;
          }).map((item) => {
            if (item.type === 'episode-end') {
              const endedEpisode = item.endedEpisodeIndex != null
                ? a2aEpisodeByIndex.get(item.endedEpisodeIndex)
                : undefined;
              return (
                <A2AEpisodeDividerCard
                  key={item.key}
                  episodeIndex={item.endedEpisodeIndex ?? 0}
                  summary={endedEpisode?.summary ?? null}
                />
              );
            }
            if (item.type === 'separator-start' || item.type === 'separator-end') {
              const label = item.type === 'separator-start' ? 'Order Start' : 'Order End';
              return (
                <div key={item.key} className="flex items-center gap-3 px-4 py-1">
                  <div className="flex-1 h-px dark:bg-white/10 bg-black/10" />
                  <span className="text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary opacity-70 font-mono select-none">
                    {label}
                  </span>
                  <div className="flex-1 h-px dark:bg-white/10 bg-black/10" />
                </div>
              );
            }
            const msg = item.message!;
            return (
              <div
                key={msg.id}
                ref={(element) => {
                  messageElementRefs.current[msg.id] = element;
                }}
                className={focusedOrderMessageId === msg.id
                  ? 'rounded-lg ring-2 ring-amber-500/40 ring-offset-2 ring-offset-claude-bg transition-shadow dark:ring-offset-claude-darkBg'
                  : undefined}
                data-order-focus-target={focusedOrderMessageId === msg.id ? 'true' : undefined}
                // Turn-navigator rail: the transcript lookup contract. Without
                // this id the rail renders in A2A sessions but every jump and
                // active-mark resolve misses silently (standard-session paths
                // mount the same id on their turn wrappers).
                data-message-id={msg.id}
              >
                <A2AMessageItem
                  message={msg}
                  peerName={currentSession.peerName}
                  peerAvatar={resolvedPeerAvatar}
                  metabotName={currentSession.metabotName}
                  metabotAvatar={currentSession.metabotAvatar}
                  peerGlobalMetaId={a2aPeerGlobalMetaId}
                  localGlobalMetaId={sessionMetabot?.globalmetaid}
                  invertSides={isA2APeerOwner}
                  onOpenBotInBrowser={onOpenBotInBrowser}
                  canResendDigitalDelivery={canResendDigitalDelivery}
                  isResendingDigitalDelivery={Boolean(resendingDeliveryOrderTxid)}
                  onResendDigitalDelivery={handleResendDigitalDelivery}
                  isAssistantMode={isAssistantMode}
                  peerIsFriend={a2aPeerIsFriend}
                  sessionId={currentSession?.id ?? undefined}
                />
              </div>
            );
          })
        ) : (
          renderConversationTurns()
        )}
        {/* Scroll anchor. Assistant mode keeps only a hair of runway: the
            status indicator / last bubble hugs the composer so the visible
            transcript column is maximized (the turn's own py-2 plus the
            composer's top padding already provide the breathing room).
            Professional mode keeps the original 80px scroll runway. */}
        <div ref={messagesEndRef} className={isAssistantMode ? 'h-2' : 'h-20'} />
        {/* DSH WebUI-style "back to bottom" button: sticky zero-height slot keeps
            the 34px floating button pinned 16px above the scrollport's bottom edge,
            right-aligned with the chat content column. */}
        {!shouldAutoScroll && (
          <div className="sticky bottom-4 z-10 h-0 flex pointer-events-none">
            <div className="w-full max-w-[clamp(680px,64%,920px)] mx-auto flex justify-end">
              <button
                type="button"
                onClick={handleScrollToBottomClick}
                title={i18nService.t('coworkScrollToBottom')}
                aria-label={i18nService.t('coworkScrollToBottom')}
                className="pointer-events-auto -mt-[34px] flex h-[34px] w-[34px] items-center justify-center rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-elevated dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                <ChevronDownIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {shouldRenderRefundStatusCard && currentSession.serviceOrderSummary && (
        <RefundStatusCard
          summary={currentSession.serviceOrderSummary}
          onProcessRefund={handleProcessServiceRefund}
          isProcessingRefund={isProcessingRefund}
          refundActionError={refundActionError}
          onDismiss={handleDismissRefundStatusCard}
        />
      )}

      {/* Dream review P2-2: one quiet feedback nudge under a mature,
          completely unrated session (the message_feedback table has been
          empty since launch — RLHF starves at the source). Global one-shot
          (2026-10-23 redesign): the first session that displays it consumes
          it everywhere; renders nothing afterwards. */}
      <FeedbackNudgeHint
        // Remount per session so the lazy storage read re-runs on switch.
        key={`feedback-nudge-${currentSession.id}`}
        messages={currentSession.messages}
        feedbackLoaded={feedbackLoadedForNudge}
      />

      {/* Streaming Activity Bar — professional mode only. Assistant mode's
          single activity indicator lives inline at the reply position (see
          AssistantTurnBlock), so nothing renders here in that mode. */}
      {!isAssistantMode && (isStreaming || currentSession.status === 'running') && (
        <StreamingActivityBar
          messages={currentSession.messages}
          sessionId={currentSession.id}
          fallbackText={isA2ASession ? i18nService.t('coworkA2ABackgroundWorking') : undefined}
        />
      )}

      {quotaExhausted && (
        <div className="px-4 pb-2 shrink-0">
          <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
            <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <ExclamationTriangleIcon className="h-4 w-4 text-red-500 shrink-0" />
              <span className="text-xs text-red-700 dark:text-red-300">
                {i18nService.t(isMobile ? 'quotaExhaustedBannerMobile' : 'freeQuotaExhaustedBanner')}
              </span>
              {isMobile ? (
                // Mobile web (REQ-A-25): no Settings > Models surface — the
                // recharge screen lives in the WS-E shell, which listens for
                // this event (seam documented in services/isMobileRuntime.ts).
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('idbots:mobile-recharge'))}
                  className="text-xs font-medium text-red-700 dark:text-red-300 underline hover:no-underline shrink-0"
                >
                  {i18nService.t('quotaExhaustedRechargeMobile')}
                </button>
              ) : onRequestAppSettings && (
                <button
                  type="button"
                  onClick={() => onRequestAppSettings({ initialTab: 'model', notice: i18nService.t('freeQuotaExhaustedNotice') })}
                  className="text-xs font-medium text-red-700 dark:text-red-300 underline hover:no-underline shrink-0"
                >
                  {i18nService.t('freeQuotaGoSettings')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {isA2ASession && currentSession.status === 'error' && !quotaExhausted && (
        <div className="px-4 pb-2 shrink-0">
          <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
            <div className="flex items-start justify-between gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <div className="flex items-start gap-2 min-w-0">
                <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 text-red-500 shrink-0" />
                <div className="min-w-0">
                  <span className="text-xs text-red-700 dark:text-red-300">
                    {i18nService.t('coworkA2ASessionErrorBanner')}
                  </span>
                  {a2aSessionErrorDetail && (
                    <p className="mt-0.5 text-xs leading-4 text-red-600/90 dark:text-red-300/80 break-all">
                      {a2aSessionErrorDetail}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void handleDismissA2AErrorBanner();
                }}
                disabled={isClearingA2AError}
                title={i18nService.t('coworkA2ASessionErrorDismiss')}
                aria-label={i18nService.t('coworkA2ASessionErrorDismiss')}
                className="shrink-0 p-1 rounded-md text-red-400 hover:text-red-600 dark:hover:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {isPrivateA2ASession && a2aAutoReplySuppressed && (
        <div className="px-4 pb-2 shrink-0">
          <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <InformationCircleIcon className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
              <span className="text-xs leading-4 text-amber-700 dark:text-amber-300">
                {i18nService.t('coworkA2AAutoReplySuppressedBanner')}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
      {isA2ASession ? (
        <div className="px-4 py-3 shrink-0 border-t dark:border-claude-darkBorder border-claude-border">
          <div className="mx-auto flex max-w-[clamp(680px,64%,920px)] flex-col items-stretch gap-2">
            {a2aApprovalPermissions[0] && (
              <A2AApprovalBar
                key={a2aApprovalPermissions[0].requestId}
                permission={a2aApprovalPermissions[0]}
              />
            )}
            {isA2APeerOwner ? (
              <A2AOwnerComposer
                key={currentSession.id}
                sessionId={currentSession.id}
              />
            ) : isPrivateA2ASession && a2aApprovalPermissions.length === 0 && (
              <A2AGuidanceControls
                key={currentSession.id}
                sessionId={currentSession.id}
                isConversationEnded={isA2AConversationEnded}
                isEnding={isEndingA2A}
                endError={a2aEndError}
                resendError={resendDeliveryError}
                onEndConversation={handleEndA2APrivateChat}
              />
            )}
          </div>
        </div>
      ) : (
        // Assistant mode halves the composer area's top padding — together
        // with the slimmed scroll anchor above, the last bubble / status
        // indicator sits close under the composer instead of behind ~112px of
        // accumulated gaps. Professional mode keeps p-4 byte-identical.
        <div className={isAssistantMode ? 'px-4 pb-4 pt-2 shrink-0' : 'p-4 shrink-0'}>
          <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
            <div className="flex items-center justify-end gap-2 mb-2">
              {currentSession.contextUsage && (
                <ManualCompactButton
                  sessionId={currentSession.id}
                  usageRatio={currentSession.contextUsage.usageRatio}
                  visibleRatio={0.4}
                  disabled={isStreaming}
                />
              )}
              {currentSession.usageStats && (
                <UsageStatsChip
                  usageStats={currentSession.usageStats}
                  modelId={currentModelId}
                />
              )}
              <SubagentPanel
                sessionId={currentSession.id}
                disableControls={resolvedExecutionMode === 'sandbox'}
              />
              <TodoPanel messages={currentSession.messages} />
              {/* Plan mode is entered through the composer /plan command
                  (kernel dsh-plan-mode), not a toolbar chip — one control,
                  one source of truth. */}
              <PermissionModeSelector
                sessionId={currentSession.id}
                currentMode={currentSession.permissionMode ?? 'default'}
                onModeChange={(mode) => {
                  void coworkService.setPermissionMode(currentSession.id, mode);
                }}
              />
            </div>
          </div>
          {currentSession.parentSessionId && (
            <div className="max-w-[clamp(680px,64%,920px)] mx-auto mb-2">
              <div className="flex items-center gap-2 rounded-lg border border-claude-border/60 dark:border-claude-darkBorder/60 bg-claude-surfaceMuted/60 dark:bg-claude-darkSurfaceMuted/60 px-3 py-2">
                <DocumentDuplicateIcon className="h-3.5 w-3.5 shrink-0 text-claude-accent/70" />
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('coworkBranchedFrom')}
                  <button
                    type="button"
                    onClick={() => {
                      const parentId = currentSession.parentSessionId;
                      if (parentId) void coworkService.loadSession(parentId);
                    }}
                    className="mx-1 font-medium text-claude-accent hover:underline"
                    title={i18nService.t('coworkBranchedFromOpenSource')}
                  >
                    {branchedFromTitle ?? i18nService.t('coworkBranchedFromUnknown')}
                  </button>
                </span>
              </div>
            </div>
          )}
          {delegationBlocking && (
            <div className="max-w-[clamp(680px,64%,920px)] mx-auto mb-2">
              <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <svg className="animate-spin h-4 w-4 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  {/* Assistant mode keeps delegation jargon out of the copy:
                      the handoff reads as the assistant passing the task on,
                      not as a remote-service transport state. */}
                  {i18nService.t(isAssistantMode ? 'assistantDelegationWaiting' : 'delegationWaitingForResult')}
                </span>
              </div>
            </div>
          )}
          {showWelcomeRetirement && (
            <div className="max-w-[clamp(680px,64%,920px)] mx-auto mb-2">
              <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                <div className="flex items-start gap-2.5">
                  <CheckIcon className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('coworkWelcomeRetirePrompt')}
                  </p>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleRetireWelcome}
                    disabled={isRetiringWelcome}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <CheckIcon className="h-4 w-4" />
                    {isRetiringWelcome ? i18nService.t('coworkWelcomeRetireConfirming') : i18nService.t('coworkWelcomeRetireConfirm')}
                  </button>
                </div>
                {retireWelcomeError && (
                  <div className="text-[11px] text-red-600 dark:text-red-400" role="alert">
                    {retireWelcomeError}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
            {pendingPermission ? (
              <CoworkPermissionPanel
                permission={pendingPermission}
                onRespond={handlePermissionResponse}
                responding={isRespondingToPermission}
              />
            ) : (
              <CoworkPromptInput
                key={currentSession.id}
                ref={promptInputRef}
                scopeKey={currentSession.id}
                onSubmit={handlePromptSubmit}
                onStop={onStop}
                isStreaming={isStreaming}
                steerDisabled={steerDisabled}
                placeholder={delegationBlocking
                  ? i18nService.t(isAssistantMode ? 'assistantDelegationInputPlaceholder' : 'delegationInputDisabledPlaceholder')
                  : i18nService.t('coworkContinuePlaceholder')}
                disabled={delegationBlocking}
                onManageSkills={onManageSkills}
                size="large"
                singleLine
                showModelSelector={true}
                modelEffortValue={sessionModelEffortValue}
                onModelEffortChange={handleSessionModelEffortChange}
                contextUsage={currentSession.contextUsage}
                suggestedPrompts={!isStreaming && latestPromptSuggestion ? [latestPromptSuggestion] : undefined}
                commands={buildSessionComposerCommands({ sessionId: currentSession.id, goal: currentSession.goal ?? null })}
                sessionMetabotId={currentSession.metabotId ?? null}
                botName={currentSession.metabotName}
              />
            )}
            {submitError && (
              <div className="mt-2 text-xs text-red-500 dark:text-red-400" role="alert">
                {submitError}
              </div>
            )}
            {branchActionError && (
              <div className="mt-2 text-xs text-red-500 dark:text-red-400" role="alert">
                {branchActionError}
              </div>
            )}
            {quoteJumpNotice && (
              // "Jump to the quoted message" missed: the message is not in the
              // rendered window. Readable, beside the input, same style as the
              // two alerts above — never a silent no-op.
              <div className="mt-2 text-xs text-red-500 dark:text-red-400" role="alert">
                {quoteJumpNotice}
              </div>
            )}
          </div>
        </div>
      )}
      </div>

      {markdownViewerPath && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleMarkdownViewerResizeStart}
            onDoubleClick={handleMarkdownViewerResizeReset}
            className="w-1 shrink-0 cursor-col-resize transition-colors hover:bg-claude-accent/40"
          />
          <div
            className="h-full shrink-0 border-l dark:border-claude-darkBorder border-claude-border"
            style={{ width: markdownViewerWidthPx }}
          >
            <MarkdownViewerPanel
              filePath={markdownViewerPath}
              onClose={() => setMarkdownViewerPath(null)}
              onOpenFile={setMarkdownViewerPath}
            />
          </div>
        </>
      )}
      </div>

      {/* Floating "add to conversation" bar for the pending transcript
          selection. Rendered only while a non-empty selection exists. */}
      {pendingQuoteSelection && quoteActionPlacement && (
        <CoworkQuoteActionBar
          ref={quoteActionBarRef}
          placement={quoteActionPlacement}
          onAdd={handleAddQuoteToConversation}
        />
      )}

      {/* Turn navigator rail — absolutely positioned against the detail root so
          it floats beside the transcript without disturbing the column layout.
          It centres itself in the band above the composer and hides on narrow
          viewports (see TurnNavigator). */}
      <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center">
        <TurnNavigator
          items={turnNavigatorItems}
          activeAnchorId={turnNavigatorActiveId}
          sessionRunning={currentSession.status === 'running'}
          hasMoreBefore={Boolean(currentSession.messageHistory?.hasMoreBefore)}
          onLoadEarlier={handleTurnNavigatorLoadEarlier}
          scrollContainerRef={scrollContainerRef}
          onNavigate={handleTurnNavigatorNavigate}
        />
      </div>

      {/* Drag overlay so mouse events are not swallowed mid-resize */}
      {isMarkdownViewerResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </div>
    </InlineMetaAppActorContext.Provider>
  );
};

export default CoworkSessionDetail;
