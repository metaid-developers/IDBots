import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { toRenderableAvatarSource } from '../../utils/avatarSource';
import NftAvatarFrame from '../metabots/NftAvatarFrame';
import { parseNftAvatarReference } from '../metabots/nftAvatarPresentation.js';
import { buildBotPageBrowserUri } from '../../features/botBrowser/botBrowserIntent';
import type { GroupTaskMemberPreview, GroupTaskSummary } from '../../types/groupTask';
import {
  formatGroupTaskRelativeTime,
  groupTaskStatusBadgeClass,
  groupTaskStatusLabelKey,
  isBotBrowserUri,
  openGroupTaskUri,
} from './groupTaskUtils';

/**
 * Open a member/sender Bot page in the Bot Browser via the app-wide URI
 * channel (the same DOM event the markdown link renderer uses). Keeps avatar
 * components free of per-view callback threading.
 */
export const openBotPageInBotBrowser = (globalMetaId: string | null | undefined): void => {
  const uri = buildBotPageBrowserUri(globalMetaId ?? '');
  if (!uri || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
};

const avatarInitial = (name?: string | null): string => {
  const trimmed = name?.trim() ?? '';
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
};

export const groupTaskMemberPreviews = (task: GroupTaskSummary): GroupTaskMemberPreview[] => {
  if (Array.isArray(task.members) && task.members.length > 0) {
    return [...task.members].sort((a, b) => {
      if (a.role === 'chair' && b.role !== 'chair') return -1;
      if (b.role === 'chair' && a.role !== 'chair') return 1;
      return 0;
    });
  }
  return (task.memberNames ?? []).map((name) => ({
    name,
    avatar: null,
    role: name === task.chairName ? 'chair' : 'worker',
    metabotId: null,
    globalMetaId: null,
  }));
};

export const relativeTimeTitle = (unit: string, count: number): string => {
  if (unit === 'now') return i18nService.t('justNow');
  if (unit === 'minutes') return `${count} ${i18nService.t('minutesAgo')}`;
  if (unit === 'hours') return `${count} ${i18nService.t('hoursAgo')}`;
  if (unit === 'yesterday') return i18nService.t('yesterday');
  if (unit === 'days') return `${count} ${i18nService.t('daysAgo')}`;
  return '';
};

/** Tiny circular avatar sized to sit on the same row as `text-xs` member names. */
export const GroupTaskTinyAvatar: React.FC<{
  src?: string | null;
  name?: string | null;
  size?: 'list' | 'hover';
  /** When set, clicking opens this member's Bot page in the Bot Browser. */
  browserGlobalMetaId?: string | null;
}> = ({ src, name, size = 'list', browserGlobalMetaId }) => {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [src]);
  const renderSrc = toRenderableAvatarSource(src);
  const showImage = renderSrc != null && !imageFailed;
  const box = size === 'hover' ? 'h-5 w-5 text-[10px]' : 'h-4 w-4 text-[9px]';
  const displayName = name?.trim() || '';
  const body = parseNftAvatarReference(src) ? (
    <NftAvatarFrame
      avatar={src}
      frameClassName={`${box} rounded-full`}
      fallback={<span className="text-[9px] font-semibold text-claude-textSecondary">{avatarInitial(name)}</span>}
      alt={displayName}
    />
  ) : (
    <span
      className={`flex ${box} flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-claude-surfaceHover font-semibold text-claude-textSecondary dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary`}
      title={browserGlobalMetaId ? undefined : (displayName || undefined)}
    >
      {showImage ? (
        <img
          src={renderSrc ?? undefined}
          alt={displayName}
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        avatarInitial(name)
      )}
    </span>
  );

  if (!browserGlobalMetaId) return body;

  const label = i18nService.t('groupTasksOpenBotInBrowser').replace('{name}', displayName || 'Bot');
  return (
    <button
      type="button"
      data-browser-global-metaid={browserGlobalMetaId}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // Avatars sit inside clickable task cards/sidebar rows; opening the
        // Bot page must not also open the task.
        event.stopPropagation();
        event.preventDefault();
        openBotPageInBotBrowser(browserGlobalMetaId);
      }}
      className={`flex-shrink-0 rounded-full transition-shadow hover:ring-2 hover:ring-claude-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60 ${box}`}
    >
      {body}
    </button>
  );
};

