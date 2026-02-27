import React, { useEffect, useState, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { ChevronDownIcon, CpuChipIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { clearCurrentSession, setCurrentSession, setStreaming } from '../../store/slices/coworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../../store/slices/skillSlice';
import { setActions, selectAction, clearSelection } from '../../store/slices/quickActionSlice';
import { coworkService } from '../../services/cowork';
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
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium dark:text-claude-darkText text-claude-text shrink-0">
        {label}
      </label>
      <div ref={containerRef} className="relative min-w-[200px]">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center gap-2 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border px-4 py-2.5 text-sm focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/40 cursor-pointer"
          aria-label={placeholder}
        >
          {selected ? (
            <>
              {selected.avatar && (selected.avatar.startsWith('data:') || selected.avatar.startsWith('http')) ? (
                <img src={selected.avatar} alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
              ) : (
                <div className="w-6 h-6 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
                  <CpuChipIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
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
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover z-50 overflow-hidden max-h-48 overflow-y-auto">
            {metabots.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onSelect(m.id);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${selectedId === m.id ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
              >
                {m.avatar && (m.avatar.startsWith('data:') || m.avatar.startsWith('http')) ? (
                  <img src={m.avatar} alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
                ) : (
                  <div className="w-6 h-6 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
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
  onShowSkills?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const CoworkView: React.FC<CoworkViewProps> = ({ onRequestAppSettings, onShowSkills, isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const [isInitialized, setIsInitialized] = useState(false);
  const [metabots, setMetabots] = useState<Array<{ id: number; name: string; avatar: string | null; metabot_type: string }>>([]);
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
  } = useSelector((state: RootState) => state.cowork);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const quickActions = useSelector((state: RootState) => state.quickAction.actions);
  const selectedActionId = useSelector((state: RootState) => state.quickAction.selectedActionId);

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
      const result = await window.electron?.idbots?.getMetaBots?.();
      if (result?.success && result.list && result.list.length > 0) {
        setMetabots(result.list);
        const twin = result.list.find((m) => m.metabot_type === 'twin');
        setSelectedMetabotId(twin ? twin.id : result.list[0].id);
      }
    };
    void loadMetaBots();
  }, []);

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

      // Combine skill prompt with system prompt
      // If no manual skill selected, use auto-routing prompt
      let effectiveSkillPrompt = skillPrompt;
      if (!skillPrompt) {
        effectiveSkillPrompt = await skillService.getAutoRoutingPrompt() || undefined;
      }
      const combinedSystemPrompt = [effectiveSkillPrompt, config.systemPrompt]
        .filter(p => p?.trim())
        .join('\n\n') || undefined;

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

  const handleContinueSession = async (prompt: string, skillPrompt?: string) => {
    if (!currentSession) return;

    // Capture active skill IDs before clearing
    const sessionSkillIds = [...activeSkillIds];

    // Clear active skills after capturing so they don't persist to next message
    if (sessionSkillIds.length > 0) {
      dispatch(clearActiveSkills());
    }

    // Combine skill prompt with system prompt for continuation
    // If no manual skill selected, use auto-routing prompt
    let effectiveSkillPrompt = skillPrompt;
    if (!skillPrompt) {
      effectiveSkillPrompt = await skillService.getAutoRoutingPrompt() || undefined;
    }
    const combinedSystemPrompt = [effectiveSkillPrompt, config.systemPrompt]
      .filter(p => p?.trim())
      .join('\n\n') || undefined;

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

  // Handle quick action button click: select action + activate skill in one batch
  const handleActionSelect = (actionId: string) => {
    dispatch(selectAction(actionId));
    const action = quickActions.find(a => a.id === actionId);
    if (action) {
      const targetSkill = skills.find(s => s.id === action.skillMapping);
      if (targetSkill) {
        dispatch(setActiveSkillIds([targetSkill.id]));
      }
    }
  };

  // When the mapped skill is deactivated from input area, restore the QuickActionBar
  useEffect(() => {
    if (!selectedActionId) return;
    const action = quickActions.find(a => a.id === selectedActionId);
    if (action) {
      const skillStillActive = activeSkillIds.includes(action.skillMapping);
      if (!skillStillActive) {
        dispatch(clearSelection());
      }
    }
  }, [activeSkillIds]);

  // Handle prompt selection from QuickAction
  const handleQuickActionPromptSelect = (prompt: string) => {
    // Fill the prompt into input
    promptInputRef.current?.setValue(prompt);
    promptInputRef.current?.focus();
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
        <div className="max-w-3xl mx-auto px-4 py-16 space-y-12">
          {/* Welcome Section */}
          <div className="text-center space-y-5">
            <img src="logo.png" alt="logo" className="w-16 h-16 mx-auto" />
            <h2 className="text-3xl font-bold tracking-tight dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkWelcome')}
            </h2>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-md mx-auto">
              {i18nService.t('coworkDescription')}
            </p>
          </div>

          {/* MetaBot selector (when creating new session) - shows avatar and name */}
          {metabots.length > 0 && (
            <MetaBotSelector
              metabots={metabots}
              selectedId={selectedMetabotId}
              onSelect={setSelectedMetabotId}
              label={i18nService.t('coworkMetaBotLabel')}
              placeholder={i18nService.t('coworkMetaBotPlaceholder')}
            />
          )}

          {/* Prompt Input Area - Large version with folder selector */}
          <div className="space-y-3">
            <div className="shadow-glow-accent rounded-2xl">
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

          {/* Quick Actions */}
          <div className="space-y-4">
            {selectedAction ? (
              <PromptPanel
                action={selectedAction}
                onPromptSelect={handleQuickActionPromptSelect}
              />
            ) : (
              <QuickActionBar actions={quickActions} onActionSelect={handleActionSelect} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CoworkView;
