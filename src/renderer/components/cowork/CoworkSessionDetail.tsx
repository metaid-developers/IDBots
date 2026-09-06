import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import type { ModelEffortValue } from '../ModelEffortPicker';
import { convertLegacyEffortLevel, LLM_EFFORT_DEFAULT_SENTINEL } from '../../services/modelCatalog';
import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkExecutionMode,
  CoworkServiceOrderSummary,
  CoworkPermissionResult,
} from '../../types/cowork';
import type { Skill } from '../../types/skill';
import type { SettingsOpenOptions } from '../Settings';
import CoworkPromptInput from './CoworkPromptInput';
import CoworkPermissionPanel from './CoworkPermissionPanel';
import { buildSessionComposerCommands } from './composerCommandCatalog';
import PermissionModeSelector from './PermissionModeSelector';
import SubagentPanel from './SubagentPanel';
import TodoPanel from './TodoPanel';
import UsageStatsChip from './UsageStatsChip';
import ManualCompactButton from './ManualCompactButton';
import A2AMessageItem from './A2AMessageItem';
import MessageFeedbackControls from './MessageFeedbackControls';
import { ThinkingBlock, splitThinkTaggedContent } from './ThinkingBlock';
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
import MarkdownViewerPanel from './MarkdownViewerPanel';
import LocalFileLink from '../ui/LocalFileLink';
import {
  CheckIcon,
  InformationCircleIcon,
  PuzzlePieceIcon,
  EllipsisHorizontalIcon,
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
import { projectsService } from '../../services/projects';
import { fetchMetaidInfoByGlobalId, resolveMetaidAvatarSource } from '../../services/metabotInfoService';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { getCompactFolderName } from '../../utils/path';
import { isRenderableAvatarSource as isSharedRenderableAvatarSource } from '../../utils/avatarSource';
import {
  buildPrivateA2ASessionDisplayId,
  getCoworkSessionTitleClassName,
  shouldShowA2AServiceSessionId,
} from './coworkSessionPresentation.js';
import {
  buildRefundStatusDismissKey,
  getRefundCardVariant,
  shouldShowRefundStatusCard,
} from './coworkServiceOrderPresentation.js';

interface CoworkSessionDetailProps {
  onManageSkills?: () => void;
  onContinue: (prompt: string, skillPrompt?: string) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  submitError?: string | null;
  focusedOrderTxid?: string | null;
  onFocusedOrderConsumed?: (orderTxid: string) => void;
  onNavigateHome?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
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
/** Machine error code of the free-quota relay, preserved in error text by the proxy. */
const FREE_QUOTA_EXHAUSTED_CODE = 'free_quota_exhausted';
const REFUND_STATUS_DISMISS_STORAGE_KEY = 'idbots.cowork.dismissedRefundStatusCards.v1';
/** In-app markdown viewer sidebar: width fraction of the session area. */
const MARKDOWN_VIEWER_WIDTH_STORAGE_KEY = 'idbots.cowork.markdownViewerWidth';
const MARKDOWN_VIEWER_DEFAULT_FRACTION = 0.25;
const MARKDOWN_VIEWER_MAX_FRACTION = 0.5;
const MARKDOWN_VIEWER_MIN_WIDTH_PX = 280;
const MARKDOWN_FILE_RE = /\.(md|markdown)$/i;

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
const DELEGATION_CONTROL_PREFIX = '[DELEGATE_REMOTE_SERVICE]';
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

const getToolResultDisplay = (message: CoworkMessage): string => {
  if (hasText(message.content)) {
    return message.content;
  }
  if (hasText(message.metadata?.toolResult)) {
    return message.metadata?.toolResult ?? '';
  }
  if (hasText(message.metadata?.error)) {
    return message.metadata?.error ?? '';
  }
  return '';
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

const stripFileProtocol = (value: string): string => {
  let cleaned = value.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
};

const hasScheme = (value: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(value);

const isAbsolutePath = (value: string): boolean => (
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
);

const isRelativePath = (value: string): boolean => !isAbsolutePath(value) && !hasScheme(value);
const SANDBOX_WORKSPACE_GUEST_ROOT = '/workspace/project';
const SANDBOX_WORKSPACE_LEGACY_ROOT = '/workspace';
const SANDBOX_WORKSPACE_RESERVED_DIRS = new Set(['skills', 'ipc', 'tmp']);
const SANDBOX_WORKSPACE_PATH_PATTERN = /\/workspace(?:\/project)?(?:\/[^\s'"`)\]}>,;:!?]*)?/g;

const isReservedSandboxSegment = (relativePath: string): boolean => {
  const [firstSegment] = relativePath.split('/');
  return Boolean(firstSegment && SANDBOX_WORKSPACE_RESERVED_DIRS.has(firstSegment.toLowerCase()));
};

const mapSandboxGuestPathToCwd = (filePath: string, cwd?: string): string | null => {
  if (!cwd) return null;

  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedCwd = cwd.replace(/[\\/]+$/, '');

  if (
    normalizedPath === SANDBOX_WORKSPACE_GUEST_ROOT
    || normalizedPath.startsWith(`${SANDBOX_WORKSPACE_GUEST_ROOT}/`)
  ) {
    const relativePath = normalizedPath
      .slice(SANDBOX_WORKSPACE_GUEST_ROOT.length)
      .replace(/^\/+/, '');
    if (relativePath && isReservedSandboxSegment(relativePath)) {
      return null;
    }
    return relativePath ? `${normalizedCwd}/${relativePath}` : normalizedCwd;
  }

  if (
    normalizedPath !== SANDBOX_WORKSPACE_LEGACY_ROOT
    && !normalizedPath.startsWith(`${SANDBOX_WORKSPACE_LEGACY_ROOT}/`)
  ) {
    return null;
  }

  const legacyRelativePath = normalizedPath
    .slice(SANDBOX_WORKSPACE_LEGACY_ROOT.length)
    .replace(/^\/+/, '');
  if (!legacyRelativePath) {
    return normalizedCwd;
  }

  if (isReservedSandboxSegment(legacyRelativePath)) {
    return null;
  }

  return `${normalizedCwd}/${legacyRelativePath}`;
};

const mapSandboxGuestPathsInText = (value: string, cwd?: string): string => {
  if (!value || !cwd || !value.includes('/workspace')) {
    return value;
  }

  return value.replace(SANDBOX_WORKSPACE_PATH_PATTERN, (candidatePath) =>
    mapSandboxGuestPathToCwd(candidatePath, cwd) ?? candidatePath);
};

const parseRootRelativePath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return null;
  const separatorIndex = trimmed.indexOf('::');
  if (separatorIndex < 0) return null;

  const rootPart = trimmed.slice(0, separatorIndex);
  const relativePart = trimmed.slice(separatorIndex + 2);
  if (!relativePart.trim()) return null;

  const rootPath = safeDecodeURIComponent(stripFileProtocol(stripHashAndQuery(rootPart)));
  const relativePath = safeDecodeURIComponent(stripHashAndQuery(relativePart));
  if (!rootPath || !relativePath) return null;

  const normalizedRoot = rootPath.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[\\/]+/, '');
  if (!normalizedRelative) return null;

  return `${normalizedRoot}/${normalizedRelative}`;
};

const normalizeLocalPath = (
  value: string
): { path: string; isRelative: boolean; isAbsolute: boolean } | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fileScheme = /^file:\/\//i.test(trimmed);
  const schemePresent = hasScheme(trimmed);
  if (schemePresent && !fileScheme && !isAbsolutePath(trimmed)) return null;

  let raw = trimmed;
  if (fileScheme) {
    raw = stripFileProtocol(raw);
  }
  raw = stripHashAndQuery(raw);
  const decoded = safeDecodeURIComponent(raw);
  const path = decoded || raw;
  if (!path) return null;

  const isAbsolute = isAbsolutePath(path);
  const isRelative = isRelativePath(path);
  return { path, isRelative, isAbsolute };
};

const toAbsolutePathFromCwd = (filePath: string, cwd: string): string => {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }
  return `${cwd.replace(/\/$/, '')}/${filePath.replace(/^\.\//, '')}`;
};

const LOCAL_IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const LOCAL_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const IMAGE_LINK_DESTINATION_PATTERN = /\[[^\]]*]\(([^)\r\n]+)\)/g;
const IMAGE_CANDIDATE_PATTERN = /(?:^|[\s"'`([{<:：])((?:file:\/\/[^\s"'`)\]}>]+|[A-Za-z]:\\[^\s"'`<>|]+|\/[^\s"'`<>|]+|\.{1,2}[\\/][^\s"'`<>|]+|[^\s"'`<>|]+)\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s"'`)\]}>，。,；;:：!?])/gi;

type LocalImagePreviewCacheEntry =
  | { status: 'ready'; dataUrl: string }
  | { status: 'error' };

const localImagePreviewCache = new Map<string, LocalImagePreviewCacheEntry>();

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

const hasSupportedImageExtension = (value: string): boolean => {
  const base = stripHashAndQuery(value.trim());
  const match = /\.([A-Za-z0-9]+)$/.exec(base);
  if (!match) return false;
  return LOCAL_IMAGE_EXTENSIONS.has(match[1].toLowerCase());
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

const getPathBaseName = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
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

type ToolGroupItem = {
  type: 'tool_group';
  toolUse: CoworkMessage;
  toolResult?: CoworkMessage | null;
};

type DisplayItem =
  | { type: 'message'; message: CoworkMessage }
  | ToolGroupItem;

type AssistantTurnItem =
  | { type: 'assistant'; message: CoworkMessage }
  | { type: 'system'; message: CoworkMessage }
  | { type: 'tool_group'; group: ToolGroupItem }
  | { type: 'tool_result'; message: CoworkMessage };

type ConversationTurn = {
  id: string;
  userMessage: CoworkMessage | null;
  assistantItems: AssistantTurnItem[];
};

const shouldHideControlMessage = (message: CoworkMessage): boolean => {
  if (isA2ATransportHandshakeMessage(message)) {
    return true;
  }
  if (message.metadata?.isDelegationInternal) {
    return true;
  }
  // Ephemeral SDK runtime-status signals (api_retry / requesting) are surfaced
  // in StreamingActivityBar, not as persisted message bubbles.
  if (typeof message.metadata?.sdkRuntimeStatus === 'string') {
    return true;
  }
  // Prompt-suggestion signals are surfaced as chips below the prompt input.
  if (typeof message.metadata?.promptSuggestion === 'string') {
    return true;
  }
  // Subagent activity signals drive the live subagent panel, not the message list.
  if (message.metadata?.subagentEvent && typeof message.metadata.subagentEvent === 'object') {
    return true;
  }
  return typeof message.content === 'string' && message.content.includes(DELEGATION_CONTROL_PREFIX);
};

const isA2ATransportHandshakeMessage = (message: CoworkMessage): boolean => {
  const isMetawebPrivate = message.metadata?.sourceChannel === 'metaweb_private';
  if (!isMetawebPrivate) {
    return false;
  }
  const normalizedContent = typeof message.content === 'string'
    ? message.content.trim().toLowerCase().replace(/[^a-z]/g, '')
    : '';
  return normalizedContent === 'ping' || normalizedContent === 'pong';
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

const buildDisplayItems = (messages: CoworkMessage[]): DisplayItem[] => {
  const items: DisplayItem[] = [];
  const groupsByToolUseId = new Map<string, ToolGroupItem>();
  let pendingAdjacentGroup: ToolGroupItem | null = null;

  for (const message of messages) {
    if (shouldHideControlMessage(message)) {
      continue;
    }

    if (message.type === 'tool_use') {
      const group: ToolGroupItem = { type: 'tool_group', toolUse: message };
      items.push(group);

      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && toolUseId.trim()) {
        groupsByToolUseId.set(toolUseId, group);
      }
      pendingAdjacentGroup = group;
      continue;
    }

    if (message.type === 'tool_result') {
      let matched = false;
      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && groupsByToolUseId.has(toolUseId)) {
        const group = groupsByToolUseId.get(toolUseId);
        if (group) {
          group.toolResult = message;
          matched = true;
        }
      } else if (pendingAdjacentGroup && !pendingAdjacentGroup.toolResult) {
        pendingAdjacentGroup.toolResult = message;
        matched = true;
      }

      pendingAdjacentGroup = null;
      if (!matched) {
        items.push({ type: 'message', message });
      }
      continue;
    }

    pendingAdjacentGroup = null;
    items.push({ type: 'message', message });
  }

  return items;
};

const buildConversationTurns = (items: DisplayItem[]): ConversationTurn[] => {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;
  let orphanIndex = 0;

  const ensureTurn = (): ConversationTurn => {
    if (currentTurn) return currentTurn;
    const orphanTurn: ConversationTurn = {
      id: `orphan-${orphanIndex++}`,
      userMessage: null,
      assistantItems: [],
    };
    turns.push(orphanTurn);
    currentTurn = orphanTurn;
    return orphanTurn;
  };

  for (const item of items) {
    if (item.type === 'message' && item.message.type === 'user') {
      currentTurn = {
        id: item.message.id,
        userMessage: item.message,
        assistantItems: [],
      };
      turns.push(currentTurn);
      continue;
    }

    const turn = ensureTurn();
    if (item.type === 'tool_group') {
      turn.assistantItems.push({ type: 'tool_group', group: item });
      continue;
    }

    const message = item.message;
    if (message.type === 'assistant') {
      turn.assistantItems.push({ type: 'assistant', message });
      continue;
    }

    if (message.type === 'system') {
      turn.assistantItems.push({ type: 'system', message });
      continue;
    }

    if (message.type === 'tool_result') {
      turn.assistantItems.push({ type: 'tool_result', message });
      continue;
    }

    if (message.type === 'tool_use') {
      turn.assistantItems.push({
        type: 'tool_group',
        group: {
          type: 'tool_group',
          toolUse: message,
        },
      });
    }
  }

  return turns;
};

const isRenderableAssistantOrSystemMessage = (message: CoworkMessage): boolean => {
  if (hasText(message.content) || hasText(message.metadata?.error)) {
    return true;
  }
  if (message.metadata?.isThinking) {
    return Boolean(message.metadata?.isStreaming);
  }
  return false;
};

const isVisibleAssistantTurnItem = (item: AssistantTurnItem): boolean => {
  if (item.type === 'assistant' || item.type === 'system') {
    return isRenderableAssistantOrSystemMessage(item.message);
  }
  if (item.type === 'tool_result') {
    return hasText(getToolResultDisplay(item.message));
  }
  return true;
};

const getVisibleAssistantItems = (assistantItems: AssistantTurnItem[]): AssistantTurnItem[] =>
  assistantItems.filter(isVisibleAssistantTurnItem);

const hasRenderableAssistantContent = (turn: ConversationTurn): boolean => (
  getVisibleAssistantItems(turn.assistantItems).length > 0
);

const formatCompactTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
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

const ImagePreviewStrip: React.FC<{ imagePaths: string[] }> = ({ imagePaths }) => {
  const [previewData, setPreviewData] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    const cachedPreviews: Record<string, string> = {};
    for (const imagePath of imagePaths) {
      const cached = localImagePreviewCache.get(imagePath);
      if (cached?.status === 'ready') {
        cachedPreviews[imagePath] = cached.dataUrl;
      }
    }
    setPreviewData(cachedPreviews);

    const pendingPaths = imagePaths.filter((imagePath) => !localImagePreviewCache.has(imagePath));
    if (pendingPaths.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    pendingPaths.forEach((imagePath) => {
      void window.electron.cowork.readLocalImage({
        path: imagePath,
        maxBytes: LOCAL_IMAGE_PREVIEW_MAX_BYTES,
      }).then((result) => {
        if (cancelled) return;
        if (result?.success && typeof result.dataUrl === 'string' && result.dataUrl) {
          localImagePreviewCache.set(imagePath, { status: 'ready', dataUrl: result.dataUrl });
          setPreviewData((prev) => (
            prev[imagePath]
              ? prev
              : { ...prev, [imagePath]: result.dataUrl }
          ));
          return;
        }
        localImagePreviewCache.set(imagePath, { status: 'error' });
      }).catch(() => {
        if (!cancelled) {
          localImagePreviewCache.set(imagePath, { status: 'error' });
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [imagePaths]);

  const visiblePaths = imagePaths.filter((imagePath) => typeof previewData[imagePath] === 'string');
  if (visiblePaths.length === 0) return null;

  const handleOpenPath = async (imagePath: string) => {
    try {
      await window.electron.shell.openPath(imagePath);
    } catch (error) {
      console.error('Failed to open image path:', imagePath, error);
    }
  };

  return (
    <div className="ml-4 mt-2 flex flex-wrap gap-2">
      {visiblePaths.map((imagePath) => (
        <LocalFileLink
          key={imagePath}
          filePath={imagePath}
          title={imagePath}
          showTypeIcon={false}
          onOpen={(path) => { void handleOpenPath(path); }}
          className="group rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden dark:bg-claude-darkSurface bg-claude-surface hover:border-claude-accent transition-colors"
        >
          <img
            src={previewData[imagePath]}
            alt={getPathBaseName(imagePath)}
            className="h-24 w-24 object-cover"
            loading="lazy"
          />
          <div className="px-1.5 py-1 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-24 truncate text-left">
            {getPathBaseName(imagePath)}
          </div>
        </LocalFileLink>
      ))}
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

// Copy button component
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
          className="w-4 h-4 text-[var(--icon-secondary)]"
          aria-hidden="true"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
        </svg>
      )}
    </button>
  );
};

// Message timestamp shown next to the copy button, sharing its
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
}> = ({ message, skills }) => {
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
                <div className="w-fit max-w-[min(646px,82%)]">
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
              <div className="w-fit max-w-[min(646px,82%)] rounded-[22px] px-[16px] py-[10px] dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text shadow-subtle">
                <MarkdownContent
                  content={message.content}
                  className="max-w-none whitespace-pre-wrap [overflow-wrap:anywhere]"
                />
              </div>
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
}> = ({
  message,
  resolveLocalFilePath,
  mapDisplayText,
  showCopyButton = false,
  onOpenLocalFile,
  onBranch,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const gigSquareCard = renderGigSquareCard(message.content);
  const thinkSplit = splitThinkTaggedContent(displayContent);

  if (gigSquareCard) {
    return (
      <div className="relative">
        {gigSquareCard}
      </div>
    );
  }

  const replyContent = thinkSplit.thinking ? thinkSplit.text : displayContent;

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {thinkSplit.thinking ? (
        <div className="mb-3">
          <ThinkingBlock
            message={{
              ...message,
              content: thinkSplit.thinking,
              metadata: {
                ...message.metadata,
                isThinking: true,
                isStreaming: Boolean(message.metadata?.isStreaming) && !thinkSplit.text,
              },
            }}
            mapDisplayText={mapDisplayText}
          />
        </div>
      ) : null}
      {replyContent ? (
        <div className="dark:text-claude-darkText text-claude-text">
          <MarkdownContent
            content={replyContent}
            className="prose dark:prose-invert max-w-none"
            resolveLocalFilePath={resolveLocalFilePath}
            onOpenLocalFile={onOpenLocalFile}
          />
        </div>
      ) : null}
      {showCopyButton && (
        <div className="flex items-center gap-1.5 mt-1">
          <CopyButton
            content={replyContent || displayContent}
            visible={isHovered}
          />
          <MessageFeedbackControls
            messageId={message.id}
            visible={isHovered}
          />
          <MessageTimestamp
            timestamp={message.timestamp}
            visible={isHovered}
          />
          {onBranch && (
            <button
              type="button"
              onClick={() => void onBranch(message)}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-all duration-200 ${
                isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
              title={i18nService.t('coworkBranchNewChatTitle')}
            >
              <DocumentDuplicateIcon className="h-3 w-3" />
              {i18nService.t('coworkBranchNewChatLabel')}
            </button>
          )}
        </div>
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

// Streaming activity bar shown between messages and input
const StreamingActivityBar: React.FC<{ messages: CoworkMessage[]; fallbackText?: string }> = ({
  messages,
  fallbackText,
}) => {
  // Walk messages backwards to find the latest tool_use without a paired tool_result
  const getStatusText = (): string => {
    // SDK runtime-status signals (api_retry / requesting) take precedence over
    // tool-running text — they describe the transport layer, not the agent loop.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const status = msg.metadata?.sdkRuntimeStatus;
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
        return i18nService.t('coworkRequesting');
      }
      // Stop scanning once we hit a non-runtime-status message — only the most
      // recent SDK status applies.
      break;
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

const AssistantTurnBlock: React.FC<{
  turn: ConversationTurn;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showTypingIndicator?: boolean;
  showCopyButtons?: boolean;
  showImagePreviews?: boolean;
  onOpenLocalFile?: (filePath: string, event: React.MouseEvent) => boolean | void;
  onBranch?: (message: CoworkMessage) => void | Promise<void>;
}> = ({
  turn,
  resolveLocalFilePath,
  mapDisplayText,
  showTypingIndicator = false,
  showCopyButtons = true,
  showImagePreviews = true,
  onOpenLocalFile,
  onBranch,
}) => {
  const visibleAssistantItems = getVisibleAssistantItems(turn.assistantItems);
  // Collapsed by default once a turn completes; the header expands to reveal
  // the working process (thinking, tool calls, intermediate notes).
  const [processExpanded, setProcessExpanded] = useState(false);

  const renderSystemMessage = (message: CoworkMessage) => {
    const meta = message.metadata ?? {};

    // Structured SDK event messages (previously silently dropped events are
    // now surfaced here: notification / informational / compact_boundary /
    // permission_denied / rate_limit_event / conversation_reset).
    let sdkIcon: string | null = null;
    let sdkTint = 'dark:text-claude-darkTextSecondary text-claude-textSecondary';
    let sdkContent = '';

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
    } else if (meta.dshTurnStalled === true) {
      sdkIcon = '⏱️';
      sdkTint = 'text-amber-600 dark:text-amber-400';
      sdkContent = i18nService.t('coworkDshTurnStalled');
    } else if (meta.steerInterruptAcknowledged === true) {
      // The CLI reported the interrupted turn via an internal diagnostic; the
      // steer was delivered and the task continues toward it.
      sdkIcon = '🧭';
      sdkContent = i18nService.t('coworkSteerInterruptAcknowledged').replace(
        '{text}',
        typeof meta.steerText === 'string' ? meta.steerText : ''
      );
    }

    const rawContent = hasText(message.content)
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
        return (
          <ThinkingBlock
            key={item.message.id}
            message={item.message}
            mapDisplayText={mapDisplayText}
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
          showCopyButton={showCopyButtons && !hasToolGroupAfter}
          onOpenLocalFile={onOpenLocalFile}
          onBranch={onBranch}
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
  const isTurnComplete = !visibleAssistantItems.some((item) => {
    const message = item.type === 'tool_group' ? item.group.toolUse : item.message;
    return Boolean(message.metadata?.isStreaming);
  });
  let deliveryIndex = -1;
  for (let i = visibleAssistantItems.length - 1; i >= 0; i--) {
    const item = visibleAssistantItems[i];
    if (item.type === 'assistant' && !item.message.metadata?.isThinking) {
      deliveryIndex = i;
      break;
    }
  }
  const deliveryItem = deliveryIndex >= 0 ? visibleAssistantItems[deliveryIndex] : null;
  const deliveryMessage = deliveryItem && deliveryItem.type === 'assistant' ? deliveryItem.message : null;
  const processItems = deliveryMessage
    ? visibleAssistantItems.filter((_, index) => index !== deliveryIndex)
    : [];
  const workedForMs = deliveryMessage && turn.userMessage
    ? Math.max(0, deliveryMessage.timestamp - turn.userMessage.timestamp)
    : 0;
  const showWorkedHeader = Boolean(
    isTurnComplete
    && deliveryMessage
    && processItems.length > 0
    && turn.userMessage
    && workedForMs > 0
  );

  return (
    <div className="px-4 py-2">
      <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 px-4 py-3 space-y-3">
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
                    {processItems.map((processItem) => (
                      renderVisibleItem(processItem, visibleAssistantItems.indexOf(processItem), visibleAssistantItems)
                    ))}
                  </div>
                )}
                <AssistantMessageItem
                  key={deliveryMessage!.id}
                  message={deliveryMessage!}
                  resolveLocalFilePath={resolveLocalFilePath}
                  mapDisplayText={mapDisplayText}
                  showCopyButton={showCopyButtons}
                  onOpenLocalFile={onOpenLocalFile}
                  onBranch={onBranch}
                />
              </>
            ) : (
              visibleAssistantItems.map((item, index) => renderVisibleItem(item, index, visibleAssistantItems))
            )}
            {showTypingIndicator && <TypingDots />}
          </div>
        </div>
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
  onToggleSidebar,
  onNewChat,
  onOpenBotInBrowser,
  onRequestAppSettings,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const { currentSession, isStreaming, pendingPermissions } = useSelector((state: RootState) => state.cowork);
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
    const success = await coworkService.respondToPermission(pendingPermission.requestId, result);
    if (!success) setIsRespondingToPermission(false);
  }, [pendingPermission, isRespondingToPermission]);
  const isA2ASession = currentSession?.sessionType === 'a2a';
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
  // The free-quota relay surfaces 429 + code free_quota_exhausted (annotated
  // into the error text by the OpenAI-compat proxy). Detect it from persisted
  // system error messages and guide the user to configure their own key.
  const freeQuotaExhausted = useMemo(() => {
    for (const message of currentSession?.messages ?? []) {
      if (message.type !== 'system') continue;
      const content = typeof message.content === 'string' ? message.content : '';
      const metaError = typeof message.metadata?.error === 'string' ? message.metadata.error : '';
      if (content.includes(FREE_QUOTA_EXHAUSTED_CODE) || metaError.includes(FREE_QUOTA_EXHAUSTED_CODE)) {
        return true;
      }
    }
    return false;
  }, [currentSession?.messages]);
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
  // 'default' sentinel for an explicit "Default" pick (model default wins over
  // the bot brain / global rungs — a plain null would fall back to them).
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
  const handleBranchFromMessage = useCallback(async (msg: CoworkMessage) => {
    if (!currentSession || isStreaming) return;
    setBranchActionError(null);
    const forked = await coworkService.forkSession(currentSession.id, msg.id);
    if (!forked) {
      setBranchActionError(i18nService.t('coworkForkFailed'));
    }
  }, [currentSession, isStreaming]);
  const detailRootRef = useRef<HTMLDivElement>(null);
  // Markdown viewer sidebar: .md/.markdown file links in assistant messages
  // open in this right-hand panel instead of an external app. The width is a
  // fraction of the session area (default 1/4, clamped to at most 1/2) and is
  // persisted across sessions.
  const [markdownViewerPath, setMarkdownViewerPath] = useState<string | null>(null);
  const [markdownViewerFraction, setMarkdownViewerFraction] = useState<number>(loadPersistedMarkdownViewerFraction);
  const markdownViewerFractionRef = useRef(markdownViewerFraction);
  const markdownViewerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isMarkdownViewerResizing, setIsMarkdownViewerResizing] = useState(false);

  const handleOpenLocalFile = useCallback((filePath: string): boolean => {
    if (!MARKDOWN_FILE_RE.test(filePath)) return false;
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
  const messageElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const consumedOrderFocusKeyRef = useRef<string | null>(null);
  const lastAutoScrollSessionIdRef = useRef<string | null>(null);
  const skipNextAutoScrollEffectRef = useRef(false);
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
  const [sessionMetabot, setSessionMetabot] = useState<{ name: string; avatar: string | null; llm_id: string | null; llm_provider?: string | null; llm_effort?: string | null; globalmetaid: string | null; metabot_type: string } | null>(null);
  // Picker value: session pick wins, else the bound bot's brain (model id or
  // legacy provider key — the picker resolves legacy keys for display), else
  // nothing (global default). Effort mirrors the runtime tiering:
  // session pick > bot brain effort > global default > model default. A
  // persisted 'default' sentinel (explicit Default pick) converts to null and
  // displays as Default instead of snapping to a fallback rung.
  const sessionUsesBrainModel = sessionModelId == null && Boolean(sessionMetabot?.llm_id);
  const sessionModelEffortValue: ModelEffortValue = {
    modelId: sessionModelId ?? sessionMetabot?.llm_id ?? null,
    providerKey: sessionUsesBrainModel
      ? (sessionMetabot?.llm_provider ?? null)
      : sessionModelProvider,
    effort: (() => {
      if (sessionEffortOverride != null) return convertLegacyEffortLevel(sessionEffortOverride);
      if (currentSession?.effort) return convertLegacyEffortLevel(currentSession.effort);
      if (sessionMetabot?.llm_effort) return convertLegacyEffortLevel(sessionMetabot.llm_effort);
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
      !shouldHideControlMessage(message) && !shouldHideA2AInternalMessage(message)
    )) ?? []
  ), [currentSession?.messages]);
  const a2aPeerGlobalMetaId = useMemo(() => {
    if (currentSession?.sessionType !== 'a2a') return null;
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
    if (currentSession?.sessionType !== 'a2a') {
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
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
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
    if (
      !sessionId
      || currentSession?.sessionType !== 'a2a'
      || !history?.hasMoreBefore
      || history.beforeSequence == null
      || !container
      || historyLoadInFlightRef.current
    ) {
      return;
    }
    historyLoadInFlightRef.current = true;
    setIsLoadingEarlierMessages(true);
    const previousScrollHeight = container.scrollHeight;
    const previousScrollTop = container.scrollTop;
    try {
      const loadedCount = await coworkService.loadEarlierMessages(sessionId);
      if (loadedCount <= 0) return;
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
    } finally {
      historyLoadInFlightRef.current = false;
      setIsLoadingEarlierMessages(false);
    }
  }, [currentSession?.id, currentSession?.sessionType, currentSession?.messageHistory]);

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

  const resolveLocalFilePath = useCallback((href: string, text: string) => {
    const hrefValue = typeof href === 'string' ? href.trim() : '';
    const textValue = typeof text === 'string' ? text.trim() : '';
    if (!hrefValue && !textValue) return null;

    // In sandbox mode, translate VM guest paths to host paths.
    const mapSandboxPath = (filePath: string): string => {
      if (
        currentSession?.executionMode !== 'sandbox' ||
        !currentSession?.cwd
      ) {
        return filePath;
      }
      const mapped = mapSandboxGuestPathToCwd(filePath, currentSession.cwd);
      return mapped ?? filePath;
    };

    const hrefRootRelative = hrefValue ? parseRootRelativePath(hrefValue) : null;
    if (hrefRootRelative) {
      return mapSandboxPath(hrefRootRelative);
    }

    const hrefPath = hrefValue ? normalizeLocalPath(hrefValue) : null;
    if (hrefPath) {
      if (hrefPath.isRelative && currentSession?.cwd) {
        return mapSandboxPath(toAbsolutePathFromCwd(hrefPath.path, currentSession.cwd));
      }
      if (hrefPath.isAbsolute) {
        return mapSandboxPath(hrefPath.path);
      }
    }

    const textRootRelative = textValue ? parseRootRelativePath(textValue) : null;
    if (textRootRelative) {
      return mapSandboxPath(textRootRelative);
    }

    const textPath = textValue ? normalizeLocalPath(textValue) : null;
    if (textPath) {
      if (textPath.isRelative && currentSession?.cwd) {
        return mapSandboxPath(toAbsolutePathFromCwd(textPath.path, currentSession.cwd));
      }
      if (textPath.isAbsolute) {
        return mapSandboxPath(textPath.path);
      }
    }

    return null;
  }, [currentSession?.cwd, currentSession?.executionMode]);

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
    if (!shouldAutoScroll) {
      return;
    }
    if (skipNextAutoScrollEffectRef.current) {
      skipNextAutoScrollEffectRef.current = false;
      return;
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

  if (!currentSession) {
    return null;
  }

  const displayItems = buildDisplayItems(currentSession.messages);
  const turns = buildConversationTurns(displayItems);
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
    if (turns.length === 0) {
      if (!isStreaming) return null;
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
            showCopyButtons={!isStreaming}
            showImagePreviews
            onOpenLocalFile={handleOpenLocalFile}
          />
        </div>
      );
    }

    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      const showTypingIndicator = isStreaming && isLastTurn && !hasRenderableAssistantContent(turn);
      const showAssistantBlock = turn.assistantItems.length > 0 || showTypingIndicator;

      return (
        <React.Fragment key={turn.id}>
          {turn.userMessage && (
            <div data-export-role="user-message">
              <UserMessageItem
                message={turn.userMessage}
                skills={skills}
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
                showCopyButtons={!isStreaming}
                showImagePreviews
                onOpenLocalFile={handleOpenLocalFile}
                onBranch={handleBranchFromMessage}
              />
            </div>
          )}
          {showWelcomeHandoff && hasRenderableAssistantContent(turn) && (
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
    <div ref={detailRootRef} className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 shrink-0">
        {/* Left side: Toggle buttons (when collapsed) + Title + Sandbox badge */}
        <div className="flex h-full items-center gap-2 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
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
              <div className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                {sessionMetabot.avatar ? (
                  <img src={sessionMetabot.avatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[10px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
                    {sessionMetabot.name.slice(0, 2) || '?'}
                  </span>
                )}
              </div>
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
              })} max-w-[360px]`}
            >
              {currentSession.title || i18nService.t('coworkNewSession')}
            </h1>
          )}
          {currentSession.executionMode === 'sandbox' && (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {i18nService.t('coworkSandboxBadge')}
            </span>
          )}
          {currentSession.executionMode === 'local' && !isA2ASession && (
            <span className="inline-flex items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {i18nService.t('coworkLocalBadge')}
            </span>
          )}
          {isA2ASession && (
            <span className="inline-flex items-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {i18nService.t('coworkOnChainBadge')}
            </span>
          )}
          {normalizedFocusedOrderTxid && (
            <span className="non-draggable inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-700 dark:text-amber-300">
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

        {/* Right side: Folder + Menu */}
        <div className="non-draggable flex items-center gap-1">
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
        className="flex-1 overflow-y-auto overflow-anchor-none min-h-0 pt-3"
      >
        {isA2ASession && isLoadingEarlierMessages && (
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
            const items: Array<{ type: 'separator-start' | 'separator-end' | 'message'; key: string; message?: CoworkMessage }> = [];

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
              >
                <A2AMessageItem
                  message={msg}
                  peerName={currentSession.peerName}
                  peerAvatar={resolvedPeerAvatar}
                  metabotName={currentSession.metabotName}
                  metabotAvatar={currentSession.metabotAvatar}
                  peerGlobalMetaId={a2aPeerGlobalMetaId}
                  localGlobalMetaId={sessionMetabot?.globalmetaid}
                  onOpenBotInBrowser={onOpenBotInBrowser}
                  canResendDigitalDelivery={canResendDigitalDelivery}
                  isResendingDigitalDelivery={Boolean(resendingDeliveryOrderTxid)}
                  onResendDigitalDelivery={handleResendDigitalDelivery}
                />
              </div>
            );
          })
        ) : (
          renderConversationTurns()
        )}
        <div ref={messagesEndRef} className="h-20" />
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

      {/* Streaming Activity Bar */}
      {(isStreaming || currentSession.status === 'running') && (
        <StreamingActivityBar
          messages={currentSession.messages}
          fallbackText={isA2ASession ? i18nService.t('coworkA2ABackgroundWorking') : undefined}
        />
      )}

      {freeQuotaExhausted && (
        <div className="px-4 pb-2 shrink-0">
          <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
            <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <ExclamationTriangleIcon className="h-4 w-4 text-red-500 shrink-0" />
              <span className="text-xs text-red-700 dark:text-red-300">
                {i18nService.t('freeQuotaExhaustedBanner')}
              </span>
              {onRequestAppSettings && (
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

      {isA2ASession && currentSession.status === 'error' && !freeQuotaExhausted && (
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

      {/* Input Area */}
      {isA2ASession ? (
        <div className="px-4 py-3 shrink-0 border-t dark:border-claude-darkBorder border-claude-border">
          <div className="mx-auto flex max-w-[clamp(680px,64%,920px)] flex-col items-stretch gap-2">
            {isPrivateA2ASession && (
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
        <div className="p-4 shrink-0">
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
                  {i18nService.t('delegationWaitingForResult')}
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
                scopeKey={currentSession.id}
                onSubmit={onContinue}
                onStop={onStop}
                isStreaming={isStreaming}
                steerDisabled={steerDisabled}
                placeholder={delegationBlocking ? i18nService.t('delegationInputDisabledPlaceholder') : i18nService.t('coworkContinuePlaceholder')}
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

      {/* Drag overlay so mouse events are not swallowed mid-resize */}
      {isMarkdownViewerResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </div>
  );
};

export default CoworkSessionDetail;