export const GroupTaskMemberAvatarRow: React.FC<{ members: GroupTaskMemberPreview[] }> = ({
  members,
}) => {
  if (members.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {members.map((member, index) => (
        <GroupTaskTinyAvatar
          key={`${member.metabotId ?? member.name}-${index}`}
          src={member.avatar}
          name={member.name}
          browserGlobalMetaId={member.globalMetaId}
        />
      ))}
    </span>
  );
};

/**
 * R3: a deliverable URI rendered in FULL (never abbreviated — bots/owners must
 * be able to copy the exact id). metaweb schemes (metaapp://, pin://, …) and
 * http(s) are clickable and open in the right surface (Bot Browser vs external
 * browser); the copy button always gives the full URI regardless of scheme.
 * Shared by the local task detail and the OpenTeam collab detail rails.
 */
export const GroupTaskDeliverableUri: React.FC<{ uri: string }> = ({ uri }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  };
  const clickable = isBotBrowserUri(uri) || /^https?:\/\//i.test(uri);
  return (
    <div className="mt-1 flex items-start gap-1">
      <button
        type="button"
        onClick={() => clickable && openGroupTaskUri(uri)}
        disabled={!clickable}
        title={clickable ? uri : i18nService.t('groupTasksAcceptancePublishedPin')}
        className={`block text-left text-xs break-all ${
          clickable
            ? 'text-claude-accent hover:underline cursor-pointer'
            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-text'
        }`}
      >
        {uri}
      </button>
      <button
        type="button"
        onClick={(e) => void handleCopy(e)}
        className="shrink-0 mt-px inline-flex items-center text-[10px] text-claude-accent hover:underline"
        title={i18nService.t('copy')}
      >
        {copied
          ? <CheckIcon className="h-3 w-3 text-emerald-500" />
          : <ClipboardDocumentIcon className="h-3 w-3" />}
      </button>
    </div>
  );
};

export const GroupTaskHoverCard: React.FC<{
  task: GroupTaskSummary;
  anchorRect: DOMRect | null;
}> = ({ task, anchorRect }) => {
  if (!anchorRect || typeof document === 'undefined') return null;

  const members = groupTaskMemberPreviews(task);
  const displayTitle = task.displayName?.trim() || task.title;
  const relative = formatGroupTaskRelativeTime(task.updatedAt ?? task.createdAt);
  const panelWidth = 260;
  const padding = 8;
  let left = anchorRect.right + 8;
  if (left + panelWidth > window.innerWidth - padding) {
    left = Math.max(padding, anchorRect.left - panelWidth - 8);
  }
  const top = Math.min(anchorRect.top, window.innerHeight - 240);

  return createPortal(
    <div
      role="tooltip"
      style={{ top, left, width: panelWidth }}
      className="pointer-events-none fixed z-[80] max-h-[70vh] overflow-y-auto rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-2.5 shadow-popover"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
            {displayTitle}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}>
              {i18nService.t(groupTaskStatusLabelKey(task.status))}
            </span>
            {task.mode === 'chat' ? (
              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-claude-accent/10 text-claude-accent">
                {i18nService.t('groupTasksFormModeChat')}
              </span>
            ) : null}
            {relative.compact ? (
              <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {relative.compact}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {task.goal?.trim() ? (
        <div className="mt-2">
          <div className="text-[10px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('groupTasksFormGoal')}
          </div>
          <p className="mt-0.5 text-xs leading-snug dark:text-claude-darkText text-claude-text line-clamp-3">
            {task.goal.trim()}
          </p>
        </div>
      ) : null}
      <div className="mt-2">
        <div className="text-[10px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('groupTasksMembers')}
        </div>
        <div className="mt-1 space-y-1">
          {members.length === 0 ? (
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">—</div>
          ) : (
            members.map((member, index) => (
              <div
                key={`${member.metabotId ?? member.name}-${index}`}
                className="flex items-center gap-2 min-w-0"
              >
                <GroupTaskTinyAvatar src={member.avatar} name={member.name} size="hover" browserGlobalMetaId={member.globalMetaId} />
                <span className="min-w-0 flex-1 truncate text-xs dark:text-claude-darkText text-claude-text">
                  {member.name || '?'}
                </span>
                {member.role === 'chair' ? (
                  <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-claude-accent/15 text-claude-accent">
                    {i18nService.t('groupTasksChairBadge')}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
