import type { UnifiedTaskItem } from '../../utils/unifiedTaskList';
import type { GroupTaskSummary } from '../../types/groupTask';
import { GroupTaskSidebarRow, type GroupTaskTypeVariant } from './GroupTaskSidebarList';
import { OpenTeamCollabSidebarRow } from './OpenTeamCollabSidebarRow';

export interface UnifiedTaskListProps {
  /** Unified list of tasks and collabs, already sorted */
  items: UnifiedTaskItem[];
  /** Currently selected task ID (local task) */
  selectedTaskId: number | null;
  /** Currently selected collab ID (OpenTeam guest) */
  selectedCollabId: number | null;
  /** Callback when a local task is selected */
  onSelectTask: (taskId: number) => void;
  /** Callback when an OpenTeam collab is selected */
  onSelectCollab: (collabId: number) => void;
  /** Callback to toggle pin for a local task */
  onTogglePin?: (taskId: number, pinned: boolean) => void;
  /** Callback to rename a local task */
  onRename?: (taskId: number, title: string) => void;
  /** Callback to archive a local task */
  onArchive?: (taskId: number) => void;
  /** Function to get task type badge (local, openteam-host, openteam-guest) */
  getTaskType?: (task: GroupTaskSummary) => GroupTaskTypeVariant;
  /** Empty state text */
  emptyText?: string;
}

/**
 * Unified task list that renders both local GroupTasks and OpenTeam guest collabs
 * in one sorted list. Each item type uses its own sidebar row component while
 * sharing a common container and empty state.
 */
export function UnifiedTaskList({
  items,
  selectedTaskId,
  selectedCollabId,
  onSelectTask,
  onSelectCollab,
  onTogglePin,
  onRename,
  onArchive,
  getTaskType,
  emptyText,
}: UnifiedTaskListProps): JSX.Element {
  if (items.length === 0 && emptyText) {
    return (
      <div className="px-3 py-2 text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {items.map((item) => {
        if (item.kind === 'local' || item.kind === 'openteam-host') {
          return (
            <GroupTaskSidebarRow
              key={`task-${item.task.id}`}
              task={item.task}
              isSelected={item.task.id === selectedTaskId}
              onSelect={() => onSelectTask(item.task.id)}
              onTogglePin={onTogglePin}
              onRename={onRename}
              onArchive={onArchive}
              taskType={getTaskType ? getTaskType(item.task) : item.kind}
            />
          );
        }

        if (item.kind === 'openteam-guest') {
          return (
            <OpenTeamCollabSidebarRow
              key={`collab-${item.collab.id}`}
              collab={item.collab}
              isSelected={item.collab.id === selectedCollabId}
              onSelect={() => onSelectCollab(item.collab.id)}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
