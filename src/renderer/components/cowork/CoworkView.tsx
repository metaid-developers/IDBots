import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { ChevronDownIcon, CpuChipIcon } from '@heroicons/react/24/outline';
import { RootState, store } from '../../store';
import { clearCurrentSession, setCurrentSession, setStreaming, clearPreferredMetabotId } from '../../store/slices/coworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../../store/slices/skillSlice';
import { setActions, selectAction, clearSelection } from '../../store/slices/quickActionSlice';
import { coworkService } from '../../services/cowork';
import { metaAppService } from '../../services/metaApp';
import { skillService } from '../../services/skill';
import { quickActionService } from '../../services/quickAction';
import { i18nService } from '../../services/i18n';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import CoworkSessionDetail from './CoworkSessionDetail';
import ModelSelector from '../ModelSelector';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { QuickActionBar, PromptPanel } from '../quick-actions';
import type { SettingsOpenOptions } from '../Settings';
import type { CoworkSession } from '../../types/cowork';
import type { LocalizedPrompt } from '../../types/quickAction';
import { resolveQuickActionPromptSkillMapping } from '../quick-actions/quickActionPresentation.js';
import { shouldRouteFirstMetabotCreationToOnboarding } from '../onboarding/onboardingGate.js';

type MetaBotForSelector = { id: number; name: string; avatar: string | null; metabot_type: string };

