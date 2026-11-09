import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { setViewMode, selectTask } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import { selectTrackedTasksNeedingAttention } from '../../utils/trackedTaskAttention';
import TaskList from './TaskList';
import TaskForm from './TaskForm';
import TaskDetail from './TaskDetail';
import AllRunsHistory from './AllRunsHistory';
import DeleteConfirmModal from './DeleteConfirmModal';
import LongTermTasksBoard from '../longTermTasks/LongTermTasksBoard';

/** 长期任务页的外层 Tab：「长期任务」默认在前，「定时任务」原样保留。 */
type TrackingTabId = 'longTerm' | 'scheduled';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface ScheduledTasksViewProps {
  isSidebarCollapsed?: boolean;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

/** 定时任务 Tab 的内层子 Tab（「任务 / 历史」，原样保留）。 */
type ScheduledSubTab = 'tasks' | 'history';

/** 两层 Tab 共用同一套激活态视觉（下划线），不新造第二套。 */
const tabButtonClass = (active: boolean): string =>
  `px-4 py-2.5 text-sm font-medium transition-colors relative ${
    active
      ? 'dark:text-claude-darkText text-claude-text'
      : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
  }`;

/**
 * 长期任务页（原「定时任务」入口，左栏同名入口）。
 *
 * 两层 Tab：
 *   L1：长期任务（默认在前） | 定时任务
 *   L2：仅「定时任务」内 —— 任务 | 历史（原样保留）
 * 长期任务 Tab 的主体是一等实体的长期任务看板（components/longTermTasks）。
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
  const [trackingTab, setTrackingTab] = useState<TrackingTabId>('longTerm');
  const [scheduledSubTab, setScheduledSubTab] = useState<ScheduledSubTab>('tasks');
  const [deleteTaskInfo, setDeleteTaskInfo] = useState<{ id: string; name: string } | null>(null);
  // 长期任务 tab badge: cards parked on an owner decision (waiting_owner). The
  // board is kept live app-wide (App.tsx init), so the badge is already correct
  // on the first paint of this tab.
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  const longTermNeedsDecisionCount = useMemo(
    () => selectTrackedTasksNeedingAttention({ longTermTask: { board: longTermBoard } }).longTerm,
    [longTermBoard],
  );

  const handleRequestDelete = useCallback((taskId: string, taskName: string) => {
    setDeleteTaskInfo({ id: taskId, name: taskName });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTaskInfo) return;
    const taskId = deleteTaskInfo.id;
    setDeleteTaskInfo(null);
    await scheduledTaskService.deleteTask(taskId);
    // If we were viewing this task's detail, go back to list
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

  const handleTrackingTabChange = (tab: TrackingTabId) => {
    setTrackingTab(tab);
    if (tab === 'scheduled') {
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
      setScheduledSubTab('tasks');
    }
  };

  // 「定时任务」Tab 里的创建/编辑/详情子视图会顶掉 Tab 行，把标题位让给返回按钮
  const inScheduledSubView = viewMode !== 'list' || Boolean(selectedTaskId);
  const showTrackingTabs = trackingTab === 'longTerm' || !inScheduledSubView;
  const showScheduledSubTabs = trackingTab === 'scheduled' && !inScheduledSubView;

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
          {trackingTab === 'scheduled' && inScheduledSubView && (
            <button
              onClick={handleBackToList}
              className="non-draggable p-2 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
              aria-label={i18nService.t('back')}
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('scheduledTasksTitle')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* L1 tabs：长期任务（默认在前） | 定时任务 */}
      {showTrackingTabs && (
        <div className="flex items-center border-b dark:border-claude-darkBorder border-claude-border px-4 shrink-0">
          <div className="flex">
            <button
              type="button"
              onClick={() => handleTrackingTabChange('longTerm')}
              className={tabButtonClass(trackingTab === 'longTerm')}
            >
              <span className="inline-flex items-center gap-1.5">
                {longTermNeedsDecisionCount > 0 && (
                  // Owner decision pending on this tab: the same amber dot the
                  // sidebar entry carries, with the count beside it.
                  <span
                    data-testid="long-term-tab-decision-indicator"
                    title={i18nService.t('trackedTaskNeedsDecision').replace('{count}', String(longTermNeedsDecisionCount))}
                    aria-label={i18nService.t('trackedTaskNeedsDecision').replace('{count}', String(longTermNeedsDecisionCount))}
                    role="img"
                    className="tracked-task-decision-indicator shrink-0"
                  />
                )}
                {i18nService.t('trackedTask.tab.longTerm')}
                {longTermNeedsDecisionCount > 0 && (
                  <span className="text-[11px] font-normal tabular-nums" aria-hidden>
                    {longTermNeedsDecisionCount}
                  </span>
                )}
              </span>
              {trackingTab === 'longTerm' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
            <button
              type="button"
              onClick={() => handleTrackingTabChange('scheduled')}
              className={tabButtonClass(trackingTab === 'scheduled')}
            >
              {i18nService.t('trackedTask.tab.scheduled')}
              {trackingTab === 'scheduled' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* L2 tabs（仅「定时任务」内）+ New Task button */}
      {showScheduledSubTabs && (
        <div className="flex items-center justify-between border-b dark:border-claude-darkBorder border-claude-border px-4 shrink-0">
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
              className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"
            >
              {i18nService.t('scheduledTasksNewTask')}
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {trackingTab === 'longTerm' ? (
          <LongTermTasksBoard />
        ) : (
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
        )}
      </div>

      {/* Delete confirmation modal */}
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
