import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { openTeamCollabService } from '../../services/openTeamCollabService';
import type { GroupChatTranscriptMessage } from '../../types/groupTask';
import type { OpenTeamCollabSummary, OpenTeamCollabMember } from '../../types/openTeamCollab';
import GroupTaskMessageItem from './GroupTaskMessageItem';
import {
  formatGroupTaskTime,
  formatGroupTaskRelativeTime,
  mergeTranscriptMessages,
  shouldStickToBottom,
  dedupeDeliverablesByPinid,
  deliverableKindBadge,
  deliverableVerificationBadgeClass,
  deliverableVerificationState,
  isDigitalDeliverable,
  openGroupTaskUri,
  isBotBrowserUri,
} from './groupTaskUtils';
import {
  openTeamCollabStatusBadgeClass,
  openTeamCollabStatusLabel,
  openTeamCollabTitle,
  shortGlobalMetaId,
} from './OpenTeamCollabsSection';
import { GroupTaskTinyAvatar } from './GroupTaskListMeta';
import { ArrowLeftIcon, ChatBubbleLeftRightIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

const MESSAGE_PAGE_LIMIT = 50;

interface OpenTeamCollabDetailViewProps {
  collab: OpenTeamCollabSummary;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  onBack: () => void;
}

/**
 * Read-only transcript of one external OpenTeam group this machine's bot
 * joined. No composer and no controls — the task is hosted on the inviter's
 * machine; this view only proves what our bot saw and said. Polls on the same
 * 5s cadence as the group-task detail transcript.
 */
const OpenTeamCollabDetailView: React.FC<OpenTeamCollabDetailViewProps> = ({
  collab,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onBack,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [messages, setMessages] = useState<GroupChatTranscriptMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [members, setMembers] = useState<OpenTeamCollabMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const loadMessages = useCallback(async () => {
    try {
      const page = await openTeamCollabService.listMessages(collab.groupId, { limit: MESSAGE_PAGE_LIMIT });
      setMessages((current) => mergeTranscriptMessages(current, page));
      setMessagesError(null);
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
    }
  }, [collab.groupId]);

  const loadMembers = useCallback(async () => {
    try {
      const membersList = await openTeamCollabService.getMembers(collab.groupId);
      setMembers(membersList);
    } catch (err) {
      console.warn('Failed to load OpenTeam collab members:', err);
      // Members list is optional — transcript should still render if it fails.
    }
  }, [collab.groupId]);

  // Transcript: initial load + 5s poll while mounted.
  useEffect(() => {
    let cancelled = false;
    setLoadingMessages(true);
    void loadMessages().finally(() => {
      if (!cancelled) setLoadingMessages(false);
    });
    const timer = window.setInterval(() => {
      void loadMessages();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadMessages]);

  // Members: initial load + 15s poll while mounted.
  useEffect(() => {
    let cancelled = false;
    setLoadingMembers(true);
    void loadMembers().finally(() => {
      if (!cancelled) setLoadingMembers(false);
    });
    const timer = window.setInterval(() => {
      void loadMembers();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadMembers]);

  // Auto-scroll to bottom on new messages unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  const title = openTeamCollabTitle(collab);
  const inviter = shortGlobalMetaId(collab.inviterGlobalmetaid);
  const botLabel = collab.botName?.trim() || `bot-${collab.metabotId}`;
  const ownBotGlobalMetaId = collab.globalmetaid?.trim() || null;

  // Compute deliverables from messages (similar to GroupTaskDetailView)
  const deliverables = useMemo(
    () => {
      const extracted = messages
        .filter((msg) => msg.content?.includes('[DELIVERABLE]'))
        .map((msg) => {
          // Extract deliverable info from message content
          const match = msg.content?.match(/\[DELIVERABLE\]\s*(.+)/);
          if (!match) return null;
          const uriOrText = match[1]?.trim();
          if (!uriOrText) return null;
          // Parse as simple URI or metafile
          return {
            id: msg.id,
            pinId: msg.pinId,
            kind: uriOrText.startsWith('metafile://') ? 'metafile' : 'uri',
            uri: uriOrText,
            text: null,
            authorGlobalMetaId: msg.senderGlobalMetaId,
            status: 'delivered' as const,
            createdAt: msg.createdAt,
          };
        })
        .filter((d): d is NonNullable<typeof d> => d != null && isDigitalDeliverable(d));
      return dedupeDeliverablesByPinid(extracted);
    },
    [messages],
  );

  const memberDisplayName = (member: OpenTeamCollabMember): string =>
    member.name ?? (member.metabotId != null
      ? `bot-${member.metabotId}`
      : member.globalmetaid
        ? `${member.globalmetaid.slice(0, 10)}…`
        : 'remote bot');

  const deliverableAuthorName = (authorGlobalMetaId: string | null): string => {
    if (!authorGlobalMetaId) return '—';
    const member = members.find((candidate) => candidate.globalmetaid === authorGlobalMetaId);
    if (member?.name) return member.name;
    return `${authorGlobalMetaId.slice(0, 10)}…`;
  };

  return (
    <div className="flex h-full">
      {/* Main content area */}
      <div className="flex flex-col flex-1 min-w-0">
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
            <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text truncate">
              {title}
            </h1>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${openTeamCollabStatusBadgeClass(collab)}`}>
              {openTeamCollabStatusLabel(collab)}
            </span>
            <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium bg-green-500/15 text-green-600 dark:text-green-400">
              OpenTeam
            </span>
            <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium bg-sky-500/15 text-sky-600 dark:text-sky-400">
              {i18nService.t('groupTasksTaskBadgeGuest')}
            </span>
          </div>
          <WindowTitleBar inline />
        </div>

        {/* Meta strip: who invited us, which bot joined, when */}
        <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 shrink-0">
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('openTeamCollabYourBot')}: {botLabel}
            {inviter ? ` · ${i18nService.t('openTeamCollabInvitedBy')} ${inviter}` : ''}
            {collab.createdAt ? ` · ${i18nService.t('openTeamCollabJoined')} ${formatGroupTaskTime(collab.createdAt)}` : ''}
          </p>
          <p className="mt-1 text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {i18nService.t('openTeamCollabReadOnlyHint')}
          </p>
        </div>

        {/* Transcript */}
        <div
          ref={scrollRef}
          onScroll={handleTranscriptScroll}
          className="flex-1 overflow-y-auto pt-3"
        >
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
            messages.map((message) => (
              <GroupTaskMessageItem
                key={message.id}
                message={message}
                isChairSender={false}
                isOwnerSender={false}
                isOwnBotSender={Boolean(
                  ownBotGlobalMetaId && message.senderGlobalMetaId === ownBotGlobalMetaId,
                )}
              />
            ))
          )}
        </div>
      </div>

      {/* Right sidebar */}
      <div className="w-80 border-l dark:border-claude-darkBorder border-claude-border overflow-y-auto shrink-0">
        {/* Members section */}
        <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
          <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
            {i18nService.t('groupTasksMembers')}
          </h3>
          {loadingMembers && members.length === 0 ? (
            <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {i18nService.t('loading')}
            </p>
          ) : members.length === 0 ? (
            <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {i18nService.t('groupTasksNoMembers')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {members.map((member) => (
                <React.Fragment key={member.id ?? member.globalmetaid}>
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
                    {member.metabotId == null ? (
                      <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-green-500/15 text-green-600 dark:text-green-400">
                        {i18nService.t('groupTasksRemoteBadge')}
                      </span>
                    ) : (
                      <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-sky-500/15 text-sky-600 dark:text-sky-400">
                        {i18nService.t('groupTasksLocalBadge')}
                      </span>
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
          )}
        </div>

        {/* Deliverables section */}
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
                const verification = deliverableVerificationState(deliverable);
                const canOpen = isBotBrowserUri(deliverable.uri ?? '');

                return (
                  <div
                    key={deliverable.pinId || deliverable.id}
                    className="relative rounded-lg border dark:border-claude-darkBorder/50 border-claude-border/50 p-2.5 dark:bg-claude-darkSurfaceHover/30 bg-claude-surfaceHover/30"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight ${kindBadge.class}`}>
                          {kindBadge.label}
                        </span>
                        {verification && (
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight ${deliverableVerificationBadgeClass(verification)}`}>
                            {verification}
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight bg-slate-500/10 text-slate-600 dark:text-slate-400">
                        {i18nService.t(statusKey)}
                      </span>
                    </div>
                    <p className="text-[11px] leading-snug dark:text-claude-darkText text-claude-text break-all line-clamp-2 mb-1.5">
                      {deliverable.uri ?? deliverable.text ?? '—'}
                    </p>
                    <div className="flex items-center justify-between text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                      <span>{deliverableAuthorName(deliverable.authorGlobalMetaId)}</span>
                      <span>{formatGroupTaskTime(deliverable.createdAt)}</span>
                    </div>
                    {canOpen && deliverable.uri && (
                      <button
                        type="button"
                        onClick={() => openGroupTaskUri(deliverable.uri!)}
                        className="mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 px-2 rounded text-[11px] font-medium dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurface bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border dark:border-claude-darkBorder border-claude-border transition-colors"
                      >
                        {i18nService.t('groupTasksDeliverableOpen')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OpenTeamCollabDetailView;
