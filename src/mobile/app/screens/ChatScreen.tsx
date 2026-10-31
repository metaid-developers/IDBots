import { useCallback, useEffect, useRef, useState } from 'react';
import { Bars3Icon, PlusIcon, PaperAirplaneIcon, PaperClipIcon, FaceSmileIcon, StopIcon } from '@heroicons/react/24/outline';
import MarkdownContent from '@/components/MarkdownContent';
import MobileArtifactPreview from '../components/MobileArtifactPreview';
import CoworkPermissionPanel from '@/components/cowork/CoworkPermissionPanel';
import { coworkAttachmentAdmission } from '@/components/cowork/coworkComposerAttachments';
import ChatComposerAttachments from '../components/ChatComposerAttachments';
import { EmojiPickerPanel, rememberRecentEmoji } from '../components/EmojiPickerPanel';
import { insertEmojiAtCaret } from '../chat/emojiTextInsert';
import { mapWechatBracketCodesForDisplay } from '../chat/wechatEmojiDisplay';
import TwemojiText from '@/components/chat/TwemojiText';
import { t } from '../../i18n';
import type { MockMetabot } from '../../bridge/types';
import type { useChat } from '../hooks/useChat';
import type { ChatMessageView } from '../chatProjection';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import { useNativeBackHandler } from '../hooks/useNativeBackHandler';
import { BottomSheet } from '../components/BottomSheet';
import { BotAvatar } from '../components/BotAvatar';
import { groupSessionsByDay, resolveSessionBot } from '../sessionList';
import { sortBotsForList } from '../botList';
import { useVoiceInput } from '../voice/useVoiceInput';
import { VoiceButton, VoiceErrorBanner } from '../voice/VoiceButton';

type Chat = ReturnType<typeof useChat>;

const GROUP_LABEL_KEYS = {
  today: 'mobile.chat.group.today',
  yesterday: 'mobile.chat.group.yesterday',
  earlier: 'mobile.chat.group.earlier',
} as const;

