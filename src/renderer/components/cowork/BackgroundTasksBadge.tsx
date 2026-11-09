import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { RootState } from '../../store';
import { selectTask as selectGroupTask } from '../../store/slices/groupTasksSlice';

interface BackgroundTasksBadgeProps {
  /** Opens the Group Tasks main view (used when the active work is a MetaBot group-task turn). */
  onShowGroupTasks?: () => void;
}

/**
 * Global indicator for running/backgrounded tasks across all sessions, plus
 * MetaBot group-task background turns reported by the group-task daemon.
 * Lives in the sidebar status row; clicking jumps to the session or group
 * task that owns the work (if any). Visible on every mainView, not just the
 * session detail.
 */
const BackgroundTasksBadge: React.FC<BackgroundTasksBadgeProps> = ({ onShowGroupTasks }) => {
  const dispatch = useDispatch();
  const tasks = useSelector((state: RootState) => state.cowork.subagentTasks);
  const activeTurns = useSelector((state: RootState) => state.groupTasks.activeTurns);
  const taskList = Object.values(tasks);

  // A task is "active" when running/pending or explicitly backgrounded.
  const activeTasks = taskList.filter(
    (task) => task.isBackgrounded === true
      || task.status === 'running'
      || task.status === 'pending'
  );

  const totalActive = activeTasks.length + activeTurns.length;
  if (totalActive === 0) return null;

  const taskWithSession = activeTasks.find((task) => task.sessionId);
  const targetSessionId = taskWithSession?.sessionId;
  const targetGroupTaskId = activeTurns[0]?.taskId ?? null;
  const canJump = Boolean(targetSessionId) || (targetGroupTaskId != null && onShowGroupTasks);

  const title = activeTurns.length > 0
    ? i18nService.t('coworkBackgroundTasksBadgeMixedTitle')
      .replace('{cowork}', String(activeTasks.length))
      .replace('{groupTask}', String(activeTurns.length))
    : i18nService.t('coworkBackgroundTasksBadgeTitle');

  return (
    <button
      type="button"
      onClick={() => {
        if (targetSessionId) {
          void coworkService.loadSession(targetSessionId);
        } else if (targetGroupTaskId != null && onShowGroupTasks) {
          dispatch(selectGroupTask(targetGroupTaskId));
          onShowGroupTasks();
        }
      }}
      className={`flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
        canJump
          ? 'text-claude-accent dark:text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-default'
      }`}
      title={title}
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-claude-accent animate-pulse" />
      {/* The one flexible element in the sidebar footer: when the sidebar is
          narrow the label absorbs the squeeze via ellipsis instead of
          wrapping (a wrapped footer row reads broken). Full text stays on
          the `title` tooltip. */}
      <span className="truncate">
        {i18nService.t('coworkBackgroundTasksBadge').replace('{count}', String(totalActive))}
      </span>
    </button>
  );
};

export default BackgroundTasksBadge;
