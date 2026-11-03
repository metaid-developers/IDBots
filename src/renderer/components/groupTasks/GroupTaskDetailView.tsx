import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { groupTaskService } from '../../services/groupTaskService';
import type {
  GroupChatTranscriptMessage,
  GroupTaskDetail,
} from '../../types/groupTask';
import GroupTaskMessageItem from './GroupTaskMessageItem';
import GroupTaskComposer from './GroupTaskComposer';
import { GroupTaskTinyAvatar, GroupTaskDeliverableUri } from './GroupTaskListMeta';
import GroupTaskCloseConfirmModal from './GroupTaskCloseConfirmModal';
import GroupTaskRatingStars from './GroupTaskRatingStars';
import GroupTaskKickConfirmModal from './GroupTaskKickConfirmModal';
import GroupTaskInfoModal from './GroupTaskInfoModal';
import {
  canAcceptGroupTask,
  canReopenGroupTask,
  dedupeDeliverablesByPinid,
  deliverableKindBadge,
  deliverableVerificationBadgeClass,
  deliverableVerificationState,
  formatGroupTaskRelativeTime,
  formatGroupTaskTime,
  isDigitalDeliverable,
  groupTaskMemberStatusBadgeClass,
  groupTaskMemberStatusLabel,
  groupTaskStatusBadgeClass,
  groupTaskWorkStatusLabelKey,
  isActiveGroupTaskStatus,
  mergeTranscriptMessages,
  shortGroupId,
  shouldStickToBottom,
} from './groupTaskUtils';
import { groupTaskStatusLabelKey } from './GroupTasksView';
import { ArrowLeftIcon, ChatBubbleLeftRightIcon, ClipboardDocumentIcon, CheckIcon, XMarkIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

const MESSAGE_PAGE_LIMIT = 50;
// Distance from the top (px) at which one older transcript page is fetched.
const LOAD_OLDER_THRESHOLD = 48;
// HITL: the pause-banner decision summary is truncated at this length; the
// "expand" toggle reveals the full body (the transcript holds it anyway).
const CHECKPOINT_SUMMARY_MAX_LEN = 120;

/**
 * Copyable group/room id pill. The group_id is the room id (stored locally on
 * the task) — copying it lets the owner paste it when referring a local MetaBot
 * to a specific group task. Shows a short form; copies the FULL id.
 */
const RoomIdBadge: React.FC<{ groupId: string }> = ({ groupId }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(groupId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions) — the title tooltip still shows the full id
    }
  };
  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      title={i18nService.t(copied ? 'groupTasksRoomIdCopied' : 'groupTasksCopyRoomId')}
      aria-label={i18nService.t(copied ? 'groupTasksRoomIdCopied' : 'groupTasksCopyRoomId')}
      className="non-draggable inline-flex shrink-0 items-center gap-1 rounded-full border dark:border-claude-darkBorder border-claude-border px-2 py-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
    >
      <span className="font-mono">{shortGroupId(groupId)}</span>
      {copied
        ? <CheckIcon className="h-3 w-3 text-emerald-500" />
        : <ClipboardDocumentIcon className="h-3 w-3" />}
    </button>
  );
};

/** Field-for-field equality of two detail payloads (IPC rows are plain JSON). */
const isSameDetail = (a: GroupTaskDetail, b: GroupTaskDetail): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

interface GroupTaskDetailViewProps {
  taskId: number;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  onBack: () => void;
}

