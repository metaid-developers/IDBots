import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentNotification, AgentNotificationTarget } from '@/types/notification';
import { t } from '../i18n';
import { getMobileElectron, hasAppBridge } from './appBridge';
import { resolveTwinMetabotId } from './activity';
import { useChat } from './hooks/useChat';
import { useMetabots } from './hooks/useMetabots';
import { useResync } from './hooks/useResync';
import { useNotificationReadThrough, useNotificationUnreadCount } from './hooks/useNotifications';
import { useTerminalBridgeState } from './hooks/useTerminalBridgeState';
import { getMeStore, isMeSubscribed } from './me/mePointsStore';
import { BridgeUnavailable } from './components/BridgeUnavailable';
import { ConnectionBanner } from './components/ConnectionBanner';
import {
  TenantUnavailableScreen,
  TooManyDevicesScreen,
  VersionMismatchScreen,
} from './components/GatewayTerminalScreens';
import { TabBar } from './components/TabBar';
import type { MobileTab } from './components/TabBar';
import { handleMobileRootBack } from './nativeBack';
import { useNativeBackHandler } from './hooks/useNativeBackHandler';
import { isRechargeAllowed } from '../native/rechargePolicy';
import type { MobileNftMintRequest } from './me/nftMint';
import type { MobileBrowserRequest } from './browser/MobileBrowserScreen';
import {
  notificationCenterPath,
  notificationTargetPath,
  parseMobileAppRoute,
  sanitizeMobileReturnPath,
} from './notifications/notificationRoutes';
import type { MobileAppRoute } from './notifications/notificationRoutes';

const ChatScreen = lazy(() => import('./screens/ChatScreen'));
const TasksScreen = lazy(() => import('./screens/TasksScreen'));
const MeScreen = lazy(() => import('./screens/MeScreen'));
const MePurchaseScreen = lazy(() => import('./screens/MePurchaseScreen'));
const RechargeScreen = lazy(() => import('./screens/RechargeScreen'));
const MobileBrowserScreen = lazy(() => import('./browser/MobileBrowserScreen'));
const NotificationsScreen = lazy(() => import('./screens/NotificationsScreen'));

const ACTIVE_TAB_STORAGE_KEY = 'idbots.mobile.activeTab.v1';
const MOBILE_TABS: readonly MobileTab[] = ['chat', 'browser', 'tasks', 'me'];

type PurchaseSection = 'subscribe' | 'topup';

function readActiveTab(): MobileTab {
  try {
    const saved = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    return MOBILE_TABS.includes(saved as MobileTab) ? saved as MobileTab : 'chat';
  } catch {
    return 'chat';
  }
}

function TabFallback(): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center py-16 text-sm text-[var(--text-secondary)]">
      {t('mobile.common.loading')}
    </div>
  );
}

