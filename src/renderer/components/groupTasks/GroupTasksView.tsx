import React, { useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { selectCollab, selectTask } from '../../store/slices/groupTasksSlice';
import { groupTaskService } from '../../services/groupTaskService';
import { i18nService } from '../../services/i18n';
import type { GroupTaskListTab, GroupTaskSummary } from '../../types/groupTask';
import GroupTaskDetailView from './GroupTaskDetailView';
import OpenTeamCollabDetailView from './OpenTeamCollabDetailView';
import {
  OpenTeamCollabCard,
  OpenTeamGuestInviteCard,
  openTeamCollabTitle,
  useOpenTeamCollabs,
} from './OpenTeamCollabsSection';
import {
  filterGroupTasksByTab,
  formatGroupTaskRelativeTime,
  groupTaskStatusBadgeClass,
  groupTaskStatusLabelKey,
  shortGroupId,
  splitGroupTasksByOpenTeam,
} from './groupTaskUtils';
import GroupTaskItemMenu, { PushPinIcon } from './GroupTaskItemMenu';
import {
  GroupTaskHoverCard,
  GroupTaskMemberAvatarRow,
  groupTaskMemberPreviews,
  relativeTimeTitle,
} from './GroupTaskListMeta';
import { UserGroupIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import MetaTaskBoard from '../metatask/MetaTaskBoard';

interface GroupTasksViewProps {
  isSidebarCollapsed?: boolean;
  onNewChat?: () => void;
  onNewGroupTask?: () => void;
  updateBadge?: React.ReactNode;
}

const FILTER_TABS: Array<{ id: GroupTaskListTab; labelKey: string }> = [
  { id: 'active', labelKey: 'groupTasksFilterActive' },
  { id: 'done', labelKey: 'groupTasksFilterDone' },
  { id: 'cancelled', labelKey: 'groupTasksFilterCancelled' },
  { id: 'all', labelKey: 'groupTasksFilterAll' },
];

/** Home-page tab: local group tasks, OpenTeam tasks, or the on-chain MetaTask board. */
type GroupTaskHomeMode = 'local' | 'openTeam' | 'metaTask';
/** OpenTeam sub-tab: initiated here (remote invitees) vs joined remotely. */
type OpenTeamListTab = 'initiated' | 'joined';

const MODE_TABS: Array<{ id: GroupTaskHomeMode; labelKey: string }> = [
  { id: 'local', labelKey: 'groupTasksModeLocal' },
  { id: 'openTeam', labelKey: 'groupTasksModeOpenTeam' },
  { id: 'metaTask', labelKey: 'groupTasksModeMetaTask' },
];

const OPEN_TEAM_TABS: Array<{ id: OpenTeamListTab; labelKey: string }> = [
  { id: 'initiated', labelKey: 'groupTasksOpenTeamInitiated' },
  { id: 'joined', labelKey: 'groupTasksOpenTeamJoined' },
];

export { groupTaskStatusLabelKey } from './groupTaskUtils';

interface GroupTaskListItemProps {
  task: GroupTaskSummary;
  onClick: () => void;
  onTogglePin: (pinned: boolean) => void;
  onRename: (title: string) => void;
  onArchive: () => void;
}

const GroupTaskListItem: React.FC<GroupTaskListItemProps> = ({
  task,
  onClick,
  onTogglePin,
  onRename,
  onArchive,
}) => {
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
      onTogglePin={onTogglePin}
      onRename={onRename}
      onArchive={onArchive}
      onCopyGroupId={handleCopyGroupId}
    >
      {(api) => (
        <div
          className="group relative px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer transition-colors"
          onClick={() => {
            if (api.isRenaming) return;
            api.closeMenu();
            onClick();
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
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
                    className="flex-1 min-w-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
                  />
                ) : (
                  <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                    {displayTitle}
                  </span>
                )}
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}>
                  {i18nService.t(groupTaskStatusLabelKey(task.status))}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <GroupTaskMemberAvatarRow members={members} />
                {task.groupId ? (
                  <span className="shrink-0 truncate">{shortGroupId(task.groupId)}</span>
                ) : null}
              </div>
            </div>
            <div className="shrink-0 text-right text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {relative.compact ? (
                <div title={relativeTimeTitle(relative.unit, relative.count)}>
                  {relative.compact}
                </div>
              ) : null}
            </div>
          </div>

          {/* Actions - absolutely positioned overlay */}
          <div
            className={`absolute right-3 top-3 transition-opacity ${
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
              className="p-1.5 rounded-lg bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurface hover:bg-claude-surface transition-colors"
              aria-label={actionLabel}
            >
              {task.pinned ? (
                <span className="relative block h-4 w-4">
                  <PushPinIcon className="h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
                  <EllipsisHorizontalIcon className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                </span>
              ) : (
                <EllipsisHorizontalIcon className="h-4 w-4" />
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

const GroupTasksView: React.FC<GroupTasksViewProps> = ({
  isSidebarCollapsed,
  onNewChat,
  onNewGroupTask,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const tasks = useSelector((state: RootState) => state.groupTasks.tasks);
  const loading = useSelector((state: RootState) => state.groupTasks.loading);
  const selectedTaskId = useSelector((state: RootState) => state.groupTasks.selectedTaskId);
  const selectedCollabId = useSelector((state: RootState) => state.groupTasks.selectedCollabId);
  const [mode, setMode] = useState<GroupTaskHomeMode>('local');
  const [activeTab, setActiveTab] = useState<GroupTaskListTab>('active');
  const [openTeamTab, setOpenTeamTab] = useState<OpenTeamListTab>('initiated');
  const {
    items: collabs,
    guestInvites,
    loaded: collabsLoaded,
    removedNotices,
    dismissRemovedNotice,
  } = useOpenTeamCollabs();
  const selectedCollab = selectedCollabId != null
    ? collabs.find((collab) => collab.id === selectedCollabId) ?? null
    : null;

  useEffect(() => {
    void groupTaskService.loadTasks();
  }, []);

  // Local seats only vs OpenTeam (at least one remote invitee seat).
  const { local: localTasks, openTeam: initiatedTasks } = splitGroupTasksByOpenTeam(tasks);
  const filteredTasks = mode === 'local' ? filterGroupTasksByTab(localTasks, activeTab) : initiatedTasks;

  // Sidebar deep link: collab selected before its list arrives — hold on a
  // loading screen instead of flashing the home list.
  if (selectedCollabId != null && !selectedCollab && !collabsLoaded) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('loading')}
          </div>
        </div>
      </div>
    );
  }

  if (selectedCollab) {
    return (
      <OpenTeamCollabDetailView
        key={selectedCollab.id}
        collab={selectedCollab}
        isSidebarCollapsed={isSidebarCollapsed}
        onNewChat={onNewChat}
        updateBadge={updateBadge}
        onBack={() => dispatch(selectCollab(null))}
      />
    );
  }

  if (selectedTaskId != null) {
    return (
      <GroupTaskDetailView
        key={selectedTaskId}
        taskId={selectedTaskId}
        isSidebarCollapsed={isSidebarCollapsed}
        onNewChat={onNewChat}
        updateBadge={updateBadge}
        onBack={() => dispatch(selectTask(null))}
      />
    );
  }

  const subTabs = mode === 'local' ? FILTER_TABS : mode === 'openTeam' ? OPEN_TEAM_TABS : [];
  const activeSubTab = mode === 'local' ? activeTab : openTeamTab;
  const setActiveSubTab = (id: string) => {
    if (mode === 'local') {
      setActiveTab(id as GroupTaskListTab);
    } else {
      setOpenTeamTab(id as OpenTeamListTab);
    }
  };

  const renderTaskEmptyState = (iconClass: string, titleKey: string, hintKey: string) => (
    <div className="flex flex-col items-center justify-center py-16 px-6">
      <UserGroupIcon className={iconClass} />
      <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
        {i18nService.t(titleKey)}
      </p>
      <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
        {i18nService.t(hintKey)}
      </p>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
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
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('groupTasksTitle')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Mode tabs: local group tasks | Open Team | MetaTask.
          Segmented-control style mirrors the Settings Skills/MCP toggle. */}
      <div className="flex items-center border-b dark:border-claude-darkBorder border-claude-border px-4 py-1.5 shrink-0">
        <div className="inline-flex items-center rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-1">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={mode === tab.id}
              onClick={() => setMode(tab.id)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                mode === tab.id
                  ? 'bg-claude-accent text-claude-accentInk shadow-sm'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t(tab.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Per-tab sub row, inside the tab's own container (not on the mode-tab
          bar): status filters plus the New Group Task button under Local,
          initiated/joined under OpenTeam; the MetaTask tab brings its own
          header, so it renders no sub row here. */}
      {mode !== 'metaTask' && (
        <div className="flex items-center justify-between border-b dark:border-claude-darkBorder border-claude-border px-4 shrink-0">
          <div className="flex">
            {subTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSubTab(tab.id)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                  activeSubTab === tab.id
                    ? 'dark:text-claude-darkText text-claude-text'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
                }`}
              >
                {i18nService.t(tab.labelKey)}
                {activeSubTab === tab.id && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
                )}
              </button>
            ))}
          </div>
          {mode === 'local' && onNewGroupTask && (
            <button
              type="button"
              onClick={onNewGroupTask}
              className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"
            >
              {i18nService.t('groupTasksNewTask')}
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className={`flex-1 min-h-0 ${mode === 'metaTask' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {mode === 'metaTask' ? (
          /* On-chain MetaTask board: self-contained (own views, refresh, detail drill-in). */
          <MetaTaskBoard />
        ) : mode === 'openTeam' && openTeamTab === 'joined' ? (
          <>
            {/* R4: one-time dismissible notice when a poll observes an active -> left flip. */}
            {removedNotices.map((notice) => {
              const reasonText = notice.leftReason?.trim()
                ? ` — ${i18nService.t('openTeamCollabLeftReason')}: ${notice.leftReason.trim()}`
                : '';
              return (
                <div
                  key={notice.id}
                  className="mx-4 mt-3 flex items-start gap-2 rounded-lg border dark:border-amber-500/40 border-amber-300/70 dark:bg-amber-900/20 bg-amber-50 px-3 py-2"
                >
                  <span className="flex-1 min-w-0 text-xs dark:text-amber-200 text-amber-800">
                    {i18nService.t('openTeamCollabRemovedNotice')
                      .replace('{bot}', notice.botName?.trim() || `bot-${notice.metabotId}`)
                      .replace('{title}', openTeamCollabTitle(notice))
                      .replace('{reason}', reasonText)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs dark:text-amber-300/80 text-amber-700 hover:underline"
                    aria-label={i18nService.t('close')}
                    onClick={() => dismissRemovedNotice(notice.id)}
                  >
                    {i18nService.t('close')}
                  </button>
                </div>
              );
            })}
            {collabs.length > 0 ? (
              collabs.map((collab) => (
                <OpenTeamCollabCard
                  key={collab.id}
                  collab={collab}
                  onClick={() => dispatch(selectCollab(collab.id))}
                />
              ))
            ) : guestInvites.length === 0 ? (
              renderTaskEmptyState(
                'h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4',
                'groupTasksOpenTeamJoinedEmpty',
                'groupTasksOpenTeamJoinedEmptyHint',
              )
            ) : null}
            {guestInvites.length > 0 && (
              <>
                <div className="px-4 pt-4 pb-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('openTeamGuestInvitesSectionTitle')}
                  </h2>
                </div>
                {guestInvites.map((invite) => (
                  <OpenTeamGuestInviteCard key={invite.id} invite={invite} />
                ))}
              </>
            )}
          </>
        ) : loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('loading')}
            </div>
          </div>
        ) : filteredTasks.length === 0 ? (
          mode === 'local'
            ? renderTaskEmptyState(
              'h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4',
              'groupTasksEmptyState',
              'groupTasksEmptyHint',
            )
            : renderTaskEmptyState(
              'h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4',
              'groupTasksOpenTeamInitiatedEmpty',
              'groupTasksOpenTeamInitiatedEmptyHint',
            )
        ) : (
          filteredTasks.map((task) => (
            <GroupTaskListItem
              key={task.id}
              task={task}
              onClick={() => dispatch(selectTask(task.id))}
              onTogglePin={(pinned) => void groupTaskService.setTaskPinned(task.id, pinned)}
              onRename={(title) => void groupTaskService.renameTask(task.id, title)}
              onArchive={() => void groupTaskService.archiveTask(task.id)}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default GroupTasksView;
