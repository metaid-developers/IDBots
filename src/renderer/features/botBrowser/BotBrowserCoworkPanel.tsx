import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import { CpuChipIcon, FolderIcon } from '@heroicons/react/24/outline';
import MarkdownContent from '../../components/MarkdownContent';
import CoworkPromptInput, { type CoworkPromptInputRef } from '../../components/cowork/CoworkPromptInput';
import { UserMessageBody } from '../../components/cowork/UserAttachmentBody';
import { resolveLocalPathAgainstCwd, type LocalFilePathResolver } from '../../utils/localPath';
import { buildLocalPreviewUri } from './localPreviewUri';
import { buildSessionComposerCommands } from '../../components/cowork/composerCommandCatalog';
import FolderSelectorPopover from '../../components/cowork/FolderSelectorPopover';
import type { MetaBotForSelector } from '../../components/cowork/MetaBotSelector';
import ModelEffortPicker from '../../components/ModelEffortPicker';
import { effortDisplayForPick, effortForSessionStart, type ComposerModelEffortPick } from '../../services/modelCatalog';
import { ActiveSkillBadge } from '../../components/skills';
import { RootState } from '../../store';
import { clearActiveSkills } from '../../store/slices/skillSlice';
import { browserCoworkService } from '../../services/browserCowork';
import { coworkService } from '../../services/cowork';
import { sessionTabBinding } from '../../services/sessionTabBinding';
import { useChatExperienceMode } from '../../hooks/useChatExperienceMode';
import { isAssistantModeOwnerChatSession } from '../../components/cowork/assistantModeSessionGate';
import { AssistantActivityIndicator } from '../../components/cowork/AssistantActivityIndicator';
import { projectsService } from '../../services/projects';
import { i18nService } from '../../services/i18n';
import { subscribeMetabotsChanged } from '../../services/metabotEvents';
import { getCompactFolderName } from '../../utils/path';
import type { CoworkMessage, CoworkWorkspaceSelection } from '../../types/cowork';
import BotPickerChip from './BotPickerChip';
import CoworkSurfaceIdentityBadge from './CoworkSurfaceIdentityBadge';
import { resolveDefaultMetabotId } from '../../services/coworkSessionStart';
import { elementSelectionsStore } from './elementSelectionsStore';
import CoworkHistoryPanel from './CoworkHistoryPanel';
import { formatPanelMessageTimestamp, isPanelMessageGroupEnd } from './panelMessageTimestamp';
import {
  applyPanelReactionToggle,
  getPanelReactionsStorage,
  readPanelReactionsForSession,
  writePanelReaction,
  type PanelReactionRating,
} from './panelMessageReactions';
import {
  isPointerOutsideContextMenu,
  resolveContextMenuPlacement,
} from './panelContextMenuGeometry';
import PanelMessageContextMenu from './PanelMessageContextMenu';
import PanelMessageLocatorRail from './PanelMessageLocatorRail';
import { buildPanelLocatorRows } from './panelMessageLocator';
import { createMessageQuotedSelection, parseSentQuoteBlock, parseSentSelectionQuoteBlock } from '../../components/cowork/coworkQuotedSelections';
import { buildSentQuoteDisplaySources, buildSentSelectionQuoteLabelSets, transientHighlight, QUOTE_JUMP_HIGHLIGHT_MS } from '../../components/cowork/CoworkSessionDetail';
import { resolveBubbleSelectedText } from './panelBubbleSelection';

type PanelMetabot = MetaBotForSelector & { llm_id?: string | null; llm_provider?: string | null; llm_effort?: string | null };

/**
 * Minimal rendering contract for the side panel: user messages and final
 * agent answers only. Tool calls, tool results, system messages, thinking
 * blocks, and delegation-internal chatter are intentionally hidden.
 */
export function filterVisiblePanelMessages(messages: CoworkMessage[]): CoworkMessage[] {
  return messages.filter((message) => {
    if (message.metadata?.isDelegationInternal) return false;
    if (message.type === 'user') return true;
    if (message.type === 'assistant') return !message.metadata?.isThinking;
    return false;
  });
}

/**
 * Draft-state identity for the assistant-mode gate: the next session started
 * from this panel is a Bot Internet projector session (browserCoworkService
 * stamps the per-session assistantMode marker), so the empty chat already
 * renders assistant-side before any session exists.
 */
const PROJECTOR_DRAFT_SESSION_IDENTITY = {
  sessionType: 'browser' as const,
  autoOrigin: null,
  assistantMode: true,
};

