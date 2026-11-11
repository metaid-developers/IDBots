import { useCallback, useEffect, useRef, useState } from 'react';
import { Bars3Icon, PlusIcon, PaperClipIcon, FaceSmileIcon, StopIcon, EllipsisHorizontalIcon, MagnifyingGlassIcon, PencilSquareIcon, TrashIcon, XMarkIcon, ArrowDownIcon } from '@heroicons/react/24/outline';
import MarkdownContent from '@/components/MarkdownContent';
import MobileArtifactPreview from '../components/MobileArtifactPreview';
import CoworkPermissionPanel from '@/components/cowork/CoworkPermissionPanel';
import { coworkAttachmentAdmission } from '@/components/cowork/coworkComposerAttachments';
import ChatComposerAttachments from '../components/ChatComposerAttachments';
import { EmojiPickerPanel, rememberRecentEmoji } from '../components/EmojiPickerPanel';
import { insertEmojiAtCaret } from '../chat/emojiTextInsert';
import { isNearBottom } from '../chat/autoScroll';
import { mapWechatBracketCodesForDisplay } from '../chat/wechatEmojiDisplay';
import TwemojiText from '@/components/chat/TwemojiText';
import { t } from '../../i18n';
import type { MockMetabot } from '../../bridge/types';
import type { useChat } from '../hooks/useChat';
import { formatDiagnosticCopy, type ChatMessageView } from '../chatProjection';
import { copyTextToClipboard } from '../../login/inAppBrowser';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import { useNativeBackHandler } from '../hooks/useNativeBackHandler';
import { getNativeAdapter } from '../../native/nativeAdapter';
import { BottomSheet } from '../components/BottomSheet';
import { BotAvatar } from '../components/BotAvatar';
import { filterSessionsByTitle, groupSessionsByDay, resolveSessionBot } from '../sessionList';
import { sortBotsForList } from '../botList';
import { useVoiceInput } from '../voice/useVoiceInput';
import { VoiceButton, VoiceErrorBanner } from '../voice/VoiceButton';
import { sendVoiceMessage, type HoldCancelReason } from '../voice/holdToSend';

type Chat = ReturnType<typeof useChat>;

const GROUP_LABEL_KEYS = {
  today: 'mobile.chat.group.today',
  yesterday: 'mobile.chat.group.yesterday',
  earlier: 'mobile.chat.group.earlier',
} as const;

/**
 * Chat drawer (UE rework 2026-10-29, A4; search/rename/delete 2026-11-02).
 *
 * Rows keep their day-grouped, tap-to-open behavior unchanged. New affordances:
 *   - a title search (sync filter — the session list is a small client-side
 *     summary array, so per-keystroke filtering is cheap by construction);
 *   - a per-row "…" actions button opening a bottom sheet with Rename/Delete;
 *   - Delete is gated behind its own confirm sheet and calls the ARCHIVE
 *     channel (cowork.archiveSession): the allowlist has no hard-delete
 *     session channel by design (desktop cowork.ts: "Hard delete is
 *     intentionally not exposed to users"), so the row leaves the list while
 *     the record survives — restorable via the desktop Archived Chats UI.
 * Closing the drawer resets the search query and any open sub-sheet.
 */
