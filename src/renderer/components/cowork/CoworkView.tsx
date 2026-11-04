import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { CpuChipIcon } from '@heroicons/react/24/outline';
import { RootState, store } from '../../store';
import { clearCurrentSession, setCurrentSession, setStreaming, clearPreferredMetabotId, setNewTaskMetabotId } from '../../store/slices/coworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../../store/slices/skillSlice';
import { setActions, selectAction, clearSelection } from '../../store/slices/quickActionSlice';
import { coworkService } from '../../services/cowork';
import { resolveDefaultMetabotId } from '../../services/coworkSessionStart';
import { configService } from '../../services/config';
import { localStore } from '../../services/store';
import { CONFIG_KEYS, type AppConfig, type ChatExperienceMode } from '../../config';
import { projectsService } from '../../services/projects';
import { metaAppService } from '../../services/metaApp';
import { quickActionService } from '../../services/quickAction';
import { i18nService } from '../../services/i18n';
import { effortDisplayForPick, effortForSessionStart, type ComposerModelEffortPick } from '../../services/modelCatalog';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import CoworkSessionDetail from './CoworkSessionDetail';
import { buildNewTaskComposerCommands } from './composerCommandCatalog';
import BootstrapShortcuts from './BootstrapShortcuts';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { QuickActionBar, PromptPanel } from '../quick-actions';
import type { SettingsOpenOptions } from '../Settings';
import type { CoworkSession, CoworkPermissionMode, CoworkWorkspaceSelection } from '../../types/cowork';
import type { LocalizedPrompt } from '../../types/quickAction';
import { resolveQuickActionPromptSkillMapping } from '../quick-actions/quickActionPresentation.js';
import MetaBotSelector, { type MetaBotForSelector } from './MetaBotSelector';

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  onShowSkills?: () => void;
  onOpenBotInBrowser?: (input: {
    globalMetaId: string;
    name?: string | null;
    avatar?: string | null;
  }) => void;
  focusedOrderTxid?: string | null;
  onFocusedOrderConsumed?: (orderTxid: string) => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const CoworkView: React.FC<CoworkViewProps> = ({
  onRequestAppSettings,
  onShowSkills,
  onOpenBotInBrowser,
  focusedOrderTxid,
  onFocusedOrderConsumed,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const [isInitialized, setIsInitialized] = useState(false);
  const [metabots, setMetabots] = useState<Array<{ id: number; name: string; avatar: string | null; metabot_type: string }>>([]);
  const [, setLocalMetabotCount] = useState(0);
  // Bootstrap state: the machine has no Twin Bot yet (first-run welcome
  // experience). Tracked from the full local roster, not the llm-filtered
  // selectable list, so bootstrap ends as soon as any Twin Bot exists.
  const [hasTwin, setHasTwin] = useState(false);
  const hasTwinRef = useRef(false);
  // The New Task page is a single instance: its MetaBot selection lives in
  // the global store so it survives navigating to conversations or other
  // columns and back.
  const selectedMetabotId = useSelector((state: RootState) => state.cowork.newTaskMetabotId);
  const setSelectedMetabotId = useCallback(
    (id: number | null) => dispatch(setNewTaskMetabotId(id)),
    [dispatch],
  );
  const [selectedMetabotBrain, setSelectedMetabotBrain] = useState<{
    llm_id: string | null;
    llm_provider?: string | null;
    llm_effort?: string | null;
    fallback_llm_id?: string | null;
  } | null>(null);
  // Pending model+effort for the session about to be started from this home
  // view. The whole state being null = follow the selected bot's brain (its
  // model and effort). Inside a pick, effort null is an explicit "Auto"
  // choice (stored as the 'default' sentinel: cerebellum picks per message,
  // degrading to the model default — never brain/global) — it must not fall
  // through to the brain/global rungs the way a missing pick does.
  const [pendingModelEffort, setPendingModelEffort] = useState<ComposerModelEffortPick | null>(null);
  // Chat experience mode (Settings > General). Assistant mode defaults
  // reasoning effort to off, so the composer effort chip displays 'off' for a
  // session with no explicit pick (mirrors the runtime chain). Kept reactive
  // through the app_config store-changed broadcast, same as
  // CoworkSessionDetail, so flipping the mode re-renders without a reload.
  const [chatExperienceMode, setChatExperienceMode] = useState<ChatExperienceMode>(
    () => configService.getConfig().chatExperienceMode ?? 'assistant',
  );
  useEffect(() => {
    const unsubscribe = localStore.onChanged(({ key }) => {
      if (key !== CONFIG_KEYS.APP_CONFIG) return;
      void localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG).then((stored) => {
        setChatExperienceMode(stored?.chatExperienceMode ?? 'assistant');
      });
    });
    return unsubscribe;
  }, []);
  const isAssistantMode = chatExperienceMode === 'assistant';
  // Permission mode is a global preference persisted in app_config; the new
  // task composer shows and updates the same value every session/Bot uses.
  const [permissionMode, setPermissionModeState] = useState<CoworkPermissionMode>(
    configService.getConfig().coworkPermissionMode ?? 'default'
  );
  // The New Task composer's workspace choice: a project, an explicit folder, or
  // the default bot workspace. Seeded from the persisted last selection and
  // persisted back whenever the user changes it.
  const [workspaceSelection, setWorkspaceSelection] = useState<CoworkWorkspaceSelection | null>(null);
  const seedWorkspaceSelection = useCallback(async () => {
    const persisted = store.getState().cowork.config.lastWorkspaceSelection;
    if (!persisted) {
      setWorkspaceSelection({ kind: 'botWorkspace' });
      return;
    }
    if (persisted.kind === 'project') {
      // A project default is only valid while the project still exists.
      try {
        const projects = await projectsService.loadProjects();
        const stillExists = projects.some((p) => p.id === persisted.projectId);
        setWorkspaceSelection(stillExists ? persisted : { kind: 'botWorkspace' });
      } catch {
        setWorkspaceSelection({ kind: 'botWorkspace' });
      }
      return;
    }
    setWorkspaceSelection(persisted);
  }, []);
  const handleWorkspaceSelectionChange = useCallback((selection: CoworkWorkspaceSelection) => {
    setWorkspaceSelection(selection);
    void coworkService.updateConfig({ lastWorkspaceSelection: selection });
  }, []);
  const setPermissionMode = useCallback((mode: CoworkPermissionMode) => {
    setPermissionModeState(mode);
    void configService.updateConfig({ coworkPermissionMode: mode });
  }, []);
  // Slash-command catalog for the new-task composer. Rebuilt every render so
  // command copy follows language switches without extra subscriptions.
  // pendingGoal is the /goal objective attached to the next started session.
  // A ref mirrors it because /goal create sets the goal and submits in the
  // same tick: handleStartSession runs from the pre-update render closure, so
  // it must read the synchronously-written ref, not the (stale) state value.
  const pendingGoalRef = useRef<{ text: string; status: 'active' | 'paused' } | null>(null);
  const [pendingGoal, setPendingGoalState] = useState<{ text: string; status: 'active' | 'paused' } | null>(null);
  const setPendingGoal = useCallback((goal: { text: string; status: 'active' | 'paused' } | null) => {
    pendingGoalRef.current = goal;
    setPendingGoalState(goal);
  }, []);
  const composerCommands = buildNewTaskComposerCommands({
    setPermissionMode: (mode) => setPermissionMode(mode),
    pendingGoal,
    setPendingGoal,
  });
  // Gate the empty-list selection reset below: the metabot list loads async,
  // so without this flag every mount would clear the persisted New Task
  // selection before the IPC resolves.
  const [metabotsLoaded, setMetabotsLoaded] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitErrorSessionIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  // Track if we're starting a session to prevent duplicate submissions
  const isStartingRef = useRef(false);
  // Track pending start request so stop can cancel delayed startup.
  const pendingStartRef = useRef<{ requestId: number; cancelled: boolean } | null>(null);
  const startRequestIdRef = useRef(0);
  // Ref for CoworkPromptInput
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  // The exact prompt text last filled from a quick action (建议操作); when the
  // user submits it unchanged the turn is marked as quick-action sourced so
  // the host MetaApp guard treats it as a pre-approved request.
  const quickActionPromptRef = useRef<string | null>(null);

  // Field-level subscriptions: a whole-slice selector re-renders this view on
  // every composer keystroke (drafts live in the same slice) and drags the
  // session sidebar through a full re-render each time.
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.cowork.isStreaming);
  const config = useSelector((state: RootState) => state.cowork.config);
  const preferredMetabotId = useSelector((state: RootState) => state.cowork.preferredMetabotId);
  activeSessionIdRef.current = currentSession?.id ?? null;

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const quickActions = useSelector((state: RootState) => state.quickAction.actions);
  const selectedActionId = useSelector((state: RootState) => state.quickAction.selectedActionId);
  const selectedPromptId = useSelector((state: RootState) => state.quickAction.selectedPromptId);

  const loadSelectableMetaBots = useCallback(async (): Promise<{ selectable: MetaBotForSelector[]; localCount: number; hasTwin: boolean }> => {
    const [selectorResult, fullListResult] = await Promise.all([
      window.electron?.idbots?.getMetaBots?.(),
      window.electron?.metabot?.list?.(),
    ]);
    const localList = fullListResult?.success && fullListResult.list ? fullListResult.list : [];
    const localCount = localList.length;
    const twinProbeList = localList.length > 0
      ? localList
      : (selectorResult?.success && selectorResult.list ? selectorResult.list : []);
    const hasTwin = twinProbeList.some((metabot) => metabot.metabot_type === 'twin');
    if (!selectorResult?.success || !selectorResult.list) {
      return { selectable: [], localCount, hasTwin };
    }
    if (!fullListResult?.success || !fullListResult.list) {
      return { selectable: selectorResult.list, localCount: selectorResult.list.length, hasTwin };
    }
    const llmConfiguredIds = new Set(
      localList
        .filter((metabot) => metabot.enabled && typeof metabot.llm_id === 'string' && metabot.llm_id.trim())
        .map((metabot) => metabot.id)
    );
    return {
      selectable: selectorResult.list.filter((metabot) => llmConfiguredIds.has(metabot.id)),
      localCount,
      hasTwin,
    };
  }, []);

  // Apply one loaded roster snapshot to local state. When bootstrap just ended
  // (the first Twin Bot appeared, e.g. created by the Welcome Bot mid-chat),
  // auto-select that Twin for the New Task composer.
  const applyLoadedMetaBots = useCallback((loaded: { selectable: MetaBotForSelector[]; localCount: number; hasTwin: boolean }) => {
    const bootstrapEnded = !hasTwinRef.current && loaded.hasTwin;
    setMetabots(loaded.selectable);
    setLocalMetabotCount(loaded.localCount);
    setHasTwin(loaded.hasTwin);
    hasTwinRef.current = loaded.hasTwin;
    setMetabotsLoaded(true);
    if (bootstrapEnded) {
      const twin = loaded.selectable.find((metabot) => metabot.metabot_type === 'twin');
      if (twin) {
        setSelectedMetabotId(twin.id);
      }
    }
  }, [setSelectedMetabotId]);

  const buildApiConfigNotice = (error?: string) => {
    const baseNotice = i18nService.t('coworkModelSettingsRequired');
    if (!error) {
      return baseNotice;
    }
    const normalizedError = error.trim();
    if (
      normalizedError.startsWith('No enabled provider found for model:')
      || normalizedError === 'No available model configured in enabled providers.'
    ) {
      return baseNotice;
    }
    return `${baseNotice} (${error})`;
  };

  useEffect(() => {
    const loadMetaBots = async () => {
      const loaded = await loadSelectableMetaBots();
      applyLoadedMetaBots(loaded);
      if (loaded.selectable.length > 0) {
        const preferred = store.getState().cowork.preferredMetabotId;
        if (preferred != null && loaded.selectable.some((m) => m.id === preferred)) {
          setSelectedMetabotId(preferred);
          dispatch(clearPreferredMetabotId());
        }
      }
    };
    void loadMetaBots();
  }, [dispatch, loadSelectableMetaBots, applyLoadedMetaBots, setSelectedMetabotId]);

  // Bots added behind this view's back (cross-device chain restore from the
  // Settings overlay) announce themselves on this window event; without the
  // reload the restored fleet stays invisible until an app restart.
  useEffect(() => {
    const reloadRoster = () => {
      void loadSelectableMetaBots().then((loaded) => {
        applyLoadedMetaBots(loaded);
      });
    };
    window.addEventListener('app:metabots-changed', reloadRoster);
    return () => window.removeEventListener('app:metabots-changed', reloadRoster);
  }, [loadSelectableMetaBots, applyLoadedMetaBots]);

  // When user just restored a MetaBot (preferredMetabotId set), refetch list and select it so the new bot appears and is selected
  useEffect(() => {
    if (preferredMetabotId == null) return;
    let cancelled = false;
    const refetchAndSelect = async () => {
      const loaded = await loadSelectableMetaBots();
      if (cancelled) return;
      applyLoadedMetaBots(loaded);
      if (loaded.selectable.some((m) => m.id === preferredMetabotId)) {
        setSelectedMetabotId(preferredMetabotId);
      }
      dispatch(clearPreferredMetabotId());
    };
    void refetchAndSelect();
    return () => { cancelled = true; };
  }, [preferredMetabotId, dispatch, loadSelectableMetaBots, applyLoadedMetaBots, setSelectedMetabotId]);

  useEffect(() => {
    if (!metabotsLoaded) return;
    const resolvedId = resolveDefaultMetabotId(metabots, selectedMetabotId);
    if (resolvedId !== selectedMetabotId) setSelectedMetabotId(resolvedId);
  }, [metabots, metabotsLoaded, selectedMetabotId, setSelectedMetabotId]);

  useEffect(() => {
    const id = selectedMetabotId;
    if (id == null) {
      setSelectedMetabotBrain(null);
      return;
    }
    let cancelled = false;
    const fetchMetaBot = async () => {
      const result = await window.electron?.metabot?.get?.(id);
      if (cancelled || !result?.success || !result.metabot) return;
      const metabot = result.metabot;
      setSelectedMetabotBrain({
        llm_id: metabot.llm_id ?? null,
        llm_provider: metabot.llm_provider ?? null,
        llm_effort: metabot.llm_effort ?? null,
        fallback_llm_id: metabot.fallback_llm_id ?? null,
      });
    };
    void fetchMetaBot();
    return () => { cancelled = true; };
  }, [selectedMetabotId]);

  // Intent prewarm (first-sentence latency, 2026-10-16): boot the picked
  // bot's runtime slot — process spawn + plugin tree, ~11-18s cold on
  // automation slots — while the user is still typing, instead of inside the
  // first turn. Debounced to coalesce rapid selector churn; the main side
  // dedupes repeats and the hub coalesces per-slot boots.
  useEffect(() => {
    if (selectedMetabotId == null) return;
    const timer = setTimeout(() => {
      coworkService.prewarmTurnSlot({
        metabotId: selectedMetabotId,
        model: pendingModelEffort?.modelId ?? null,
        modelProvider: pendingModelEffort?.providerKey ?? null,
        cwd: workspaceSelection?.kind === 'project' || workspaceSelection?.kind === 'folder'
          ? workspaceSelection.cwd
          : (config.workingDirectory || null),
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [selectedMetabotId, pendingModelEffort, workspaceSelection, config.workingDirectory]);

  // Same prewarm when an existing session opens: a session whose slot was
  // reaped (idle > 30min) or never warmed re-boots while the user reads the
  // transcript, so the next message starts fast too.
  const currentSessionId = currentSession?.id ?? null;
  useEffect(() => {
    if (!currentSessionId || currentSessionId.startsWith('temp-')) return;
    coworkService.prewarmTurnSlot({ sessionId: currentSessionId });
  }, [currentSessionId]);

  // Returning from a session to the New Task home: the session may have
  // changed the roster (e.g. the Welcome Bot created the user's first Twin Bot
  // mid-chat), so reload instead of showing a stale bootstrap state.
  const hadCurrentSessionRef = useRef(false);
  useEffect(() => {
    if (currentSession) {
      hadCurrentSessionRef.current = true;
      return;
    }
    if (!hadCurrentSessionRef.current) return;
    hadCurrentSessionRef.current = false;
    const reload = async () => {
      const loaded = await loadSelectableMetaBots();
      applyLoadedMetaBots(loaded);
    };
    void reload();
  }, [currentSession, loadSelectableMetaBots, applyLoadedMetaBots]);

  useEffect(() => {
    const init = async () => {
      await coworkService.init();
      // Seed the composer's workspace choice from the persisted last selection
      // (or fall back to the bot workspace for new users / missing dirs).
      await seedWorkspaceSelection();
      // Load quick actions with localization
      try {
        quickActionService.initialize();
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to load quick actions:', error);
      }
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          onRequestAppSettings?.({
            initialTab: 'model',
            notice: buildApiConfigNotice(apiConfig.error),
          });
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }
      setIsInitialized(true);
    };
    init();

    // Subscribe to language changes to reload quick actions
    const unsubscribe = quickActionService.subscribe(async () => {
      try {
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to reload quick actions:', error);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [dispatch, seedWorkspaceSelection]);

  const buildCombinedSystemPrompt = async (skillPrompt?: string) => {
    // Skill routing rules and the live skill catalog are composed main-side
    // now (SKILLS system-prompt section + volatile per-turn catalog tail);
    // the renderer only embeds explicitly pinned skills (`## Skill:` blocks).
    const metaAppPrompt = await metaAppService.getAutoRoutingPrompt();
    return [metaAppPrompt, skillPrompt, config.systemPrompt]
      .filter(p => p?.trim())
      .join('\n\n') || undefined;
  };

  const handleStartSession = async (prompt: string, skillPrompt?: string) => {
    // Prevent duplicate submissions
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    const requestId = ++startRequestIdRef.current;
    pendingStartRef.current = { requestId, cancelled: false };
    const isPendingStartCancelled = () => {
      const pending = pendingStartRef.current;
      return !pending || pending.requestId !== requestId || pending.cancelled;
    };
    // A verbatim quick-action prompt marks the turn as quick-action sourced.
    const isQuickActionPrompt = quickActionPromptRef.current !== null
      && prompt.trim() === quickActionPromptRef.current.trim();
    quickActionPromptRef.current = null;
    // Snapshot the composer pick before any await / setState. Clearing
    // pendingModelEffort and swapping to the temp session would otherwise
    // drop an explicit Off/Low choice and let the session fall through to
    // the model default (DeepSeek: max).
    const pendingPick = pendingModelEffort;
    // Same snapshot discipline for the /goal objective: read the ref once at
    // entry so a later setPendingGoal (or another command) during the awaits
    // below cannot swap what this submission carries.
    const submittedGoal = pendingGoalRef.current;

    try {
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          onRequestAppSettings?.({
            initialTab: 'model',
            notice: buildApiConfigNotice(),
          });
          isStartingRef.current = false;
          return;
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }

      // Create a temporary session with user message to show immediately
      const tempSessionId = `temp-${Date.now()}`;
      const fallbackTitle = prompt.split('\n')[0].slice(0, 50) || i18nService.t('coworkNewSession');
      const now = Date.now();

      // Capture active skill IDs before clearing them
      const sessionSkillIds = [...activeSkillIds];

      // Resolve the conversation's working directory + optional project binding
      // from the New Task composer's workspace choice. A project (or explicit
      // folder) pins the cwd; botWorkspace/empty falls back to the default chain
      // so the main process routes to {base}/bots/{botId}/{date} as before.
      const resolvedCwd = workspaceSelection?.kind === 'project'
        ? workspaceSelection.cwd
        : workspaceSelection?.kind === 'folder'
          ? workspaceSelection.cwd
          : config.workingDirectory || '';
      const resolvedProjectId = workspaceSelection?.kind === 'project'
        ? workspaceSelection.projectId
        : null;

      const tempSession: CoworkSession = {
        id: tempSessionId,
        title: fallbackTitle,
        claudeSessionId: null,
        status: 'running',
        pinned: false,
        createdAt: now,
        updatedAt: now,
        cwd: resolvedCwd,
        systemPrompt: '',
        executionMode: config.executionMode || 'local',
        activeSkillIds: sessionSkillIds,
        model: pendingPick?.modelId ?? undefined,
        modelProvider: pendingPick?.providerKey ?? undefined,
        effort: effortForSessionStart(pendingPick),
        projectId: resolvedProjectId ?? undefined,
        messages: [
          {
            id: `msg-${now}`,
            type: 'user',
            content: prompt,
            timestamp: now,
            metadata: sessionSkillIds.length > 0 ? { skillIds: sessionSkillIds } : undefined,
          },
        ],
      };

      // Immediately show the session detail page with user message
      dispatch(setCurrentSession(tempSession));
      dispatch(setStreaming(true));

      // Clear active skills and quick action selection after starting session
      // so they don't persist to next session. The pending goal is NOT cleared
      // here: it is consumed only after startSession succeeds, so a failed or
      // cancelled start keeps the objective for the retry.
      dispatch(clearActiveSkills());
      dispatch(clearSelection());
      setPendingModelEffort(null);

      const combinedSystemPrompt = await buildCombinedSystemPrompt(skillPrompt);

      // Session titles: start with the placeholder (first line of the prompt);
      // the DSH runtime's dsh-session-title fallback refines it from the first
      // human message, and the host's summary refinement
      // (coworkRunner.scheduleHostSessionTitleRefinement, system brain) lands
      // the final natural-language title — both mirrored into the store +
      // sidebar by the main process. Pre-generating one renderer-side would
      // double the LLM call and be overwritten by the refinement anyway.
      await new Promise(resolve => setTimeout(resolve, 0));

      if (isPendingStartCancelled()) {
        return;
      }

      const title = fallbackTitle;

      // Start the actual session - this will replace the temp session via addSession
      const startedSession = await coworkService.startSession({
        prompt,
        title,
        cwd: resolvedCwd || undefined,
        systemPrompt: combinedSystemPrompt,
        activeSkillIds: sessionSkillIds,
        metabotId: selectedMetabotId,
        permissionMode,
        // Pending picker selection from the home composer; empty pick falls
        // back to the selected bot's brain (its model and effort). An explicit
        // pick with effort null carries the 'default' sentinel (the "Auto"
        // rung): the cerebellum picks per message, degrading to the model
        // default when no verdict lands — never the brain/global rungs.
        model: pendingPick?.modelId ?? undefined,
        modelProvider: pendingPick?.providerKey ?? undefined,
        effort: effortForSessionStart(pendingPick),
        source: isQuickActionPrompt ? 'quick_action' : undefined,
        projectId: resolvedProjectId ?? undefined,
        // Only an active pending goal rides along; a paused one stays local.
        // Reads the entry snapshot: the ref may have been swapped during the
        // awaits above, but this submission carries what was pending when it
        // began.
        goal: submittedGoal?.status === 'active' ? submittedGoal.text : undefined,
      });

      // The goal is consumed once the session actually exists; a failed
      // start leaves it pending for the retry.
      if (startedSession) {
        setPendingGoal(null);
      }

      // Stop immediately if user cancelled while startup request was in flight.
      if (isPendingStartCancelled() && startedSession) {
        await coworkService.stopSession(startedSession.id);
      }
    } finally {
      if (pendingStartRef.current?.requestId === requestId) {
        pendingStartRef.current = null;
      }
      isStartingRef.current = false;
    }
  };

  const handleContinueSession = async (
    prompt: string,
    skillPrompt?: string,
    quotedMessageIds?: string[],
  ) => {
    if (!currentSession) return false;

    const submittedSessionId = currentSession.id;
    const sessionSkillIds = isStreaming ? [] : [...activeSkillIds];
    // A verbatim quick-action prompt marks the turn as quick-action sourced.
    const isQuickActionPrompt = quickActionPromptRef.current !== null
      && prompt.trim() === quickActionPromptRef.current.trim();
    quickActionPromptRef.current = null;
    // Only build/forward a fresh system prompt when the user picked skills for
    // this turn. Ordinary turns reuse the session's persisted prompt so the
    // LIVE MetaApp/Skill catalogs (which change whenever any bot publishes a
    // MetaApp or a skill updates) can never rewrite the cacheable prompt head
    // mid-session and reset DeepSeek's cached prefix.
    const systemPrompt = isStreaming || sessionSkillIds.length === 0
      ? undefined
      : await buildCombinedSystemPrompt(skillPrompt);
    if (
      activeSessionIdRef.current === submittedSessionId
      && !isStreaming
      && sessionSkillIds.length > 0
    ) {
      dispatch(clearActiveSkills());
    }
    const result = await coworkService.submitInput({
      sessionId: submittedSessionId,
      submissionId: crypto.randomUUID(),
      text: prompt,
      systemPrompt,
      activeSkillIds: sessionSkillIds.length > 0 ? sessionSkillIds : undefined,
      source: isQuickActionPrompt ? 'quick_action' : undefined,
      quotedMessageIds,
    });
    if (activeSessionIdRef.current !== submittedSessionId) {
      return result.success;
    }
    if (result.success === false) {
      if (result.code === 'cancelled') {
        submitErrorSessionIdRef.current = null;
        setSubmitError(null);
        return true;
      }
      submitErrorSessionIdRef.current = submittedSessionId;
      setSubmitError(i18nService.t(`coworkSubmitError.${result.code}`));
      return false;
    }
    submitErrorSessionIdRef.current = null;
    setSubmitError(null);
    return true;
  };

  const handleStopSession = async () => {
    if (!currentSession) return;
    if (currentSession.id.startsWith('temp-') && pendingStartRef.current) {
      pendingStartRef.current.cancelled = true;
    }
    await coworkService.stopSession(currentSession.id);
  };

  // Get selected quick action
  const selectedAction = React.useMemo(() => {
    return quickActions.find(action => action.id === selectedActionId);
  }, [quickActions, selectedActionId]);

  // Handle quick action button click: open the second-level prompt list and clear any previous quick-action skill selection.
  const handleActionSelect = (actionId: string) => {
    dispatch(selectAction(actionId));
    dispatch(clearActiveSkills());
  };

  // Bootstrap = no Twin Bot exists yet (first-run welcome experience): the New
  // Task composer offers first-Bot shortcuts instead of the full quick action
  // bar. Gated on metabotsLoaded so a veteran user never sees a bootstrap
  // flash while the roster IPC is still in flight.
  const isBootstrap = metabotsLoaded && !hasTwin;

  // The bot the selector is locked to: drives the welcome hero (avatar, name,
  // description) above the composer.
  const selectedNewTaskBot = metabots.find((m) => m.id === selectedMetabotId) ?? null;
  const descriptionKey = !selectedNewTaskBot
    ? 'coworkDescription'
    : selectedNewTaskBot.metabot_type === 'twin'
      ? 'coworkDescriptionTwin'
      : 'coworkDescriptionPro';

  // Fill (without sending) one of the bootstrap shortcuts into the composer.
  const handleBootstrapShortcut = (text: string) => {
    promptInputRef.current?.setValue(text);
    promptInputRef.current?.focus();
  };

  // When the prompt-mapped skill is deactivated from input area, restore the QuickActionBar.
  useEffect(() => {
    if (!selectedActionId || !selectedPromptId) return;
    const action = quickActions.find(a => a.id === selectedActionId);
    const resolvedSkillMapping = resolveQuickActionPromptSkillMapping(action, selectedPromptId);
    if (!resolvedSkillMapping) return;
    const skillStillActive = activeSkillIds.includes(resolvedSkillMapping);
    if (!skillStillActive) {
      dispatch(clearSelection());
    }
  }, [activeSkillIds, dispatch, quickActions, selectedActionId, selectedPromptId]);

  // Handle prompt selection from QuickAction
  const handleQuickActionPromptSelect = (prompt: LocalizedPrompt) => {
    const resolvedSkillMapping = resolveQuickActionPromptSkillMapping(selectedAction, prompt.id);
    if (resolvedSkillMapping) {
      const targetSkill = skills.find(skill => skill.id === resolvedSkillMapping);
      if (targetSkill) {
        dispatch(setActiveSkillIds([targetSkill.id]));
      } else {
        dispatch(clearActiveSkills());
      }
    } else {
      dispatch(clearActiveSkills());
    }

    // Fill the prompt into input
    quickActionPromptRef.current = prompt.prompt;
    promptInputRef.current?.setValue(prompt.prompt);
    promptInputRef.current?.focus();
  };

  const handleQuickActionBack = () => {
    dispatch(clearSelection());
    dispatch(clearActiveSkills());
  };

  useEffect(() => {
    const handleNewSession = () => {
      dispatch(clearCurrentSession());
      dispatch(clearSelection());
      window.dispatchEvent(new CustomEvent('cowork:focus-input', {
        detail: { clear: true },
      }));
    };
    window.addEventListener('cowork:shortcut:new-session', handleNewSession);
    return () => {
      window.removeEventListener('cowork:shortcut:new-session', handleNewSession);
    };
  }, [dispatch]);

  if (!isInitialized) {
    return (
      <div className="flex-1 h-full flex flex-col cowork-chat-surface">
        <div className="draggable flex h-12 items-center justify-end px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <WindowTitleBar inline />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('loading')}
          </div>
        </div>
      </div>
    );
  }

  // When there's a current session, show the session detail view
  if (currentSession) {
    return (
      <>
        <CoworkSessionDetail
          onManageSkills={() => onShowSkills?.()}
          onContinue={handleContinueSession}
          onStop={handleStopSession}
          submitError={submitErrorSessionIdRef.current === currentSession.id ? submitError : null}
          focusedOrderTxid={focusedOrderTxid}
          onFocusedOrderConsumed={onFocusedOrderConsumed}
          onNavigateHome={() => dispatch(clearCurrentSession())}
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          onNewChat={onNewChat}
          onOpenBotInBrowser={onOpenBotInBrowser}
          onRequestAppSettings={onRequestAppSettings}
          updateBadge={updateBadge}
        />
      </>
    );
  }

  // Home view - no current session
  return (
    <div className="flex-1 flex flex-col cowork-chat-surface h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="non-draggable h-8 flex items-center">
          {isSidebarCollapsed && (
            <div className={`flex items-center gap-1 mr-2 ${isMac ? 'pl-[68px]' : ''}`}>
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
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-[clamp(680px,64%,920px)] mx-auto px-4 pt-10 pb-6 min-h-full flex flex-col">
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6">
            {/* Welcome Section - centered */}
            <div className="text-center space-y-5">
              {selectedNewTaskBot ? (
                <div className="flex flex-col items-center gap-3">
                  {selectedNewTaskBot.avatar && (selectedNewTaskBot.avatar.startsWith('data:') || selectedNewTaskBot.avatar.startsWith('http')) ? (
                    <img
                      src={selectedNewTaskBot.avatar}
                      alt={selectedNewTaskBot.name}
                      className="w-[85px] h-[85px] rounded-xl object-cover"
                    />
                  ) : (
                    <div className="w-[85px] h-[85px] rounded-xl dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center">
                      <CpuChipIcon className="h-10 w-10 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                    </div>
                  )}
                  <div className="text-base font-medium dark:text-claude-darkText text-claude-text">
                    {selectedNewTaskBot.name}
                  </div>
                </div>
              ) : (
                <img src="logo.png" alt="logo" className="w-16 h-16 mx-auto" />
              )}
              <h2 className="text-3xl font-bold tracking-tight dark:text-claude-darkText text-claude-text">
                {i18nService.t('coworkWelcome')}
              </h2>
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-md mx-auto">
                {i18nService.t(descriptionKey)}
              </p>
            </div>

            {/* MetaBot selector (when creating new session) - centered, slightly larger */}
            <div className="flex flex-col items-center gap-3">
              {metabots.length > 0 && (
                <div className="flex justify-center">
                  <MetaBotSelector
                    metabots={metabots}
                    selectedId={selectedMetabotId}
                    onSelect={setSelectedMetabotId}
                    label={i18nService.t('coworkMetaBotLabel')}
                    placeholder={i18nService.t('coworkMetaBotPlaceholder')}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Quick Actions (above input) */}
          <div className="space-y-4 pb-4">
            {selectedAction ? (
              <PromptPanel
                action={selectedAction}
                onPromptSelect={handleQuickActionPromptSelect}
                onBack={handleQuickActionBack}
              />
            ) : isBootstrap ? (
              <BootstrapShortcuts
                greetLabel={i18nService.t('coworkBootstrapGreetShortcut')}
                createLabel={i18nService.t('coworkBootstrapCreateShortcut')}
                onGreet={() => handleBootstrapShortcut(i18nService.t('coworkBootstrapGreetPrompt'))}
                onCreateBot={() => handleBootstrapShortcut(i18nService.t('coworkBootstrapCreatePrompt'))}
              />
            ) : (
              <QuickActionBar actions={quickActions} onActionSelect={handleActionSelect} />
            )}
          </div>
        </div>
      </div>

      {/* Prompt Input Area - Bottom aligned */}
      <div className="p-4 shrink-0">
        <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
          <CoworkPromptInput
            ref={promptInputRef}
            onSubmit={handleStartSession}
            onStop={handleStopSession}
            isStreaming={isStreaming}
            placeholder={i18nService.t(isBootstrap ? 'coworkBootstrapPlaceholder' : 'coworkPlaceholder')}
            size="large"
            workingDirectory={config.workingDirectory}
            onWorkingDirectoryChange={async (dir: string) => {
              await coworkService.updateConfig({ workingDirectory: dir });
            }}
            workspaceSelection={workspaceSelection}
            onWorkspaceSelectionChange={handleWorkspaceSelectionChange}
            onOpenNewProject={() => onRequestAppSettings?.({ initialTab: 'projects', openNewProjectForm: true })}
            showFolderSelector={true}
            showModelSelector={true}
            modelEffortValue={{
              modelId: pendingModelEffort?.modelId ?? selectedMetabotBrain?.llm_id ?? null,
              providerKey: pendingModelEffort?.modelId == null
                ? (selectedMetabotBrain?.llm_provider ?? null)
                : (pendingModelEffort?.providerKey ?? null),
              // An explicit pick sticks as chosen (null = Default); only a
              // missing pick resolves the fallback chain. A bot with a
              // configured brain (primary or fallback model) is authoritative —
              // the persisted global effort only fills in when no brain exists.
              // Assistant mode displays 'off' for a missing pick: that is the
              // rung the new session will actually run at.
              effort: effortDisplayForPick(pendingModelEffort, [
                selectedMetabotBrain?.llm_effort ?? null,
                ...(selectedMetabotBrain?.llm_id || selectedMetabotBrain?.fallback_llm_id
                  ? []
                  : [configService.getConfig().coworkEffortLevel ?? null]),
              ], { assistantMode: isAssistantMode }),
            }}
            onModelEffortChange={(value) => {
              setPendingModelEffort({
                modelId: value.modelId,
                providerKey: value.providerKey ?? null,
                effort: value.effort,
              });
            }}
            onManageSkills={() => onShowSkills?.()}
            showPermissionModeSelector={true}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            commands={composerCommands}
            sessionMetabotId={selectedMetabotId}
          />
        </div>
      </div>
    </div>
  );
};

export default CoworkView;
