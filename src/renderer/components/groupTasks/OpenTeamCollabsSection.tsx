import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { openTeamCollabService } from '../../services/openTeamCollabService';
import type { OpenTeamCollabSummary, OpenTeamGuestInvite, OpenTeamGuestInviteStatus } from '../../types/openTeamCollab';
import { formatGroupTaskTime } from './groupTaskUtils';
import { GroupTaskTypeBadge, GroupTaskGuestBadge } from './GroupTaskSidebarList';

/** Short display form of a GlobalMetaID / group id (same style as the task detail rail). */
export function shortGlobalMetaId(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!text) return '';
  return text.length > 12 ? `${text.slice(0, 10)}…` : text;
}

/** Card title: the task title carried by the invite, else a short group id. */
export function openTeamCollabTitle(collab: Pick<OpenTeamCollabSummary, 'taskTitle' | 'groupId'>): string {
  const title = collab.taskTitle?.trim();
  if (title) return title;
  return i18nService.t('openTeamCollabUntitled').replace('{id}', shortGlobalMetaId(collab.groupId) || collab.groupId);
}

/**
 * Badge for one collab: a left membership shows "Left" (gray); otherwise the
 * HOST task status drives the badge — 待验收 amber, 已完成 blue, 已取消 gray,
 * unknown/executing keeps the plain green "进行中". This is what un-sticks the
 * eternal "active" badge once the chair's [STATUS:...] tags are parsed.
 */
export function openTeamCollabStatusBadgeClass(
  collab: Pick<OpenTeamCollabSummary, 'status' | 'taskStatus'>,
): string {
  if (collab.status === 'left') {
    return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
  }
  switch (collab.taskStatus) {
    case 'review':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'done':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'cancelled':
      return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
    default:
      return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
  }
}

/** i18n label paired with openTeamCollabStatusBadgeClass. */
export function openTeamCollabStatusLabel(
  collab: Pick<OpenTeamCollabSummary, 'status' | 'taskStatus'>,
): string {
  if (collab.status === 'left') return i18nService.t('openTeamCollabStatusLeft');
  switch (collab.taskStatus) {
    case 'review': return i18nService.t('openTeamCollabTaskStatusReview');
    case 'done': return i18nService.t('openTeamCollabTaskStatusDone');
    case 'cancelled': return i18nService.t('openTeamCollabTaskStatusCancelled');
    default: return i18nService.t('openTeamCollabStatusActive');
  }
}

/**
 * Tailwind classes for a received-invite status badge (P0-1): waiting shows
 * amber, accepted green, everything terminal gray.
 */
export function openTeamGuestInviteStatusBadgeClass(status: OpenTeamGuestInviteStatus): string {
  if (status === 'invited') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  }
  if (status === 'accepted') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
  }
  return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
}

/** i18n label for a received-invite status (P0-1). */
export function openTeamGuestInviteStatusLabel(status: OpenTeamGuestInviteStatus): string {
  switch (status) {
    case 'invited': return i18nService.t('openTeamGuestInviteStatusInvited');
    case 'accepted': return i18nService.t('openTeamGuestInviteStatusAccepted');
    case 'declined': return i18nService.t('openTeamGuestInviteStatusDeclined');
    case 'skipped': return i18nService.t('openTeamGuestInviteStatusSkipped');
    case 'expired': return i18nService.t('openTeamGuestInviteStatusExpired');
    default: return status;
  }
}

/**
 * Pure presentational card for one received invite (exported for node:test
 * markup assertions). Shows who invited the machine's bots into which task and
 * how the invite ended up — visible even when the bot declined or never joined.
 */
