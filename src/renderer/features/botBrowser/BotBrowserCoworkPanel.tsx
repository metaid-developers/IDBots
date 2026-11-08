import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ChatBubbleLeftRightIcon, ClockIcon, XMarkIcon, TrashIcon, FolderIcon } from '@heroicons/react/24/outline';
import ComposeIcon from '../../components/icons/ComposeIcon';
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

const formatRelativeTime = (timestamp: number): string => {
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

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
}> = ({ message, onOpenUri, isAssistantMode = false, resolveLocalFilePath }) => {
  if (message.type === 'user') {
    return (
      <div className="flex justify-end">
        {/* Same display-side body pipeline as the main cowork transcript: the
            attachment marker lines split out at render time, image files render
            as the shared thumbnail strip with the in-app lightbox, and the rest
            renders as markdown. The panel keeps its own bubble chrome. */}
        <div className="max-w-[90%] min-w-0 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text shadow-subtle">
          <UserMessageBody content={message.content} resolveLocalFilePath={resolveLocalFilePath} />
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
      <div className="min-w-0">
        <div className="assistant-bubble w-fit max-w-[92%] rounded-[22px] px-[16px] py-[10px] text-[13px] leading-5 dark:text-claude-darkText text-claude-text shadow-subtle [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all">
          <MarkdownContent content={message.content} compact onOpenBotBrowserUri={onOpenUri} emojiImages />
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 text-[13px] leading-5 dark:text-claude-darkText text-claude-text [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all">
      <MarkdownContent content={message.content} compact onOpenBotBrowserUri={onOpenUri} emojiImages />
    </div>
  );
};

interface BotBrowserCoworkPanelProps {
  onShowSkills?: () => void;
  /** Open Settings > Projects > New Project (from the workspace popover). */
  onOpenNewProject?: () => void;
  /** Switch the sidebar back to Bot Home (no-Twin bootstrap guidance). */
  onOpenBotHome?: () => void;
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
const BotBrowserCoworkPanel: React.FC<BotBrowserCoworkPanelProps> = ({ onShowSkills, onOpenNewProject, onOpenBotHome }) => {
  const dispatch = useDispatch();
  const currentSession = useSelector((state: RootState) => state.browserCowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.browserCowork.isStreaming);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const [showHistory, setShowHistory] = useState(false);
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

  const browserSessions = useMemo(
    () => sessions.filter((session) => session.sessionType === 'browser'),
    [sessions]
  );

  const messages = currentSession?.messages ?? [];
  const visibleMessages = useMemo(
    () => filterVisiblePanelMessages(messages),
    [messages]
  );

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

  const renderMessage = (message: CoworkMessage) => (
    <PanelMessage
      key={message.id}
      message={message}
      onOpenUri={handleOpenUri}
      isAssistantMode={isAssistantMode}
      resolveLocalFilePath={resolveLocalFilePath}
    />
  );

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
      {/* Actions only (owner ruling 2026-11-08 14:15). The row used to start
          with a «Co-Work» label, but this column's every entry IS a co-work
          session and the rail entry that opened the panel already names it, so
          the label was an in-place self-introduction with nothing to add. The
          two actions stay — they are the only controls here. */}
      {/* Metric grid, aesthetic pass 2026-11-08: both actions use the SAME
          28 px control box as the mid-column header's capsule and search
          button, sitting on the column's 10 px inset. Before this they were
          24 px and pulled 4 px inside that inset, so the eye read a second,
          smaller control ladder floating under the header. */}
      <div data-slot="cowork-panel-actions" className="flex items-center justify-end gap-0.5 pb-1.5">
        <button
          type="button"
          onClick={() => {
            setShowHistory(false);
            browserCoworkService.startNewDraft();
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
          aria-label={i18nService.t('botBrowserCoworkNew')}
          title={i18nService.t('botBrowserCoworkNew')}
        >
          <ComposeIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((value) => !value)}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
            showHistory
              ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
          }`}
          aria-label={i18nService.t('botBrowserCoworkHistory')}
          title={i18nService.t('botBrowserCoworkHistory')}
        >
          <ClockIcon className="h-4 w-4" />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overflow-x-hidden px-1 pb-2">
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
            // Empty state, aesthetic pass 2026-11-08: the dashed frame made the
            // first screen of this column read as an unfilled placeholder. An
            // empty Co-Work panel is a landing, not a slot: one quiet mark, one
            // sentence, centred in the room it actually has — and no control
            // that pretends to be clickable.
            <div
              data-slot="cowork-empty"
              className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2.5 px-6 text-center"
            >
              <ChatBubbleLeftRightIcon
                aria-hidden
                className="h-5 w-5 opacity-50 dark:text-claude-darkTextSecondary text-claude-textSecondary"
              />
              <p className="max-w-[16rem] text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('botBrowserCoworkEmpty')}
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
        <div className="absolute inset-x-0 top-7 bottom-0 z-10 flex flex-col rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted shadow-lg">
          <div className="flex items-center justify-between px-3 py-2 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span>{i18nService.t('botBrowserCoworkHistory')}</span>
            <button
              type="button"
              onClick={() => setShowHistory(false)}
              className="h-5 w-5 inline-flex items-center justify-center rounded-md hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
            {browserSessions.length === 0 ? (
              <div className="px-2 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('coworkNoSessions')}
              </div>
            ) : (
              browserSessions.map((session) => (
                <div
                  key={session.id}
                  className={`group flex items-start gap-1 rounded-md px-2 py-1.5 text-sm transition-colors cursor-pointer hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${
                    currentSession?.id === session.id ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover' : ''
                  }`}
                  onClick={() => void handleSelectHistory(session.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs dark:text-claude-darkText text-claude-text">
                      {session.title}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {(session.browserTitle || session.browserUri) ?? ''}
                    </div>
                  </div>
                  <span className="shrink-0 pt-0.5 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleDeleteHistory(session.id);
                    }}
                    className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-md text-claude-textSecondary hover:text-red-500 group-hover:inline-flex"
                    aria-label={i18nService.t('delete')}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default BotBrowserCoworkPanel;
