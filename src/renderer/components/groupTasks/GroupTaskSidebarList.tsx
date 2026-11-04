import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { groupTaskStatusBadgeClass, formatGroupTaskRelativeTime, groupTaskStatusLabelKey } from './groupTaskUtils';
import GroupTaskItemMenu, { PushPinIcon } from './GroupTaskItemMenu';
import {
  GroupTaskHoverCard,
  GroupTaskMemberAvatarRow,
  groupTaskMemberPreviews,
  relativeTimeTitle,
} from './GroupTaskListMeta';
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline';
import type { GroupTaskSummary } from '../../types/groupTask';

/**
 * Row-level type badge for the unified records list: distinguishes local
 * group tasks (every seat is one of this machine's bots) from Open Team
 * entries (remote invitees / remote-hosted) without splitting the list into
 * separate sections. Shared with the joined-collab sidebar row.
 */
export type GroupTaskTypeVariant = 'local' | 'openteam-host' | 'openteam-guest';

export const GroupTaskTypeBadge: React.FC<{ type: GroupTaskTypeVariant }> = ({ type }) => (
  <span className="shrink-0 rounded px-1 py-px text-[9px] font-medium leading-none border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted text-claude-textSecondary dark:text-claude-darkTextSecondary">
    {i18nService.t(
      type === 'local'
        ? 'groupTasksTaskBadgeLocal'
        : 'groupTasksTaskBadgeOpenTeam'
    )}
  </span>
);

interface GroupTaskSidebarListProps {
  tasks: GroupTaskSummary[];
  selectedTaskId?: number | null;
  onSelectTask: (taskId: number) => void;
  onTogglePin?: (taskId: number, pinned: boolean) => void;
  onRename?: (taskId: number, title: string) => void;
  onArchive?: (taskId: number) => void;
  /** Empty-state message; defaults to the group-task empty text. */
  emptyText?: string;
  /** Task ids that carry at least one remote (OpenTeam invitee) seat; they render an Open Team type badge. */
  openTeamTaskIds?: Set<number>;
  /** Determines type badge variant for each task */
  getTaskType?: (task: GroupTaskSummary) => GroupTaskTypeVariant;
}

/**
 * Group-task entity list for the sidebar "Group Tasks" tab. Unlike the
 * co-work/A2A tabs (which show cowork sessions), this tab shows the real
 * group-task records — title, status badge, chair/members, update time —
 * and opens the full Group Tasks detail view on click. Each item carries the
 * same context menu as the main list (copy group ID / rename / pin / archive).
 */