export const PanelMessage: React.FC<{
  message: CoworkMessage;
  onOpenUri: (uri: string) => void;
  isAssistantMode?: boolean;
  resolveLocalFilePath?: LocalFilePathResolver;
  /** Intercepts local file opens; a true return means the click was handled. */
  onOpenLocalFile?: (filePath: string, event: React.MouseEvent) => boolean | void;
  /** Meta-line stamp, pre-formatted (`HH:mm` / `MM-DD HH:mm`, '' = omit). */
  timestampLabel?: string;
  /**
   * Contract-stability flag (owner rulings 2026-11-11: fix ② unified, the
   * 14:07 rework narrowed again). The gate is retired TWICE over: the stamp
   * decision now lives entirely in `timestampLabel`, which the parent computes
   * with the same assistant&&group-end expression this flag carries. Kept in
   * the component contract (the parent still passes it verbatim and the wiring
   * guards pin the formula); do not read it for stamp decisions.
   */
  showTimestamp?: boolean;
  /**
   * The session bot's name: names the speaker on the pending reply card and
   * in a sent quote's inline display label (main-transcript mapping). Null
   * falls back to the i18n placeholder.
   */
  botName?: string | null;
  /** This bubble's stored reaction (local MVP; null = none). */
  currentReaction?: PanelReactionRating | null;
  /** Right-click on the bubble chrome opens the panel context menu. */
  onContextMenu?: (event: React.MouseEvent, message: CoworkMessage) => void;
  /** Chip click toggles the reaction (re-click on the active side cancels). */
  onToggleReaction?: (message: CoworkMessage, current: PanelReactionRating | null) => void;
}> = ({
  message,
  onOpenUri,
  isAssistantMode = false,
  resolveLocalFilePath,
  onOpenLocalFile,
  timestampLabel,
  // showTimestamp stays in the contract but is deliberately NOT destructured:
  // stamp decisions ride timestampLabel alone (the parent gates it with the
  // assistant&&group-end formula; see the prop doc above).
  botName = null,
  currentReaction = null,
  onContextMenu,
  onToggleReaction,
}) => {
  const isUser = message.type === 'user';
  const handleBubbleContextMenu = (event: React.MouseEvent) => {
    if (!onContextMenu) return;
    // Own menu replaces the browser's; stopPropagation keeps ancestor
    // surfaces (iframe hosts, transcript chrome) from also opening theirs.
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(event, message);
  };
  // In-bubble stamp (owner rulings 2026-11-11: fix ② moved it INSIDE the
  // bubble's bottom-right corner, superseding pass #5 ③④'s external meta
  // line; the 14:07 rework narrowed WHO carries it — only the last bubble
  // of a consecutive assistant group, user rows never). Which bubble
  // qualifies is the parent's call: it hands down a pre-gated
  // `timestampLabel`, so an absent label means no stamp at all.
  // Sixth item (owner ruling 2026-11-11 14:45): the reaction chip moved
  // INSIDE the bubble too — one in-bubble footer row hugging the bubble's
  // bottom-right corner, chip LEFT of the stamp; the old external chip row
  // (the former meta row) is gone for good. The chip's own interactions
  // (click toggle, hover fade, toggle params) are byte-identical.
  const hasReactionChip = Boolean(currentReaction && onToggleReaction);
  // The stamp itself: same `HH:mm` / `MM-DD HH:mm` formatting as before,
  // right-aligned by the footer row so long content wraps ABOVE it and the
  // stamp never overlays text. An empty label (non-finite/pre-epoch clock)
  // renders no stamp at all.
  const bubbleStamp = timestampLabel ? (
    <span
      data-panel-message-timestamp="true"
      className="select-none text-[10px] leading-3 dark:text-claude-darkTextSecondary text-claude-textSecondary"
    >
      {timestampLabel}
    </span>
  ) : null;
  // The in-bubble footer: chip left, stamp right, the pair flush with the
  // bubble's bottom-right corner (`justify-end`; with no chip the stamp
  // alone keeps the exact pre-sixth-item right-aligned geometry). Mounts
  // only while at least one of the two exists — no reserved slot.
  const bubbleFooter = hasReactionChip || bubbleStamp ? (
    <div data-slot="panel-bubble-footer" className="mt-1 flex items-center justify-end gap-1.5">
      {/* The inline conditional keeps the reaction wiring literal the
          reactions guards pin (PurityWiring ③). */}
      {currentReaction && onToggleReaction ? (
        <button
          type="button"
          data-panel-reaction-chip={currentReaction}
          onClick={() => onToggleReaction(message, currentReaction)}
          className="rounded-full border border-current/20 px-1.5 py-px text-[10px] leading-3 transition-opacity hover:opacity-70 dark:text-claude-darkTextSecondary text-claude-textSecondary"
        >
          {currentReaction === 'up' ? '👍' : '👎'}
        </button>
      ) : null}
      {bubbleStamp}
    </div>
  ) : null;
  if (isUser) {
    // Sent quotes keep the ORIGINAL inline style — one bubble, quote flowing
    // above the reply (owner ruling 2026-11-11, after the Telegram card read
    // as a separate block) — but the label line shows the REAL speaker via
    // the main transcript's WeChat-style mapping (`你：` / `Monday：`),
    // not the machine label ("#152 助手消息："). Display-only: the stored
    // body stays verbatim for the model; hand-written blockquotes never
    // match the generated form and render untouched.
    const sentQuote = parseSentQuoteBlock(message.content, buildSentQuoteDisplaySources(botName));
    const sentSelectionQuote = sentQuote
      ? null
      : parseSentSelectionQuoteBlock(message.content, buildSentSelectionQuoteLabelSets(botName));
    const sentQuoteBlock = sentQuote?.block ?? sentSelectionQuote?.block ?? null;
    const sentQuoteRest = sentQuote?.rest ?? sentSelectionQuote?.rest ?? null;
    const displayContent = sentQuoteBlock
      ? [sentQuoteBlock, sentQuoteRest].filter(Boolean).join('\n\n')
      : message.content;
    const bubbleClassName = "max-w-[90%] min-w-0 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text shadow-subtle";
    return (
      // data-panel-message-id lets the locator rail measure this row
      // (purity pass #2 ③) without touching the bubble chrome.
      <div data-panel-message-id={message.id} className="flex flex-col items-end">
        <div onContextMenu={handleBubbleContextMenu} className={bubbleClassName}>
          {/* Same display-side body pipeline as the main cowork transcript:
              the attachment marker lines split out at render time, image
              files render as the shared thumbnail strip with the in-app
              lightbox, and the rest renders as markdown. The panel keeps
              its own bubble chrome. */}
          <UserMessageBody content={displayContent} resolveLocalFilePath={resolveLocalFilePath} />
          {bubbleFooter}
        </div>
      </div>
    );
  }
  if (message.type !== 'assistant' || !message.content.trim()) return null;
  if (isAssistantMode) {
    // Assistant mode aligns the panel with the main cowork chat: bot answers
    // (narration and final alike) sit in the neutral-gray .assistant-bubble
    // instead of bare full-width text, so both surfaces read the same way.
    return (
      <div data-panel-message-id={message.id} className="flex min-w-0 flex-col items-start">
        <div
          onContextMenu={handleBubbleContextMenu}
          className="assistant-bubble w-fit max-w-[92%] rounded-[22px] px-[16px] py-[10px] text-[13px] leading-5 dark:text-claude-darkText text-claude-text shadow-subtle [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all"
        >
          <MarkdownContent
            content={message.content}
            compact
            onOpenBotBrowserUri={onOpenUri}
            resolveLocalFilePath={resolveLocalFilePath}
            onOpenLocalFile={onOpenLocalFile}
            emojiImages
          />
          {bubbleFooter}
        </div>
      </div>
    );
  }
  return (
    <div data-panel-message-id={message.id} className="flex min-w-0 flex-col items-start text-[13px] leading-5 dark:text-claude-darkText text-claude-text [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all">
      <div onContextMenu={handleBubbleContextMenu} className="min-w-0">
        <MarkdownContent
          content={message.content}
          compact
          onOpenBotBrowserUri={onOpenUri}
          resolveLocalFilePath={resolveLocalFilePath}
          onOpenLocalFile={onOpenLocalFile}
          emojiImages
        />
        {bubbleFooter}
      </div>
    </div>
  );
};

