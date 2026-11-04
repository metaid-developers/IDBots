/**
 * Unified task list utilities: merge local GroupTask records with joined
 * OpenTeam collab memberships into one chronological list for the sidebar
 * "Group Tasks" tab.
 */

import type { GroupTaskSummary } from '../types/groupTask';
import type { OpenTeamCollabSummary } from '../types/openTeamCollab';
import type { GroupTaskTypeVariant } from '../components/groupTasks/GroupTaskSidebarList';

/**
 * Unified task item: a discriminated union wrapping either a local group task
 * or a joined OpenTeam collab. The sidebar renders both in one sorted list.
 */
export type UnifiedTaskItem =
  | { kind: 'local'; task: GroupTaskSummary }
  | { kind: 'openteam-host'; task: GroupTaskSummary }
  | { kind: 'openteam-guest'; collab: OpenTeamCollabSummary };

/**
 * Extract the timestamp used for chronological sorting. Local tasks use
 * updatedAt; joined collabs use lastMessageAt (chain_timestamp of the newest
 * indexed message, null when none).
 */
export function getUnifiedTaskTimestamp(item: UnifiedTaskItem): number {
  if (item.kind === 'openteam-guest') {
    // lastMessageAt is chain_timestamp (unix seconds); convert to ms.
    return item.collab.lastMessageAt != null ? item.collab.lastMessageAt * 1000 : 0;
  }
  // Local/host tasks: updatedAt is sqlite datetime text; parse it.
  const text = item.task.updatedAt ?? item.task.createdAt;
  if (!text) return 0;
  try {
    // sqlite datetime('now') is 'YYYY-MM-DD HH:MM:SS' UTC.
    const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return 0;
  }
}

/**
 * Unified task item ID for React keys: local/host tasks use their numeric id,
 * collabs use a prefixed string to avoid collision.
 */
export function getUnifiedTaskKey(item: UnifiedTaskItem): string {
  return item.kind === 'openteam-guest'
    ? `collab-${item.collab.id}`
    : `task-${item.task.id}`;
}

/**
 * Merge local group tasks and OpenTeam collabs into one unified list, split
 * by type and sorted newest first. Local tasks with at least one remote seat
 * (metabotId NULL member) are 'openteam-host'; pure local tasks are 'local';
 * collabs are 'openteam-guest'.
 */
export function buildUnifiedTaskList(
  tasks: GroupTaskSummary[],
  collabs: OpenTeamCollabSummary[],
): UnifiedTaskItem[] {
  const items: UnifiedTaskItem[] = [];

  // Classify and wrap local tasks.
  for (const task of tasks) {
    const members = Array.isArray(task.members) ? task.members : [];
    const hasRemoteSeat = members.some((member) => member.metabotId == null);
    items.push({
      kind: hasRemoteSeat ? 'openteam-host' : 'local',
      task,
    });
  }

  // Wrap joined collabs.
  for (const collab of collabs) {
    items.push({ kind: 'openteam-guest', collab });
  }

  // Sort newest first.
  items.sort((a, b) => getUnifiedTaskTimestamp(b) - getUnifiedTaskTimestamp(a));

  return items;
}

/**
 * Extract the underlying GroupTaskSummary when the item is a local/host task,
 * or null when it's a collab. Used by the sidebar to pass tasks into the
 * existing GroupTaskSidebarList component.
 */
export function extractGroupTask(item: UnifiedTaskItem): GroupTaskSummary | null {
  return item.kind === 'openteam-guest' ? null : item.task;
}

/**
 * Determine the type badge variant for a unified task item.
 */
export function getUnifiedTaskType(item: UnifiedTaskItem): GroupTaskTypeVariant {
  return item.kind;
}
