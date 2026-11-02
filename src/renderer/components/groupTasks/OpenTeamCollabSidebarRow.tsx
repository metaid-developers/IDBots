import React from 'react';
import type { OpenTeamCollabSummary } from '../../types/openTeamCollab';
import { i18nService } from '../../services/i18n';
import { GroupTaskTypeBadge, GroupTaskGuestBadge } from './GroupTaskSidebarList';
import { relativeTimeTitle } from './GroupTaskListMeta';
import { formatGroupTaskRelativeTime } from './groupTaskUtils';

export interface OpenTeamCollabSidebarRowProps {
  collab: OpenTeamCollabSummary;
  /** Whether this collab is currently selected */
  isSelected?: boolean;
  /** Callback when collab is clicked */
  onSelect: () => void;
}

/**
 * Sidebar row for an OpenTeam collaboration (guest role). Shows title, OpenTeam
 * + Guest badges, and relative time. Integrates with the unified task list.
 */
export const OpenTeamCollabSidebarRow: React.FC<OpenTeamCollabSidebarRowProps> = ({
  collab,
  isSelected = false,
  onSelect,
}) => {
  // Use taskTitle if available, otherwise fallback to botName, or a truncated groupId
  const displayTitle = collab.taskTitle || collab.botName || `Group ${collab.groupId.slice(0, 8)}`;

  // Convert timestamp to ISO string for formatGroupTaskRelativeTime
  const updatedAtStr = collab.lastMessageAt
    ? new Date(collab.lastMessageAt).toISOString()
    : collab.createdAt;

  const relative = formatGroupTaskRelativeTime(updatedAtStr ?? new Date().toISOString());

  // Check for unread checkpoint (if hasOpenCheckpoint exists in future)
  const hasCheckpoint = false; // OpenTeam doesn't expose this yet

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={isSelected ? 'true' : undefined}
      className={`
        group relative flex items-start gap-2 px-3 py-2 cursor-pointer
        transition-colors rounded-lg
        ${isSelected ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}
      `}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* Left side: title + badges */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
            {displayTitle}
          </span>
          <GroupTaskTypeBadge type="openteam-guest" />
          <GroupTaskGuestBadge />
        </div>

        {/* Status indicators */}
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {hasCheckpoint && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-500"></span>
              <span>{i18nService.t('groupTask.checkpoint')}</span>
            </span>
          )}

          {collab.status === 'left' && (
            <span className="text-amber-600 dark:text-amber-400">
              {i18nService.t('groupTask.left')}
            </span>
          )}

          {collab.status === 'active' && collab.messageCount > 0 && (
            <span>{collab.messageCount} {i18nService.t('groupTask.messages')}</span>
          )}
        </div>
      </div>

      {/* Right side: timestamp */}
      <div className="flex-shrink-0 text-xs text-slate-500 dark:text-slate-400">
        <time dateTime={updatedAtStr ?? undefined} title={relativeTimeTitle(relative.unit, relative.count)}>
          {relative.compact}
        </time>
      </div>
    </div>
  );
};