const GroupTaskSidebarList: React.FC<GroupTaskSidebarListProps> = ({
  tasks,
  selectedTaskId = null,
  onSelectTask,
  onTogglePin,
  onRename,
  onArchive,
  emptyText,
  openTeamTaskIds,
  getTaskType,
}) => {
  if (tasks.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {emptyText ?? i18nService.t('coworkEmptyGroup')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {tasks.map((task) => {
        const taskType = getTaskType
          ? getTaskType(task)
          : openTeamTaskIds?.has(task.id)
            ? 'openteam-host'
            : 'local';
        return (
          <GroupTaskSidebarRow
            key={task.id}
            task={task}
            isActive={selectedTaskId === task.id}
            onSelectTask={onSelectTask}
            onTogglePin={onTogglePin}
            onRename={onRename}
            onArchive={onArchive}
            taskType={taskType}
          />
        );
      })}
    </div>
  );
};

export interface GroupTaskSidebarRowProps {
  task: GroupTaskSummary;
  /** Whether this task is currently selected */
  isSelected?: boolean;
  /** Legacy prop name for isSelected */
  isActive?: boolean;
  /** Callback when task is clicked */
  onSelect?: () => void;
  /** Legacy callback with taskId */
  onSelectTask?: (taskId: number) => void;
  onTogglePin?: (taskId: number, pinned: boolean) => void;
  onRename?: (taskId: number, title: string) => void;
  onArchive?: (taskId: number) => void;
  /** Type badge variant for this task. */
  taskType: GroupTaskTypeVariant;
}

export const GroupTaskSidebarRow: React.FC<GroupTaskSidebarRowProps> = ({
  task,
  isSelected: isSelectedProp,
  isActive: isActiveProp,
  onSelect: onSelectProp,
  onSelectTask: onSelectTaskProp,
  onTogglePin,
  onRename,
  onArchive,
  taskType,
}) => {
  // Support both new and legacy props
  const isActive = isSelectedProp ?? isActiveProp ?? false;
  const handleSelect = () => {
    if (onSelectProp) {
      onSelectProp();
    } else if (onSelectTaskProp) {
      onSelectTaskProp(task.id);
    }
  };

  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const displayTitle = task.displayName?.trim() || task.title;
  const actionLabel = i18nService.t('coworkSessionActions');
  const members = groupTaskMemberPreviews(task);
  const relative = formatGroupTaskRelativeTime(task.updatedAt ?? task.createdAt);

  const handleCopyGroupId = () => {
    const value = task.groupId?.trim() || `#${task.id}`;
    try {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
      if (clipboard) void clipboard.writeText(value);
    } catch {
      // Ignore clipboard failures; the menu should still close.
    }
  };

  return (
    <GroupTaskItemMenu
      task={task}
      onTogglePin={(pinned) => onTogglePin?.(task.id, pinned)}
      onRename={(title) => onRename?.(task.id, title)}
      onArchive={() => onArchive?.(task.id)}
      onCopyGroupId={handleCopyGroupId}
    >
      {(api) => (
        <div
          role="button"
          tabIndex={0}
          aria-current={isActive ? 'true' : undefined}
          onClick={() => {
            if (api.isRenaming) return;
            api.closeMenu();
            handleSelect();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (api.isRenaming) return;
              handleSelect();
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            api.openMenuAt(event.clientX, event.clientY);
          }}
          onMouseEnter={(event) => {
            if (api.isRenaming) return;
            setHoverRect(event.currentTarget.getBoundingClientRect());
          }}
          onMouseLeave={() => setHoverRect(null)}
          className={`group relative px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${
            isActive
              ? 'bg-black/[0.06] dark:bg-white/[0.08]'
              : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
          }`}
        >
          <div className="flex items-center gap-2 mb-0.5">
            <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              #{task.id}
            </span>
            {api.isRenaming ? (
              <input
                ref={api.renameInputRef}
                value={api.renameValue}
                onChange={(event) => api.onRenameInputChange(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={api.onRenameInputKeyDown}
                onBlur={api.onRenameInputBlur}
                className="flex-1 min-w-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-0.5 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
            ) : (
              <span className="flex-1 min-w-0 truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
                {displayTitle}
              </span>
            )}
            <GroupTaskTypeBadge type={taskType} />
            {task.hasOpenCheckpoint ? (
              <span
                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400"
                title={i18nService.t('groupTasksCheckpointAwaitingOwner')}
              >
                ⏸ {i18nService.t('groupTasksCheckpointAwaitingOwner')}
              </span>
            ) : null}
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}
            >
              {i18nService.t(groupTaskStatusLabelKey(task.status))}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-tight">
            <GroupTaskMemberAvatarRow members={members} />
            {relative.compact ? (
              <span
                className="shrink-0 whitespace-nowrap"
                title={relativeTimeTitle(relative.unit, relative.count)}
              >
                {relative.compact}
              </span>
            ) : null}
          </div>

          <div
            className={`absolute right-1.5 top-1.5 transition-opacity ${
              api.isRenaming
                ? 'opacity-0 pointer-events-none'
                : task.pinned
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <button
              ref={api.actionButtonRef}
              onClick={api.openMenu}
              className="p-1 rounded-md bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurface hover:bg-claude-surface transition-colors"
              aria-label={actionLabel}
            >
              {task.pinned ? (
                <span className="relative block h-3.5 w-3.5">
                  <PushPinIcon className="h-3.5 w-3.5 transition-opacity duration-150 group-hover:opacity-0" />
                  <EllipsisHorizontalIcon className="absolute inset-0 h-3.5 w-3.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                </span>
              ) : (
                <EllipsisHorizontalIcon className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {api.renderMenu()}
          {api.renderArchiveConfirm()}
          {!api.isRenaming ? <GroupTaskHoverCard task={task} anchorRect={hoverRect} /> : null}
        </div>
      )}
    </GroupTaskItemMenu>
  );
};

export default GroupTaskSidebarList;
