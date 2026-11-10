import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { CpuChipIcon, FolderIcon } from '@heroicons/react/24/outline';
import MarkdownContent from '../../components/MarkdownContent';
import CoworkPromptInput, { type CoworkPromptInputRef } from '../../components/cowork/CoworkPromptInput';
import { UserMessageBody } from '../../components/cowork/UserAttachmentBody';
import { resolveLocalPathAgainstCwd, type LocalFilePathResolver } from '../../utils/localPath';
import { buildSessionComposerCommands } from '../../components/cowork/composerCommandCatalog';
import FolderSelectorPopover from '../../components/cowork/FolderSelectorPopover';
import type { MetaBotForSelector } from '../../components/cowork/MetaBotSelector';
import ModelEffortPicker from '../../components/ModelEffortPicker';
import { effortDisplayForPick, effortForSessionStart, type ComposerModelEffortPick } from '../../services/modelCatalog';
import { ActiveSkillBadge } from '../../components/skills';
import { RootState } from '../../store';
import { clearActiveSkills } from '../../store/slices/skillSlice';
import { browserCoworkService } from '../../services/browserCowork';
import { useChatExperienceMode } from '../../hooks/useChatExperienceMode';
import { isAssistantModeOwnerChatSession } from '../../components/cowork/assistantModeSessionGate';
import { AssistantActivityIndicator } from '../../components/cowork/AssistantActivityIndicator';
import { projectsService } from '../../services/projects';
import { i18nService } from '../../services/i18n';
import { dispatchMetabotsChanged, subscribeMetabotsChanged } from '../../services/metabotEvents';
import { getCompactFolderName } from '../../utils/path';
import type { CoworkMessage, CoworkWorkspaceSelection } from '../../types/cowork';
import TwinSeatChip from './TwinSeatChip';
import { appointTwinSeat } from './twinSeatAppointment';
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
import { createMessageQuotedSelection } from '../../components/cowork/coworkQuotedSelections';

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
  /** Meta-line stamp, pre-formatted (`HH:mm` / `MM-DD HH:mm`, '' = omit). */
  timestampLabel?: string;
  /**
   * Whether this bubble ends a same-sender group (purity pass #3 ①): only
   * group-end rows carry the stamp at all, and even there the stamp stays
   * hidden until the row is hovered (zero layout footprint otherwise).
   */
  showTimestamp?: boolean;
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
  timestampLabel,
  showTimestamp = true,
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
  // Meta line under the bubble (pass #3 ①, refined after owner's live test):
  // the stamp is group-scoped and hover-revealed, but the ROW ITSELF ALWAYS
  // MOUNTS and keeps its height — reveal switches visibility only
  // (`invisible group-hover:visible`), never display. Mount-on-hover made
  // the bubble grow under the pointer and jitter the whole transcript
  // (owner report 2026-11-10); a reserved ~20px meta slot on group-end rows
  // is the stability cost the owner explicitly chose. A row carrying a
  // reaction chip is functional state (visible and cancellable) with its
  // stamp still hover-gated inside. The row wrapper below carries the
  // `group` class that drives the reveal.
  const hasReactionChip = Boolean(currentReaction && onToggleReaction);
  const stampOnlyRow = showTimestamp && !hasReactionChip;
  const metaRow = showTimestamp || hasReactionChip ? (
    <div
      data-slot="panel-message-meta"
      className={`${stampOnlyRow ? 'invisible group-hover:visible' : 'flex'} items-center gap-1.5 px-1 pt-0.5 text-[11px] leading-3 dark:text-claude-darkTextSecondary text-claude-textSecondary ${
        isUser ? 'justify-end' : 'justify-start'
      }`}
    >
      {timestampLabel ? (
        showTimestamp ? (
          // Group-end rows only. The span reveals with its row when the row
          // is stamp-only (visibility toggle only); on a chip-carrying row
          // (always mounted) the stamp waits for hover on its own.
          <span
            data-panel-message-timestamp="true"
            className={stampOnlyRow ? undefined : 'invisible group-hover:inline'}
          >
            {timestampLabel}
          </span>
        ) : null
      ) : null}
      {currentReaction && onToggleReaction ? (
        <button
          type="button"
          data-panel-reaction-chip={currentReaction}
          onClick={() => onToggleReaction(message, currentReaction)}
          className="rounded-full border border-current/20 px-1.5 py-px text-[10px] leading-3 transition-opacity hover:opacity-70"
        >
          {currentReaction === 'up' ? '👍' : '👎'}
        </button>
      ) : null}
    </div>
  ) : null;
  if (isUser) {
    return (
      // data-panel-message-id lets the locator rail measure this row
      // (purity pass #2 ③) without touching the bubble chrome. `group` is
      // the hover proxy for the stamp reveal (pass #3 ①).
      <div data-panel-message-id={message.id} className="group flex flex-col items-end">
        {/* Same display-side body pipeline as the main cowork transcript: the
            attachment marker lines split out at render time, image files render
            as the shared thumbnail strip with the in-app lightbox, and the rest
            renders as markdown. The panel keeps its own bubble chrome. */}
        <div
          onContextMenu={handleBubbleContextMenu}
          className="max-w-[90%] min-w-0 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text shadow-subtle"
        >
          <UserMessageBody content={message.content} resolveLocalFilePath={resolveLocalFilePath} />
        </div>
        {metaRow}
      </div>
    );
  }
  if (message.type !== 'assistant' || !message.content.trim()) return null;
  if (isAssistantMode) {
    // Assistant mode aligns the panel with the main cowork chat: bot answers
    // (narration and final alike) sit in the neutral-gray .assistant-bubble
    // instead of bare full-width text, so both surfaces read the same way.
    return (
      <div data-panel-message-id={message.id} className="group flex min-w-0 flex-col items-start">
        <div
          onContextMenu={handleBubbleContextMenu}
          className="assistant-bubble w-fit max-w-[92%] rounded-[22px] px-[16px] py-[10px] text-[13px] leading-5 dark:text-claude-darkText text-claude-text shadow-subtle [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all"
        >
          <MarkdownContent content={message.content} compact onOpenBotBrowserUri={onOpenUri} emojiImages />
        </div>
        {metaRow}
      </div>
    );
  }
  return (
    <div data-panel-message-id={message.id} className="group flex min-w-0 flex-col items-start text-[13px] leading-5 dark:text-claude-darkText text-claude-text [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all">
      <div onContextMenu={handleBubbleContextMenu} className="min-w-0">
        <MarkdownContent content={message.content} compact onOpenBotBrowserUri={onOpenUri} emojiImages />
      </div>
      {metaRow}
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
  // Twin seat appointment (owner ruling 2026-11-08): the bottom-left identity
  // chip is a live appointment control, not a decoration. The appoint action
  // drives the SAME metabot_type the My Bots editor writes (demote the current
  // Twin → promote the chosen bot), so the seat stays one system-wide fact and
  // never a second pointer. In a live session the chip is display-only: an
  // acting transcript never changes actors mid-flight.
  const [showTwinSeatMenu, setShowTwinSeatMenu] = useState(false);
  const [twinSeatBusy, setTwinSeatBusy] = useState(false);
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
    const placement = resolveContextMenuPlacement(event.clientX, event.clientY, {
      width: typeof window !== 'undefined' ? window.innerWidth : 0,
      height: typeof window !== 'undefined' ? window.innerHeight : 0,
    });
    setContextMenu({
      message,
      x: placement.x,
      y: placement.y,
      opener: event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
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

  // Copy the RAW message text (the stored markdown, not the rendered prose).
  const handleMenuCopyText = useCallback(() => {
    const menu = contextMenuRef.current;
    if (!menu) return;
    const raw = menu.message.content;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(raw);
      }
    } catch {
      // Clipboard unavailable (permissions): menu still closes; nothing to show.
    }
  }, []);

  // Three close channels while the menu is open: a pointerdown outside the
  // menu AND outside the opening bubble, Escape, and any scroll (capture phase
  // catches the panel list and ancestor scrollers). Bound only while open.
  useEffect(() => {
    if (!contextMenu) return undefined;
    const dismiss = () => setContextMenu(null);
    const handlePointerDown = (event: PointerEvent) => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      if (!isPointerOutsideContextMenu(panelMenuRef.current, menu.opener, event.target)) return;
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

  // Twin welcome page (owner rulings 2026-11-09: the BotHub face is the
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
    const ordinal = visibleMessages.findIndex((candidate) => candidate.id === message.id) + 1;
    const fragment = createMessageQuotedSelection({
      content: message.content,
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
    // The Twin seat menu is a roster-level control (owner ruling 2026-11-08):
    // it lists every local bot, not just the ones selectable for a chat, so an
    // appointment can land on any bot the My Bots editor can also flag. The
    // seat itself stays a single system-wide fact (`metabot_type`).
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

  // Twin seat appointment: demote the current Twin, promote the chosen bot,
  // then re-read the roster. The sequence + rollback live in
  // twinSeatAppointment.ts so a mock-IPC unit test covers them without
  // touching the real roster; this handler only wires the effect (IPC,
  // reload, toast) and owns the busy/menu UI state.
  const notifyTwinSeat = useCallback((message: string) => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
  }, []);

  const closeTwinSeatMenu = useCallback(() => setShowTwinSeatMenu(false), []);

  const handleAppointTwin = useCallback(async (target: PanelMetabot) => {
    if (twinSeatBusy) return;
    setTwinSeatBusy(true);
    try {
      await appointTwinSeat(target, metabots, {
        update: (id, patch) => window.electron.metabot.update(id, patch),
        reload: loadMetabots,
        // The appointment writes `metabot_type`, which the My Bots pane shows
        // as badge ownership on its cards: announce both moved ids so an
        // already-open My Bots pane refetches instead of waiting for a switch.
        announce: (metabotIds) => dispatchMetabotsChanged({ metabotIds, reason: 'twin-seat' }),
        notify: notifyTwinSeat,
        translate: (key) => i18nService.t(key),
      });
    } catch (error) {
      // Transport-level rejection (IPC error): the helper reports outcome
      // failures itself, but a thrown update must never fail silently.
      notifyTwinSeat(error instanceof Error ? error.message : 'Twin seat appointment failed');
    } finally {
      setShowTwinSeatMenu(false);
      setTwinSeatBusy(false);
    }
  }, [loadMetabots, metabots, notifyTwinSeat, twinSeatBusy]);

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

  // Bot Internet is locked to the owner's Twin (owner ruling #2, 2026-11-07):
  // sessions started here always target the metabot_type === 'twin' bot, and
  // machines without a Twin get bootstrap guidance instead of a composer.
  // Legacy (pre-marker) sessions keep showing their own bot in the identity
  // chip so old transcripts read the same as before.
  const twinMetabot = metabots.find((m) => m.metabot_type === 'twin') ?? null;
  const needsTwinBootstrap = metabotsLoaded && !twinMetabot && !currentSession;
  const legacySessionMetabot = !currentSession?.assistantMode && currentSession?.metabotId != null
    ? metabots.find((m) => m.id === currentSession.metabotId) ?? null
    : null;
  const chipMetabot = legacySessionMetabot ?? twinMetabot;
  const effectiveMetabotId = twinMetabot?.id ?? null;
  const selectedMetabot = twinMetabot;
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

  const handleSubmit = async (prompt: string, skillPrompt?: string) => {
    if (!currentSession && !twinMetabot) return; // no-Twin machines never start sessions here
    setShowHistory(false);
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
      await browserCoworkService.send(prompt, skills);
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
      }, skills, startProjectId);
      setPendingModelEffort(null);
    }
    if (skillIds.length > 0) {
      dispatch(clearActiveSkills());
    }
  };

  const handleSelectHistory = async (sessionId: string) => {
    setShowHistory(false);
    await browserCoworkService.loadSession(sessionId);
  };

  const handleDeleteHistory = async (sessionId: string) => {
    await browserCoworkService.archiveSession(sessionId);
  };

  const handleOpenUri = useCallback((uri: string) => {
    window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
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

  // (message, index) rides Array.map: the group-end predicate reads the
  // rendered sequence (visibleMessages), so same-sender bursts collapse to
  // one hover-revealed stamp on their last bubble (purity pass #3 ①).
  const renderMessage = (message: CoworkMessage, index: number) => (
    <PanelMessage
      key={message.id}
      message={message}
      onOpenUri={handleOpenUri}
      isAssistantMode={isAssistantMode}
      resolveLocalFilePath={resolveLocalFilePath}
      // Quiet per-bubble stamp on the meta line: same-day `HH:mm`, older
      // days `MM-DD HH:mm` (computed at render, local time). The stamp only
      // mounts on a group-end row and only shows while that row is hovered.
      timestampLabel={formatPanelMessageTimestamp(message.timestamp, Date.now())}
      showTimestamp={isPanelMessageGroupEnd(visibleMessages, index)}
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
        <div ref={listRef} className="h-full space-y-2.5 overflow-y-auto overflow-x-hidden px-1 pb-2">
        {visibleMessages.length === 0 ? (
          needsTwinBootstrap ? (
            // No Twin on this machine: block the chat with bootstrap guidance
            // instead of the ordinary empty state (owner ruling #2).
            // A blocked chat is a real call to action, so it keeps a container
            // — but a solid hairline card, not the dashed "drop something here"
            // frame the aesthetic pass retired.
            <div
              data-slot="cowork-needs-twin"
              className="rounded-xl border dark:border-claude-darkBorder/80 border-claude-border/80 dark:bg-claude-darkSurface/50 bg-claude-surface/50 px-3.5 py-4 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary"
            >
              <p>{i18nService.t('botInternetNeedsTwin')}</p>
              <button
                type="button"
                onClick={onOpenBotHome}
                className="mt-3 inline-flex items-center rounded-lg px-2 py-1 -ml-1 text-xs font-medium dark:text-claude-accent text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
              >
                {i18nService.t('botInternetGoBotHome')}
              </button>
            </div>
          ) : (
            // Twin welcome page (owner rulings 2026-11-09: landing built on
            // the white-screen fix + the finalized copy set; the 缩略态定稿
            // same-day ruling retires the width-derived expanded variant).
            // An empty BotHub column is the twin's office greeting — ONE
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
                {i18nService.t('botBrowserCoworkEmptySub')}
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
        />
      </div>

      <div className="flex items-center justify-between gap-0.5 pb-1.5">
        {chipMetabot ? (
          // Twin seat (owner ruling 2026-11-08): the chip is the appointment
          // control in the draft state — clicking opens the seat menu listing
          // every bot. In a live session it stays a fixed identity chip (the
          // transcript always shows the bot it was started with; legacy
          // sessions keep their own bot).
          <TwinSeatChip
            chipMetabot={chipMetabot}
            roster={metabots}
            live={Boolean(currentSession)}
            busy={twinSeatBusy}
            menuOpen={showTwinSeatMenu}
            onToggleMenu={() => setShowTwinSeatMenu((value) => !value)}
            onDismissMenu={closeTwinSeatMenu}
            onAppoint={handleAppointTwin}
          />
        ) : null}
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

      {needsTwinBootstrap ? null : (
        <CoworkPromptInput
          ref={promptInputRef}
          onSubmit={handleSubmit}
          onStop={() => void browserCoworkService.stop()}
          isStreaming={isStreaming}
          placeholder={i18nService.t('botBrowserCoworkPlaceholder')}
          size="normal"
          scopeKey="botBrowser"
          showFolderSelector={false}
          showModelSelector={false}
          onManageSkills={() => onShowSkills?.()}
          commands={browserComposerCommands}
          // Scope the skills picker to the session's bot (live session wins,
          // draft follows the Twin) so pins stay inside that bot's view.
          sessionMetabotId={currentSession?.metabotId ?? effectiveMetabotId}
        />
      )}

      {showHistory ? (
        <CoworkHistoryPanel
          sessions={browserSessions}
          currentSessionId={currentSession?.id ?? null}
          onSelectSession={handleSelectHistory}
          onDeleteSession={handleDeleteHistory}
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