export function SessionDrawer(props: { chat: Chat; bots: MockMetabot[]; open: boolean; onPickBot: () => void; onClose: () => void }): JSX.Element | null {
  const { chat, bots } = props;
  const [searchQuery, setSearchQuery] = useState('');
  const [actionsFor, setActionsFor] = useState<{ id: string; title: string } | null>(null);
  const [renameFor, setRenameFor] = useState<{ id: string; title: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteFor, setDeleteFor] = useState<{ id: string; title: string } | null>(null);
  useNativeBackHandler(() => {
    props.onClose();
    return true;
  }, props.open, 100);
  // Reset transient drawer state on close so reopening starts clean (no
  // stale search text, no orphaned sheets).
  useEffect(() => {
    if (props.open) return;
    setSearchQuery('');
    setActionsFor(null);
    setRenameFor(null);
    setRenameDraft('');
    setDeleteFor(null);
  }, [props.open]);
  if (!props.open) return null;
  const visibleSessions = filterSessionsByTitle(chat.sessions, searchQuery);
  const groups = groupSessionsByDay(visibleSessions);
  const trimmedQuery = searchQuery.trim();
  const submitRename = async (): Promise<void> => {
    if (!renameFor) return;
    const ok = await chat.renameSession(renameFor.id, renameDraft);
    if (ok) setRenameFor(null);
  };
  const confirmDelete = async (): Promise<void> => {
    if (!deleteFor) return;
    const ok = await chat.archiveSession(deleteFor.id);
    if (ok) setDeleteFor(null);
  };
  return (
    <div className="fixed inset-0 z-30">
      <button type="button" aria-label={t('mobile.common.close')} className="twin-sheet-backdrop absolute inset-0" onClick={props.onClose} tabIndex={-1} />
      <div className="twin-drawer absolute bottom-0 left-0 top-0 flex w-[85%] max-w-[320px] flex-col">
        <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
          <h2 className="twin-title-small">{t('mobile.chat.drawerTitle')}</h2>
          <button
            type="button"
            onClick={() => {
              props.onPickBot();
            }}
            data-testid="session-new-chat"
            className="twin-button twin-button-ghost"
          >
            <PlusIcon className="h-4 w-4" aria-hidden />
            {t('mobile.chat.newChat')}
          </button>
        </div>
        <div className="border-b border-[var(--border-color)] px-4 py-2">
          <div className="twin-input flex items-center gap-2">
            <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('mobile.chat.searchSessions')}
              aria-label={t('mobile.chat.searchSessions')}
              data-testid="session-search-input"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
            />
            {searchQuery !== '' ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label={t('mobile.chat.searchClear')}
                data-testid="session-search-clear"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] active:text-[var(--text-primary)]"
              >
                <XMarkIcon className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="session-drawer-list">
          {groups.length === 0 ? (
            <p
              className="px-4 py-6 text-sm text-[var(--text-secondary)]"
              data-testid={trimmedQuery !== '' ? 'session-search-empty' : undefined}
            >
              {trimmedQuery !== '' ? t('mobile.chat.searchEmpty') : t('mobile.chat.drawerEmpty')}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.key}>
                <p
                  className="twin-section-label sticky top-0 bg-[var(--bg-panel)]"
                  data-testid={`session-group-${group.key}`}
                >
                  {t(GROUP_LABEL_KEYS[group.key])}
                </p>
                {group.sessions.map((session) => {
                  const bot = resolveSessionBot(chat.sessions, session.id, null, bots);
                  return (
                    <div
                      key={session.id}
                      className={`flex items-stretch border-b border-[var(--border-color)] ${
                        session.id === chat.sessionId ? 'bg-[var(--bg-hover)]' : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          void chat.openSession(session.id);
                          props.onClose();
                        }}
                        className="twin-list-row min-w-0 flex-1"
                      >
                        <BotAvatar name={bot.name} avatar={bot.avatar} size={32} testId={`session-bot-avatar-${session.id}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            {session.status === 'running' ? <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" aria-hidden /> : null}
                            <span className="truncate text-[var(--text-primary)]">{session.title}</span>
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setActionsFor({ id: session.id, title: session.title })}
                        aria-label={t('mobile.chat.sessionActions')}
                        data-testid={`session-actions-${session.id}`}
                        className="twin-icon-button shrink-0"
                      >
                        <EllipsisHorizontalIcon className="h-5 w-5" aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </div>
      {actionsFor ? (
        <BottomSheet title={t('mobile.chat.sessionActionsTitle')} onClose={() => setActionsFor(null)}>
          <div className="flex flex-col" data-testid="session-action-menu">
            <button
              type="button"
              data-testid="session-action-rename"
              onClick={() => {
                setRenameFor(actionsFor);
                setRenameDraft(actionsFor.title);
                setActionsFor(null);
              }}
              className="flex min-h-[52px] items-center gap-3 border-b border-[var(--border-color)] px-1 py-2 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              <PencilSquareIcon className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden />
              {t('mobile.chat.rename')}
            </button>
            <button
              type="button"
              data-testid="session-action-delete"
              onClick={() => {
                setDeleteFor(actionsFor);
                setActionsFor(null);
              }}
              className="flex min-h-[52px] items-center gap-3 px-1 py-2 text-left text-[15px] text-red-600 active:bg-[var(--bg-hover)]"
            >
              <TrashIcon className="h-5 w-5" aria-hidden />
              {t('mobile.chat.delete')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {renameFor ? (
        <BottomSheet title={t('mobile.chat.renameTitle')} onClose={() => setRenameFor(null)}>
          <input
            type="text"
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            placeholder={t('mobile.chat.renamePlaceholder')}
            aria-label={t('mobile.chat.renamePlaceholder')}
            data-testid="session-rename-input"
            className="min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-testid="session-rename-cancel"
              onClick={() => setRenameFor(null)}
              className="flex min-h-[44px] items-center rounded-xl border border-[var(--border-color)] px-4 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.common.cancel')}
            </button>
            <button
              type="button"
              data-testid="session-rename-confirm"
              disabled={renameDraft.trim() === ''}
              onClick={() => {
                void submitRename();
              }}
              className="flex min-h-[44px] items-center rounded-xl bg-[var(--color-primary)] px-4 text-sm text-black active:opacity-80 disabled:opacity-40"
            >
              {t('mobile.chat.renameSave')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {deleteFor ? (
        <BottomSheet title={t('mobile.chat.deleteTitle')} onClose={() => setDeleteFor(null)}>
          <p data-testid="session-delete-body" className="text-sm leading-relaxed text-[var(--text-secondary)]">
            {t('mobile.chat.deleteBody')}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-testid="session-delete-cancel"
              onClick={() => setDeleteFor(null)}
              className="flex min-h-[44px] items-center rounded-xl border border-[var(--border-color)] px-4 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.common.cancel')}
            </button>
            <button
              type="button"
              data-testid="session-delete-confirm"
              onClick={() => {
                void confirmDelete();
              }}
              className="flex min-h-[44px] items-center rounded-xl bg-red-100 px-4 text-sm text-red-700 active:bg-red-200"
            >
              {t('mobile.chat.deleteConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}

/**
 * New-chat Bot picker (UE rework 2026-10-29, A3): a conversation is started
 * FOR a specific MetaBot, so the picker is the only place a Bot is chosen —
 * aligned with the desktop "start a conversation" flow. Rows carry the Bot
 * avatar; the Twin ranks first (shared sortBotsForList order).
 */
function BotPickerSheet(props: { chat: Chat; bots: MockMetabot[]; open: boolean; onClose: () => void }): JSX.Element | null {
  const { chat } = props;
  if (!props.open) return null;
  const sorted = sortBotsForList(props.bots);
  return (
    <BottomSheet title={t('mobile.chat.pickBotTitle')} onClose={props.onClose}>
      <p className="text-xs text-[var(--text-secondary)]">{t('mobile.chat.pickBotHint')}</p>
      <div className="mt-2 flex flex-col" data-testid="bot-picker-list">
        {sorted.map((bot) => (
          <button
            key={bot.id}
            type="button"
            data-testid={`bot-picker-option-${bot.id}`}
            onClick={() => {
              chat.setMetabotId(bot.id);
              chat.newChat();
              props.onClose();
            }}
            className="flex min-h-[56px] items-center gap-3 border-b border-[var(--border-color)] px-1 py-2 text-left last:border-b-0 active:bg-[var(--bg-hover)]"
          >
            <BotAvatar name={bot.name} avatar={bot.avatar} testId={`bot-picker-avatar-${bot.id}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-[var(--text-primary)]">{bot.name}</span>
              {bot.role ? <span className="block truncate text-xs text-[var(--text-secondary)]">{bot.role}</span> : null}
            </span>
            {bot.metabot_type === 'twin' ? (
              <span className="shrink-0 text-xs text-[var(--color-primary)]">{t('mobile.me.botType.twin')}</span>
            ) : null}
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

function PermissionSheet({ chat }: { chat: Chat }): JSX.Element | null {
  const permission = chat.permission;
  if (!permission) return null;
  return (
    <BottomSheet title={t('mobile.chat.permissionTitle')} onClose={chat.dismissPermission}>
      <CoworkPermissionPanel
        permission={permission.request}
        responding={permission.responding}
        onRespond={(result) => {
          void chat.respondPermission(result);
        }}
      />
    </BottomSheet>
  );
}

function ToolCallList({ chat }: { chat: Chat }): JSX.Element | null {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (chat.toolCalls.length === 0) return null;
  return (
    <div className="border-t border-[var(--border-color)] px-4 py-2" data-testid="tool-call-list">
      {chat.toolCalls.map((call) => {
        const expanded = expandedId === call.requestId;
        return (
          <div key={call.requestId} className="py-1">
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : call.requestId)}
              className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left text-xs text-[var(--text-secondary)] active:text-[var(--text-primary)]"
            >
              <span className="truncate">{t('mobile.chat.toolCallSummary', { name: call.toolName })}</span>
              <span aria-hidden>{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded ? (
              <div className="mb-1 rounded-lg bg-[var(--bg-main)] p-2">
                <p className="mb-1 text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                  {t('mobile.chat.toolCallInputTitle')}
                </p>
                <pre className="overflow-x-auto text-[11px] text-[var(--text-secondary)]">
                  {JSON.stringify(call.input, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function messageText(message: ChatMessageView): string {
  return message.diagnostic ? t(`mobile.chat.diagnostic.${message.diagnostic}`) : message.text;
}

/**
 * "Copy diagnostics" for a turnFailed bubble: puts timestamp, session id (when
 * known), the diagnostic kind and the FULL raw error text on the clipboard so
 * the owner can paste a self-describing report. When the clipboard is
 * unavailable (insecure context / webview) the button says so and the reason
 * line stays selectable — long-press to copy manually.
 */
function DiagnosticCopyButton({ message, sessionId }: { message: ChatMessageView; sessionId: string | null }): JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);
  const copy = async (): Promise<void> => {
    const copied = await copyTextToClipboard(formatDiagnosticCopy(message, sessionId));
    setCopyState(copied ? 'copied' : 'failed');
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopyState('idle'), 1600);
  };
  const labelKey = copyState === 'idle'
    ? 'mobile.chat.diagnostic.copy'
    : copyState === 'copied'
      ? 'mobile.chat.diagnostic.copied'
      : 'mobile.chat.diagnostic.copyFailed';
  return (
    <button
      type="button"
      data-testid="chat-diagnostic-copy"
      onClick={() => void copy()}
      className="mt-1 min-h-[36px] select-none text-[11px] font-normal underline opacity-80 active:opacity-100"
    >
      {t(labelKey)}
    </button>
  );
}

function MessageRow({ message, sessionId, onOpenFile }: { message: ChatMessageView; sessionId: string | null; onOpenFile: (filePath: string) => boolean }): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="twin-message flex justify-end">
        <div className="twin-message-user whitespace-pre-wrap break-words" data-testid="chat-user-message">
          {/* Display-only mapping (wechatEmojiDisplay.ts); catalog emoji
              render as bundled Twemoji images (alt = codepoint). */}
          <TwemojiText text={mapWechatBracketCodesForDisplay(message.text)} />
        </div>
      </div>
    );
  }
  if (message.role === 'error') {
    return (
      <div className="twin-message flex justify-start">
        {/* select-text keeps the reason long-pressable on phones where the
            clipboard API is unavailable (copy button's documented fallback). */}
        <div className="twin-message-error select-text whitespace-pre-wrap break-words" data-testid="error-bubble">
          {/* Display-only mapping (wechatEmojiDisplay.ts); catalog emoji
              render as bundled Twemoji images (alt = codepoint). Same
              display convention as the user/assistant bubbles. */}
          <TwemojiText text={mapWechatBracketCodesForDisplay(messageText(message))} />
          {message.diagnosticReason ? (
            <p className="mt-1 break-words text-[11px] font-normal opacity-80" data-testid="chat-diagnostic-reason">
              {`${t('mobile.chat.diagnostic.reasonLabel')}: ${message.diagnosticReason}`}
            </p>
          ) : null}
          {message.diagnostic === 'turnFailed' ? (
            <DiagnosticCopyButton message={message} sessionId={sessionId} />
          ) : null}
        </div>
      </div>
    );
  }
  if (message.role === 'system') {
    return (
      <div className="twin-message flex justify-start">
        <div className="twin-message-system whitespace-pre-wrap break-words" data-testid="system-notice">
          {/* Display-only mapping (wechatEmojiDisplay.ts); catalog emoji
              render as bundled Twemoji images (alt = codepoint). Same
              display convention as the user/assistant bubbles. */}
          <TwemojiText text={mapWechatBracketCodesForDisplay(messageText(message))} />
        </div>
      </div>
    );
  }
  return (
    <div className="twin-message flex justify-start">
      <div className="twin-message-assistant">
        {/* Display-only mapping (wechatEmojiDisplay.ts); emojiImages renders
            catalog emoji as bundled Twemoji artwork inside the markdown. */}
        <MarkdownContent content={mapWechatBracketCodesForDisplay(message.text)} chatExperienceMode="assistant" compact onOpenLocalFile={onOpenFile} emojiImages />
        {message.streaming ? <span className="mt-1 inline-block h-4 w-2 animate-pulse bg-[var(--color-primary)]" aria-hidden /> : null}
      </div>
    </div>
  );
}

function SubmissionStatus({ chat }: { chat: Chat }): JSX.Element | null {
  const attempts = chat.attempts ?? [];
  if (attempts.length === 0 && !chat.actionError) return null;
  return (
    <div className="mx-3 mb-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-3" data-testid="chat-action-status">
      {chat.actionError ? <p className="mb-2 whitespace-pre-wrap break-words text-xs text-red-600">{chat.actionError}</p> : null}
      {attempts.map((attempt) => (
        <div key={attempt.submissionId} className="flex flex-wrap items-center gap-2 py-1">
          <span className="min-w-0 flex-1 text-xs text-[var(--text-secondary)]">
            {t(`mobile.chat.submission.${attempt.status}`)}
            {attempt.status === 'verified' && attempt.error ? (
              <span className="block whitespace-pre-wrap break-words">{attempt.error}</span>
            ) : null}
          </span>
          {attempt.status !== 'sending' ? (
            <>
              <button type="button" onClick={() => void chat.reconcileSubmission(attempt.submissionId)} disabled={attempt.status === 'reconciling'} className="min-h-[36px] px-2 text-xs text-[var(--text-primary)] disabled:opacity-40">
                {t('mobile.chat.reconcile')}
              </button>
              {attempt.kind === 'submit' || attempt.status === 'failed' ? (
                <button type="button" onClick={() => void chat.retrySubmission(attempt.submissionId)} disabled={attempt.status === 'reconciling' || attempt.status === 'verified'} className="min-h-[36px] px-2 text-xs text-[var(--text-primary)] disabled:opacity-40">
                  {t('mobile.common.retry')}
                </button>
              ) : null}
              <button type="button" onClick={() => chat.discardSubmission(attempt.submissionId)} disabled={attempt.status === 'reconciling'} className="min-h-[36px] px-2 text-xs text-[var(--text-secondary)] disabled:opacity-40">
                {t('mobile.chat.discard')}
              </button>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function ChatScreen(props: {
  chat: Chat;
  bots: MockMetabot[];
  botsError?: string | null;
  onReloadBots?: () => void;
  onOpenRecharge: () => void;
  rechargeAllowed?: boolean;
}): JSX.Element {
  const { chat, bots } = props;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachmentSourceOpen, setAttachmentSourceOpen] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // Refs (caret notes: emojiTextInsert.ts).
  const listRef = useRef<HTMLDivElement | null>(null);
  // Scroll guard (autoScroll.ts): follow new content only while the
  // viewport hugs the transcript bottom; reading history keeps the scroll
  // position frozen and shows the "new messages" pill instead.
  const stickToBottomRef = useRef(true);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const keyboardInset = useKeyboardInset();
  const headerBot = resolveSessionBot(chat.sessions, chat.sessionId, chat.metabotId, bots);
  const draft = chat.draft ?? '';
  const attachments = chat.attachments ?? [];
  const nativeCapabilities = typeof window === 'undefined' ? null : getNativeAdapter().getCapabilities();
  const hasNativeAttachmentPicker = nativeCapabilities !== null
    && (nativeCapabilities.camera || nativeCapabilities.photos || nativeCapabilities.files);
  const openPreview = useCallback((filePath: string): boolean => {
    setPreviewPath(filePath);
    return true;
  }, []);
  const turnPhase = chat.turnPhase ?? (chat.isStreaming ? 'running' : 'idle');
  const composerBlocked = chat.isSending
    || chat.restoring
    || chat.pendingPermissionCount > 0
    || turnPhase === 'stopping'
    || (!chat.sessionId && chat.metabotId === null);
  const canSubmit = Boolean(draft.trim() || attachments.length > 0)
    && !composerBlocked
    && !chat.isUploading;
  const canAttach = coworkAttachmentAdmission({
    disabled: chat.isSending || chat.restoring || (!chat.sessionId && chat.metabotId === null),
    isStreaming: chat.isStreaming,
    steerDisabled: chat.pendingPermissionCount > 0 || turnPhase === 'stopping',
  }) && !chat.isUploading;

  // Voice input (voice P1: hold to send). Press and hold the mic to record;
  // release sends the transcript as a NEW message via chat.send, so the
  // composer draft (whatever the user already typed) is never touched. Swipe
  // up cancels, and a pointer press shorter than 400 ms is discarded as an
  // accidental press (one-shot hint, never a send). The accessible path is the
  // click/keyboard activation, which keeps the P0 tap toggle and its streaming
  // backfill into the draft.
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const voiceHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showVoiceHint = useCallback((copy: string) => {
    setVoiceHint(copy);
    if (voiceHintTimerRef.current !== null) clearTimeout(voiceHintTimerRef.current);
    voiceHintTimerRef.current = setTimeout(() => setVoiceHint(null), 2200);
  }, []);
  useEffect(
    () => () => {
      if (voiceHintTimerRef.current !== null) clearTimeout(voiceHintTimerRef.current);
    },
    [],
  );
  const voice = useVoiceInput({
    getDraftAndCaret: () => {
      const textarea = textareaRef.current;
      const caret =
        textarea && typeof textarea.selectionStart === 'number' && document.activeElement === textarea
          ? textarea.selectionStart
          : pendingCaretRef.current;
      return { draft: chat.draft ?? '', caret };
    },
    onDraftReplace: (text, caret) => {
      pendingCaretRef.current = caret;
      chat.setDraft(text);
    },
    // Release-to-send: the transcript bypasses the composer entirely. An empty
    // transcript is an accidental press (hint only); a busy composer keeps the
    // words in the draft instead of dropping them.
    onFinalText: (text) => {
      const outcome = sendVoiceMessage(chat, text, { blocked: composerBlocked });
      if (outcome === 'empty') showVoiceHint(t('mobile.chat.voice.hintNoSpeech'));
      else if (outcome === 'kept_in_draft') showVoiceHint(t('mobile.chat.voice.hintKeptInDraft'));
    },
  });
  const handleVoiceHoldCancelled = (reason: HoldCancelReason) => {
    // One-shot hint for an accidental short press; the swipe path already has
    // its own visual feedback in the overlay.
    if (reason === 'too_short') showVoiceHint(t('mobile.chat.voice.hintTooShort'));
  };

  // Track stickiness on user scroll: leaving the near-bottom zone releases
  // auto-follow; returning to it re-arms follow and dismisses the pill.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      const near = isNearBottom(list);
      stickToBottomRef.current = near;
      if (near) setShowNewMessages(false);
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => list.removeEventListener('scroll', onScroll);
  }, []);
  // Auto-scroll on message/streaming updates, guarded by stickiness: near
  // the bottom this preserves the original follow exactly; further up the
  // position must not move at all — only flag the pill.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (stickToBottomRef.current) {
      list.scrollTop = list.scrollHeight;
    } else {
      setShowNewMessages(true);
    }
  }, [chat.messages, chat.isStreaming]);
  const scrollToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    stickToBottomRef.current = true;
    setShowNewMessages(false);
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  };
  useEffect(() => setPreviewPath(null), [chat.sessionId]);

  // Insertion point: DOM selection (focused) / pending caret / end.
  const currentEmojiSelection = (): { start: number; end: number } | null => {
    const textarea = textareaRef.current;
    if (
      textarea
      && typeof document !== 'undefined'
      && document.activeElement === textarea
      && typeof textarea.selectionStart === 'number'
    ) {
      return { start: textarea.selectionStart, end: textarea.selectionEnd };
    }
    const pending = pendingCaretRef.current;
    return pending == null ? null : { start: pending, end: pending };
  };

  const insertEmoji = (emoji: string) => {
    rememberRecentEmoji(emoji);
    const insertion = insertEmojiAtCaret(draft, emoji, currentEmojiSelection());
    pendingCaretRef.current = insertion.caret;
    chat.setDraft(insertion.text);
    // No refocus (WeChat-style flow).
  };

  // Caret restore (post-render).
  useEffect(() => {
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret == null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.setSelectionRange(caret, caret);
  }, [draft]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  }, [draft]);

  const submit = () => {
    if (!canSubmit) return;
    void chat.send(draft, attachments);
  };

  return (
    <div className="twin-page">
      <div className="twin-topbar">
        <button type="button" onClick={() => setDrawerOpen(true)} aria-label={t('mobile.chat.drawerTitle')} className="twin-icon-button">
          <Bars3Icon className="h-6 w-6" aria-hidden />
        </button>
        <div className="twin-chat-identity">
          <BotAvatar name={headerBot.name} avatar={headerBot.avatar} size={34} testId="chat-header-avatar" />
          <div className="twin-chat-identity-copy">
            <span className="twin-chat-bot-name">{headerBot.name ?? t('mobile.chat.title')}</span>
            <h1 className="twin-chat-session-name" data-testid="chat-header-title">
              {chat.sessionTitle ?? t('mobile.chat.title')}
            </h1>
          </div>
        </div>
        <button type="button" onClick={() => setPickerOpen(true)} aria-label={t('mobile.chat.newChat')} className="twin-icon-button">
          <PlusIcon className="h-6 w-6" aria-hidden />
        </button>
      </div>

      {props.botsError ? (
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-2" role="alert" data-testid="bots-error">
          <p className="min-w-0 flex-1 text-xs text-red-600">{props.botsError}</p>
          {props.onReloadBots ? (
            <button type="button" onClick={props.onReloadBots} className="min-h-[36px] px-2 text-xs text-[var(--text-primary)]">
              {t('mobile.common.retry')}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Relative wrapper anchors the floating new-messages pill to the
          transcript's bottom edge (just above the composer). */}
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} className="twin-scroll h-full px-4 py-4">
          {chat.hasMoreHistory ? (
            <button type="button" onClick={() => void chat.loadEarlierMessages()} className="twin-button twin-button-secondary twin-button-full mb-3">
              {t('mobile.chat.loadEarlier')}
            </button>
          ) : null}
          {chat.messages.length === 0 ? (
            <div className="twin-empty h-full">
              <p className="twin-empty-title">
                {chat.restoring ? t('mobile.common.loading') : t('mobile.chat.emptyTitle')}
              </p>
              {!chat.restoring ? <p className="twin-empty-copy">{t('mobile.chat.emptyBody')}</p> : null}
            </div>
          ) : (
            chat.messages.map((message) => <MessageRow key={message.id} message={message} sessionId={chat.sessionId ?? null} onOpenFile={openPreview} />)
          )}
          {turnPhase !== 'idle' && turnPhase !== 'completed' ? (
            <p className="px-2 py-1 text-xs text-[var(--text-secondary)]" data-testid="turn-phase">
              {t(`mobile.chat.phase.${turnPhase}`)}
            </p>
          ) : null}
        </div>
        {showNewMessages ? (
          <button
            type="button"
            onClick={scrollToLatest}
            aria-label={t('mobile.chat.newMessages')}
            data-testid="chat-new-messages-pill"
            className="twin-chip absolute bottom-3 left-1/2 z-10 -translate-x-1/2 gap-1.5 px-4 shadow-lg"
          >
            <ArrowDownIcon className="h-4 w-4" aria-hidden />
            {t('mobile.chat.newMessages')}
          </button>
        ) : null}
      </div>

      {chat.pendingPermissionCount > 0 && !chat.permission ? (
        <button type="button" onClick={chat.reopenPermissions} className="twin-button twin-button-secondary mx-3 mb-2">
          {t('mobile.chat.actionRequired', { count: chat.pendingPermissionCount })}
        </button>
      ) : null}

      <ToolCallList chat={chat} />

      {chat.quotaExhausted ? (
        <div className="twin-notice twin-notice-warning mx-3 mb-2" data-testid="quota-card">
          <p className="text-sm font-semibold">
            {t(
              chat.quotaKind === 'me'
                ? 'mobile.chat.quotaTitleMe'
                : chat.quotaKind === 'purchased'
                  ? 'mobile.chat.quotaTitlePurchased'
                  : 'mobile.chat.quotaTitleFree',
            )}
          </p>
          <p className="mb-2 text-sm">
            {t(
              chat.quotaKind === 'me'
                ? 'mobile.chat.quotaBodyMe'
                : chat.quotaKind === 'purchased'
                  ? 'mobile.chat.quotaBodyPurchased'
                  : 'mobile.chat.quotaBodyFree',
            )}
          </p>
          <div className="flex gap-2">
            {props.rechargeAllowed !== false ? (
              <button type="button" onClick={props.onOpenRecharge} className="twin-button twin-button-primary flex-1">
                {t(chat.quotaKind === 'me' ? 'mobile.chat.quotaMeAction' : 'mobile.chat.quotaRecharge')}
              </button>
            ) : null}
            <button type="button" onClick={chat.dismissQuota} className="twin-button twin-button-secondary">
              {t('mobile.chat.quotaDismiss')}
            </button>
          </div>
        </div>
      ) : null}

      <SubmissionStatus chat={chat} />

      <div className="twin-composer-zone" style={{ paddingBottom: `calc(max(env(safe-area-inset-bottom), ${keyboardInset}px) + 8px)` }}>
        {emojiPanelOpen ? (
          <EmojiPickerPanel onSelect={insertEmoji} onClose={() => setEmojiPanelOpen(false)} />
        ) : null}
        <ChatComposerAttachments chat={chat} />
        <VoiceErrorBanner state={voice.state} onDismiss={voice.dismissError} />
        {voiceHint ? (
          <div className="twin-voice-hint" role="status" data-testid="voice-hint">
            {voiceHint}
          </div>
        ) : null}
        <div className="twin-composer">
          <button
            type="button"
            onClick={() => {
              setEmojiPanelOpen(false);
              setComposerMenuOpen(true);
            }}
            aria-label={t('mobile.chat.composerActions')}
            aria-expanded={composerMenuOpen}
            aria-haspopup="dialog"
            className="twin-icon-button twin-composer-accessory twin-composer-plus"
            data-testid="composer-plus"
          >
            <PlusIcon className="h-6 w-6" aria-hidden />
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => chat.setDraft(event.target.value)}
            onFocus={() => {
              setEmojiPanelOpen(false);
              setComposerMenuOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (canSubmit) submit();
            }}
            enterKeyHint="send"
            placeholder={t('mobile.chat.composerPlaceholder')}
            aria-label={t('mobile.chat.composerPlaceholder')}
            rows={1}
            className="twin-composer-input max-h-32 resize-none"
            data-testid="chat-composer-input"
          />
          {chat.isStreaming ? (
            <button
              type="button"
              onClick={() => void chat.stop()}
              disabled={turnPhase === 'stopping'}
              aria-label={t('mobile.chat.stop')}
              className="twin-icon-button twin-icon-button-danger twin-composer-tail"
            >
              <StopIcon className="h-5 w-5" aria-hidden />
            </button>
          ) : (
            <div className="twin-composer-tail">
              <VoiceButton
                state={voice.state}
                elapsedSec={voice.elapsedSec}
                recognizedText={voice.recognizedText}
                levelRef={voice.levelRef}
                bottomInset={keyboardInset}
                onStart={voice.start}
                onStop={voice.stop}
                onStartHold={voice.startHold}
                onEndHold={voice.endHold}
                onCancelHold={voice.cancelHold}
                onSalvage={voice.commitToDraft}
                onDismissError={voice.dismissError}
                onHoldCancelled={handleVoiceHoldCancelled}
              />
            </div>
          )}
        </div>
      </div>

      <SessionDrawer
        chat={chat}
        bots={bots}
        open={drawerOpen}
        onPickBot={() => {
          setDrawerOpen(false);
          setPickerOpen(true);
        }}
        onClose={() => setDrawerOpen(false)}
      />
      <BotPickerSheet
        chat={chat}
        bots={bots}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
      {composerMenuOpen ? (
        <BottomSheet title={t('mobile.chat.composerActions')} onClose={() => setComposerMenuOpen(false)}>
          <div className="flex flex-col" data-testid="composer-action-sheet">
            <button
              type="button"
              data-testid="composer-action-emoji"
              onClick={() => {
                setComposerMenuOpen(false);
                setEmojiPanelOpen(true);
              }}
              className="flex min-h-[52px] items-center gap-3 border-b border-[var(--border-color)] px-1 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              <FaceSmileIcon className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden />
              {t('mobile.chat.emojiPicker')}
            </button>
            <button
              type="button"
              data-testid="composer-action-attachment"
              disabled={!canAttach}
              onClick={() => {
                setComposerMenuOpen(false);
                if (hasNativeAttachmentPicker) {
                  setAttachmentSourceOpen(true);
                } else {
                  void chat.pickAttachments('files');
                }
              }}
              className="flex min-h-[52px] items-center gap-3 px-1 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
            >
              <PaperClipIcon className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden />
              {t('mobile.chat.addAttachment')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {attachmentSourceOpen ? (
        <BottomSheet title={t('mobile.chat.attachmentSourceTitle')} onClose={() => setAttachmentSourceOpen(false)}>
          <div className="flex flex-col" data-testid="attachment-source-sheet">
            {nativeCapabilities?.camera ? (
              <button
                type="button"
                data-testid="attachment-source-camera"
                onClick={() => {
                  setAttachmentSourceOpen(false);
                  void chat.pickAttachments('camera');
                }}
                className="min-h-[52px] border-b border-[var(--border-color)] px-1 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
              >
                {t('mobile.chat.attachmentSourceCamera')}
              </button>
            ) : null}
            {nativeCapabilities?.photos ? (
              <button
                type="button"
                data-testid="attachment-source-photos"
                onClick={() => {
                  setAttachmentSourceOpen(false);
                  void chat.pickAttachments('photos');
                }}
                className="min-h-[52px] border-b border-[var(--border-color)] px-1 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
              >
                {t('mobile.chat.attachmentSourcePhotos')}
              </button>
            ) : null}
            {nativeCapabilities?.files ? (
              <button
                type="button"
                data-testid="attachment-source-files"
                onClick={() => {
                  setAttachmentSourceOpen(false);
                  void chat.pickAttachments('files');
                }}
                className="min-h-[52px] px-1 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
              >
                {t('mobile.chat.attachmentSourceFiles')}
              </button>
            ) : null}
          </div>
        </BottomSheet>
      ) : null}
      {previewPath ? (
        <MobileArtifactPreview key={previewPath} path={previewPath} onClose={() => setPreviewPath(null)} />
      ) : null}
      <PermissionSheet chat={chat} />
    </div>
  );
}