export const OpenTeamGuestInviteCard: React.FC<{ invite: OpenTeamGuestInvite }> = ({ invite }) => {
  const inviter = shortGlobalMetaId(invite.inviterName || invite.inviterGlobalmetaid);
  const title = invite.taskTitle?.trim()
    || i18nService.t('openTeamCollabUntitled').replace('{id}', shortGlobalMetaId(invite.groupId) || invite.groupId);
  const receivedAt = formatGroupTaskTime(invite.createdAt);
  const goal = invite.goalSummary?.trim();

  return (
    <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
              {title}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${openTeamGuestInviteStatusBadgeClass(invite.status)}`}>
              {openTeamGuestInviteStatusLabel(invite.status)}
            </span>
          </div>
          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
            {inviter ? `${i18nService.t('openTeamGuestInviteFrom')} ${inviter}` : ''}
            {receivedAt ? ` · ${i18nService.t('openTeamGuestInviteReceivedAt')} ${receivedAt}` : ''}
          </div>
          {goal && (
            <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {i18nService.t('openTeamGuestInviteGoal')}: {goal}
            </div>
          )}
          {invite.requiredSkills.length > 0 && (
            <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {i18nService.t('openTeamGuestInviteSkills')}: {invite.requiredSkills.join(', ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** Pure presentational card (exported for node:test markup assertions). */
export const OpenTeamCollabCard: React.FC<{ collab: OpenTeamCollabSummary; onClick: () => void }> = ({
  collab,
  onClick,
}) => {
  const inviter = shortGlobalMetaId(collab.inviterGlobalmetaid);
  const botLabel = collab.botName?.trim() || `bot-${collab.metabotId}`;
  const joinedAt = formatGroupTaskTime(collab.createdAt);
  const lastActivity = formatGroupTaskTime(collab.lastMessageAt);
  const leftAt = formatGroupTaskTime(collab.leftAt);
  // R4: why/how the membership ended — a kicked collab must read as "removed",
  // not as an unexplained gray "Left" badge. Legacy rows (pre left_* columns)
  // carry no cause and simply keep the plain badge.
  const leftCauseLabel = collab.status !== 'left'
    ? ''
    : collab.leftCause === 'kick'
      ? i18nService.t('openTeamCollabLeftCauseKick')
      : collab.leftCause === 'self_check'
        ? i18nService.t('openTeamCollabLeftCauseSelfCheck')
        : collab.leftCause === 'opt_out'
          ? i18nService.t('openTeamCollabLeftCauseOptOut')
          : '';
  const leftReason = collab.leftReason?.trim();

  return (
    <div
      className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
              {openTeamCollabTitle(collab)}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${openTeamCollabStatusBadgeClass(collab)}`}>
              {openTeamCollabStatusLabel(collab)}
            </span>
          </div>
          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
            {i18nService.t('openTeamCollabYourBot')}: {botLabel}
            {inviter ? ` · ${i18nService.t('openTeamCollabInvitedBy')} ${inviter}` : ''}
            {joinedAt ? ` · ${i18nService.t('openTeamCollabJoined')} ${joinedAt}` : ''}
          </div>
          {collab.status === 'left' && (leftCauseLabel || leftAt) && (
            <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {leftCauseLabel}
              {leftAt ? `${leftCauseLabel ? ' · ' : ''}${i18nService.t('openTeamCollabLeftAt')} ${leftAt}` : ''}
              {leftReason ? ` · ${i18nService.t('openTeamCollabLeftReason')}: ${leftReason}` : ''}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <div>
            {i18nService.t('openTeamCollabMessageCount').replace('{count}', String(collab.messageCount))}
          </div>
          {lastActivity && <div className="mt-0.5">{lastActivity}</div>}
        </div>
      </div>
    </div>
  );
};

/** Poll cadence for the collab list (new invites/kicks surface without a reload). */
export const OPEN_TEAM_COLLAB_POLL_INTERVAL_MS = 15_000;

/**
 * Collab + received-invite data for every OpenTeam surface (group-task home
 * "Open Team" tabs, sidebar records list). Loads on mount and re-polls every
 * OPEN_TEAM_COLLAB_POLL_INTERVAL_MS so new collaborations and kick/leave
 * transitions surface without revisiting the view; the interval is cleared on
 * unmount. `loaded` distinguishes "empty so far" from "not fetched yet" so a
 * deep link into a collab can show a loading state instead of flashing home.
 *
 * R4: also watches for active -> left flips (kick / self-check) and surfaces
 * them as one-time dismissible removed notices — the user must SEE the
 * removal, not just find a grayed badge on the next visit.
 */
export function useOpenTeamCollabs(): {
  items: OpenTeamCollabSummary[];
  guestInvites: OpenTeamGuestInvite[];
  loaded: boolean;
  removedNotices: OpenTeamCollabSummary[];
  dismissRemovedNotice: (id: number) => void;
} {
  const [items, setItems] = useState<OpenTeamCollabSummary[]>([]);
  const [guestInvites, setGuestInvites] = useState<OpenTeamGuestInvite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [removedNotices, setRemovedNotices] = useState<OpenTeamCollabSummary[]>([]);
  const prevStatusRef = useRef<Map<number, OpenTeamCollabSummary['status']>>(new Map());
  const dismissedNoticeIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      openTeamCollabService
        .list()
        .then((list) => {
          if (cancelled) return;
          const prev = prevStatusRef.current;
          const newlyLeft = list.filter(
            (collab) => prev.get(collab.id) === 'active' && collab.status === 'left'
              && !dismissedNoticeIdsRef.current.has(collab.id),
          );
          if (newlyLeft.length > 0) {
            setRemovedNotices((current) => [...current, ...newlyLeft]);
          }
          prevStatusRef.current = new Map(list.map((collab) => [collab.id, collab.status]));
          setItems(list);
          setLoaded(true);
        })
        .catch(() => {
          // Traceability data must never break the Group Tasks view.
        });
      // P0-1: received-invite history rides the same poll so new invites and
      // accept/decline/expiry transitions surface without a reload.
      openTeamCollabService
        .listGuestInvites()
        .then((list) => {
          if (!cancelled) setGuestInvites(list);
        })
        .catch(() => {
          // Traceability data must never break the Group Tasks view.
        });
    };
    load();
    const timer = setInterval(load, OPEN_TEAM_COLLAB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const dismissRemovedNotice = useCallback((id: number) => {
    dismissedNoticeIdsRef.current.add(id);
    setRemovedNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  return { items, guestInvites, loaded, removedNotices, dismissRemovedNotice };
}

/**
 * Compact sidebar row for one joined collab (Bot Home task records, "Group
 * Tasks" tab). Same rhythm as GroupTaskSidebarRow: title + type/status badges
 * on the first line, bot/meta line below.
 */
export const OpenTeamCollabSidebarRow: React.FC<{
  collab: OpenTeamCollabSummary;
  onSelect: () => void;
}> = ({ collab, onSelect }) => {
  const botLabel = collab.botName?.trim() || `bot-${collab.metabotId}`;
  const lastActivity = formatGroupTaskTime(collab.lastMessageAt);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="flex-1 min-w-0 truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
          {openTeamCollabTitle(collab)}
        </span>
        <GroupTaskTypeBadge type="openteam-guest" />
        <GroupTaskGuestBadge />
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${openTeamCollabStatusBadgeClass(collab)}`}>
          {openTeamCollabStatusLabel(collab)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-tight">
        <span className="truncate">
          {i18nService.t('openTeamCollabYourBot')}: {botLabel}
        </span>
        {lastActivity ? (
          <span className="shrink-0 whitespace-nowrap">{lastActivity}</span>
        ) : null}
      </div>
    </div>
  );
};
