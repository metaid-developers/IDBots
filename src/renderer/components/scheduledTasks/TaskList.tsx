import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { selectTask, setViewMode } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTask, Schedule } from '../../types/scheduledTask';
import { EllipsisVerticalIcon, ClockIcon } from '@heroicons/react/24/outline';
import { parseScheduleToFormState } from './taskFormSchedule';

const weekdayKeys: Record<number, string> = {
  0: 'scheduledTasksFormWeekSun',
  1: 'scheduledTasksFormWeekMon',
  2: 'scheduledTasksFormWeekTue',
  3: 'scheduledTasksFormWeekWed',
  4: 'scheduledTasksFormWeekThu',
  5: 'scheduledTasksFormWeekFri',
  6: 'scheduledTasksFormWeekSat',
};

function formatScheduleLabel(schedule: Schedule): string {
  const parsed = parseScheduleToFormState(schedule);
  if (parsed.mode === 'interval') {
    const unitKey = parsed.intervalUnit === 'minutes' ? 'scheduledTasksFormIntervalMinutes' :
      parsed.intervalUnit === 'hours' ? 'scheduledTasksFormIntervalHours' : 'scheduledTasksFormIntervalDays';
    return `${i18nService.t('scheduledTasksScheduleEvery')} ${parsed.intervalValue} ${i18nService.t(unitKey)}`;
  }

  if (schedule.type === 'at') {
    const dt = schedule.datetime ?? '';
    if (dt.includes('T')) {
      const date = new Date(dt);
      return `${i18nService.t('scheduledTasksFormScheduleModeOnce')} · ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return i18nService.t('scheduledTasksFormScheduleModeOnce');
  }

  if (schedule.type === 'cron' && schedule.expression) {
    const parts = schedule.expression.trim().split(/\s+/);
    if (parts.length >= 5) {
      const [min, hour, dom, , dow] = parts;
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

      if (dow !== '*' && dom === '*') {
        const dayNum = parseInt(dow) || 0;
        return `${i18nService.t('scheduledTasksFormScheduleModeWeekly')} · ${i18nService.t(weekdayKeys[dayNum] ?? 'scheduledTasksFormWeekSun')} ${timeStr}`;
      }
      if (dom !== '*' && dow === '*') {
        return `${i18nService.t('scheduledTasksFormScheduleModeMonthly')} · ${dom}${i18nService.t('scheduledTasksFormMonthDaySuffix')} ${timeStr}`;
      }
      return `${i18nService.t('scheduledTasksFormScheduleModeDaily')} · ${timeStr}`;
    }
  }

  return '';
}

interface TaskListItemProps {
  task: ScheduledTask;
  onRequestDelete: (taskId: string, taskName: string) => void;
}

const TaskListItem: React.FC<TaskListItemProps> = ({ task, onRequestDelete }) => {
  const dispatch = useDispatch();
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const warning = await scheduledTaskService.toggleTask(task.id, !task.enabled);
    if (warning) {
      const msg = warning === 'TASK_AT_PAST'
        ? i18nService.t('scheduledTasksToggleWarningAtPast')
        : warning === 'TASK_EXPIRED'
          ? i18nService.t('scheduledTasksToggleWarningExpired')
          : warning;
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: msg }));
    }
  };

  const handleRunNow = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    await scheduledTaskService.runManually(task.id);
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    dispatch(selectTask(task.id));
    dispatch(setViewMode('edit'));
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    onRequestDelete(task.id, task.name);
  };

  return (
    <div
      className="grid grid-cols-[1fr_1fr_80px_40px] items-center gap-3 px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer transition-colors"
      onClick={() => dispatch(selectTask(task.id))}
    >
      {/* Title */}
      <div className={`text-sm truncate ${task.enabled ? 'dark:text-claude-darkText text-claude-text' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'}`}>
        {task.name}
      </div>

      {/* Schedule */}
      <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
        {formatScheduleLabel(task.schedule)}
      </div>

      {/* Status: toggle + running indicator */}
      <div className="flex items-center gap-1.5">
        {/* Running indicator */}
        {task.state.runningAtMs && (
          <span className="inline-flex items-center text-xs text-blue-500">
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
            </svg>
          </span>
        )}

        {/* Toggle switch */}
        <button
          type="button"
          onClick={handleToggle}
          className={`relative shrink-0 w-7 h-4 rounded-full transition-colors ${
            task.enabled
              ? 'bg-claude-accent'
              : 'dark:bg-claude-darkSurfaceHover bg-claude-border'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform shadow-sm ${
              task.enabled ? 'translate-x-3' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* More menu */}
      <div className="flex justify-center">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="p-1.5 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <EllipsisVerticalIcon className="w-5 h-5" />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-full mt-1 w-32 rounded-lg shadow-lg dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border z-50 py-1">
              <button
                type="button"
                onClick={handleRunNow}
                disabled={!!task.state.runningAtMs}
                className="w-full text-left px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
              >
                {i18nService.t('scheduledTasksRun')}
              </button>
              <button
                type="button"
                onClick={handleEdit}
                className="w-full text-left px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('scheduledTasksEdit')}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('scheduledTasksDelete')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface TaskListProps {
  onRequestDelete: (taskId: string, taskName: string) => void;
}

const TaskList: React.FC<TaskListProps> = ({ onRequestDelete }) => {
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const loading = useSelector((state: RootState) => state.scheduledTask.loading);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('loading')}
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6">
        <ClockIcon className="h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4" />
        <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('scheduledTasksEmptyState')}
        </p>
        <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
          {i18nService.t('scheduledTasksEmptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Column Headers */}
      <div className="grid grid-cols-[1fr_1fr_80px_40px] items-center gap-3 px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksListColTitle')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksListColSchedule')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksListColStatus')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary text-center">
          {i18nService.t('scheduledTasksListColMore')}
        </div>
      </div>
      {tasks.map((task) => (
        <TaskListItem key={task.id} task={task} onRequestDelete={onRequestDelete} />
      ))}
    </div>
  );
};

export default TaskList;