export default function MobileApp(): JSX.Element {
  const initialRouteRef = useRef<MobileAppRoute>(parseMobileAppRoute(window.location.pathname));
  const [tab, setTab] = useState<MobileTab>(readActiveTab);
  const [purchase, setPurchase] = useState<{
    section: PurchaseSection;
    planId?: string;
    packageId?: string;
    orderId?: string;
  } | null>(null);
  const [billingRevision, setBillingRevision] = useState(0);
  const [usageSignal, setUsageSignal] = useState(0);
  const [browserVisited, setBrowserVisited] = useState(() => tab === 'browser');
  const [browserRequest, setBrowserRequest] = useState<MobileBrowserRequest | null>(null);
  const [taskAttentionCount, setTaskAttentionCount] = useState(0);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(initialRouteRef.current.kind === 'notifications');
  const [taskDeepLink, setTaskDeepLink] = useState<string | undefined>(
    initialRouteRef.current.kind === 'task' ? initialRouteRef.current.taskId : undefined,
  );
  const [scheduledDeepLink, setScheduledDeepLink] = useState<{ taskId: string; runId: string } | undefined>(
    initialRouteRef.current.kind === 'scheduled_run'
      ? { taskId: initialRouteRef.current.taskId, runId: initialRouteRef.current.runId }
      : undefined,
  );

  const selectTab = useCallback((next: MobileTab) => {
    if (next === 'browser') setBrowserVisited(true);
    setNotificationCenterOpen(false);
    window.history.replaceState({}, '', '/app/');
    setTab(next);
  }, []);
  const openBrowser = useCallback((uri: string) => {
    setBrowserRequest((current) => ({ uri, nonce: (current?.nonce ?? 0) + 1, newTab: true }));
    setBrowserVisited(true);
    setPurchase(null);
    setNotificationCenterOpen(false);
    setTab('browser');
  }, []);
  const purchaseAllowed = isRechargeAllowed(window.idbotsMobile);
  const openPurchase = useCallback((section: PurchaseSection, subjectId?: string, orderId?: string) => {
    if (!purchaseAllowed) return;
    setPurchase({
      section,
      ...(section === 'subscribe' ? { planId: subjectId } : { packageId: subjectId }),
      ...(orderId ? { orderId } : {}),
    });
  }, [purchaseAllowed]);
  const openRecharge = useCallback(() => {
    if (!purchaseAllowed) return;
    const subscribed = isMeSubscribed(getMeStore().subscription);
    setPurchase({ section: subscribed ? 'topup' : 'subscribe' });
  }, [purchaseAllowed]);
  const openUsage = useCallback(() => {
    setPurchase(null);
    setTab('me');
    setUsageSignal((value) => value + 1);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
    } catch {
      return;
    }
  }, [tab]);

  const { bots, error: botsError, reload: reloadBots } = useMetabots();
  useEffect(() => {
    if (tab === 'chat') void reloadBots();
  }, [tab, reloadBots]);
  const chat = useChat(bots);
  const twinMetabotId = resolveTwinMetabotId(bots);
  const twinName = bots.find((bot) => bot.id === twinMetabotId)?.name ?? 'Twin Bot';
  const openMintNft = useCallback((request: MobileNftMintRequest, prompt: string) => {
    chat.setMetabotId(request.botId);
    chat.newChat();
    chat.setDraft(prompt);
    setPurchase(null);
    setTab('chat');
  }, [chat.setMetabotId, chat.newChat, chat.setDraft]);
  const openWorkSession = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      const result = await getMobileElectron().cowork.getSession(sessionId, { messageLimit: 1 });
      if (!result?.success || !result.session) return false;
    } catch {
      return false;
    }
    const previousSessionId = chat.getOpenSessionId();
    const opened = await chat.openSession(sessionId);
    if (opened) {
      setTab('chat');
      return true;
    }
    if (previousSessionId && previousSessionId !== sessionId) {
      await chat.openSession(previousSessionId);
    }
    return false;
  }, [chat.getOpenSessionId, chat.openSession]);
  const openTaskDraft = useCallback((draft: string) => {
    if (twinMetabotId !== null) chat.setMetabotId(twinMetabotId);
    chat.newChat();
    chat.setDraft(draft);
    setPurchase(null);
    setTab('chat');
  }, [chat.setDraft, chat.setMetabotId, chat.newChat, twinMetabotId]);

  const { terminal, versionMismatch } = useTerminalBridgeState();
  const resyncCounter = useResync(
    {
      getOpenSessionId: chat.getOpenSessionId,
      getStreamingMessage: chat.getStreamingMessage,
      beginResync: chat.beginResync,
    },
    chat.applyResync,
  );
  const notificationUnreadCount = useNotificationUnreadCount(resyncCounter);
  useNotificationReadThrough(
    chat.sessionId,
    tab === 'chat' && !notificationCenterOpen && (typeof document === 'undefined' || document.visibilityState === 'visible'),
  );

  const openNotificationTarget = useCallback(async (target: AgentNotificationTarget): Promise<boolean> => {
    if (target.kind === 'session') return openWorkSession(target.sessionId);
    if (target.kind === 'task') {
      setTaskDeepLink(target.taskId);
      setTab('tasks');
      return true;
    }
    setScheduledDeepLink({ taskId: target.taskId, runId: target.runId });
    setTab('tasks');
    return true;
  }, [openWorkSession]);

  const openNotification = useCallback(async (item: AgentNotification): Promise<boolean> => {
    if (item.readAt === null) await getMobileElectron().notification.markRead([item.eventId]);
    setNotificationCenterOpen(false);
    window.history.pushState({ mobileDeepLink: true }, '', notificationTargetPath(item.target));
    const opened = await openNotificationTarget(item.target);
    if (!opened) {
      setNotificationCenterOpen(true);
      window.history.replaceState({ notificationCenter: true }, '', notificationCenterPath(item.eventId));
    }
    return opened;
  }, [openNotificationTarget]);

  const handleRoute = useCallback(async (route: MobileAppRoute): Promise<void> => {
    if (route.kind === 'root') {
      setNotificationCenterOpen(false);
      return;
    }
    if (route.kind === 'notifications') {
      setNotificationCenterOpen(true);
      return;
    }
    if (route.kind === 'notification') {
      const result = await getMobileElectron().notification.get(route.eventId);
      if (result?.success && result.item) await openNotification(result.item);
      else setNotificationCenterOpen(true);
      return;
    }
    setNotificationCenterOpen(false);
    if (route.kind === 'session') {
      setTab('chat');
      await openWorkSession(route.sessionId);
      return;
    }
    if (route.kind === 'task') {
      setTaskDeepLink(route.taskId);
      setTab('tasks');
      return;
    }
    setScheduledDeepLink({ taskId: route.taskId, runId: route.runId });
    setTab('tasks');
  }, [openNotification, openWorkSession]);

  const handledInitialRouteRef = useRef(false);
  useEffect(() => {
    if (handledInitialRouteRef.current || !chat.isReady) return;
    handledInitialRouteRef.current = true;
    void handleRoute(initialRouteRef.current);
  }, [handleRoute, chat.isReady]);

  useEffect(() => {
    const onPopState = () => void handleRoute(parseMobileAppRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [handleRoute]);

  const openNotificationCenter = useCallback(() => {
    if (!notificationCenterOpen) window.history.pushState({ notificationCenter: true }, '', notificationCenterPath());
    setNotificationCenterOpen(true);
  }, [notificationCenterOpen]);
  const closeNotificationCenter = useCallback(() => {
    setNotificationCenterOpen(false);
    if (window.history.state?.notificationCenter) window.history.back();
    else window.history.replaceState({}, '', '/app/');
  }, []);

  useNativeBackHandler(() => {
    if (notificationCenterOpen) {
      closeNotificationCenter();
      return true;
    }
    return handleMobileRootBack(
      { rechargeOpen: purchase !== null, tab },
      { closeRecharge: () => setPurchase(null), showChat: () => setTab('chat') },
    );
  });

  useEffect(() => {
    if (terminal === 'unauthorized') {
      const returnTo = sanitizeMobileReturnPath(`${window.location.pathname}${window.location.search}`);
      window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [terminal]);

  if (!hasAppBridge()) {
    return <BridgeUnavailable />;
  }

  if (terminal === 'unauthorized') {
    return <div className="hidden" data-testid="gateway-unauthorized" />;
  }
  if (terminal === 'tenant-unavailable') {
    return <TenantUnavailableScreen />;
  }
  if (terminal === 'too-many-devices') {
    return <TooManyDevicesScreen />;
  }
  if (terminal === 'version-mismatch') {
    return <VersionMismatchScreen mismatch={versionMismatch} />;
  }

  return (
    <div
      className="twin-page h-[100dvh]"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1 flex-col">
        {notificationCenterOpen ? (
          <Suspense fallback={<TabFallback />}>
            <NotificationsScreen
              resyncCounter={resyncCounter}
              onBack={closeNotificationCenter}
              onOpenNotification={openNotification}
            />
          </Suspense>
        ) : (
          <>
            {tab === 'chat' ? (
              <Suspense fallback={<TabFallback />}>
                <ChatScreen
                  chat={chat}
                  bots={bots}
                  botsError={botsError}
                  onReloadBots={() => void reloadBots()}
                  onOpenRecharge={openRecharge}
                  onOpenUri={openBrowser}
                  rechargeAllowed={purchaseAllowed}
                  notificationUnreadCount={notificationUnreadCount}
                  onOpenNotifications={openNotificationCenter}
                />
              </Suspense>
            ) : null}
            {tab === 'tasks' ? (
              <Suspense fallback={<TabFallback />}>
                <TasksScreen
                  resyncCounter={resyncCounter}
                  twinMetabotId={twinMetabotId}
                  twinName={twinName}
                  onOpenSession={openWorkSession}
                  onOpenDraft={openTaskDraft}
                  onOpenUri={openBrowser}
                  onAttentionCount={setTaskAttentionCount}
                  notificationUnreadCount={notificationUnreadCount}
                  onOpenNotifications={openNotificationCenter}
                  requestedTaskId={taskDeepLink}
                  requestedScheduledRun={scheduledDeepLink}
                />
              </Suspense>
            ) : null}
            {tab === 'me' ? (
              <Suspense fallback={<TabFallback />}>
                <MeScreen
                  resyncCounter={resyncCounter + billingRevision}
                  canPurchase={purchaseAllowed}
                  onOpenPurchase={openPurchase}
                  onMintNft={openMintNft}
                  onOpenUri={openBrowser}
                  usageSignal={usageSignal}
                  notificationUnreadCount={notificationUnreadCount}
                  onOpenNotification={openNotification}
                />
              </Suspense>
            ) : null}
            {browserVisited ? (
              <div className="min-h-0 flex-1" style={{ display: tab === 'browser' ? 'flex' : 'none', flexDirection: 'column' }}>
                <Suspense fallback={<TabFallback />}>
                  <MobileBrowserScreen visible={tab === 'browser'} request={browserRequest} />
                </Suspense>
              </div>
            ) : null}
          </>
        )}
      </div>
      <TabBar active={tab} onSelect={selectTab} taskAttentionCount={taskAttentionCount} />
      {purchaseAllowed && purchase ? (
        <div className="fixed inset-0 z-50">
          <Suspense fallback={<TabFallback />}>
            {purchase.section === 'subscribe' ? (
              <MePurchaseScreen
                section="subscribe"
                initialPlanId={purchase.planId}
                initialOrderId={purchase.orderId}
                canPurchase={purchaseAllowed}
                onClose={() => setPurchase(null)}
                onSwitchSection={(section) => setPurchase({ section })}
                onOpenUsage={openUsage}
                onSubmitted={() => setBillingRevision((value) => value + 1)}
              />
            ) : (
              <RechargeScreen
                initialPackageId={purchase.packageId}
                initialOrderId={purchase.orderId}
                canPurchase={purchaseAllowed}
                onClose={() => setPurchase(null)}
                onOpenSubscribe={(planId) => setPurchase({ section: 'subscribe', planId })}
                onOpenUsage={openUsage}
                onSubmitted={() => setBillingRevision((value) => value + 1)}
              />
            )}
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