interface BotBrowserCoworkPanelProps {
  onShowSkills?: () => void;
  /** Open Settings > Projects > New Project (from the workspace popover). */
  onOpenNewProject?: () => void;
  /** Switch the sidebar back to BotWorks (no-Twin bootstrap guidance). */
  onOpenBotHome?: () => void;
  /**
   * Session-records overlay state (owner spec 2026-11-08 21:31). The records
   * toggle lives in the shared surface header bar — beside the surface pill,
   * where the owner's screenshot puts it — so the panel receives the open
   * state and its setter. Both are optional: a standalone mount keeps the
   * previous internal toggle.
   */
  historyOpen?: boolean;
  onHistoryOpenChange?: (open: boolean) => void;
}

const WORKSPACE_SELECTION_STORAGE_KEY = 'idbots.botBrowser.workspaceSelection';

const parsePersistedWorkspaceSelection = (raw: string | null): CoworkWorkspaceSelection | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CoworkWorkspaceSelection>;
    if (parsed.kind === 'botWorkspace') return { kind: 'botWorkspace' };
    if (parsed.kind === 'folder' && typeof parsed.cwd === 'string' && parsed.cwd.trim()) {
      return { kind: 'folder', cwd: parsed.cwd };
    }
    if (parsed.kind === 'project'
      && typeof parsed.projectId === 'string' && parsed.projectId.trim()
      && typeof parsed.name === 'string') {
      return {
        kind: 'project',
        projectId: parsed.projectId,
        name: parsed.name,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      };
    }
  } catch {
    // Malformed stored value: fall through to no selection.
  }
  return null;
};