function SessionDrawer(props: { chat: Chat; bots: MockMetabot[]; open: boolean; onPickBot: () => void; onClose: () => void }): JSX.Element | null {
  const { chat, bots } = props;
  useNativeBackHandler(() => {
    props.onClose();
    return true;
  }, props.open, 100);
  if (!props.open) return null;
  const groups = groupSessionsByDay(chat.sessions);
  return (
    <div className="fixed inset-0 z-30">
      <button type="button" aria-label={t('mobile.common.close')} className="absolute inset-0 bg-black/40" onClick={props.onClose} tabIndex={-1} />
      <div className="absolute bottom-0 left-0 top-0 flex w-[85%] max-w-[320px] flex-col bg-[var(--bg-panel)]">
        <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('mobile.chat.drawerTitle')}</h2>
          <button
            type="button"
            onClick={() => {
              props.onPickBot();
            }}
            data-testid="session-new-chat"
            className="flex min-h-[44px] items-center gap-1 px-2 text-sm text-[var(--text-secondary)] active:text-[var(--text-primary)]"
          >
            <PlusIcon className="h-4 w-4" aria-hidden />
            {t('mobile.chat.newChat')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="session-drawer-list">
          {groups.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--text-secondary)]">{t('mobile.chat.drawerEmpty')}</p>
          ) : (
            groups.map((group) => (
              <section key={group.key}>
                <p
                  className="sticky top-0 bg-[var(--bg-panel)] px-4 py-1.5 text-xs font-medium text-[var(--text-secondary)]"
                  data-testid={`session-group-${group.key}`}
                >
                  {t(GROUP_LABEL_KEYS[group.key])}
                </p>
                {group.sessions.map((session) => {
                  const bot = resolveSessionBot(chat.sessions, session.id, null, bots);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => {
                        void chat.openSession(session.id);
                        props.onClose();
                      }}
                      className={`block w-full min-h-[52px] border-b border-[var(--border-color)] px-4 py-2 text-left text-sm active:bg-[var(--bg-hover)] ${
                        session.id === chat.sessionId ? 'bg-[var(--bg-hover)]' : ''
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <BotAvatar name={bot.name} avatar={bot.avatar} size={32} testId={`session-bot-avatar-${session.id}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            {session.status === 'running' ? <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" aria-hidden /> : null}
                            <span className="truncate text-[var(--text-primary)]">{session.title}</span>
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </div>
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

function MessageRow({ message, onOpenFile }: { message: ChatMessageView; onOpenFile: (filePath: string) => boolean }): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="mb-3 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--color-primary)] px-3.5 py-2.5 text-[15px] text-black" data-testid="chat-user-message">
          {/* Display-only mapping (wechatEmojiDisplay.ts); catalog emoji
              render as bundled Twemoji images (alt = codepoint). */}
          <TwemojiText text={mapWechatBracketCodesForDisplay(message.text)} />
        </div>
      </div>
    );
  }
  if (message.role === 'error') {
    return (
      <div className="mb-3 flex justify-start">
        <div className="w-full whitespace-pre-wrap break-words rounded-2xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700" data-testid="error-bubble">
          {/* Display-only mapping (wechatEmojiDisplay.ts); catalog emoji
              render as bundled Twemoji images (alt = codepoint). Same
              display convention as the user/assistant bubbles. */}
          <TwemojiText text={mapWechatBracketCodesForDisplay(messageText(message))} />
        </div>
      </div>
    );
  }
  if (message.role === 'system') {
    return (
      <div className="mb-3 flex justify-start">
        <div className="w-full whitespace-pre-wrap break-words rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]" data-testid="system-notice">
          {/* Display-only mapping (wechatEmojiDisplay.ts); catalog emoji
              render as bundled Twemoji images (alt = codepoint). Same
              display convention as the user/assistant bubbles. */}
          <TwemojiText text={mapWechatBracketCodesForDisplay(messageText(message))} />
        </div>
      </div>
    );
  }
  return (
    <div className="mb-3 flex justify-start">
      <div className="max-w-[90%] rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3.5 py-2.5">
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
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // Refs (caret notes: emojiTextInsert.ts).
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const keyboardInset = useKeyboardInset();
  const headerBot = resolveSessionBot(chat.sessions, chat.sessionId, chat.metabotId, bots);
  const draft = chat.draft ?? '';
  const attachments = chat.attachments ?? [];
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

  // Voice input (voice P0, subtask #10): tap-to-toggle mic button beside the
  // composer; streaming partials backfill the draft at the caret and finals
  // replace the trailing partial (Doubao-style). The hook owns capture +
  // socket + state machine; this screen only supplies the draft seam.
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
  });

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat.messages, chat.isStreaming]);
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

  const submit = () => {
    if (!canSubmit) return;
    void chat.send(draft, attachments);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A2 (UE rework 2026-10-29): the in-conversation MetaBot switcher tab
          strip is gone — a conversation belongs to exactly one Bot, so the
          header is just that Bot's avatar next to the title. Bots are chosen
          when STARTING a conversation (drawer → New chat → picker). */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-panel)] px-2 py-1.5">
        <button type="button" onClick={() => setDrawerOpen(true)} aria-label={t('mobile.chat.drawerTitle')} className="flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-primary)] active:bg-[var(--bg-hover)]">
          <Bars3Icon className="h-6 w-6" aria-hidden />
        </button>
        <BotAvatar name={headerBot.name} avatar={headerBot.avatar} size={32} testId="chat-header-avatar" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--text-primary)]" data-testid="chat-header-title">
          {chat.sessionTitle ?? t('mobile.chat.title')}
        </h1>
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

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {chat.hasMoreHistory ? (
          <button type="button" onClick={() => void chat.loadEarlierMessages()} className="mb-3 min-h-[36px] w-full rounded-lg border border-[var(--border-color)] text-xs text-[var(--text-secondary)]">
            {t('mobile.chat.loadEarlier')}
          </button>
        ) : null}
        {chat.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-base font-semibold text-[var(--text-primary)]">
              {chat.restoring ? t('mobile.common.loading') : t('mobile.chat.emptyTitle')}
            </p>
            {!chat.restoring ? <p className="text-sm text-[var(--text-secondary)]">{t('mobile.chat.emptyBody')}</p> : null}
          </div>
        ) : (
          chat.messages.map((message) => <MessageRow key={message.id} message={message} onOpenFile={openPreview} />)
        )}
        {turnPhase !== 'idle' && turnPhase !== 'completed' ? (
          <p className="px-2 py-1 text-xs text-[var(--text-secondary)]" data-testid="turn-phase">
            {t(`mobile.chat.phase.${turnPhase}`)}
          </p>
        ) : null}
      </div>

      {chat.pendingPermissionCount > 0 && !chat.permission ? (
        <button type="button" onClick={chat.reopenPermissions} className="mx-3 mb-2 min-h-[44px] rounded-xl border border-[var(--color-primary)] px-3 text-sm text-[var(--text-primary)]">
          {t('mobile.chat.actionRequired', { count: chat.pendingPermissionCount })}
        </button>
      ) : null}

      <ToolCallList chat={chat} />

      {chat.quotaExhausted ? (
        <div className="mx-3 mb-2 rounded-2xl border border-amber-300 bg-amber-50 p-3" data-testid="quota-card">
          <p className="text-sm font-semibold text-amber-800">
            {t(chat.quotaKind === 'purchased' ? 'mobile.chat.quotaTitlePurchased' : 'mobile.chat.quotaTitleFree')}
          </p>
          <p className="mb-2 text-sm text-amber-700">
            {t(chat.quotaKind === 'purchased' ? 'mobile.chat.quotaBodyPurchased' : 'mobile.chat.quotaBodyFree')}
          </p>
          <div className="flex gap-2">
            {props.rechargeAllowed !== false ? (
              <button type="button" onClick={props.onOpenRecharge} className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-black active:opacity-80">
                {t('mobile.chat.quotaRecharge')}
              </button>
            ) : null}
            <button type="button" onClick={chat.dismissQuota} className="min-h-[44px] rounded-xl border border-amber-300 px-3 py-2 text-sm text-amber-800 active:bg-amber-100">
              {t('mobile.chat.quotaDismiss')}
            </button>
          </div>
        </div>
      ) : null}

      <SubmissionStatus chat={chat} />

      <div className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-panel)] px-3 pt-2" style={{ paddingBottom: `calc(max(env(safe-area-inset-bottom), ${keyboardInset}px) + 8px)` }}>
        {emojiPanelOpen ? (
          <EmojiPickerPanel onSelect={insertEmoji} onClose={() => setEmojiPanelOpen(false)} />
        ) : null}
        <ChatComposerAttachments chat={chat} />
        <VoiceErrorBanner state={voice.state} onDismiss={voice.dismissError} />
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => setEmojiPanelOpen((open) => !open)}
            aria-label={t('mobile.chat.emojiPicker')}
            aria-expanded={emojiPanelOpen}
            aria-haspopup="dialog"
            aria-controls="mobile-chat-emoji-panel"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-[var(--border-color)] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            <FaceSmileIcon className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => void chat.pickAttachments()}
            disabled={!canAttach}
            aria-label={t('mobile.chat.addAttachment')}
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-[var(--border-color)] text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <PaperClipIcon className="h-5 w-5" aria-hidden />
          </button>
          <VoiceButton state={voice.state} elapsedSec={voice.elapsedSec} onStart={voice.start} onStop={voice.stop} />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => chat.setDraft(event.target.value)}
            onFocus={() => setEmojiPanelOpen(false)}
            placeholder={t('mobile.chat.composerPlaceholder')}
            rows={1}
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none"
          />
          {chat.isStreaming ? (
            <button
              type="button"
              onClick={() => void chat.stop()}
              disabled={turnPhase === 'stopping'}
              aria-label={t('mobile.chat.stop')}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-red-100 px-3 text-red-700 active:bg-red-200 disabled:opacity-40"
            >
              <StopIcon className="h-5 w-5" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            aria-label={t('mobile.chat.send')}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-[var(--color-primary)] px-3 text-black active:opacity-80 disabled:opacity-40"
          >
            <PaperAirplaneIcon className="h-5 w-5" aria-hidden />
          </button>
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
      {previewPath ? (
        <MobileArtifactPreview key={previewPath} path={previewPath} onClose={() => setPreviewPath(null)} />
      ) : null}
      <PermissionSheet chat={chat} />
    </div>
  );
}
