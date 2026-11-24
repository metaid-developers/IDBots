import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { sessionTabBinding } from '../../services/sessionTabBinding';
import type { AgentNotification } from '../../types/notification';
import {
  groupNotifications,
  resolveNotificationJump,
  sortNotificationsForPanel,
} from '../../utils/notificationCenter';

/**
 * 通知中心 (批 B · P0-4, Friday 稿 Fork 5 A).
 *
 * The host has been WRITING notifications for a while — cowork terminal
 * (completed / failed), scheduled-run terminal, permission-required — into
 * `notification_events` behind `notification:list` + `notification:changed`,
 * and no renderer read them: the one component with a pipe and no faucet.
 * This is the faucet: a rail-bottom bell with an unread badge, a panel that
 * groups the existing pipeline into 完成 / 失败 / 待拍板, and a click that
 * marks the row read and jumps by its `target`.
 *
 * 待拍板 is the third group and it has TWO honest sources, because this tree
 * has no decision-type notification write (that is P2-2, upstream PR #179):
 *   1. `permission.required` rows already in the notification pipeline;
 *   2. the LIVE open Studio decision queue (`longtermTask:studioStatus`), the
 *      same rows the Live Stage card rules on; the Process Hub only POINTS at
 *      them (P0 removed its ruling seat).
 * Nothing is invented: both are existing read channels, and a decision row
 * jumps to the seat that actually decides (Live Stage). The Process Hub is NOT
 * a decision destination any more (P0, v3.2 §2.0/§3.2 S-05): when a row has no
 * studio session, the jump lands on its long-term task card; with neither key
 * the panel stays open — the notification center IS that decision's home.
 *
 * The ENTRY is not drawn here. `renderTrigger` hands the button back to the
 * host whose rail it sits on, so 通知中心 rides the same RailButton as 进程中心
 * (owner order 2026-11-24 00:38: 对齐两个按钮) — one geometry, one hover
 * language, one count badge, and no second copy to drift.
 */

interface OpenDecisionRow {
  id: string;
  kind: string;
  title: string;
  question: string;
  originStudioSessionId?: string | null;
  longtermTaskId?: string | null;
}

interface NotificationCenterProps {
  /**
   * The entry that opens this panel — supplied BY THE RAIL, not drawn here.
   *
   * 通知中心 and 进程中心 are the rail's two system entries and the owner asked
   * for them to be aligned (2026-11-24 00:38). Drawing a second, privately
   * styled bell in this file is exactly how the two drifted apart (20 px glyph
   * vs the rail's 24 px, accent/20 fill vs the rail's hover tokens, its own
   * badge markup vs the shared count pill). The panel therefore owns only the
   * state and the surface; the host renders the trigger with the rail's ONE
   * RailButton, so both entries are the same component by construction.
   */
  renderTrigger: (state: NotificationTriggerState) => React.ReactNode;
}

/** Everything the rail's entry needs to be a real toggle of this panel. */
export interface NotificationTriggerState {
  open: boolean;
  unreadCount: number;
  /** 待拍板 rows the panel would show (live decisions + permission rows). */
  decisionCount: number;
  /** The localized entry label (tooltip + accessible name). */
  label: string;
  toggle: () => void;
}

const MAX_ITEMS = 60;