const MetaBotSelector: React.FC<{
  metabots: MetaBotForSelector[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  label: string;
  placeholder: string;
}> = ({ metabots, selectedId, onSelect, label, placeholder }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);
  const selected = metabots.find((m) => m.id === selectedId) ?? metabots[0];
  return (
    <div className="flex items-center justify-center gap-3">
      <label className="text-sm font-medium dark:text-claude-darkText text-claude-text shrink-0">
        {label}
      </label>
      <div ref={containerRef} className="relative min-w-[280px]">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center gap-2 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border px-5 py-3 text-base focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/40 cursor-pointer"
          aria-label={placeholder}
        >
          {selected ? (
            <>
              {selected.avatar && (selected.avatar.startsWith('data:') || selected.avatar.startsWith('http')) ? (
                <img src={selected.avatar} alt="" className="w-7 h-7 rounded-md object-cover flex-shrink-0" />
              ) : (
                <div className="w-7 h-7 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
                  <CpuChipIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
              )}
              <span className="truncate flex-1 text-left">{selected.name}</span>
            </>
          ) : (
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{placeholder}</span>
          )}
          <ChevronDownIcon className={`h-4 w-4 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover z-50 overflow-hidden max-h-56 overflow-y-auto">
            {metabots.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onSelect(m.id);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-5 py-3 text-left text-base hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${selectedId === m.id ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
              >
                {m.avatar && (m.avatar.startsWith('data:') || m.avatar.startsWith('http')) ? (
                  <img src={m.avatar} alt="" className="w-7 h-7 rounded-md object-cover flex-shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
                      {m.name.slice(0, 2) || '?'}
                    </span>
                  </div>
                )}
                <span className="truncate flex-1">{m.name}</span>
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                  ({m.metabot_type})
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  onRequestOnboarding?: () => void;
  onShowSkills?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const CoworkView: React.FC<CoworkViewProps> = ({
  onRequestAppSettings,
  onRequestOnboarding,
  onShowSkills,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const [isInitialized, setIsInitialized] = useState(false);
  const [metabots, setMetabots] = useState<Array<{ id: number; name: string; avatar: string | null; metabot_type: string }>>([]);
  const [localMetabotCount, setLocalMetabotCount] = useState(0);
  const [selectedMetabotId, setSelectedMetabotId] = useState<number | null>(null);
  const [selectedMetabotLlmId, setSelectedMetabotLlmId] = useState<string | null>(null);
  // Track if we're starting a session to prevent duplicate submissions
  const isStartingRef = useRef(false);
  // Track pending start request so stop can cancel delayed startup.
  const pendingStartRef = useRef<{ requestId: number; cancelled: boolean } | null>(null);
  const startRequestIdRef = useRef(0);
  // Ref for CoworkPromptInput
  const promptInputRef = useRef<CoworkPromptInputRef>(null);

  const {
    currentSession,
    isStreaming,
    config,
    preferredMetabotId,
  } = useSelector((state: RootState) => state.cowork);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const quickActions = useSelector((state: RootState) => state.quickAction.actions);
  const selectedActionId = useSelector((state: RootState) => state.quickAction.selectedActionId);
  const selectedPromptId = useSelector((state: RootState) => state.quickAction.selectedPromptId);

  const loadSelectableMetaBots = useCallback(async (): Promise<{ selectable: MetaBotForSelector[]; localCount: number }> => {
    const [selectorResult, fullListResult] = await Promise.all([
      window.electron?.idbots?.getMetaBots?.(),
      window.electron?.metabot?.list?.(),
    ]);
    const localList = fullListResult?.success && fullListResult.list ? fullListResult.list : [];
    const localCount = localList.length;
    if (!selectorResult?.success || !selectorResult.list) {
      return { selectable: [], localCount };
    }
    if (!fullListResult?.success || !fullListResult.list) {
      return { selectable: selectorResult.list, localCount: selectorResult.list.length };
    }
    const llmConfiguredIds = new Set(
      localList
        .filter((metabot) => metabot.enabled && typeof metabot.llm_id === 'string' && metabot.llm_id.trim())
        .map((metabot) => metabot.id)
    );
    return {
      selectable: selectorResult.list.filter((metabot) => llmConfiguredIds.has(metabot.id)),
      localCount,
    };
  }, []);

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
      const { selectable, localCount } = await loadSelectableMetaBots();
      setMetabots(selectable);
      setLocalMetabotCount(localCount);
      if (selectable.length > 0) {
        const preferred = store.getState().cowork.preferredMetabotId;
        if (preferred != null && selectable.some((m) => m.id === preferred)) {
          setSelectedMetabotId(preferred);
          dispatch(clearPreferredMetabotId());
        }
      }
    };
    void loadMetaBots();
  }, [dispatch, loadSelectableMetaBots]);

  // When user just restored a MetaBot (preferredMetabotId set), refetch list and select it so the new bot appears and is selected
  useEffect(() => {
    if (preferredMetabotId == null) return;
    let cancelled = false;
    const refetchAndSelect = async () => {
      const { selectable, localCount } = await loadSelectableMetaBots();
      if (cancelled) return;
      setMetabots(selectable);
      setLocalMetabotCount(localCount);
      if (selectable.some((m) => m.id === preferredMetabotId)) {
        setSelectedMetabotId(preferredMetabotId);
      }
      dispatch(clearPreferredMetabotId());
    };
    void refetchAndSelect();
    return () => { cancelled = true; };
  }, [preferredMetabotId, dispatch, loadSelectableMetaBots]);

  useEffect(() => {
    if (metabots.length === 0) {
      setSelectedMetabotId(null);
      return;
    }
    if (selectedMetabotId != null && metabots.some((metabot) => metabot.id === selectedMetabotId)) {
      return;
    }
    const twin = metabots.find((metabot) => metabot.metabot_type === 'twin');
    setSelectedMetabotId(twin ? twin.id : metabots[0].id);
  }, [metabots, selectedMetabotId]);

  // Keep selector in sync when opening a session (so "new chat" uses the same MetaBot as the current session)
  useEffect(() => {
    if (currentSession?.metabotId != null && typeof currentSession.metabotId === 'number') {
      setSelectedMetabotId(currentSession.metabotId);
    }
  }, [currentSession?.id, currentSession?.metabotId]);

  useEffect(() => {
    const id = selectedMetabotId;
    if (id == null) {
      setSelectedMetabotLlmId(null);
      return;
    }
    let cancelled = false;
    const fetchMetaBot = async () => {
      const result = await window.electron?.metabot?.get?.(id);
      if (cancelled || !result?.success || !result.metabot) return;
      setSelectedMetabotLlmId(result.metabot.llm_id ?? null);
    };
    void fetchMetaBot();
    return () => { cancelled = true; };
  }, [selectedMetabotId]);

  useEffect(() => {
    const init = async () => {
      await coworkService.init();
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
  }, [dispatch]);

  const buildCombinedSystemPrompt = async (skillPrompt?: string) => {
    const [metaAppPrompt, effectiveSkillPrompt] = await Promise.all([
      metaAppService.getAutoRoutingPrompt(),
      skillPrompt ? Promise.resolve(skillPrompt) : skillService.getAutoRoutingPrompt(),
    ]);
    return [metaAppPrompt, effectiveSkillPrompt, config.systemPrompt]
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

    try {
      if (shouldRouteFirstMetabotCreationToOnboarding(localMetabotCount)) {
        onRequestOnboarding?.();
        return;
      }
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

      const tempSession: CoworkSession = {
        id: tempSessionId,
        title: fallbackTitle,
        claudeSessionId: null,
        status: 'running',
        pinned: false,
        createdAt: now,
        updatedAt: now,
        cwd: config.workingDirectory || '',
        systemPrompt: '',
        executionMode: config.executionMode || 'local',
        activeSkillIds: sessionSkillIds,
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
      // so they don't persist to next session
      dispatch(clearActiveSkills());
      dispatch(clearSelection());

      const combinedSystemPrompt = await buildCombinedSystemPrompt(skillPrompt);

      // Generate title in background while starting session
      const [generatedTitle] = await Promise.all([
        coworkService.generateSessionTitle(prompt).catch(error => {
          console.error('Failed to generate cowork session title:', error);
          return null;
        }),
        // Small delay to ensure UI updates before heavy operations
        new Promise(resolve => setTimeout(resolve, 0)),
      ]);

      if (isPendingStartCancelled()) {
        return;
      }

      const title = generatedTitle?.trim() || fallbackTitle;

      // Start the actual session - this will replace the temp session via addSession
      const startedSession = await coworkService.startSession({
        prompt,
        title,
        cwd: config.workingDirectory || undefined,
        systemPrompt: combinedSystemPrompt,
        activeSkillIds: sessionSkillIds,
        metabotId: selectedMetabotId,
      });

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

  const shouldPromptCreateMetabot = shouldRouteFirstMetabotCreationToOnboarding(localMetabotCount);

  const handleContinueSession = async (prompt: string, skillPrompt?: string) => {
    if (!currentSession) return;

    // Capture active skill IDs before clearing
    const sessionSkillIds = [...activeSkillIds];

    // Clear active skills after capturing so they don't persist to next message
    if (sessionSkillIds.length > 0) {
      dispatch(clearActiveSkills());
    }

    const combinedSystemPrompt = await buildCombinedSystemPrompt(skillPrompt);

    await coworkService.continueSession({
      sessionId: currentSession.id,
      prompt,
      systemPrompt: combinedSystemPrompt,
      activeSkillIds: sessionSkillIds.length > 0 ? sessionSkillIds : undefined,
    });
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
      <div className="flex-1 h-full flex flex-col dark:bg-claude-darkBg bg-claude-bg">
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
          onNavigateHome={() => dispatch(clearCurrentSession())}
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          onNewChat={onNewChat}
          updateBadge={updateBadge}
        />
      </>
    );
  }

  // Home view - no current session
  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
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
          <ModelSelector restrictToLlmId={selectedMetabotLlmId} />
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-6 min-h-full flex flex-col">
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6">
            {/* Welcome Section - centered */}
            <div className="text-center space-y-5">
              <img src="logo.png" alt="logo" className="w-16 h-16 mx-auto" />
              <h2 className="text-3xl font-bold tracking-tight dark:text-claude-darkText text-claude-text">
                {i18nService.t('coworkWelcome')}
              </h2>
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-md mx-auto">
                {i18nService.t('coworkDescription')}
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
              {shouldPromptCreateMetabot && (
                <button
                  type="button"
                  onClick={() => onRequestOnboarding?.()}
                  className="text-sm font-medium text-red-500 transition-colors hover:text-red-400"
                >
                  {i18nService.t('metabotCreateFirstPrompt')}
                </button>
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
            ) : (
              <QuickActionBar actions={quickActions} onActionSelect={handleActionSelect} />
            )}
          </div>
        </div>
      </div>

      {/* Prompt Input Area - Bottom aligned */}
      <div className="p-4 shrink-0">
        <div className="max-w-3xl mx-auto">
          <CoworkPromptInput
            ref={promptInputRef}
            onSubmit={handleStartSession}
            onStop={handleStopSession}
            isStreaming={isStreaming}
            placeholder={i18nService.t('coworkPlaceholder')}
            size="large"
            workingDirectory={config.workingDirectory}
            onWorkingDirectoryChange={async (dir: string) => {
              await coworkService.updateConfig({ workingDirectory: dir });
            }}
            showFolderSelector={true}
            onManageSkills={() => onShowSkills?.()}
          />
        </div>
      </div>
    </div>
  );
};

export default CoworkView;
