import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { getMobileElectron, hasAppBridge } from './appBridge';
import { resolveTwinMetabotId } from './activity';
import { useChat } from './hooks/useChat';
import { useMetabots } from './hooks/useMetabots';
import { useResync } from './hooks/useResync';
import { useTerminalBridgeState } from './hooks/useTerminalBridgeState';
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

/**
 * App shell (REQ-E-11): connection banner on top, three lazy-loaded tabs,
 * bottom tab bar with safe-area padding, and the recharge page pushed as a
 * full-screen overlay. No router dependency: simple state navigation.
 */

const ChatScreen = lazy(() => import('./screens/ChatScreen'));
const TasksScreen = lazy(() => import('./screens/TasksScreen'));
const MeScreen = lazy(() => import('./screens/MeScreen'));
const RechargeScreen = lazy(() => import('./screens/RechargeScreen'));

const ACTIVE_TAB_STORAGE_KEY = 'idbots.mobile.activeTab.v1';
const MOBILE_TABS: readonly MobileTab[] = ['chat', 'tasks', 'me'];

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
  const [tab, setTab] = useState<MobileTab>(readActiveTab);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [billingRevision, setBillingRevision] = useState(0);
  const rechargeAllowed = isRechargeAllowed(window.idbotsMobile);
  const openRecharge = useCallback(() => {
    if (rechargeAllowed) setRechargeOpen(true);
  }, [rechargeAllowed]);
  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
    } catch {
      return;
    }
  }, [tab]);
  // Chat state lives at the shell level so switching tabs keeps the stream.
  const { bots, error: botsError, reload: reloadBots } = useMetabots();
  const chat = useChat(bots);
  const twinMetabotId = resolveTwinMetabotId(bots);
  const twinName = bots.find((bot) => bot.id === twinMetabotId)?.name ?? 'Twin Bot';
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
  // Terminal gateway states (REQ-E-2 close codes) replace the whole shell.
  const { terminal, versionMismatch } = useTerminalBridgeState();
  // Reconnect resync (REQ-E-5): refresh on every (re)connect, whichever
  // bridge is active; the counter drives the tasks/meters/me list refresh.
  const resyncCounter = useResync(
    {
      getOpenSessionId: chat.getOpenSessionId,
      getStreamingMessage: chat.getStreamingMessage,
      beginResync: chat.beginResync,
    },
    chat.applyResync,
  );
  useNativeBackHandler(() => handleMobileRootBack(
    { rechargeOpen, tab },
    { closeRecharge: () => setRechargeOpen(false), showChat: () => setTab('chat') },
  ));

  // 4001/4003 unauthorized: the session is no longer valid — sign in again.
  useEffect(() => {
    if (terminal === 'unauthorized') {
      window.location.assign('/login');
    }
  }, [terminal]);

  if (!hasAppBridge()) {
    return <BridgeUnavailable />;
  }

  if (terminal === 'unauthorized') {
    // Navigating away in the effect above; render nothing meanwhile.
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
        {tab === 'chat' ? (
          <Suspense fallback={<TabFallback />}>
            <ChatScreen
              chat={chat}
              bots={bots}
              botsError={botsError}
              onReloadBots={() => void reloadBots()}
              onOpenRecharge={openRecharge}
              rechargeAllowed={rechargeAllowed}
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
            />
          </Suspense>
        ) : null}
        {tab === 'me' ? (
          <Suspense fallback={<TabFallback />}>
            <MeScreen
              resyncCounter={resyncCounter + billingRevision}
              onOpenRecharge={openRecharge}
              rechargeAllowed={rechargeAllowed}
            />
          </Suspense>
        ) : null}
      </div>
      <TabBar active={tab} onSelect={setTab} />
      {rechargeAllowed && rechargeOpen ? (
        <div className="fixed inset-0 z-50">
          <Suspense fallback={<TabFallback />}>
            <RechargeScreen onClose={() => setRechargeOpen(false)} onMetersUpdated={() => setBillingRevision((value) => value + 1)} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