function loadPersistedWorkspaceSelection(): CoworkWorkspaceSelection | null {
  try {
    return parsePersistedWorkspaceSelection(window.localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Co-Work chat panel embedded in the Bot Internet sidebar. Stays mounted for
 * Bot Browser, Bot Hub, and Meta Apps so the same panel can drive those pages.
 * Talks to the local Agent through
 * `browserCoworkService`; the Agent controls the browser via bot_browser_*
 * tools. Rendering is intentionally minimal: user messages and final agent
 * answers only — tool calls, thinking, and system noise stay out of view.
 * History is a toggleable overlay; sessions remember the browser URI they
 * were about.
 */
const BotBrowserCoworkPanel: React.FC<BotBrowserCoworkPanelProps> = ({
  onShowSkills,
  onOpenNewProject,
  onOpenBotHome,
  historyOpen,
  onHistoryOpenChange,
}) => {
  const dispatch = useDispatch();
  const currentSession = useSelector((state: RootState) => state.browserCowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.browserCowork.isStreaming);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  // Controlled by the shared surface header bar when the parent passes it; a
  // standalone mount (tests, future hosts) falls back to an internal toggle.
  const [internalShowHistory, setInternalShowHistory] = useState(false);
  const showHistory = historyOpen ?? internalShowHistory;
  const setShowHistory = useCallback(
    (next: boolean) => {
      if (onHistoryOpenChange) onHistoryOpenChange(next);
      else setInternalShowHistory(next);
    },
    [onHistoryOpenChange],
  );
  const [metabots, setMetabots] = useState<PanelMetabot[]>([]);
  const [metabotsLoaded, setMetabotsLoaded] = useState(false);
  // Workspace choice for the next browser session, same selection model as the
  // cowork home composer (project / folder / bot workspace); the popover is
  // the shared project-mode FolderSelectorPopover. The last choice is
  // remembered per surface (own localStorage key — deliberately NOT the
  // cowork config's lastWorkspaceSelection, which belongs to the home
  // composer).
  const [workspaceSelection, setWorkspaceSelection] = useState<CoworkWorkspaceSelection | null>(() =>
    loadPersistedWorkspaceSelection()
  );
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  // Bot picker (owner 18:21 final ruling 2026-11-11, item ⑦ rework): the
  // identity chip moved UP from this composer's top-left row into the shared
  // surface-header actions row (Sidebar's Studio branch). The draft chip is
  // still the bot picker — picking a bot selects which bot runs the NEXT
  // conversation, the same pure selection as the BotWorks new-task bot
  // picker. It never writes metabot_type (the Twin appointment is owned by
  // the My Bots editor alone), so picking a worker bot never appoints it
  // Twin, not even temporarily. The chip is DRAFT-ONLY: a live session
  // never changes actors mid-flight, so its header identity is the
  // read-only CoworkSurfaceIdentityBadge instead (portal below). The picker
  // state stays owned HERE — only the DOM placement moved (portal).
  const [showBotPickerMenu, setShowBotPickerMenu] = useState(false);
  const [pickedMetabotId, setPickedMetabotId] = useState<number | null>(null);
  // The surface-header identity anchor (owner 18:21 final ruling): the
  // Sidebar's Studio actions row mounts
  // `<div data-slot="cowork-header-identity-anchor">` as the row's FIRST
  // lane — ahead of the session-name slot — and this panel portals the
  // identity component into it (draft: BotPickerChip; live session:
  // CoworkSurfaceIdentityBadge). Queried after mount: the header commits in the
  // same tree as this panel, so the anchor is in the document by the time
  // effects run. Standalone mounts (tests, future hosts without the shared
  // header) find no anchor and simply don't render the chip.
  const [identityAnchorEl, setIdentityAnchorEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setIdentityAnchorEl(document.querySelector<HTMLElement>('[data-slot="cowork-header-identity-anchor"]'));
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  const folderButtonRef = useRef<HTMLButtonElement>(null);

  // ── Bubble context menu + reactions (purity pass #1, 2026-11-10) ─────────
  // The chat surface stays clean: no persistent furniture. Everything a bubble
  // can do lives behind its right-click menu (react up/down, quote reply,
  // copy text), mounted only while open. Reactions are a localStorage MVP —
  // no backend model exists yet; the upgrade path is documented in
  // panelMessageReactions.ts.
  interface PanelContextMenuState {
    message: CoworkMessage;
    x: number;
    y: number;
    /**
     * Non-empty text selected INSIDE this bubble at open time (pass #4), else
     * null. When set, quote-reply and copy act on the fragment; 👍👎 ignore it.
     */
    selectedText: string | null;
    /** The bubble element that opened the menu (kept open on re-clicks there). */
    opener: HTMLElement | null;
  }
  const [contextMenu, setContextMenu] = useState<PanelContextMenuState | null>(null);
  const [panelReactions, setPanelReactions] = useState<Record<string, PanelReactionRating>>({});
  const panelMenuRef = useRef<HTMLDivElement>(null);
  // Latest-menu mirror for the capture-phase listeners (they close over the
  // ref, not the state, so re-opening with a new message cannot pin a stale one).
  const contextMenuRef = useRef<PanelContextMenuState | null>(null);
  useEffect(() => {
    contextMenuRef.current = contextMenu;
  }, [contextMenu]);

  const sessionId = currentSession?.id ?? null;
  // Sweep the session's stored ratings when the session (or the mount) changes;
  // runtime menu/chip updates go through setPanelReactions directly.
  useEffect(() => {
    if (!sessionId) {
      setPanelReactions({});
      return;
    }
    setPanelReactions(readPanelReactionsForSession(getPanelReactionsStorage(), sessionId));
  }, [sessionId]);

  const handlePanelContextMenu = useCallback((event: React.MouseEvent, message: CoworkMessage) => {
    // Capture the live selection FIRST (pass #4): at contextmenu time Chromium
    // still holds it (select-then-right-click), and this handler is the only
    // reliable moment. A selection spanning another bubble, or living outside
    // this one, resolves to null — the menu then treats the WHOLE message.
    const bubble = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const selectedText = resolveBubbleSelectedText(
      selection?.anchorNode ?? null,
      selection?.focusNode ?? null,
      selection ? selection.toString() : '',
      bubble,
    );
    const placement = resolveContextMenuPlacement(event.clientX, event.clientY, {
      width: typeof window !== 'undefined' ? window.innerWidth : 0,
      height: typeof window !== 'undefined' ? window.innerHeight : 0,
    });
    setContextMenu({
      message,
      x: placement.x,
      y: placement.y,
      selectedText,
      opener: bubble,
    });
  }, []);

  // Menu react row (chips share the toggle): re-picking the active side
  // cancels; picking the other side switches. Single-choice, local-only.
  const handleMenuReact = useCallback((rating: PanelReactionRating) => {
    const menu = contextMenuRef.current;
    if (!menu || !sessionId) return;
    const { id: messageId } = menu.message;
    setPanelReactions((prev) => {
      const nextRating = applyPanelReactionToggle(prev[messageId] ?? null, rating);
      const next = { ...prev };
      if (nextRating === null) delete next[messageId];
      else next[messageId] = nextRating;
      writePanelReaction(getPanelReactionsStorage(), sessionId, messageId, nextRating);
      return next;
    });
  }, [sessionId]);

  // Chip click: the chip only renders while a rating is active, so clicking it
  // always cancels.
  const handleToggleReaction = useCallback((message: CoworkMessage) => {
    if (!sessionId) return;
    setPanelReactions((prev) => {
      if (!prev[message.id]) return prev;
      const next = { ...prev };
      delete next[message.id];
      writePanelReaction(getPanelReactionsStorage(), sessionId, message.id, null);
      return next;
    });
  }, [sessionId]);

  // Copy the selected fragment VERBATIM when the menu opened on one (pass #4),
  // else the RAW message text (the stored markdown, not the rendered prose).
  const handleMenuCopyText = useCallback(() => {
    const menu = contextMenuRef.current;
    if (!menu) return;
    const raw = menu.selectedText ?? menu.message.content;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(raw);
      }
    } catch {
      // Clipboard unavailable (permissions): menu still closes; nothing to show.
    }
  }, []);

  // Close channels while the menu is open (capture phase, bound only while
  // open): a pointerdown outside the menu, Escape, and any scroll (the
  // scroll listener catches the panel list and ancestor scrollers).
  //
  // Opener-bubble demotion (owner ruling 2026-11-11, four-item fix ④): the
  // geometry helper's contract keeps the OPENING BUBBLE alive on pointerdown;
  // the ruling demotes it — a plain click anywhere inside the bubble now
  // dismisses too, while clicks inside the MENU box still keep it alive (the
  // menu rows dismiss via their own onDismiss after acting). Re-right-clicking
  // the bubble re-opens/re-positions through the contextmenu channel: button
  // 2 never reaches the dismiss path, so there is no dismiss-then-open flash.
  useEffect(() => {
    if (!contextMenu) return undefined;
    const dismiss = () => setContextMenu(null);
    const handlePointerDown = (event: PointerEvent) => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      if (event.button === 2) return;
      if (!isPointerOutsideContextMenu(panelMenuRef.current, menu.opener, event.target)) {
        if (menu.opener?.contains(event.target as Node)) dismiss();
        return;
      }
      dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [contextMenu]);

  // Twin welcome page (owner rulings 2026-11-09: the Studio face is the
  // twin's office — its landing invites like a friend, not a feature tour;
  // the copy set is finalized in i18n and mirrored zh/en). The 缩略态定稿
  // same-day ruling retires the width-derived expanded variant: the welcome
  // renders ONE fixed compact form (name row + invitation + sub line), with
  // no width state that could disagree with the seam.

  const browserSessions = useMemo(
    () => sessions.filter((session) => session.sessionType === 'browser'),
    [sessions]
  );

  const messages = currentSession?.messages ?? [];
  const visibleMessages = useMemo(
    () => filterVisiblePanelMessages(messages),
    [messages]
  );

  // Quote reply goes through the exact CoworkSessionDetail path: a whole-message
  // quoted fragment into the composer's single-target slot — the chip above the
  // composer, the remove affordance and the send composition are all the shared
  // CoworkPromptInput machinery. The ordinal is the panel's own rendered
  // position (filterVisiblePanelMessages order, 1-based), matching what the
  // panel actually displayed at capture time. NOTE (MVP boundary): the
  // quotedMessageIds jump anchor is NOT persisted on this panel's sends —
  // browserCoworkService.send sits outside this delegation's writable paths;
  // the quoted TEXT still travels inside the composed prompt exactly as on the
  // BotWorks side. (Future IPC upgrade: pass quotedMessageIds through send.)
  const handleMenuQuoteReply = useCallback(() => {
    const menu = contextMenuRef.current;
    if (!menu) return;
    const { message } = menu;
    // Selection-aware (pass #4): a fragment captured inside this bubble quotes
    // the FRAGMENT through the same factory (createQuotedSelection trims and
    // caps it at QUOTED_SELECTION_MAX_CHARS); no selection quotes the whole
    // message, as before. The messageRef jump anchor stays the bubble either way.
    const content = menu.selectedText ?? message.content;
    const ordinal = visibleMessages.findIndex((candidate) => candidate.id === message.id) + 1;
    const fragment = createMessageQuotedSelection({
      content,
      role: message.type === 'user' ? 'user' : message.type === 'assistant' ? 'assistant' : 'other',
      messageId: message.id,
      ordinal,
      streaming: message.metadata?.isStreaming === true,
    });
    if (!fragment) return;
    promptInputRef.current?.addQuotedSelection(fragment);
    promptInputRef.current?.focus();
  }, [visibleMessages]);

  const loadMetabots = useCallback(async () => {
    const result = await window.electron?.metabot?.list?.();
    setMetabotsLoaded(true);
    if (!result?.success || !result.list) return;
    // The picker is a roster-level control (owner ruling 2026-11-11): it lists
    // every local bot, so any bot can be picked to run the next conversation.
    setMetabots([...result.list].sort((a, b) => a.id - b.id));
  }, []);

  useEffect(() => {
    void loadMetabots();
  }, [loadMetabots]);

  // Cross-view roster freshness: the My Bots editor and the chain-restore
  // flow can move the same system-wide facts this panel renders (above all
  // `metabot_type`). Re-read the roster when another surface announces a
  // change, so an already-open panel never shows a stale Twin badge.
  useEffect(() => subscribeMetabotsChanged(() => {
    void loadMetabots();
  }), [loadMetabots]);

  const closeBotPickerMenu = useCallback(() => setShowBotPickerMenu(false), []);

  // Picking a bot is a pure local selection (owner ruling 2026-11-11): no IPC
  // write, no toast, no roster change — the next conversation started from
  // this panel simply runs with that bot.
  const handlePickBot = useCallback((target: PanelMetabot) => {
    setPickedMetabotId(target.id);
    setShowBotPickerMenu(false);
  }, []);

  // Remember the workspace choice across panel remounts / app restarts.
  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, JSON.stringify(workspaceSelection));
    } catch {
      // Storage unavailable: the choice stays session-local.
    }
  }, [workspaceSelection]);

  // A persisted project binding survives only while the project still exists
  // (best-effort check; load failures keep the selection).
  const selectedProjectId = workspaceSelection?.kind === 'project' ? workspaceSelection.projectId : null;
  useEffect(() => {
    if (!selectedProjectId) return;
    let cancelled = false;
    void (async () => {
      try {
        const projects = await projectsService.loadProjects();
        if (!cancelled && !projects.some((project) => project.id === selectedProjectId)) {
          setWorkspaceSelection(null);
        }
      } catch {
        // Best-effort validation; keep the selection on load failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  // Which bot runs the next conversation (owner ruling 2026-11-11): the draft
  // state follows the picker — an explicit pick wins, else the Twin, else the
  // first bot (the SAME resolution the BotWorks new-task composer uses, via
  // the shared resolveDefaultMetabotId). Machines without any bot get
  // bootstrap guidance instead of a composer. Live sessions always show and
  // scope to the bot they were started with, so old transcripts read the same
  // as before.
  const selectedMetabotId = resolveDefaultMetabotId(metabots, pickedMetabotId);
  const selectedMetabot = selectedMetabotId != null
    ? metabots.find((m) => m.id === selectedMetabotId) ?? null
    : null;
  const needsBootstrap = metabotsLoaded && metabots.length === 0 && !currentSession;
  const liveSessionMetabot = currentSession?.metabotId != null
    ? metabots.find((m) => m.id === currentSession.metabotId) ?? null
    : null;
  const chipMetabot = currentSession ? (liveSessionMetabot ?? selectedMetabot) : selectedMetabot;
  const effectiveMetabotId = selectedMetabotId;
  // Pending model+effort for the session about to start from this panel. The
  // whole state being null = follow the selected bot's brain (its model and
  // effort); inside a pick, effort null is an EXPLICIT "Default" choice.
  const [pendingModelEffort, setPendingModelEffort] = useState<ComposerModelEffortPick | null>(null);
  // Chat experience mode is overridden in this surface (owner ruling
  // 2026-11-07): every session started here carries the per-session
  // assistantMode marker, so the panel resolves assistant-side for live
  // sessions through the shared gate (isAssistantModeOwnerChatSession —
  // mirrors the backend rule in src/main/libs/coworkRunner.ts) and for the
  // draft state through the projector draft identity. Legacy (pre-marker)
  // browser sessions keep the professional presentation. See
  // useChatExperienceMode for the cross-window reactivity contract.
  const chatExperienceMode = useChatExperienceMode();
  const isAssistantMode = isAssistantModeOwnerChatSession(chatExperienceMode, currentSession ?? PROJECTOR_DRAFT_SESSION_IDENTITY);

  // Slash commands for the '+' menu: browser sessions are regular cowork
  // sessions, so once one is live the full session command set applies; in
  // the draft state the menu simply hides the command item.
  const browserComposerCommands = useMemo(
    () => (currentSession
      ? buildSessionComposerCommands({ sessionId: currentSession.id, goal: currentSession.goal ?? null })
      : []),
    [currentSession],
  );

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [visibleMessages.length, isStreaming]);

  // Locator rail rows (purity pass #2 ③): identity + preview text per
  // visible message; the rail itself decides visibility from overflow, and
  // the transcript's auto-scroll-to-bottom effect above stays untouched.
  const locatorRows = useMemo(
    () => buildPanelLocatorRows(visibleMessages, {
      botName: chipMetabot?.name ?? null,
      userLabel: i18nService.t('coworkOriginBadgeYou'),
    }),
    [visibleMessages, chipMetabot?.name],
  );

  // Locator tick-jump landing cue (owner ruling 2026-11-11, four-item fix ③):
  // clicking a rail tick is "you were taken here", so the target BUBBLE lights
  // the same transient accent ring the main transcript's rail jump and quote
  // jump use — the shared transientHighlight helper, the same ring classes,
  // the same 2.5s window, one timer so rapid jumps never stack rings.
  const locatorHighlightTimerRef = useRef<number | null>(null);
  // Same hardening as the main transcript: the timer holds the element it
  // will un-ring, so drop it on unmount and on session switch instead of
  // letting it fire against a detached node.
  useEffect(() => () => {
    if (locatorHighlightTimerRef.current != null) {
      window.clearTimeout(locatorHighlightTimerRef.current);
      locatorHighlightTimerRef.current = null;
    }
  }, [sessionId]);
  const handleLocatorTickJump = useCallback((messageId: string) => {
    const container = listRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(
      `[data-panel-message-id="${CSS.escape(messageId)}"]`,
    );
    // The bubble chrome is always the row wrapper's first child (the meta
    // row, when present, renders after it), so the ring lands on the bubble
    // itself — never across the whole transcript row.
    const bubble = row?.firstElementChild;
    if (!(bubble instanceof HTMLElement)) return;
    transientHighlight(locatorHighlightTimerRef, container, bubble, QUOTE_JUMP_HIGHLIGHT_MS);
  }, []);

  const handleSubmit = async (prompt: string, skillPrompt?: string) => {
    if (!currentSession && selectedMetabotId == null) return; // botless machines never start sessions here
    setShowHistory(false);
    const captureOutgoingPrompt = async () => {
      // Element-picker capture (ABC v0.10.0): live marks first, then the
      // pre-navigation cache. First sends pass this preparation into start so
      // the optimistic bubble does not wait for the bridge read.
      const markedElementsBlock = await elementSelectionsStore.capturePromptBlock();
      return markedElementsBlock ? `${markedElementsBlock}\n\n${prompt}` : prompt;
    };
    // Pinned-skill snapshot, same contract as the home composer: the ids ride
    // the submitted turn (persisted main-side for the session, driving
    // per-skill env overrides), and the inlined `## Skill:` blocks embed into
    // the system prompt sent WITH that turn. Turns without pins never rewrite
    // the session's persisted prompt, and clearing the pins does not strip
    // blocks embedded by earlier turns. Steer turns carry no skills (the
    // composer already drops the prompt while streaming).
    const skillIds = isStreaming ? [] : [...activeSkillIds];
    const skills = skillIds.length > 0
      ? { prompt: skillPrompt, activeSkillIds: skillIds }
      : undefined;
    if (currentSession) {
      const outgoingPrompt = await captureOutgoingPrompt();
      await browserCoworkService.send(outgoingPrompt, skills);
    } else {
      // Only project/folder selections carry a concrete cwd; bot workspace
      // (and no selection) start in the default bot workspace chain. The
      // projectId binding matters even when cwd is empty: main-side it pins
      // the session to the project (its dir used as-is, no per-bot redirect).
      const startCwd = workspaceSelection
        && (workspaceSelection.kind === 'folder' || workspaceSelection.kind === 'project')
        && workspaceSelection.cwd.trim()
        ? workspaceSelection.cwd.trim()
        : undefined;
      const startProjectId = workspaceSelection?.kind === 'project' ? workspaceSelection.projectId : undefined;
      await browserCoworkService.start(prompt, effectiveMetabotId, startCwd, {
        model: pendingModelEffort?.modelId ?? undefined,
        modelProvider: pendingModelEffort?.providerKey ?? undefined,
        effort: effortForSessionStart(pendingModelEffort),
      }, skills, startProjectId, prompt, captureOutgoingPrompt);
      setPendingModelEffort(null);
    }
    if (skillIds.length > 0) {
      dispatch(clearActiveSkills());
    }
  };

  const handleSelectHistory = async (sessionId: string) => {
    setShowHistory(false);
    await browserCoworkService.loadSession(sessionId);
    await sessionTabBinding.revealSessionTab(sessionId);
  };

  const handleDeleteHistory = async (sessionId: string) => {
    await browserCoworkService.archiveSession(sessionId);
  };

  const handleToggleHistoryPin = async (sessionId: string, pinned: boolean) => {
    await coworkService.setSessionPinned(sessionId, pinned);
  };

  const handleRenameHistory = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
  };

  const handleOpenUri = useCallback((uri: string) => {
    window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
  }, []);

  // Studio panel only: local file links the bot produces open inside the
  // right-side Bot Browser tab instead of a system download/external app —
  // preview-metaapp for app folders and HTML pages, preview-file for every
  // other previewable document. Unpreviewable types return false so the
  // shared markdown link keeps its shell.openPath fallback.
  const handleOpenLocalFile = useCallback((filePath: string) => {
    const uri = buildLocalPreviewUri(filePath);
    if (!uri) return false;
    window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri, newTab: true } }));
    return true;
  }, []);

  // Attachment paths in the panel resolve exactly like the main transcript's:
  // against the session cwd, with sandbox guest paths mapped back to it. No
  // session cwd = no resolver — the splitter's own absolute-path fallback still
  // renders temp-file images, and nothing relative is guessed.
  const resolveLocalFilePath = useMemo<LocalFilePathResolver | undefined>(() => {
    const cwd = currentSession?.cwd?.trim();
    if (!cwd) return undefined;
    const executionMode = currentSession?.executionMode;
    return (href: string, text: string) => resolveLocalPathAgainstCwd(href, text, { cwd, executionMode });
  }, [currentSession?.cwd, currentSession?.executionMode]);

  // (message, index) rides Array.map. Stamp semantics (owner ruling
  // 2026-11-11 14:07, rework narrowing fix ②'s unify-all-bubbles scope): the
  // in-bubble stamp rides ONLY the last bubble of a consecutive assistant
  // group — user bubbles never carry one, and neither does a non-final row
  // inside a group. The assistant&&group-end expression therefore drives the
  // stamp label itself; it stays on showTimestamp verbatim too so the wiring
  // guards keep pinning the same parent formula.
  const renderMessage = (message: CoworkMessage, index: number) => (
    <PanelMessage
      key={message.id}
      message={message}
      onOpenUri={handleOpenUri}
      isAssistantMode={isAssistantMode}
      resolveLocalFilePath={resolveLocalFilePath}
      onOpenLocalFile={handleOpenLocalFile}
      // Same-day `HH:mm`, older days `MM-DD HH:mm` (computed at render,
      // local time) — inside the bubble's bottom-right corner, assistant
      // group-end rows only (owner ruling 2026-11-11 14:07). An empty or
      // withheld label means no stamp at all, so user rows and non-final
      // rows inside a group stay clean.
      timestampLabel={
        message.type === 'assistant' && isPanelMessageGroupEnd(visibleMessages, index)
          ? formatPanelMessageTimestamp(message.timestamp, Date.now())
          : undefined
      }
      showTimestamp={message.type === 'assistant' && isPanelMessageGroupEnd(visibleMessages, index)}
      // The real speaker for the pending card and sent-quote labels (pass
      // #5 ① + the inline label mapping).
      botName={chipMetabot?.name ?? null}
      currentReaction={panelReactions[message.id] ?? null}
      onContextMenu={handlePanelContextMenu}
      onToggleReaction={handleToggleReaction}
    />
  );

  // Welcome-page avatar: same img/fallback rule as the home welcome
  // (CoworkView) — data:/http avatars render, everything else falls back to
  // the shared CpuChipIcon placeholder on a muted tile.
  const renderWelcomeAvatar = (boxClass: string, iconClass: string) => {
    if (chipMetabot?.avatar
      && (chipMetabot.avatar.startsWith('data:') || chipMetabot.avatar.startsWith('http'))) {
      return (
        <img
          src={chipMetabot.avatar}
          alt={chipMetabot.name}
          className={`${boxClass} shrink-0 object-cover`}
        />
      );
    }
    return (
      <span className={`${boxClass} flex shrink-0 items-center justify-center dark:bg-claude-darkSurface bg-claude-surface`}>
        <CpuChipIcon aria-hidden className={`${iconClass} dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
      </span>
    );
  };

  const workspaceLabel = workspaceSelection
    ? (workspaceSelection.kind === 'project'
        ? workspaceSelection.name
        : workspaceSelection.kind === 'folder'
          ? getCompactFolderName(workspaceSelection.cwd, 40)
          : i18nService.t('coworkBotWorkspace'))
    : '';
  const workspaceTooltip = workspaceSelection
    ? (workspaceSelection.kind === 'project'
        ? `${workspaceSelection.name} (${getCompactFolderName(workspaceSelection.cwd, 120)})`
        : workspaceSelection.kind === 'folder'
          ? getCompactFolderName(workspaceSelection.cwd, 120)
          : i18nService.t('coworkBotWorkspace'))
    : i18nService.t('coworkSelectFolderFirst');
  const selectedWorkspaceCwd = workspaceSelection
    && (workspaceSelection.kind === 'folder' || workspaceSelection.kind === 'project')
    ? workspaceSelection.cwd
    : '';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The relative wrapper hosts the locator rail (purity pass #2 ③) at
          the transcript's right edge; the scroller itself stays unpositioned
          so the rail never scrolls with the content. */}
      <div className="relative min-h-0 flex-1">
        {/* The locator rail is the scroll indicator on this seat: the native
            scrollbar is hidden (scroll behavior unchanged) so the two rails
            never overlap or fight for the same edge. The scroller also
            RESERVES the rail's horizontal lane: pl-1 pr-5 keeps bubble
            content — and the jump ring's 1px outward overhang — a full
            20px (14px w-3.5 rail lane + 1px ring + 5px gap) clear of the
            rail's right-edge zone, so a highlighted bubble never paints
            under the locator rail. */}
        <div ref={listRef} className="h-full space-y-2.5 overflow-y-auto overflow-x-hidden pl-1 pr-5 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleMessages.length === 0 ? (
          needsBootstrap ? (
            // No bot at all on this machine: block the chat with bootstrap
            // guidance instead of the ordinary empty state. A blocked chat is
            // a real call to action, so it keeps a container — but a solid
            // hairline card, not the dashed "drop something here" frame the
            // aesthetic pass retired.
            <div
              data-slot="cowork-needs-bot"
              className="rounded-xl border dark:border-claude-darkBorder/80 border-claude-border/80 dark:bg-claude-darkSurface/50 bg-claude-surface/50 px-3.5 py-4 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary"
            >
              <p>{i18nService.t('botInternetNeedsBot')}</p>
              <button
                type="button"
                onClick={onOpenBotHome}
                className="mt-3 inline-flex items-center rounded-lg px-2 py-1 -ml-1 text-xs font-medium dark:text-claude-accent text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
              >
                {i18nService.t('botInternetGoBotWorks')}
              </button>
            </div>
          ) : (
            // Twin welcome page (owner rulings 2026-11-09: landing built on
            // the white-screen fix + the finalized copy set; the 缩略态定稿
            // same-day ruling retires the width-derived expanded variant).
            // An empty Studio column is the twin's office greeting — ONE
            // fixed compact form: a small avatar + name row, one invitation
            // line, one sub line. No control pretends to be clickable; the
            // real invitation is the composer below, whose placeholder speaks
            // the same voice.
            <div
              data-slot="cowork-empty"
              data-welcome-state="compact"
              className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2.5 px-6 text-center"
            >
              {chipMetabot ? (
                <div className="flex items-center gap-1.5">
                  {renderWelcomeAvatar('h-6 w-6 rounded-md', 'h-3.5 w-3.5')}
                  <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                    {chipMetabot.name}
                  </span>
                </div>
              ) : null}
              <p className="text-base font-semibold tracking-tight dark:text-claude-darkText text-claude-text">
                {i18nService.t('botBrowserCoworkEmpty')}
              </p>
              <p className="max-w-[16rem] text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {chipMetabot?.metabot_type === 'twin'
                  ? i18nService.t('botBrowserCoworkEmptySub')
                  : i18nService.t('botBrowserCoworkEmptySubWorker')}
              </p>
            </div>
          )
        ) : (
          visibleMessages.map(renderMessage)
        )}
        {isStreaming ? (
          // Assistant mode uses the same bot-avatar activity indicator as the
          // main cowork chat (avatar + breathing ring + status line); the
          // panel is a side surface, so the indicator's compact inline form
          // fits without the transcript's gutter wrapper. Professional mode
          // keeps the original pulse dots.
          isAssistantMode ? (
            <AssistantActivityIndicator
              inline
              messages={messages}
              avatar={currentSession?.metabotAvatar ?? selectedMetabot?.avatar ?? null}
            />
          ) : (
            <div className="flex items-center gap-1 px-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </div>
          )
        ) : null}
        </div>
        <PanelMessageLocatorRail
          containerRef={listRef}
          rows={locatorRows}
          ariaLabel={i18nService.t('botBrowserLocatorRail')}
          onTickJump={handleLocatorTickJump}
        />
      </div>

      {/* ① Identity component (owner 18:21 final ruling 2026-11-11; v3
          close wiring, same day): the shared surface-header actions row's
          FIRST lane (left of the session-name slot, ahead of the
          新建会话/会话记录 buttons) carries TWO forms, both portaled into
          Sidebar's cowork-header-identity-anchor by this panel:
          · draft state → BotPickerChip, the interactive bot picker (the
            18:21 "keep the existing interaction" clause — picking decides
            which bot runs the NEXT conversation, a pure selection);
          · live session → CoworkSurfaceIdentityBadge, the read-only
            identity label. It resolves roster-authoritative with the
            session summary row (metabotName/metabotAvatar) as fallback —
            a live transcript shows the bot it RUNS WITH, never the draft
            pick, and renders nothing when nothing is resolvable (the
            same contract as the session-name slot). The former
            `liveSessionMetabot ?? selectedMetabot` header fallback showed
            the draft pick for sessions whose bot left the roster; that
            wrong-identity window is closed here.
          No anchor mounted (panel-less hosts, tests) = nothing renders. */}
      {identityAnchorEl ? (
        createPortal(
          currentSession ? (
            <CoworkSurfaceIdentityBadge
              metabotId={currentSession.metabotId ?? null}
              fallbackName={currentSession.metabotName ?? null}
              fallbackAvatar={currentSession.metabotAvatar ?? null}
            />
          ) : chipMetabot ? (
            <BotPickerChip
              chipMetabot={chipMetabot}
              roster={metabots}
              menuOpen={showBotPickerMenu}
              onToggleMenu={() => setShowBotPickerMenu((value) => !value)}
              onDismissMenu={closeBotPickerMenu}
              onSelect={handlePickBot}
              // The header sits at the panel's top edge: the roster opens DOWN.
              menuDirection="down"
            />
          ) : null,
          identityAnchorEl,
        )
      ) : null}

      {/* The composer tool row keeps only its right cluster (model/effort,
          active skill, workspace folder) — the identity line that used to
          sit on this row's LEFT is gone (owner 18:21 final ruling), so the
          row hugs its tools right and the composer's top edge carries no
          identity anymore. */}
      <div className="flex items-center justify-end gap-0.5 pb-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          <ModelEffortPicker
            dropdownDirection="up"
            compact
            useFixedDropdown
            value={{
              modelId: pendingModelEffort?.modelId ?? selectedMetabot?.llm_id ?? null,
              providerKey: pendingModelEffort?.modelId == null
                ? (selectedMetabot?.llm_provider ?? null)
                : (pendingModelEffort?.providerKey ?? null),
              // An explicit pick sticks as chosen (null = Auto); only a
              // missing pick resolves the bot brain fallback. Assistant mode
              // displays the Auto rung for a missing pick: the session
              // resolves per turn (cerebellum auto when configured, else the
              // default chain).
              effort: effortDisplayForPick(pendingModelEffort, [selectedMetabot?.llm_effort ?? null], { assistantMode: isAssistantMode }),
            }}
            onChange={(value) => {
              setPendingModelEffort({
                modelId: value.modelId,
                providerKey: value.providerKey ?? null,
                effort: value.effort,
              });
            }}
          />
          <ActiveSkillBadge />
          <button
            ref={folderButtonRef}
            type="button"
            onClick={() => setShowFolderMenu((value) => !value)}
            className={`shrink-0 p-1.5 rounded-lg transition-colors ${
              workspaceSelection
                ? 'dark:text-claude-accent text-claude-accent'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text'
            }`}
            title={workspaceTooltip}
            aria-label={workspaceLabel || i18nService.t('coworkSelectFolderFirst')}
          >
            <FolderIcon className="h-4 w-4" />
          </button>
          <FolderSelectorPopover
            isOpen={showFolderMenu}
            onClose={() => setShowFolderMenu(false)}
            onSelectFolder={(folderPath) => {
              setWorkspaceSelection({ kind: 'folder', cwd: folderPath });
              setShowFolderMenu(false);
            }}
            onSelectProject={(project) => {
              setWorkspaceSelection({
                kind: 'project',
                projectId: project.id,
                name: project.name,
                cwd: project.sourceDir?.trim() || '',
              });
            }}
            onOpenNewProject={onOpenNewProject}
            onSelectBotWorkspace={() => setWorkspaceSelection({ kind: 'botWorkspace' })}
            anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
            currentFolder={selectedWorkspaceCwd}
          />
        </div>
      </div>

      {needsBootstrap ? null : (
        <CoworkPromptInput
          ref={promptInputRef}
          onSubmit={handleSubmit}
          onStop={() => void browserCoworkService.stop()}
          isStreaming={isStreaming}
          // The composer speaks the selected bot's voice: the Twin keeps the
          // Twin invitation, a picked worker bot gets the assignment wording
          // (owner ruling 2026-11-11). chipMetabot IS that bot — the draft
          // selection, or the bot a live session runs with.
          placeholder={chipMetabot?.metabot_type === 'twin'
            ? i18nService.t('botBrowserCoworkPlaceholder')
            : i18nService.t('botBrowserCoworkPlaceholderWorker')}
          size="normal"
          scopeKey="botBrowser"
          showFolderSelector={false}
          showModelSelector={false}
          onManageSkills={() => onShowSkills?.()}
          commands={browserComposerCommands}
          // Scope the skills picker to the session's bot (live session wins,
          // draft follows the picker) so pins stay inside that bot's view.
          sessionMetabotId={currentSession?.metabotId ?? effectiveMetabotId}
          // The pending reply card names the real speaker (pass #5 ①): the
          // session bot's own name — 「回复 Monday」 instead of 「回复 Bot」.
          botName={chipMetabot?.name ?? null}
        />
      )}

      {showHistory ? (
        <CoworkHistoryPanel
          sessions={browserSessions}
          // Bot-centered history (owner spec 2026-11-11 17:28 ②): the panel
          // lists the PRESENTED bot's studio conversations — the chip bot
          // (live session bot in a live session, draft pick otherwise) — so
          // switching the picker moves the list with it.
          botId={chipMetabot?.id ?? null}
          currentSessionId={currentSession?.id ?? null}
          onSelectSession={handleSelectHistory}
          onDeleteSession={handleDeleteHistory}
          onTogglePin={handleToggleHistoryPin}
          onRenameSession={handleRenameHistory}
          onClose={() => setShowHistory(false)}
        />
      ) : null}

      {contextMenu ? (
        // Bubble context menu — mounted only while open (no persistent
        // furniture). Placement was viewport-flipped at open time; the three
        // close channels live in the effect above.
        <PanelMessageContextMenu
          ref={panelMenuRef}
          x={contextMenu.x}
          y={contextMenu.y}
          currentReaction={panelReactions[contextMenu.message.id] ?? null}
          selectionActive={Boolean(contextMenu.selectedText)}
          onReact={handleMenuReact}
          onQuoteReply={handleMenuQuoteReply}
          onCopyText={handleMenuCopyText}
          onDismiss={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
};

export default BotBrowserCoworkPanel;

