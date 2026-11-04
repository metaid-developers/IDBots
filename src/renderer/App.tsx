import React, { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store';
import type { SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import MeBalanceBadge from './components/me/MeBalanceBadge';
import MePurchaseFlow from './components/me/MePurchaseFlow';
import {
  onRequestOpenMePurchase,
  onRequestOpenUsagePage,
  type MePurchaseSection,
} from './components/me/mePointsStore';
import WindowTitleBar from './components/window/WindowTitleBar';
import { CoworkView } from './components/cowork';
import CoworkPermissionOverlay from './components/cowork/CoworkPermissionOverlay';
import AgentGameConsentCard from './components/agentGame/AgentGameConsentCard';
import { configService } from './services/config';
import { localStore } from './services/store';
import { ensureFreeQuotaProvisioning } from './services/llmFreeQuotaBootstrap';
import {
  clearPersistedSession,
  isOnboardingEnterPending,
  loadPersistedViewState,
  savePersistedViewState,
} from './services/viewState';
import { apiService } from './services/api';
import { themeService } from './services/theme';
import { coworkService } from './services/cowork';
import { browserCoworkService } from './services/browserCowork';
import { agentGameService } from './services/agentGame';
import { enqueuePendingConsent, dequeuePendingConsent } from './store/slices/agentGameSlice';
import { scheduledTaskService } from './services/scheduledTask';
import { groupTaskService } from './services/groupTaskService';
import { checkForAppUpdate, type AppUpdateInfo, type AppUpdateDownloadProgress, type ChangeLogEntry, UPDATE_POLL_INTERVAL_MS, UPDATE_HEARTBEAT_INTERVAL_MS } from './services/appUpdate';
import {
  type UpdatePhase,
  modalStateForUpdatePhase,
  resolveCancelDownloadFollowUp,
  resolveConfirmUpdateAction,
  shouldPreserveDownloadProgress,
} from './services/appUpdateUi';
import { defaultConfig, type ModelOptions } from './config';
import { setAvailableModels, setSelectedModel } from './store/slices/modelSlice';
import { setDraftPrompt } from './store/slices/coworkSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import { setActiveSkillIds } from './store/slices/skillSlice';
import { selectTask as selectLongTermTask } from './store/slices/longTermTaskSlice';
import { longTermTaskService } from './services/longTermTask';
import { selectTask as selectGroupTask } from './store/slices/groupTasksSlice';
import type { ApiConfig } from './services/api';
import type { MetaAppRecord } from './types/metaApp';
import type { GroupTaskDetail } from './types/groupTask';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from './services/i18n';
import { matchesShortcut } from './services/shortcuts';
import { metaAppService } from './services/metaApp';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import UpdateChangeLogPanel from './components/update/UpdateChangeLogPanel';
import AppUpdateModal, { type UpdateModalState } from './components/update/AppUpdateModal';
import { openSelectedMetaApp } from './components/metaapps/metaAppLaunch.js';
import { normalizePreselectedSkillId } from './utils/newChatPreselect';
import {
  clampSidebarWidth,
  defaultSidebarWidth,
  loadSidebarWidth,
  sidebarWidthStorageKey,
  type SidebarWidthMode,
} from './utils/sidebarWidth';
import { useBotBrowserShell } from './features/botBrowser/useBotBrowserShell';
import { openBotBrowserConversationInCowork } from './features/botBrowser/conversationNavigationAdapter';
import type { BotBrowserConversationRequest } from './features/botBrowser/types';
import SidebarToggleIcon from './components/icons/SidebarToggleIcon';
import { FREE_PROVIDER_DISPLAY_NAME, LLM_FREE_PROVIDER_KEY } from './services/llmFreeQuotaGate.js';
import {
  loadUpdateNotifications,
  getNotificationForVersion,
  shouldShowNotification,
} from './services/updateNotification';

const UpdateNotificationModal = React.lazy(() => import('./components/UpdateNotificationModal'));

/**
 * Everything the user cannot see on first paint is split into its own chunk:
 * Settings (a 200 kB settings shell behind a click), the non-Co-Work main
 * views, the first-run welcome flow, the new-group-task modal, and — the
 * heaviest of them — the Bot Browser surface, which drags in the ABC browser
 * UI + core (~1.5 MB of vendor code) that nothing else in the app imports.
 *
 * Co-Work, the Sidebar and the shell stay in the startup chunk. Each lazy
 * binding keeps the identifier its import used to have, so every JSX call site
 * is unchanged.
 */
const Settings = React.lazy(() => import('./components/Settings'));
const MetaAppsView = React.lazy(() =>
  import('./components/metaapps').then((module) => ({ default: module.MetaAppsView })));
const ScheduledTasksView = React.lazy(() =>
  import('./components/scheduledTasks').then((module) => ({ default: module.ScheduledTasksView })));
const GroupTasksView = React.lazy(() =>
  import('./components/groupTasks').then((module) => ({ default: module.GroupTasksView })));
const NewGroupTaskModal = React.lazy(() =>
  import('./components/groupTasks').then((module) => ({ default: module.NewGroupTaskModal })));
const MetabotsView = React.lazy(() => import('./components/metabots/MetabotsView'));
const GigSquareView = React.lazy(() => import('./components/gigSquare/GigSquareView'));
const WelcomeFlow = React.lazy(() => import('./components/onboarding/WelcomeFlow'));
const BotBrowserSurface = React.lazy(() =>
  import('./features/botBrowser/BotBrowserSurface').then((module) => ({ default: module.BotBrowserSurface })));

// Shared loading indicator: the startup screen and every lazy view fallback
// render the same mark, so a chunk arriving late looks like the app still
// loading rather than a blank pane.
const AppLoadingIndicator: React.FC = () => (
  <div className="flex-1 h-full flex items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
    <div className="flex flex-col items-center space-y-4">
      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-claude-accent to-claude-accentHover flex items-center justify-center shadow-glow-accent animate-pulse">
        <ChatBubbleLeftRightIcon className="h-8 w-8 text-claude-accentInk" />
      </div>
      <div className="w-24 h-1 rounded-full bg-claude-accent/20 overflow-hidden">
        <div className="h-full w-1/2 rounded-full bg-claude-accent animate-shimmer" />
      </div>
      <div className="dark:text-claude-darkText text-claude-text text-xl font-medium">{i18nService.t('loading')}</div>
    </div>
  </div>
);

type FocusedOrderTarget = {
  sessionId: string;
  orderTxid: string;
};

const normalizeFocusedOrderTxid = (value: unknown): string | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

// Provider label for the redux model list: keys are capitalized wire ids,
// except the built-in free provider, which always shows its canonical label
// (installs provisioned before the rename still store "MetaID Free").
const providerDisplayLabel = (providerKey: string): string => (
  providerKey === LLM_FREE_PROVIDER_KEY
    ? FREE_PROVIDER_DISPLAY_NAME
    : providerKey.charAt(0).toUpperCase() + providerKey.slice(1)
);

// Update phases: idle = none / silent download failed; downloading / applying =
// silent background work (badge + modal stay in sync); ready = downloaded,
// waiting for install; restartReady = macOS silent apply done, waiting restart.

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  // S9 ME points: the shared purchase flow (订阅/充值 人工凭证通道) is one
  // modal mounted here; badge / plan card / settings page open it by event.
  const [mePurchase, setMePurchase] = useState<{ open: boolean; section: MePurchaseSection }>({
    open: false,
    section: 'subscribe',
  });
  // Restored from the persisted view state so a renderer reload (dev HMR,
  // crash recovery, auto-update) does not bounce the user back to the New Task
  // home; the boot effect restores this view's conversation too.
  const [mainView, setMainView] = useState<'cowork' | 'skills' | 'scheduledTasks' | 'groupTasks' | 'metabots'>(
    () => loadPersistedViewState()?.mainView ?? 'cowork',
  );
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  // First-run welcome flow: set during boot when the machine holds no Twin Bot.
  const [showWelcomeFlow, setShowWelcomeFlow] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isNewGroupTaskOpen, setIsNewGroupTaskOpen] = useState(false);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth((key) => window.localStorage.getItem(key), 'home'));
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number; mode: SidebarWidthMode } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateModalState, setUpdateModalState] = useState<UpdateModalState>('info');
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatePhase, setUpdatePhaseState] = useState<UpdatePhase>('idle');
  const updatePhaseRef = useRef<UpdatePhase>('idle');
  // 静默下载失败（非用户取消）时置位，徽章给出可见提示；新一轮下载开始或手动下载成功后清除
  const [silentDownloadFailed, setSilentDownloadFailed] = useState(false);
  const downloadedUpdateFileRef = useRef<{ version: string; filePath: string } | null>(null);
  // User clicked Install while silent download/apply still owns the file.
  const userRequestedInstallRef = useRef(false);
  const installInFlightRef = useRef(false);
  const changeUpdatePhase = useCallback((phase: UpdatePhase) => {
    updatePhaseRef.current = phase;
    setUpdatePhaseState(phase);
  }, []);
  const [focusedOrderTarget, setFocusedOrderTarget] = useState<FocusedOrderTarget | null>(null);
  // Update notification modal state
  const [showUpdateNotification, setShowUpdateNotification] = useState(false);
  const [updateNotificationData, setUpdateNotificationData] = useState<{
    version: string;
    title: string;
    content: string;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const mockUpdateModeRef = useRef(false);
  const mockDownloadTimerRef = useRef<number | null>(null);
  const mockInstallTimerRef = useRef<number | null>(null);
  const openingMetaAppIdsRef = useRef<Set<string>>(new Set());
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);

  // Register cowork stream listeners at app level: permission prompts can
  // arrive while the user is in Bot Browser or any non-cowork view, and they
  // must enqueue even when CoworkView (the usual init site) never mounts.
  useEffect(() => {
    void coworkService.init();
  }, []);
  const pendingConsents = useSelector((state: RootState) => state.agentGame.pendingConsents);
  const pendingConsent = pendingConsents[0] ?? null;
  const isWindows = window.electron.platform === 'win32';
  const isMac = window.electron.platform === 'darwin';
  const focusedOrderTxid = focusedOrderTarget?.sessionId === currentSessionId
    ? focusedOrderTarget.orderTxid
    : null;
  const handleFocusedOrderConsumed = useCallback((orderTxid: string) => {
    const normalizedOrderTxid = normalizeFocusedOrderTxid(orderTxid);
    if (!normalizedOrderTxid) return;
    setFocusedOrderTarget((current) => (
      current?.sessionId === currentSessionId && current.orderTxid === normalizedOrderTxid
        ? null
        : current
    ));
  }, [currentSessionId]);

  const reportRendererStartupComplete = useCallback(async () => {
    try {
      await window.electron.startup.rendererInitialized();
    } catch (error) {
      console.warn('[Startup] Failed to report renderer initialization:', error);
    }
  }, []);

  const checkAndShowUpdateNotification = useCallback(async () => {
    try {
      const currentVersion = await window.electron.appInfo.getVersion();
      // Force-show (dev test path) is consulted first: it must bypass every
      // gate below, including the fresh-install classification.
      const forceShow = await window.electron.updateNotification.shouldForceShow();

      // Resolve (and seed once) the first-install version. An upgrader from
      // <= 1.0.7 — which never recorded the key — is detected main-side from
      // prior data and seeded at the legacy floor instead of the current
      // version; a fresh install seeds at the current version.
      const firstInstallVersion = await window.electron.updateNotification.resolveFirstInstallVersion(currentVersion);
      if (!forceShow && (!firstInstallVersion || firstInstallVersion === currentVersion)) {
        // Fresh install: upgrade notices never apply.
        return;
      }

      // Load notification definitions
      const notificationsData = await loadUpdateNotifications();
      if (!notificationsData) return;

      // Notification for the running version; under force-show, fall back to
      // the newest defined notice so the modal is previewable regardless of
      // which version the announcement targets.
      let notification = getNotificationForVersion(notificationsData, currentVersion);
      if (!notification && forceShow) {
        notification = notificationsData.notifications[notificationsData.notifications.length - 1] ?? null;
      }
      if (!notification) return;

      // Check if already viewed
      const hasViewed = await window.electron.updateNotification.hasViewed(currentVersion);

      // Check if should show (force show bypasses all checks)
      if (forceShow || shouldShowNotification(firstInstallVersion, currentVersion, notification, hasViewed)) {
        const lang = i18nService.getLanguage();
        setUpdateNotificationData({
          version: currentVersion,
          title: notification.title[lang] || notification.title.en,
          content: notification.content[lang] || notification.content.en,
        });
        setShowUpdateNotification(true);
      }
    } catch (error) {
      console.warn('[UpdateNotification] Failed to check update notification:', error);
    }
  }, []);

  const handleCloseUpdateNotification = useCallback(async () => {
    if (updateNotificationData) {
      await window.electron.updateNotification.markAsViewed(updateNotificationData.version);
    }
    setShowUpdateNotification(false);
    setUpdateNotificationData(null);
  }, [updateNotificationData]);

  const clearMockTimers = useCallback(() => {
    if (mockDownloadTimerRef.current != null) {
      window.clearInterval(mockDownloadTimerRef.current);
      mockDownloadTimerRef.current = null;
    }
    if (mockInstallTimerRef.current != null) {
      window.clearTimeout(mockInstallTimerRef.current);
      mockInstallTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearMockTimers();
    };
  }, [clearMockTimers]);

  useEffect(() => {
    if (!isInitialized) return;
    const config = configService.getConfig();
    if (!config.app.isDevelopment) return;
    // The dev start script hardcodes ELECTRON_START_URL, so a ?mockUpdate=1
    // query appended by the launcher is dropped. Also accept a localStorage
    // flag so the mock is reachable regardless of how the URL is built.
    const hasMockFlag = window.location.search.includes('mockUpdate=1')
      || (typeof localStorage !== 'undefined' && localStorage.getItem('idbots_mock_update') === '1');
    if (!hasMockFlag) return;

    mockUpdateModeRef.current = true;

    const mockInfo: AppUpdateInfo = {
      latestVersion: '9.9.9',
      date: '2026-03-11',
      changeLog: {
        zh: {
          title: '更新内容',
          content: ['优化更新流程展示', '修复若干稳定性问题'],
        },
        en: {
          title: 'Changes',
          content: ['Improve update flow preview', 'Fix stability issues'],
        },
      },
      url: 'https://idbots.ai/downloads/IDBots-latest',
    };

    setUpdateInfo(mockInfo);
    setUpdateError(null);
    setDownloadProgress(null);
    // 模拟静默下载已完成：Windows 进入待安装，macOS 进入待重启；点击徽章打开对应弹窗
    downloadedUpdateFileRef.current = { version: mockInfo.latestVersion, filePath: '/tmp/mock-idbots-update' };
    changeUpdatePhase(window.electron.platform === 'darwin' ? 'restartReady' : 'ready');
  }, [isInitialized, changeUpdatePhase]);

  // Keep the in-memory app_config aligned with main-side rewrites. The relay
  // identity closeout (user identity import/create) blanks and re-issues the
  // metaid-free provider key directly in the store; without this reload the
  // renderer kept the previous identity's key in memory and the next
  // updateConfig wrote it straight back over the repaired row.
  useEffect(() => {
    const unsubscribe = localStore.onChanged(({ key }) => {
      if (key === 'app_config') {
        void configService.reloadFromStore();
      }
    });
    return unsubscribe;
  }, []);

  // 初始化应用
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      try {
        // 标记平台，用于 CSS 条件样式（如 Windows 标题栏按钮区域留白）
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        // 初始化配置
        await configService.init();

        // 初始化主题
        // Depends only on the config just loaded (config.theme), so it applies
        // before the provisioning round-trips below instead of after them: the
        // window is themed as soon as the config is in memory.
        themeService.initialize();

        // First-run free-quota bootstrap: provisions the built-in metaid-free
        // provider (identity-signed relay key) before the welcome flow can
        // create any bot, so a fresh install gets a working brain. Never
        // throws; on failure the welcome flow falls back to the configured
        // default model or reports the failure in its own retry UI.
        await ensureFreeQuotaProvisioning();

        // 初始化语言
        // Stays strictly AFTER provisioning: initialize() captures the whole
        // config and writes that snapshot back, so overlapping it with
        // provisioning's provider write would revert the provisioned provider.
        await i18nService.initialize();

        // Read the config once for the whole init path. getConfig() returns the
        // already-loaded in-memory config synchronously (init() populated it),
        // so this is a plain read, not an awaited round-trip.
        const config = configService.getConfig();

        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        // 从 providers 配置中加载可用模型列表到 Redux
        const providerModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean; options?: ModelOptions }[] = [];
        if (config.providers) {
          Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
            if (providerConfig.enabled && providerConfig.models) {
              providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean; options?: ModelOptions }) => {
                providerModels.push({
                  id: model.id,
                  name: model.name,
                  provider: providerDisplayLabel(providerName),
                  providerKey: providerName,
                  supportsImage: model.supportsImage ?? false,
                  options: model.options,
                });
              });
            }
          });
        }
        const fallbackModels = config.model.availableModels.map(model => ({
          id: model.id,
          name: model.name,
          supportsImage: model.supportsImage ?? false,
          options: model.options,
          // Legacy availableModels carry no provider association.
          providerKey: undefined as string | undefined,
        }));
        const resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        if (resolvedModels.length > 0) {
          dispatch(setAvailableModels(resolvedModels));
          // Prefer the model the stored defaultProvider points to: a restart
          // must not silently switch a chosen provider's model to another
          // provider that happens to offer the same model id.
          const preferredModel = resolvedModels.find(
            (model) => model.id === config.model.defaultModel && model.providerKey === config.model.defaultProvider
          ) ?? resolvedModels.find(model => model.id === config.model.defaultModel) ?? resolvedModels[0];
          dispatch(setSelectedModel(preferredModel));
        }
        
        // 初始化定时任务服务
        // The three boards are mutually independent: separate IPC channels,
        // separate Redux slices, and none of them reads the config or i18n
        // state that the awaits above settle. Running them together collapses
        // their serial IPC round-trips into one wait.
        await Promise.all([
          scheduledTaskService.init(),
          groupTaskService.init(),
          // Long-term board data must be live BEFORE the board is ever opened:
          // the sidebar's 跟踪任务 amber dot and the 长期任务 tab badge both read
          // this board, and the badge has to work on a machine where the tab was
          // never opened. init() is idempotent, so the board component keeps its
          // own init call as a harmless fallback.
          longTermTaskService.init(),
        ]);

        // First-run gate: a machine with no Twin Bot gets the two-screen
        // welcome flow instead of the app shell. Keying off the Twin rather
        // than a persisted "onboarding done" flag also covers installs that
        // only have the legacy welcome bot. A roster read that fails leaves
        // the app usable (no welcome flow) rather than trapping the user in it.
        // An unfinished "Enter IDBots" click also re-offers the flow: the Twin
        // was created but the greeting chat never was (the renderer reloaded in
        // between), and the flow's Enter adopts that Twin instead of making
        // another one.
        let hasTwin = true;
        try {
          const roster = await window.electron.metabot.list();
          const bots = roster?.success && Array.isArray(roster.list) ? roster.list : [];
          hasTwin = bots.some((bot) => bot.metabot_type === 'twin');
        } catch {
          hasTwin = true;
        }
        const needsWelcomeFlow = !hasTwin || isOnboardingEnterPending();
        setShowWelcomeFlow(needsWelcomeFlow);

        // Bring back the conversation the persisted view state points at, so a
        // renderer reload lands on the chat the user was in instead of the New
        // Task home. The welcome flow owns the screen on a first-run machine,
        // and a stored id that no longer loads (archived / deleted / stale
        // `temp-…`) is dropped rather than retried on every reload.
        const storedSessionId = needsWelcomeFlow ? null : loadPersistedViewState()?.sessionId ?? null;
        if (storedSessionId) {
          const restored = await coworkService.loadSession(storedSessionId).catch(() => null);
          if (!restored) {
            clearPersistedSession();
          }
        }
        setIsInitialized(true);
        void reportRendererStartupComplete();

        // Check and show update notification if needed
        void checkAndShowUpdateNotification();
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
        void reportRendererStartupComplete();
      }
    };

    initializeApp();
  }, []);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Persist the active view + open conversation so a renderer reload returns
  // the user where they were (see services/viewState). Skipped until boot has
  // settled and while the welcome flow owns the screen: the stored value is
  // only ever written from a state the user actually reached.
  useEffect(() => {
    if (!isInitialized || showWelcomeFlow) return;
    savePersistedViewState({
      mainView: mainView === 'skills' ? 'cowork' : mainView,
      sessionId: currentSessionId,
    });
  }, [isInitialized, showWelcomeFlow, mainView, currentSessionId]);

  // The Twin Bot chat already exists (one generated greeting): land in it. The
  // session is pulled into the store before the flag flips, so the shell never
  // paints the New Task page for a frame; the session list is reloaded so the
  // sidebar shows the new chat.
  const handleWelcomeFlowEnter = useCallback(async (sessionId: string) => {
    try {
      await coworkService.loadSessions();
      await coworkService.loadSession(sessionId);
    } finally {
      setMainView('cowork');
      setShowWelcomeFlow(false);
    }
  }, []);

  // Escape hatch: the user entered without creating a bot (creation failed or
  // they chose to skip). The welcome flow shows again on the next launch
  // because the Twin still does not exist.
  const handleWelcomeFlowSkip = useCallback(() => {
    setMainView('cowork');
    setShowWelcomeFlow(false);
  }, []);

  useEffect(() => {
    if (!isInitialized || !selectedModel?.id) return;
    const config = configService.getConfig();
    const wantsProvider = selectedModel.providerKey ? selectedModel.providerKey : null;
    const providerUnchanged = wantsProvider === null || config.model.defaultProvider === wantsProvider;
    if (config.model.defaultModel === selectedModel.id && providerUnchanged) return;
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: selectedModel.id,
        ...(wantsProvider ? { defaultProvider: wantsProvider } : {}),
      },
    });
  }, [isInitialized, selectedModel?.id, selectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions({
      initialTab: options?.initialTab,
      notice: options?.notice,
      openNewProjectForm: options?.openNewProjectForm,
    });
    setShowSettings(true);
  }, []);

  // S9 ME points ripples: badge / plan card open the shared purchase modal
  // and the merged 「用量 & 积分」 page (the settings traffic tab).
  useEffect(
    () =>
      onRequestOpenMePurchase((section) => {
        setMePurchase({ open: true, section });
      }),
    [],
  );
  useEffect(
    () =>
      onRequestOpenUsagePage(() => {
        handleShowSettings({ initialTab: 'traffic' });
      }),
    [handleShowSettings],
  );

  const handleShowSkills = useCallback(() => {
    handleShowSettings({ initialTab: 'skills' });
  }, [handleShowSettings]);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const handleShowScheduledTasks = useCallback(() => {
    setMainView('scheduledTasks');
  }, []);

  const handleShowGroupTasks = useCallback(() => {
    setMainView('groupTasks');
  }, []);

  const handleNewGroupTask = useCallback(() => {
    setIsNewGroupTaskOpen(true);
  }, []);

  const handleGroupTaskCreated = useCallback((task: GroupTaskDetail) => {
    setIsNewGroupTaskOpen(false);
    setMainView('groupTasks');
    dispatch(selectGroupTask(task.id));
  }, [dispatch]);

  const handleShowMetabots = useCallback(() => {
    setMainView('metabots');
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isSidebarResizing) return;
    const handleMove = (event: MouseEvent) => {
      const start = sidebarResizeRef.current;
      if (!start) return;
      setSidebarWidth(clampSidebarWidth(start.startWidth + event.clientX - start.startX));
    };
    const handleUp = () => {
      const start = sidebarResizeRef.current;
      setIsSidebarResizing(false);
      sidebarResizeRef.current = null;
      setSidebarWidth((width) => {
        window.localStorage.setItem(sidebarWidthStorageKey(start?.mode ?? 'home'), String(width));
        return width;
      });
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isSidebarResizing]);

  const handleNewChat = useCallback((preselectSkillId?: unknown, draftText?: string) => {
    const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
    const normalizedPreselectSkillId = normalizePreselectedSkillId(preselectSkillId);
    coworkService.clearSession();
    dispatch(clearSelection());
    if (normalizedPreselectSkillId) {
      dispatch(setActiveSkillIds([normalizedPreselectSkillId]));
    }
    // 带草稿的新对话：先落全局草稿（无 scope 的 composer 挂载时会读它——
    // focus-input 可能在 composer 挂载前派发，store 是晚挂载场景的兜底）。
    if (draftText) {
      dispatch(setDraftPrompt(draftText));
    }
    setMainView('cowork');
    window.setTimeout(() => {
      const dispatchFocus = () => {
        window.dispatchEvent(new CustomEvent('cowork:focus-input', {
          detail: { clear: shouldClearInput, text: draftText },
        }));
      };
      dispatchFocus();
      // composer 可能在本派发之后才挂载（会话状态异步就绪）：短暂重发直到
      // textarea 拿到焦点（handleFocusInput 对同一文本幂等）。
      let tries = 0;
      const retry = window.setInterval(() => {
        tries += 1;
        if (document.activeElement instanceof HTMLTextAreaElement || tries >= 10) {
          window.clearInterval(retry);
          return;
        }
        dispatchFocus();
      }, 200);
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const handleBlankNewChat = useCallback(() => {
    handleNewChat();
  }, [handleNewChat]);

  const handleStartTaskWithMetaApp = useCallback(async (app: MetaAppRecord) => {
    if (openingMetaAppIdsRef.current.has(app.id)) {
      return;
    }

    openingMetaAppIdsRef.current.add(app.id);
    try {
      await openSelectedMetaApp({ app, metaAppService });
    } finally {
      openingMetaAppIdsRef.current.delete(app.id);
    }
  }, []);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  const botBrowserShell = useBotBrowserShell({
    showToast,
  });

  const handleShowMetaApps = useCallback(() => {
    botBrowserShell.selectInternetPane('metaapps');
  }, [botBrowserShell.selectInternetPane]);

  const handleSidebarResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
      mode: botBrowserShell.surfaceMode,
    };
    setIsSidebarResizing(true);
  }, [sidebarWidth, botBrowserShell.surfaceMode]);

  const handleSidebarResizeReset = useCallback(() => {
    const mode = botBrowserShell.surfaceMode;
    const width = defaultSidebarWidth(mode);
    setSidebarWidth(width);
    window.localStorage.setItem(sidebarWidthStorageKey(mode), String(width));
  }, [botBrowserShell.surfaceMode]);

  // Bot Home and Bot Internet keep independent widths: restore the surface's own
  // comfortable width on every mode switch.
  useEffect(() => {
    setSidebarWidth(loadSidebarWidth((key) => window.localStorage.getItem(key), botBrowserShell.surfaceMode));
  }, [botBrowserShell.surfaceMode]);

  useEffect(() => {
    return window.electron.botBrowser.onOpenUri((input) => {
      void botBrowserShell.openUri(input);
    });
  }, [botBrowserShell.openUri]);

  // In-renderer requests (e.g. clickable metaid:// metaapp:// links in the
  // Co-Work panel) ride a DOM event to reach the shell. Every dispatcher on
  // this channel is a user click, so the URI opens a NEW browser tab instead
  // of replacing the tab the user is reading; an explicit newTab: false in the
  // detail opts back into navigate-in-place. An optional actorId seeds the
  // tab's acting identity (an embedded MetaApp hands off with the session Bot
  // so the Browser tab signs as the same Actor the bubble did).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ uri?: unknown; newTab?: unknown; actorId?: unknown }>).detail;
      const uri = detail?.uri;
      if (typeof uri === 'string' && uri.trim()) {
        const actorId = typeof detail?.actorId === 'string' && detail.actorId.trim() ? detail.actorId.trim() : undefined;
        void botBrowserShell.openUri({ uri: uri.trim(), actorId, newTab: detail?.newTab !== false });
      }
    };
    window.addEventListener('botBrowser:openUri', handler);
    return () => window.removeEventListener('botBrowser:openUri', handler);
  }, [botBrowserShell.openUri]);

  // 「长期任务 → 新建任务」：切到 cowork 新对话并预填 composer 草稿。草稿文本
  // 只走 focus-input 的 detail，由 CoworkPromptInput 在清空逻辑之后经版本化
  // 草稿字段写入并落回 setDraftPrompt。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      const text = typeof detail?.text === 'string' && detail.text.trim() ? detail.text : undefined;
      handleNewChat(undefined, text);
    };
    window.addEventListener('cowork:newChatWithDraft', handler);
    return () => window.removeEventListener('cowork:newChatWithDraft', handler);
  }, [handleNewChat]);

  useEffect(() => {
    return window.electron.botBrowser.onTabCommand(({ requestId, command }) => {
      void botBrowserShell.controlTabs(command).then(
        (result) => {
          window.electron.botBrowser.respondToTabCommand({
            requestId,
            success: true,
            result,
          });
        },
        (error) => {
          window.electron.botBrowser.respondToTabCommand({
            requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    });
  }, [botBrowserShell.controlTabs]);

  const handleShowLogin = useCallback(() => {
    showToast(i18nService.t('featureInDevelopment'));
  }, [showToast]);

  const resolveDownloadedFilePath = useCallback((): string | null => {
    if (!updateInfo) return null;
    return downloadedUpdateFileRef.current?.version === updateInfo.latestVersion
      ? downloadedUpdateFileRef.current.filePath
      : null;
  }, [updateInfo]);

  const installDownloadedUpdate = useCallback(async (filePath?: string) => {
    if (installInFlightRef.current) return;
    const downloadedFile = filePath || resolveDownloadedFilePath();
    if (!downloadedFile) {
      setUpdateModalState('error');
      setUpdateError(i18nService.t('updateInstallFailed'));
      return;
    }
    installInFlightRef.current = true;
    setUpdateModalState('installing');
    setUpdateError(null);
    try {
      const installResult = await window.electron.appUpdate.install(downloadedFile);
      if (!installResult.success) {
        setUpdateModalState('error');
        setUpdateError(installResult.error || i18nService.t('updateInstallFailed'));
      }
    } catch (error) {
      setUpdateModalState('error');
      setUpdateError(error instanceof Error ? error.message : i18nService.t('updateInstallFailed'));
    } finally {
      installInFlightRef.current = false;
    }
  }, [resolveDownloadedFilePath]);

  const startSilentDownload = useCallback(async (info: AppUpdateInfo) => {
    userRequestedInstallRef.current = false;
    changeUpdatePhase('downloading');
    setDownloadProgress(null);
    setSilentDownloadFailed(false);
    const unsubscribe = window.electron.appUpdate.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });
    try {
      const downloadResult = await window.electron.appUpdate.download(info.url, info.latestVersion, info.sha256);
      unsubscribe();
      if (!downloadResult.success || !downloadResult.filePath) {
        console.warn('[AppUpdate] Silent download failed:', downloadResult.error);
        if (downloadResult.error !== 'Download cancelled') {
          setSilentDownloadFailed(true);
        }
        changeUpdatePhase('idle');
        return;
      }
      downloadedUpdateFileRef.current = { version: info.latestVersion, filePath: downloadResult.filePath };

      if (window.electron.platform === 'darwin') {
        changeUpdatePhase('applying');
        try {
          const applyResult = await window.electron.appUpdate.applySilent(downloadResult.filePath);
          if (applyResult.success) {
            userRequestedInstallRef.current = false;
            changeUpdatePhase('restartReady');
            return;
          }
          console.warn('[AppUpdate] Silent apply failed:', applyResult.error);
        } catch (applyError) {
          console.warn('[AppUpdate] Silent apply error:', applyError);
        }
      }
      changeUpdatePhase('ready');
      if (userRequestedInstallRef.current) {
        userRequestedInstallRef.current = false;
        void installDownloadedUpdate(downloadResult.filePath);
      }
    } catch (error) {
      unsubscribe();
      console.warn('[AppUpdate] Silent download error:', error);
      setSilentDownloadFailed(true);
      changeUpdatePhase('idle');
    }
  }, [changeUpdatePhase, installDownloadedUpdate]);

  const runUpdateCheck = useCallback(async () => {
    if (mockUpdateModeRef.current) {
      return;
    }
    const phase = updatePhaseRef.current;
    // 静默下载/替换进行中，或已替换待重启时，不再重复检查
    if (phase === 'downloading' || phase === 'applying' || phase === 'restartReady') {
      return;
    }
    try {
      const currentVersion = await window.electron.appInfo.getVersion();
      const nextUpdate = await checkForAppUpdate(currentVersion);
      if (!nextUpdate) {
        // 服务器端无更新：仅在本地没有待处理的已下载更新时清理提示
        if (!downloadedUpdateFileRef.current) {
          setUpdateInfo(null);
          setShowUpdateModal(false);
        }
        return;
      }
      if (downloadedUpdateFileRef.current?.version === nextUpdate.latestVersion) {
        return;
      }
      setUpdateInfo(nextUpdate);
      void startSilentDownload(nextUpdate);
    } catch (error) {
      console.error('Failed to check app update:', error);
    }
  }, [startSilentDownload]);

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;
    setUpdateModalState(modalStateForUpdatePhase(updatePhase));
    setUpdateError(null);
    if (!shouldPreserveDownloadProgress(updatePhase)) {
      setDownloadProgress(null);
    }
    setShowUpdateModal(true);
  }, [updateInfo, updatePhase]);

  // Keep an already-open modal in lockstep with silent download/apply so it
  // never sits at 100% with only Cancel after the background flow has moved on.
  useEffect(() => {
    if (!showUpdateModal) return;

    if (updatePhase === 'restartReady') {
      userRequestedInstallRef.current = false;
      setUpdateModalState((current) => (current === 'error' ? current : 'restart'));
      return;
    }

    if (updatePhase === 'applying') {
      setUpdateModalState((current) => (current === 'error' ? current : 'installing'));
      return;
    }

    if (updatePhase === 'ready') {
      if (userRequestedInstallRef.current) {
        userRequestedInstallRef.current = false;
        void installDownloadedUpdate();
        return;
      }
      setUpdateModalState((current) => {
        if (current === 'error') return current;
        if (installInFlightRef.current) return current;
        if (current === 'downloading' || current === 'installing') return 'info';
        return current;
      });
      return;
    }

    if (updatePhase === 'idle') {
      userRequestedInstallRef.current = false;
      setUpdateModalState((current) => {
        if (current === 'downloading' || current === 'installing') return 'info';
        return current;
      });
    }
  }, [showUpdateModal, updatePhase, installDownloadedUpdate]);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    if (mockUpdateModeRef.current) {
      setShowUpdateModal(false);
      return;
    }

    const action = resolveConfirmUpdateAction({
      phase: updatePhaseRef.current,
      modalState: updateModalState,
      downloadedFilePath: resolveDownloadedFilePath(),
    });

    if (action.type === 'relaunch') {
      await window.electron.appUpdate.relaunchNow();
      return;
    }

    if (action.type === 'showRestart') {
      userRequestedInstallRef.current = false;
      setUpdateModalState('restart');
      return;
    }

    if (action.type === 'waitForSilentApply') {
      userRequestedInstallRef.current = true;
      setUpdateModalState('installing');
      return;
    }

    if (action.type === 'installLocal') {
      userRequestedInstallRef.current = false;
      await installDownloadedUpdate();
      return;
    }

    setUpdateModalState('downloading');
    setDownloadProgress(null);
    setUpdateError(null);

    const unsubscribe = window.electron.appUpdate.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      const downloadResult = await window.electron.appUpdate.download(updateInfo.url, updateInfo.latestVersion, updateInfo.sha256);
      unsubscribe();

      if (!downloadResult.success) {
        if (downloadResult.error === 'Download cancelled') {
          return;
        }
        setUpdateModalState('error');
        setUpdateError(downloadResult.error || i18nService.t('updateDownloadFailed'));
        return;
      }

      if (downloadResult.filePath) {
        downloadedUpdateFileRef.current = { version: updateInfo.latestVersion, filePath: downloadResult.filePath };
        setSilentDownloadFailed(false);
      }

      setUpdateModalState('installing');
      const installResult = await window.electron.appUpdate.install(downloadResult.filePath!);

      if (!installResult.success) {
        setUpdateModalState('error');
        setUpdateError(installResult.error || i18nService.t('updateInstallFailed'));
      }
    } catch (error) {
      unsubscribe();
      const msg = error instanceof Error ? error.message : '';
      if (msg === 'Download cancelled') {
        return;
      }
      setUpdateModalState('error');
      setUpdateError(msg || i18nService.t('updateDownloadFailed'));
    }
  }, [updateInfo, updateModalState, resolveDownloadedFilePath, installDownloadedUpdate]);

  const handleCancelDownload = useCallback(async () => {
    const result = await window.electron.appUpdate.cancelDownload();
    const followUp = resolveCancelDownloadFollowUp({
      phase: updatePhaseRef.current,
      downloadWasActive: Boolean(result?.success),
    });
    if (followUp.type === 'resetToInfo') {
      userRequestedInstallRef.current = false;
      setUpdateModalState('info');
      setDownloadProgress(null);
      return;
    }
    setUpdateModalState(followUp.modalState);
    if (followUp.modalState !== 'downloading') {
      setDownloadProgress(null);
    }
  }, []);

  const handleRetryUpdate = useCallback(() => {
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
  }, []);

  const handleConsentResponse = useCallback(
    async (approved: boolean, reason?: string) => {
      const current = pendingConsent;
      if (!current) return;
      dispatch(dequeuePendingConsent({ requestId: current.requestId }));
      await agentGameService.respondConsent(current.requestId, approved, reason);
    },
    [pendingConsent, dispatch],
  );

  // Agent-Game-v2: subscribe to consent cards + session updates (toast on transitions).
  useEffect(() => {
    const cleanup = agentGameService.setupListeners({
      onConsentRequired: (info) => dispatch(enqueuePendingConsent(info)),
      onSessionUpdated: (session) => {
        const tag = `Agent-Game ${session.gameId}`;
        if (session.status === 'running') showToast(`${tag}: session running`);
        else if (session.status === 'paused') showToast(`${tag}: paused${session.lastError ? ` (${session.lastError.code})` : ''}`);
        else if (session.status === 'finished') showToast(`${tag}: match finished`);
        else if (session.status === 'stopped') showToast(`${tag}: session stopped`);
        else if (session.status === 'error') showToast(`${tag}: error${session.lastError ? ` (${session.lastError.code})` : ''}`);
      },
    });
    // Re-hydrate any consent cards that arrived before the listener attached.
    void agentGameService.listPendingConsent().then((cards) => {
      cards.forEach((card) => dispatch(enqueuePendingConsent(card)));
    });
    return cleanup;
  }, [dispatch, showToast]);

  const handleBrowserOpenConversation = useCallback(async (request: BotBrowserConversationRequest) => {
    await openBotBrowserConversationInCowork(request, {
      switchToHome: botBrowserShell.switchToHome,
      showCowork: handleShowCowork,
      showToast,
    });
  }, [botBrowserShell.switchToHome, handleShowCowork, showToast]);

  // A browser-type session listed in the Bot Home history opens back in the Bot
  // Browser co-work panel: switch to that surface first, then point the panel at
  // the selected session. (Home history shows browser chats so they always have
  // an entry point; the panel is still where they run.)
  const handleSelectBrowserSession = useCallback(async (sessionId: string) => {
    await botBrowserShell.openBrowserHome();
    await browserCoworkService.loadSession(sessionId);
  }, [botBrowserShell.openBrowserHome]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    window.dispatchEvent(new CustomEvent('app:settingsClosed'));
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean; options?: ModelOptions }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean; options?: ModelOptions }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerDisplayLabel(providerName),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
              options: model.options,
            });
          });
        }
      });
      if (allModels.length > 0) {
        dispatch(setAvailableModels(allModels));
      }
    }
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      if (matchesShortcut(event, activeShortcuts.newChat)) {
        event.preventDefault();
        handleBlankNewChat();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.search)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:search'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.settings)) {
        event.preventDefault();
        handleShowSettings();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleShowSettings, handleBlankNewChat]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      if (message) showToast(message);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // 监听托盘菜单打开设置的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.appEvents.onOpenSettings(() => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // 监听托盘菜单新建任务的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.appEvents.onNewTask(() => {
      handleBlankNewChat();
    });
    return unsubscribe;
  }, [handleBlankNewChat]);

  // 监听定时任务查看会话事件
  useEffect(() => {
    const handleViewSession = async (event: Event) => {
      const { sessionId } = (event as CustomEvent).detail;
      if (sessionId) {
        setFocusedOrderTarget(null);
        setMainView('cowork');
        await coworkService.loadSession(sessionId);
      }
    };
    window.addEventListener('scheduledTask:viewSession', handleViewSession);
    return () => window.removeEventListener('scheduledTask:viewSession', handleViewSession);
  }, []);

  // 监听「打开看板里的这个长期任务」事件（会话侧 chip → 跟踪任务页）
  useEffect(() => {
    const handleViewLongTermTask = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {};
      const taskId = typeof detail.taskId === 'string' ? detail.taskId.trim() : '';
      if (!taskId) return;
      botBrowserShell.switchToHome();
      setMainView('scheduledTasks');
      dispatch(selectLongTermTask(taskId));
      void longTermTaskService.loadTask(taskId);
    };
    window.addEventListener('longtermTask:viewTask', handleViewLongTermTask);
    return () => window.removeEventListener('longtermTask:viewTask', handleViewLongTermTask);
  }, [botBrowserShell.switchToHome, dispatch]);

  useEffect(() => {
    const handleViewSession = async (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {};
      const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId.trim() : '';
      const orderTxid = normalizeFocusedOrderTxid(detail.focusedOrderTxid ?? detail.orderTxid);
      if (sessionId) {
        setFocusedOrderTarget(orderTxid ? { sessionId, orderTxid } : null);
        botBrowserShell.switchToHome();
        setMainView('cowork');
        await coworkService.loadSession(sessionId);
      }
    };
    window.addEventListener('cowork:viewSession', handleViewSession);
    return () => window.removeEventListener('cowork:viewSession', handleViewSession);
  }, [botBrowserShell.switchToHome]);

  useEffect(() => {
    if (!isInitialized) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async () => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < UPDATE_POLL_INTERVAL_MS) return;
      lastCheckTime = now;
      await runUpdateCheck();
    };

    void maybeCheck();

    const timer = window.setInterval(() => {
      void maybeCheck();
    }, UPDATE_HEARTBEAT_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeCheck();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, runUpdateCheck]);

  const isOverlayActive = showSettings || showUpdateModal || pendingConsents.length > 0;
  // 按当前 UI 语言解析更新说明（该语言无内容时回退到另一种语言），用于悬停徽章时展示
  const isEmptyChangeLog = (log?: ChangeLogEntry): boolean => !log?.title && !(log?.content?.length > 0);
  const updateChangeLog: ChangeLogEntry | null = (() => {
    if (!updateInfo) return null;
    const lang = i18nService.getLanguage();
    const zh = updateInfo.changeLog.zh;
    const en = updateInfo.changeLog.en;
    const preferred = lang === 'zh' ? zh : en;
    if (!isEmptyChangeLog(preferred)) return preferred;
    if (!isEmptyChangeLog(zh)) return zh;
    if (!isEmptyChangeLog(en)) return en;
    return null;
  })();
  // 静默下载中显示带进度的徽章（非打扰式后台状态）；静默替换中隐藏；就绪/待重启时显示徽章；
  // 静默下载失败时以警示色显示，提示将自动重试
  const updateBadge = updateInfo && updatePhase !== 'applying' ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      label={
        updatePhase === 'restartReady'
          ? i18nService.t('updateReadyPill')
          : silentDownloadFailed
            ? i18nService.t('updateDownloadFailedPill')
            : undefined
      }
      tone={silentDownloadFailed ? 'error' : undefined}
      progress={updatePhase === 'downloading' ? downloadProgress : null}
      onClick={handleOpenUpdateModal}
      hoverPanel={updateChangeLog ? (
        <UpdateChangeLogPanel
          version={updateInfo.latestVersion}
          date={updateInfo.date}
          changeLog={updateChangeLog}
        />
      ) : undefined}
    />
  ) : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <div className="draggable relative h-9 shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      <WindowTitleBar isOverlayActive={isOverlayActive} />
    </div>
  ) : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <AppLoadingIndicator />
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium text-center">{initError}</div>
            <button
              onClick={() => handleShowSettings()}
              className="btn-idchat-primary px-6 py-2.5 text-sm font-medium"
            >
              {i18nService.t('openSettings')}
            </button>
          </div>
          {showSettings && (
            <Suspense fallback={null}>
              <Settings
                onClose={handleCloseSettings}
                initialTab={settingsOptions.initialTab}
                notice={settingsOptions.notice}
                openNewProjectForm={settingsOptions.openNewProjectForm}
              />
            </Suspense>
          )}
        </div>
      </div>
    );
  }

  if (showWelcomeFlow) {
    return (
      <Suspense fallback={<AppLoadingIndicator />}>
        <WelcomeFlow onEnterWithBot={handleWelcomeFlowEnter} onEnterWithoutBot={handleWelcomeFlowSkip} />
      </Suspense>
    );
  }

  const homeContent = mainView === 'scheduledTasks' ? (
    <ScheduledTasksView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : mainView === 'groupTasks' ? (
    <GroupTasksView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      onNewGroupTask={handleNewGroupTask}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : mainView === 'metabots' ? (
    <MetabotsView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
      onRequestModelSettings={() => handleShowSettings({ initialTab: 'model' })}
      onOpenMetabotInBrowser={botBrowserShell.openLocalMetabot}
      onPreviewMetaAppHomepage={botBrowserShell.openMetaAppByPin}
      onRequestMetaApps={handleShowMetaApps}
    />
  ) : (
    <CoworkView
      onRequestAppSettings={handleShowSettings}
      onShowSkills={handleShowSkills}
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
      focusedOrderTxid={focusedOrderTxid}
      onFocusedOrderConsumed={handleFocusedOrderConsumed}
      onOpenBotInBrowser={botBrowserShell.openRemoteBot}
    />
  );

  const internetCatalogContent = botBrowserShell.internetPane === 'gigSquare' ? (
    <GigSquareView onOpenRemoteBotInBrowser={botBrowserShell.openRemoteBot} />
  ) : botBrowserShell.internetPane === 'metaapps' ? (
    <MetaAppsView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleNewChat}
      onOpenMetaAppInBrowser={botBrowserShell.openMetaApp}
      onPreviewMetaAppByPin={botBrowserShell.openMetaAppByPin}
      onStartTaskWithMetaApp={handleStartTaskWithMetaApp}
      onOpenBotInBrowser={botBrowserShell.openRemoteBot}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : null;

  const showHomeSurface = botBrowserShell.surfaceMode === 'home';
  const showInternetCatalog = botBrowserShell.surfaceMode === 'browser' && !botBrowserShell.isBrowserPaneVisible;

  return (
    <div className="relative h-screen overflow-hidden flex dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
      {/* S9: 免费额度 token 口径横幅下线；全局 ME 余额角标取而代之（顶栏右上，同源）。 */}
      <div className="fixed right-4 top-3 z-[85] non-draggable">
        <MeBalanceBadge />
      </div>
      <MePurchaseFlow
        open={mePurchase.open}
        section={mePurchase.section}
        onSectionChange={(section) => setMePurchase((prev) => ({ ...prev, section }))}
        onClose={() => setMePurchase((prev) => ({ ...prev, open: false }))}
      />
      <CoworkPermissionOverlay
        inlineSessionId={mainView === 'cowork' && showHomeSurface ? currentSessionId : null}
      />
      {isNewGroupTaskOpen && (
        <Suspense fallback={null}>
          <NewGroupTaskModal
            onClose={() => setIsNewGroupTaskOpen(false)}
            onCreated={handleGroupTaskCreated}
          />
        </Suspense>
      )}
      <Sidebar
        onShowLogin={handleShowLogin}
        onShowSettings={handleShowSettings}
        activeView={mainView}
        onShowSkills={handleShowSkills}
        onShowCowork={handleShowCowork}
        onShowScheduledTasks={handleShowScheduledTasks}
        onShowGroupTasks={handleShowGroupTasks}
        onShowMetabots={handleShowMetabots}
        onNewChat={handleBlankNewChat}
        mode={botBrowserShell.surfaceMode}
        internetPane={botBrowserShell.internetPane}
        onSelectHome={botBrowserShell.switchToHome}
        onSelectBrowser={() => {
          void botBrowserShell.openBrowserHome();
        }}
        onSelectInternetPane={botBrowserShell.selectInternetPane}
        onSelectBrowserSession={handleSelectBrowserSession}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
        width={sidebarWidth}
        isResizing={isSidebarResizing}
        updateBadge={!isSidebarCollapsed ? updateBadge : null}
      />
      {!isSidebarCollapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={handleSidebarResizeReset}
          className="w-1 shrink-0 cursor-col-resize transition-colors hover:bg-claude-accent/40"
        />
      ) : null}
      {/* While resizing, cover the content area so the Bot Browser iframe cannot
          swallow mousemove/mouseup events mid-drag (iframe event capture made the
          handle nearly undraggable in browser mode). */}
      {isSidebarResizing ? (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      ) : null}
      <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
        {showHomeSurface || showInternetCatalog ? (
          <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
            <div className="h-full rounded-xl dark:bg-claude-darkBg bg-claude-bg overflow-hidden">
              <Suspense fallback={<AppLoadingIndicator />}>
                {showHomeSurface ? homeContent : internetCatalogContent}
              </Suspense>
            </div>
          </div>
        ) : null}
        {botBrowserShell.hasMountedBrowser ? (
          <div className={botBrowserShell.isBrowserPaneVisible ? 'relative flex flex-1 min-w-0 flex-col' : 'hidden'}>
            {isWindows ? (
              <div className="draggable relative h-9 shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
                <WindowTitleBar isOverlayActive={isOverlayActive} />
              </div>
            ) : null}
            <div className="flex-1 min-h-0">
              <Suspense fallback={<AppLoadingIndicator />}>
                <BotBrowserSurface
                  ref={botBrowserShell.browserRef}
                  visible={botBrowserShell.isBrowserPaneVisible}
                  onOpenConversation={handleBrowserOpenConversation}
                  onError={showToast}
                  onReady={botBrowserShell.onBrowserReady}
                />
              </Suspense>
            </div>
            {isSidebarCollapsed ? (
              <button
                type="button"
                onClick={handleToggleSidebar}
                className={`non-draggable absolute top-2 z-40 h-8 w-8 inline-flex items-center justify-center rounded-lg border border-claude-border/70 bg-claude-surface/90 text-claude-textSecondary shadow-sm backdrop-blur-sm transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:border-claude-darkBorder/70 dark:bg-claude-darkSurface/90 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText ${isMac ? 'left-[76px]' : 'left-2'}`}
                aria-label={i18nService.t('expand')}
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 设置窗口显示在所有主内容之上，但不影响主界面的交互 */}
      {showSettings && (
        <Suspense fallback={null}>
          <Settings
            onClose={handleCloseSettings}
            initialTab={settingsOptions.initialTab}
            notice={settingsOptions.notice}
            openNewProjectForm={settingsOptions.openNewProjectForm}
          />
        </Suspense>
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateInfo={updateInfo}
          readyToInstall={updatePhase === 'ready'}
          onConfirm={handleConfirmUpdate}
          onCancel={() => {
            if (updateModalState === 'info' || updateModalState === 'error' || updateModalState === 'restart') {
              setShowUpdateModal(false);
            }
          }}
          modalState={updateModalState}
          downloadProgress={downloadProgress}
          errorMessage={updateError}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
          onHide={() => setShowUpdateModal(false)}
          installingHint={updatePhase === 'applying' ? i18nService.t('updateInstallingSilentHint') : undefined}
        />
      )}
      {pendingConsent && (
        <AgentGameConsentCard info={pendingConsent} onRespond={handleConsentResponse} />
      )}
      {showUpdateNotification && updateNotificationData && (
        <Suspense fallback={null}>
          <UpdateNotificationModal
            title={updateNotificationData.title}
            content={updateNotificationData.content}
            onClose={handleCloseUpdateNotification}
          />
        </Suspense>
      )}
    </div>
  );
};

export default App; 
