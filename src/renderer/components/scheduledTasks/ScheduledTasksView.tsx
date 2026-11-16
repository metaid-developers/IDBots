import React, { useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { setViewMode, selectTask } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import TaskList from './TaskList';
import TaskForm from './TaskForm';
import TaskDetail from './TaskDetail';
import AllRunsHistory from './AllRunsHistory';
import DeleteConfirmModal from './DeleteConfirmModal';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface ScheduledTasksViewProps {
  isSidebarCollapsed?: boolean;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

type ScheduledSubTab = 'tasks' | 'history';

const tabButtonClass = (active: boolean): string =>
  `px-4 py-2.5 text-sm font-medium transition-colors relative ${
    active
      ? 'dark:text-claude-darkText text-claude-text'
      : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
  }`;

/**
 * BotWorks Scheduled Cron Tasks view.
 *
 * Managed Task Trees (formerly the Long-Term Task board) migrated to Studio
 * (`tasks` rail destination) so Twin orchestration, proactive heartbeat
 * briefings, and the 3-state task tree live exclusively in Studio while
 * BotWorks focuses on inspecting Worker sessions and recurring cron schedules.
 */
const ScheduledTasksView: React.FC<ScheduledTasksViewProps> = ({
  isSidebarCollapsed,
  onNewChat,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const viewMode = useSelector((state: RootState) => state.scheduledTask.viewMode);
  const selectedTaskId = useSelector((state: RootState) => state.scheduledTask.selectedTaskId);
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null;
  const [scheduledSubTab, setScheduledSubTab] = useState<ScheduledSubTab>('tasks');
  const [deleteTaskInfo, setDeleteTaskInfo] = useState<{ id: string; name: string } | null>(null);

  const handleRequestDelete = useCallback((taskId: string, taskName: string) => {
    setDeleteTaskInfo({ id: taskId, name: taskName });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTaskInfo) return;
    const taskId = deleteTaskInfo.id;
    setDeleteTaskInfo(null);
    await scheduledTaskService.deleteTask(taskId);
    if (selectedTaskId === taskId) {
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
    }
  }, [deleteTaskInfo, selectedTaskId, dispatch]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTaskInfo(null);
  }, []);

  useEffect(() => {
    scheduledTaskService.loadTasks();
  }, []);

  const handleBackToList = () => {
    dispatch(selectTask(null));
    dispatch(setViewMode('list'));
  };

  const handleScheduledSubTabChange = (tab: ScheduledSubTab) => {
    setScheduledSubTab(tab);
    if (tab === 'tasks') {
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
    }
  };

  const inScheduledSubView = viewMode !== 'list' || Boolean(selectedTaskId);
  const showScheduledSubTabs = !inScheduledSubView;

  return (
    <div className="flex flex-col h-full">
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-[8px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          {inScheduledSubView && (
            <button
              onClick={handleBackToList}
              className="non-draggable p-2 rounded-[8px] dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
              aria-label={i18nService.t('back')}
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('trackedTask.tab.scheduled')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {showScheduledSubTabs && (
        <div className="flex h-[46px] items-center justify-between border-b dark:border-claude-darkBorder border-claude-border px-4 shrink-0">
          <div className="flex">
            <button
              type="button"
              onClick={() => handleScheduledSubTabChange('tasks')}
              className={tabButtonClass(scheduledSubTab === 'tasks')}
            >
              {i18nService.t('scheduledTasksTabTasks')}
              {scheduledSubTab === 'tasks' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
            <button
              type="button"
              onClick={() => handleScheduledSubTabChange('history')}
              className={tabButtonClass(scheduledSubTab === 'history')}
            >
              {i18nService.t('scheduledTasksTabHistory')}
              {scheduledSubTab === 'history' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
          </div>
          {scheduledSubTab === 'tasks' && (
            <button
              type="button"
              onClick={() => dispatch(setViewMode('create'))}
              className="btn-idchat-primary-filled inline-flex h-9 items-center justify-center rounded-[var(--shape-radius-lg)] px-3 text-sm font-medium"
            >
              {i18nService.t('scheduledTasksNewTask')}
            </button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full overflow-y-auto">
          {showScheduledSubTabs && scheduledSubTab === 'history' ? (
            <AllRunsHistory />
          ) : (
            <>
              {viewMode === 'list' && <TaskList onRequestDelete={handleRequestDelete} />}
              {viewMode === 'create' && (
                <TaskForm
                  mode="create"
                  onCancel={handleBackToList}
                  onSaved={handleBackToList}
                />
              )}
              {viewMode === 'edit' && selectedTask && (
                <TaskForm
                  mode="edit"
                  task={selectedTask}
                  onCancel={() => dispatch(setViewMode('detail'))}
                  onSaved={() => dispatch(setViewMode('detail'))}
                />
              )}
              {viewMode === 'detail' && selectedTask && (
                <TaskDetail task={selectedTask} onRequestDelete={handleRequestDelete} />
              )}
            </>
          )}
        </div>
      </div>

      {deleteTaskInfo && (
        <DeleteConfirmModal
          taskName={deleteTaskInfo.name}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
    </div>
  );
};

export default ScheduledTasksView;
