import React from 'react';
import type { OpenTeamCollabSummary } from '../../types/openTeamCollab';
import { GroupTaskTypeBadge } from './GroupTaskSidebarList';
import { GroupTaskMemberAvatarRow, relativeTimeTitle } from './GroupTaskListMeta';
import { formatGroupTaskRelativeTime } from './groupTaskUtils';
import { openTeamCollabStatusBadgeClass, openTeamCollabStatusLabel } from './OpenTeamCollabsSection';

export interface OpenTeamCollabSidebarRowProps {
  collab: OpenTeamCollabSummary;
  /** Whether this collab is currently selected */
  isSelected?: boolean;
  /** Callback when collab is clicked */
  onSelect: () => void;
}

/**
 * Sidebar row for an OpenTeam collaboration (guest role), mirroring the local
 * GroupTaskSidebarRow rhythm: title + type/status badges on the first line,
 * participating-bot avatars + relative time below. No message count and no
 * guest badge — the OpenTeam badge is the only type marker.
 */
export const OpenTeamCollabSidebarRow: React.FC<OpenTeamCollabSidebarRowProps> = ({
  collab,
  isSelected = false,
  onSelect,
}) => {
  // Use taskTitle if available, otherwise fallback to botName, or a truncated groupId
  const displayTitle = collab.taskTitle || collab.botName || `Group ${collab.groupId.slice(0, 8)}`;

  // lastMessageAt is chain_timestamp (unix SECONDS); createdAt is sqlite text.
  // toGroupTaskDate handles both — a naive new Date(seconds) reads as 1970 and
  // rendered absurd relative times like "20739d".
  const relative = formatGroupTaskRelativeTime(collab.lastMessageAt ?? collab.createdAt);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={isSelected ? 'true' : undefined}
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
      className={`
        group relative px-2.5 py-1.5 rounded-lg cursor-pointer
        transition-colors
        ${isSelected ? 'bg-black/[0.06] dark:bg-white/[0.08]' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'}
      `}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="flex-1 min-w-0 truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
          {displayTitle}
        </span>
        <GroupTaskTypeBadge type="openteam-guest" />
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${openTeamCollabStatusBadgeClass(collab)}`}>
          {openTeamCollabStatusLabel(collab)}
        </span>
      </div>

      {/* Participating bots (avatar row, like local task rows) + last activity */}
      <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-tight">
        <GroupTaskMemberAvatarRow members={collab.memberPreviews ?? []} />
        {relative.compact ? (
          <span
            className="shrink-0 whitespace-nowrap"
            title={relativeTimeTitle(relative.unit, relative.count)}
          >
            {relative.compact}
          </span>
        ) : null}
      </div>
    </div>
  );
};