function formatStamp(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return '';
  const date = new Date(createdAt);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

const NotificationRow: React.FC<{
  item: AgentNotification;
  onJump: (item: AgentNotification) => void;
}> = ({ item, onJump }) => {
  const unread = item.readAt == null;
  return (
    <button
      type="button"
      data-testid="notification-row"
      data-event-id={item.eventId}
      data-notification-type={item.type}
      data-notification-unread={unread ? 'true' : 'false'}
      onClick={() => onJump(item)}
      title={`${item.title} · ${item.body}`}
      className="flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
    >
      <span
        aria-hidden
        className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${unread ? 'bg-amber-500' : 'bg-transparent'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className={`min-w-0 flex-1 truncate text-[12px] ${unread ? 'font-semibold' : 'font-medium'} dark:text-claude-darkText text-claude-text`}>
            {item.title}
          </span>
          <span className="flex-shrink-0 text-[10px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {formatStamp(item.createdAt)}
          </span>
        </span>
        {item.body ? (
          <span className="mt-0.5 block truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {item.body}
          </span>
        ) : null}
      </span>
    </button>
  );
};

const NotificationCenter: React.FC<NotificationCenterProps> = ({ renderTrigger }) => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AgentNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [decisions, setDecisions] = useState<OpenDecisionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const api = window.electron?.notification;
    const lt = window.electron?.longtermTask;
    if (!api?.list) return;
    setLoading(true);
    try {
      const [list, count, status] = await Promise.all([
        api.list({ limit: MAX_ITEMS }),
        api.getUnreadCount?.(),
        lt?.studioStatus ? lt.studioStatus({}) : Promise.resolve(null),
      ]);
      if (list?.success && Array.isArray(list.items)) setItems(list.items);
      if (count?.success && typeof count.count === 'number') setUnreadCount(count.count);
      const openRows = status?.success && Array.isArray(status.openDecisions)
        ? (status.openDecisions as OpenDecisionRow[])
        : [];
      setDecisions(openRows);
    } catch {
      // Best-effort: a failed read keeps the last good snapshot.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubNotification = window.electron?.notification?.onChanged?.(() => {
      void load();
    });
    // Decisions ride the long-term board broadcast (the same signal the rail
    // badge and the Live Stage HUD refresh on).
    const unsubTask = window.electron?.longtermTask?.onUpdate?.(() => {
      void load();
    });
    return () => {
      unsubNotification?.();
      unsubTask?.();
    };
  }, [load]);

  // Close on outside click / Escape — the panel is a transient popover.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (panelRef.current && target && !panelRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const groups = useMemo(() => groupNotifications(sortNotificationsForPanel(items), 8), [items]);
  const completed = groups.completed;
  const failed = groups.failed;
  const permissions = groups.decisions;
  const decisionCount = decisions.length + permissions.length;

  const markRead = useCallback((eventIds: string[]) => {
    const clean = eventIds.filter((id) => typeof id === 'string' && id);
    if (clean.length === 0) return;
    void window.electron?.notification?.markRead?.(clean).then(() => {
      void load();
    }).catch(() => {
      // A failed mark-read must not block the jump.
    });
  }, [load]);

  const jumpNotification = useCallback((item: AgentNotification) => {
    markRead([item.eventId]);
    const jump = resolveNotificationJump(item.target);
    if (!jump) return;
    if (jump.kind === 'session') {
      window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: jump.sessionId } }));
    } else if (jump.kind === 'scheduled') {
      window.dispatchEvent(new CustomEvent('scheduledTask:viewSession', { detail: { sessionId: jump.sessionId } }));
    } else if (jump.kind === 'artifact') {
      // N2 态3 (owner definition 2026-11-24 00:47): open the conversation,
      // bring its SHOWCASE tab forward onto the digest, then put the caret
      // back in the composer so the owner can steer immediately.
      window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: jump.sessionId } }));
      void sessionTabBinding.controlSessionTab({
        action: 'navigate-tab',
        sessionId: jump.sessionId,
        role: 'showcase',
        uri: jump.artifactUri,
        activate: true,
      }).catch(() => {
        // A dead preview route must not block the session open above.
      });
      window.dispatchEvent(new CustomEvent('cowork:focusComposer', { detail: { sessionId: jump.sessionId } }));
    } else {
      window.dispatchEvent(new CustomEvent('longtermTask:viewTask', { detail: { taskId: jump.taskId } }));
    }
    setOpen(false);
  }, [markRead]);

  const jumpDecision = useCallback((row: OpenDecisionRow) => {
    const sessionId = typeof row.originStudioSessionId === 'string' ? row.originStudioSessionId.trim() : '';
    if (sessionId) {
      // Live Stage is the decision's FIRST landing (owner ruling 22:23):
      // open that session and bring its stage tab forward. This is the ONE
      // decision seat after P0 — the Process Hub no longer rules.
      window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId } }));
      void sessionTabBinding.revealSessionTab(sessionId);
      setOpen(false);
      return;
    }
    const taskId = typeof row.longtermTaskId === 'string' ? row.longtermTaskId.trim() : '';
    if (taskId) {
      // No studio session → land on the decision's long-term task card. The
      // hub is deliberately NOT a fallback (v3.2 §3.2 S-05: it has no seat).
      window.dispatchEvent(new CustomEvent('longtermTask:viewTask', { detail: { taskId } }));
      setOpen(false);
      return;
    }
    // Neither landing key: keep the panel open — the decision row is already
    // at its home, and a click must not dump the owner into a room with no desk.
  }, []);

  const markAllRead = useCallback(() => {
    void window.electron?.notification?.markAllRead?.().then(() => {
      void load();
    }).catch(() => {
      // Best-effort.
    });
  }, [load]);

  const label = i18nService.t('notificationsBellLabel');
  const toggle = useCallback(() => {
    if (!open) void load();
    setOpen((value) => !value);
  }, [open, load]);

  return (
    <div ref={panelRef} className="relative flex w-full justify-center">
      {renderTrigger({ open, unreadCount, decisionCount, label, toggle })}

      {open ? (
        <div
          data-testid="notification-panel"
          className="absolute bottom-0 left-full z-50 ml-2 flex max-h-[70vh] w-[326px] flex-col overflow-hidden rounded-[12px] border border-claude-border bg-claude-bg shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkBg"
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-claude-border px-3 dark:border-claude-darkBorder">
            <span className="text-[13px] font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('notificationsTitle')}
            </span>
            <span className="text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {unreadCount > 0 ? i18nService.t('notificationsUnreadBadge').replace('{count}', String(unreadCount)) : ''}
            </span>
            <button
              type="button"
              data-testid="notification-mark-all-read"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="ml-auto rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover disabled:opacity-40 dark:hover:bg-claude-darkSurfaceHover"
            >
              {i18nService.t('notificationsMarkAllRead')}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {/* 待拍板 — decisions first: they are the owner's next act. */}
            <section data-testid="notification-group" data-group="decision">
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
                <span className="text-[10.5px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  {i18nService.t('notificationsGroupDecision')}
                </span>
                <span className="text-[10px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">{decisionCount}</span>
              </div>
              {decisions.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  data-testid="notification-decision-row"
                  data-decision-id={row.id}
                  data-decision-kind={row.kind}
                  onClick={() => jumpDecision(row)}
                  title={`${row.title} · ${row.question}`}
                  className="flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  <span aria-hidden className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold dark:text-claude-darkText text-claude-text">{row.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{row.question}</span>
                  </span>
                  <span className="flex-shrink-0 self-center rounded-[6px] bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    {i18nService.t('notificationsOpenDecision')}
                  </span>
                </button>
              ))}
              {permissions.map((item) => (
                <NotificationRow key={item.eventId} item={item} onJump={jumpNotification} />
              ))}
              {decisionCount === 0 ? (
                <p className="px-2 pb-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('notificationsGroupDecisionEmpty')}
                </p>
              ) : null}
            </section>

            {/* 完成 / 失败 — the persisted pipeline rows. */}
            <section data-testid="notification-group" data-group="completed">
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
                <span className="text-[10.5px] font-bold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('notificationsGroupCompleted')}
                </span>
                <span className="text-[10px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">{completed.length}</span>
              </div>
              {completed.map((item) => (
                <NotificationRow key={item.eventId} item={item} onJump={jumpNotification} />
              ))}
              {completed.length === 0 ? (
                <p className="px-2 pb-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('notificationsGroupEmpty')}
                </p>
              ) : null}
            </section>

            <section data-testid="notification-group" data-group="failed">
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
                <span className="text-[10.5px] font-bold uppercase tracking-wide text-red-600 dark:text-red-400">
                  {i18nService.t('notificationsGroupFailed')}
                </span>
                <span className="text-[10px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">{failed.length}</span>
              </div>
              {failed.map((item) => (
                <NotificationRow key={item.eventId} item={item} onJump={jumpNotification} />
              ))}
              {failed.length === 0 ? (
                <p className="px-2 pb-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('notificationsGroupEmpty')}
                </p>
              ) : null}
            </section>

            {!loading && items.length === 0 && decisionCount === 0 ? (
              <p data-testid="notification-empty" className="px-2 py-6 text-center text-[11.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('notificationsEmpty')}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default NotificationCenter;