const GroupTaskDetailView: React.FC<GroupTaskDetailViewProps> = ({
  taskId,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onBack,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [detail, setDetail] = useState<GroupTaskDetail | null>(null);
  // HITL: id of the currently open checkpoint (null when none) — drives the
  // pause banner and the summary collapse-on-change effect below.
  const openCheckpointId = detail?.checkpoints?.find((checkpoint) => checkpoint.status === 'open')?.id ?? null;
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupChatTranscriptMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [ownerGlobalMetaId, setOwnerGlobalMetaId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentHint, setSentHint] = useState(false);
  // HITL: whether the pause-banner decision summary shows in full (expand).
  const [checkpointSummaryExpanded, setCheckpointSummaryExpanded] = useState(false);
  // Info modal visibility
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'done' | 'cancelled' | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  // G-04: supervisor-pause resume (owner click = the confirmation).
  const [resumingPaused, setResumingPaused] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // OpenTeam M3: member removal (kick) — target member + in-flight state.
  const [kickTarget, setKickTarget] = useState<GroupTaskDetail['members'][number] | null>(null);
  const [kicking, setKicking] = useState(false);
  const [kickError, setKickError] = useState<string | null>(null);
  // Optional kick reason (removeuser pin + [OPENTEAM_KICK] notification).
  const [kickReason, setKickReason] = useState('');
  // R2P1-2: surfaces when the kick held locally but the on-chain member list
  // has not confirmed the removal within the poll budget.
  const [kickChainConfirmPending, setKickChainConfirmPending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const sentHintTimerRef = useRef<number | null>(null);
  // Id of the newest rendered row — the auto-scroll effect only fires when it
  // actually advances.
  const latestMessageIdRef = useRef<number | null>(null);
  // Scroll-up pagination: oldestLoadedId is the backwards cursor (beforeId),
  // hasMore whether an older page may exist, plus in-flight + scroll-restore
  // state. Refs back the scroll handler so it never reads a stale closure.
  const oldestLoadedIdRef = useRef<number | null>(null);
  const hasMoreRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const pendingScrollRestoreRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // Integrity-event → message anchor: messagesRef mirrors the loaded transcript
  // for the async jump loop; highlightPinId briefly rings the target row.
  const messagesRef = useRef<GroupChatTranscriptMessage[]>([]);
  const [highlightPinId, setHighlightPinId] = useState<string | null>(null);
  const [jumpHint, setJumpHint] = useState<string | null>(null);

  const refreshDetail = useCallback(async (opts?: { quiet?: boolean }) => {
    try {
      const task = await groupTaskService.getTask(taskId);
      // The 5s poll usually re-fetches an unchanged row: keep the previous
      // detail reference so the panel (and every memoized child) stays put.
      setDetail((previous) => (previous && isSameDetail(previous, task) ? previous : task));
      setDetailError(null);
    } catch (err) {
      // Background (poll/event) refreshes must never blank a healthy view on a
      // transient IPC hiccup — only the foreground mount load surfaces the
      // error screen. A later successful refresh clears the error anyway.
      if (opts?.quiet) {
        console.warn('GroupTaskDetailView: background detail refresh failed', err);
        return;
      }
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  const loadMessages = useCallback(async () => {
    try {
      const page = await groupTaskService.listMessages(taskId, { limit: MESSAGE_PAGE_LIMIT });
      setMessages((current) => mergeTranscriptMessages(current, page));
      // The first successful page seeds the backwards-paging cursor. Later 5s
      // polls only refresh the latest window and must NOT move a cursor the
      // user may have already advanced by loading older messages.
      if (oldestLoadedIdRef.current === null && page.length > 0) {
        oldestLoadedIdRef.current = page.reduce(
          (min, message) => (message.id < min ? message.id : min),
          page[0].id,
        );
        const more = page.length >= MESSAGE_PAGE_LIMIT;
        hasMoreRef.current = more;
        setHasMore(more);
      }
      setMessagesError(null);
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  // Fetch one older page (before the oldest loaded id) and prepend it. The
  // user's viewport is preserved by nudging scrollTop by the added height.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const beforeId = oldestLoadedIdRef.current;
    if (beforeId == null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    try {
      const page = await groupTaskService.listMessages(taskId, { beforeId, limit: MESSAGE_PAGE_LIMIT });
      if (page.length > 0) {
        setMessages((current) => mergeTranscriptMessages(current, page));
        oldestLoadedIdRef.current = page.reduce(
          (min, message) => (message.id < min ? message.id : min),
          page[0].id,
        );
        const more = page.length >= MESSAGE_PAGE_LIMIT;
        hasMoreRef.current = more;
        setHasMore(more);
        pendingScrollRestoreRef.current = { prevScrollHeight, prevScrollTop };
      } else {
        hasMoreRef.current = false;
        setHasMore(false);
      }
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [taskId]);

  // Initial detail load + owner identity (for owner-message styling).
  useEffect(() => {
    let cancelled = false;
    setLoadingDetail(true);
    void refreshDetail().finally(() => {
      if (!cancelled) setLoadingDetail(false);
    });
    void (async () => {
      try {
        const result = await window.electron?.userIdentity?.get?.();
        if (!cancelled && result?.success && result.identity?.globalmetaid) {
          setOwnerGlobalMetaId(result.identity.globalmetaid);
        }
      } catch {
        // Owner styling simply stays off when the identity is unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDetail]);

  // Reset per-task transcript state when the parent reuses this component
  // instance for a different task (defensive: callers normally remount via
  // `key`, but an in-place taskId change must never show the previous task's
  // messages).
  useEffect(() => {
    setMessages([]);
    setMessagesError(null);
    setInfoModalOpen(false);
    oldestLoadedIdRef.current = null;
    hasMoreRef.current = true;
    loadingOlderRef.current = false;
    pendingScrollRestoreRef.current = null;
    latestMessageIdRef.current = null;
    setHasMore(true);
    setLoadingOlder(false);
  }, [taskId]);

  // Transcript: initial load + 5s poll while mounted. The poll also refreshes
  // the task detail so a missed/lost groupTask:statusChanged push can never
  // leave the header badge stale (R1 self-heal). A hidden window skips the
  // tick entirely (the interval stays armed) and refreshes once on becoming
  // visible again, so a backgrounded app stops re-rendering.
  useEffect(() => {
    let cancelled = false;
    setLoadingMessages(true);
    void loadMessages().finally(() => {
      if (!cancelled) setLoadingMessages(false);
    });
    const pollTick = () => {
      if (document.visibilityState !== 'visible') return;
      void loadMessages();
      void refreshDetail({ quiet: true });
    };
    const timer = window.setInterval(pollTick, 5000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') pollTick();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadMessages, refreshDetail]);

  // Immediate refresh on task status changes (also keeps the header badge live).
  useEffect(() => {
    const api = window.electron?.groupTask;
    if (!api) return undefined;
    return api.onStatusChanged((event) => {
      if (event?.taskId !== taskId) return;
      void refreshDetail({ quiet: true });
      void loadMessages();
    });
  }, [taskId, refreshDetail, loadMessages]);

  // HITL: a checkpoint opening/resolving refreshes the detail (banner) and the
  // transcript (pause/resume ceremony lines).
  useEffect(() => {
    const api = window.electron?.groupTask;
    if (!api) return undefined;
    return api.onCheckpointChanged((event) => {
      if (event?.taskId !== taskId) return;
      void refreshDetail();
      void loadMessages();
    });
  }, [taskId, refreshDetail, loadMessages]);

  // HITL: collapse the pause-banner decision summary when the open checkpoint
  // changes (a fresh pause always starts truncated).
  useEffect(() => {
    setCheckpointSummaryExpanded(false);
  }, [openCheckpointId]);

  // Auto-scroll to bottom on a genuinely new message unless the user scrolled
  // up. An in-place row update (same latest id) is not a new message, so it
  // never forces a synchronous layout.
  useEffect(() => {
    const latestId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (latestId === null || latestId === latestMessageIdRef.current) return;
    latestMessageIdRef.current = latestId;
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Mirror the loaded transcript into a ref so the async jump loop reads the
  // latest rows instead of a stale closure snapshot.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // After an older page is prepended, keep the user's viewport anchored on the
  // same message instead of jumping to the new (older) top. Runs before paint
  // so there is no flicker; a no-op when no restore is pending.
  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore) return;
    pendingScrollRestoreRef.current = null;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = restore.prevScrollTop + (el.scrollHeight - restore.prevScrollHeight);
    }
  }, [messages]);

  useEffect(() => () => {
    if (sentHintTimerRef.current != null) {
      window.clearTimeout(sentHintTimerRef.current);
    }
  }, []);

  const handleTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    // Load one older page when the user reaches the top (chat-style infinite
    // scroll upwards); the backend already pages backwards via beforeId.
    if (
      el.scrollTop <= LOAD_OLDER_THRESHOLD
      && hasMoreRef.current
      && !loadingOlderRef.current
      && oldestLoadedIdRef.current != null
    ) {
      void loadOlder();
    }
  };

  // Integrity-event → message anchor: ensure the target message is loaded
  // (paging back via the existing beforeId path if it is older than the window),
  // then scroll it into view and briefly highlight it.
  const jumpToMessage = useCallback(async (pinId: string) => {
    if (!pinId) return;
    let guard = 0;
    while (
      messagesRef.current.every((message) => message.pinId !== pinId)
      && hasMoreRef.current
      && oldestLoadedIdRef.current != null
      && guard < 12
    ) {
      guard += 1;
      await loadOlder();
    }
    const present = messagesRef.current.some((message) => message.pinId === pinId);
    if (!present) {
      setJumpHint(i18nService.t('groupTasksAnchorNotFound'));
      window.setTimeout(() => setJumpHint(null), 2500);
      return;
    }
    // Let React commit any prepended rows before querying the DOM node.
    window.setTimeout(() => {
      const target = scrollRef.current?.querySelector(`[data-pin-id="${pinId}"]`) as HTMLElement | null;
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlightPinId(pinId);
      window.setTimeout(() => setHighlightPinId((current) => (current === pinId ? null : current)), 1800);
      // A jump up means we are no longer tracking the bottom.
      stickToBottomRef.current = false;
    }, 60);
  }, [loadOlder]);

  const handleJumpToReply = useCallback((pinId: string) => {
    void jumpToMessage(pinId);
  }, [jumpToMessage]);

  const handleSendText = useCallback(async (text: string): Promise<boolean> => {
    if (sending) return false;
    setSending(true);
    setSendError(null);
    try {
      await groupTaskService.sendUserMessage(taskId, text);
      setSentHint(true);
      if (sentHintTimerRef.current != null) {
        window.clearTimeout(sentHintTimerRef.current);
      }
      sentHintTimerRef.current = window.setTimeout(() => setSentHint(false), 4000);
      return true;
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSending(false);
    }
  }, [sending, taskId]);

  const handleConfirmClose = async (rating?: number, ratingComment?: string) => {
    if (!confirmAction || !detail) return;
    setClosing(true);
    setCloseError(null);
    try {
      const updated = await groupTaskService.closeTask({ taskId, status: confirmAction, rating, ratingComment });
      // Accept used to return a bare GroupTask row (no members/deliverables).
      // Writing that into detail state crashed the view (`members.find`).
      // Prefer the close payload when it is already a full detail; otherwise
      // refetch so the post-accept render cannot white-screen.
      const nextDetail = Array.isArray(updated?.members)
        ? updated
        : await groupTaskService.getTask(taskId);
      setDetail(nextDetail);
      setConfirmAction(null);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosing(false);
    }
  };

  // P0-1: review -> executing 补充执行通道 (Back to work / 返回修改).
  const handleReopen = async () => {
    if (reopening || !detail) return;
    setReopening(true);
    setReopenError(null);
    try {
      const updated = await groupTaskService.reopenTask(taskId);
      setDetail(updated);
    } catch (err) {
      setReopenError(err instanceof Error ? err.message : String(err));
    } finally {
      setReopening(false);
    }
  };

  // G-04: owner-side resume of a supervisor dispatch pause. The button click
  // IS the owner confirmation the resume gate requires.
  const handleResumePaused = async () => {
    if (resumingPaused || !detail) return;
    setResumingPaused(true);
    setResumeError(null);
    try {
      const updated = await groupTaskService.resumePausedTask(taskId);
      setDetail(updated);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : String(err));
    } finally {
      setResumingPaused(false);
    }
  };

  const handleConfirmKick = async () => {
    if (!kickTarget || !detail) return;
    setKicking(true);
    setKickError(null);
    try {
      const reason = kickReason.trim();
      const kicked = await groupTaskService.kickMember({
        taskId,
        metabotId: kickTarget.metabotId ?? undefined,
        globalmetaid: kickTarget.metabotId == null ? kickTarget.globalmetaid ?? undefined : undefined,
        reason: reason || undefined,
      });
      setKickTarget(null);
      setKickReason('');
      // R2P1-2: the local removal + announcement already hold; only warn that
      // the on-chain member list has not confirmed the removal yet.
      setKickChainConfirmPending(kicked.chainRemovalConfirmed === false);
      await refreshDetail();
    } catch (err) {
      setKickError(err instanceof Error ? err.message : String(err));
    } finally {
      setKicking(false);
    }
  };

  // Render derivations that feed memoized children stay ABOVE the loading/error
  // returns (hooks must run on every render): every value crossing into a
  // memoized row is reference-stable, and the pin lookups are O(1) instead of a
  // per-row scan of the whole transcript.
  // Nested collections can be missing on a stale/partial close payload.
  // Always coerce to arrays so Accept & Close cannot white-screen the view.
  const members = useMemo(
    () => (detail && Array.isArray(detail.members) ? detail.members : []),
    [detail],
  );
  // Text rows (kind=text, no uri) are process notes, not deliverables — the
  // rail lists digital outcomes only, mirroring the acceptance checklist.
  // Task #63: one artifact = one card — pinid-keyed dedupe so legacy ledgers
  // (same URI recorded under two authors before artifact-identity folding)
  // never render twice; the earliest row (the publisher's) wins.
  const deliverables = useMemo(
    () => dedupeDeliverablesByPinid(
      (detail && Array.isArray(detail.deliverables) ? detail.deliverables : [])
        .filter((deliverable) => isDigitalDeliverable(deliverable)),
    ),
    [detail],
  );
  // Remote members (metabotId == null) joined via OpenTeam; their messages are
  // matched by globalmetaid so the transcript can flag them.
  const remoteMemberGlobalMetaIds = useMemo(
    () => new Set(
      members
        .filter((member) => member.metabotId == null && member.globalmetaid)
        .map((member) => member.globalmetaid as string),
    ),
    [members],
  );
  // P13 (v1.1): the roster wins over the chain nickname. A worker session can
  // post under a runtime identity nickname (task #22 rendered Builder阿码's
  // delivery as "claude bot"), while senderGlobalMetaId always points at the
  // registered member — resolve transcript author names through this map.
  const memberNameByGmid = useMemo(() => {
    const byGmid = new Map<string, string>();
    for (const member of members) {
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      const name = (member.name ?? member.displayName ?? '').trim();
      if (gmid && name) byGmid.set(gmid, name);
    }
    return byGmid;
  }, [members]);
  const resolveTranscriptSenderName = useCallback((message: {
    senderGlobalMetaId?: string | null;
    senderName?: string | null;
  }): string => {
    const gmid = message.senderGlobalMetaId?.trim().toLowerCase();
    return (gmid ? memberNameByGmid.get(gmid) : undefined) || message.senderName?.trim() || 'Unknown';
  }, [memberNameByGmid]);
  const messagesByPinId = useMemo(() => {
    const byPinId = new Map<string, GroupChatTranscriptMessage>();
    for (const message of messages) {
      // First row wins, mirroring the previous Array.find lookup.
      if (message.pinId && !byPinId.has(message.pinId)) byPinId.set(message.pinId, message);
    }
    return byPinId;
  }, [messages]);
  // R5: the replied-to message for each replyPin in the loaded window; null
  // when the target is on an older page (the bar still jumps/loads it).
  const replyTargetByPinId = useMemo(() => {
    const byPinId = new Map<string, { senderName: string; preview: string } | null>();
    for (const message of messages) {
      const replyPin = message.replyPin?.trim();
      if (!replyPin || byPinId.has(replyPin)) continue;
      const target = messagesByPinId.get(replyPin);
      byPinId.set(replyPin, target
        ? {
          senderName: resolveTranscriptSenderName(target),
          preview: (target.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        }
        : null);
    }
    return byPinId;
  }, [messages, messagesByPinId, resolveTranscriptSenderName]);

  if (loadingDetail) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('loading')}
        </div>
      </div>
    );
  }

  if (detailError || !detail) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-red-500">{detailError ?? i18nService.t('groupTasksLoadFailed')}</p>
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm rounded-lg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          {i18nService.t('back')}
        </button>
      </div>
    );
  }

  const isTerminal = !isActiveGroupTaskStatus(detail.status);
  // HITL: the currently open human checkpoint, if any (drives the pause banner).
  const openCheckpoint = detail.checkpoints?.find((checkpoint) => checkpoint.status === 'open') ?? null;
  // HITL: what the owner must decide, shown under the banner topic — the
  // chair's tag-free [CHECKPOINT] message body. Truncated until expanded.
  const openCheckpointSummary = detail.openCheckpointSummary?.trim() || null;
  const checkpointSummaryShown = openCheckpointSummary
    && !checkpointSummaryExpanded
    && openCheckpointSummary.length > CHECKPOINT_SUMMARY_MAX_LEN
    ? `${openCheckpointSummary.slice(0, CHECKPOINT_SUMMARY_MAX_LEN).trimEnd()}…`
    : openCheckpointSummary;
  const chairMember = members.find((member) => member.role === 'chair');
  const memberDisplayName = (member: GroupTaskDetail['members'][number]): string =>
    member.name ?? (member.metabotId != null
      ? `bot-${member.metabotId}`
      : member.globalmetaid
        ? `${member.globalmetaid.slice(0, 10)}…`
        : 'remote bot');
  const deliverableAuthorName = (authorGlobalMetaId: string | null): string => {
    if (!authorGlobalMetaId) return '—';
    const member = members.find((candidate) => candidate.globalmetaid === authorGlobalMetaId);
    if (member?.name) return member.name;
    if (ownerGlobalMetaId && authorGlobalMetaId === ownerGlobalMetaId) {
      return i18nService.t('groupTasksOwnerBadge');
    }
    return `${authorGlobalMetaId.slice(0, 10)}…`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
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
          <button
            onClick={onBack}
            className="non-draggable p-2 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
            aria-label={i18nService.t('back')}
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <span className="shrink-0 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            #{detail.id}
          </span>
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text truncate">
            {detail.title}
          </h1>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${groupTaskStatusBadgeClass(detail.status)}`}>
            {i18nService.t(groupTaskStatusLabelKey(detail.status))}
          </span>
          {detail.mode === 'chat' && (
            <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium bg-claude-accent/10 text-claude-accent">
              {i18nService.t('groupTasksFormModeChat')}
            </span>
          )}
          {detail.groupId && <RoomIdBadge groupId={detail.groupId} />}
        </div>
        <div className="non-draggable flex items-center gap-2">
          {!isTerminal && (
            <>
              {/* Accept & Close / Rework stay in the header so the owner can
                  always decide from the top-right while a task is in review —
                  the single-card also keeps in-card copies (never behind the
                  collapsed expand toggle). */}
              {canReopenGroupTask(detail.status) && (
                <button
                  type="button"
                  onClick={() => void handleReopen()}
                  disabled={reopening}
                  className="px-2.5 py-1 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-50"
                >
                  {reopening ? i18nService.t('groupTasksReopening') : i18nService.t('groupTasksBackToWork')}
                </button>
              )}
              {canAcceptGroupTask(detail.status) && (
                <button
                  type="button"
                  onClick={() => setConfirmAction('done')}
                  className="px-2.5 py-1 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
                >
                  {i18nService.t('groupTasksAcceptClose')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmAction('cancelled')}
                className="px-2.5 py-1 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 text-red-500 border border-red-300 dark:border-red-500/40 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                {i18nService.t('groupTasksCancelTask')}
              </button>
            </>
          )}
          <WindowTitleBar inline />
        </div>
      </div>

      {/* Body: transcript column + right rail */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Compact info bar */}
          <div className="px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50 shrink-0 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setInfoModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary border dark:border-claude-darkBorder/60 border-claude-border/60 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              <InformationCircleIcon className="h-4 w-4" />
              <span>{i18nService.t('groupTasksShowInfo')}</span>
            </button>
            {detail.acceptanceSummary && (
              <button
                type="button"
                onClick={() => setInfoModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg text-emerald-600 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-500/40 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
              >
                <CheckIcon className="h-3.5 w-3.5" />
                <span>{i18nService.t('groupTasksAcceptanceSummaryTitle')}</span>
              </button>
            )}
            {detail.status === 'done' && detail.rating != null && (
              <button
                type="button"
                onClick={() => setInfoModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary border dark:border-claude-darkBorder/60 border-claude-border/60 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <GroupTaskRatingStars value={detail.rating} sizeClass="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Banners (stall/review/paused/checkpoint) */}
          {detail.stall === true && !openCheckpoint && detail.status !== 'review' && detail.dispatchPausedAt == null && (
            <div className="mx-4 mt-2 rounded-lg border border-orange-300 dark:border-orange-500/40 bg-orange-50 dark:bg-orange-900/20 px-3 py-2 text-xs dark:text-orange-200 text-orange-800">
              {i18nService
                .t('groupTasksStallBanner')
                .replace('{minutes}', String(detail.stallAfterMinutes ?? 30))}
            </div>
          )}
          {detail.status === 'review' && (
            <div className="mx-4 mt-2 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs dark:text-amber-200 text-amber-800">
              {i18nService.t('groupTasksReviewSilenceHint')}
            </div>
          )}
          {detail.dispatchPausedAt != null && !isTerminal && (
            <div className="mx-4 mt-2 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs dark:text-amber-200 text-amber-800">
              <div className="flex items-center gap-2 flex-wrap">
                <span>⏸️ {i18nService.t('groupTasksPausedBanner')}</span>
                <button
                  type="button"
                  onClick={() => void handleResumePaused()}
                  disabled={resumingPaused}
                  className="ml-auto shrink-0 rounded-lg border border-amber-400/60 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors disabled:opacity-50"
                >
                  {resumingPaused
                    ? i18nService.t('groupTasksResuming')
                    : i18nService.t('groupTasksResumeDispatch')}
                </button>
              </div>
              {resumeError && (
                <div className="mt-1 text-red-600 dark:text-red-400">{resumeError}</div>
              )}
            </div>
          )}
          {openCheckpoint && (
            <div className="mx-4 mt-2 rounded-lg border border-sky-300 dark:border-sky-500/40 bg-sky-50 dark:bg-sky-900/20 px-3 py-2 text-xs dark:text-sky-200 text-sky-800">
              <div>
                {i18nService
                  .t('groupTasksCheckpointBanner')
                  .replace('{topic}', openCheckpoint.topic?.trim() || i18nService.t('groupTasksCheckpointNoTopic'))}
              </div>
              {openCheckpointSummary && (
                <div className="mt-1">
                  <span className="font-medium">{i18nService.t('groupTasksCheckpointDecisionPrefix')}</span>
                  <span className="whitespace-pre-wrap">{checkpointSummaryShown}</span>
                  {openCheckpointSummary.length > CHECKPOINT_SUMMARY_MAX_LEN && (
                    <button
                      type="button"
                      className="ml-1 underline cursor-pointer"
                      onClick={() => setCheckpointSummaryExpanded((expanded) => !expanded)}
                    >
                      {i18nService.t(checkpointSummaryExpanded ? 'groupTasksCheckpointCollapse' : 'groupTasksCheckpointExpand')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {reopenError && (
            <p className="mx-4 mt-2 text-xs text-red-500">{reopenError}</p>
          )}

          {/* Transcript */}
          <div
            ref={scrollRef}
            onScroll={handleTranscriptScroll}
            className="flex-1 overflow-y-auto pt-3"
          >
            {/* Scroll-up pagination status (top of the transcript window). */}
            {messages.length > 0 && (loadingOlder || !hasMore) && (
              <div className="flex items-center justify-center py-1.5 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                {loadingOlder
                  ? i18nService.t('groupTasksLoadingOlder')
                  : i18nService.t('groupTasksNoMoreMessages')}
              </div>
            )}
            {loadingMessages && messages.length === 0 ? (
              <div className="flex items-center justify-center py-16">
                <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('loading')}
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-6">
                <ChatBubbleLeftRightIcon className="h-10 w-10 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-3" />
                <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {messagesError ?? i18nService.t('groupTasksTranscriptEmpty')}
                </p>
              </div>
            ) : (
              messages.map((message) => {
                // R5: the replied-to message (null when the target is on an older
                // page — clicking still jumps/loads it via jumpToMessage).
                const replyPin = message.replyPin?.trim();
                return (
                <GroupTaskMessageItem
                  key={message.id}
                  message={message}
                  senderDisplayName={resolveTranscriptSenderName(message)}
                  isChairSender={Boolean(
                    chairMember?.globalmetaid
                    && message.senderGlobalMetaId === chairMember.globalmetaid,
                  )}
                  isOwnerSender={Boolean(
                    ownerGlobalMetaId && message.senderGlobalMetaId === ownerGlobalMetaId,
                  )}
                  isRemoteSender={Boolean(
                    message.senderGlobalMetaId
                    && remoteMemberGlobalMetaIds.has(message.senderGlobalMetaId),
                  )}
                  highlight={highlightPinId != null && message.pinId === highlightPinId}
                  replyTarget={replyPin ? replyTargetByPinId.get(replyPin) : undefined}
                  onJumpToReply={handleJumpToReply}
                />
                );
              })
            )}
          </div>

          {/* Composer (non-terminal only) */}
          {!isTerminal && (
            <GroupTaskComposer
              sending={sending}
              sendError={sendError}
              sentHint={sentHint}
              onSend={handleSendText}
            />
          )}
        </div>

        {/* Right rail */}
        <div className="w-60 shrink-0 border-l dark:border-claude-darkBorder border-claude-border overflow-y-auto">
          <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              {i18nService.t('groupTasksMembers')}
            </h3>
            <div className="space-y-1.5">
              {members.map((member) => (
                <React.Fragment key={member.id}>
                <div className="group flex items-center gap-2">
                  <GroupTaskTinyAvatar
                    src={member.avatar}
                    name={memberDisplayName(member)}
                    size="hover"
                    browserGlobalMetaId={member.globalmetaid ?? null}
                  />
                  <span className="text-sm dark:text-claude-darkText text-claude-text truncate">
                    {memberDisplayName(member)}
                  </span>
                  {member.role === 'chair' && (
                    <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-claude-accent/15 text-claude-accent">
                      {i18nService.t('groupTasksChairBadge')}
                    </span>
                  )}
                  {member.metabotId == null && (
                    <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-green-500/15 text-green-600 dark:text-green-400">
                      {i18nService.t('groupTasksRemoteBadge')}
                    </span>
                  )}
                  {member.workStatus && member.workStatus !== 'unknown' && (
                    <span
                      title={
                        member.workStatus === 'error'
                          ? i18nService.t('groupTasksWorkStatusErrorHint')
                          : member.workStatus === 'timeout'
                            ? i18nService.t('groupTasksWorkStatusTimeoutHint')
                            : member.workStatus === 'waiting'
                              ? i18nService.t('groupTasksWorkStatusWaitingHint')
                              : undefined
                      }
                      className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${
                        member.workStatus === 'working'
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : member.workStatus === 'error'
                            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                            : member.workStatus === 'timeout'
                              ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
                              : member.workStatus === 'waiting'
                                ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                                : member.workStatus === 'done'
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-gray-500/10 text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {i18nService.t(groupTaskWorkStatusLabelKey(member.workStatus))}
                    </span>
                  )}
                  {member.status && (
                    <span
                      className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${groupTaskMemberStatusBadgeClass(member.status)}`}
                      title={member.statusChangedAt
                        ? `Status changed ${formatGroupTaskTime(member.statusChangedAt)}`
                        : groupTaskMemberStatusLabel(member.status)}
                    >
                      {groupTaskMemberStatusLabel(member.status)}
                    </span>
                  )}
                  {/* M3: the owner may remove any non-chair member while the task is active. */}
                  {!isTerminal && member.role !== 'chair'
                    && (member.metabotId != null || member.globalmetaid) && (
                    <button
                      type="button"
                      onClick={() => {
                        setKickError(null);
                        setKickTarget(member);
                      }}
                      title={i18nService.t('groupTasksRemoveMember')}
                      aria-label={i18nService.t('groupTasksRemoveMember')}
                      className="ml-auto shrink-0 hidden group-hover:inline-flex h-5 w-5 items-center justify-center rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {(member.lastActivityAt != null || member.lastSpeakAt != null) && (
                  <div
                    className="text-[10px] leading-tight dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 pl-0.5"
                    title={formatGroupTaskTime(member.lastActivityAt ?? member.lastSpeakAt)}
                  >
                    {i18nService.t('groupTasksLastActive').replace(
                      '{time}',
                      formatGroupTaskRelativeTime(member.lastActivityAt ?? member.lastSpeakAt).compact,
                    )}
                  </div>
                )}
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
            <details>
              <summary className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-pointer mb-2">
                {i18nService.t('groupTasksStatusHistory')}
              </summary>
              {(detail.statusEvents ?? []).length === 0 ? (
                <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                  {i18nService.t('groupTasksNoStatusEvents')}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {(detail.statusEvents ?? []).map((event) => (
                    <div key={event.id} className="text-[11px] leading-snug">
                      <span className="dark:text-claude-darkText text-claude-text">
                        {event.fromStatus} → {event.toStatus}
                      </span>
                      <span className="dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                        {` · ${event.actorName ?? event.actorKind} · ${formatGroupTaskTime(event.createdAt)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </details>
          </div>

          <div className="px-4 py-3 border-t dark:border-claude-darkBorder/50 border-claude-border/50">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              Transitions
            </h3>
            {(detail.transitions ?? []).length === 0 ? (
              <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                No transitions yet
              </p>
            ) : (
              <div className="space-y-1.5">
                {(detail.transitions ?? []).map((transition) => (
                  <div key={transition.id} className="text-[11px] leading-tight dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80">
                    <span className="font-medium dark:text-claude-darkText text-claude-text">
                      {(transition.fromStatus ?? '—')} → {transition.toStatus}
                    </span>
                    {transition.reason ? ` — ${transition.reason}` : ''}
                    <div className="text-[10px] opacity-70">
                      {transition.actor ?? 'system'} · {formatGroupTaskTime(transition.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-4 py-3 border-t dark:border-claude-darkBorder/50 border-claude-border/50">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              Integrity events
            </h3>
            {(detail.integrityEvents ?? []).length === 0 ? (
              <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                No integrity events yet
              </p>
            ) : (
              <div className="space-y-1.5">
                {(detail.integrityEvents ?? []).map((event) => (
                  <button
                    type="button"
                    key={event.id}
                    disabled={!event.msgPinId}
                    onClick={() => event.msgPinId && void jumpToMessage(event.msgPinId)}
                    title={event.msgPinId ? i18nService.t('groupTasksJumpToMessage') : undefined}
                    className={`block w-full text-left rounded-md px-1.5 py-1 text-[11px] leading-tight transition-colors dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 ${
                      event.msgPinId
                        ? 'hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover cursor-pointer'
                        : 'cursor-default'
                    }`}
                  >
                    <span className={`font-medium ${event.eventType === 'correction' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {event.eventType === 'correction' ? 'correction' : 'honest report'}
                    </span>
                    <div className="text-[10px] opacity-80 line-clamp-2">{event.detail ?? ''}</div>
                    <div className="text-[10px] opacity-70">{formatGroupTaskTime(event.createdAt)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="px-4 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              {i18nService.t('groupTasksDeliverables')}
            </h3>
            {deliverables.length === 0 ? (
              <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                {i18nService.t('groupTasksNoDeliverables')}
              </p>
            ) : (
              <div className="space-y-2">
                {deliverables.map((deliverable) => {
                  const kindBadge = deliverableKindBadge(deliverable.kind);
                  const statusKey = deliverable.status === 'accepted'
                    ? 'groupTasksDeliverableStatusAccepted'
                    : deliverable.status === 'rejected'
                      ? 'groupTasksDeliverableStatusRejected'
                      : deliverable.status === 'delivered'
                        ? 'groupTasksDeliverableStatusDelivered'
                        : 'groupTasksDeliverableStatusPending';
                  const statusHintKey = deliverable.status === 'accepted'
                    ? 'groupTasksDeliverableStatusAcceptedHint'
                    : deliverable.status === 'rejected'
                      ? 'groupTasksDeliverableStatusRejectedHint'
                      : deliverable.status === 'delivered'
                        ? 'groupTasksDeliverableStatusDeliveredHint'
                        : 'groupTasksDeliverableStatusPendingHint';
                  return (
                  <div
                    key={deliverable.id}
                    className="rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${kindBadge.className}`}>
                        {i18nService.t(kindBadge.labelKey)}
                      </span>
                      <span
                        className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70"
                        title={i18nService.t(statusHintKey)}
                      >
                        {i18nService.t(statusKey)}
                      </span>
                      {(() => {
                        // Issue #8: on-chain confirmation is a ledger state
                        // driven by multi-source verification, shown
                        // separately from the acceptance status above. For
                        // legacy rows still awaiting a verification pass,
                        // fall back to the verification-report detail.
                        if (deliverable.confirmation === 'confirmed') {
                          return (
                            <span
                              className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                              title={deliverable.verification ?? i18nService.t('groupTasksDeliverableConfirmedHint')}
                            >
                              {i18nService.t('groupTasksDeliverableConfirmed')}
                            </span>
                          );
                        }
                        const state = deliverableVerificationState(deliverable.verification);
                        if (state === 'unknown') return null;
                        return (
                          <span
                            className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${deliverableVerificationBadgeClass(state)}`}
                            title={deliverable.verification ?? ''}
                          >
                            {state === 'verified' ? 'on-chain ✓' : state === 'pending-sync' ? 'pending sync' : 'unverified'}
                          </span>
                        );
                      })()}
                    </div>
                    {deliverable.uri ? (
                      <GroupTaskDeliverableUri uri={deliverable.uri} />
                    ) : (
                      // Text deliverable (no uri): fold the producing message
                      // body so the panel reads as content, not an empty card.
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] text-claude-accent hover:underline">
                          {i18nService.t('groupTasksDeliverableViewSource')}
                        </summary>
                        <div className="mt-1 max-h-40 overflow-y-auto rounded p-2 text-[11px] whitespace-pre-wrap break-words dark:bg-claude-darkSurfaceHover/60 bg-claude-surfaceHover/60 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {deliverable.sourceContent?.trim()
                            || i18nService.t('groupTasksDeliverableNoSource')}
                        </div>
                      </details>
                    )}
                    <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                      {deliverableAuthorName(deliverable.authorGlobalmetaid)}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Close confirmation (accept = rate + close, cancel = plain confirm) */}
      {confirmAction && (
        <GroupTaskCloseConfirmModal
          action={confirmAction}
          taskTitle={detail.title}
          closing={closing}
          error={closeError}
          onConfirm={(rating, ratingComment) => void handleConfirmClose(rating, ratingComment)}
          onCancel={() => {
            setConfirmAction(null);
            setCloseError(null);
          }}
        />
      )}
      {/* Info modal */}
      {infoModalOpen && (
        <GroupTaskInfoModal
          detail={detail}
          onClose={() => setInfoModalOpen(false)}
          onAccept={detail.status === 'review' ? () => { setInfoModalOpen(false); setConfirmAction('done'); } : undefined}
          onRework={detail.status === 'review' ? () => { setInfoModalOpen(false); void handleReopen(); } : undefined}
          reworking={reopening}
        />
      )}
      {/* Member removal confirmation */}
      {kickTarget && (
        <GroupTaskKickConfirmModal
          memberName={memberDisplayName(kickTarget)}
          kicking={kicking}
          error={kickError}
          reason={kickReason}
          onReasonChange={setKickReason}
          onConfirm={() => void handleConfirmKick()}
          onCancel={() => {
            setKickTarget(null);
            setKickError(null);
            setKickReason('');
          }}
        />
      )}
      {kickChainConfirmPending && !kickTarget && (
        <div
          className="fixed bottom-4 right-4 z-[9998] rounded-lg bg-amber-500 text-white text-sm px-4 py-2 shadow-lg cursor-pointer"
          onClick={() => setKickChainConfirmPending(false)}
        >
          {i18nService.t('groupTasksKickChainConfirmPending')}
        </div>
      )}
      {closeError && !confirmAction && (
        <div className="fixed bottom-4 right-4 z-[9998] rounded-lg bg-red-500 text-white text-sm px-4 py-2 shadow-lg">
          {closeError}
        </div>
      )}
      {jumpHint && (
        <div className="fixed bottom-4 right-4 z-[9998] rounded-lg bg-claude-textSecondary text-white text-sm px-4 py-2 shadow-lg">
          {jumpHint}
        </div>
      )}
    </div>
  );
};

export default GroupTaskDetailView;
