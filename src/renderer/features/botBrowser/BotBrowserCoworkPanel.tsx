import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ClockIcon, XMarkIcon, TrashIcon, FolderIcon } from '@heroicons/react/24/outline';
import ComposeIcon from '../../components/icons/ComposeIcon';
import MarkdownContent from '../../components/MarkdownContent';
import CoworkPromptInput, { type CoworkPromptInputRef } from '../../components/cowork/CoworkPromptInput';
import { buildSessionComposerCommands } from '../../components/cowork/composerCommandCatalog';
import FolderSelectorPopover from '../../components/cowork/FolderSelectorPopover';
import MetaBotSelector, { type MetaBotForSelector } from '../../components/cowork/MetaBotSelector';
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
import { getCompactFolderName } from '../../utils/path';
import type { CoworkMessage, CoworkWorkspaceSelection } from '../../types/cowork';

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

const PanelMessage: React.FC<{
  message: CoworkMessage;
  onOpenUri: (uri: string) => void;
  isAssistantMode?: boolean;
}> = ({ message, onOpenUri, isAssistantMode = false }) => {
  if (message.type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] min-w-0 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text shadow-subtle">
          {message.content}
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
          <MarkdownContent content={message.content} compact onOpenBotBrowserUri={onOpenUri} />
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 text-[13px] leading-5 dark:text-claude-darkText text-claude-text [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all">
      <MarkdownContent content={message.content} compact onOpenBotBrowserUri={onOpenUri} />
    </div>
  );
};

interface BotBrowserCoworkPanelProps {
  onShowSkills?: () => void;
  /** Open Settings > Projects > New Project (from the workspace popover). */
  onOpenNewProject?: () => void;
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
const BotBrowserCoworkPanel: React.FC<BotBrowserCoworkPanelProps> = ({ onShowSkills, onOpenNewProject }) => {
  const dispatch = useDispatch();
  const currentSession = useSelector((state: RootState) => state.browserCowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.browserCowork.isStreaming);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const [showHistory, setShowHistory] = useState(false);
  const [metabots, setMetabots] = useState<PanelMetabot[]>([]);
  const [selectedMetabotId, setSelectedMetabotId] = useState<number | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await window.electron?.metabot?.list?.();
      if (cancelled || !result?.success || !result.list) return;
      const selectable = result.list
        .filter(
          (metabot) => metabot.enabled && typeof metabot.llm_id === 'string' && metabot.llm_id.trim()
        )
        .sort((a, b) => a.id - b.id);
      setMetabots(selectable);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // An existing session's MetaBot wins for display; otherwise fall back to the first available.
  useEffect(() => {
    if (currentSession?.metabotId != null) {
      setSelectedMetabotId(currentSession.metabotId);
    }
  }, [currentSession?.metabotId]);

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

  const effectiveMetabotId = selectedMetabotId ?? metabots[0]?.id ?? null;
  const selectedMetabot = metabots.find((m) => m.id === effectiveMetabotId) ?? null;
  // Pending model+effort for the session about to start from this panel. The
  // whole state being null = follow the selected bot's brain (its model and
  // effort); inside a pick, effort null is an EXPLICIT "Default" choice.
  const [pendingModelEffort, setPendingModelEffort] = useState<ComposerModelEffortPick | null>(null);
  // Chat experience mode (Settings > General), scoped per session through the
  // shared gate (isAssistantModeOwnerChatSession — mirrors the backend rule in
  // src/main/libs/coworkRunner.ts). Browser cowork sessions are non-standard,
  // so the backend runs them with the professional prompt and the professional
  // effort chain; the panel follows (professional effort-chip display, plain
  // message text rather than assistant bubbles). In the draft state (no
  // session yet) the verdict is likewise professional — the session about to
  // start from this panel is a browser session. See useChatExperienceMode for
  // the cross-window reactivity contract.
  const chatExperienceMode = useChatExperienceMode();
  const isAssistantMode = isAssistantModeOwnerChatSession(chatExperienceMode, currentSession);

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

  const renderMessage = (message: CoworkMessage) => (
    <PanelMessage key={message.id} message={message} onOpenUri={handleOpenUri} isAssistantMode={isAssistantMode} />
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
      <div className="flex items-center gap-1 px-1 pb-2">
        <span className="flex-1 truncate text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('botBrowserCoworkTitle')}
        </span>
        <button
          type="button"
          onClick={() => {
            setShowHistory(false);
            setSelectedMetabotId(null);
            browserCoworkService.startNewDraft();
          }}
          className="h-6 w-6 inline-flex items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('botBrowserCoworkNew')}
          title={i18nService.t('botBrowserCoworkNew')}
        >
          <ComposeIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((value) => !value)}
          className={`h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors ${
            showHistory
              ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
          }`}
          aria-label={i18nService.t('botBrowserCoworkHistory')}
          title={i18nService.t('botBrowserCoworkHistory')}
        >
          <ClockIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overflow-x-hidden px-1 pb-2">
        {visibleMessages.length === 0 ? (
          <div className="rounded-lg border border-dashed dark:border-claude-darkBorder border-claude-border px-3 py-4 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('botBrowserCoworkEmpty')}
          </div>
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

      <div className="flex items-center justify-between gap-0.5 px-1 pb-1.5">
        {metabots.length > 0 ? (
          <div className="min-w-0 max-w-[60%]">
            <MetaBotSelector
              metabots={metabots}
              selectedId={effectiveMetabotId}
              onSelect={setSelectedMetabotId}
              label={i18nService.t('coworkMetaBotLabel')}
              placeholder={i18nService.t('coworkMetaBotPlaceholder')}
              compact
              dropdownDirection="up"
            />
          </div>
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
        // draft follows the selector) so pins stay inside that bot's view.
        sessionMetabotId={currentSession?.metabotId ?? effectiveMetabotId}
      />

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
