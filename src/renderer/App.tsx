import React, { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store';
import type { SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import HomeSidebar from './components/HomeSidebar';
import WorkspaceRail from './components/layout/WorkspaceRail';
import {
  resolveHomeViewRenderer,
  resolveInternetPaneRenderer,
} from './components/layout/workspaceDestinations.js';
import Toast from './components/Toast';
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
import { sessionTabBinding } from './services/sessionTabBinding';
import { store } from './store';
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
import { setDraftPrompt, setNewTaskOrigin } from './store/slices/coworkSlice';
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
  loadSidebarWidth,
  maxSidebarWidthForWindow,
  migrateSidebarWidthStorage,
  shouldAutoHideSidebar,
  shouldAutoShowSidebar,
  sidebarSnapWidthForWindow,
  sidebarWidthStorageKey,
  SIDEBAR_WIDTH_MIN,
  type SidebarWidthMode,
} from './utils/sidebarWidth';
import {
  dampedSidebarDelta,
  easeOutCubic,
  startSidebarResizeSession,
  SIDEBAR_SNAP_TWEEN_MS,
  type SidebarResizeSession,
} from './utils/sidebarResizeSession';
import { useBotBrowserShell } from './features/botBrowser/useBotBrowserShell';
import { openBotBrowserConversationInCowork } from './features/botBrowser/conversationNavigationAdapter';
import type { BotBrowserConversationRequest } from './features/botBrowser/types';
import type { BotHomeSection } from './features/botBrowser/types';
import PanelToggleIcon from './components/icons/PanelToggleIcon';
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

// Seam toggle pills (owner order ④, 2026-11-11 evening): ONE slim,
// low-presence style shared by every face and every state. 细长 = h-6 w-2
// with a 10px chevron (was h-7 w-3.5 with 12px); 低存在感 = no border, no
// shadow, no backdrop blur, muted claude text tokens at reduced opacity;
// Studio and BotWorks sit at the SAME spot — dead-center on the seam — in
// every state (supersedes the Studio split pill hugging the browser edge).
// The two split-state pills stay invisible until the seam itself is hovered
// (or keyboard-focused); the two collapsed-state recover pills stay faintly
// visible because when the column is gone they are the ONLY affordance.
const SEAM_TOGGLE_PILL_CLASS = 'non-draggable absolute left-1/2 top-1/2 z-40 flex h-6 w-2 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm transition-[opacity,background-color,color] duration-150 text-claude-textSecondary/70 dark:text-claude-darkTextSecondary/70 hover:bg-claude-surfaceHover/70 dark:hover:bg-claude-darkSurfaceHover/70 hover:text-claude-text dark:hover:text-claude-darkText focus-visible:outline-none focus-visible:text-claude-text dark:focus-visible:text-claude-darkText focus-visible:ring-1 focus-visible:ring-claude-accent/40';
// Split-state pills: reveal on seam hover / keyboard focus only.
const SEAM_TOGGLE_PILL_ON_SEAM_CLASS = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100';
// Collapsed-state recover pills: faintly visible, strengthen on hover.
const SEAM_TOGGLE_PILL_RECOVER_CLASS = 'opacity-80 hover:opacity-100 bg-claude-surface/70 dark:bg-claude-darkSurface/70';

// Update phases: idle = none / silent download failed; downloading / applying =
// silent background work (badge + modal stay in sync); ready = downloaded,
// waiting for install; restartReady = macOS silent apply done, waiting restart.

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  // S9 ME points: the shared gateway-checkout flow is one modal mounted
  // here; badge / plan card / settings page open it by event.
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
  // Seam state is PER FACE (总裁办接缝按钮双向化 2026-11-09; 砍平铺态同日令):
  // the Studio face (browser surface) runs a TWO-state cycle — split ↔
  // left(中栏收起·浏览器占满). The 对话框占满 fill state (right, the › pill) is
  // RETIRED — this face's browser must always stay in use, so the seam never
  // hides it. The BotWorks face (home surface) stays single-direction
  // split ↔ left. The two machines never share a variable, so one face's
  // collapse can never leak into the other.
  const [studioSeamState, setStudioSeamState] = useState<'split' | 'left'>('split');
  const [homeSeamCollapsed, setHomeSeamCollapsed] = useState(false);
  // Narrow-window auto-hide (fixed-width ruling 2026-11-11): per face, true
  // when the CURRENT collapse was triggered by the window running out of room
  // (not by the user), so a later widening can bring the column back. Any
  // manual seam interaction clears the face's flag — a manual collapse must
  // never "restore" on its own.
  const sidebarAutoHiddenRef = useRef<Record<SidebarWidthMode, boolean>>({ home: false, browser: false });
  // Crossing guard for the auto-hide threshold: re-armed only once the window
  // leaves the tight zone, so a manual re-open while the window stays narrow
  // is not re-hidden by the very next resize event.
  const sidebarNarrowRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    // Shared-width ruling (2026-11-11 evening, owner order ①): seed the ONE
    // shared storage key from the freshest remembered per-face width BEFORE
    // the first read, so both faces restore the same width from the first
    // paint — switching surfaces never changes the column width. The read
    // itself stays pure (loadSidebarWidth) and synchronous.
    migrateSidebarWidthStorage(
      (key) => window.localStorage.getItem(key),
      (key, value) => window.localStorage.setItem(key, value),
    );
    return loadSidebarWidth((key) => window.localStorage.getItem(key), 'home');
  });
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  // True while the double-click snap tween is animating the width. Like the
  // drag flag it strips the CSS width transition (both are passed into the
  // columns as `isResizing`), so the rAF tween stays the single animator and
  // the tween frames never fight a transition delay.
  const [isSidebarTweening, setIsSidebarTweening] = useState(false);
  // The live resize session owns the pointer between its mousedown and the
  // single finish() funnel; only a session can move the column.
  const sidebarResizeRef = useRef<SidebarResizeSession | null>(null);
  // Double-click snap tween (3:7 ruling 2026-11-09 fourth order): one rAF
  // loop animating sidebarWidth to the 3:7 target. The mirror ref lets the
  // tween read the live width without re-creating the handler on every drag frame.
  const sidebarTweenRafRef = useRef<number | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);
  const stopSidebarSnapTween = useCallback(() => {
    if (sidebarTweenRafRef.current != null) {
      window.cancelAnimationFrame(sidebarTweenRafRef.current);
      sidebarTweenRafRef.current = null;
    }
    setIsSidebarTweening(false);
  }, []);
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

  // Seam button handlers (接缝按钮双向化 2026-11-09). Each face owns its own
  // transition set; every handler is a pure setter (no face probe), so they
  // can live above the shell hook without touching its bindings. Every manual
  // transition also clears that face's auto-hide flag (fixed-width ruling
  // 2026-11-11): from here on the collapse/expand is user-owned, so the
  // window-resize fit check must not auto-restore it later.
  //
  // · BotWorks (home): ONE direction only — split ‹→ left, left ›→ split.
  //   No right-collapsed state exists on this face.
  // · Studio (browser): ONE collapse direction — split ‹→ left (browser
  //   fills), left ›→ split. The › collapse (对话框占满 fill) is retired with
  //   the 平铺态 (same-day ruling) and has no handler anymore.
  const handleCollapseHomeSeam = useCallback(() => {
    sidebarAutoHiddenRef.current.home = false;
    setHomeSeamCollapsed(true);
  }, []);
  const handleExpandHomeSeam = useCallback(() => {
    sidebarAutoHiddenRef.current.home = false;
    setHomeSeamCollapsed(false);
  }, []);
  const handleCollapseStudioSeamLeft = useCallback(() => {
    sidebarAutoHiddenRef.current.browser = false;
    setStudioSeamState('left');
  }, []);
  const handleExpandStudioSeam = useCallback(() => {
    sidebarAutoHiddenRef.current.browser = false;
    setStudioSeamState('split');
  }, []);

  // Face-scoped seam helpers. Defined after the shell hook (below) because
  // they probe the active face — see the derivation block after
  // `useBotBrowserShell`.

  // Column resize is a SESSION started inside the seam's mousedown handler
  // (handleSidebarResizeStart), not an effect keyed on a state flag. That
  // difference is the fix for the "hover follows the pointer" hang: the
  // listeners are attached before the mousedown returns, and every termination
  // path funnels through one finish() that clears the ref + state.

  const handleNewChat = useCallback((preselectSkillId?: unknown, draftText?: string) => {
    const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
    const normalizedPreselectSkillId = normalizePreselectedSkillId(preselectSkillId);
    coworkService.clearSession();
    dispatch(clearSelection());
    // Every generic new-chat entry (rail 新建, the blank-new-chat buttons, a
    // draft handoff) is an OWNER-task composer: reset the wording origin so an
    // a2a composer armed earlier by a 线上对话 + never leaks its Bot-to-Bot copy
    // into it. handleBlankNewChat funnels through here, so it is covered too.
    dispatch(setNewTaskOrigin('local'));
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

  // Session ↔ tab binding (owner request 2026-11-10): every Studio Co-Work
  // session owns one browser tab. The coordinator gets the shell's SILENT tab
  // control (restore/switch must never yank the active face) plus store-backed
  // session reads so it stays free of app imports. Re-attached on shell
  // identity change; the binding itself lives module-level.
  useEffect(() => {
    sessionTabBinding.attach({
      controlTabs: (command) => botBrowserShell.controlTabsSilent(command),
      getOpenSession: () => store.getState().browserCowork.currentSession,
      openSession: async (sessionId) => {
        try {
          await browserCoworkService.loadSession(sessionId);
          const loaded = store.getState().browserCowork.currentSession;
          return loaded?.id === sessionId ? loaded : null;
        } catch {
          return null;
        }
      },
      listBrowserSessions: async () => {
        await coworkService.loadSessions();
        return store.getState().cowork.sessions.filter(
          (entry) => entry.sessionType === 'browser',
        );
      },
    });
    // controlTabsSilent is a stable useCallback; everything else injected above
    // reads module-level services/store, so this only re-runs on shell swaps.
  }, [botBrowserShell.controlTabsSilent]);

  // Launch restore (owner request 2026-11-10): the Studio conversation window
  // opens on the session that was open at quit time, and that session's tab is
  // restored into the freshly booted browser. One-shot; the coordinator is a
  // no-op before attach and queues tab commands behind the surface's
  // browser-ready handshake.
  useEffect(() => {
    if (!isInitialized) return;
    void sessionTabBinding.restoreLastSession();
  }, [isInitialized]);

  // ---- Face-scoped seam derivation (接缝按钮双向化 2026-11-09) -----------
  // The active face owns the seam: every layout consumer below reads the SAME
  // collapsed boolean as before, but its value now comes from the ACTIVE
  // face's own state machine. The two faces' machines never write each other.
  const isHomeSurfaceMode = botBrowserShell.surfaceMode === 'home';
  // On the Studio face only `left` (records column collapsed, browser fills)
  // is a real middle-column collapse. The retired `right` fill state (对话
  // 框占满) once mapped to a collapse here and zeroed the Sidebar's own width
  // inside its 1fr grid track, blanking the whole face — the Studio
  // white-screen, fixed 2026-11-09. The 平铺态砍掉 ruling (same day) removed
  // that state entirely, so exactly one collapse remains to check.
  const isSidebarCollapsed = isHomeSurfaceMode ? homeSeamCollapsed : studioSeamState === 'left';
  // Dragging / double-click snap only make sense while the middle column is
  // its user-resizable self: the Studio right-collapsed state (browser gone)
  // must not arm the middle-column resize grip either.
  const middleColumnResizable = isHomeSurfaceMode
    ? !homeSeamCollapsed
    : studioSeamState === 'split';

  /**
   * Self-rescue: any rail destination click re-opens the middle column.
   *
   * Collapsing hides the column that owns almost every control, so a collapsed
   * workspace must be recoverable from the rail alone — a rail click is the
   * cheapest, most obvious recovery gesture there is. (The rail also carries a
   * dedicated toggle; this is the second, always-taken path.)
   *
   * Per-face scope: only the ACTIVE face's seam resets — the other face keeps
   * its own seam state, so switching surfaces never drags one face's collapse
   * into the other.
   */
  const revealMiddleColumn = useCallback(() => {
    if (isHomeSurfaceMode) {
      sidebarAutoHiddenRef.current.home = false;
      setHomeSeamCollapsed(false);
    } else {
      sidebarAutoHiddenRef.current.browser = false;
      setStudioSeamState('split');
    }
  }, [isHomeSurfaceMode]);

  const handleShowMetaApps = useCallback(() => {
    botBrowserShell.selectInternetPane('metaapps');
  }, [botBrowserShell.selectInternetPane]);

  // Bot Home destinations: the left rail is the ONLY entry point into the three
  // record types (the middle column's old type drawer was removed as a second
  // selector). It switches the surface and the right column's view together.
  // Entering 多人任务 resets the drilled-in selection: the rail entry is a fixed
  // home-page entry point, never "re-open last time's task". That reset used to
  // live in the removed type drawer and moved here with the single entry point.
  const handleSelectHomeSection = useCallback((section: BotHomeSection) => {
    botBrowserShell.switchToHome();
    if (section === 'longTerm') {
      setMainView('scheduledTasks');
    } else if (section === 'groupTasks') {
      dispatch(selectGroupTask(null));
      setMainView('groupTasks');
    } else {
      setMainView('cowork');
    }
  }, [botBrowserShell.switchToHome, dispatch]);

  /**
   * Seam drag = one session, started here and ended by the session's own
   * finish() funnel. Four properties matter and are each load-bearing:
   *
   *   1. ONLY the primary button starts (a right/middle click would open a
   *      native menu that eats the matching mouseup — the old way a drag could
   *      be stranded "held down" forever);
   *   2. the document listeners are attached synchronously, inside this
   *      handler, so a down/up pair completing before React commits cannot
   *      slip past them;
   *   3. onEnd is the ONE exit: mouseup, pointerup, pointercancel, Escape,
   *      window blur, tab hidden, mode switch and unmount all land in it and
   *      clear both the session ref and the visual flag;
   *   4. 50:50 drag-cap ruling (2026-11-11 evening, superseding the same-day
   *      fixed-width 480px cap): the cap is HALF the live middle+right split,
   *      tightened by the right pane's minimum width on narrow windows and
   *      floored at the minimum width — window width is read live per move so
   *      a mid-drag window resize cannot be outrun by a captured constant.
   *      Double-click stays the 3:7 baseline, always under this cap.
   *      The drag follows the pointer in real time, and shapeNext damps
   *      movement near both range edges so the column eases into the cap /
   *      the minimum instead of jerking against them.
   */
  const handleSidebarResizeStart = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if (sidebarResizeRef.current?.active) return;
    // Grabbing the seam mid-tween takes the pointer back: kill the animation
    // first or the frames would fight the drag.
    stopSidebarSnapTween();
    event.preventDefault();
    const session = startSidebarResizeSession({
      startX: event.clientX,
      startWidth: sidebarWidth,
      mode: botBrowserShell.surfaceMode,
      button: event.button,
      // Cap = HALF the live middle+right split (50:50), tightened by the
      // right pane's minimum width on narrow windows, floored at the minimum
      // width; window width is read live per move so a mid-drag window
      // resize cannot be outrun by a captured constant.
      clamp: (width) => clampSidebarWidth(width, window.innerWidth),
      shapeNext: (rawNext, current) => current + dampedSidebarDelta(
        rawNext - current,
        current,
        SIDEBAR_WIDTH_MIN,
        maxSidebarWidthForWindow(window.innerWidth),
      ),
      onWidth: setSidebarWidth,
      onEnd: ({ mode, width }) => {
        sidebarResizeRef.current = null;
        setIsSidebarResizing(false);
        window.localStorage.setItem(sidebarWidthStorageKey(mode), String(width));
      },
    });
    if (!session) return;
    sidebarResizeRef.current = session;
    setIsSidebarResizing(true);
  }, [sidebarWidth, botBrowserShell.surfaceMode, stopSidebarSnapTween]);

  /**
   * Double-click the seam → smooth snap to the 3:7 split (2026-11-09 fourth
   * expansion order, supersedes the third order's 40:60 wording and the old
   * "reset to mode default" semantics).
   * A JS rAF tween drives sidebarWidth with an ease-out curve: fast start,
   * soft landing, ~220 ms, no hard jump. Each frame re-clamps against the
   * live window so a resize mid-tween can never overshoot the cap. The
   * middle column carries no CSS width transition in this state, so the tween
   * is the single animator.
   */
  const handleSidebarResizeSnapToRatio = useCallback(() => {
    // A double-click's first click can leave a live session behind on the
    // second; finish it before the tween takes the pointer's place.
    sidebarResizeRef.current?.finish('explicit');
    stopSidebarSnapTween();
    const mode = botBrowserShell.surfaceMode;
    const target = clampSidebarWidth(sidebarSnapWidthForWindow(window.innerWidth), window.innerWidth);
    const from = sidebarWidthRef.current;
    if (from === target) return;
    // The tween is the single animator while it runs: flag it so both columns
    // strip their CSS width transition for the whole flight (see the
    // isSidebarTweening state).
    setIsSidebarTweening(true);
    const startedAt = performance.now();
    let last = from;
    const step = () => {
      const t = Math.min(1, (performance.now() - startedAt) / SIDEBAR_SNAP_TWEEN_MS);
      last = clampSidebarWidth(Math.round(from + (target - from) * easeOutCubic(t)), window.innerWidth);
      setSidebarWidth(last);
      if (t < 1) {
        sidebarTweenRafRef.current = window.requestAnimationFrame(step);
      } else {
        sidebarTweenRafRef.current = null;
        setIsSidebarTweening(false);
        window.localStorage.setItem(sidebarWidthStorageKey(mode), String(last));
      }
    };
    sidebarTweenRafRef.current = window.requestAnimationFrame(step);
  }, [botBrowserShell.surfaceMode, stopSidebarSnapTween]);

  // A resize session must never outlive the shell (HMR swap, reload, logout):
  // the session owns document listeners, so unmount is an exit path too. The
  // snap tween is a shell-owned rAF loop and dies with the shell as well.
  useEffect(() => () => {
    sidebarResizeRef.current?.finish('unmount');
    stopSidebarSnapTween();
  }, [stopSidebarSnapTween]);

  // Fixed-width ruling (2026-11-11; supersedes the 3:7 window-relative
  // re-clamp): the middle column's width is a remembered pixel value that a
  // window resize NEVER re-scales — only the right pane flexes. When the
  // window gets so narrow that the right pane would keep less than its
  // minimum width (快看不到), the active face's middle column AUTO-HIDES
  // instead of shrinking, and it comes back once the window has room again
  // (plus a hysteresis band, so a borderline window does not flicker).
  // A collapse the USER chose is never auto-restored — the per-face flag
  // marks only collapses this check itself triggered — and a manual re-open
  // while the window stays narrow is not re-hidden until the window first
  // leaves the tight zone (the crossing guard).
  useEffect(() => {
    const fitSidebarToWindow = () => {
      // A live drag or snap tween owns the column width; never fight it.
      if (sidebarResizeRef.current?.active || sidebarTweenRafRef.current != null) return;
      const mode: SidebarWidthMode = botBrowserShell.surfaceMode;
      const width = sidebarWidthRef.current;
      const collapsed = mode === 'home' ? homeSeamCollapsed : studioSeamState === 'left';
      if (shouldAutoHideSidebar(window.innerWidth, width)) {
        if (!sidebarNarrowRef.current && !collapsed) {
          sidebarAutoHiddenRef.current[mode] = true;
          if (mode === 'home') {
            setHomeSeamCollapsed(true);
          } else {
            setStudioSeamState('left');
          }
        }
        sidebarNarrowRef.current = true;
        return;
      }
      sidebarNarrowRef.current = false;
      if (!shouldAutoShowSidebar(window.innerWidth, width)) return;
      // Room again: bring back every face THIS check hid (manual collapses
      // carry no flag and stay collapsed).
      if (sidebarAutoHiddenRef.current.home && homeSeamCollapsed) {
        sidebarAutoHiddenRef.current.home = false;
        setHomeSeamCollapsed(false);
      }
      if (sidebarAutoHiddenRef.current.browser && studioSeamState === 'left') {
        sidebarAutoHiddenRef.current.browser = false;
        setStudioSeamState('split');
      }
    };
    fitSidebarToWindow();
    window.addEventListener('resize', fitSidebarToWindow);
    return () => window.removeEventListener('resize', fitSidebarToWindow);
  }, [botBrowserShell.surfaceMode, homeSeamCollapsed, studioSeamState, sidebarWidth]);

  // Shared-width ruling (2026-11-11 evening): both faces read the ONE shared
  // storage key, so this restore is a same-value re-clamp on every switch —
  // the seam never jumps between faces. The finish('mode-change') still ends
  // a live drag or tween owned by the outgoing face before the width settles.
  useEffect(() => {
    sidebarResizeRef.current?.finish('mode-change');
    stopSidebarSnapTween();
    setSidebarWidth(clampSidebarWidth(
      loadSidebarWidth((key) => window.localStorage.getItem(key), botBrowserShell.surfaceMode),
      window.innerWidth,
    ));
  }, [botBrowserShell.surfaceMode, stopSidebarSnapTween]);

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
      const controlTabs = command.background === true
        ? botBrowserShell.controlTabsSilent
        : botBrowserShell.controlTabs;
      void controlTabs(command).then(
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
  }, [botBrowserShell.controlTabs, botBrowserShell.controlTabsSilent]);

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
  // an entry point; the panel is still where they run.) The session's browser
  // tab is revealed too — one session, one tab.
  const handleSelectBrowserSession = useCallback(async (sessionId: string) => {
    await botBrowserShell.openBrowserHome();
    await browserCoworkService.loadSession(sessionId);
    void sessionTabBinding.revealSessionTab(sessionId);
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

  // The Bot Home middle column's expanded section is the main view's list
  // reading — derived, never a second piece of state, so the column and the
  // right pane can never disagree about where the user is.
  const homeSection: BotHomeSection = mainView === 'scheduledTasks'
    ? 'longTerm'
    : mainView === 'groupTasks'
      ? 'groupTasks'
      : 'records';

  // ---- Right column: exhaustive destination switches ----------------------
  // The rail only names a destination; these two switches are the ONLY place
  // that decides what the right column renders. Every branch is keyed by the
  // destination table in components/layout/workspaceDestinations.js, and every
  // chain ends on a real pane: `null` is not a destination. That is what makes
  // "click a rail icon → blank pane" unreachable — unknown or stale values
  // (HMR state, an old persisted view id) fall back to a rendered pane too.
  const metabotsPane = (
    <MetabotsView
      isSidebarCollapsed={isSidebarCollapsed}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
      onRequestModelSettings={() => handleShowSettings({ initialTab: 'model' })}
      onOpenMetabotInBrowser={botBrowserShell.openLocalMetabot}
      onPreviewMetaAppHomepage={botBrowserShell.openMetaAppByPin}
      onRequestMetaApps={handleShowMetaApps}
    />
  );

  const homePaneKey = resolveHomeViewRenderer(mainView);
  const homeContent = homePaneKey === 'scheduledTasksView' ? (
    <ScheduledTasksView
      isSidebarCollapsed={isSidebarCollapsed}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : homePaneKey === 'groupTasksView' ? (
    <GroupTasksView
      isSidebarCollapsed={isSidebarCollapsed}
      onNewChat={handleBlankNewChat}
      onNewGroupTask={handleNewGroupTask}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : homePaneKey === 'metabotsView' ? (
    metabotsPane
  ) : (
    <CoworkView
      onRequestAppSettings={handleShowSettings}
      onShowSkills={handleShowSkills}
      isSidebarCollapsed={isSidebarCollapsed}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
      focusedOrderTxid={focusedOrderTxid}
      onFocusedOrderConsumed={handleFocusedOrderConsumed}
      onOpenBotInBrowser={botBrowserShell.openRemoteBot}
    />
  );

  // The Co-Work face's right pane — the Bot Internet DEFAULT branch now
  // (owner rulings 2026-11-08 14:15 and 20:18). Both halves of the face live in
  // the MIDDLE column: the session list and the live transcript. The card that
  // used to fill this pane introduced the destination to the user ("Co-Work" +
  // session counts + an "open the browser" button), which duplicated the rail
  // entry that opened it and the panel that actually holds the work. That rail
  // entry is retired by the 20:18 ruling, so this card is what an unknown or
  // retired pane id resolves to. It stays a REAL rendered branch — never
  // `null` — because the destination table's completeness guard
  // (components/layout/workspaceDestinations.js) exists to keep a null branch
  // from blanking the workspace again; it just has nothing of its own to say,
  // exactly like a detail pane with no selection.
  const coworkLandingCard = (
    <div data-pane-empty="cowork" className="h-full" />
  );

  const internetPaneKey = resolveInternetPaneRenderer(botBrowserShell.internetPane);
  const internetCatalogContent = internetPaneKey === 'gigSquareView' ? (
    <GigSquareView onOpenRemoteBotInBrowser={botBrowserShell.openRemoteBot} />
  ) : internetPaneKey === 'metaAppsView' ? (
    <MetaAppsView
      isSidebarCollapsed={isSidebarCollapsed}
      onNewChat={handleNewChat}
      onOpenMetaAppInBrowser={botBrowserShell.openMetaApp}
      onPreviewMetaAppByPin={botBrowserShell.openMetaAppByPin}
      onStartTaskWithMetaApp={handleStartTaskWithMetaApp}
      onOpenBotInBrowser={botBrowserShell.openRemoteBot}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : internetPaneKey === 'metabotsView' ? (
    metabotsPane
  ) : (
    coworkLandingCard
  );

  const showHomeSurface = isHomeSurfaceMode;
  const showInternetCatalog = botBrowserShell.surfaceMode === 'browser' && !botBrowserShell.isBrowserPaneVisible;
  /** The one right-column renderer currently mounted (see `data-pane-view`). */
  const rightPaneKey = showHomeSurface ? homePaneKey : internetPaneKey;
  // Bot Home's THREE-COLUMN final ruling 2026-11-09 (supersedes the 2026-11-08
  // 14:22 two-column degradation): the Home face now mounts the SAME shell
  // shape as the Internet face — 64px icon rail | user-resizable records
  // column | 4px seam | right column. Collapsed: the middle track goes to 0
  // while the rail keeps its column (the rail is how a collapsed workspace
  // recovers its records column). Single-direction (接缝按钮双向化
  // 2026-11-09): the BotWorks face reads its OWN homeSeamCollapsed machine —
  // no right-collapsed track exists on this face.
  const homeShellGridTemplate = homeSeamCollapsed
    ? '64px 0px 4px minmax(0, 1fr)'
    : '64px auto 4px minmax(0, 1fr)';

  return (
    <div className="relative h-screen overflow-hidden flex dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
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
      {/* The workspace shell.
          · Bot Internet keeps the three-column grid untouched: icon rail |
            resizable middle column | 4 px seam | right column.
          · Bot Home runs the SAME three-column shell (three-column final
            ruling 2026-11-09): rail | records column | right column — the
            rail carries the three task entries, the middle column is the
            records (任务记录) list, the right column keeps rendering the
            Co-Work content flow.
          Both faces share this ONE container on purpose: the keep-alive Bot
          Browser pane lives in the right column, so switching surfaces must
          never unmount it (that would drop every open browser tab). */}
      <div
        data-slot="app-three-column-shell"
        data-shell-face={showHomeSurface ? 'home' : 'browser'}
        className="grid min-h-0 min-w-0 flex-1"
        style={{
          // Four tracks in every state: a collapsed column goes to 0 but the
          // boundary handle keeps its 4px track, so the ONE panel toggle stays
          // mounted (and clickable) exactly where it collapsed the column.
          // Studio has exactly TWO states after the 平铺态砍掉 (the 对话框占满
          // branch that zeroed the browser track is retired): split keeps the
          // middle column user-resizable (`auto`), left hands the whole 1fr
          // to the browser.
          gridTemplateColumns: showHomeSurface
            ? homeShellGridTemplate
            : studioSeamState === 'left'
              ? '64px 0px 4px minmax(0, 1fr)'
              : '64px auto 4px minmax(0, 1fr)',
        }}
      >
        {showHomeSurface ? (
          <>
            {/* BotWorks three-column final ruling 2026-11-09: the Home face
                mounts the SAME WorkspaceRail the Internet face mounts — its
                home nav carries exactly the three entries that used to be the
                sidebar's stacked text rows (新建任务 / 长期任务 / 多人任务),
                same RailButton form, size, spacing and interaction states.
                Behavior is the OLD rows' behavior verbatim: 新建任务 →
                handleBlankNewChat (rail's own onNewChat hook), 长期任务 →
                handleShowScheduledTasks, 多人任务 → handleShowGroupTasks —
                no group-task drill-in reset here, because the old Home rows
                never did one. Settings rides the rail on BOTH faces now
                (设置按钮共享化, 总裁办侧栏微调批单 2026-11-09 12:23 —
                superseding the 11:16 order): ONE shared implementation (the
                rail's bottom RailButton + Cog6ToothIcon), ONE onShowSettings
                chain (handleShowSettings), and the records column's old
                「⚙ 设置」 text row is gone. The update badge keeps living in
                the records column's header actions row (the rail gets none —
                one badge per screen). */}
            <WorkspaceRail
              mode={botBrowserShell.surfaceMode}
              internetPane={botBrowserShell.internetPane}
              homeSection={homeSection}
              onSelectInternetPane={(pane) => {
                revealMiddleColumn();
                botBrowserShell.selectInternetPane(pane);
              }}
              onSelectHomeSection={(section) => {
                revealMiddleColumn();
                if (section === 'longTerm') {
                  handleShowScheduledTasks();
                } else if (section === 'groupTasks') {
                  handleShowGroupTasks();
                }
              }}
              onNewChat={handleBlankNewChat}
              onShowSettings={() => handleShowSettings()}
            />
            <HomeSidebar
              onShowCowork={handleShowCowork}
              onShowGroupTasks={handleShowGroupTasks}
              mode={botBrowserShell.surfaceMode}
              onSelectHome={botBrowserShell.switchToHome}
              onSelectSurface={(mode) => {
                if (mode === 'home') {
                  botBrowserShell.switchToHome();
                } else {
                  void botBrowserShell.openBrowserHome();
                }
              }}
              onSelectBrowserSession={handleSelectBrowserSession}
              isCollapsed={isSidebarCollapsed}
              width={sidebarWidth}
              isResizing={isSidebarResizing || isSidebarTweening}
              updateBadge={isSidebarCollapsed ? null : updateBadge}
            />
          </>
        ) : (
          <>
            <WorkspaceRail
              mode={botBrowserShell.surfaceMode}
              internetPane={botBrowserShell.internetPane}
              homeSection={homeSection}
              onSelectInternetPane={(pane) => {
                revealMiddleColumn();
                botBrowserShell.selectInternetPane(pane);
              }}
              onSelectHomeSection={(section) => {
                revealMiddleColumn();
                handleSelectHomeSection(section);
              }}
              onNewChat={() => {
                revealMiddleColumn();
                botBrowserShell.switchToHome();
                handleBlankNewChat();
              }}
              onShowSettings={() => handleShowSettings()}
              updateBadge={updateBadge}
            />
            <Sidebar
              onShowLogin={handleShowLogin}
              onShowSettings={handleShowSettings}
              onShowSkills={handleShowSkills}
              onShowCowork={handleShowCowork}
              onShowScheduledTasks={handleShowScheduledTasks}
              onShowGroupTasks={handleShowGroupTasks}
              mode={botBrowserShell.surfaceMode}
              homeSection={homeSection}
              onSelectHome={botBrowserShell.switchToHome}
              onSelectSurface={(mode) => {
                if (mode === 'home') {
                  botBrowserShell.switchToHome();
                } else {
                  void botBrowserShell.openBrowserHome();
                }
              }}
              onSelectBrowserSession={handleSelectBrowserSession}
              isCollapsed={isSidebarCollapsed}
              width={sidebarWidth}
              isResizing={isSidebarResizing || isSidebarTweening}
            />
          </>
        )}
        {/* Middle ⇄ right boundary handle: the ONE panel-toggle spot in the
            shell, plus the column resize grip. It is mounted in EVERY seam
            state on purpose — a control that lives inside a collapsible
            column is unusable the moment that column is gone, so the toggle
            sits on the seam: same spot to collapse and to bring the column
            back. Drag caps at HALF the middle+right split (50:50 ruling
            2026-11-11 evening, superseding the same-day fixed-width 480px cap
            and the earlier 3:7 ratio cap), with edge damping; double-click
            eases the column to the 3:7 split with a short tween.
            接缝按钮双向化 2026-11-09, then the 平铺态砍掉 same-day ruling,
            then the ④ pill unification 2026-11-11 evening: the chevron(s)
            always point where the pane on their own side will GROW on click,
            every pill shares one slim centered style, and the pills reveal on
            seam hover (recover pills stay faintly visible). The BotWorks face
            shows a single chevron (its one direction: collapse records,
            conversation fills); the Studio split state keeps ONE chevron (‹)
            and its collapsed state shows a single recover chevron (the ›
            direction is retired with the 平铺态). */}
        <div
          role="separator"
          aria-orientation="vertical"
          data-slot="panel-boundary-handle"
          data-collapsed={isSidebarCollapsed ? 'true' : 'false'}
          data-seam-state={showHomeSurface ? (homeSeamCollapsed ? 'left' : 'split') : studioSeamState}
          onMouseDown={middleColumnResizable ? handleSidebarResizeStart : undefined}
          onDoubleClick={middleColumnResizable ? handleSidebarResizeSnapToRatio : undefined}
          style={{ gridColumn: 3 }}
          className={`group relative z-40 w-1 transition-colors ${
            middleColumnResizable ? 'cursor-col-resize hover:bg-claude-accent/40' : ''
          }`}
        >
          {/* Painted line is 4px; the draggable band is 8px so grabbing the
              seam never requires pixel-hunting a 4px target. */}
          <span aria-hidden="true" className="absolute inset-y-0 -left-0.5 -right-0.5" />
          {/* 接缝铰链 pill 定版 2026-11-11 evening (owner order ④, supersedes
              the 接缝铰链分置定版 2026-11-09 placement): ALL pills share ONE
              slim, low-presence style (SEAM_TOGGLE_PILL_CLASS) and ONE spot —
              dead-center on the seam — on both faces and in every state. The
              split-state pills reveal on seam hover; the collapsed-state
              recover pills stay faintly visible (sole affordance). Chevrons
              still point where the pane on their own side will GROW on click:
              BotWorks single direction (collapse records ⇄ expand records),
              Studio split ‹ + collapsed › recover (the 平铺态 fill state
              stays retired). */}
          {showHomeSurface ? (
            homeSeamCollapsed ? (
              /* BotWorks face, collapsed: the records column re-opens to the
                 right. Single direction, single chevron. */
              <button
                type="button"
                data-slot="panel-toggle"
                aria-label={i18nService.t('seamExpandRecordsHomeFace')}
                title={i18nService.t('seamExpandRecordsHomeFace')}
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={handleExpandHomeSeam}
                className={`${SEAM_TOGGLE_PILL_CLASS} ${SEAM_TOGGLE_PILL_RECOVER_CLASS}`}
              >
                <PanelToggleIcon className="h-2.5 w-2.5" direction="right" />
              </button>
            ) : (
              /* BotWorks face, split: collapse the records column left — the
                 conversation fills. The ONLY direction this face offers. */
              <button
                type="button"
                data-slot="panel-toggle"
                aria-label={i18nService.t('seamCollapseRecordsHomeFace')}
                title={i18nService.t('seamCollapseRecordsHomeFace')}
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={handleCollapseHomeSeam}
                className={`${SEAM_TOGGLE_PILL_CLASS} ${SEAM_TOGGLE_PILL_ON_SEAM_CLASS}`}
              >
                <PanelToggleIcon className="h-2.5 w-2.5" direction="left" />
              </button>
            )
          ) : studioSeamState === 'split' ? (
            /* Studio face, split: one pill, centered on the seam like the
               BotWorks split pill — ‹ (the browser grows leftward to fill).
               The › pill and its 对话框占满 fill state are retired (平铺态
               砍掉). */
            <button
              type="button"
              data-slot="panel-toggle"
              aria-label={i18nService.t('seamCollapseLeftBrowserFace')}
              title={i18nService.t('seamCollapseLeftBrowserFace')}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={handleCollapseStudioSeamLeft}
              className={`${SEAM_TOGGLE_PILL_CLASS} ${SEAM_TOGGLE_PILL_ON_SEAM_CLASS}`}
            >
              <PanelToggleIcon className="h-2.5 w-2.5" direction="left" />
            </button>
          ) : (
            /* Studio face, collapsed (browser fills): one chevron pointing
               back to the split state — the seam travels right when the
               middle column re-opens. */
            <button
              type="button"
              data-slot="panel-toggle"
              aria-label={i18nService.t('seamExpandMiddleFromLeft')}
              title={i18nService.t('seamExpandMiddleFromLeft')}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={handleExpandStudioSeam}
              className={`${SEAM_TOGGLE_PILL_CLASS} ${SEAM_TOGGLE_PILL_RECOVER_CLASS}`}
            >
              <PanelToggleIcon className="h-2.5 w-2.5" direction="right" />
            </button>
          )}
        </div>
      {/* The right column is pinned to track 4 on purpose: the boundary handle
          above is the only optional-width child and it never unmounts, so a
          missing third child can never pull this column into a zero-width
          track (the 11:37 blank-workspace bug). Explicit placement keeps the
          collapsed state behaving like the expanded one. */}
      <div
        data-slot="app-right-column"
        style={{ gridColumn: 4 }}
        className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden"
      >
        {showHomeSurface || showInternetCatalog ? (
          <div
            data-pane-view={rightPaneKey}
            className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}
          >
            <div className="h-full rounded-xl dark:bg-claude-darkBg bg-claude-bg overflow-hidden">
              <Suspense fallback={<AppLoadingIndicator />}>
                {showHomeSurface ? homeContent : internetCatalogContent}
              </Suspense>
            </div>
          </div>
        ) : null}
        {botBrowserShell.hasMountedBrowser ? (
          <div
            data-pane-view={botBrowserShell.isBrowserPaneVisible ? 'botBrowserSurface' : undefined}
            className={botBrowserShell.isBrowserPaneVisible ? 'relative flex flex-1 min-w-0 flex-col' : 'hidden'}
          >
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
          </div>
        ) : null}
      </div>
      </div>

      {/* Seam drag shield (owner order ②, 2026-11-11 evening): while a drag
          session is live this transparent full-viewport layer keeps every
          pointer event inside THIS document. The Bot Browser pane is a real
          iframe — dragging the seam across it used to swallow mousemove/
          mouseup mid-flight ("拖拽中丢失目标", dead zone then a jump when the
          pointer re-emerged). The session's document-level listeners never
          change; the shield just guarantees the events reach that document.
          Same pattern as the CoworkSessionDetail markdown-viewer splitter's
          drag overlay. It exists only while dragging, so normal clicks are
          never intercepted, and it carries the col-resize cursor so the
          pointer language stays continuous over the iframe region. */}
      {isSidebarResizing ? (
        <div
          aria-hidden="true"
          data-slot="panel-resize-overlay"
          className="fixed inset-0 z-50 cursor-col-resize"
        />
      ) : null}

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
